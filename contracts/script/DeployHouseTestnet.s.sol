// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PredictionHouse} from "../src/PredictionHouse.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {MockPoints} from "../src/mocks/MockPoints.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Testnet deploy of the HOUSE stack: MockPoints faucet + HouseVault (LP bankroll) +
/// PredictionHouse wired to it and the live Injective testnet Pyth, with BTC/ETH/INJ markets at
/// 30s / 1m / 2m, then a seed LP deposit so the house can take bets from block one.
///
/// NOTE: Injective testnet returns null receipts, so `forge script --broadcast` hangs. This file
/// is the canonical record + bytecode source; actual deploys go through script/deploy-house-testnet.sh
/// (cast --async + codesize polling). On mainnet, wire a real vault to real $HELIXPOINT instead.
contract DeployHouseTestnet is Script {
    address constant PYTH_TESTNET = 0xDd24F84d36BF92C65F92307595335bdFab5Bbd21; // chainid 1439

    bytes32 constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant INJ = 0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592;

    // house params
    uint256 constant PAYOUT_BPS = 19500; // 1.95x  (~2.56% edge)
    uint64 constant MAX_PRICE_AGE = 60;
    uint256 constant MAX_ROUND_EXPOSURE_BPS = 1000; // 10% of bankroll per round
    uint256 constant MAX_AGG_EXPOSURE_BPS = 3000; // 30% of bankroll across all open rounds
    uint256 constant MAX_BET = 5000 ether; // 5000 tPOINTS per bet
    uint256 constant MAX_CONF_BPS = 200; // void if Pyth conf band > 2%
    uint64 constant SETTLE_GRACE = 3600; // 1h refund hatch
    uint256 constant SEED = 100_000 ether; // initial LP bankroll

    function run() external {
        require(block.chainid == 1439, "testnet only (chainid 1439)");

        vm.startBroadcast();
        MockPoints points = new MockPoints();
        HouseVault vault = new HouseVault(IERC20(address(points)), "HELIX House LP (testnet)", "hHLX-t");
        PredictionHouse house = new PredictionHouse(
            IPyth(PYTH_TESTNET),
            vault,
            PAYOUT_BPS,
            MAX_PRICE_AGE,
            MAX_ROUND_EXPOSURE_BPS,
            MAX_AGG_EXPOSURE_BPS,
            MAX_BET,
            MAX_CONF_BPS,
            SETTLE_GRACE
        );
        vault.setHouse(address(house));

        bytes32[3] memory feeds = [BTC, ETH, INJ];
        for (uint256 i; i < feeds.length; i++) {
            house.addMarket(feeds[i], 15); // 15s rounds
        }

        // seed the bankroll so the house is live immediately
        points.faucet(SEED);
        points.approve(address(vault), SEED);
        vault.deposit(SEED, msg.sender);
        vm.stopBroadcast();

        console2.log("MockPoints     ", address(points));
        console2.log("HouseVault     ", address(vault));
        console2.log("PredictionHouse", address(house));
        console2.log("markets        ", house.marketsLength());
        console2.log("bankroll       ", vault.totalAssets());
    }
}
