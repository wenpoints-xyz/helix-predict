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
import {HouseVault} from "./HouseVault.sol";

/// @title PredictionHouse
/// @notice Short-horizon "above/below" price game where an LP vault (HouseVault) is the
/// counterparty to every bet at FIXED odds. A bettor stakes `s` on UP or DOWN; if right they
/// receive `m·s` (m = payout, e.g. 1.95x), if wrong they lose `s`. The vault pays winners and
/// keeps losers' stakes, earning the vig (2·(1-1/m)) as LP yield. Because it's ~50/50 over 30s
/// with no fair value to model, the only knob is the vig; safety comes from exposure caps.
///
/// RESERVE MODEL (net-per-round) — the solvency crux:
///   For an open round with UP stake U and DOWN stake D at payout m, the two sides HEDGE each
///   other (the vault can only lose one side). Its true max loss is
///       netReserve = max( ⌈(m−1)·U⌉ − D , ⌈(m−1)·D⌉ − U , 0 )
///   which is ~0 when flow is balanced. The house locks exactly this on the vault as bets fill
///   (reserving/releasing the delta), so balanced volume ties up almost no LP capital.
///
///   bet ─► escrow s in this contract, adjust vault reserve to new netReserve, enforce caps
///   settle ─► winners get m·s (dust-free split), losers' stakes → vault, reserve released
///
/// ORACLE HARDENING (a house is robbed straight from the vault, so this is bank-grade):
///   • settle price's publishTime is PINNED to [expiryTime, expiryTime+maxPriceAge] — a settler
///     can't pick a stale-but-valid price that favours their bet.
///   • confidence guard: if Pyth's conf/price band is too wide at settle, the round VOIDS
///     (full refund, zero vault P&L) instead of paying out on an untrustworthy price.
///   • per-round + aggregate exposure caps (bps of the bankroll) bound any single theft.
///   • voidExpired(): permissionless refund hatch if settlement lapses, so funds never lock.
contract PredictionHouse is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 internal constant BPS = 10000;
    uint256 public constant MAX_PAYOUT_BPS = 19900; // < 2.00x so the house edge is always positive
    uint256 public constant MAX_EXPOSURE_BPS = 5000; // caps can never exceed 50% of the bankroll

    IPyth public immutable pyth;
    HouseVault public immutable vault;
    IERC20 public immutable stakeToken;

    uint256 public payoutBps; // m in bps (e.g. 19500 = 1.95x); snapshotted per round at creation
    uint64 public maxPriceAge; // staleness bound (s) for lock/settle price reads
    uint256 public maxRoundExposureBps; // per-round vault max loss cap, as bps of bankroll
    uint256 public maxAggExposureBps; // aggregate open exposure cap, as bps of bankroll
    uint256 public maxBet; // max single bet (absolute, in stake token)
    uint256 public maxConfBps; // confidence guard: void if conf/|price| > this (0 = disabled)
    uint64 public settleGrace; // after expiry+grace, anyone may voidExpired() a stuck round

    enum State {
        Open,
        Locked,
        Settled
    }

    struct Market {
        bytes32 feedId;
        uint32 timeframe;
        bool enabled;
    }

    struct Round {
        uint256 marketId;
        uint64 lockTime;
        uint64 expiryTime;
        int64 strike;
        int64 close;
        uint128 upPool; // total UP stake
        uint128 downPool; // total DOWN stake
        uint32 payoutBps; // odds locked at creation
        uint256 distributable; // total owed to winners at settle (m·winStake), decremented on claim
        uint256 winPoolRemaining; // winning stake not yet claimed (dust-free split)
        State state;
        bool upWon;
        bool voided;
    }

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
        uint32 payoutBps;
        uint8 state;
        bool upWon;
        bool voided;
    }

    Market[] public markets;
    Round[] public rounds;
    mapping(uint256 => bool) public marketHasRound;
    mapping(uint256 => uint64) public marketLastLock;
    mapping(uint256 => uint256) public marketLatestRound; // id + 1 (0 = none)
    mapping(uint256 => uint256) public roundReserve; // roundId => currently reserved on the vault
    mapping(uint256 => mapping(address => uint256)) public upStake;
    mapping(uint256 => mapping(address => uint256)) public downStake;
    mapping(uint256 => mapping(address => bool)) public claimed;

    event MarketAdded(uint256 indexed marketId, bytes32 indexed feedId, uint32 timeframe);
    event MarketEnabled(uint256 indexed marketId, bool enabled);
    event ParamsSet(
        uint256 payoutBps, uint256 maxRoundExposureBps, uint256 maxAggExposureBps, uint256 maxBet
    );
    event GuardsSet(uint64 maxPriceAge, uint256 maxConfBps, uint64 settleGrace);
    event RoundCreated(
        uint256 indexed roundId,
        uint256 indexed marketId,
        uint64 lockTime,
        uint64 expiryTime,
        uint32 payoutBps
    );
    event BetPlaced(
        uint256 indexed roundId, address indexed user, bool up, uint256 amount, uint256 roundReserve
    );
    event RoundLocked(uint256 indexed roundId, int64 strike);
    event RoundSettled(uint256 indexed roundId, int64 close, bool upWon, bool voided, uint256 distributable);
    event Claimed(uint256 indexed roundId, address indexed user, uint256 amount);

    error PayoutOutOfRange();
    error ExposureCapTooHigh();
    error NoSuchMarket();
    error MarketDisabled();
    error BadTiming();
    error TooFarAhead();
    error NotNextSlot();
    error NotOpen();
    error NotLocked();
    error AlreadySettled();
    error BettingClosed();
    error TooEarly();
    error ZeroAmount();
    error BetTooBig();
    error RoundCapExceeded();
    error AggCapExceeded();
    error InsufficientFee();
    error RefundFailed();
    error PriceBeforeWindow();
    error NotSettled();
    error AlreadyClaimed();
    error NothingToClaim();

    constructor(
        IPyth _pyth,
        HouseVault _vault,
        uint256 _payoutBps,
        uint64 _maxPriceAge,
        uint256 _maxRoundExposureBps,
        uint256 _maxAggExposureBps,
        uint256 _maxBet,
        uint256 _maxConfBps,
        uint64 _settleGrace
    ) Ownable(msg.sender) {
        if (_payoutBps <= BPS || _payoutBps > MAX_PAYOUT_BPS) revert PayoutOutOfRange();
        if (_maxRoundExposureBps > MAX_EXPOSURE_BPS || _maxAggExposureBps > MAX_EXPOSURE_BPS) {
            revert ExposureCapTooHigh();
        }
        pyth = _pyth;
        vault = _vault;
        stakeToken = IERC20(_vault.asset());
        payoutBps = _payoutBps;
        maxPriceAge = _maxPriceAge;
        maxRoundExposureBps = _maxRoundExposureBps;
        maxAggExposureBps = _maxAggExposureBps;
        maxBet = _maxBet;
        maxConfBps = _maxConfBps;
        settleGrace = _settleGrace;
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

    function setParams(
        uint256 _payoutBps,
        uint256 _maxRoundExposureBps,
        uint256 _maxAggExposureBps,
        uint256 _maxBet
    ) external onlyOwner {
        if (_payoutBps <= BPS || _payoutBps > MAX_PAYOUT_BPS) {
            revert PayoutOutOfRange();
        }
        if (_maxRoundExposureBps > MAX_EXPOSURE_BPS || _maxAggExposureBps > MAX_EXPOSURE_BPS) {
            revert ExposureCapTooHigh();
        }
        payoutBps = _payoutBps;
        maxRoundExposureBps = _maxRoundExposureBps;
        maxAggExposureBps = _maxAggExposureBps;
        maxBet = _maxBet;
        emit ParamsSet(_payoutBps, _maxRoundExposureBps, _maxAggExposureBps, _maxBet);
    }

    function setGuards(uint64 _maxPriceAge, uint256 _maxConfBps, uint64 _settleGrace) external onlyOwner {
        maxPriceAge = _maxPriceAge;
        maxConfBps = _maxConfBps;
        settleGrace = _settleGrace;
        emit GuardsSet(_maxPriceAge, _maxConfBps, _settleGrace);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---- round lifecycle ----

    /// @notice Open the next round of a market. Permissionless, cadence-enforced (one canonical
    /// round per slot). The current payout is snapshotted so mid-round odds changes can't break
    /// the reserve accounting.
    function createRound(uint256 marketId, uint64 lockTime) external whenNotPaused returns (uint256 roundId) {
        if (marketId >= markets.length) revert NoSuchMarket();
        Market memory m = markets[marketId];
        if (!m.enabled) revert MarketDisabled();
        if (lockTime <= block.timestamp) revert BadTiming();
        if (lockTime > block.timestamp + 2 * uint256(m.timeframe)) revert TooFarAhead();
        if (marketHasRound[marketId]) {
            uint64 nextSlot = marketLastLock[marketId] + m.timeframe;
            if (nextSlot > block.timestamp && lockTime != nextSlot) revert NotNextSlot();
        }
        marketHasRound[marketId] = true;
        marketLastLock[marketId] = lockTime;

        uint64 expiryTime = lockTime + m.timeframe;
        roundId = rounds.length;
        marketLatestRound[marketId] = roundId + 1;
        rounds.push(
            Round({
                marketId: marketId,
                lockTime: lockTime,
                expiryTime: expiryTime,
                strike: 0,
                close: 0,
                upPool: 0,
                downPool: 0,
                // forge-lint: disable-next-line(unsafe-typecast) — payoutBps <= MAX_PAYOUT_BPS (19900) fits uint32
                payoutBps: uint32(payoutBps),
                distributable: 0,
                winPoolRemaining: 0,
                state: State.Open,
                upWon: false,
                voided: false
            })
        );
        // forge-lint: disable-next-line(unsafe-typecast) — payoutBps <= MAX_PAYOUT_BPS (19900) fits uint32
        emit RoundCreated(roundId, marketId, lockTime, expiryTime, uint32(payoutBps));
    }

    /// @notice Stake `amount` on UP/DOWN vs the house. Adjusts the vault's reservation to the
    /// round's new net max-loss and enforces the exposure caps against the current bankroll.
    function bet(uint256 roundId, bool up, uint256 amount) external nonReentrant whenNotPaused {
        Round storage r = rounds[roundId];
        if (r.state != State.Open) revert NotOpen();
        if (block.timestamp >= r.lockTime) revert BettingClosed();
        if (amount == 0) revert ZeroAmount();
        if (amount > maxBet) revert BetTooBig();

        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 newUp = uint256(r.upPool) + (up ? amount : 0);
        uint256 newDown = uint256(r.downPool) + (up ? 0 : amount);
        uint256 newNet = _netReserve(newUp, newDown, r.payoutBps);
        uint256 old = roundReserve[roundId];

        uint256 bankroll = vault.totalAssets();
        if (newNet > _bps(bankroll, maxRoundExposureBps)) revert RoundCapExceeded();
        if (newNet > old) {
            uint256 add = newNet - old;
            if (vault.reservedExposure() + add > _bps(bankroll, maxAggExposureBps)) revert AggCapExceeded();
            vault.reserve(add); // also reverts if it would break vault solvency
        } else if (newNet < old) {
            vault.release(old - newNet);
        }
        roundReserve[roundId] = newNet;

        if (up) {
            r.upPool = newUp.toUint128();
            upStake[roundId][msg.sender] += amount;
        } else {
            r.downPool = newDown.toUint128();
            downStake[roundId][msg.sender] += amount;
        }
        emit BetPlaced(roundId, msg.sender, up, amount, newNet);
    }

    /// @notice Freeze the strike from a fresh Pyth price at/after lockTime.
    function lock(uint256 roundId, bytes[] calldata updateData) external payable nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != State.Open) revert NotOpen();
        if (block.timestamp < r.lockTime) revert TooEarly();
        PythStructs.Price memory p = _pullPrice(markets[r.marketId].feedId, updateData, r.lockTime);
        r.strike = p.price;
        r.state = State.Locked;
        emit RoundLocked(roundId, r.strike);
    }

    /// @notice Settle against a fresh Pyth price whose publishTime is pinned to the expiry window.
    /// UP wins iff close > strike. A tie or a too-wide confidence band voids (full refund).
    function settle(uint256 roundId, bytes[] calldata updateData) external payable nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != State.Locked) revert NotLocked();
        if (block.timestamp < r.expiryTime) revert TooEarly();
        PythStructs.Price memory p = _pullPrice(markets[r.marketId].feedId, updateData, r.expiryTime);
        int64 close = p.price;
        r.close = close;
        r.state = State.Settled;

        uint256 res = roundReserve[roundId];
        roundReserve[roundId] = 0;

        // Void on tie or untrustworthy price: refund everyone, zero vault P&L.
        if (close == r.strike || _confTooWide(p)) {
            r.voided = true;
            if (res > 0) vault.release(res);
            emit RoundSettled(roundId, close, false, true, 0);
            return;
        }

        r.upWon = close > r.strike;
        uint256 U = uint256(r.upPool);
        uint256 D = uint256(r.downPool);
        uint256 winStake = r.upWon ? U : D;
        uint256 distributable = (winStake * r.payoutBps) / BPS; // total owed to winners (floored)
        uint256 escrow = U + D;

        if (res > 0) vault.release(res); // free the reservation first (keeps vault solvent on pay)
        if (distributable > escrow) {
            vault.payWinnings(address(this), distributable - escrow); // vault covers shortfall (<= res)
        } else if (escrow > distributable) {
            stakeToken.safeTransfer(address(vault), escrow - distributable); // vig to LPs
        }

        r.distributable = distributable;
        r.winPoolRemaining = winStake;
        emit RoundSettled(roundId, close, r.upWon, false, distributable);
    }

    /// @notice Permissionless refund hatch: if a round never settles (oracle/keeper down), anyone
    /// may void it after expiry + settleGrace so escrow and reservations never lock forever.
    function voidExpired(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state == State.Settled) revert AlreadySettled();
        if (block.timestamp < uint256(r.expiryTime) + settleGrace) revert TooEarly();
        uint256 res = roundReserve[roundId];
        roundReserve[roundId] = 0;
        if (res > 0) vault.release(res);
        r.state = State.Settled;
        r.voided = true;
        emit RoundSettled(roundId, 0, false, true, 0);
    }

    /// @notice Winnings (m·stake, dust-free) or a full refund for a voided round. Pull payment.
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
            if (winStake > 0 && r.winPoolRemaining > 0) {
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

    /// @notice Odds/exposure preview: the vault's net max loss for a hypothetical (U,D) at a round's odds.
    function netReserveOf(uint256 up, uint256 down, uint256 mBps) external pure returns (uint256) {
        return _netReserve(up, down, mBps);
    }

    /// @notice Whole board in one call (frontend renders from this alone).
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
                info.payoutBps = r.payoutBps;
                info.state = uint8(r.state);
                info.upWon = r.upWon;
                info.voided = r.voided;
            }
            out[i] = info;
        }
    }

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

    function previewPayout(uint256 roundId, address user) external view returns (uint256) {
        return _claimable(roundId, user);
    }

    /// @notice LP-panel stats: bankroll, locked exposure, free capital, share price (assets per 1e18 shares).
    function houseStats()
        external
        view
        returns (uint256 bankroll, uint256 reserved, uint256 free, uint256 sharePrice)
    {
        bankroll = vault.totalAssets();
        reserved = vault.reservedExposure();
        free = vault.freeAssets();
        sharePrice = vault.convertToAssets(1e18);
    }

    function _claimable(uint256 roundId, address user) internal view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.state != State.Settled || claimed[roundId][user]) return 0;
        if (r.voided) return upStake[roundId][user] + downStake[roundId][user];
        uint256 winStake = r.upWon ? upStake[roundId][user] : downStake[roundId][user];
        if (winStake == 0 || r.winPoolRemaining == 0) return 0;
        return (winStake * r.distributable) / r.winPoolRemaining;
    }

    // ---- internal math ----

    /// @dev Vault's true max loss on a round: it can only lose the side that wins, so the sides
    /// hedge. Uses ceil on the (m−1)·stake term so the reservation always covers the floored payout.
    function _netReserve(uint256 up, uint256 down, uint256 mBps) internal pure returns (uint256) {
        uint256 edgeUp = _ceilDiv(up * (mBps - BPS), BPS); // ⌈(m−1)·U⌉
        uint256 edgeDown = _ceilDiv(down * (mBps - BPS), BPS); // ⌈(m−1)·D⌉
        uint256 a = edgeUp > down ? edgeUp - down : 0; // vault pays if UP wins
        uint256 b = edgeDown > up ? edgeDown - up : 0; // vault pays if DOWN wins
        return a > b ? a : b;
    }

    function _confTooWide(PythStructs.Price memory p) internal view returns (bool) {
        if (maxConfBps == 0) return false; // guard disabled
        uint256 absPrice = p.price >= 0 ? uint256(uint64(p.price)) : uint256(uint64(-p.price));
        if (absPrice == 0) return true; // no usable price -> untrustworthy
        return uint256(p.conf) * BPS / absPrice > maxConfBps;
    }

    function _bps(uint256 x, uint256 bps) internal pure returns (uint256) {
        return (x * bps) / BPS;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// @dev Push a fresh Pyth update, read the (staleness-checked) price, require its publishTime is
    /// at/after `minPublishTime` (pins lock->lockTime, settle->expiryTime), refund excess fee.
    function _pullPrice(bytes32 feedId, bytes[] calldata updateData, uint64 minPublishTime)
        internal
        returns (PythStructs.Price memory p)
    {
        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientFee();
        pyth.updatePriceFeeds{value: fee}(updateData);
        p = pyth.getPriceNoOlderThan(feedId, maxPriceAge); // reverts if older than maxPriceAge
        if (p.publishTime < minPublishTime) revert PriceBeforeWindow(); // can't settle on a pre-window price
        uint256 excess = msg.value - fee;
        if (excess > 0) {
            (bool ok,) = payable(msg.sender).call{value: excess}("");
            if (!ok) revert RefundFailed();
        }
    }
}
