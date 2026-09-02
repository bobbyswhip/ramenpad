// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../src/interfaces/IERC20.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";
import {RamenToken} from "../src/RamenToken.sol";
import {RamenLauncher} from "../src/RamenLauncher.sol";
import {RamenLiquidityLocker} from "../src/RamenLiquidityLocker.sol";
import {RamenOTC} from "../src/RamenOTC.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract MockPositionManager is INonfungiblePositionManager {
    uint256 public nextTokenId = 1;
    address public immutable pool;
    uint160 public poolPrice;
    mapping(uint256 => MintParams) private minted;
    mapping(uint256 => uint256) public fee0;
    mapping(uint256 => uint256) public fee1;

    constructor() {
        pool = address(this);
    }

    function createAndInitializePoolIfNecessary(address, address, uint24, uint160 sqrtPriceX96)
        external
        payable
        returns (address)
    {
        if (poolPrice == 0) poolPrice = sqrtPriceX96;
        return pool;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (poolPrice, 0, 0, 0, 0, 0, true);
    }

    function preInitializePool(uint160 sqrtPriceX96) external {
        poolPrice = sqrtPriceX96;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        tokenId = nextTokenId++;
        minted[tokenId] = params;
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        if (amount0 != 0) IERC20(params.token0).transferFrom(msg.sender, address(this), amount0);
        if (amount1 != 0) IERC20(params.token1).transferFrom(msg.sender, address(this), amount1);
        IERC721Receiver(params.recipient).onERC721Received(msg.sender, address(0), tokenId, "");
        liquidity = 1;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1) {
        MintParams storage position = minted[params.tokenId];
        amount0 = fee0[params.tokenId];
        amount1 = fee1[params.tokenId];
        fee0[params.tokenId] = 0;
        fee1[params.tokenId] = 0;
        if (amount0 != 0) IERC20(position.token0).transfer(params.recipient, amount0);
        if (amount1 != 0) IERC20(position.token1).transfer(params.recipient, amount1);
    }

    function setFees(uint256 tokenId, uint256 amount0, uint256 amount1) external {
        fee0[tokenId] = amount0;
        fee1[tokenId] = amount1;
    }

    function sendToken(address token, address to, uint256 amount) external {
        IERC20(token).transfer(to, amount);
    }

    function mockPosition(address token0, address token1, address recipient) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        MintParams storage position = minted[tokenId];
        position.token0 = token0;
        position.token1 = token1;
        position.recipient = recipient;
        IERC721Receiver(recipient).onERC721Received(msg.sender, address(0), tokenId, "");
    }

    function recipientOf(uint256 tokenId) external view returns (address) {
        return minted[tokenId].recipient;
    }
}

contract MockSwapRouter is ISwapRouter02 {
    MockPositionManager public immutable manager;

    constructor(address manager_) {
        manager = MockPositionManager(manager_);
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        amountOut = params.amountIn;
        if (IERC20(params.tokenOut).balanceOf(address(this)) < amountOut) {
            manager.sendToken(params.tokenOut, address(this), amountOut);
        }
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}

contract MockV2Router {
    function swapExactETHForTokens(uint256, address[] calldata, address, uint256)
        external
        payable
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](2);
    }
}

contract FailingOtc {
    function depositProtocolFees(address, address, uint256, uint256) external pure {
        revert("temporarily unavailable");
    }
}

