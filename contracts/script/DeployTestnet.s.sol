// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PredictionPool} from "../src/PredictionPool.sol";
import {MockPoints} from "../src/mocks/MockPoints.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Testnet deploy: a MockPoints faucet token + PredictionPool wired to it and the
/// live Injective testnet Pyth, with BTC/ETH/INJ markets at 30s / 1m / 2m.
/// On mainnet, use Deploy.s.sol instead (wired to real $HELIXPOINT via STAKE_TOKEN).
contract DeployTestnet is Script {
    address constant PYTH_TESTNET = 0xDd24F84d36BF92C65F92307595335bdFab5Bbd21; // chainid 1439

    bytes32 constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 constant INJ = 0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592;

    function run() external {
        require(block.chainid == 1439, "testnet only (chainid 1439)");

        vm.startBroadcast();
        MockPoints points = new MockPoints();
        PredictionPool pool = new PredictionPool(IPyth(PYTH_TESTNET), IERC20(address(points)), 300, 60);

        bytes32[3] memory feeds = [BTC, ETH, INJ];
        uint32[3] memory tfs = [uint32(30), 60, 120];
        for (uint256 i; i < feeds.length; i++) {
            for (uint256 j; j < tfs.length; j++) {
                pool.addMarket(feeds[i], tfs[j]);
            }
        }
        vm.stopBroadcast();

        console2.log("MockPoints    ", address(points));
        console2.log("PredictionPool", address(pool));
        console2.log("markets       ", pool.marketsLength());
    }
}
