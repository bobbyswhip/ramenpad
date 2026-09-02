// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RamenLauncher} from "../src/RamenLauncher.sol";
import {RamenLiquidityLocker} from "../src/RamenLiquidityLocker.sol";
import {RamenOTC} from "../src/RamenOTC.sol";

interface Vm {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployRamenPad {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ROBINHOOD_V3_POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;
    address private constant ROBINHOOD_V3_SWAP_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address private constant ROBINHOOD_V2_ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address private constant RAMEN = 0xe013e34F03F42d49E836d59CF6353B897c337777;

    function run() external returns (RamenLauncher launcher) {
        uint256 deployerKey = vm.envUint("RAMENPAD_DEPLOYER_PRIVATE_KEY");
        address owner = vm.envAddress("RAMENPAD_OWNER_ADDRESS");
        address ramenDev = vm.envAddress("RAMENPAD_DEV_ADDRESS");
        address quoteSigner = vm.envAddress("RAMENPAD_QUOTE_SIGNER_ADDRESS");
        vm.startBroadcast(deployerKey);
        RamenOTC otc = new RamenOTC(RAMEN, ROBINHOOD_V3_SWAP_ROUTER);
        RamenLiquidityLocker locker = new RamenLiquidityLocker(ROBINHOOD_V3_POSITION_MANAGER, address(otc));
        launcher = new RamenLauncher(
            ROBINHOOD_V3_POSITION_MANAGER,
            ROBINHOOD_V2_ROUTER,
            RAMEN,
            WETH,
            address(locker),
            address(otc),
            quoteSigner,
            owner,
            ramenDev
        );
        otc.initialize(address(launcher), address(locker));
        locker.initialize(address(launcher));
        vm.stopBroadcast();
    }
}