contract RamenPadTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant SIGNER_KEY = 0xB0B;
    address private constant CREATOR = address(0xCAFE);
    address private constant OWNER = address(0xA11CE);
    address private constant DEV = address(0xD3A);

    MockPositionManager private manager;
    MockSwapRouter private swapRouter;
    RamenToken private ramen;
    RamenLauncher private launcher;
    RamenLiquidityLocker private locker;
    RamenOTC private otc;

    function setUp() external {
        manager = new MockPositionManager();
        swapRouter = new MockSwapRouter(address(manager));
        ramen = new RamenToken("RAMEN", "RAMEN", address(this));
        otc = new RamenOTC(address(ramen), address(swapRouter));
        locker = new RamenLiquidityLocker(address(manager), address(otc));
        launcher = new RamenLauncher(
            address(manager),
            address(new MockV2Router()),
            address(ramen),
            address(0x1234),
            address(locker),
            address(otc),
            vm.addr(SIGNER_KEY),
            OWNER,
            DEV
        );
        otc.initialize(address(launcher), address(locker));
        locker.initialize(address(launcher));
    }

    function testLaunchCreatesNinetyTenAllocationAndLocksPosition() external {
        (RamenLauncher.PriceQuote memory quote, bytes memory signature, address predicted) = _quote(SIGNER_KEY);
        vm.prank(CREATOR);
        (address token, address pool, uint256 tokenId) =
            launcher.launch("Spicy Miso", "MISO", "ipfs://logo", quote, signature);

        _assertEq(token, predicted, "predicted token");
        _assertEq(pool, manager.pool(), "pool");
        _assertEq(RamenToken(token).totalSupply(), 6_942_000 ether, "fixed supply");
        _assertEq(IERC20(token).balanceOf(address(manager)), 6_247_800 ether, "90% LP");
        (,, uint256 tokenInventory,,, uint256 ramenShares) = otc.marketInfo(token);
        _assertEq(tokenInventory, 694_200 ether, "10% OTC");
        _assertEq(ramenShares, 0, "RAMEN deck starts empty");
        (uint256 devShares,,) = otc.positionInfo(token, RamenOTC.Side.Token, DEV);
        (uint256 ownerShares,,) = otc.positionInfo(token, RamenOTC.Side.Token, OWNER);
        _assertEq(devShares, 694_200 ether * 69 / 100, "dev initial shares");
        _assertEq(ownerShares, 694_200 ether * 31 / 100, "owner initial shares");
        _assertEq(manager.recipientOf(tokenId), address(locker), "LP recipient");
        (address founder, address lockedToken, address lockedPool,,, bool registered) = locker.positions(tokenId);
        _assertEq(founder, CREATOR, "founder");
        _assertEq(lockedToken, token, "locked token");
        _assertEq(lockedPool, pool, "locked pool");
        _assertTrue(registered, "registered");
    }

    function testRoutedBuyUsesTwentyPercentOtcAndAutoChurnsProtocolYield() external {
        (address token,,) = _launch();
        manager.sendToken(token, address(swapRouter), 1_000 ether);
        ramen.transfer(CREATOR, 100 ether);
        vm.prank(CREATOR);
        IERC20(address(ramen)).approve(address(otc), 100 ether);
        vm.prank(CREATOR);
        uint256 amountOut = otc.buy(token, 100 ether, 100 ether, CREATOR);

        _assertEq(amountOut, 100 ether, "realized rate");
        _assertEq(IERC20(token).balanceOf(CREATOR), 100 ether, "buyer output");
        (,, uint256 tokenInventory,,, uint256 ramenShares) = otc.marketInfo(token);
        _assertEq(tokenInventory, 694_180 ether, "20% OTC inventory used");
        _assertTrue(ramenShares >= 20 ether - 2, "OTC RAMEN yield auto-churned");
        (uint256 devRamenShares,,) = otc.positionInfo(token, RamenOTC.Side.Ramen, DEV);
        (uint256 ownerRamenShares,,) = otc.positionInfo(token, RamenOTC.Side.Ramen, OWNER);
        _assertTrue(devRamenShares > ownerRamenShares, "69% dev OTC earnings churned");
        _assertTrue(devRamenShares + ownerRamenShares >= 20 ether - 2, "all protocol OTC earnings churned");
    }

    function testInsufficientOtcInventoryFallsBackToPool() external {
        (address token,,) = _launch();
        manager.sendToken(token, address(swapRouter), 4_000_000 ether);
        ramen.transfer(CREATOR, 4_000_000 ether);
        vm.prank(CREATOR);
        IERC20(address(ramen)).approve(address(otc), 4_000_000 ether);
        vm.prank(CREATOR);
        uint256 amountOut = otc.buy(token, 4_000_000 ether, 4_000_000 ether, CREATOR);
        _assertEq(amountOut, 4_000_000 ether, "shortfall routed to pool");
        (,, uint256 tokenInventory,,,) = otc.marketInfo(token);
        _assertEq(tokenInventory, 1 ether, "one-token recapitalization reserve remains");
    }

    function testRoutedSellUsesRamenDeckAndChurnsTokenYield() external {
        (address token,,) = _launch();
        ramen.transfer(CREATOR, 100 ether);
        vm.prank(CREATOR);
        IERC20(address(ramen)).approve(address(otc), 100 ether);
        vm.prank(CREATOR);
        otc.buy(token, 100 ether, 100 ether, CREATOR);

        vm.prank(CREATOR);
        IERC20(token).approve(address(otc), 50 ether);
        vm.prank(CREATOR);
        uint256 ramenOut = otc.sell(token, 50 ether, 50 ether, CREATOR);
        _assertEq(ramenOut, 50 ether, "sell output");
        _assertEq(IERC20(address(ramen)).balanceOf(CREATOR), 50 ether, "seller received RAMEN");
        (,, uint256 tokenInventory,, uint256 ramenInventory,) = otc.marketInfo(token);
        _assertTrue(tokenInventory >= 694_190 ether - 2, "TOKEN yield churned back to token deck");
        _assertTrue(ramenInventory <= 10 ether, "RAMEN deck principal filled sell");
    }

    function testHarvestAccruesLauncherAndDepositsProtocolIntoBothDecks() external {
        (address token, uint256 tokenId,) = _launch();
        (,,, address token0, address token1,) = locker.positions(tokenId);
        uint256 amount0 = 100 ether;
        uint256 amount1 = 50 ether;
        ramen.transfer(address(manager), 100 ether);
        manager.setFees(tokenId, amount0, amount1);

        locker.harvest(tokenId);
        _assertEq(locker.claimable(tokenId, token0), amount0 * 69 / 100, "creator token0 accrual");
        _assertEq(locker.claimable(tokenId, token1), amount1 * 69 / 100, "creator token1 accrual");
        uint256 tokenFee = token0 == token ? amount0 : amount1;
        uint256 ramenFee = token0 == address(ramen) ? amount0 : amount1;
        (uint256 devTokenShares,,) = otc.positionInfo(token, RamenOTC.Side.Token, DEV);
        (uint256 ownerTokenShares,,) = otc.positionInfo(token, RamenOTC.Side.Token, OWNER);
        (uint256 devRamenShares,,) = otc.positionInfo(token, RamenOTC.Side.Ramen, DEV);
        (uint256 ownerRamenShares,,) = otc.positionInfo(token, RamenOTC.Side.Ramen, OWNER);
        _assertEq(devTokenShares, 694_200 ether * 69 / 100 + tokenFee * 1_550 / 10_000, "dev TOKEN fee deck");
        _assertEq(ownerTokenShares, 694_200 ether * 31 / 100 + tokenFee * 1_550 / 10_000, "owner TOKEN fee deck");
        _assertEq(devRamenShares, ramenFee * 1_550 / 10_000, "dev RAMEN fee deck");
        _assertEq(ownerRamenShares, ramenFee * 1_550 / 10_000, "owner RAMEN fee deck");
        _assertEq(IERC20(token).balanceOf(OWNER), 0, "owner receives no loose token");
        _assertEq(IERC20(address(ramen)).balanceOf(OWNER), 0, "owner receives no loose RAMEN");

        uint256 creatorTokenBefore = IERC20(token).balanceOf(CREATOR);
        uint256 creatorRamenBefore = IERC20(address(ramen)).balanceOf(CREATOR);
        vm.prank(CREATOR);
        locker.claimFees(tokenId);
        uint256 expectedToken = (token0 == token ? amount0 : amount1) * 69 / 100;
        uint256 expectedRamen = (token0 == address(ramen) ? amount0 : amount1) * 69 / 100;
        _assertEq(IERC20(token).balanceOf(CREATOR) - creatorTokenBefore, expectedToken, "launcher token claim");
        _assertEq(IERC20(address(ramen)).balanceOf(CREATOR) - creatorRamenBefore, expectedRamen, "launcher RAMEN claim");
    }

    function testOwnerCanSetOtcBetweenOneAndThirtyPercent() external {
        vm.prank(OWNER);
        otc.setOtcBps(100);
        _assertEq(otc.otcBps(), 100, "one percent");
        vm.prank(OWNER);
        otc.setOtcBps(3_000);
        _assertEq(otc.otcBps(), 3_000, "thirty percent");
        vm.expectRevert(RamenOTC.InvalidBps.selector);
        vm.prank(OWNER);
        otc.setOtcBps(3_001);
    }

    function testLauncherCanAtomicallyBuyWithRamenAfterSetup() external {
        (RamenLauncher.PriceQuote memory quote, bytes memory signature,) = _quote(SIGNER_KEY);
        ramen.transfer(CREATOR, 100 ether);
        vm.prank(CREATOR);
        IERC20(address(ramen)).approve(address(launcher), 100 ether);
        vm.prank(CREATOR);
        (address token,,, uint256 tokenOut) =
            launcher.launchAndBuyWithRamen("Spicy Miso", "MISO", "", quote, signature, 100 ether, 100 ether);
        _assertEq(tokenOut, 100 ether, "atomic output");
        _assertEq(IERC20(token).balanceOf(CREATOR), 100 ether, "launcher got first buy");
    }

    function testRejectsQuoteFromWrongSigner() external {
        (RamenLauncher.PriceQuote memory quote, bytes memory signature,) = _quote(0xBAD);
        vm.expectRevert(RamenLauncher.InvalidSignature.selector);
        vm.prank(CREATOR);
        launcher.launch("Spicy Miso", "MISO", "", quote, signature);
    }

    function testRejectsPoolPreInitializedAtWrongPrice() external {
        (RamenLauncher.PriceQuote memory quote, bytes memory signature,) = _quote(SIGNER_KEY);
        manager.preInitializePool(quote.sqrtPriceX96 + 1);
        vm.expectRevert(RamenLauncher.InvalidQuote.selector);
        vm.prank(CREATOR);
        launcher.launch("Spicy Miso", "MISO", "", quote, signature);
    }

    function testOnlyLauncherCanClaimAccruedFees() external {
        (, uint256 tokenId,) = _launch();
        vm.expectRevert(RamenLiquidityLocker.Unauthorized.selector);
        locker.claimFees(tokenId);
    }

    function testDeferredProtocolDepositCannotBlockLauncherClaim() external {
        FailingOtc failingOtc = new FailingOtc();
        RamenLiquidityLocker resilientLocker = new RamenLiquidityLocker(address(manager), address(failingOtc));
        resilientLocker.initialize(address(this));
        RamenToken feeToken = new RamenToken("Fee", "FEE", address(this));
        uint256 tokenId = manager.mockPosition(address(feeToken), address(ramen), address(resilientLocker));
        resilientLocker.registerPosition(
            tokenId, CREATOR, address(feeToken), address(0xBEEF), address(feeToken), address(ramen)
        );
        feeToken.transfer(address(manager), 100 ether);
        ramen.transfer(address(manager), 100 ether);
        manager.setFees(tokenId, 100 ether, 100 ether);

        vm.prank(CREATOR);
        resilientLocker.claimFees(tokenId);
        _assertEq(feeToken.balanceOf(CREATOR), 69 ether, "launcher token claim survives OTC failure");
        _assertEq(ramen.balanceOf(CREATOR), 69 ether, "launcher RAMEN claim survives OTC failure");
        _assertEq(resilientLocker.pendingDevProtocol(tokenId, address(feeToken)), 15.5 ether, "dev protocol deferred");
        _assertEq(
            resilientLocker.pendingOwnerProtocol(tokenId, address(feeToken)), 15.5 ether, "owner protocol deferred"
        );
    }

    function _launch() private returns (address token, uint256 tokenId, address pool) {
        (RamenLauncher.PriceQuote memory quote, bytes memory signature,) = _quote(SIGNER_KEY);
        vm.prank(CREATOR);
        (token, pool, tokenId) = launcher.launch("Spicy Miso", "MISO", "", quote, signature);
    }

    function _quote(uint256 key)
        private
        returns (RamenLauncher.PriceQuote memory quote, bytes memory signature, address predicted)
    {
        bytes32 salt;
        (predicted, salt,) = launcher.predictNextTokenAddress(CREATOR, "Spicy Miso", "MISO");
        quote = RamenLauncher.PriceQuote({
            sqrtPriceX96: uint160(1 << 96), tickLower: -200, tickUpper: 200, deadline: block.timestamp + 10 minutes
        });
        bytes32 digest = launcher.launchQuoteDigest(CREATOR, predicted, salt, quote);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _assertEq(address left, address right, string memory reason) private pure {
        require(left == right, reason);
    }

    function _assertEq(uint256 left, uint256 right, string memory reason) private pure {
        require(left == right, reason);
    }

    function _assertTrue(bool value, string memory reason) private pure {
        require(value, reason);
    }
}
