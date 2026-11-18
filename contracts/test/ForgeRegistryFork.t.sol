// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ForgeRegistry} from "../src/ForgeRegistry.sol";

/// @notice Mainnet-fork test against the REAL Agent ID registry
///         (SPACE ID, 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).
///         Run with: BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test --match-contract ForgeRegistryForkTest
///         Impersonates 0xd176c8EEf179B2807c11Ed479Fb3e9Ed387aCdF9, holder of
///         Agent ID "fouzye" (tokenId = keccak256("fouzye")). No real funds move.
contract ForgeRegistryForkTest is Test {
    address public constant AGENT_ID = 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F;
    address public constant FOUZYE = 0xd176c8EEf179B2807c11Ed479Fb3e9Ed387aCdF9;

    ForgeRegistry public registry;

    function setUp() public {
        uint256 forkId = vm.createFork(vm.envString("BSC_RPC_URL"));
        vm.selectFork(forkId);
        registry = new ForgeRegistry(AGENT_ID);
    }

    function testRealRegistryRecognisesFouzye() public view {
        (bool ok, bytes memory ret) =
            AGENT_ID.staticcall(abi.encodeWithSignature("balanceOf(address)", FOUZYE));
        assertTrue(ok);
        assertGt(abi.decode(ret, (uint256)), 0);
    }

    function testRegisterRepoAsRealAgentIdHolder() public {
        vm.prank(FOUZYE);
        uint256 id = registry.registerRepo("agentforge-fork-test", "public");
        assertEq(id, 0);
        assertEq(registry.repoCount(), 1);
        (address rOwner,,,) = registry.getRepo(0);
        assertEq(rOwner, FOUZYE);
    }

    function testRegisterRepoRevertsForNonHolderOnFork() public {
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        vm.expectRevert(ForgeRegistry.AgentIdRequired.selector);
        registry.registerRepo("nope", "public");
    }
}
