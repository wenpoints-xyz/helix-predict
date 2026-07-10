// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {PredictionHouse} from "../src/PredictionHouse.sol";
import {HouseVault} from "../src/HouseVault.sol";
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

/// @dev Re-enters PredictionHouse.claim() when the house pays a winner, to prove nonReentrant holds.
contract ReentrantToken is ERC20 {
    PredictionHouse public house;
    uint256 public round;
    bool public armed;

    constructor() ERC20("Reenter", "RE") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function setHouse(PredictionHouse h) external {
        house = h;
    }

    function arm(uint256 r) external {
        armed = true;
        round = r;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from == address(house)) {
            house.claim(round); // reenter on payout -> must revert
        }
    }
}

contract PredictionHouseTest is Test {
    MockPyth pyth;
    MockERC20 token;
    HouseVault vault;
    PredictionHouse house;

    bytes32 constant FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    uint32 constant TF = 30;
    uint256 constant FEE = 1;
    uint256 constant M = 19500; // 1.95x
    int64 constant STRIKE = 100_000;
    uint256 marketId;

    address lp = address(0x11D);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);

    function setUp() public {
        pyth = new MockPyth(60, FEE);
        token = new MockERC20();
        vault = new HouseVault(IERC20(address(token)), "HELIX House LP", "hHLX");
        house = new PredictionHouse(
            IPyth(address(pyth)),
            vault,
            M, // payout 1.95x
            60, // maxPriceAge
            5000, // maxRoundExposureBps (50%)
            5000, // maxAggExposureBps
            1_000_000 ether, // maxBet
            0, // maxConfBps (disabled by default)
            1 hours // settleGrace
        );
        vault.setHouse(address(house));
        marketId = house.addMarket(FEED, TF);

        vm.warp(1_000_000);
        vm.deal(address(this), 100 ether);

        // LP seeds the bankroll
        token.mint(lp, 1_000_000 ether);
        vm.startPrank(lp);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000 ether, lp);
        vm.stopPrank();

        address[3] memory users = [alice, bob, carol];
        for (uint256 i; i < users.length; i++) {
            token.mint(users[i], 1_000_000 ether);
            vm.prank(users[i]);
            token.approve(address(house), type(uint256).max);
        }
        // the test contract itself bets in one case
        token.mint(address(this), 1_000_000 ether);
        token.approve(address(house), type(uint256).max);
    }

    // ---- helpers ----
    function _upd(int64 price, uint64 conf, uint64 publishTime) internal view returns (bytes[] memory data) {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(FEED, price, conf, -8, price, conf, publishTime);
    }

    function _openRound() internal returns (uint256 id, uint64 lockTime) {
        lockTime = uint64(block.timestamp + 10);
        id = house.createRound(marketId, lockTime);
    }

    function _bet(address u, uint256 id, bool up, uint256 amt) internal {
        vm.prank(u);
        house.bet(id, up, amt);
    }

    function _lock(uint256 id, uint64 lockTime, int64 price) internal {
        vm.warp(lockTime);
        house.lock{value: FEE}(id, _upd(price, 0, uint64(block.timestamp)));
    }

    function _settle(uint256 id, uint64 lockTime, int64 price) internal {
        vm.warp(uint256(lockTime) + TF);
        house.settle{value: FEE}(id, _upd(price, 0, uint64(block.timestamp)));
    }

    function _claimGain(address u, uint256 id) internal returns (uint256) {
        uint256 before = token.balanceOf(u);
        vm.prank(u);
        house.claim(id);
        return token.balanceOf(u) - before;
    }

    // =========================================================
    // Vault
    // =========================================================

    function test_Vault_DepositMintsShares() public view {
        assertGt(vault.balanceOf(lp), 0);
        assertEq(vault.totalAssets(), 1_000_000 ether);
    }

    /// First-depositor inflation attack: attacker seeds 1 wei then donates a lump to inflate the
    /// share price, trying to make the victim's deposit round to 0 shares. The decimals offset
    /// must keep the victim's shares worth ~their deposit.
    function test_Vault_InflationAttackResisted() public {
        MockERC20 t = new MockERC20();
        HouseVault v = new HouseVault(IERC20(address(t)), "V", "V");
        address attacker = address(0xBAD);
        address victim = address(0x111);
        t.mint(attacker, 10_000 ether + 1); // 1 wei seed + 10_000 donation
        t.mint(victim, 10_000 ether);

        vm.startPrank(attacker);
        t.approve(address(v), type(uint256).max);
        v.deposit(1, attacker); // 1 wei
        t.transfer(address(v), 10_000 ether); // donate to inflate share price
        vm.stopPrank();

        vm.startPrank(victim);
        t.approve(address(v), type(uint256).max);
        uint256 shares = v.deposit(10_000 ether, victim);
        vm.stopPrank();

        assertGt(shares, 0, "victim got 0 shares -> inflation attack succeeded");
        // victim can redeem back ~all of their deposit (attack is uneconomic)
        assertGe(v.convertToAssets(shares), 9_900 ether, "victim lost too much to the attacker");
    }

    function test_Vault_WithdrawCappedByReservedCapital() public {
        // A solo bet reserves (m-1)*100 = 95 on the vault; that much is not withdrawable.
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether); // one-sided -> reserve = 95 ether
        assertEq(vault.reservedExposure(), 95 ether);
        assertEq(vault.freeAssets(), 1_000_000 ether - 95 ether);
        assertEq(vault.maxWithdraw(lp), 1_000_000 ether - 95 ether);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1); // UP wins, reserve released
        assertEq(vault.reservedExposure(), 0);
    }

    function test_Vault_OnlyHouseCanReserve() public {
        vm.expectRevert(HouseVault.NotHouse.selector);
        vault.reserve(1 ether);
        vm.expectRevert(HouseVault.NotHouse.selector);
        vault.payWinnings(address(this), 1 ether);
    }

    function test_Vault_SetHouseOnce() public {
        vm.expectRevert(HouseVault.HouseAlreadySet.selector);
        vault.setHouse(address(0xDEAD));
    }

    // =========================================================
    // House happy paths
    // =========================================================

    /// Balanced two-sided round: sides hedge, reserve is 0, vault just skims the vig.
    function test_House_Balanced_VaultEarnsVig() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether); // UP
        _bet(bob, id, false, 100 ether); // DOWN
        assertEq(vault.reservedExposure(), 0, "balanced flow needs no reserve");

        uint256 vaultBefore = vault.totalAssets();
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1); // UP wins

        // distributable = 100 * 1.95 = 195; escrow 200; vig 5 -> vault
        assertEq(vault.totalAssets(), vaultBefore + 5 ether, "vault should gain the 5 vig");
        assertEq(_claimGain(alice, id), 195 ether);
        vm.prank(bob);
        vm.expectRevert(PredictionHouse.NothingToClaim.selector);
        house.claim(id);
    }

    /// Solo bet with no opponent: the VAULT is the counterparty. This is the whole point of the pivot.
    function test_House_SoloBet_VaultIsCounterparty_UpWins() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether); // only UP; reserve 95
        assertEq(vault.reservedExposure(), 95 ether);

        uint256 vaultBefore = vault.totalAssets();
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1); // UP wins -> vault pays

        assertEq(_claimGain(alice, id), 195 ether); // stake 100 + 95 profit
        assertEq(vault.totalAssets(), vaultBefore - 95 ether, "vault paid 95");
        assertEq(vault.reservedExposure(), 0);
    }

    function test_House_SoloBet_VaultWins() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether); // only UP
        uint256 vaultBefore = vault.totalAssets();
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE - 1); // DOWN wins -> UP loses everything to vault

        assertEq(vault.totalAssets(), vaultBefore + 100 ether, "vault keeps the losing stake");
        vm.prank(alice);
        vm.expectRevert(PredictionHouse.NothingToClaim.selector);
        house.claim(id);
    }

    function test_House_DownWins_MultiWinner_DustFree() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, false, 1); // DOWN 1 wei
        _bet(bob, id, false, 1); // DOWN 1 wei
        _bet(carol, id, false, 1); // DOWN 1 wei  (downStake 3)
        _bet(address(this), id, true, 3); // UP 3  (this contract needs approve + tokens)
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE - 1); // DOWN wins

        // distributable = floor(3 * 1.95) = 5; three winners split 5 -> 1,1,3 (last absorbs remainder)
        uint256 sum = _claimGain(alice, id) + _claimGain(bob, id) + _claimGain(carol, id);
        assertEq(sum, 5, "winners split exactly the distributable, no dust");
    }

    // =========================================================
    // Oracle hardening
    // =========================================================

    /// A settler cannot use a price stamped BEFORE the expiry window (would let them cherry-pick).
    function test_House_Oracle_PriceBeforeExpiryWindowReverts() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether);
        _bet(bob, id, false, 100 ether);
        _lock(id, lockTime, STRIKE);
        vm.warp(uint256(lockTime) + TF); // exactly expiry
        // price stamped 1s before expiry -> must be rejected even though it's not "stale"
        bytes[] memory u = _upd(STRIKE + 1, 0, uint64(block.timestamp - 1));
        vm.expectRevert(PredictionHouse.PriceBeforeWindow.selector);
        house.settle{value: FEE}(id, u);
    }

    function test_House_Oracle_ConfidenceGuardVoids() public {
        house.setGuards(60, 100, 1 hours); // maxConfBps = 1%
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether);
        _bet(bob, id, false, 100 ether);
        _lock(id, lockTime, STRIKE);
        vm.warp(uint256(lockTime) + TF);
        // conf 2000 on price 100000 => 200 bps > 100 -> void
        house.settle{value: FEE}(id, _upd(STRIKE + 1, 2000, uint64(block.timestamp)));

        (,,,,,,,,,, PredictionHouse.State st, bool upWon, bool voided) = house.rounds(id);
        assertTrue(voided, "wide confidence should void");
        assertEq(uint8(st), 2);
        assertFalse(upWon);
        assertEq(_claimGain(alice, id), 100 ether); // full refund
        assertEq(_claimGain(bob, id), 100 ether);
    }

    function test_House_Oracle_StalePriceReverts() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether);
        _bet(bob, id, false, 100 ether);
        _lock(id, lockTime, STRIKE);
        vm.warp(uint256(lockTime) + 200); // far past expiry
        bytes[] memory stale = _upd(STRIKE + 1, 0, uint64(block.timestamp - 100)); // age 100 > 60
        vm.expectRevert(); // getPriceNoOlderThan reverts
        house.settle{value: FEE}(id, stale);
    }

    // =========================================================
    // Void paths
    // =========================================================

    function test_House_Tie_Voids() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether);
        _bet(bob, id, false, 40 ether);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE); // close == strike -> void
        assertEq(_claimGain(alice, id), 100 ether);
        assertEq(_claimGain(bob, id), 40 ether);
        assertEq(vault.reservedExposure(), 0);
    }

    function test_House_VoidExpired_RefundsAndReleases() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether); // one-sided, reserve 95
        _lock(id, lockTime, STRIKE);
        assertEq(vault.reservedExposure(), 95 ether);
        // never settle; warp past expiry + grace
        vm.warp(uint256(lockTime) + TF + 1 hours + 1);
        house.voidExpired(id);
        assertEq(vault.reservedExposure(), 0, "reserve released on lapse");
        assertEq(_claimGain(alice, id), 100 ether); // refunded
    }

    function test_House_VoidExpired_TooEarlyReverts() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether);
        _lock(id, lockTime, STRIKE);
        vm.warp(uint256(lockTime) + TF + 10); // past expiry but within grace
        vm.expectRevert(PredictionHouse.TooEarly.selector);
        house.voidExpired(id);
    }

    // =========================================================
    // Caps & guards
    // =========================================================

    function test_House_Caps_RoundExposure() public {
        // tiny cap so a solo bet blows the per-round exposure limit
        house.setParams(M, 1, 5000, 1_000_000 ether); // maxRoundExposureBps = 1 (0.01% of 1e6 = 100 ether)
        (uint256 id,) = _openRound();
        // solo bet of 200 ether -> reserve 190 ether > cap 100 ether
        vm.prank(alice);
        vm.expectRevert(PredictionHouse.RoundCapExceeded.selector);
        house.bet(id, true, 200 ether);
    }

    function test_House_Caps_MaxBet() public {
        house.setParams(M, 5000, 5000, 50 ether);
        (uint256 id,) = _openRound();
        vm.prank(alice);
        vm.expectRevert(PredictionHouse.BetTooBig.selector);
        house.bet(id, true, 51 ether);
    }

    function test_House_PayoutRange() public {
        vm.expectRevert(PredictionHouse.PayoutOutOfRange.selector);
        house.setParams(20000, 5000, 5000, 1 ether); // >= 2.0x = non-positive edge
        vm.expectRevert(PredictionHouse.PayoutOutOfRange.selector);
        house.setParams(10000, 5000, 5000, 1 ether); // 1.0x = no winnings
        vm.expectRevert(PredictionHouse.ExposureCapTooHigh.selector);
        house.setParams(M, 6000, 5000, 1 ether); // > 50%
    }

    function test_House_ReserveReleasedOnBalancingBet() public {
        // solo UP reserves 95; a matching DOWN bet balances it back toward 0
        (uint256 id,) = _openRound();
        _bet(alice, id, true, 100 ether);
        assertEq(vault.reservedExposure(), 95 ether);
        _bet(bob, id, false, 100 ether); // now balanced -> reserve 0
        assertEq(vault.reservedExposure(), 0);
    }

    // =========================================================
    // Access / lifecycle guards
    // =========================================================

    function test_House_Revert_BetAfterLock() public {
        (uint256 id, uint64 lockTime) = _openRound();
        vm.warp(lockTime);
        vm.prank(alice);
        vm.expectRevert(PredictionHouse.BettingClosed.selector);
        house.bet(id, true, 1 ether);
    }

    function test_House_Revert_DoubleClaim() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether);
        _bet(bob, id, false, 100 ether);
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1);
        vm.prank(alice);
        house.claim(id);
        vm.prank(alice);
        vm.expectRevert(PredictionHouse.AlreadyClaimed.selector);
        house.claim(id);
    }

    function test_House_Pause_BlocksBet_AllowsResolve() public {
        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, 100 ether);
        _bet(bob, id, false, 100 ether);
        house.pause();
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSignature("EnforcedPause()"));
        house.bet(id, true, 1 ether);
        // in-flight round still resolves + pays while paused
        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, STRIKE + 1);
        _claimGain(alice, id);
    }

    function test_House_Reentrancy_ClaimBlocked() public {
        ReentrantToken rtok = new ReentrantToken();
        HouseVault rvault = new HouseVault(IERC20(address(rtok)), "RV", "RV");
        PredictionHouse rhouse =
            new PredictionHouse(IPyth(address(pyth)), rvault, M, 60, 5000, 5000, 1_000_000 ether, 0, 1 hours);
        rvault.setHouse(address(rhouse));
        uint256 mid = rhouse.addMarket(FEED, TF);
        rtok.setHouse(rhouse);

        rtok.mint(lp, 1_000_000 ether);
        vm.startPrank(lp);
        rtok.approve(address(rvault), type(uint256).max);
        rvault.deposit(1_000_000 ether, lp);
        vm.stopPrank();

        rtok.mint(alice, 1000 ether);
        vm.prank(alice);
        rtok.approve(address(rhouse), type(uint256).max);

        uint64 l = uint64(block.timestamp + 10);
        uint256 id = rhouse.createRound(mid, l);
        vm.prank(alice);
        rhouse.bet(id, true, 100 ether); // solo -> vault pays on win
        vm.warp(l);
        rhouse.lock{value: FEE}(id, _upd(STRIKE, 0, uint64(block.timestamp)));
        vm.warp(uint256(l) + TF);
        rhouse.settle{value: FEE}(id, _upd(STRIKE + 1, 0, uint64(block.timestamp)));

        rtok.arm(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        rhouse.claim(id);
    }

    // =========================================================
    // Fuzz: solvency + conservation
    // =========================================================

    /// For any (U, D) and either outcome: the vault stays solvent, winners are paid m*stake, and
    /// nothing is created or destroyed (house ends holding exactly the winners' distributable).
    function testFuzz_SolvencyAndConservation(uint96 up, uint96 down, bool upWins) public {
        up = uint96(bound(up, 1, 100_000 ether));
        down = uint96(bound(down, 1, 100_000 ether));

        (uint256 id, uint64 lockTime) = _openRound();
        _bet(alice, id, true, up);
        _bet(bob, id, false, down);

        // reserve must cover the vault's worst-case loss on THIS round
        uint256 reserve = vault.reservedExposure();
        uint256 lossIfUp = _lossIfWins(up, down); // vault pays if UP wins
        uint256 lossIfDown = _lossIfWins(down, up); // vault pays if DOWN wins
        assertGe(reserve, lossIfUp, "reserve under-covers UP-win loss");
        assertGe(reserve, lossIfDown, "reserve under-covers DOWN-win loss");
        assertGe(vault.totalAssets(), vault.reservedExposure(), "INV-1 pre-settle");

        _lock(id, lockTime, STRIKE);
        _settle(id, lockTime, upWins ? STRIKE + 1 : STRIKE - 1);

        assertEq(vault.reservedExposure(), 0, "reserve released");
        assertGe(vault.totalAssets(), vault.reservedExposure(), "INV-1 post-settle");

        uint256 winStake = upWins ? up : down;
        uint256 distributable = uint256(winStake) * M / 10000;
        // house holds exactly the winners' distributable after settle
        assertEq(token.balanceOf(address(house)), distributable, "house holds exactly distributable");

        // winner(s) can withdraw the whole distributable, nothing stranded
        address winner = upWins ? alice : bob;
        if (distributable > 0) {
            assertEq(_claimGain(winner, id), distributable);
        }
        assertEq(token.balanceOf(address(house)), 0, "nothing stranded in house after claims");
    }

    function _lossIfWins(uint256 winStake, uint256 loseStake) internal pure returns (uint256) {
        uint256 owed = winStake * M / 10000; // floored payout to winners
        uint256 escrow = winStake + loseStake;
        return owed > escrow ? owed - escrow : 0;
    }

    receive() external payable {}
}
