// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {RamenEthRouter} from "../src/RamenEthRouter.sol";

interface EthRouterVm {
    function envUint(string calldata name) external view returns (uint256);
    function envAddress(string calldata name) external view returns (address);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

contract DeployRamenEthRouter {
    EthRouterVm private constant vm = EthRouterVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant V2_ROUTER = 0x89e5DB8B5aA49aA85AC63f691524311AEB649eba;
    address private constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address private constant RAMEN = 0xe013e34F03F42d49E836d59CF6353B897c337777;

    function run() external returns (RamenEthRouter router) {
        uint256 deployerKey = vm.envUint("RAMENPAD_DEPLOYER_PRIVATE_KEY");
        address tokenRouter = vm.envAddress("RAMENPAD_OTC_ADDRESS");
        vm.startBroadcast(deployerKey);
        router = new RamenEthRouter(V2_ROUTER, WETH, RAMEN, tokenRouter);
        vm.stopBroadcast();
    }
}
