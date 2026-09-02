// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";
import {RamenToken} from "./RamenToken.sol";
import {RamenLiquidityLocker} from "./RamenLiquidityLocker.sol";
import {RamenOTC} from "./RamenOTC.sol";

interface IUniswapV3PoolState {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @notice One-transaction fixed-terms RamenPad token + Uniswap v3 launch.
contract RamenLauncher {
    uint256 public constant TOTAL_SUPPLY = 6_942_000 ether;
    uint256 public constant TARGET_MARKET_CAP_USD = 6_942;
    uint16 public constant LP_BPS = 9_000;
    uint16 public constant INITIAL_OTC_BPS = 1_000;
    uint24 public constant POOL_FEE = 10_000;
    int24 public constant TICK_SPACING = 200;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint16 private constant BPS = 10_000;

    struct PriceQuote {
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint256 deadline;
    }

    struct LaunchRecord {
        address token;
        address pool;
        address launcher;
        uint256 positionTokenId;
        uint64 launchedAt;
    }

    INonfungiblePositionManager public immutable positionManager;
    IUniswapV2Router02 public immutable v2Router;
    address public immutable ramen;
    address public immutable weth;
    RamenLiquidityLocker public immutable locker;
    RamenOTC public immutable otc;
    address public owner;
    address public pendingOwner;
    address public ramenDev;
    address public quoteSigner;
    uint256 public launchCount;
    bool private entered;

    mapping(address => uint256) public launcherNonces;
    mapping(address => LaunchRecord) public launches;
    address[] public allTokens;

    event TokenLaunched(
        uint256 indexed launchId,
        address indexed token,
        address indexed launcher,
        address pool,
        uint256 positionTokenId,
        string name,
        string symbol,
        string imageUrl,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper
    );
    event AtomicFirstBuy(address indexed token, address indexed launcher, uint256 ramenIn, uint256 tokenOut);
    event QuoteSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event RamenDevUpdated(address indexed previousDev, address indexed newDev);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error Unauthorized();
    error InvalidAddress();
    error InvalidMetadata();
    error QuoteExpired();
    error InvalidQuote();
    error InvalidSignature();
    error TransferFailed();
    error Reentrancy();
    error InvalidAmount();

    constructor(
        address positionManager_,
        address v2Router_,
        address ramen_,
        address weth_,
        address locker_,
        address otc_,
        address quoteSigner_,
        address owner_,
        address ramenDev_
    ) {
        if (
            positionManager_ == address(0) || v2Router_ == address(0) || ramen_ == address(0) || weth_ == address(0)
                || locker_ == address(0) || otc_ == address(0) || quoteSigner_ == address(0) || owner_ == address(0)
                || ramenDev_ == address(0)
        ) revert InvalidAddress();
        positionManager = INonfungiblePositionManager(positionManager_);
        v2Router = IUniswapV2Router02(v2Router_);
        ramen = ramen_;
        weth = weth_;
        locker = RamenLiquidityLocker(locker_);
        otc = RamenOTC(otc_);
        quoteSigner = quoteSigner_;
        owner = owner_;
        ramenDev = ramenDev_;
        emit QuoteSignerUpdated(address(0), quoteSigner_);
        emit RamenDevUpdated(address(0), ramenDev_);
        emit OwnershipTransferred(address(0), owner_);
    }

    function launch(
        string calldata name,
        string calldata symbol,
        string calldata imageUrl,
        PriceQuote calldata quote,
        bytes calldata signature
    ) external nonReentrant returns (address token, address pool, uint256 positionTokenId) {
        return _launch(msg.sender, name, symbol, imageUrl, quote, signature);
    }

    /// @notice Launches and buys in the newly initialized market in one transaction using native ETH.
    function launchAndBuy(
        string calldata name,
        string calldata symbol,
        string calldata imageUrl,
        PriceQuote calldata quote,
        bytes calldata signature,
        uint256 minRamenOut,
        uint256 minTokenOut
    ) external payable nonReentrant returns (address token, address pool, uint256 positionTokenId, uint256 tokenOut) {
        if (msg.value == 0) revert InvalidAmount();
        (token, pool, positionTokenId) = _launch(msg.sender, name, symbol, imageUrl, quote, signature);
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = ramen;
        uint256 ramenBefore = IERC20(ramen).balanceOf(address(this));
        v2Router.swapExactETHForTokens{value: msg.value}(minRamenOut, path, address(this), quote.deadline);
        uint256 ramenIn = IERC20(ramen).balanceOf(address(this)) - ramenBefore;
        if (ramenIn == 0) revert InvalidAmount();
        _forceApprove(ramen, address(otc), ramenIn);
        tokenOut = otc.buy(token, ramenIn, minTokenOut, msg.sender);
        emit AtomicFirstBuy(token, msg.sender, ramenIn, tokenOut);
    }

    /// @notice RAMEN form of the atomic launch+buy. The launcher must have prior RAMEN allowance.
    function launchAndBuyWithRamen(
        string calldata name,
        string calldata symbol,
        string calldata imageUrl,
        PriceQuote calldata quote,
        bytes calldata signature,
        uint256 ramenIn,
        uint256 minTokenOut
    ) external nonReentrant returns (address token, address pool, uint256 positionTokenId, uint256 tokenOut) {
        if (ramenIn == 0) revert InvalidAmount();
        (token, pool, positionTokenId) = _launch(msg.sender, name, symbol, imageUrl, quote, signature);
        _safeTransferFrom(ramen, msg.sender, address(this), ramenIn);
        _forceApprove(ramen, address(otc), ramenIn);
        tokenOut = otc.buy(token, ramenIn, minTokenOut, msg.sender);
        emit AtomicFirstBuy(token, msg.sender, ramenIn, tokenOut);
    }

    function _launch(
        address creator,
        string calldata name,
        string calldata symbol,
        string calldata imageUrl,
        PriceQuote calldata quote,
        bytes calldata signature
    ) private returns (address token, address pool, uint256 positionTokenId) {
        if (
            bytes(name).length == 0 || bytes(name).length > 32 || bytes(symbol).length == 0 || bytes(symbol).length > 10
        ) revert InvalidMetadata();
        if (quote.deadline < block.timestamp) revert QuoteExpired();
        if (quote.sqrtPriceX96 == 0 || quote.tickLower >= quote.tickUpper) revert InvalidQuote();

        uint256 nonce = launcherNonces[creator];
        bytes32 salt = computeLaunchSalt(creator, nonce, name, symbol);
        token = predictTokenAddress(salt, name, symbol);
        bytes32 digest = launchQuoteDigest(creator, token, salt, quote);
        if (_recover(digest, signature) != quoteSigner) revert InvalidSignature();

        launcherNonces[creator] = nonce + 1;
        token = address(new RamenToken{salt: salt}(name, symbol, address(this)));
        (pool, positionTokenId) = _createMarket(token, creator, quote);
        _recordLaunch(token, pool, positionTokenId, creator, name, symbol, imageUrl, quote);
    }

    function _createMarket(address token, address creator, PriceQuote calldata quote)
        private
        returns (address pool, uint256 positionTokenId)
    {
        (address token0, address token1) = token < ramen ? (token, ramen) : (ramen, token);
        pool = positionManager.createAndInitializePoolIfNecessary(token0, token1, POOL_FEE, quote.sqrtPriceX96);
        // The CREATE2 token address is knowable before launch. Reject a pool an attacker pre-initialized
        // at any price other than the backend-signed $6,942 launch quote.
        (uint160 actualSqrtPriceX96,,,,,,) = IUniswapV3PoolState(pool).slot0();
        if (actualSqrtPriceX96 != quote.sqrtPriceX96) revert InvalidQuote();

        uint256 lpAllocation = TOTAL_SUPPLY * LP_BPS / BPS;
        uint256 otcAllocation = TOTAL_SUPPLY - lpAllocation;
        _forceApprove(token, address(positionManager), lpAllocation);
        uint256 amount0;
        uint256 amount1;
        uint128 liquidity;
        (positionTokenId, liquidity, amount0, amount1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: POOL_FEE,
                tickLower: quote.tickLower,
                tickUpper: quote.tickUpper,
                amount0Desired: token0 == token ? lpAllocation : 0,
                amount1Desired: token1 == token ? lpAllocation : 0,
                amount0Min: 0,
                amount1Min: 0,
                recipient: address(locker),
                deadline: quote.deadline
            })
        );
        if (liquidity == 0) revert InvalidQuote();

