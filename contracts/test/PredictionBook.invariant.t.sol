// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {PredictionBook} from "../src/PredictionBook.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockPythUnique} from "./mocks/MockPythUnique.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockERC20I is ERC20 {
    constructor() ERC20("Points", "PTS") {}

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Drives the per-user book under the fuzzer: LPs deposit/withdraw, bettors open bounded positions
/// on both sides at random durations, positions are settled (win/loss/void) or voided-after-grace by
/// a permissionless settler (this handler), and winners/void-refunds are claimed — all interleaved.
/// Ghosts track exposure and value so the invariants can assert solvency + reserve-sum + conservation
/// across the NO-NETTING reserve model (every open bet reserves its full ⌈(m−1)·stake⌉).
contract Handler is Test {
    PredictionBook public book;
    HouseVault public vault;
    MockERC20I public token;
    MockPythUnique public pyth;
    uint256 public marketId;

    bytes32 constant FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    int64 constant STRIKE = 100_000;

    address[3] public lps = [address(0xda11), address(0xda12), address(0xda13)];
    address[4] public bettors = [address(0xbe71), address(0xbe72), address(0xbe73), address(0xbe74)];

    uint256[] public openBets; // currently-Open betIds
    uint256[] public claimable; // settled/voided betIds with owed > 0

    // ghosts
    uint256 public gDeposited;
    uint256 public gStakeIn;
    uint256 public gWithdrawn;
    uint256 public gClaimed;
    uint256 public gTips;
    uint256 public gOpenReserve; // running sum of reserves on OPEN positions

    receive() external payable {}

    constructor(
        PredictionBook _book,
        HouseVault _vault,
        MockERC20I _token,
        MockPythUnique _pyth,
        uint256 _mid
    ) {
        book = _book;
        vault = _vault;
        token = _token;
        pyth = _pyth;
        marketId = _mid;
        vm.deal(address(this), 10_000 ether);
        for (uint256 i; i < lps.length; i++) {
            token.mint(lps[i], 1_000_000 ether);
        }
        for (uint256 i; i < bettors.length; i++) {
            token.mint(bettors[i], 1_000_000 ether);
        }
    }

    function openCount() external view returns (uint256) {
        return openBets.length;
    }

    function _uupd(int64 price, uint64 pt, uint64 prevPt) internal view returns (bytes[] memory d) {
        d = new bytes[](1);
        d[0] = pyth.createUniqueUpdateData(FEED, price, 0, -8, pt, prevPt);
    }

    function _removeOpen(uint256 idx) internal {
        openBets[idx] = openBets[openBets.length - 1];
        openBets.pop();
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
        amt = bound(amt, 0, vault.maxWithdraw(lp));
        if (amt == 0) return;
        vm.prank(lp);
        vault.withdraw(amt, lp, lp);
        gWithdrawn += amt;
    }

    function open(uint256 bSeed, bool up, uint256 amt, uint256 durSeed) external {
        address b = bettors[bSeed % bettors.length];
        uint256 cap = token.balanceOf(b);
        if (cap > book.maxBet()) cap = book.maxBet();
        amt = bound(amt, 0, cap);
        if (amt < book.minBet()) return;
        uint64 dur = uint64(bound(durSeed, book.minDur(), book.maxDur()));
        vm.startPrank(b);
        token.approve(address(book), amt);
        try book.openBet(marketId, up, amt, dur) returns (uint256 betId) {
            gStakeIn += amt;
            gOpenReserve += book.getPosition(betId).reserve;
            openBets.push(betId);
        } catch {}
        vm.stopPrank();
    }

    function settle(uint256 idxSeed, uint256 priceSeed) external {
        if (openBets.length == 0) return;
        uint256 idx = idxSeed % openBets.length;
        uint256 id = openBets[idx];
        PredictionBook.Position memory p = book.getPosition(id);
        uint64 sAt = p.strikeInstant;
        uint64 cAt = sAt + p.dur;
        if (block.timestamp < cAt) vm.warp(cAt);
        int64 close = STRIKE + int64(int256(priceSeed % 3)) - 1; // down / tie / up
        uint256 tipBefore = token.balanceOf(address(this));
        try book.settle{value: 2}(id, _uupd(STRIKE, sAt, sAt - 1), _uupd(close, cAt, cAt - 1)) {
            gOpenReserve -= p.reserve;
            gTips += token.balanceOf(address(this)) - tipBefore;
            if (book.owed(id) > 0) claimable.push(id);
            _removeOpen(idx);
        } catch {}
    }

    function voidExpire(uint256 idxSeed) external {
        if (openBets.length == 0) return;
        uint256 idx = idxSeed % openBets.length;
        uint256 id = openBets[idx];
        PredictionBook.Position memory p = book.getPosition(id);
        uint256 deadline = uint256(p.strikeInstant) + p.dur + book.settleGrace();
        if (block.timestamp < deadline) vm.warp(deadline);
        uint256 tipBefore = token.balanceOf(address(this));
        try book.voidExpired(id) {
            gOpenReserve -= p.reserve;
            gTips += token.balanceOf(address(this)) - tipBefore;
            if (book.owed(id) > 0) claimable.push(id);
            _removeOpen(idx);
        } catch {}
    }

    function claim(uint256 idxSeed) external {
        if (claimable.length == 0) return;
        uint256 idx = idxSeed % claimable.length;
        uint256 id = claimable[idx];
        address bettor = book.getPosition(id).bettor;
        uint256 before = token.balanceOf(bettor);
        try book.claim(id) {
            gClaimed += token.balanceOf(bettor) - before;
        } catch {}
        claimable[idx] = claimable[claimable.length - 1];
        claimable.pop();
    }
}

