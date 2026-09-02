// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IRamenRoles} from "./interfaces/IRamenRoles.sol";

interface IRamenOtcDepositor {
    function depositProtocolFees(address token, address asset, uint256 devAmount, uint256 ownerAmount) external;
}

/// @notice Permanent Uniswap v3 LP NFT locker. LP principal has no withdrawal path.
/// @dev Launcher fees accrue for pull-claiming. Protocol fees are deposited directly into OTC decks.
contract RamenLiquidityLocker {
    uint16 public constant CREATOR_FEE_BPS = 6_900;
    uint16 public constant PROTOCOL_FEE_BPS = 3_100;
    uint16 private constant BPS = 10_000;

    struct LockedPosition {
        address launcher;
        address token;
        address pool;
        address token0;
        address token1;
        bool registered;
    }

    INonfungiblePositionManager public immutable positionManager;
    address public immutable bootstrapAdmin;
    address public immutable otc;
    address public launchContract;
    bool private entered;

    mapping(uint256 => LockedPosition) public positions;
    mapping(address => uint256) public positionForToken;
    mapping(uint256 => mapping(address => uint256)) public claimable;
    mapping(uint256 => mapping(address => uint256)) public pendingDevProtocol;
    mapping(uint256 => mapping(address => uint256)) public pendingOwnerProtocol;

    event PositionLocked(
        uint256 indexed tokenId,
        address indexed launcher,
        address indexed token,
        address pool,
        address token0,
        address token1
    );
    event FeesHarvested(
        uint256 indexed tokenId,
        uint256 creatorAmount0,
        uint256 creatorAmount1,
        uint256 devAmount0,
        uint256 devAmount1,
        uint256 ownerAmount0,
        uint256 ownerAmount1
    );
    event LauncherFeesClaimed(uint256 indexed tokenId, address indexed launcher, uint256 amount0, uint256 amount1);
    event ProtocolFeesDeposited(uint256 indexed tokenId, address indexed asset, uint256 devAmount, uint256 ownerAmount);
    event ProtocolFeesDeferred(uint256 indexed tokenId, address indexed asset, uint256 devAmount, uint256 ownerAmount);
    event Initialized(address indexed launchContract);

    error Unauthorized();
    error AlreadyRegistered();
    error UnknownPosition();
    error Reentrancy();
    error TransferFailed();
    error InvalidAddress();

    constructor(address positionManager_, address otc_) {
        if (positionManager_ == address(0) || otc_ == address(0)) {
            revert InvalidAddress();
        }
        bootstrapAdmin = msg.sender;
        positionManager = INonfungiblePositionManager(positionManager_);
        otc = otc_;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    function initialize(address launchContract_) external {
        if (msg.sender != bootstrapAdmin) revert Unauthorized();
        if (launchContract != address(0)) revert AlreadyRegistered();
        if (launchContract_ == address(0)) revert InvalidAddress();
        launchContract = launchContract_;
        emit Initialized(launchContract_);
    }

    function owner() external view returns (address) {
        return IRamenRoles(launchContract).owner();
    }

    function ramenDev() external view returns (address) {
        return IRamenRoles(launchContract).ramenDev();
    }

    function registerPosition(
        uint256 tokenId,
        address launcher,
        address token,
        address pool,
        address token0,
        address token1
    ) external {
        if (msg.sender != launchContract) revert Unauthorized();
        if (positions[tokenId].registered || positionForToken[token] != 0) revert AlreadyRegistered();
        positions[tokenId] = LockedPosition(launcher, token, pool, token0, token1, true);
        positionForToken[token] = tokenId;
        emit PositionLocked(tokenId, launcher, token, pool, token0, token1);
    }

    /// @notice Permissionless harvest used by routed swaps and the backend keeper.
    function harvest(uint256 tokenId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        return _harvest(tokenId);
    }

    /// @notice Token-address form used automatically after a RamenOTC-routed trade.
    function harvestForToken(address token) external nonReentrant {
        uint256 tokenId = positionForToken[token];
        if (tokenId == 0) revert UnknownPosition();
        _harvest(tokenId);
    }

    /// @notice Harvests, routes protocol shares to OTC, then pays all accrued launcher fees.
    function claimFees(uint256 tokenId) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        LockedPosition memory position = positions[tokenId];
        if (!position.registered) revert UnknownPosition();
        if (msg.sender != position.launcher) revert Unauthorized();
        _harvest(tokenId);
        // A prior OTC outage must not strand protocol fees once the launcher returns to claim.
        _flushProtocol(tokenId, position.token, position.token0);
        _flushProtocol(tokenId, position.token, position.token1);

        amount0 = claimable[tokenId][position.token0];
        amount1 = claimable[tokenId][position.token1];
        claimable[tokenId][position.token0] = 0;
        claimable[tokenId][position.token1] = 0;
        _safeTransfer(position.token0, position.launcher, amount0);
        _safeTransfer(position.token1, position.launcher, amount1);
        emit LauncherFeesClaimed(tokenId, position.launcher, amount0, amount1);
    }

    /// @notice Retries protocol OTC deposits without touching launcher claimable balances.
    function flushProtocolFees(uint256 tokenId) external nonReentrant {
        LockedPosition memory position = positions[tokenId];
        if (!position.registered) revert UnknownPosition();
        _flushProtocol(tokenId, position.token, position.token0);
        _flushProtocol(tokenId, position.token, position.token1);
    }

    function _harvest(uint256 tokenId) private returns (uint256 amount0, uint256 amount1) {
        LockedPosition memory position = positions[tokenId];
        if (!position.registered) revert UnknownPosition();
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this), amount0Max: type(uint128).max, amount1Max: type(uint128).max
            })
        );

        // Empty manual claims should neither inflate harvest KPIs nor make external OTC calls.
        if (amount0 == 0 && amount1 == 0) return (0, 0);

        (uint256 creator0, uint256 dev0, uint256 owner0) = _split(amount0);
        (uint256 creator1, uint256 dev1, uint256 owner1) = _split(amount1);
        claimable[tokenId][position.token0] += creator0;
        claimable[tokenId][position.token1] += creator1;
        _queueProtocol(tokenId, position.token, position.token0, dev0, owner0);
        _queueProtocol(tokenId, position.token, position.token1, dev1, owner1);
        emit FeesHarvested(tokenId, creator0, creator1, dev0, dev1, owner0, owner1);
    }

    function _split(uint256 amount) private pure returns (uint256 creator, uint256 dev, uint256 protocolOwner) {
        creator = amount * CREATOR_FEE_BPS / BPS;
        uint256 protocol = amount - creator;
        dev = protocol / 2;
        protocolOwner = protocol - dev;
    }

    function _queueProtocol(uint256 tokenId, address token, address asset, uint256 devAmount, uint256 ownerAmount)
        private
    {
        pendingDevProtocol[tokenId][asset] += devAmount;
        pendingOwnerProtocol[tokenId][asset] += ownerAmount;
        _flushProtocol(tokenId, token, asset);
    }

    function _flushProtocol(uint256 tokenId, address token, address asset) private {
        uint256 devAmount = pendingDevProtocol[tokenId][asset];
        uint256 ownerAmount = pendingOwnerProtocol[tokenId][asset];
        uint256 total = devAmount + ownerAmount;
        if (total == 0) return;
        _forceApprove(asset, otc, total);
        pendingDevProtocol[tokenId][asset] = 0;
        pendingOwnerProtocol[tokenId][asset] = 0;
        try IRamenOtcDepositor(otc).depositProtocolFees(token, asset, devAmount, ownerAmount) {
            emit ProtocolFeesDeposited(tokenId, asset, devAmount, ownerAmount);
        } catch {
            pendingDevProtocol[tokenId][asset] = devAmount;
            pendingOwnerProtocol[tokenId][asset] = ownerAmount;
            emit ProtocolFeesDeferred(tokenId, asset, devAmount, ownerAmount);
        }
    }

    /// @dev Accepts only Uniswap v3 position NFTs. There is intentionally no ERC-721 transfer-out method.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(positionManager)) revert Unauthorized();
        return this.onERC721Received.selector;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (ok && (data.length == 0 || abi.decode(data, (bool)))) return;
        (ok, data) = token.call(abi.encodeCall(IERC20.approve, (spender, 0)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
        (ok, data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