        uint256 used = token0 == token ? amount0 : amount1;
        if (used < lpAllocation) _safeTransfer(token, BURN_ADDRESS, lpAllocation - used);
        locker.registerPosition(positionTokenId, creator, token, pool, token0, token1);
        otc.registerMarket(token, pool, positionTokenId);
        _forceApprove(token, address(otc), otcAllocation);
        otc.seedTokenDeck(token, otcAllocation);
    }

    function _recordLaunch(
        address token,
        address pool,
        uint256 positionTokenId,
        address creator,
        string calldata name,
        string calldata symbol,
        string calldata imageUrl,
        PriceQuote calldata quote
    ) private {
        uint256 launchId = launchCount++;
        launches[token] = LaunchRecord(token, pool, creator, positionTokenId, uint64(block.timestamp));
        allTokens.push(token);
        emit TokenLaunched(
            launchId,
            token,
            creator,
            pool,
            positionTokenId,
            name,
            symbol,
            imageUrl,
            quote.sqrtPriceX96,
            quote.tickLower,
            quote.tickUpper
        );
    }

    function predictNextTokenAddress(address creator, string calldata name, string calldata symbol)
        external
        view
        returns (address token, bytes32 salt, uint256 nonce)
    {
        nonce = launcherNonces[creator];
        salt = computeLaunchSalt(creator, nonce, name, symbol);
        token = predictTokenAddress(salt, name, symbol);
    }

    function computeLaunchSalt(address creator, uint256 nonce, string memory name, string memory symbol)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(creator, nonce, keccak256(bytes(name)), keccak256(bytes(symbol))));
    }

    function predictTokenAddress(bytes32 salt, string memory name, string memory symbol) public view returns (address) {
        bytes memory initCode = abi.encodePacked(type(RamenToken).creationCode, abi.encode(name, symbol, address(this)));
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(initCode)));
        return address(uint160(uint256(hash)));
    }

    function launchQuoteDigest(address creator, address token, bytes32 salt, PriceQuote memory quote)
        public
        view
        returns (bytes32)
    {
        bytes32 quoteHash = keccak256(
            abi.encode(
                block.chainid,
                address(this),
                creator,
                token,
                salt,
                ramen,
                TARGET_MARKET_CAP_USD,
                quote.sqrtPriceX96,
                quote.tickLower,
                quote.tickUpper,
                quote.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", quoteHash));
    }

    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    function setQuoteSigner(address newSigner) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newSigner == address(0)) revert InvalidAddress();
        emit QuoteSignerUpdated(quoteSigner, newSigner);
        quoteSigner = newSigner;
    }

    function setRamenDev(address newDev) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newDev == address(0)) revert InvalidAddress();
        emit RamenDevUpdated(ramenDev, newDev);
        ramenDev = newDev;
    }

    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert Unauthorized();
        if (newOwner == address(0)) revert InvalidAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert Unauthorized();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, msg.sender);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
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

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(s) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0) {
            revert InvalidSignature();
        }
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }
}
