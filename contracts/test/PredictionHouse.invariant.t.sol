// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PredictionHouse} from "../src/PredictionHouse.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20I is ERC20 {
    constructor() ERC20("Points", "PTS") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Drives the full lifecycle under the invariant fuzzer: LPs deposit/withdraw, bettors bet both
/// sides at bounded sizes, rounds are opened and resolved (lock+settle with a random up/tie/down
/// outcome), and winners claim — all interleaved in random order. Actions guard their
/// preconditions and swallow cap-driven reverts so the sequence keeps making progress.
contract Handler is Test {
    PredictionHouse public house;
    HouseVault public vault;
    MockERC20I public token;
    MockPyth public pyth;
    uint256 public marketId;
    bytes32 constant FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    uint32 constant TF = 30;
    int64 constant STRIKE = 100_000;
    uint256 constant NONE = type(uint256).max;

    address[3] public lps = [address(0xda11), address(0xda12), address(0xda13)];
    address[4] public bettors = [address(0xbe71), address(0xbe72), address(0xbe73), address(0xbe74)];

    uint256 public curRound = NONE;
    uint64 public curLock;
    uint256[] public settledRounds;

    // value-conservation ghosts (token that ENTERED / LEFT the two-contract system)
    uint256 public gDeposited;
    uint256 public gBet;
    uint256 public gWithdrawn;
    uint256 public gClaimed;

    constructor(
        PredictionHouse _house,
        HouseVault _vault,
        MockERC20I _token,
        MockPyth _pyth,
        uint256 _marketId
    ) {
        house = _house;
        vault = _vault;
        token = _token;
        pyth = _pyth;
        marketId = _marketId;
        vm.deal(address(this), 1000 ether);
        for (uint256 i; i < lps.length; i++) {
            token.mint(lps[i], 1_000_000 ether);
        }
        for (uint256 i; i < bettors.length; i++) {
            token.mint(bettors[i], 1_000_000 ether);
        }
    }

    function hasOpenRound() external view returns (bool) {
        return curRound != NONE;
    }

    function _feed(int64 price, uint64 pub) internal view returns (bytes[] memory d) {
        d = new bytes[](1);
        d[0] = pyth.createPriceFeedUpdateData(FEED, price, 0, -8, price, 0, pub);
    }

    function deposit(uint256 lpSeed, uint256 amt) external {
        address lp = lps[lpSeed % lps.length];
        amt = bound(amt, 0, token.balanceOf(lp));
        if (amt == 0) return;
        vm.startPrank(lp);
        token.approve(address(vault), amt);
        vault.deposit(amt, lp);
        vm.stopPrank();
        gDeposited += amt;
    }

    function withdraw(uint256 lpSeed, uint256 amt) external {
        address lp = lps[lpSeed % lps.length];
        uint256 mx = vault.maxWithdraw(lp);
        amt = bound(amt, 0, mx);
        if (amt == 0) return;
        vm.prank(lp);
        vault.withdraw(amt, lp, lp);
        gWithdrawn += amt;
    }

    function openRound() external {
        if (curRound != NONE) return;
        uint64 lock = uint64(block.timestamp + 10);
        try house.createRound(marketId, lock) returns (uint256 id) {
            curRound = id;
            curLock = lock;
        } catch {}
    }

    function bet(uint256 bSeed, bool up, uint256 amt) external {
        if (curRound == NONE || block.timestamp >= curLock) return;
        address b = bettors[bSeed % bettors.length];
        uint256 cap = token.balanceOf(b);
        if (cap > house.maxBet()) cap = house.maxBet();
        amt = bound(amt, 0, cap);
        if (amt == 0) return;
        uint256 before = token.balanceOf(address(house));
        vm.startPrank(b);
        token.approve(address(house), amt);
        try house.bet(curRound, up, amt) {} catch {} // may hit exposure caps -> fine
        vm.stopPrank();
        gBet += token.balanceOf(address(house)) - before; // only counts a bet that actually landed
    }

    function resolve(uint256 priceSeed) external {
        if (curRound == NONE) return;
        if (block.timestamp < curLock) vm.warp(curLock);
        uint256 id = curRound;
        uint64 expiry = curLock + TF;
        // lock at/after lockTime
        try house.lock{value: 1}(id, _feed(STRIKE, uint64(block.timestamp))) {} catch {}
        // settle at/after expiry with random outcome: 0=down, 1=tie(void), 2=up
        vm.warp(expiry);
        int64 close = STRIKE + int64(int256(priceSeed % 3)) - 1;
        try house.settle{value: 1}(id, _feed(close, uint64(block.timestamp))) {
            settledRounds.push(id);
            curRound = NONE;
        } catch {}
    }

    function claim(uint256 bSeed, uint256 rSeed) external {
        if (settledRounds.length == 0) return;
        address b = bettors[bSeed % bettors.length];
        uint256 id = settledRounds[rSeed % settledRounds.length];
        uint256 before = token.balanceOf(b);
        vm.prank(b);
        try house.claim(id) {} catch {}
        gClaimed += token.balanceOf(b) - before;
    }
}

contract PredictionHouseInvariantTest is StdInvariant, Test {
    MockPyth pyth;
    MockERC20I token;
    HouseVault vault;
    PredictionHouse house;
    Handler handler;
    uint256 constant M = 19500;
    uint256 constant SEED = 500_000 ether;
    bytes32 constant FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    function setUp() public {
        pyth = new MockPyth(60, 1);
        token = new MockERC20I();
        vault = new HouseVault(IERC20(address(token)), "House LP", "hLP");
        house = new PredictionHouse(IPyth(address(pyth)), vault, M, 60, 3000, 4000, 100_000 ether, 0, 1 hours);
        vault.setHouse(address(house));
        uint256 mid = house.addMarket(FEED, 30);

        // seed the vault so there is a bankroll from block one
        address seed = address(0x5EED);
        token.mint(seed, SEED);
        vm.startPrank(seed);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(SEED, seed);
        vm.stopPrank();

        vm.warp(1_000_000);
        handler = new Handler(house, vault, token, pyth, mid);
        targetContract(address(handler));
    }

    /// INV-1: the vault can always cover what it has reserved. The core solvency guarantee.
    function invariant_VaultSolvent() public view {
        assertGe(vault.totalAssets(), vault.reservedExposure(), "INV-1: vault under-collateralised");
    }

    /// INV-2: the vault's reservation equals the open round's net reserve (0 when none is open).
    function invariant_ReserveMatchesOpenRound() public view {
        if (handler.hasOpenRound()) {
            assertEq(
                vault.reservedExposure(), house.roundReserve(handler.curRound()), "INV-2: reserve mismatch"
            );
        } else {
            assertEq(vault.reservedExposure(), 0, "INV-2: dangling reserve with no open round");
        }
    }

    /// INV-3 (value conservation): no wei is created or destroyed. The token held across the two
    /// contracts equals everything that entered (seed + deposits + landed bets) minus everything
    /// that left (withdrawals + claims). Internal vig/payout transfers cancel out.
    function invariant_ValueConserved() public view {
        uint256 held = token.balanceOf(address(house)) + token.balanceOf(address(vault));
        uint256 expected =
            SEED + handler.gDeposited() + handler.gBet() - handler.gWithdrawn() - handler.gClaimed();
        assertEq(held, expected, "INV-3: value not conserved");
    }
}
