// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IRamenRoles {
    function owner() external view returns (address);
    function ramenDev() external view returns (address);
}
