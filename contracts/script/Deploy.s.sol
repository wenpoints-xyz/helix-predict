// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PredictionPool} from "../src/PredictionPool.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Deploy PredictionPool wired to the live Pyth contract for the current chain,
/// then register BTC/ETH/INJ markets at 30s / 1m / 2m.
/// Env: STAKE_TOKEN (address of the points/stake ERC20), optional RAKE_BPS (default 300).
contract Deploy is Script {
    // Pyth pull oracle on Injective EVM (verified live; see design doc).
    address constant PYTH_MAINNET = 0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320; // chainid 1776
    address constant PYTH_TESTNET = 0xDd24F84d36BF92C65F92307595335bdFab5Bbd21; // chainid 1439

    // Pyth price feed ids (universal across chains).
    bytes32 constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant INJ = 0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592;

    function run() external {
        address pyth = block.chainid == 1776 ? PYTH_MAINNET : PYTH_TESTNET;
        address stakeToken = vm.envAddress("STAKE_TOKEN");
        uint256 rakeBps = vm.envOr("RAKE_BPS", uint256(300));

        vm.startBroadcast();
        PredictionPool pool = new PredictionPool(IPyth(pyth), IERC20(stakeToken), rakeBps, 60);

        bytes32[3] memory feeds = [BTC, ETH, INJ];
        uint32[3] memory tfs = [uint32(30), 60, 120];
        for (uint256 i; i < feeds.length; i++) {
            for (uint256 j; j < tfs.length; j++) {
                pool.addMarket(feeds[i], tfs[j]);
            }
        }
        vm.stopBroadcast();

        console2.log("chainid       ", block.chainid);
        console2.log("pyth          ", pyth);
        console2.log("stakeToken    ", stakeToken);
        console2.log("PredictionPool", address(pool));
        console2.log("markets       ", pool.marketsLength());
    }
}
