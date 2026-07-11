// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {PythErrors} from "@pythnetwork/pyth-sdk-solidity/PythErrors.sol";

/// @notice Test double: the vendored MockPyth predates parsePriceFeedUpdatesUnique, so we add it
/// here with the REAL uniqueness semantics — an update is accepted only if
///     prevPublishTime < minPublishTime <= publishTime <= maxPublishTime
/// i.e. it is the FIRST tick at/after minPublishTime. Encoding carries prevPublishTime so tests can
/// forge a "later, cherry-picked tick" (prevPublishTime >= min) and prove it is rejected.
contract MockPythUnique is MockPyth {
    constructor(uint256 validTimePeriod, uint256 singleUpdateFeeInWei)
        MockPyth(validTimePeriod, singleUpdateFeeInWei)
    {}

    /// @dev Build a Unique-style update. `prevPublishTime` is the publishTime of the tick BEFORE this
    /// one; for an honest "first tick >= T" update, set prevPublishTime = T-1 (i.e. < T).
    function createUniqueUpdateData(
        bytes32 id,
        int64 price,
        uint64 conf,
        int32 expo,
        uint64 publishTime,
        uint64 prevPublishTime
    ) external pure returns (bytes memory) {
        PythStructs.PriceFeed memory pf;
        pf.id = id;
        pf.price.price = price;
        pf.price.conf = conf;
        pf.price.expo = expo;
        pf.price.publishTime = publishTime;
        pf.emaPrice = pf.price;
        return abi.encode(pf, prevPublishTime);
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updateData,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory feeds) {
        if (msg.value < getUpdateFee(updateData)) revert PythErrors.InsufficientFee();
        feeds = new PythStructs.PriceFeed[](priceIds.length);
        for (uint256 i; i < priceIds.length; i++) {
            bool found;
            for (uint256 j; j < updateData.length; j++) {
                (PythStructs.PriceFeed memory pf, uint64 prevPT) =
                    abi.decode(updateData[j], (PythStructs.PriceFeed, uint64));
                if (pf.id != priceIds[i]) continue;
                uint64 pt = uint64(uint256(pf.price.publishTime));
                // The anti-cherry-pick rule: must be the FIRST tick at/after min, within the window.
                if (prevPT < minPublishTime && minPublishTime <= pt && pt <= maxPublishTime) {
                    feeds[i] = pf;
                    found = true;
                    break;
                }
            }
            if (!found) revert PythErrors.PriceFeedNotFoundWithinRange();
        }
    }
}
