// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {IRamenRoles} from "./interfaces/IRamenRoles.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";

/// @notice Two-sided RAMEN/TOKEN OTC inventory routed at the realized Uniswap v3 execution price.
/// @dev TOKEN deck principal earns RAMEN; RAMEN deck principal earns TOKEN.
contract RamenOTC {
    uint16 public constant MIN_OTC_BPS = 100;
    uint16 public constant MAX_OTC_BPS = 3_000;
    uint16 public constant INITIAL_OTC_BPS = 2_000;
    uint16 public constant RAMEN_DEV_BPS = 6_900;
    uint16 private constant BPS = 10_000;
    uint256 private constant ACC_PRECISION = 1e27;
    uint256 private constant MIN_INVENTORY_RESERVE = 1 ether;

    enum Side {
        Token,
        Ramen
    }

    struct Deck {
        uint256 inventory;
        uint256 totalShares;
        uint256 yieldBalance;
        uint256 accYieldPerShare;
    }

    struct Position {
        uint256 shares;
        uint256 rewardDebt;
        uint256 pendingYield;
    }

    struct Market {
        address pool;
        uint256 positionTokenId;
        bool registered;
        Deck tokenDeck;
        Deck ramenDeck;
    }

    address public immutable bootstrapAdmin;
    address public immutable ramen;
    ISwapRouter02 public immutable swapRouter;
    address public launcher;
    address public locker;
    uint16 public otcBps = INITIAL_OTC_BPS;
    bool private entered;

    mapping(address => Market) private markets;
    mapping(address => mapping(Side => mapping(address => Position))) private positions;

    event MarketRegistered(address indexed token, address indexed pool, uint256 indexed positionTokenId);
    event Initialized(address indexed launcher, address indexed locker);
    event OtcBpsUpdated(uint16 previousBps, uint16 newBps);
    event Deposited(
        address indexed token, Side indexed side, address indexed beneficiary, uint256 amount, uint256 shares
    );
    event Withdrawn(
        address indexed token, Side indexed side, address indexed beneficiary, uint256 principal, uint256 yieldAmount
    );
    event OtcSwap(
        address indexed token,
        address indexed trader,
        address indexed recipient,
        bool isBuy,
        uint256 amountIn,
        uint256 amountOut,
        uint256 poolAmountIn,
        uint256 otcAmountIn,
        uint256 otcAmountOut
    );
    event ProtocolChurned(address indexed token, address indexed beneficiary, uint256 ramenAmount, uint256 tokenAmount);

    error Unauthorized();
    error InvalidAddress();
    error InvalidBps();
    error UnknownMarket();
    error AlreadyRegistered();
    error InvalidAmount();
    error InsufficientOutput();
    error InsufficientShares();
    error TransferFailed();
    error Reentrancy();

    constructor(address ramen_, address swapRouter_) {
        if (ramen_ == address(0) || swapRouter_ == address(0)) revert InvalidAddress();
        bootstrapAdmin = msg.sender;
        ramen = ramen_;
        swapRouter = ISwapRouter02(swapRouter_);
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    modifier onlyOwner() {
        if (msg.sender != IRamenRoles(launcher).owner()) revert Unauthorized();
        _;
    }

    function owner() external view returns (address) {
        return IRamenRoles(launcher).owner();
    }

    function ramenDev() external view returns (address) {
        return IRamenRoles(launcher).ramenDev();
    }

    function initialize(address launcher_, address locker_) external {
        if (msg.sender != bootstrapAdmin) revert Unauthorized();
        if (launcher != address(0) || locker != address(0)) revert AlreadyRegistered();
        if (launcher_ == address(0) || locker_ == address(0)) revert InvalidAddress();
        launcher = launcher_;
        locker = locker_;
        emit Initialized(launcher_, locker_);
    }

    function registerMarket(address token, address pool, uint256 positionTokenId) external {
        if (msg.sender != launcher) revert Unauthorized();
        if (token == address(0) || pool == address(0)) revert InvalidAddress();
        Market storage market = markets[token];
        if (market.registered) revert AlreadyRegistered();
        market.pool = pool;
        market.positionTokenId = positionTokenId;
        market.registered = true;
        emit MarketRegistered(token, pool, positionTokenId);
    }

    /// @notice Seeds the launch's 10% OTC allocation, split 69% ramen_dev / 31% owner.
    function seedTokenDeck(address token, uint256 amount) external nonReentrant {
        if (msg.sender != launcher) revert Unauthorized();
        Market storage market = _market(token);
        if (market.tokenDeck.totalShares != 0 || amount == 0) revert InvalidAmount();
        _safeTransferFrom(token, msg.sender, address(this), amount);
        uint256 devAmount = amount * RAMEN_DEV_BPS / BPS;
        _creditDeposit(token, Side.Token, IRamenRoles(launcher).ramenDev(), devAmount);
        _creditDeposit(token, Side.Token, IRamenRoles(launcher).owner(), amount - devAmount);
    }

    function depositToken(address token, uint256 amount, address beneficiary)
        external
        nonReentrant
        returns (uint256 shares)
    {
        _requireBeneficiary(beneficiary);
        _market(token);
        _safeTransferFrom(token, msg.sender, address(this), amount);
        shares = _creditDeposit(token, Side.Token, beneficiary, amount);
    }

    function depositRamen(address token, uint256 amount, address beneficiary)
        external
        nonReentrant
        returns (uint256 shares)
    {
        _requireBeneficiary(beneficiary);
        _market(token);
        _safeTransferFrom(ramen, msg.sender, address(this), amount);
        shares = _creditDeposit(token, Side.Ramen, beneficiary, amount);
    }

    /// @dev Called by the LP locker after every harvest. Assets never pass through protocol EOAs.
    function depositProtocolFees(address token, address asset, uint256 devAmount, uint256 ownerAmount)
        external
        nonReentrant
    {
        if (msg.sender != locker) revert Unauthorized();
        _market(token);
        uint256 total = devAmount + ownerAmount;
        if (total == 0) return;
        Side side;
        if (asset == token) side = Side.Token;
        else if (asset == ramen) side = Side.Ramen;
        else revert InvalidAddress();
        _safeTransferFrom(asset, msg.sender, address(this), total);
        if (devAmount != 0) _creditDeposit(token, side, IRamenRoles(launcher).ramenDev(), devAmount);
        if (ownerAmount != 0) _creditDeposit(token, side, IRamenRoles(launcher).owner(), ownerAmount);
    }

    function withdrawToken(address token, uint256 shares, address recipient)
        external
        nonReentrant
        returns (uint256 principal, uint256 ramenYield)
    {
        _requireBeneficiary(recipient);
        (principal, ramenYield) = _withdraw(token, Side.Token, msg.sender, shares);
        _safeTransfer(token, recipient, principal);
        _safeTransfer(ramen, recipient, ramenYield);
    }

    function withdrawRamen(address token, uint256 shares, address recipient)
        external
        nonReentrant
        returns (uint256 principal, uint256 tokenYield)
    {
        _requireBeneficiary(recipient);
        (principal, tokenYield) = _withdraw(token, Side.Ramen, msg.sender, shares);
        _safeTransfer(ramen, recipient, principal);
        _safeTransfer(token, recipient, tokenYield);
    }

    function claimTokenDeckYield(address token, address recipient) external nonReentrant returns (uint256 amount) {
        _requireBeneficiary(recipient);
        Market storage market = _market(token);
        Position storage position = positions[token][Side.Token][msg.sender];
        _settle(market.tokenDeck, position);
        amount = position.pendingYield;
        position.pendingYield = 0;
        market.tokenDeck.yieldBalance -= amount;
        _safeTransfer(ramen, recipient, amount);
    }

    function claimRamenDeckYield(address token, address recipient) external nonReentrant returns (uint256 amount) {
        _requireBeneficiary(recipient);
        Market storage market = _market(token);
        Position storage position = positions[token][Side.Ramen][msg.sender];
        _settle(market.ramenDeck, position);
        amount = position.pendingYield;
        position.pendingYield = 0;
        market.ramenDeck.yieldBalance -= amount;
        _safeTransfer(token, recipient, amount);
    }

    function buy(address token, uint256 ramenIn, uint256 minTokenOut, address recipient)
        external
        nonReentrant
        returns (uint256 tokenOut)
    {
        _requireBeneficiary(recipient);
        Market storage market = _market(token);
        if (ramenIn == 0) revert InvalidAmount();
        _safeTransferFrom(ramen, msg.sender, address(this), ramenIn);
        uint256 poolIn;
        uint256 otcIn;
        uint256 otcOut;
        (tokenOut, poolIn, otcIn, otcOut) = _route(token, ramen, token, market.tokenDeck, ramenIn);
        if (tokenOut < minTokenOut) revert InsufficientOutput();
        _safeTransfer(token, recipient, tokenOut);
        _churnProtocol(token);
        emit OtcSwap(token, msg.sender, recipient, true, ramenIn, tokenOut, poolIn, otcIn, otcOut);
    }

    function sell(address token, uint256 tokenIn, uint256 minRamenOut, address recipient)
        external
        nonReentrant
        returns (uint256 ramenOut)
    {
        _requireBeneficiary(recipient);
        Market storage market = _market(token);
        if (tokenIn == 0) revert InvalidAmount();
        _safeTransferFrom(token, msg.sender, address(this), tokenIn);
        uint256 poolIn;
        uint256 otcIn;
        uint256 otcOut;
        (ramenOut, poolIn, otcIn, otcOut) = _route(token, token, ramen, market.ramenDeck, tokenIn);
        if (ramenOut < minRamenOut) revert InsufficientOutput();
        _safeTransfer(ramen, recipient, ramenOut);
        _churnProtocol(token);
        emit OtcSwap(token, msg.sender, recipient, false, tokenIn, ramenOut, poolIn, otcIn, otcOut);
    }

    function churnProtocol(address token) external nonReentrant {
        _market(token);
        _churnProtocol(token);
    }

    function setOtcBps(uint16 newBps) external onlyOwner {
        if (newBps < MIN_OTC_BPS || newBps > MAX_OTC_BPS) revert InvalidBps();
        emit OtcBpsUpdated(otcBps, newBps);
        otcBps = newBps;
    }

    function marketInfo(address token)
        external
        view
        returns (
            address pool,
            uint256 positionTokenId,
            uint256 tokenInventory,
            uint256 tokenShares,
            uint256 ramenInventory,
            uint256 ramenShares
        )
    {
        Market storage market = markets[token];
        return (
            market.pool,
            market.positionTokenId,
            market.tokenDeck.inventory,
            market.tokenDeck.totalShares,
            market.ramenDeck.inventory,
            market.ramenDeck.totalShares
        );
    }

    function positionInfo(address token, Side side, address beneficiary)
        external
        view
        returns (uint256 shares, uint256 principal, uint256 pendingYield)
    {
        Market storage market = markets[token];
        Deck storage deck = side == Side.Token ? market.tokenDeck : market.ramenDeck;
        Position storage position = positions[token][side][beneficiary];
        shares = position.shares;
        principal = deck.totalShares == 0 ? 0 : shares * deck.inventory / deck.totalShares;
        uint256 accumulated = shares * deck.accYieldPerShare / ACC_PRECISION;
        pendingYield =
            position.pendingYield + (accumulated > position.rewardDebt ? accumulated - position.rewardDebt : 0);
    }

    function _route(address, address assetIn, address assetOut, Deck storage otcDeck, uint256 amountIn)
        private
        returns (uint256 amountOut, uint256 totalPoolIn, uint256 otcIn, uint256 otcOut)
    {
        uint256 targetOtcIn = amountIn * otcBps / BPS;
        uint256 firstPoolIn = amountIn - targetOtcIn;
        if (firstPoolIn == 0) revert InvalidAmount();
        uint256 firstPoolOut = _poolSwap(assetIn, assetOut, firstPoolIn);
        if (firstPoolOut == 0) revert InsufficientOutput();

        if (targetOtcIn != 0 && otcDeck.inventory > MIN_INVENTORY_RESERVE && otcDeck.totalShares != 0) {
            uint256 desiredOut = targetOtcIn * firstPoolOut / firstPoolIn;
            uint256 available = otcDeck.inventory - MIN_INVENTORY_RESERVE;
            otcOut = desiredOut < available ? desiredOut : available;
            if (otcOut != 0) {
                otcIn = _ceilDiv(otcOut * firstPoolIn, firstPoolOut);
                if (otcIn > targetOtcIn) otcIn = targetOtcIn;
                otcDeck.inventory -= otcOut;
                otcDeck.yieldBalance += otcIn;
                otcDeck.accYieldPerShare += otcIn * ACC_PRECISION / otcDeck.totalShares;
            }
        }

        uint256 fallbackPoolIn = targetOtcIn - otcIn;
        uint256 fallbackOut = fallbackPoolIn == 0 ? 0 : _poolSwap(assetIn, assetOut, fallbackPoolIn);
        totalPoolIn = firstPoolIn + fallbackPoolIn;
        amountOut = firstPoolOut + otcOut + fallbackOut;
    }

    function _poolSwap(address assetIn, address assetOut, uint256 amountIn) private returns (uint256 amountOut) {
        _forceApprove(assetIn, address(swapRouter), amountIn);
        amountOut = swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: assetIn,
                tokenOut: assetOut,
                fee: 10_000,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _creditDeposit(address token, Side side, address beneficiary, uint256 amount)
        private
        returns (uint256 shares)
    {
        if (amount == 0 || beneficiary == address(0)) revert InvalidAmount();
        Market storage market = markets[token];
        Deck storage deck = side == Side.Token ? market.tokenDeck : market.ramenDeck;
        Position storage position = positions[token][side][beneficiary];
        _settle(deck, position);
        shares = deck.totalShares == 0 ? amount : amount * deck.totalShares / deck.inventory;
        if (shares == 0) revert InvalidAmount();
        deck.inventory += amount;
        deck.totalShares += shares;
        position.shares += shares;
        position.rewardDebt = position.shares * deck.accYieldPerShare / ACC_PRECISION;
        emit Deposited(token, side, beneficiary, amount, shares);
    }

    function _withdraw(address token, Side side, address beneficiary, uint256 shares)
        private
        returns (uint256 principal, uint256 yieldAmount)
    {
        if (shares == 0) revert InvalidAmount();
        Market storage market = _market(token);
        Deck storage deck = side == Side.Token ? market.tokenDeck : market.ramenDeck;
        Position storage position = positions[token][side][beneficiary];
        if (shares > position.shares) revert InsufficientShares();
        _settle(deck, position);
        principal = shares * deck.inventory / deck.totalShares;
        position.shares -= shares;
        deck.totalShares -= shares;
        deck.inventory -= principal;
        yieldAmount = position.pendingYield;
        position.pendingYield = 0;
        deck.yieldBalance -= yieldAmount;
        position.rewardDebt = position.shares * deck.accYieldPerShare / ACC_PRECISION;
        emit Withdrawn(token, side, beneficiary, principal, yieldAmount);
    }

    function _settle(Deck storage deck, Position storage position) private {
        uint256 accumulated = position.shares * deck.accYieldPerShare / ACC_PRECISION;
        if (accumulated > position.rewardDebt) position.pendingYield += accumulated - position.rewardDebt;
        position.rewardDebt = accumulated;
    }

    function _churnProtocol(address token) private {
        _churnBeneficiary(token, IRamenRoles(launcher).ramenDev());
        address protocolOwner = IRamenRoles(launcher).owner();
        if (protocolOwner != IRamenRoles(launcher).ramenDev()) _churnBeneficiary(token, protocolOwner);
    }

    function _churnBeneficiary(address token, address beneficiary) private {
        Market storage market = markets[token];
        Position storage tokenPosition = positions[token][Side.Token][beneficiary];
        Position storage ramenPosition = positions[token][Side.Ramen][beneficiary];
        _settle(market.tokenDeck, tokenPosition);
        _settle(market.ramenDeck, ramenPosition);
        uint256 ramenAmount = tokenPosition.pendingYield;
        uint256 tokenAmount = ramenPosition.pendingYield;
        if (ramenAmount != 0) {
            tokenPosition.pendingYield = 0;
            market.tokenDeck.yieldBalance -= ramenAmount;
            _creditDeposit(token, Side.Ramen, beneficiary, ramenAmount);
        }
        if (tokenAmount != 0) {
            ramenPosition.pendingYield = 0;
            market.ramenDeck.yieldBalance -= tokenAmount;
            _creditDeposit(token, Side.Token, beneficiary, tokenAmount);
        }
        if (ramenAmount != 0 || tokenAmount != 0) emit ProtocolChurned(token, beneficiary, ramenAmount, tokenAmount);
    }

    function _market(address token) private view returns (Market storage market) {
        market = markets[token];
        if (!market.registered) revert UnknownMarket();
    }

    function _requireBeneficiary(address beneficiary) private pure {
        if (beneficiary == address(0)) revert InvalidAddress();
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        if (amount == 0) revert InvalidAmount();
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
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

    function _ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator == 0 ? 0 : (numerator - 1) / denominator + 1;
    }
}
