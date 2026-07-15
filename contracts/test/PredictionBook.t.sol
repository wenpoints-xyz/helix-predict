// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PredictionBook} from "../src/PredictionBook.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockPythUnique} from "./mocks/MockPythUnique.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Points", "PTS") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev A bettor contract with NO receive/fallback: it can open bets but CANNOT accept native INJ, so
/// the v3 escrow refund .call to it fails — exercising the _payInj pull fallback (owedInj) that keeps
/// voidExpired/settle from being bricked by a hostile wallet.
contract NoReceive {
    PredictionBook book;

    constructor(PredictionBook b, IERC20 t) {
        book = b;
        t.approve(address(b), type(uint256).max);
    }

    function open(uint256 mkt, bool up, uint256 stake, uint64 dur, uint256 fee) external returns (uint256) {
        return book.openBet{value: fee}(mkt, up, stake, dur);
    }
}

/// @dev Tests for PredictionBook: per-user positions, future-instant strike, deterministic Unique
/// settle, tip-from-escrow, no-netting reserve, void/expiry, caps, paged views.
///
///   openBet ─► [Open] ──(strikeInstant=t+Δ)── strike knowable ──(strikeInstant+dur)──► settle
///     strike = firstTick>=strikeInstant ; close = firstTick>=strikeInstant+dur   (both Unique)
///     win: m·stake−tip owed (pull) | loss: stake−tip→vault | void: stake−tip refund ; tip→settler
contract PredictionBookTest is Test {
    MockPythUnique pyth;
    MockERC20 token;
    HouseVault vault;
    PredictionBook book;

    bytes32 constant FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    uint256 constant FEE = 1; // per-update mock fee
    uint256 constant M = 19500; // 1.95x
    uint256 constant MINBET = 1 ether;
    uint256 constant MAXBET = 100_000 ether;
    uint64 constant DELTA = 3; // strikeDelay
    uint64 constant TOL = 5; // settleTol
    uint64 constant GRACE = 1 hours;
    uint256 marketId;
    uint256 OPEN_FEE; // book.openCost() — INJ escrow each bet prepays (v3)

    address lp = address(0x11D);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    receive() external payable {} // this contract settles in tests; accept Pyth-fee refunds

    function setUp() public {
        pyth = new MockPythUnique(60, FEE);
        token = new MockERC20();
        vault = new HouseVault(IERC20(address(token)), "HELIX House LP", "hHLX");
        book = new PredictionBook(
            IPyth(address(pyth)),
            vault,
            M, // 1.95x
            5000, // maxBetExposureBps (50%)
            5000, // maxAggExposureBps (50%)
            MINBET,
            MAXBET
        );
        vault.setHouse(address(book));
        // guards: maxConf disabled, tip 1%, no maxTip cap, 25 open, dur 5..300, Δ=3, TOL=5, grace 1h
        book.setGuards(0, 100, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE);
        marketId = book.addMarket(FEED);
        OPEN_FEE = book.openCost(); // v3: INJ each bet must prepay for its settlement (≈ gasCompWei here)

        vm.warp(1_000_000);
        vm.deal(address(this), 100 ether);

        token.mint(lp, 1_000_000 ether);
        vm.startPrank(lp);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000 ether, lp);
        vm.stopPrank();

        address[2] memory users = [alice, bob];
        for (uint256 i; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.deal(users[i], 100 ether); // v3: bettors need INJ to attach the settle-fee escrow
            vm.prank(users[i]);
            token.approve(address(book), type(uint256).max);
        }
        vm.deal(sessionKey, 100 ether); // v3: the session key funds the escrow when it opens for a bettor
    }

    // ---- helpers ----
    function _open(address u, bool up, uint256 stake, uint64 dur) internal returns (uint256 betId) {
        vm.prank(u);
        betId = book.openBet{value: OPEN_FEE}(marketId, up, stake, dur);
    }

    function _uupd(int64 price, uint64 conf, uint64 pt, uint64 prevPt)
        internal
        view
        returns (bytes[] memory d)
    {
        d = new bytes[](1);
        d[0] = pyth.createUniqueUpdateData(FEED, price, conf, -8, pt, prevPt);
    }

    /// @dev Settle a matured bet with honest first-tick updates at both instants.
    function _settle(uint256 betId, int64 strikePrice, int64 closePrice, uint64 sConf, uint64 cConf)
        internal
    {
        PredictionBook.Position memory p = book.getPosition(betId);
        uint64 sAt = p.strikeInstant;
        uint64 cAt = sAt + p.dur;
        if (block.timestamp < cAt) vm.warp(cAt);
        bytes[] memory sData = _uupd(strikePrice, sConf, sAt, sAt - 1);
        bytes[] memory cData = _uupd(closePrice, cConf, cAt, cAt - 1);
        book.settle{value: 2 * FEE}(betId, sData, cData);
    }

    function _reserveOf(uint256 stake) internal pure returns (uint256) {
        // ceil((m-1)*stake / BPS)
        uint256 num = stake * (M - 10000);
        return num == 0 ? 0 : (num - 1) / 10000 + 1;
    }

    // ---- openBet ----
    function test_OpenBet_reservesEscrowsAndStores() public {
        uint256 stake = 100 ether;
        uint256 betId = _open(alice, true, stake, 30);
        assertEq(token.balanceOf(address(book)), stake, "escrow");
        assertEq(vault.reservedExposure(), _reserveOf(stake), "reserve");
        assertEq(book.openCount(alice), 1);
        PredictionBook.Position memory p = book.getPosition(betId);
        assertEq(p.bettor, alice);
        assertEq(p.strike, 0, "strike unset at open");
        assertEq(p.close, 0);
        assertEq(uint256(p.strikeInstant), block.timestamp + DELTA, "future strike instant");
        assertEq(uint8(p.result), uint8(PredictionBook.Result.Open));
    }

    function test_OpenBet_rejects() public {
        vm.prank(alice);
        vm.expectRevert(PredictionBook.BetTooSmall.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, MINBET - 1, 30);

        vm.prank(alice);
        vm.expectRevert(PredictionBook.BetTooBig.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, MAXBET + 1, 30);

        vm.prank(alice);
        vm.expectRevert(PredictionBook.BadDuration.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, 10 ether, 4); // < minDur

        vm.prank(alice);
        vm.expectRevert(PredictionBook.BadDuration.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, 10 ether, 301); // > maxDur

        vm.prank(alice);
        vm.expectRevert(PredictionBook.NoSuchMarket.selector);
        book.openBet{value: OPEN_FEE}(99, true, 10 ether, 30);
    }

    function test_OpenBet_disabledMarket() public {
        book.setMarketEnabled(marketId, false);
        vm.prank(alice);
        vm.expectRevert(PredictionBook.MarketDisabled.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, 10 ether, 30);
    }

    function test_OpenBet_maxOpenCap() public {
        book.setGuards(0, 100, type(uint256).max, 2, 5, 300, DELTA, TOL, GRACE); // cap 2
        _open(alice, true, 10 ether, 30);
        _open(alice, true, 10 ether, 30);
        vm.prank(alice);
        vm.expectRevert(PredictionBook.TooManyOpen.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, 10 ether, 30);
    }

    // ---- settle: win / loss / void ----
    function test_Settle_Win_paysMStakeMinusTip() public {
        uint256 stake = 100 ether;
        uint256 betId = _open(alice, true, stake, 30);
        uint256 vaultBefore = vault.totalAssets();
        uint256 aliceBefore = token.balanceOf(alice);

        _settle(betId, 100_000, 100_001, 0, 0); // up, close > strike -> win

        PredictionBook.Position memory p = book.getPosition(betId);
        assertEq(uint8(p.result), uint8(PredictionBook.Result.Win));
        uint256 tip = (stake * 100) / 10000;
        uint256 distributable = (stake * M) / 10000; // m*stake
        assertEq(book.owed(betId), distributable - tip, "owed = m*stake - tip");
        assertEq(vault.reservedExposure(), 0, "reserve released");
        assertEq(token.balanceOf(address(this)), tip, "settler tip"); // this contract settled
        // vault paid the (m-1)*stake shortfall
        assertEq(vaultBefore - vault.totalAssets(), distributable - stake, "vault paid shortfall");

        book.claim(betId);
        assertEq(token.balanceOf(alice) - aliceBefore, distributable - tip, "alice claimed");
        assertEq(book.openCount(alice), 0);
    }

    function test_Settle_Loss_stakeToVaultMinusTip() public {
        uint256 stake = 100 ether;
        uint256 betId = _open(alice, true, stake, 30);
        uint256 vaultBefore = vault.totalAssets();

        _settle(betId, 100_000, 99_999, 0, 0); // up, close < strike -> loss

        PredictionBook.Position memory p = book.getPosition(betId);
        assertEq(uint8(p.result), uint8(PredictionBook.Result.Loss));
        assertEq(book.owed(betId), 0);
        uint256 tip = (stake * 100) / 10000;
        assertEq(vault.totalAssets() - vaultBefore, stake - tip, "loser stake (minus tip) -> LPs");
        assertEq(vault.reservedExposure(), 0);
        assertEq(token.balanceOf(address(this)), tip);
        vm.expectRevert(PredictionBook.NothingToClaim.selector);
        book.claim(betId);
    }

    function test_Settle_Void_onTie() public {
        uint256 stake = 100 ether;
        uint256 betId = _open(alice, true, stake, 30);
        uint256 vaultBefore = vault.totalAssets();

        _settle(betId, 100_000, 100_000, 0, 0); // tie -> void

        PredictionBook.Position memory p = book.getPosition(betId);
        assertEq(uint8(p.result), uint8(PredictionBook.Result.Void));
        uint256 tip = (stake * 100) / 10000;
        assertEq(book.owed(betId), stake - tip, "refund stake - tip");
        assertEq(vault.totalAssets(), vaultBefore, "vault P&L zero on void");
        assertEq(vault.reservedExposure(), 0);
        book.claim(betId);
        assertEq(token.balanceOf(alice), 1_000_000 ether - tip, "alice whole minus tip");
    }

    function test_Settle_Void_onWideConfidence() public {
        book.setGuards(50, 100, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE); // maxConf 0.5%
        uint256 stake = 100 ether;
        uint256 betId = _open(alice, true, stake, 30);
        // close would be a win, but its confidence band is too wide -> void
        _settle(betId, 100_000, 100_100, 0, 5_000); // conf 5000 / 100100 ~ 5% >> 0.5%
        PredictionBook.Position memory p = book.getPosition(betId);
        assertEq(uint8(p.result), uint8(PredictionBook.Result.Void), "wide conf voids");
    }

    function test_Settle_downWin() public {
        uint256 stake = 50 ether;
        uint256 betId = _open(alice, false, stake, 30); // DOWN
        _settle(betId, 100_000, 99_990, 0, 0); // close < strike -> down wins
        assertEq(uint8(book.getPosition(betId).result), uint8(PredictionBook.Result.Win));
    }

    function test_Settle_notMatured_reverts() public {
        uint256 betId = _open(alice, true, 10 ether, 30);
        PredictionBook.Position memory p = book.getPosition(betId);
        uint64 cAt = p.strikeInstant + p.dur;
        vm.warp(cAt - 1);
        bytes[] memory sData = _uupd(100_000, 0, p.strikeInstant, p.strikeInstant - 1);
        bytes[] memory cData = _uupd(100_001, 0, cAt, cAt - 1);
        vm.expectRevert(PredictionBook.NotMatured.selector);
        book.settle{value: 2 * FEE}(betId, sData, cData);
    }

    // ---- ORACLE ADVERSARIAL: Unique defeats cherry-pick ----
    function test_Settle_cherryPickedLaterTick_reverts() public {
        uint256 betId = _open(alice, true, 100 ether, 30);
        PredictionBook.Position memory p = book.getPosition(betId);
        uint64 sAt = p.strikeInstant;
        uint64 cAt = sAt + p.dur;
        vm.warp(cAt + 2);
        bytes[] memory sData = _uupd(100_000, 0, sAt, sAt - 1);
        // Attacker submits a LATER favorable close tick whose prevPublishTime >= min -> NOT the first
        // tick at/after cAt -> Unique must reject it.
        bytes[] memory cData = _uupd(200_000, 0, cAt + 1, cAt); // prevPt = cAt (>= min) -> illegal
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        book.settle{value: 2 * FEE}(betId, sData, cData);
    }

    function test_Settle_tickAfterWindow_reverts() public {
        uint256 betId = _open(alice, true, 100 ether, 30);
        PredictionBook.Position memory p = book.getPosition(betId);
        uint64 sAt = p.strikeInstant;
        uint64 cAt = sAt + p.dur;
        vm.warp(cAt + TOL + 5);
        bytes[] memory sData = _uupd(100_000, 0, sAt, sAt - 1);
        bytes[] memory cData = _uupd(100_050, 0, cAt + TOL + 1, cAt - 1); // beyond maxPublishTime
        vm.expectRevert(PythErrors.PriceFeedNotFoundWithinRange.selector);
        book.settle{value: 2 * FEE}(betId, sData, cData);
    }

    // ---- voidExpired ----
    function test_VoidExpired_afterGrace() public {
        uint256 stake = 100 ether;
        uint256 betId = _open(alice, true, stake, 30);
        PredictionBook.Position memory p = book.getPosition(betId);
        vm.warp(p.strikeInstant + p.dur + GRACE);
        book.voidExpired(betId);
        uint256 tip = (stake * 100) / 10000;
        assertEq(uint8(book.getPosition(betId).result), uint8(PredictionBook.Result.Void));
        assertEq(book.owed(betId), stake - tip);
        assertEq(vault.reservedExposure(), 0, "reserve freed");
        assertEq(book.openCount(alice), 0);
    }

    function test_VoidExpired_tooEarly_reverts() public {
        uint256 betId = _open(alice, true, 100 ether, 30);
        PredictionBook.Position memory p = book.getPosition(betId);
        vm.warp(p.strikeInstant + p.dur + GRACE - 1);
        vm.expectRevert(PredictionBook.GraceNotElapsed.selector);
        book.voidExpired(betId);
    }

    function test_VoidExpired_whenPaused_bettorSelfRescue() public {
        uint256 betId = _open(alice, true, 100 ether, 30);
        book.pause();
        vm.prank(alice); // the bettor may self-rescue immediately while paused
        book.voidExpired(betId);
        assertEq(uint8(book.getPosition(betId).result), uint8(PredictionBook.Result.Void));
    }

    function test_VoidExpired_whenPaused_thirdPartyReverts() public {
        // a non-bettor must NOT be able to force-void someone else's open bet during a pause
        uint256 betId = _open(alice, true, 100 ether, 30);
        book.pause();
        vm.prank(bob);
        vm.expectRevert(PredictionBook.GraceNotElapsed.selector);
        book.voidExpired(betId);
    }

    function test_VoidExpired_afterGrace_permissionless() public {
        // after grace, anyone (here bob, not the bettor) may void — the liveness hatch is intact
        uint256 betId = _open(alice, true, 100 ether, 30);
        PredictionBook.Position memory p = book.getPosition(betId);
        vm.warp(p.strikeInstant + p.dur + GRACE);
        vm.prank(bob);
        book.voidExpired(betId);
        assertEq(uint8(book.getPosition(betId).result), uint8(PredictionBook.Result.Void));
    }

    // ---- caps ----
    function test_Caps_perBetExposure() public {
        // per-bet cap 1% of 1M bankroll = 10k; reserve = 0.95*stake; stake s.t. reserve>10k -> revert
        book.setParams(M, 100, 5000, MINBET, MAXBET); // maxBetExposureBps = 1%
        vm.prank(alice);
        vm.expectRevert(PredictionBook.BetCapExceeded.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, 20_000 ether, 30); // reserve 19000 > 10000
    }

    function test_Caps_aggregateExposure() public {
        book.setParams(M, 5000, 100, MINBET, MAXBET); // agg cap 1% = 10k
        _open(alice, true, 10_000 ether, 30); // reserve 9500 <= 10000 ok
        vm.prank(bob);
        vm.expectRevert(PredictionBook.AggCapExceeded.selector);
        book.openBet{value: OPEN_FEE}(marketId, true, 10_000 ether, 30); // would push agg to 19000 > 10000
    }

    // ---- settleMany ----
    function test_SettleMany_skipsUnmatured() public {
        uint256 b0 = _open(alice, true, 10 ether, 30);
        uint256 b1 = _open(bob, false, 10 ether, 30);
        uint256 b2 = _open(alice, true, 10 ether, 300); // matures much later
        PredictionBook.Position memory p0 = book.getPosition(b0);
        uint64 cAt = p0.strikeInstant + 30;
        vm.warp(cAt); // b0,b1 matured; b2 not

        uint256[] memory ids = new uint256[](3);
        ids[0] = b0;
        ids[1] = b1;
        ids[2] = b2;
        bytes[][] memory sData = new bytes[][](3);
        bytes[][] memory cData = new bytes[][](3);
        // b0 up win
        sData[0] = _uupd(100_000, 0, p0.strikeInstant, p0.strikeInstant - 1);
        cData[0] = _uupd(100_010, 0, cAt, cAt - 1);
        // b1 down: strikeInstant same (opened same block)
        PredictionBook.Position memory p1 = book.getPosition(b1);
        sData[1] = _uupd(100_000, 0, p1.strikeInstant, p1.strikeInstant - 1);
        cData[1] = _uupd(99_990, 0, p1.strikeInstant + 30, p1.strikeInstant + 30 - 1);
        // b2 not matured -> data can be anything, should be skipped
        sData[2] = _uupd(100_000, 0, p0.strikeInstant, p0.strikeInstant - 1);
        cData[2] = _uupd(100_000, 0, cAt, cAt - 1);

        book.settleMany{value: 6 * FEE}(ids, sData, cData);

        assertEq(uint8(book.getPosition(b0).result), uint8(PredictionBook.Result.Win), "b0 settled");
        assertEq(uint8(book.getPosition(b1).result), uint8(PredictionBook.Result.Win), "b1 down win");
        assertEq(uint8(book.getPosition(b2).result), uint8(PredictionBook.Result.Open), "b2 skipped");
        assertEq(token.balanceOf(address(this)), 2 * ((10 ether * 100) / 10000), "two tips");
    }

    // ---- tip guard (edge-based: tip <= 2*BPS - payoutBps) ----
    function test_SetGuards_tipAtEdgeOK_aboveReverts() public {
        // m = 19500 -> house edge = 2*10000 - 19500 = 500 bps. Tip 500 OK, 501 reverts.
        book.setGuards(0, 500, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE);
        assertEq(book.tipBps(), 500);
        vm.expectRevert(PredictionBook.BadParams.selector);
        book.setGuards(0, 501, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE);
    }

    function test_SetGuards_rejectsZeroTip() public {
        vm.expectRevert(PredictionBook.BadParams.selector);
        book.setGuards(0, 0, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE);
    }

    function test_SetGuards_rejectsGraceBelowFloor() public {
        vm.expectRevert(PredictionBook.BadParams.selector);
        book.setGuards(0, 100, type(uint256).max, 25, 5, 300, DELTA, TOL, 59); // < MIN_SETTLE_GRACE (60)
    }

    function test_SetParams_raisingPayoutRechecksTip() public {
        // Standing tip 400 is fine at m=19500 (edge 500). Raising payout to 19800 (edge 200) must
        // revert because the standing tip 400 would exceed the new edge -> drain vector.
        book.setGuards(0, 400, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE);
        vm.expectRevert(PredictionBook.BadParams.selector);
        book.setParams(19800, 500, 3000, MINBET, MAXBET);
        // lowering the tip first, then raising payout, is allowed
        book.setGuards(0, 100, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE);
        book.setParams(19800, 500, 3000, MINBET, MAXBET);
        assertEq(book.payoutBps(), 19800);
    }

    function test_Constructor_confGuardOnByDefault() public {
        // a freshly-constructed book must NOT leave the confidence guard disabled (maxConfBps==0)
        HouseVault v2 = new HouseVault(IERC20(address(token)), "v2", "v2");
        PredictionBook b2 = new PredictionBook(IPyth(address(pyth)), v2, M, 500, 3000, MINBET, MAXBET);
        assertGt(b2.maxConfBps(), 0);
    }

    // The matched-pair self-settle drain the audit found: at safe params it must NOT be profitable.
    // eve opens up+down in the same block (identical strike/close instants -> exactly one win + one
    // loss, no price risk) and settles BOTH herself so she collects both tips. With tip <= house edge
    // her net token balance must not rise.
    function test_MatchedPairSelfSettle_notProfitable() public {
        book.setGuards(0, 100, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE); // tip 1% < edge 5%
        address eve = address(0xE7E);
        token.mint(eve, 1_000_000 ether);
        vm.deal(eve, 10 ether);
        vm.prank(eve);
        token.approve(address(book), type(uint256).max);

        uint256 stake = 1000 ether;
        uint256 before = token.balanceOf(eve);
        vm.startPrank(eve);
        uint256 up = book.openBet{value: OPEN_FEE}(marketId, true, stake, 30);
        uint256 dn = book.openBet{value: OPEN_FEE}(marketId, false, stake, 30);
        vm.stopPrank();

        PredictionBook.Position memory p = book.getPosition(up);
        uint64 sAt = p.strikeInstant;
        uint64 cAt = sAt + 30;
        vm.warp(cAt);
        // strike 100 @ sAt, close 101 @ cAt -> up wins, down loses; eve is the settler (gets both tips)
        bytes[] memory sData = _uupd(100e8, 0, sAt, sAt - 1);
        bytes[] memory cData = _uupd(101e8, 0, cAt, cAt - 1);
        vm.startPrank(eve);
        book.settle{value: 2 * FEE}(up, sData, cData);
        book.settle{value: 2 * FEE}(dn, sData, cData);
        if (book.owed(up) > 0) book.claim(up);
        if (book.owed(dn) > 0) book.claim(dn);
        vm.stopPrank();

        assertLe(token.balanceOf(eve), before, "matched-pair self-settle must not profit");
    }

    // ---- paged views ----
    function test_PositionsOf_paged() public {
        for (uint256 i; i < 5; i++) {
            _open(alice, true, 10 ether, 30);
        }
        (uint256[] memory ids, uint256 total) = book.positionsOf(alice, 1, 2);
        assertEq(total, 5);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
        (uint256[] memory tail,) = book.positionsOf(alice, 4, 10);
        assertEq(tail.length, 1);
        assertEq(tail[0], 4);
        (uint256[] memory none,) = book.positionsOf(alice, 9, 3);
        assertEq(none.length, 0);
    }

    // ---- keeper view ----
    function test_PendingSettlement_returnsOnlyMatured() public {
        uint256 b0 = _open(alice, true, 10 ether, 30);
        _open(bob, false, 10 ether, 300); // matures much later
        PredictionBook.Position memory p0 = book.getPosition(b0);
        vm.warp(p0.strikeInstant + 30); // b0 matured, b1 not
        (PredictionBook.Pending[] memory list, uint256 cursor) = book.pendingSettlement(0, 100);
        assertEq(list.length, 1, "only b0 matured");
        assertEq(list[0].betId, b0);
        assertEq(list[0].feedId, FEED);
        assertEq(uint256(list[0].strikeInstant), p0.strikeInstant);
        assertEq(cursor, 2, "scanned to end");
        // after settling b0, nothing pending
        _settle(b0, 100_000, 100_010, 0, 0);
        (PredictionBook.Pending[] memory list2,) = book.pendingSettlement(0, 100);
        assertEq(list2.length, 0, "settled bet no longer pending");
    }

    // ---- solvency: vault never insolvent through a win ----
    function test_Solvency_holdsThroughWin() public {
        _open(alice, true, 100 ether, 30);
        uint256 betId = _open(bob, true, 100 ether, 30);
        assertGe(vault.totalAssets(), vault.reservedExposure());
        _settle(betId, 100_000, 100_010, 0, 0);
        assertGe(vault.totalAssets(), vault.reservedExposure(), "solvent after payout");
    }

    // ---- audit re-audit fixes: per-bet tip edge cap + matured-void exclusion ----
    function test_TipCappedAtSnapshotEdge_afterPayoutLowered() public {
        // Open a pair at HIGH payout (edge 100bps), then owner lowers payout + raises tip. The
        // already-open bets' tip must stay capped at THEIR snapshot edge, so a self-settle can't drain.
        book.setParams(19900, 5000, 5000, MINBET, MAXBET); // payout 1.99x, edge 100bps
        book.setGuards(0, 100, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE);
        address eve = address(0xE7E);
        token.mint(eve, 1_000_000 ether);
        vm.deal(eve, 10 ether);
        vm.prank(eve);
        token.approve(address(book), type(uint256).max);
        uint256 S = 1000 ether;
        uint256 before = token.balanceOf(eve);
        vm.startPrank(eve);
        uint256 up = book.openBet{value: OPEN_FEE}(marketId, true, S, 30);
        uint256 dn = book.openBet{value: OPEN_FEE}(marketId, false, S, 30);
        vm.stopPrank();
        // owner reconfigures: lower payout (raises live edge), then raise tip to the new edge
        book.setParams(15000, 5000, 5000, MINBET, MAXBET); // edge now 5000bps
        book.setGuards(0, 2000, type(uint256).max, 25, 5, 300, DELTA, TOL, GRACE); // tip 20%
        PredictionBook.Position memory pp = book.getPosition(up);
        uint64 sAt = pp.strikeInstant;
        uint64 cAt = sAt + 30;
        vm.warp(cAt);
        bytes[] memory sData = _uupd(100e8, 0, sAt, sAt - 1);
        bytes[] memory cData = _uupd(101e8, 0, cAt, cAt - 1);
        vm.startPrank(eve);
        book.settle{value: 2 * FEE}(up, sData, cData);
        book.settle{value: 2 * FEE}(dn, sData, cData);
        if (book.owed(up) > 0) book.claim(up);
        if (book.owed(dn) > 0) book.claim(dn);
        vm.stopPrank();
        assertLe(token.balanceOf(eve), before, "tip must be capped at the bet's own snapshot edge");
    }

    function test_VoidExpired_pausedMaturedLoser_reverts() public {
        // A matured losing bet cannot be self-voided during a pause to dodge the loss; must settle.
        uint256 betId = _open(alice, true, 100 ether, 30);
        PredictionBook.Position memory p = book.getPosition(betId);
        vm.warp(p.strikeInstant + p.dur); // matured, still within grace
        book.pause();
        vm.prank(alice);
        vm.expectRevert(PredictionBook.GraceNotElapsed.selector);
        book.voidExpired(betId);
    }

    function test_VoidExpired_pausedUnmaturedBettor_ok() public {
        // Genuine self-rescue of an un-resolvable (not matured) position during a pause still works.
        uint256 betId = _open(alice, true, 100 ether, 30);
        book.pause(); // still before strikeInstant+dur
        vm.prank(alice);
        book.voidExpired(betId);
        assertEq(uint8(book.getPosition(betId).result), uint8(PredictionBook.Result.Void));
    }

    // ================= session-key auto-bet (grantSession / revokeSession / openBetFor) =================
    //
    //   grantSession(key,expiry,maxSpend) ─► sessions[bettor]   (v3: maxStake wall dropped)
    //   openBetFor(bettor,...) by the KEY ─► _open(bettor) : escrow from BETTOR, position under BETTOR
    //     walls: msg.sender==key · now<expiry · spent+stake<=maxSpend (odometer)
    //   revokeSession() ─► delete (works even while paused)

    address sessionKey = address(0x5E5510);

    function _grant(address bettor, address key, uint64 ttl, uint128 maxSpend) internal {
        vm.prank(bettor);
        book.grantSession(key, uint64(block.timestamp) + ttl, maxSpend);
    }

    function test_GrantSession_storesAndEmits() public {
        uint64 exp = uint64(block.timestamp) + 3600;
        vm.expectEmit(true, true, false, true, address(book));
        emit PredictionBook.SessionGranted(alice, sessionKey, exp, 1000 ether);
        vm.prank(alice);
        book.grantSession(sessionKey, exp, 1000 ether);
        (address key, uint64 expiry, uint128 maxSpend, uint128 spent) = book.sessions(alice);
        assertEq(key, sessionKey);
        assertEq(expiry, exp);
        assertEq(maxSpend, 1000 ether);
        assertEq(spent, 0);
    }

    function test_GrantSession_rejects() public {
        uint64 exp = uint64(block.timestamp) + 3600;
        uint64 pastCap = uint64(block.timestamp) + book.MAX_SESSION() + 1; // hoist the view call out of expectRevert
        uint64 nowTs = uint64(block.timestamp);
        vm.startPrank(alice);
        vm.expectRevert(PredictionBook.BadSession.selector);
        book.grantSession(address(0), exp, 1000 ether); // zero key
        vm.expectRevert(PredictionBook.BadSession.selector);
        book.grantSession(sessionKey, nowTs, 1000 ether); // expiry <= now
        vm.expectRevert(PredictionBook.BadSession.selector);
        book.grantSession(sessionKey, pastCap, 1000 ether); // > MAX_SESSION cap
        vm.expectRevert(PredictionBook.BadSession.selector);
        book.grantSession(sessionKey, exp, 0); // maxSpend 0
        vm.stopPrank();
    }

    function test_OpenBetFor_happy_escrowsFromBettor_positionUnderBettor() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        uint256 stake = 50 ether;
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 keyBefore = token.balanceOf(sessionKey); // 0 — the key holds no POINTS
        vm.prank(sessionKey);
        uint256 betId = book.openBetFor{value: OPEN_FEE}(alice, marketId, true, stake, 30);
        assertEq(token.balanceOf(address(book)), stake, "escrow held");
        assertEq(aliceBefore - token.balanceOf(alice), stake, "stake pulled from the BETTOR");
        assertEq(token.balanceOf(sessionKey), keyBefore, "session key funds untouched");
        PredictionBook.Position memory p = book.getPosition(betId);
        assertEq(p.bettor, alice, "position recorded under the bettor");
        assertEq(book.openCount(alice), 1);
        assertEq(book.openCount(sessionKey), 0, "session key is not the bettor");
        (,,, uint128 spent) = book.sessions(alice);
        assertEq(spent, stake, "spend odometer advanced by stake");
    }

    function test_OpenBetFor_authReverts() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        vm.prank(bob); // not the key
        vm.expectRevert(PredictionBook.NotSessionKey.selector);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 10 ether, 30);
        vm.prank(sessionKey); // bob has no session (zero key)
        vm.expectRevert(PredictionBook.NotSessionKey.selector);
        book.openBetFor{value: OPEN_FEE}(bob, marketId, true, 10 ether, 30);
    }

    /// @dev v3 removed the per-bet maxStake wall: a single openBetFor may now spend up to min(maxSpend,
    /// maxBet). One bet of the whole budget succeeds; only maxBet (via BetTooBig) still bounds a bet.
    function test_OpenBetFor_noMaxStakeWall_singleBetUpToBudget() public {
        _grant(alice, sessionKey, 3600, 5000 ether);
        vm.prank(sessionKey);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 5000 ether, 30); // whole budget in ONE bet, ok
        (,,, uint128 spent) = book.sessions(alice);
        assertEq(spent, 5000 ether);
        // still bounded by the global maxBet
        _grant(alice, sessionKey, 3600, uint128(MAXBET) + 1 ether);
        vm.prank(sessionKey);
        vm.expectRevert(PredictionBook.BetTooBig.selector);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, MAXBET + 1, 30);
    }

    function test_OpenBetFor_expiredReverts() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        vm.warp(block.timestamp + 3601);
        vm.prank(sessionKey);
        vm.expectRevert(PredictionBook.SessionExpired.selector);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 10 ether, 30);
    }

    function test_OpenBetFor_budgetCap_decoupledFromAllowance() public {
        // alice's ERC20 allowance to the book is unlimited (setUp), yet the session key is capped at
        // maxSpend=120: two 50s ok (spent 100), a third 50 would hit 150 > 120 -> revert.
        _grant(alice, sessionKey, 3600, 120 ether);
        vm.startPrank(sessionKey);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 50 ether, 30);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 50 ether, 30);
        vm.expectRevert(PredictionBook.SessionBudgetExceeded.selector);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 50 ether, 30);
        vm.stopPrank();
        (,,, uint128 spent) = book.sessions(alice);
        assertEq(spent, 100 ether, "odometer unchanged by the reverted bet");
    }

    function test_RevokeSession_killsKey() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        vm.expectEmit(true, true, false, false, address(book));
        emit PredictionBook.SessionRevoked(alice, sessionKey);
        vm.prank(alice);
        book.revokeSession();
        vm.prank(sessionKey);
        vm.expectRevert(PredictionBook.NotSessionKey.selector);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 10 ether, 30);
    }

    function test_RevokeSession_worksWhilePaused() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        book.pause();
        vm.prank(alice);
        book.revokeSession(); // must NOT be whenNotPaused-gated — a user can always kill a key
        (address key,,,) = book.sessions(alice);
        assertEq(key, address(0), "session cleared during a pause");
    }

    function test_ReGrant_resetsSpent() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        vm.prank(sessionKey);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 50 ether, 30);
        (,,, uint128 spent1) = book.sessions(alice);
        assertEq(spent1, 50 ether);
        _grant(alice, address(0xBEEF), 3600, 1000 ether); // rotate
        (address key,,, uint128 spent2) = book.sessions(alice);
        assertEq(key, address(0xBEEF));
        assertEq(spent2, 0, "odometer reset on re-grant");
    }

    function test_OpenBetFor_capsStillEnforced() public {
        book.setParams(M, 100, 5000, MINBET, MAXBET); // per-bet cap 1% of 1M = 10k
        _grant(alice, sessionKey, 3600, uint128(MAXBET)); // session allows big; caps must still bite
        vm.prank(sessionKey);
        vm.expectRevert(PredictionBook.BetCapExceeded.selector);
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 20_000 ether, 30); // reserve 19000 > 10000
    }

    function test_OpenBetFor_whenPausedReverts() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        book.pause();
        vm.prank(sessionKey);
        vm.expectRevert(); // Pausable: EnforcedPause
        book.openBetFor{value: OPEN_FEE}(alice, marketId, true, 10 ether, 30);
    }

    function test_OpenBetFor_settleAndClaim_paysBettorNotKey() public {
        _grant(alice, sessionKey, 3600, 1000 ether);
        uint256 stake = 100 ether;
        vm.prank(sessionKey);
        uint256 betId = book.openBetFor{value: OPEN_FEE}(alice, marketId, true, stake, 30);
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 keyBefore = token.balanceOf(sessionKey);
        _settle(betId, 100_000, 100_001, 0, 0); // up, close > strike -> win
        book.claim(betId);
        uint256 tip = (stake * 100) / 10000;
        uint256 distributable = (stake * M) / 10000;
        assertEq(token.balanceOf(alice) - aliceBefore, distributable - tip, "winnings pay the BETTOR");
        assertEq(token.balanceOf(sessionKey), keyBefore, "session key receives nothing");
        assertEq(book.openCount(alice), 0);
    }

    // ================= v3: INJ fee escrow, reimbursement, refunds, claimMany =================

    function test_v3_OpenRequiresFeeEscrow_refundsExcess() public {
        vm.deal(alice, 100 ether);
        // below openCost -> InsufficientOpenFee
        vm.prank(alice);
        vm.expectRevert(PredictionBook.InsufficientOpenFee.selector);
        book.openBet{value: OPEN_FEE - 1}(marketId, true, 10 ether, 30);
        // exactly openCost stores it as the bet's feeEscrow
        vm.prank(alice);
        uint256 betId = book.openBet{value: OPEN_FEE}(marketId, true, 10 ether, 30);
        assertEq(uint256(book.getPosition(betId).feeEscrow), OPEN_FEE, "escrow snapshotted");
        // over-attach -> excess refunded, book holds only the escrow (+ prior bets')
        uint256 aliceBefore = alice.balance;
        uint256 bookBefore = address(book).balance;
        vm.prank(alice);
        book.openBet{value: OPEN_FEE + 3 ether}(marketId, true, 10 ether, 30);
        assertEq(aliceBefore - alice.balance, OPEN_FEE, "only the escrow left alice; excess refunded");
        assertEq(address(book).balance - bookBefore, OPEN_FEE, "book took only the escrow");
    }

    function test_v3_SettleReimbursesSettler_escrowNeverPaysPyth() public {
        uint256 betId = _open(alice, true, 100 ether, 30);
        uint256 esc = uint256(book.getPosition(betId).feeEscrow);
        uint256 bookBefore = address(book).balance; // holds esc (+ nothing else here)
        uint256 selfBefore = address(this).balance;
        // settle attaches exactly the Pyth fee (2*FEE); the book reimburses the settler from escrow.
        _settle(betId, 100_000, 100_001, 0, 0);
        // settler (this contract) net INJ: -pythFee (fronted) + reimb(=pythFee+gasComp capped at esc).
        // With esc = 2*FEE*1.1 + gasComp and pythFee = 2*FEE, reimb = esc (surplus 0) -> net +gasCompWei.
        assertEq(address(this).balance - selfBefore, book.gasCompWei(), "settler netted the gas comp");
        // the bet's whole escrow left the book (conservation): balance dropped by esc.
        assertEq(bookBefore - address(book).balance, esc, "escrow released on settle");
    }

    function test_v3_VoidRefundsFeeEscrowToBettor() public {
        uint256 betId = _open(alice, true, 100 ether, 30);
        uint256 esc = uint256(book.getPosition(betId).feeEscrow);
        PredictionBook.Position memory p = book.getPosition(betId);
        vm.warp(p.strikeInstant + p.dur + GRACE);
        uint256 aliceBefore = alice.balance;
        vm.prank(bob); // permissionless post-grace void
        book.voidExpired(betId);
        assertEq(alice.balance - aliceBefore, esc, "void refunded the INJ escrow to the bettor");
    }

    function test_v3_VoidRevertingBettor_pullFallback_neverBricks() public {
        NoReceive nr = new NoReceive(book, IERC20(address(token)));
        token.mint(address(nr), 1000 ether);
        vm.deal(address(nr), 10 ether);
        uint256 betId = nr.open(marketId, true, 100 ether, 30, OPEN_FEE);
        uint256 esc = uint256(book.getPosition(betId).feeEscrow);
        PredictionBook.Position memory p = book.getPosition(betId);
        vm.warp(p.strikeInstant + p.dur + GRACE);
        // The escrow refund .call to nr (no receive) fails -> credited to owedInj; the void STILL completes.
        vm.prank(bob);
        book.voidExpired(betId);
        assertEq(
            uint8(book.getPosition(betId).result), uint8(PredictionBook.Result.Void), "void completed anyway"
        );
        assertEq(book.owedInj(address(nr)), esc, "escrow parked in the INJ pull mapping");
    }

    function test_v3_ClaimMany_batchesAndSkips() public {
        uint256 b0 = _open(alice, true, 100 ether, 30);
        uint256 b1 = _open(alice, true, 100 ether, 30);
        _settle(b0, 100_000, 100_001, 0, 0); // win
        _settle(b1, 100_000, 100_001, 0, 0); // win
        uint256 aliceBefore = token.balanceOf(alice);
        uint256[] memory ids = new uint256[](3);
        ids[0] = b0;
        ids[1] = b1;
        ids[2] = b0; // duplicate -> second pass skips (owed already 0)
        book.claimMany(ids);
        uint256 tip = (100 ether * 100) / 10000;
        uint256 each = (100 ether * M) / 10000 - tip;
        assertEq(token.balanceOf(alice) - aliceBefore, 2 * each, "both wins paid once; dup skipped");
        assertEq(book.owed(b0), 0);
        assertEq(book.owed(b1), 0);
    }

    function test_v3_SetFeeParams_capsBind() public {
        vm.expectRevert(PredictionBook.BadParams.selector);
        book.setFeeParams(5001, 0); // buffer > 50%
        vm.expectRevert(PredictionBook.BadParams.selector);
        book.setFeeParams(1000, 3 * FEE + 1); // gasComp > 3x single update fee
        book.setFeeParams(2000, 3 * FEE); // at the caps -> ok
        assertEq(book.feeBufferBps(), 2000);
        assertEq(book.gasCompWei(), 3 * FEE);
    }
}