contract PredictionBookInvariantTest is StdInvariant, Test {
    MockPythUnique pyth;
    MockERC20I token;
    HouseVault vault;
    PredictionBook book;
    Handler handler;
    uint256 constant M = 19500;
    uint256 constant SEED = 500_000 ether;
    bytes32 constant FEED = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;

    function setUp() public {
        pyth = new MockPythUnique(60, 1);
        token = new MockERC20I();
        vault = new HouseVault(IERC20(address(token)), "House LP", "hLP");
        book = new PredictionBook(IPyth(address(pyth)), vault, M, 3000, 4000, 1 ether, 50_000 ether);
        vault.setHouse(address(book));
        uint256 mid = book.addMarket(FEED);

        address seed = address(0x5EED);
        token.mint(seed, SEED);
        vm.startPrank(seed);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(SEED, seed);
        vm.stopPrank();

        vm.warp(1_000_000);
        handler = new Handler(book, vault, token, pyth, mid);
        targetContract(address(handler));
    }

    /// INV-1: the vault can always cover what it has reserved. The core solvency guarantee.
    function invariant_VaultSolvent() public view {
        assertGe(vault.totalAssets(), vault.reservedExposure(), "INV-1: vault under-collateralised");
    }

    /// INV-2 (no-netting): the vault's reservation equals the SUM of reserves over all OPEN positions.
    function invariant_ReserveEqualsSumOfOpen() public view {
        assertEq(vault.reservedExposure(), handler.gOpenReserve(), "INV-2: reserve != sum(open)");
    }

    /// INV-3 (value conservation): token held across book+vault equals everything that entered
    /// (seed + deposits + landed stakes) minus everything that left (withdrawals + claims + tips).
    function invariant_ValueConserved() public view {
        uint256 held = token.balanceOf(address(book)) + token.balanceOf(address(vault));
        uint256 expected = SEED + handler.gDeposited() + handler.gStakeIn() - handler.gWithdrawn()
            - handler.gClaimed() - handler.gTips();
        assertEq(held, expected, "INV-3: value not conserved");
    }
}
