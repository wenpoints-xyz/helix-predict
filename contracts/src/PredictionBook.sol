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
    /// @dev Also missing from the vendored IPyth interface (like Unique above); present on the deployed
    /// Pyth receiver. The INJ cost of ONE price update — v3 sizes each bet's settle-fee escrow from it.
    function singleUpdateFeeInWei() external view returns (uint256);
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
    uint64 public constant MIN_SETTLE_GRACE = 60; // grace floor: keeper always gets >=60s before a void race
    uint64 public constant MAX_SESSION = 24 hours; // hard cap on a session-key grant's lifetime
    uint256 public constant MAX_FEE_BUFFER_BPS = 5000; // fee-escrow buffer can never exceed 50%
    uint256 public constant GAS_COMP_CAP_MULT = 3; // gasComp <= 3x a single Pyth update fee (rent-lever bound)

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
    // ---- v3 fee escrow (owner-tunable, hard-capped) ----
    uint256 public feeBufferBps; // headroom over 2 Pyth updates, absorbs fee drift between open & settle
    uint256 public gasCompWei; // flat INJ paid to the settler for gas, on top of the actual Pyth fee

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
        uint128 feeEscrow; // slot 3: INJ prepaid at open to fund this bet's settlement (v3)
    }

    /// @dev A browser session key a bettor authorises to open bets on their behalf (openBetFor), so the
    /// arcade UI can fire bets without a wallet popup per tap. Blast radius of a stolen key is bounded by
    /// TWO on-chain walls: maxSpend (cumulative-stake budget, decoupled from the ERC20 allowance) and
    /// expiry (<= now + MAX_SESSION). revokeSession() kills it instantly. (v3 dropped the per-bet maxStake
    /// wall: it was redundant — a single bet is already capped by the global maxBet + exposure caps, and
    /// the frontend never surfaced it. A single openBetFor can now spend up to min(maxSpend, maxBet).)
    struct Session {
        address key; // slot 0: 160 + 64
        uint64 expiry; // grant dies at this timestamp
        uint128 maxSpend; // slot 1: cumulative-stake budget; sum of stakes opened via this key may not exceed it
        uint128 spent; // monotonic odometer of stake wagered via this key (reset on re-grant)
    }

    Market[] public markets;
    Position[] public positions;
    mapping(address => uint256) public openCount; // concurrent OPEN positions
    mapping(address => uint256[]) private _userPositions; // all betIds per user (paged views)
    mapping(uint256 => uint256) public owed; // betId => amount the bettor can claim (pull payment)
    mapping(address => uint256) public owedInj; // address => native INJ they can claim (pull fallback, v3)
    mapping(address => Session) public sessions; // bettor => their one active session-key grant
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
    event ClaimedInj(address indexed to, uint256 amount);
    event FeeParamsSet(uint256 feeBufferBps, uint256 gasCompWei);
    event SessionGranted(address indexed bettor, address indexed key, uint64 expiry, uint128 maxSpend);
    event SessionRevoked(address indexed bettor, address indexed key);

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
    error BadSession();
    error NotSessionKey();
    error SessionExpired();
    error SessionBudgetExceeded();
    error InsufficientOpenFee(); // openBet/openBetFor msg.value < the required settle-fee escrow (v3)

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
        maxConfBps = 200; // 2% conf band — confidence guard ON from deploy (never leave it 0/disabled)
        tipBps = 100; // 1% of stake
        maxTip = type(uint256).max;
        maxOpenPerUser = 25;
        minDur = 5;
        maxDur = 300;
        strikeDelay = 3;
        settleTol = 5;
        settleGrace = 1 hours;
        feeBufferBps = 1000; // 10% headroom over the 2 Pyth updates
        gasCompWei = 5e14; // 0.0005 INJ flat settler gas comp (owner retunes via setFeeParams within caps)
    }

    /// @notice Tune the settle-fee escrow sizing. Bettors prepay `openCost()` at open; the settler is
    /// reimbursed at settle. Both knobs are hard-capped so a malicious owner can't turn the oracle fee
    /// into an unbounded per-bet INJ skim: buffer <= 50%, gasComp <= 3x a single Pyth update fee.
    /// Snapshotted per bet at open (p.feeEscrow), so a change never affects already-open bets.
    function setFeeParams(uint256 _feeBufferBps, uint256 _gasCompWei) external onlyOwner {
        if (_feeBufferBps > MAX_FEE_BUFFER_BPS) revert BadParams();
        if (_gasCompWei > GAS_COMP_CAP_MULT * _singleUpdateFee()) revert BadParams();
        feeBufferBps = _feeBufferBps;
        gasCompWei = _gasCompWei;
        emit FeeParamsSet(_feeBufferBps, _gasCompWei);
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
        // Raising payout shrinks the house edge; the standing tip must still be < that edge or a
        // matched up/down self-settle drains the vault. Re-check the same invariant setGuards enforces.
        if (tipBps > _maxEdgeBps(_payoutBps)) revert BadParams();
        payoutBps = _payoutBps;
        maxBetExposureBps = _maxBetExposureBps;
        maxAggExposureBps = _maxAggExposureBps;
        minBet = _minBet;
        maxBet = _maxBet;
        emit ParamsSet(_payoutBps, _maxBetExposureBps, _maxAggExposureBps, _minBet, _maxBet);
    }

    /// @dev The per-bet house edge in bps = 2*BPS - payoutBps (the vig on a matched up+down pair).
    /// The settler tip must stay <= this, else a same-block up/down self-settle nets a risk-free
    /// profit (tip income > vig) straight out of LP capital.
    function _maxEdgeBps(uint256 payout) internal pure returns (uint256) {
        return 2 * BPS - payout; // payout <= MAX_PAYOUT_BPS (19900) so this is in [100, BPS)
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
        // Tip must be <= the house edge (2*BPS - payoutBps). The old bound (payoutBps-BPS)/2 was
        // wrong: it caps at half the RESERVATION, but the drain vector is a matched up+down pair
        // self-settled in one block (identical strike/close -> exactly one win + one loss, no price
        // risk), where the settler collects the tip on both legs. Profit > 0 iff tip > vig. A zero
        // tip removes the settle incentive (and can brick settles on zero-reverting tokens), so
        // require > 0.
        if (_tipBps == 0 || _tipBps > _maxEdgeBps(payoutBps)) revert BadParams();
        if (_maxOpenPerUser == 0 || _minDur == 0 || _maxDur < _minDur) revert BadParams();
        if (_strikeDelay == 0 || _settleTol == 0) revert BadParams();
        if (_settleGrace < MIN_SETTLE_GRACE) revert BadParams(); // no void-race window at maturity
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
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 betId)
    {
        return _open(msg.sender, marketId, up, stake, dur);
    }

    /// @notice Open a position ON BEHALF OF `bettor`, authorised by a session key the bettor granted
    /// (grantSession). msg.sender must be that key, within the per-bet (maxStake) and cumulative-stake
    /// (maxSpend) budgets and before expiry. The stake is escrowed from the BETTOR (their allowance),
    /// the position/winnings accrue to the BETTOR — the session key only signs + pays its own gas.
    function openBetFor(address bettor, uint256 marketId, bool up, uint256 stake, uint64 dur)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 betId)
    {
        Session storage s = sessions[bettor];
        if (msg.sender != s.key) revert NotSessionKey();
        if (block.timestamp >= s.expiry) revert SessionExpired();
        // Monotonic budget odometer: cap TOTAL stake wagered via this key, decoupled from the ERC20
        // allowance (which stays large for manual-betting UX). _open enforces stake <= maxBet (so it
        // fits uint128); the checked add reverts on the impossible overflow. NOT reduced on wins — else
        // a stolen key could churn break-even bets forever under the same budget.
        if (stake > maxBet) revert BetTooBig(); // bound BEFORE the uint128 cast (maxStake wall is gone)
        uint128 newSpent = s.spent + uint128(stake);
        if (newSpent > s.maxSpend) revert SessionBudgetExceeded();
        s.spent = newSpent;
        return _open(bettor, marketId, up, stake, dur);
    }

    /// @dev Shared open path for openBet (bettor == msg.sender) and openBetFor (bettor set by a session
    /// key). Escrows `stake` from `bettor`, locks ⌈(m−1)·stake⌉ on the vault under the exposure caps,
    /// and records the position under `bettor`. Callers carry nonReentrant + whenNotPaused.
    function _open(address bettor, uint256 marketId, bool up, uint256 stake, uint64 dur)
        internal
        returns (uint256 betId)
    {
        if (marketId >= markets.length) revert NoSuchMarket();
        if (!markets[marketId].enabled) revert MarketDisabled();
        if (stake == 0) revert ZeroAmount();
        if (stake < minBet) revert BetTooSmall();
        if (stake > maxBet) revert BetTooBig();
        if (dur < minDur || dur > maxDur) revert BadDuration();
        if (openCount[bettor] >= maxOpenPerUser) revert TooManyOpen();

        // v3: the bet prepays its own settlement in INJ (msg.value). Snapshot the required escrow now so
        // a later fee/param change never touches this bet; refund any excess at the end.
        uint256 feeEscrow = _openCost();
        if (msg.value < feeEscrow) revert InsufficientOpenFee();

        uint256 m = payoutBps;
        uint256 reserve = _ceilDiv(stake * (m - BPS), BPS); // ⌈(m−1)·stake⌉, no netting
        uint256 bankroll = vault.totalAssets();
        if (reserve > _bps(bankroll, maxBetExposureBps)) revert BetCapExceeded();
        if (vault.reservedExposure() + reserve > _bps(bankroll, maxAggExposureBps)) revert AggCapExceeded();

        stakeToken.safeTransferFrom(bettor, address(this), stake);
        vault.reserve(reserve); // also reverts if it would break vault solvency

        // forge-lint: disable-next-line(unsafe-typecast) — block.timestamp fits uint64 for ~5.8e11 years
        uint64 strikeInstant = uint64(block.timestamp) + strikeDelay;
        betId = positions.length;
        positions.push(
            Position({
                bettor: bettor,
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
                close: 0,
                feeEscrow: feeEscrow.toUint128()
            })
        );
        openCount[bettor] += 1;
        _userPositions[bettor].push(betId);
        // forge-lint: disable-next-line(unsafe-typecast) — m <= MAX_PAYOUT_BPS (19900) fits uint32
        emit BetOpened(betId, bettor, marketId, up, stake, strikeInstant, dur, uint32(m), reserve);
        _refund(msg.value - feeEscrow); // return the bettor's over-attach (reverts if they can't receive)
    }

    /// @notice Authorise a browser `key` to open bets on the caller's behalf (openBetFor). Overwrites
    /// any prior grant and RESETS the spend odometer. `maxSpend` (cumulative stake) is the risk budget;
    /// `expiry` must be within MAX_SESSION. One grant per bettor.
    function grantSession(address key, uint64 expiry, uint128 maxSpend) external {
        if (key == address(0)) revert BadSession();
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_SESSION) revert BadSession();
        if (maxSpend == 0) revert BadSession();
        sessions[msg.sender] = Session({key: key, expiry: expiry, maxSpend: maxSpend, spent: 0});
        emit SessionGranted(msg.sender, key, expiry, maxSpend);
    }

    /// @notice Instantly kill the caller's session key. NOT whenNotPaused-gated — a user must always be
    /// able to revoke, including during a pause.
    function revokeSession() external {
        address key = sessions[msg.sender].key;
        delete sessions[msg.sender];
        emit SessionRevoked(msg.sender, key);
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
        _settle(betId, strikeData, closeData, msg.sender, fee);
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
        // Budget against msg.value ONLY — never address(this).balance. A griefer can force-send INJ
        // (selfdestruct) to inflate the balance; if the loop spent past msg.value, the refund below
        // would underflow and revert the whole batch. Tracking a local msg.value budget keeps
        // spent <= msg.value, so the refund can never underflow.
        uint256 budget = msg.value;
        uint256 spent;
        _activeSettler = msg.sender; // routes each self-call's tip back to the original keeper
        for (uint256 i; i < n; i++) {
            uint256 fee = _totalFee(strikeData[i], closeData[i]);
            if (budget < fee) break; // out of forwarded value; stop cleanly
            // external self-call so a single bad bet reverts in isolation (skip-not-revert)
            try this.settleFor{value: fee}(betIds[i], strikeData[i], closeData[i]) {
                spent += fee;
                budget -= fee;
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
        _settle(betId, strikeData, closeData, _activeSettler, _totalFee(strikeData, closeData));
    }

    function _settle(
        uint256 betId,
        bytes[] calldata strikeData,
        bytes[] calldata closeData,
        address settler,
        uint256 pythFee
    ) internal {
        Position storage p = positions[betId];
        if (p.result != Result.Open) revert NotOpen();
        (int64 strike, int64 close, bool voidIt) = _readOutcome(p, strikeData, closeData);
        _resolve(p, betId, settler, strike, close, voidIt, pythFee);
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

    /// @dev Decide the outcome, write ALL contract state first (checks-effects-interactions), then
    /// move money: free the reservation, tip the settler from escrow, then win/loss/void the rest.
    /// Bettor proceeds are pull. CEI ordering + the nonReentrant entry points mean even a hooked
    /// stake token (the planned USDC/other swap) can't reenter into inconsistent state.
    function _resolve(
        Position storage p,
        uint256 betId,
        address settler,
        int64 strike,
        int64 close,
        bool voidIt,
        uint256 pythFee
    ) internal {
        uint256 stake = p.stake;
        uint256 tip = _tip(stake, p.payoutBps);

        // --- decide outcome (no external calls) ---
        uint256 payout; // owed to the bettor (pull)
        uint256 vaultPull; // (m−1)·stake to pull from the vault on a win
        uint256 vaultReturn; // losing stake (minus tip) to send back to LPs
        Result result;
        if (voidIt) {
            result = Result.Void; // tie or untrustworthy price: refund stake − tip, zero house P&L
            payout = stake - tip;
        } else if (p.up ? close > strike : close < strike) {
            result = Result.Win;
            uint256 distributable = (stake * p.payoutBps) / BPS; // m·stake (floored)
            vaultPull = distributable - stake; // the (m−1)·stake shortfall
            payout = distributable - tip;
        } else {
            result = Result.Loss;
            vaultReturn = stake - tip; // losing stake (minus tip) -> LPs
        }

        // --- EFFECTS: all state written before any external call ---
        p.strike = strike;
        p.close = close;
        p.result = result;
        owed[betId] = payout;
        openCount[p.bettor] -= 1;

        // --- INTERACTIONS: free reservation first (keeps the vault solvent on pay), then move money ---
        vault.release(p.reserve);
        if (tip > 0) stakeToken.safeTransfer(settler, tip); // settler paid on every path
        if (vaultPull > 0) vault.payWinnings(address(this), vaultPull);
        if (vaultReturn > 0) stakeToken.safeTransfer(address(vault), vaultReturn);
        // v3 INJ settle-fee escrow: the two Pyth reads already ran (in _readOutcome, BEFORE this) and
        // were paid from the settler's msg.value — so escrow NEVER funds Pyth. Now reimburse the settler
        // their fronted fee + gasComp from THIS bet's escrow, and refund the unused buffer to the bettor.
        // Both go through _payInj (best-effort .call, else owedInj) so a reverting wallet can't brick settle.
        uint256 esc = p.feeEscrow;
        uint256 reimb = pythFee + gasCompWei;
        if (reimb > esc) reimb = esc; // Pyth fee rose past the buffer -> settler eats the bounded sliver
        _payInj(settler, reimb);
        _payInj(p.bettor, esc - reimb); // buffer surplus back to the bettor, not the settler
        emit BetSettled(betId, settler, strike, close, result, payout, tip);
    }

    /// @notice Refund hatch so nothing locks. After grace (oracle/keeper down) it's permissionless.
    /// While PAUSED, the pre-grace fast path is restricted to the bettor's OWN self-rescue — otherwise
    /// a third party could mass-void other people's would-be-winning bets during a pause, denying them
    /// their upside for a skimmed tip. Pays the caller the same tip (incentivise cleanup / self-rescue).
    function voidExpired(uint256 betId) external nonReentrant {
        Position storage p = positions[betId];
        if (p.result != Result.Open) revert NotOpen();
        uint64 deadline = p.strikeInstant + p.dur + settleGrace;
        if (block.timestamp < deadline) {
            // pre-grace fast path exists only for un-resolvable positions during a pause: paused AND
            // the bettor's own bet AND NOT yet matured. A matured bet's win/loss is already knowable
            // (fixed past instants), so allowing a self-void there would let a bettor dodge a known
            // loss (void refunds stake-tip vs a loss forfeiting the stake) at LP expense — it must
            // instead go through settle (which works while paused) or the post-grace hatch.
            bool matured = block.timestamp >= uint256(p.strikeInstant) + p.dur;
            if (!paused() || msg.sender != p.bettor || matured) revert GraceNotElapsed();
        }

        uint256 stake = p.stake;
        uint256 tip = _tip(stake, p.payoutBps);
        uint256 payout = stake - tip;

        // EFFECTS before INTERACTIONS
        p.result = Result.Void;
        owed[betId] = payout;
        openCount[p.bettor] -= 1;

        vault.release(p.reserve);
        if (tip > 0) stakeToken.safeTransfer(msg.sender, tip);
        // v3: a void reads NO oracle, so the whole settle-fee escrow is unused -> refund it to the bettor
        // (via _payInj so a reverting bettor wallet can't brick this permissionless liveness hatch).
        _payInj(p.bettor, p.feeEscrow);
        emit BetSettled(betId, msg.sender, 0, 0, Result.Void, payout, tip);
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

    /// @notice Claim many bets' proceeds in one tx (CASH OUT ALL). Skip-not-revert on already-claimed /
    /// unowed ids so one stale id can't block the batch. Each pays the bet's own bettor. Zeroes before
    /// transfer; nonReentrant.
    function claimMany(uint256[] calldata betIds) external nonReentrant {
        for (uint256 i; i < betIds.length; i++) {
            uint256 betId = betIds[i];
            uint256 amount = owed[betId];
            if (amount == 0) continue; // already claimed / nothing owed -> skip
            owed[betId] = 0;
            address bettor = positions[betId].bettor;
            stakeToken.safeTransfer(bettor, amount);
            emit Claimed(betId, bettor, amount);
        }
    }

    /// @notice Pull native INJ credited to the caller when a best-effort refund/reimbursement .call
    /// failed (a reverting wallet on a void escrow refund, a settle buffer surplus, or a settler reimb).
    function claimInj() external nonReentrant {
        uint256 amount = owedInj[msg.sender];
        if (amount == 0) revert NothingToClaim();
        owedInj[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert RefundFailed();
        emit ClaimedInj(msg.sender, amount);
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

    /// @notice The INJ a bettor must attach to openBet/openBetFor at this instant (the settle-fee escrow).
    /// The frontend reads this and over-attaches a slippage margin; the contract refunds the excess.
    function openCost() external view returns (uint256) {
        return _openCost();
    }

    // ---- internal ----
    /// @dev Settler tip = tipBps of stake, capped by maxTip AND by the bet's OWN snapshot edge.
    /// The snapshot-edge cap is the load-bearing one: payoutBps is fixed per bet at open, but tipBps
    /// is global, so an owner lowering payout + raising tip would otherwise push the tip above an
    /// already-open bet's vig, reopening the matched-pair self-settle drain. Capping at the per-bet
    /// edge makes tip <= that bet's vig unconditionally, whatever the live params later become.
    function _tip(uint256 stake, uint256 betPayoutBps) internal view returns (uint256 t) {
        t = (stake * tipBps) / BPS;
        if (t > maxTip) t = maxTip;
        uint256 edgeCap = (stake * _maxEdgeBps(betPayoutBps)) / BPS;
        if (t > edgeCap) t = edgeCap;
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

    function _singleUpdateFee() internal view returns (uint256) {
        return IPythUnique(address(pyth)).singleUpdateFeeInWei();
    }

    /// @dev The v3 settle-fee escrow required at open: 2 Pyth updates (strike + close) × the fee-drift
    /// buffer, plus a flat gas comp for the settler. Sized for SINGLE-FEED updateData — the keeper must
    /// post one price ID per read (getUpdateFee = numFeeds × single), or a multi-feed blob overruns this.
    function _openCost() internal view returns (uint256) {
        return 2 * _singleUpdateFee() * (BPS + feeBufferBps) / BPS + gasCompWei;
    }

    /// @dev Send native INJ best-effort; on failure credit a pull mapping and RETURN (never revert the
    /// caller). This is the one path for all bettor/settler-bound native value (void escrow refund,
    /// settle buffer surplus, settler reimbursement) so a reverting wallet can never brick a state
    /// transition — critical for the permissionless voidExpired liveness hatch and for settle.
    function _payInj(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) owedInj[to] += amount;
    }

    function _bps(uint256 x, uint256 bps) internal pure returns (uint256) {
        return (x * bps) / BPS;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
