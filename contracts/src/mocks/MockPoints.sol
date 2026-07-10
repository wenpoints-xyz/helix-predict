// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet-only faucet stand-in for the real $HELIXPOINT stake token.
/// Anyone can mint free chips to play with. NEVER deploy this on mainnet — on mainnet
/// PredictionPool is wired to the real $HELIXPOINT ERC20 instead.
contract MockPoints is ERC20 {
    constructor() ERC20("HELIX Points (testnet)", "tPOINTS") {}

    /// @notice Mint yourself test chips. Open faucet, testnet only.
    function faucet(uint256 amount) external {
        _mint(msg.sender, amount);
    }
}
