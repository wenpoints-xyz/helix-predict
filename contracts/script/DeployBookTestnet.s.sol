// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PredictionBook} from "../src/PredictionBook.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockPoints} from "../src/mocks/MockPoints.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Testnet deploy of the BOOK stack (per-user positions, deterministic settle): a FRESH
/// HouseVault (the existing one's house is one-shot-locked to the retired PredictionHouse) + a
/// PredictionBook wired to it and the live Injective testnet Pyth, with BTC/ETH/INJ markets, guards
/// set (Δ=3s / TOL=5s / grace=1h, from the Hermes-retention probe), then a seed LP deposit. The
/// MockPoints faucet token is REUSED so player balances carry over.
///
/// NOTE: Injective testnet returns null receipts, so `forge script --broadcast` hangs. This file is
/// the canonical record + bytecode source; the actual deploy runs through
/// script/deploy-book-testnet.sh (cast --async + codesize/nonce polling). Mainnet wires a real vault
/// to real $HELIXPOINT and requires explicit authorization.
contract DeployBookTestnet is Script {
    address constant PYTH_TESTNET = 0xDd24F84d36BF92C65F92307595335bdFab5Bbd21; // chainid 1439
    address constant POINTS = 0x52045F671C452b7f91a7e436c64f126E78638F14; // existing MockPoints (reused)

    bytes32 constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant INJ = 0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592;

    // book params (no-netting, sized so one whale can't pin the reserve: maxBet << agg cap)
    uint256 constant PAYOUT_BPS = 19500; // 1.95x  (~2.56% edge)
    uint256 constant MAX_BET_EXPOSURE_BPS = 500; // per-bet vault max-loss cap: 5% of bankroll
    uint256 constant MAX_AGG_EXPOSURE_BPS = 3000; // aggregate open exposure cap: 30% of bankroll
    uint256 constant MIN_BET = 1 ether; // 1 tPOINT floor (keeps the tip meaningful)
    uint256 constant MAX_BET = 2000 ether; // 2000 tPOINTS/bet -> reserve 1900 << 30% of a 100k bankroll

    // guards
    uint256 constant MAX_CONF_BPS = 200; // void if Pyth conf band > 2%
    uint256 constant TIP_BPS = 100; // settler tip: 1% of stake
    uint256 constant MAX_TIP = 5 ether; // cap the tip at 5 tPOINTS
    uint32 constant MAX_OPEN = 25; // concurrent open positions per user
    uint64 constant MIN_DUR = 5;
    uint64 constant MAX_DUR = 300;
    uint64 constant STRIKE_DELAY = 3; // Δ (future-instant strike lead)
    uint64 constant SETTLE_TOL = 5; // TOL (Unique upper-bound window)
    uint64 constant SETTLE_GRACE = 3600; // 1h refund hatch

    uint256 constant SEED = 100_000 ether; // initial LP bankroll

    function run() external {
        require(block.chainid == 1439, "testnet only (chainid 1439)");
        MockPoints points = MockPoints(POINTS);

        vm.startBroadcast();
        HouseVault vault = new HouseVault(IERC20(POINTS), "HELIX House LP (testnet)", "hHLX-t");
        PredictionBook book = new PredictionBook(
            IPyth(PYTH_TESTNET), vault, PAYOUT_BPS, MAX_BET_EXPOSURE_BPS, MAX_AGG_EXPOSURE_BPS, MIN_BET, MAX_BET
        );
        vault.setHouse(address(book));

        book.addMarket(BTC);
        book.addMarket(ETH);
        book.addMarket(INJ);
        book.setGuards(
            MAX_CONF_BPS, TIP_BPS, MAX_TIP, MAX_OPEN, MIN_DUR, MAX_DUR, STRIKE_DELAY, SETTLE_TOL, SETTLE_GRACE
        );

        points.faucet(SEED);
        points.approve(address(vault), SEED);
        vault.deposit(SEED, msg.sender);
        vm.stopBroadcast();

        console2.log("HouseVault (new)", address(vault));
        console2.log("PredictionBook  ", address(book));
        console2.log("markets         ", book.marketsLength());
        console2.log("bankroll        ", vault.totalAssets());
    }
}
