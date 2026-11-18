// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ForgeRegistry} from "../src/ForgeRegistry.sol";
import {MockAgentId} from "../src/MockAgentId.sol";

contract ForgeRegistryTest is Test {
    ForgeRegistry public registry;
    MockAgentId public agentId;

    address public owner = makeAddr("owner");
    address public collab = makeAddr("collab");
    address public stranger = makeAddr("stranger");
    address public contributor = makeAddr("contributor");

    function setUp() public {
        agentId = new MockAgentId();
        registry = new ForgeRegistry(address(agentId));
        agentId.mint(owner, "fouzye");
        agentId.mint(collab, "alice");
        // stranger and contributor hold NO Agent ID on purpose.
        vm.deal(owner, 10 ether);
        vm.deal(collab, 10 ether);
        vm.deal(stranger, 10 ether);
    }

    // --- registerRepo ---

    function testRegisterRepo() public {
        vm.prank(owner);
        uint256 id = registry.registerRepo("hello-world", "public");
        assertEq(id, 0);
        assertEq(registry.repoCount(), 1);
        (address rOwner, string memory name, string memory vis, uint256 createdAt) =
            registry.getRepo(0);
        assertEq(rOwner, owner);
        assertEq(name, "hello-world");
        assertEq(vis, "public");
        assertGt(createdAt, 0);
    }

    function testRegisterRepoIncrementsIds() public {
        vm.prank(owner);
        registry.registerRepo("a", "public");
        vm.prank(owner);
        uint256 id = registry.registerRepo("b", "private");
        assertEq(id, 1);
        assertEq(registry.repoCount(), 2);
    }

    function testRegisterRepoRevertsWithoutAgentId() public {
        vm.prank(stranger);
        vm.expectRevert(ForgeRegistry.AgentIdRequired.selector);
        registry.registerRepo("x", "public");
    }

    function testRegisterRepoRevertsBadVisibility() public {
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.InvalidVisibility.selector);
        registry.registerRepo("x", "internal");
    }

    function testRegisterRepoRevertsEmptyName() public {
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.EmptyName.selector);
        registry.registerRepo("", "public");
    }

    // --- addCollaborator ---

    function _repo() internal returns (uint256) {
        vm.prank(owner);
        return registry.registerRepo("repo", "public");
    }

    function testAddCollaborator() public {
        uint256 id = _repo();
        vm.prank(owner);
        registry.addCollaborator(id, collab);
        assertTrue(registry.isCollaborator(id, collab));
        assertFalse(registry.isCollaborator(id, stranger));
    }

    function testAddCollaboratorRevertsWithoutAgentId() public {
        uint256 id = _repo();
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.AgentIdRequired.selector);
        registry.addCollaborator(id, stranger);
    }

    function testAddCollaboratorOnlyOwner() public {
        uint256 id = _repo();
        vm.prank(collab);
        vm.expectRevert(ForgeRegistry.NotRepoOwner.selector);
        registry.addCollaborator(id, collab);
    }

    function testAddCollaboratorRevertsZeroAddress() public {
        uint256 id = _repo();
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.ZeroAddress.selector);
        registry.addCollaborator(id, address(0));
    }

    // --- postBounty / getBounty ---

    function testPostBountyAccumulates() public {
        uint256 id = _repo();
        vm.prank(owner);
        registry.postBounty{value: 0.5 ether}(id, 7);
        vm.prank(collab);
        registry.postBounty{value: 0.25 ether}(id, 7);
        assertEq(registry.getBounty(id, 7), 0.75 ether);
        assertEq(address(registry).balance, 0.75 ether);
    }

    function testPostBountyRevertsZeroValue() public {
        uint256 id = _repo();
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.ZeroValue.selector);
        registry.postBounty{value: 0}(id, 1);
    }

    function testPostBountyRevertsWithoutAgentId() public {
        uint256 id = _repo();
        vm.prank(stranger);
        vm.expectRevert(ForgeRegistry.AgentIdRequired.selector);
        registry.postBounty{value: 1 ether}(id, 1);
    }

    function testDirectTransferReverts() public {
        vm.prank(owner);
        (bool ok,) = address(registry).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // --- releaseBounty ---

    function testReleaseBounty() public {
        uint256 id = _repo();
        vm.prank(owner);
        registry.postBounty{value: 1 ether}(id, 3);
        uint256 before = contributor.balance;
        vm.prank(owner);
        registry.releaseBounty(id, 3, contributor);
        assertEq(contributor.balance, before + 1 ether);
        assertEq(registry.getBounty(id, 3), 0);
        assertEq(address(registry).balance, 0);
    }

    function testReleaseBountyOnlyOwner() public {
        uint256 id = _repo();
        vm.prank(owner);
        registry.postBounty{value: 1 ether}(id, 3);
        vm.prank(collab);
        vm.expectRevert(ForgeRegistry.NotRepoOwner.selector);
        registry.releaseBounty(id, 3, contributor);
    }

    function testReleaseBountyRevertsWhenEmpty() public {
        uint256 id = _repo();
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.NoBounty.selector);
        registry.releaseBounty(id, 3, contributor);
    }

    function testReleaseBountyRevertsZeroAddress() public {
        uint256 id = _repo();
        vm.prank(owner);
        registry.postBounty{value: 1 ether}(id, 3);
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.ZeroAddress.selector);
        registry.releaseBounty(id, 3, address(0));
    }

    // --- cancelBounty ---

    function testCancelBountyRefundsOwner() public {
        uint256 id = _repo();
        vm.prank(owner);
        registry.postBounty{value: 2 ether}(id, 9);
        uint256 before = owner.balance;
        vm.prank(owner);
        registry.cancelBounty(id, 9);
        assertEq(owner.balance, before + 2 ether);
        assertEq(registry.getBounty(id, 9), 0);
    }

    function testCancelBountyOnlyOwner() public {
        uint256 id = _repo();
        vm.prank(owner);
        registry.postBounty{value: 1 ether}(id, 9);
        vm.prank(collab);
        vm.expectRevert(ForgeRegistry.NotRepoOwner.selector);
        registry.cancelBounty(id, 9);
    }

    function testCancelBountyRevertsWhenEmpty() public {
        uint256 id = _repo();
        vm.prank(owner);
        vm.expectRevert(ForgeRegistry.NoBounty.selector);
        registry.cancelBounty(id, 9);
    }

    // --- constructor ---

    function testConstructorRevertsZeroAddress() public {
        vm.expectRevert(ForgeRegistry.ZeroAddress.selector);
        new ForgeRegistry(address(0));
    }

    function testAgentIdImmutable() public {
        assertEq(address(registry.AGENT_ID()), address(agentId));
    }
}
