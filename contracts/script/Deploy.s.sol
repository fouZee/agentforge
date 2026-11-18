// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ForgeRegistry} from "../src/ForgeRegistry.sol";
import {MockAgentId} from "../src/MockAgentId.sol";

/// @notice Deploy MockAgentId + ForgeRegistry, then mint a test Agent ID
///         ("deployer") to the deployer so the rehearsal can call registerRepo.
///         Usage (testnet):
///           forge script script/Deploy.s.sol:Deploy \
///             --rpc-url bsc_testnet --broadcast \
///             --private-key $(cat ../deployer.key)
///         Mainnet uses the REAL registry instead — see contracts/README.md;
///         do NOT deploy MockAgentId on mainnet.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        MockAgentId agentId = new MockAgentId();
        console.log("MockAgentId:", address(agentId));
        ForgeRegistry registry = new ForgeRegistry(address(agentId));
        console.log("ForgeRegistry:", address(registry));
        uint256 tokenId = agentId.mint(msg.sender, "deployer");
        console.log("Minted Agent ID 'deployer' tokenId:");
        console.logBytes32(bytes32(tokenId));
        console.log("to deployer:", msg.sender);
        vm.stopBroadcast();
    }
}
