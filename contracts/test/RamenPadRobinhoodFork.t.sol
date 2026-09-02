// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RamenLauncher} from "../src/RamenLauncher.sol";
import {RamenToken} from "../src/RamenToken.sol";
import {RamenLiquidityLocker} from "../src/RamenLiquidityLocker.sol";
import {RamenOTC} from "../src/RamenOTC.sol";
import {RamenEthRouter} from "../src/RamenEthRouter.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

interface ForkVm {
    function envOr(string calldata name, bool defaultValue) external returns (bool);
    function envOr(string calldata name, string calldata defaultValue) external returns (string memory);
    function createSelectFork(string calldata urlOrAlias) external returns (uint256);
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function prank(address sender) external;
    function deal(address account, uint256 newBalance) external;
}

interface IRamenTaxView {
    function pools(address pool) external view returns (bool);
}

contract RamenPadRobinhoodForkTest {
    ForkVm private constant vm = ForkVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address private constant SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address private constant V2_ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address private constant RAMEN = 0xe013e34F03F42d49E836d59CF6353B897c337777;
    uint256 private constant SIGNER_KEY = 0xB0B;
    address private constant CREATOR = address(0xCAFE);
    address private constant BUYER = address(0xB0A1);

    /// @dev Opt-in because it uses a live RPC: RUN_FORK_TESTS=true forge test --match-contract RamenPadRobinhoodForkTest -vvv
    function testRealRobinhoodV3PositionManagerLaunch() external {
        if (!vm.envOr("RUN_FORK_TESTS", false)) return;
        string memory rpc = vm.envOr("ROBINHOOD_RPC_URL", string("https://rpc.mainnet.chain.robinhood.com"));
        vm.createSelectFork(rpc);

        address signer = vm.addr(SIGNER_KEY);
        RamenOTC otc = new RamenOTC(RAMEN, SWAP_ROUTER);
        RamenLiquidityLocker locker = new RamenLiquidityLocker(POSITION_MANAGER, address(otc));
        RamenLauncher launcher = new RamenLauncher(
            POSITION_MANAGER,
            V2_ROUTER,
            RAMEN,
            WETH,
            address(locker),
            address(otc),
            signer,
            address(this),
            address(this)
        );
        otc.initialize(address(launcher), address(locker));
        locker.initialize(address(launcher));
        (address predicted, bytes32 salt,) = launcher.predictNextTokenAddress(CREATOR, "Fork Bowl", "FORK");

        bool tokenIsToken0 = predicted < RAMEN;
        RamenLauncher.PriceQuote memory quote = tokenIsToken0
            ? RamenLauncher.PriceQuote({
                sqrtPriceX96: 354319114228591420592203432321,
                tickLower: 30_000,
                tickUpper: 887_200,
                deadline: block.timestamp + 10 minutes
            })
            : RamenLauncher.PriceQuote({
                sqrtPriceX96: 17715955711429571029610171616,
                tickLower: -887_200,
                tickUpper: -30_000,
                deadline: block.timestamp + 10 minutes
            });
        bytes32 digest = launcher.launchQuoteDigest(CREATOR, predicted, salt, quote);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, digest);

        vm.deal(CREATOR, 0.001 ether);
        vm.prank(CREATOR);
        (address token, address pool, uint256 positionTokenId, uint256 bought) =
            launcher.launchAndBuy{value: 0.001 ether}("Fork Bowl", "FORK", "", quote, abi.encodePacked(r, s, v), 0, 0);

        require(token == predicted, "token prediction mismatch");
        require(pool.code.length != 0, "real v3 pool not created");
        require(!IRamenTaxView(RAMEN).pools(pool), "new v3 pool is unexpectedly RAMEN-taxed");
        require(positionTokenId != 0, "position not minted");
        require(RamenToken(token).balanceOf(address(launcher)) == 0, "launcher retained token supply");
        (,, uint256 tokenInventory,,, uint256 ramenShares) = otc.marketInfo(token);
        require(tokenInventory < 694_200 ether, "OTC was not used by atomic buy");
        require(ramenShares != 0, "protocol OTC yield was not auto-churned");
        (,,,,, bool registered) = launcher.locker().positions(positionTokenId);
        require(registered, "position not registered in locker");
        require(bought != 0, "real v3 + OTC routed buy failed");
        require(IERC20(token).balanceOf(CREATOR) == bought, "routed output not delivered");

        RamenEthRouter ethRouter = new RamenEthRouter(V2_ROUTER, WETH, RAMEN, address(otc));
        vm.deal(BUYER, 0.001 ether);
        vm.prank(BUYER);
        (, uint256 ethBuyOut) = ethRouter.buyWithEth{value: 0.001 ether}(token, 0, BUYER, block.timestamp + 10 minutes);
        require(ethBuyOut != 0, "ETH -> RAMEN -> token buy failed");
        require(IERC20(token).balanceOf(BUYER) == ethBuyOut, "ETH buyer output not delivered");

        locker.harvest(positionTokenId);
        uint256 accruedRamen = locker.claimable(positionTokenId, RAMEN);
        require(accruedRamen != 0, "real v3 fees did not accrue to launcher");
        uint256 ramenBeforeClaim = IERC20(RAMEN).balanceOf(CREATOR);
        vm.prank(CREATOR);
        locker.claimFees(positionTokenId);
        require(IERC20(RAMEN).balanceOf(CREATOR) > ramenBeforeClaim, "launcher fee claim failed");
    }
}
