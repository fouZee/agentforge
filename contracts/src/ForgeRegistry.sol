// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentForge ForgeRegistry
/// @notice On-chain registry for the AgentForge git forge (Binance Agent ID Hackathon).
/// @dev Identity is Binance Agent ID (SPACE ID, ERC-721, soulbound) on BNB Chain.
///      Every state-changing function requires the caller to hold at least one
///      Agent ID: `AGENT_ID.balanceOf(msg.sender) > 0`.
///      There is deliberately NO admin / owner / pause / upgrade capability.
///      Nobody — not even the deployer — can move escrowed bounty funds except
///      through the rules below (repo owner releases to a contributor, or
///      refunds to themselves on cancel).
interface IAgentId {
    function balanceOf(address account) external view returns (uint256);
}

contract ForgeRegistry {
    IAgentId public immutable AGENT_ID;

    struct Repo {
        address owner;
        string name;
        string visibility; // "public" | "private"
        uint256 createdAt;
    }

    uint256 private _repoCount;
    mapping(uint256 => Repo) private _repos;
    mapping(uint256 => mapping(address => bool)) private _collaborators;
    mapping(uint256 => mapping(uint256 => uint256)) private _bounties;

    event RepoRegistered(
        uint256 indexed repoId, address indexed owner, string name, string visibility
    );
    event CollaboratorAdded(uint256 indexed repoId, address indexed collaborator);
    event BountyPosted(
        uint256 indexed repoId, uint256 indexed issueId, address indexed poster, uint256 amount
    );
    event BountyReleased(
        uint256 indexed repoId,
        uint256 indexed issueId,
        address indexed contributor,
        uint256 amount
    );
    event BountyCancelled(uint256 indexed repoId, uint256 indexed issueId, uint256 amount);

    error AgentIdRequired();
    error NotRepoOwner();
    error InvalidVisibility();
    error EmptyName();
    error ZeroValue();
    error NoBounty();
    error ZeroAddress();
    error TransferFailed();

    modifier onlyAgentIdHolder() {
        if (AGENT_ID.balanceOf(msg.sender) == 0) revert AgentIdRequired();
        _;
    }

    modifier onlyRepoOwner(uint256 repoId) {
        if (_repos[repoId].owner != msg.sender) revert NotRepoOwner();
        _;
    }

    /// @param agentId Address of the Agent ID ERC-721 registry.
    ///                Mainnet: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
    ///                Testnet: the MockAgentId deployed alongside this contract.
    constructor(address agentId) {
        if (agentId == address(0)) revert ZeroAddress();
        AGENT_ID = IAgentId(agentId);
    }

    /// @notice Register a new repo owned by the caller's Agent ID identity.
    /// @param name Repo name.
    /// @param visibility "public" or "private".
    /// @return repoId Sequential id of the new repo.
    function registerRepo(string calldata name, string calldata visibility)
        external
        onlyAgentIdHolder
        returns (uint256 repoId)
    {
        if (bytes(name).length == 0) revert EmptyName();
        bytes32 v = keccak256(bytes(visibility));
        if (v != keccak256(bytes("public")) && v != keccak256(bytes("private"))) {
            revert InvalidVisibility();
        }
        repoId = _repoCount;
        _repoCount += 1;
        _repos[repoId] = Repo({
            owner: msg.sender,
            name: name,
            visibility: visibility,
            createdAt: block.timestamp
        });
        emit RepoRegistered(repoId, msg.sender, name, visibility);
    }

    /// @notice Add a collaborator. Only the repo owner; the collaborator must
    ///         hold an Agent ID.
    function addCollaborator(uint256 repoId, address collaborator)
        external
        onlyAgentIdHolder
        onlyRepoOwner(repoId)
    {
        if (collaborator == address(0)) revert ZeroAddress();
        if (AGENT_ID.balanceOf(collaborator) == 0) revert AgentIdRequired();
        _collaborators[repoId][collaborator] = true;
        emit CollaboratorAdded(repoId, collaborator);
    }

    /// @notice Escrow BNB as a bounty on an issue. Multiple posts accumulate.
    function postBounty(uint256 repoId, uint256 issueId)
        external
        payable
        onlyAgentIdHolder
    {
        if (msg.value == 0) revert ZeroValue();
        _bounties[repoId][issueId] += msg.value;
        emit BountyPosted(repoId, issueId, msg.sender, msg.value);
    }

    /// @notice Release the escrowed bounty to a contributor (e.g. on PR merge).
    ///         Only the repo owner. Zeroes the escrow before sending.
    function releaseBounty(uint256 repoId, uint256 issueId, address contributor)
        external
        onlyAgentIdHolder
        onlyRepoOwner(repoId)
    {
        if (contributor == address(0)) revert ZeroAddress();
        uint256 amount = _bounties[repoId][issueId];
        if (amount == 0) revert NoBounty();
        _bounties[repoId][issueId] = 0;
        (bool ok,) = contributor.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit BountyReleased(repoId, issueId, contributor, amount);
    }

    /// @notice Refund the escrowed bounty to the repo owner (issue closed
    ///         without a merge). Only the repo owner.
    function cancelBounty(uint256 repoId, uint256 issueId)
        external
        onlyAgentIdHolder
        onlyRepoOwner(repoId)
    {
        uint256 amount = _bounties[repoId][issueId];
        if (amount == 0) revert NoBounty();
        _bounties[repoId][issueId] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit BountyCancelled(repoId, issueId, amount);
    }

    function getRepo(uint256 repoId)
        external
        view
        returns (address owner, string memory name, string memory visibility, uint256 createdAt)
    {
        Repo storage r = _repos[repoId];
        return (r.owner, r.name, r.visibility, r.createdAt);
    }

    function getBounty(uint256 repoId, uint256 issueId) external view returns (uint256) {
        return _bounties[repoId][issueId];
    }

    function isCollaborator(uint256 repoId, address who) external view returns (bool) {
        return _collaborators[repoId][who];
    }

    function repoCount() external view returns (uint256) {
        return _repoCount;
    }

    /// @notice Reject plain BNB transfers; bounties must go through postBounty
    ///         so they are always attributed to a (repoId, issueId).
    receive() external payable {
        revert("Use postBounty");
    }
}
