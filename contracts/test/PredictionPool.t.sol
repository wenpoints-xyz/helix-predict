// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PredictionPool} from "../src/PredictionPool.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Points", "PTS") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev A stake token that re-enters PredictionPool.claim() when the pool pays a winner,
/// used to prove nonReentrant blocks the classic drain vector.
contract ReentrantToken is ERC20 {
    PredictionPool public pool;
    uint256 public round;
    bool public armed;

    constructor() ERC20("Reenter", "RE") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setPool(PredictionPool p) external {
        pool = p;
    }

    function arm(uint256 r) external {
        armed = true;
        round = r;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from == address(pool)) {
            pool.claim(round); // reenter on payout -> must revert via nonReentrant
        }
    }
}

contract PredictionPoolTest is Test {
    MockPyth pyth;
    MockERC20 token;
    PredictionPool pool;

    bytes32 constant FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43; // BTC/USD
    uint32 constant TF = 30; // 30s timeframe
    uint256 constant FEE = 1; // wei per Pyth update (MockPyth)
    uint256 constant RAKE = 300; // 3%
    uint256 marketId;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    int64 constant STRIKE = 100_000;

    function setUp() public {
        pyth = new MockPyth(60, FEE);
        token = new MockERC20();
        pool = new PredictionPool(IPyth(address(pyth)), IERC20(address(token)), RAKE, 60);
        marketId = pool.addMarket(FEED, TF);
        vm.warp(1_000_000);
        vm.deal(address(this), 100 ether);

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            token.approve(address(pool), type(uint256).max);
        }
    }

    // ---- helpers ----
    function _upd(int64 price) internal view returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(FEED, price, 0, -8, price, 0, uint64(block.timestamp));
    }

    function _openRound() internal returns (uint256 id, uint64 lockTime) {
        lockTime = uint64(block.timestamp + 10);
        id = pool.createRound(marketId, lockTime);
    }

    function _bet(address u, uint256 id, bool up, uint256 amt) internal {
        vm.prank(u);
        pool.bet(id, up, amt);
    }

    function _lock(uint256 id, uint64 lockTime, int64 price) internal {
        vm.warp(lockTime);
        pool.lock{value: FEE}(id, _upd(price));
    }

    function _settle(uint256 id, uint64 lockTime, int64 price) internal {
        vm.warp(uint256(lockTime) + TF); // expiry = lockTime + timeframe
        pool.settle{value: FEE}(id, _upd(price));
    }

    // ---- happy paths ----
    function test_UpWins_ProRataPayoutMinusRake() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100); // UP
        _bet(carol, id, true, 50); // UP
        _bet(bob, id, false, 100); // DOWN
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1); // close > strike -> UP wins

        // pot = 250, rake = 7 (3% floored), distributable = 243
        assertEq(pool.treasuryAccrued(), 7);
        assertEq(pool.previewPayout(id, alice), 100 * 243 / 150); // 162
        assertEq(pool.previewPayout(id, carol), 50 * 243 / 150); // 81
        assertEq(pool.previewPayout(id, bob), 0);

        uint256 aBefore = token.balanceOf(alice);
        vm.prank(alice);
        pool.claim(id);
        assertEq(token.balanceOf(alice) - aBefore, 162);
        vm.prank(carol);
        pool.claim(id);
        assertEq(pool.previewPayout(id, carol), 0); // claimed

        vm.prank(bob);
        vm.expectRevert(PredictionPool.NothingToClaim.selector);
        pool.claim(id);
    }

    function test_DownWins() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE - 1); // close < strike -> DOWN wins

        assertEq(pool.previewPayout(id, bob), 194); // pot 200, rake 6, dist 194
        assertEq(pool.previewPayout(id, alice), 0);
        uint256 b = token.balanceOf(bob);
        vm.prank(bob);
        pool.claim(id);
        assertEq(token.balanceOf(bob) - b, 194);
    }

    // ---- void rules ----
    function test_Tie_Voids_FullRefund() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 40);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE); // close == strike -> void

        assertEq(pool.treasuryAccrued(), 0);
        assertEq(pool.previewPayout(id, alice), 100);
        assertEq(pool.previewPayout(id, bob), 40);
        uint256 a = token.balanceOf(alice);
        vm.prank(alice);
        pool.claim(id);
        assertEq(token.balanceOf(alice) - a, 100);
    }

    function test_OneSided_Voids_FullRefund() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(carol, id, true, 50); // only UP bets
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 5); // would-be up win, but downPool==0 -> void

        assertEq(pool.treasuryAccrued(), 0);
        assertEq(pool.previewPayout(id, alice), 100);
        assertEq(pool.previewPayout(id, carol), 50);
    }

    // ---- guards ----
    function test_Revert_BetAfterLockTime() public {
        (uint256 id, uint64 lockTime) = _openRound();
        vm.warp(lockTime);
        vm.prank(alice);
        vm.expectRevert(PredictionPool.BettingClosed.selector);
        pool.bet(id, true, 100);
    }

    function test_Revert_LockTooEarly() public {
        (uint256 id,) = _openRound();
        bytes[] memory u = _upd(STRIKE); // build before expectRevert (it makes an external MockPyth call)
        vm.expectRevert(PredictionPool.TooEarly.selector);
        pool.lock{value: FEE}(id, u);
    }

    function test_Revert_SettleBeforeExpiry() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        _lock(id, lockTime, STRIKE);
        bytes[] memory u = _upd(STRIKE + 1);
        vm.expectRevert(PredictionPool.TooEarly.selector); // still before expiry
        pool.settle{value: FEE}(id, u);
    }

    function test_Revert_SettleWhenNotLocked() public {
        (uint256 id,) = _openRound();
        bytes[] memory u = _upd(STRIKE);
        vm.expectRevert(PredictionPool.NotLocked.selector);
        pool.settle{value: FEE}(id, u);
    }

    function test_Revert_DoubleClaim() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1);
        vm.prank(alice);
        pool.claim(id);
        vm.prank(alice);
        vm.expectRevert(PredictionPool.AlreadyClaimed.selector);
        pool.claim(id);
    }

    function test_Revert_ClaimBeforeSettle() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _lock(id, lockTime, STRIKE);
        vm.prank(alice);
        vm.expectRevert(PredictionPool.NotSettled.selector);
        pool.claim(id);
    }

    // ---- fee handling ----
    function test_Fee_ExcessRefunded() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        vm.warp(lockTime);
        uint256 balBefore = address(this).balance;
        pool.lock{value: 1 ether}(id, _upd(STRIKE)); // overpay
        assertEq(address(this).balance, balBefore - FEE); // only the fee kept
    }

    function test_Revert_InsufficientFee() public {
        (uint256 id, uint64 lockTime) = _openRound();
        vm.warp(lockTime);
        bytes[] memory u = _upd(STRIKE);
        vm.expectRevert(PredictionPool.InsufficientFee.selector);
        pool.lock{value: 0}(id, u);
    }

    // ---- treasury ----
    function test_TreasuryWithdraw() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1);
        assertEq(pool.treasuryAccrued(), 6);
        pool.withdrawTreasury(address(0xFEE5));
        assertEq(token.balanceOf(address(0xFEE5)), 6);
        assertEq(pool.treasuryAccrued(), 0);
    }

    // ---- conservation fuzz: single winner => payout + rake == pot exactly ----
    function testFuzz_Conservation(uint96 up, uint96 down) public {
        up = uint96(bound(up, 1, 1_000_000 ether));
        down = uint96(bound(down, 1, 1_000_000 ether));
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, up); // sole UP
        _bet(bob, id, false, down); // sole DOWN
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1); // UP wins -> alice sole winner

        uint256 pot = uint256(up) + uint256(down);
        uint256 payout = pool.previewPayout(id, alice);
        uint256 rake = pool.treasuryAccrued();
        assertEq(payout, pot - rake); // sole winner takes the whole distributable
        assertEq(payout + rake, pot); // nothing lost
    }

    // ---- cadence (fix #2) ----
    function test_Cadence_NextSlotAndBounds() public {
        uint64 l0 = uint64(block.timestamp + 10);
        uint256 r0 = pool.createRound(marketId, l0); // genesis
        uint256 r1 = pool.createRound(marketId, l0 + TF); // exact next slot ok
        assertEq(r1, r0 + 1);
        vm.expectRevert(PredictionPool.NotNextSlot.selector); // wrong slot while chain live
        pool.createRound(marketId, l0 + TF + 1);
        vm.expectRevert(PredictionPool.TooFarAhead.selector); // > 2*timeframe ahead
        pool.createRound(marketId, uint64(block.timestamp + 2 * TF + 5));
    }

    function test_Cadence_RestartAfterLapse() public {
        // NOTE: with via_ir on, the optimizer CSEs block.timestamp across the vm.warp cheatcode,
        // so use explicit times after the warp (block.timestamp is constant per-tx in production,
        // so this only affects warp-then-reread test code, never the contract).
        pool.createRound(marketId, uint64(block.timestamp + 10)); // lock at 1_000_010
        vm.warp(1_002_000); // chain lapses well past the slot
        uint256 rid = pool.createRound(marketId, 1_002_010); // genesis-style restart
        assertEq(rid, 1);
    }

    // ---- SafeCast (fix #1) ----
    function test_SafeCast_HugeBetReverts() public {
        (uint256 id,) = _openRound();
        uint256 huge = uint256(type(uint128).max) + 1;
        token.mint(alice, huge);
        vm.prank(alice);
        vm.expectRevert(); // SafeCast: SafeCastOverflowedUintDowncast
        pool.bet(id, true, huge);
    }

    // ---- dust-free multi-winner payout (remaining-based claim) ----
    function test_MultiWinner_DustFree() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 1);
        _bet(bob, id, true, 1);
        _bet(carol, id, true, 1); // upPool 3
        address dan = address(0xDA7);
        token.mint(dan, 1000);
        vm.prank(dan);
        token.approve(address(pool), type(uint256).max);
        _bet(dan, id, false, 7); // downPool 7, pot 10, rake floors to 0 -> distributable 10
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1); // up wins; 3 winners split 10 -> 3,3,4 (last absorbs remainder)

        uint256 sum;
        sum += _claimGain(alice, id);
        sum += _claimGain(bob, id);
        sum += _claimGain(carol, id);
        assertEq(sum, 10); // exactly distributable, no dust
        assertEq(token.balanceOf(address(pool)), 0); // nothing stranded (rake 0)
    }

    function _claimGain(address u, uint256 id) internal returns (uint256) {
        uint256 before = token.balanceOf(u);
        vm.prank(u);
        pool.claim(id);
        return token.balanceOf(u) - before;
    }

    // ---- admin guards ----
    function test_Admin_Guards() public {
        vm.expectRevert(PredictionPool.RakeTooHigh.selector);
        pool.setRakeBps(1001);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        pool.addMarket(FEED, 60);

        pool.setMarketEnabled(marketId, false);
        vm.expectRevert(PredictionPool.MarketDisabled.selector);
        pool.createRound(marketId, uint64(block.timestamp + 10));
    }

    function test_WithdrawTreasury_ZeroAddressReverts() public {
        vm.expectRevert(PredictionPool.ZeroAddress.selector);
        pool.withdrawTreasury(address(0));
    }

    // ---- pause ----
    function test_Pause_BlocksBetAndCreate_AllowsResolve() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        pool.pause();

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        pool.bet(id, true, 10);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        pool.createRound(marketId, uint64(block.timestamp + 10));

        // in-flight round still resolves + pays out while paused
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1);
        vm.prank(alice);
        pool.claim(id); // no revert
    }

    // ---- stale price guard ----
    function test_StalePrice_SettleReverts() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        _lock(id, lockTime, STRIKE);
        // warp well past expiry so even the newest pushed price is older than maxPriceAge (60s)
        vm.warp(uint256(lockTime) + 200);
        bytes[] memory stale = new bytes[](1);
        stale[0] = pyth.createPriceFeedUpdateData(
            FEED, STRIKE + 1, 0, -8, STRIKE + 1, 0, uint64(block.timestamp - 100)
        );
        vm.expectRevert(); // getPriceNoOlderThan reverts: age 100 > maxPriceAge 60
        pool.settle{value: FEE}(id, stale);
    }

    // ---- reentrancy ----
    function test_Reentrancy_ClaimBlocked() public {
        ReentrantToken rtok = new ReentrantToken();
        PredictionPool rpool = new PredictionPool(IPyth(address(pyth)), IERC20(address(rtok)), 300, 60);
        rtok.setPool(rpool);
        uint256 mid = rpool.addMarket(FEED, TF);
        rtok.mint(alice, 1000);
        rtok.mint(bob, 1000);
        vm.prank(alice);
        rtok.approve(address(rpool), type(uint256).max);
        vm.prank(bob);
        rtok.approve(address(rpool), type(uint256).max);

        uint64 l = uint64(block.timestamp + 10);
        uint256 id = rpool.createRound(mid, l);
        vm.prank(alice);
        rpool.bet(id, true, 100);
        vm.prank(bob);
        rpool.bet(id, false, 100);
        vm.warp(l);
        rpool.lock{value: FEE}(id, _upd(STRIKE));
        vm.warp(uint256(l) + TF);
        rpool.settle{value: FEE}(id, _upd(STRIKE + 1)); // up wins -> alice is a winner

        rtok.arm(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        rpool.claim(id);
    }

    // ---- voidRound (cheap one-sided exit, no oracle fee) ----
    function test_VoidRound_OneSided_RefundNoOracle() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100); // only UP
        vm.expectRevert(PredictionPool.TooEarly.selector);
        pool.voidRound(id); // can't void before betting closes
        vm.warp(lockTime);
        pool.voidRound(id); // no Pyth push, no msg.value
        assertEq(pool.treasuryAccrued(), 0);
        assertEq(pool.previewPayout(id, alice), 100);
        uint256 a = token.balanceOf(alice);
        vm.prank(alice);
        pool.claim(id);
        assertEq(token.balanceOf(alice) - a, 100); // full refund
    }

    function test_VoidRound_BothSides_Reverts() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        vm.warp(lockTime);
        vm.expectRevert(PredictionPool.HasBothSides.selector); // a real contest must settle()
        pool.voidRound(id);
    }

    // ---- board + positions views (one-call reads) ----
    function test_BoardSnapshot() public {
        (uint256 id,) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 40);
        PredictionPool.RoundInfo[] memory board = pool.boardSnapshot();
        assertEq(board.length, 1); // setUp registered 1 market
        assertEq(board[0].marketId, 0);
        assertEq(board[0].feedId, FEED);
        assertEq(board[0].timeframe, TF);
        assertTrue(board[0].hasRound);
        assertEq(board[0].roundId, id);
        assertEq(board[0].upPool, 100);
        assertEq(board[0].downPool, 40);
        assertEq(board[0].state, 0); // Open
    }

    function test_MyPositions() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100);
        _bet(bob, id, false, 100);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1); // up wins
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        (uint256[] memory up, uint256[] memory down, uint256[] memory claimable, bool[] memory didClaim) =
            pool.myPositions(alice, ids);
        assertEq(up[0], 100);
        assertEq(down[0], 0);
        assertEq(claimable[0], 194); // pot 200, rake 6, dist 194, alice sole up winner
        assertFalse(didClaim[0]);
        vm.prank(alice);
        pool.claim(id);
        (,, uint256[] memory claimable2, bool[] memory didClaim2) = pool.myPositions(alice, ids);
        assertEq(claimable2[0], 0);
        assertTrue(didClaim2[0]);
    }

    receive() external payable {}
}
