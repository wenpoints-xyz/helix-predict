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

/// @dev The vendored pyth-sdk-solidity IPyth predates parsePriceFeedUpdatesUnique. The deployed
/// Pyth receiver on Injective implements it; we declare the one method we need and cast the pyth
/// address to it (smaller/safer than bumping the whole SDK, which the deployed PredictionHouse
/// also builds against). Unique = "return the FIRST update whose publishTime is in [min,max] and
/// whose predecessor is < min" — the anti-cherry-pick guarantee this whole model rests on.
interface IPythUnique {
    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory priceFeeds);
}

/// @title PredictionBook
/// @notice Per-user "above/below" price bets vs an LP vault (HouseVault) at FIXED odds, with no
/// shared rounds. Anyone opens their own position; the vault is the counterparty; settlement is
/// anchored to FIXED PAST instants so the price is history by the time anyone settles — the
/// contract and the frontend read the identical value, which is what removes the settle lag.
///
/// DETERMINISTIC, UNOBSERVABLE-AT-COMMIT PRICING (the crux):
///   • openBet commits stake+side+duration but NOT a strike. The strike is pinned later from the
///     first Pyth tick at/after strikeInstant = openTime + STRIKE_DELAY (a FUTURE instant the
///     bettor cannot see when they commit) — so they can't time their entry against a visible
///     strike to harvest the vault.
///   • settle reads BOTH the strike (first tick >= strikeInstant) and the close (first tick >=
///     strikeInstant + dur) via parsePriceFeedUpdatesUnique — the FIRST tick past each instant is
///     forced, so a settler can't cherry-pick a favourable tick inside the window.
///
///     open ─commit(no strike)─► [Open] ──(strikeInstant = t+Δ passes)──► strike knowable off-chain
///        └─ escrow stake ; reserve ⌈(m−1)·stake⌉ on the vault (NO netting) ; caps
///     settle(strikeData, closeData) after strikeInstant+dur:
///        strike = firstTick≥strikeInstant ; close = firstTick≥strikeInstant+dur
///        won=up?close>strike:close<strike ; tie/wide-conf ─► void
///        tip→settler (from escrow) ; win: m·stake−tip owed to bettor (pull) ; loss: stake−tip→vault
///     voidExpired after strikeInstant+dur+settleGrace (or while paused): refund stake−tip, free reserve
///
/// SOLVENCY (reused HouseVault): totalAssets() >= reservedExposure always. Each open bet reserves
/// its FULL ⌈(m−1)·stake⌉ (no cross-bet hedging), bounded by per-bet + aggregate exposure caps.
///
/// ORACLE HARDENING: Unique pins both instants (no cherry-pick); confidence guard voids on an
/// untrustworthy band; voidExpired is a permissionless refund hatch so funds never lock.
contract PredictionBook is Ownable, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 internal constant BPS = 10000;
    uint256 public constant MAX_PAYOUT_BPS = 19900; // < 2.00x so the house edge stays positive
    uint256 public constant MAX_EXPOSURE_BPS = 5000; // caps can never exceed 50% of the bankroll

    IPyth public immutable pyth;
    HouseVault public immutable vault;
    IERC20 public immutable stakeToken;

    // ---- params (owner-tunable) ----
    uint256 public payoutBps; // m in bps (e.g. 19500 = 1.95x); snapshotted per bet at open
    uint256 public maxBetExposureBps; // per-bet vault max-loss cap, as bps of bankroll
    uint256 public maxAggExposureBps; // aggregate open exposure cap, as bps of bankroll
    uint256 public minBet; // dust floor (also makes the settle tip meaningful)
    uint256 public maxBet; // max single stake (absolute)
    uint256 public maxConfBps; // confidence guard: void if conf/|price| > this (0 = disabled)
    uint256 public tipBps; // settler tip as bps of stake
    uint256 public maxTip; // absolute cap on the settler tip
    uint32 public maxOpenPerUser; // concurrent OPEN positions per address (anti-spam)
    uint64 public minDur; // min bet duration (s)
    uint64 public maxDur; // max bet duration (s)
    uint64 public strikeDelay; // Δ: future lead from open to strikeInstant (s)
    uint64 public settleTol; // TOL: Unique upper-bound window past each instant (s)
    uint64 public settleGrace; // after strikeInstant+dur+grace, anyone may voidExpired()

    enum Result {
        Open,
        Win,
        Loss,
        Void
    }

    struct Market {
        bytes32 feedId;
        bool enabled;
    }

    /// @dev One matured, unsettled bet — everything the keeper needs to fetch Hermes and settle.
    struct Pending {
        uint256 betId;
        bytes32 feedId;
        uint64 strikeInstant;
        uint64 dur;
    }

    struct Position {
        address bettor; // slot 0: 160 + 32 + 32 + 8 + 8
        uint32 marketId;
        uint32 payoutBps; // odds snapshot at open
        bool up;
        Result result;
        uint128 stake; // slot 1
        uint128 reserve; // ⌈(m−1)·stake⌉ locked on the vault (stored to release the exact amount)
        uint64 strikeInstant; // slot 2: first-tick-≥ anchor for the strike (= openTime + Δ)
        uint64 dur; // N seconds; close anchor = strikeInstant + dur
        int64 strike; // pinned at settle (0 until then)
        int64 close; // pinned at settle
    }

    Market[] public markets;
    Position[] public positions;
    mapping(address => uint256) public openCount; // concurrent OPEN positions
    mapping(address => uint256[]) private _userPositions; // all betIds per user (paged views)
    mapping(uint256 => uint256) public owed; // betId => amount the bettor can claim (pull payment)
    address private _activeSettler; // set for the duration of a settleMany batch (self-call routing)

    event MarketAdded(uint256 indexed marketId, bytes32 indexed feedId);
    event MarketEnabled(uint256 indexed marketId, bool enabled);
    event ParamsSet(
        uint256 payoutBps,
        uint256 maxBetExposureBps,
        uint256 maxAggExposureBps,
        uint256 minBet,
        uint256 maxBet
    );
    event GuardsSet(
        uint256 maxConfBps,
        uint256 tipBps,
        uint256 maxTip,
        uint32 maxOpenPerUser,
        uint64 minDur,
        uint64 maxDur,
        uint64 strikeDelay,
        uint64 settleTol,
        uint64 settleGrace
    );
    event BetOpened(
        uint256 indexed betId,
        address indexed bettor,
        uint256 indexed marketId,
        bool up,
        uint256 stake,
        uint64 strikeInstant,
        uint64 dur,
        uint32 payoutBps,
        uint256 reserve
    );
    event BetSettled(
        uint256 indexed betId,
        address indexed settler,
        int64 strike,
        int64 close,
        Result result,
        uint256 payout,
        uint256 tip
    );
    event Claimed(uint256 indexed betId, address indexed bettor, uint256 amount);

    error PayoutOutOfRange();
    error ExposureCapTooHigh();
    error BadParams();
    error NoSuchMarket();
    error MarketDisabled();
    error BadDuration();
    error ZeroAmount();
    error BetTooSmall();
    error BetTooBig();
    error TooManyOpen();
    error BetCapExceeded();
    error AggCapExceeded();
    error NotOpen();
    error NotMatured();
    error GraceNotElapsed();
    error InsufficientFee();
    error RefundFailed();
    error OnlySelf();
    error NothingToClaim();

    constructor(
        IPyth _pyth,
        HouseVault _vault,
        uint256 _payoutBps,
        uint256 _maxBetExposureBps,
        uint256 _maxAggExposureBps,
        uint256 _minBet,
        uint256 _maxBet
    ) Ownable(msg.sender) {
        if (_payoutBps <= BPS || _payoutBps > MAX_PAYOUT_BPS) revert PayoutOutOfRange();
        if (_maxBetExposureBps > MAX_EXPOSURE_BPS || _maxAggExposureBps > MAX_EXPOSURE_BPS) {
            revert ExposureCapTooHigh();
        }
        if (_minBet == 0 || _maxBet < _minBet) revert BadParams();
        pyth = _pyth;
        vault = _vault;
        stakeToken = IERC20(_vault.asset());
        payoutBps = _payoutBps;
        maxBetExposureBps = _maxBetExposureBps;
        maxAggExposureBps = _maxAggExposureBps;
        minBet = _minBet;
        maxBet = _maxBet;
        // sane starting guards; owner tunes via setGuards before/after markets are added
        tipBps = 100; // 1% of stake
        maxTip = type(uint256).max;
        maxOpenPerUser = 25;
        minDur = 5;
        maxDur = 300;
        strikeDelay = 3;
        settleTol = 5;
        settleGrace = 1 hours;
    }

    // ---- admin ----
    function addMarket(bytes32 feedId) external onlyOwner returns (uint256 marketId) {
        marketId = markets.length;
        markets.push(Market({feedId: feedId, enabled: true}));
        emit MarketAdded(marketId, feedId);
    }

    function setMarketEnabled(uint256 marketId, bool enabled) external onlyOwner {
        if (marketId >= markets.length) revert NoSuchMarket();
        markets[marketId].enabled = enabled;
        emit MarketEnabled(marketId, enabled);
    }

    function setParams(
        uint256 _payoutBps,
        uint256 _maxBetExposureBps,
        uint256 _maxAggExposureBps,
        uint256 _minBet,
        uint256 _maxBet
    ) external onlyOwner {
        if (_payoutBps <= BPS || _payoutBps > MAX_PAYOUT_BPS) {
            revert PayoutOutOfRange();
        }
        if (_maxBetExposureBps > MAX_EXPOSURE_BPS || _maxAggExposureBps > MAX_EXPOSURE_BPS) {
            revert ExposureCapTooHigh();
        }
        if (_minBet == 0 || _maxBet < _minBet) revert BadParams();
        payoutBps = _payoutBps;
        maxBetExposureBps = _maxBetExposureBps;
        maxAggExposureBps = _maxAggExposureBps;
        minBet = _minBet;
        maxBet = _maxBet;
        emit ParamsSet(_payoutBps, _maxBetExposureBps, _maxAggExposureBps, _minBet, _maxBet);
    }

    function setGuards(
        uint256 _maxConfBps,
        uint256 _tipBps,
        uint256 _maxTip,
        uint32 _maxOpenPerUser,
        uint64 _minDur,
        uint64 _maxDur,
        uint64 _strikeDelay,
        uint64 _settleTol,
        uint64 _settleGrace
    ) external onlyOwner {
        // tip must be < the vig, else a settler could self-settle a loss for profit; cap at (m-1)/2.
        if (_tipBps > (payoutBps - BPS) / 2) revert BadParams();
        if (_maxOpenPerUser == 0 || _minDur == 0 || _maxDur < _minDur) revert BadParams();
        if (_strikeDelay == 0 || _settleTol == 0) revert BadParams();
        maxConfBps = _maxConfBps;
        tipBps = _tipBps;
        maxTip = _maxTip;
        maxOpenPerUser = _maxOpenPerUser;
        minDur = _minDur;
        maxDur = _maxDur;
        strikeDelay = _strikeDelay;
        settleTol = _settleTol;
        settleGrace = _settleGrace;
        emit GuardsSet(
            _maxConfBps,
            _tipBps,
            _maxTip,
            _maxOpenPerUser,
            _minDur,
            _maxDur,
            _strikeDelay,
            _settleTol,
            _settleGrace
        );
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---- bet lifecycle ----

    /// @notice Open a position vs the house. The strike is NOT set here — it will be pinned from
    /// the first Pyth tick at/after openTime+strikeDelay, a future instant, so the bettor commits
    /// blind. Escrows the stake and locks ⌈(m−1)·stake⌉ on the vault under the exposure caps.
    function openBet(uint256 marketId, bool up, uint256 stake, uint64 dur)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 betId)
    {
        if (marketId >= markets.length) revert NoSuchMarket();
        if (!markets[marketId].enabled) revert MarketDisabled();
        if (stake == 0) revert ZeroAmount();
        if (stake < minBet) revert BetTooSmall();
        if (stake > maxBet) revert BetTooBig();
        if (dur < minDur || dur > maxDur) revert BadDuration();
        if (openCount[msg.sender] >= maxOpenPerUser) revert TooManyOpen();

        uint256 m = payoutBps;
        uint256 reserve = _ceilDiv(stake * (m - BPS), BPS); // ⌈(m−1)·stake⌉, no netting
        uint256 bankroll = vault.totalAssets();
        if (reserve > _bps(bankroll, maxBetExposureBps)) revert BetCapExceeded();
        if (vault.reservedExposure() + reserve > _bps(bankroll, maxAggExposureBps)) revert AggCapExceeded();

        stakeToken.safeTransferFrom(msg.sender, address(this), stake);
        vault.reserve(reserve); // also reverts if it would break vault solvency

        // forge-lint: disable-next-line(unsafe-typecast) — block.timestamp fits uint64 for ~5.8e11 years
        uint64 strikeInstant = uint64(block.timestamp) + strikeDelay;
        betId = positions.length;
        positions.push(
            Position({
                bettor: msg.sender,
                // forge-lint: disable-next-line(unsafe-typecast) — marketId < markets.length, bounded << 2^32
                marketId: uint32(marketId),
                // forge-lint: disable-next-line(unsafe-typecast) — m <= MAX_PAYOUT_BPS (19900) fits uint32
                payoutBps: uint32(m),
                up: up,
                result: Result.Open,
                stake: stake.toUint128(),
                reserve: reserve.toUint128(),
                strikeInstant: strikeInstant,
                dur: dur,
                strike: 0,
                close: 0
            })
        );
        openCount[msg.sender] += 1;
        _userPositions[msg.sender].push(betId);
        // forge-lint: disable-next-line(unsafe-typecast) — m <= MAX_PAYOUT_BPS (19900) fits uint32
        emit BetOpened(betId, msg.sender, marketId, up, stake, strikeInstant, dur, uint32(m), reserve);
    }

    /// @notice Settle a matured bet. Pays the caller a tip from escrow, so a keeper (or anyone) is
    /// incentivised to settle even losing bets. Reads the strike and close from the two fixed past
    /// instants via Unique — deterministic, cherry-pick-proof. Winner's proceeds are pull (claim()).
    function settle(uint256 betId, bytes[] calldata strikeData, bytes[] calldata closeData)
        external
        payable
        nonReentrant
    {
        uint256 fee = _totalFee(strikeData, closeData);
        if (msg.value < fee) revert InsufficientFee();
        _settle(betId, strikeData, closeData, msg.sender);
        _refund(msg.value - fee);
    }

    /// @notice Batch settle. Skips (does not revert) any bet that isn't matured/open or whose oracle
    /// read fails, so one bad bet can't block the sweep. msg.value must cover the sum of update fees;
    /// unspent value is refunded.
    function settleMany(
        uint256[] calldata betIds,
        bytes[][] calldata strikeData,
        bytes[][] calldata closeData
    ) external payable nonReentrant {
        uint256 n = betIds.length;
        if (strikeData.length != n || closeData.length != n) revert BadParams();
        uint256 spent;
        _activeSettler = msg.sender; // routes each self-call's tip back to the original keeper
        for (uint256 i; i < n; i++) {
            uint256 fee = _totalFee(strikeData[i], closeData[i]);
            if (address(this).balance < fee) break; // out of forwarded value; stop cleanly
            // external self-call so a single bad bet reverts in isolation (skip-not-revert)
            try this.settleFor{value: fee}(betIds[i], strikeData[i], closeData[i]) {
                spent += fee;
            } catch {
                // not matured / already settled / empty oracle window -> skip
            }
        }
        _activeSettler = address(0);
        _refund(msg.value - spent);
    }

    /// @dev Self-call target for settleMany so the tip still routes to the original keeper (read from
    /// _activeSettler). Not for external callers (use settle()).
    function settleFor(uint256 betId, bytes[] calldata strikeData, bytes[] calldata closeData)
        external
        payable
    {
        if (msg.sender != address(this)) revert OnlySelf();
        _settle(betId, strikeData, closeData, _activeSettler);
    }

    function _settle(uint256 betId, bytes[] calldata strikeData, bytes[] calldata closeData, address settler)
        internal
    {
        Position storage p = positions[betId];
        if (p.result != Result.Open) revert NotOpen();
        (int64 strike, int64 close, bool voidIt) = _readOutcome(p, strikeData, closeData);
        _resolve(p, betId, settler, strike, close, voidIt);
    }

    /// @dev Maturity check + both Unique reads + confidence/tie evaluation. Split out to keep the
    /// settle stack shallow (via_ir depth).
    function _readOutcome(Position storage p, bytes[] calldata strikeData, bytes[] calldata closeData)
        internal
        returns (int64 strike, int64 close, bool voidIt)
    {
        uint64 strikeAt = p.strikeInstant;
        uint64 closeAt = strikeAt + p.dur;
        if (block.timestamp < closeAt) revert NotMatured();
        bytes32 feedId = markets[p.marketId].feedId;
        // Each read is scoped so the two Price structs never share a stack frame (via_ir depth).
        bool badStrike;
        bool badClose;
        (strike, badStrike) = _readOne(feedId, strikeData, strikeAt);
        (close, badClose) = _readOne(feedId, closeData, closeAt);
        voidIt = (strike == close) || badStrike || badClose;
    }

    /// @dev One Unique read: the first tick at/after `at` (within TOL), plus whether its confidence
    /// band is too wide to trust.
    function _readOne(bytes32 feedId, bytes[] calldata data, uint64 at)
        internal
        returns (int64 price, bool bad)
    {
        PythStructs.Price memory p = _readUnique(feedId, data, at, at + settleTol);
        price = p.price;
        bad = _confTooWide(p);
    }

    /// @dev Money movement: free the reservation first (keeps the vault solvent on pay), tip the
    /// settler from escrow on every path, then win/loss/void the rest. Bettor proceeds are pull.
    function _resolve(
        Position storage p,
        uint256 betId,
        address settler,
        int64 strike,
        int64 close,
        bool voidIt
    ) internal {
        uint256 stake = p.stake;
        uint256 tip = _tip(stake);
        vault.release(p.reserve);
        p.strike = strike;
        p.close = close;
        stakeToken.safeTransfer(settler, tip); // settler paid on every path (win/loss/void)

        uint256 payout; // owed to the bettor (pull)
        Result result;
        if (voidIt) {
            result = Result.Void; // tie or untrustworthy price: refund stake − tip, zero house P&L
            payout = stake - tip;
        } else if (p.up ? close > strike : close < strike) {
            result = Result.Win;
            uint256 distributable = (stake * p.payoutBps) / BPS; // m·stake (floored)
            vault.payWinnings(address(this), distributable - stake); // pull the (m−1)·stake shortfall
            payout = distributable - tip;
        } else {
            result = Result.Loss;
            stakeToken.safeTransfer(address(vault), stake - tip); // losing stake (minus tip) -> LPs
        }
        p.result = result;
        owed[betId] = payout;
        openCount[p.bettor] -= 1;
        emit BetSettled(betId, settler, strike, close, result, payout, tip);
    }

    /// @notice Permissionless refund hatch: if a bet never settles (oracle/keeper down) once past
    /// grace, OR while the contract is paused, free the escrow + reservation so nothing locks. Pays
    /// the caller the same tip (incentivise cleanup).
    function voidExpired(uint256 betId) external nonReentrant {
        Position storage p = positions[betId];
        if (p.result != Result.Open) revert NotOpen();
        uint64 deadline = p.strikeInstant + p.dur + settleGrace;
        if (block.timestamp < deadline && !paused()) revert GraceNotElapsed();

        uint256 stake = p.stake;
        uint256 tip = _tip(stake);
        vault.release(p.reserve);
        p.result = Result.Void;
        owed[betId] = stake - tip;
        openCount[p.bettor] -= 1;
        stakeToken.safeTransfer(msg.sender, tip);
        emit BetSettled(betId, msg.sender, 0, 0, Result.Void, stake - tip, tip);
    }

    /// @notice Pull the bettor's proceeds (winnings or a void refund). No-op paths revert.
    function claim(uint256 betId) external nonReentrant {
        uint256 amount = owed[betId];
        if (amount == 0) revert NothingToClaim();
        owed[betId] = 0;
        address bettor = positions[betId].bettor;
        stakeToken.safeTransfer(bettor, amount);
        emit Claimed(betId, bettor, amount);
    }

    // ---- views ----
    function positionsLength() external view returns (uint256) {
        return positions.length;
    }

    function marketsLength() external view returns (uint256) {
        return markets.length;
    }

    function getPosition(uint256 betId) external view returns (Position memory) {
        return positions[betId];
    }

    /// @notice Paged list of a user's betIds (never scans the whole book). Returns up to `count`
    /// ids starting at `start`, plus the user's total position count for cursor math.
    function positionsOf(address user, uint256 start, uint256 count)
        external
        view
        returns (uint256[] memory ids, uint256 total)
    {
        uint256[] storage all = _userPositions[user];
        total = all.length;
        if (start >= total) return (new uint256[](0), total);
        uint256 end = start + count;
        if (end > total) end = total;
        ids = new uint256[](end - start);
        for (uint256 i = start; i < end; i++) {
            ids[i - start] = all[i];
        }
    }

    /// @notice Vault-side max loss this contract would reserve for a hypothetical stake at current odds.
    function reserveFor(uint256 stake) external view returns (uint256) {
        return _ceilDiv(stake * (payoutBps - BPS), BPS);
    }

    /// @notice Keeper feed: scan positions[start, start+max) and return those still Open AND matured
    /// (now >= strikeInstant + dur), ready to settle. `nextCursor` is where to resume paging; the
    /// keeper walks from 0 to positionsLength() collecting these, then settleMany()s them.
    function pendingSettlement(uint256 start, uint256 max)
        external
        view
        returns (Pending[] memory list, uint256 nextCursor)
    {
        uint256 end = start + max;
        if (end > positions.length) end = positions.length;
        nextCursor = end;
        uint256 n = end > start ? end - start : 0;
        Pending[] memory buf = new Pending[](n);
        uint256 k;
        for (uint256 i = start; i < end; i++) {
            Position storage p = positions[i];
            if (p.result == Result.Open && block.timestamp >= uint256(p.strikeInstant) + p.dur) {
                buf[k++] = Pending(i, markets[p.marketId].feedId, p.strikeInstant, p.dur);
            }
        }
        list = new Pending[](k);
        for (uint256 j; j < k; j++) {
            list[j] = buf[j];
        }
    }

    /// @notice LP-panel stats: bankroll, locked exposure, free capital, share price.
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

    // ---- internal ----
    function _tip(uint256 stake) internal view returns (uint256 t) {
        t = (stake * tipBps) / BPS;
        if (t > maxTip) t = maxTip;
    }

    function _totalFee(bytes[] calldata strikeData, bytes[] calldata closeData)
        internal
        view
        returns (uint256)
    {
        return pyth.getUpdateFee(strikeData) + pyth.getUpdateFee(closeData);
    }

    /// @dev Pull the FIRST Pyth tick whose publishTime is in [minT, maxT] via Unique (cherry-pick
    /// proof), paying the update fee from this contract's balance (msg.value, pooled in batches).
    function _readUnique(bytes32 feedId, bytes[] calldata data, uint64 minT, uint64 maxT)
        internal
        returns (PythStructs.Price memory)
    {
        uint256 fee = pyth.getUpdateFee(data);
        if (address(this).balance < fee) revert InsufficientFee();
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        PythStructs.PriceFeed[] memory pf =
            IPythUnique(address(pyth)).parsePriceFeedUpdatesUnique{value: fee}(data, ids, minT, maxT);
        return pf[0].price;
    }

    function _confTooWide(PythStructs.Price memory p) internal view returns (bool) {
        if (maxConfBps == 0) return false; // guard disabled
        uint256 absPrice = p.price >= 0 ? uint256(uint64(p.price)) : uint256(uint64(-p.price));
        if (absPrice == 0) return true; // no usable price -> untrustworthy
        return uint256(p.conf) * BPS / absPrice > maxConfBps;
    }

    function _refund(uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert RefundFailed();
    }

    function _bps(uint256 x, uint256 bps) internal pure returns (uint256) {
        return (x * bps) / BPS;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
