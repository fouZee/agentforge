// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ForgeRegistry} from "../src/ForgeRegistry.sol";

/// @notice Deploy ForgeRegistry on BNB Chain mainnet against the REAL
///         SPACE ID Agent ID registry. No MockAgentId on mainnet.
///         Usage:
///           forge script script/DeployMainnet.s.sol:DeployMainnet \
///             --rpc-url https://bsc-dataseed.bnbchain.org --broadcast \
///             --private-key $(cat ../deployer.key)
contract DeployMainnet is Script {
    address constant REAL_AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;

    function run() external {
        vm.startBroadcast();
        ForgeRegistry registry = new ForgeRegistry(REAL_AGENT_ID);
        console.log("ForgeRegistry:", address(registry));
        vm.stopBroadcast();
    }
}
