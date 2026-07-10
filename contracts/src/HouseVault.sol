// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HouseVault
/// @notice The decentralized "house" bankroll for PredictionHouse. Anyone deposits the stake
/// token (points now, USDC later) and receives ERC4626 shares; the vault is the counterparty to
/// every bet, so LPs earn the house edge (the vig) as yield — the share price rises as losing
/// stakes flow in. LPs bear the counterparty risk in exchange (they pay winners).
///
/// SOLVENCY MODEL — the whole point of this contract:
///
///   totalAssets() = stakeToken.balanceOf(vault)   (LP capital + accrued vig)
///   reservedExposure                              (max the vault could owe on OPEN rounds)
///   freeAssets() = totalAssets() − reservedExposure
///
///   INVARIANT: totalAssets() >= reservedExposure   at all times.
///
/// The house (and only the house) may:
///   reserve(x)      lock x against a new/into-an-open round   — refuses if it would break the invariant
///   release(x)      free a settled round's reservation
///   payWinnings(to,x) pay x out of the bankroll               — refuses if it would break the invariant
///
/// LP withdrawals are capped at freeAssets() (you can't pull capital that's backing open bets):
/// maxWithdraw / maxRedeem are overridden to enforce it. First-depositor inflation attack is
/// blocked by a decimals offset (OZ virtual shares) plus a dead-shares seed at deploy.
///
///   deposit ─► shares ; share price ↑ as vig accrues ; withdraw ≤ freeAssets
///   PredictionHouse ─reserve/release/payWinnings─► bankroll   (onlyHouse)
contract HouseVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @dev Virtual-share offset: makes the first-depositor share-inflation attack uneconomic.
    uint8 private constant OFFSET = 6;

    address public house; // the PredictionHouse; set once
    uint256 public reservedExposure; // sum of max payouts owed on all open rounds

    event HouseSet(address indexed house);
    event Reserved(uint256 amount, uint256 totalReserved);
    event Released(uint256 amount, uint256 totalReserved);
    event WinningsPaid(address indexed to, uint256 amount);

    error NotHouse();
    error HouseAlreadySet();
    error ZeroAddress();
    error WouldBreakSolvency();
    error ReleaseTooMuch();

    constructor(IERC20 asset_, string memory name_, string memory symbol_)
        ERC4626(asset_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {}

    modifier onlyHouse() {
        if (msg.sender != house) revert NotHouse();
        _;
    }

    /// @notice Wire the house once. Immutable-in-practice: cannot be changed after set.
    function setHouse(address h) external onlyOwner {
        if (h == address(0)) revert ZeroAddress();
        if (house != address(0)) revert HouseAlreadySet();
        house = h;
        emit HouseSet(h);
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return OFFSET;
    }

    /// @notice Bankroll not currently backing any open bet — the only thing LPs can withdraw.
    function freeAssets() public view returns (uint256) {
        uint256 t = totalAssets();
        return t > reservedExposure ? t - reservedExposure : 0;
    }

    // ---- house hooks (onlyHouse) ----

    /// @notice Lock `amount` of bankroll against exposure. Reverts if it would break solvency.
    function reserve(uint256 amount) external onlyHouse {
        if (reservedExposure + amount > totalAssets()) revert WouldBreakSolvency();
        reservedExposure += amount;
        emit Reserved(amount, reservedExposure);
    }

    /// @notice Free a previously reserved amount (a round settled/voided).
    function release(uint256 amount) external onlyHouse {
        if (amount > reservedExposure) revert ReleaseTooMuch();
        reservedExposure -= amount;
        emit Released(amount, reservedExposure);
    }

    /// @notice Pay `amount` from the bankroll to a winner. Self-guards: refuses to pay into
    /// insolvency even if the house miscounts, so the vault can never owe more than it holds.
    function payWinnings(address to, uint256 amount) external onlyHouse {
        if (amount > totalAssets() || totalAssets() - amount < reservedExposure) {
            revert WouldBreakSolvency();
        }
        IERC20(asset()).safeTransfer(to, amount);
        emit WinningsPaid(to, amount);
    }

    // ---- withdrawal caps: never let LPs pull reserved capital ----

    function maxWithdraw(address owner_) public view override returns (uint256) {
        uint256 byShares = super.maxWithdraw(owner_);
        uint256 free = freeAssets();
        return byShares < free ? byShares : free;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        uint256 byShares = super.maxRedeem(owner_);
        uint256 freeShares = _convertToShares(freeAssets(), Math.Rounding.Floor);
        return byShares < freeShares ? byShares : freeShares;
    }
}
