// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title PredictionPool
/// @notice Short-horizon, parimutuel "above/below" price game settled on Pyth.
/// Players stake an ERC20 (points now, USDC later) on UP or DOWN for a round; at
/// expiry the winning side splits the whole pot minus a rake, pro-rata by stake.
/// No house, no orderbook: the pool is always fillable and every bet is one tx.
///
/// ROUND LIFECYCLE (one market = one (feed, timeframe) pair):
///
///   createRound ──► [Open] ──bet(up/down)──► lockTime ──lock(price)──► [Locked]
///                                                                         │
///                                        expiryTime ──settle(price)───────┘
///                                                          │
///                                    ┌─────────────────────┴───────────────┐
///                                    ▼                                      ▼
///                          upPool==0 || downPool==0                  both sides bet
///                          OR close == strike  ──► [Voided]          close > strike ? UP : DOWN wins
///                                    │                                      │
///                              claim() = refund                      claim() = pro-rata of pot − rake
///
/// CADENCE: rounds of a market form a strict chain spaced by `timeframe`. Anyone may
/// open the next round (permissionless), but only at exactly `lastLock + timeframe`
/// while the chain is live, and no further than ~2 timeframes ahead — so there is one
/// canonical round per slot, no overlaps, no spam. If the chain lapses (nobody opened a
/// slot in time) it restarts genesis-style from any near-future lockTime.
///
/// The lock/settle prices come from Pyth's pull oracle: the caller submits a fresh
/// signed price update (from Hermes) which is pushed on-chain, then read with
/// getPriceNoOlderThan — which REVERTS if the price is stale, so a round can never
/// settle on an old price. lock/settle are permissionless (anyone runs them once due).
///
/// Claims are pull-based and dust-free: each claim divides the *remaining* distributable
/// by the *remaining* winning stake, so the final claimer absorbs the rounding remainder
/// and Σpayouts == distributable exactly (nothing is stranded).
contract PredictionPool is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---- config ----
    IPyth public immutable pyth;
    IERC20 public immutable stakeToken; // the "chips": a points token now, USDC later
    uint256 public constant MAX_RAKE_BPS = 1000; // 10% hard cap
    uint256 public rakeBps; // treasury cut of the pot, in basis points
    uint64 public maxPriceAge; // staleness bound (s) for lock/settle price reads
    uint256 public treasuryAccrued; // rake owed to the treasury

    enum State {
        Open,
        Locked,
        Settled
    }

    struct Market {
        bytes32 feedId; // Pyth price feed id
        uint32 timeframe; // seconds between lock and expiry (e.g. 30, 60, 120)
        bool enabled;
    }

    struct Round {
        uint256 marketId;
        uint64 lockTime; // betting closes; strike is frozen at/after this
        uint64 expiryTime; // settlement time
        int64 strike; // Pyth price at lock
        int64 close; // Pyth price at expiry
        uint128 upPool; // packed: written on every bet
        uint128 downPool;
        uint256 distributable; // pot − rake at settle, decremented as winners claim (uint256: pot can exceed 2^128)
        uint256 winPoolRemaining; // winning-side stake not yet claimed (for dust-free payout)
        State state;
        bool upWon;
        bool voided;
    }

    /// @dev Read-only snapshot of a market's latest round, returned by boardSnapshot(). All static fields.
    struct RoundInfo {
        uint256 marketId;
        bytes32 feedId;
        uint32 timeframe;
        bool marketEnabled;
        bool hasRound;
        uint256 roundId;
        uint64 lockTime;
        uint64 expiryTime;
        int64 strike;
        int64 close;
        uint128 upPool;
        uint128 downPool;
        uint8 state;
        bool upWon;
        bool voided;
    }

    Market[] public markets;
    Round[] public rounds;
    mapping(uint256 => bool) public marketHasRound; // marketId => any round opened yet
    mapping(uint256 => uint64) public marketLastLock; // marketId => last opened round's lockTime
    mapping(uint256 => uint256) public marketLatestRound; // marketId => latest round id + 1 (0 = none)
    mapping(uint256 => mapping(address => uint256)) public upStake; // roundId => user => staked UP
    mapping(uint256 => mapping(address => uint256)) public downStake; // roundId => user => staked DOWN
    mapping(uint256 => mapping(address => bool)) public claimed; // roundId => user => claimed

    // ---- events ----
    event MarketAdded(uint256 indexed marketId, bytes32 indexed feedId, uint32 timeframe);
    event MarketEnabled(uint256 indexed marketId, bool enabled);
    event RakeSet(uint256 rakeBps);
    event MaxPriceAgeSet(uint64 maxPriceAge);
    event RoundCreated(uint256 indexed roundId, uint256 indexed marketId, uint64 lockTime, uint64 expiryTime);
    event BetPlaced(uint256 indexed roundId, address indexed user, bool up, uint256 amount);
    event RoundLocked(uint256 indexed roundId, int64 strike);
    event RoundSettled(
        uint256 indexed roundId, int64 close, bool upWon, bool voided, uint256 distributable, uint256 rake
    );
    event Claimed(uint256 indexed roundId, address indexed user, uint256 amount);
    event TreasuryWithdrawn(address indexed to, uint256 amount);

    // ---- errors ----
    error RakeTooHigh();
    error NoSuchMarket();
    error MarketDisabled();
    error BadTiming();
    error TooFarAhead();
    error NotNextSlot();
    error NotOpen();
    error NotLocked();
    error BettingClosed();
    error TooEarly();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientFee();
    error RefundFailed();
    error NotSettled();
    error AlreadyClaimed();
    error NothingToClaim();
    error HasBothSides();

    constructor(IPyth _pyth, IERC20 _stakeToken, uint256 _rakeBps, uint64 _maxPriceAge) Ownable(msg.sender) {
        if (_rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        pyth = _pyth;
        stakeToken = _stakeToken;
        rakeBps = _rakeBps;
        maxPriceAge = _maxPriceAge;
    }

    // ---- admin ----
    function addMarket(bytes32 feedId, uint32 timeframe) external onlyOwner returns (uint256 marketId) {
        if (timeframe == 0) revert BadTiming();
        marketId = markets.length;
        markets.push(Market({feedId: feedId, timeframe: timeframe, enabled: true}));
        emit MarketAdded(marketId, feedId, timeframe);
    }

    function setMarketEnabled(uint256 marketId, bool enabled) external onlyOwner {
        if (marketId >= markets.length) revert NoSuchMarket();
        markets[marketId].enabled = enabled;
        emit MarketEnabled(marketId, enabled);
    }

    function setRakeBps(uint256 _rakeBps) external onlyOwner {
        if (_rakeBps > MAX_RAKE_BPS) revert RakeTooHigh();
        rakeBps = _rakeBps;
        emit RakeSet(_rakeBps);
    }

    function setMaxPriceAge(uint64 _maxPriceAge) external onlyOwner {
        maxPriceAge = _maxPriceAge;
        emit MaxPriceAgeSet(_maxPriceAge);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function withdrawTreasury(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = treasuryAccrued;
        treasuryAccrued = 0;
        stakeToken.safeTransfer(to, amount);
        emit TreasuryWithdrawn(to, amount);
    }

    // ---- round lifecycle ----

    /// @notice Open the next round of a market. Permissionless, but cadence-enforced:
    /// while the chain is live the new round must be exactly `lastLock + timeframe`, and
    /// never more than 2 timeframes ahead. A lapsed chain restarts from any near-future time.
    function createRound(uint256 marketId, uint64 lockTime) external whenNotPaused returns (uint256 roundId) {
        if (marketId >= markets.length) revert NoSuchMarket();
        Market memory m = markets[marketId];
        if (!m.enabled) revert MarketDisabled();
        if (lockTime <= block.timestamp) revert BadTiming();
        if (lockTime > block.timestamp + 2 * uint256(m.timeframe)) revert TooFarAhead();
        if (marketHasRound[marketId]) {
            uint64 nextSlot = marketLastLock[marketId] + m.timeframe;
            // While the chain is still live, only the exact next slot may be opened (no overlap/dupe/spam).
            // If it already elapsed, fall through to a genesis-style restart (bounded by TooFarAhead above).
            if (nextSlot > block.timestamp && lockTime != nextSlot) revert NotNextSlot();
        }
        marketHasRound[marketId] = true;
        marketLastLock[marketId] = lockTime;

        uint64 expiryTime = lockTime + m.timeframe;
        roundId = rounds.length;
        marketLatestRound[marketId] = roundId + 1; // +1 so 0 means "none"
        rounds.push(
            Round({
                marketId: marketId,
                lockTime: lockTime,
                expiryTime: expiryTime,
                strike: 0,
                close: 0,
                upPool: 0,
                downPool: 0,
                distributable: 0,
                winPoolRemaining: 0,
                state: State.Open,
                upWon: false,
                voided: false
            })
        );
        emit RoundCreated(roundId, marketId, lockTime, expiryTime);
    }

    /// @notice Stake `amount` on UP (true) or DOWN (false) for an open round.
    function bet(uint256 roundId, bool up, uint256 amount) external nonReentrant whenNotPaused {
        Round storage r = rounds[roundId];
        if (r.state != State.Open) revert NotOpen();
        if (block.timestamp >= r.lockTime) revert BettingClosed();
        if (amount == 0) revert ZeroAmount();
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        if (up) {
            r.upPool += amount.toUint128(); // SafeCast: reverts instead of silently truncating
            upStake[roundId][msg.sender] += amount;
        } else {
            r.downPool += amount.toUint128();
            downStake[roundId][msg.sender] += amount;
        }
        emit BetPlaced(roundId, msg.sender, up, amount);
    }

    /// @notice Freeze the strike from a fresh Pyth price once lockTime passed.
    function lock(uint256 roundId, bytes[] calldata updateData) external payable nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != State.Open) revert NotOpen();
        if (block.timestamp < r.lockTime) revert TooEarly();
        r.strike = _pullPrice(markets[r.marketId].feedId, updateData);
        r.state = State.Locked;
        emit RoundLocked(roundId, r.strike);
    }

    /// @notice Settle a locked round against a fresh Pyth price at/after expiry.
    /// UP wins iff close > strike. Exact tie or a one-sided round voids (full refunds, no rake).
    function settle(uint256 roundId, bytes[] calldata updateData) external payable nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != State.Locked) revert NotLocked();
        if (block.timestamp < r.expiryTime) revert TooEarly();
        int64 close = _pullPrice(markets[r.marketId].feedId, updateData);
        r.close = close;
        r.state = State.Settled;

        uint256 pot = uint256(r.upPool) + uint256(r.downPool);
        if (r.upPool == 0 || r.downPool == 0 || close == r.strike) {
            r.voided = true;
            emit RoundSettled(roundId, close, false, true, 0, 0);
            return;
        }
        r.upWon = close > r.strike;
        uint256 rake = (pot * rakeBps) / 10000;
        treasuryAccrued += rake;
        r.distributable = pot - rake;
        r.winPoolRemaining = r.upWon ? r.upPool : r.downPool;
        emit RoundSettled(roundId, close, r.upWon, false, r.distributable, rake);
    }

    /// @notice Void a one-sided (or empty) round after betting closed, WITHOUT an oracle push.
    /// A round with a bet on only one side can only ever void, so there's no reason to spend a
    /// Pyth fee on lock+settle — this refunds the lone side for free. Permissionless.
    function voidRound(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != State.Open) revert NotOpen();
        if (block.timestamp < r.lockTime) revert TooEarly();
        if (r.upPool != 0 && r.downPool != 0) revert HasBothSides(); // a real contest must go through settle()
        r.state = State.Settled;
        r.voided = true;
        emit RoundSettled(roundId, 0, false, true, 0, 0);
    }

    /// @notice Withdraw winnings (or a refund for a voided round). Pull payment, once per round.
    /// Dust-free: the final winner to claim receives the exact remaining distributable.
    function claim(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != State.Settled) revert NotSettled();
        if (claimed[roundId][msg.sender]) revert AlreadyClaimed();
        claimed[roundId][msg.sender] = true;

        uint256 payout;
        if (r.voided) {
            payout = upStake[roundId][msg.sender] + downStake[roundId][msg.sender];
        } else {
            uint256 winStake = r.upWon ? upStake[roundId][msg.sender] : downStake[roundId][msg.sender];
            if (winStake > 0) {
                payout = (winStake * r.distributable) / r.winPoolRemaining;
                r.distributable -= payout;
                r.winPoolRemaining -= winStake;
            }
        }
        if (payout == 0) revert NothingToClaim();
        stakeToken.safeTransfer(msg.sender, payout);
        emit Claimed(roundId, msg.sender, payout);
    }

    // ---- views ----
    function roundsLength() external view returns (uint256) {
        return rounds.length;
    }

    function marketsLength() external view returns (uint256) {
        return markets.length;
    }

    /// @notice The whole board in one call: every market + its latest round. The frontend renders
    /// from this alone (no per-market round scanning), which is what keeps reads flat and lag-free.
    function boardSnapshot() external view returns (RoundInfo[] memory out) {
        uint256 n = markets.length;
        out = new RoundInfo[](n);
        for (uint256 i; i < n; i++) {
            Market memory m = markets[i];
            RoundInfo memory info;
            info.marketId = i;
            info.feedId = m.feedId;
            info.timeframe = m.timeframe;
            info.marketEnabled = m.enabled;
            uint256 lr = marketLatestRound[i];
            if (lr != 0) {
                info.hasRound = true;
                uint256 rid = lr - 1;
                info.roundId = rid;
                Round storage r = rounds[rid];
                info.lockTime = r.lockTime;
                info.expiryTime = r.expiryTime;
                info.strike = r.strike;
                info.close = r.close;
                info.upPool = r.upPool;
                info.downPool = r.downPool;
                info.state = uint8(r.state);
                info.upWon = r.upWon;
                info.voided = r.voided;
            }
            out[i] = info;
        }
    }

    /// @notice A user's stake + current claimable across a set of rounds, in one call.
    function myPositions(address user, uint256[] calldata ids)
        external
        view
        returns (
            uint256[] memory up,
            uint256[] memory down,
            uint256[] memory claimable,
            bool[] memory didClaim
        )
    {
        uint256 n = ids.length;
        up = new uint256[](n);
        down = new uint256[](n);
        claimable = new uint256[](n);
        didClaim = new bool[](n);
        for (uint256 i; i < n; i++) {
            uint256 id = ids[i];
            up[i] = upStake[id][user];
            down[i] = downStake[id][user];
            didClaim[i] = claimed[id][user];
            claimable[i] = _claimable(id, user);
        }
    }

    /// @notice What `user` could claim from a settled round right now (0 if unsettled/claimed/lost).
    /// For winners this is approximate until claimed (the remaining-based split shifts dust to the last claimer).
    function previewPayout(uint256 roundId, address user) external view returns (uint256) {
        return _claimable(roundId, user);
    }

    function _claimable(uint256 roundId, address user) internal view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.state != State.Settled || claimed[roundId][user]) return 0;
        if (r.voided) return upStake[roundId][user] + downStake[roundId][user];
        uint256 winStake = r.upWon ? upStake[roundId][user] : downStake[roundId][user];
        if (winStake == 0 || r.winPoolRemaining == 0) return 0;
        return (winStake * r.distributable) / r.winPoolRemaining;
    }

    // ---- internal ----

    /// @dev Push a fresh Pyth update, read the (staleness-checked) price, refund any excess fee.
    function _pullPrice(bytes32 feedId, bytes[] calldata updateData) internal returns (int64) {
        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientFee();
        pyth.updatePriceFeeds{value: fee}(updateData);
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(feedId, maxPriceAge); // reverts if stale
        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool ok,) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
        return p.price;
    }
}
