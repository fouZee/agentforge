// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAgentId
/// @notice Minimal stand-in for the SPACE ID Agent ID ERC-721 registry, for
///         local tests and the BSC testnet rehearsal. Mirrors the real
///         interface subset AgentForge uses: balanceOf / ownerOf / tokenURI /
///         name / symbol. tokenId = uint256(keccak256(bytes(handle))),
///         handle lowercase without ".ai" — same as mainnet.
/// @dev NOT soulbound (transfer functions are stubbed out); do not use on mainnet.
contract MockAgentId {
    string public constant name = "Agent ID";
    string public constant symbol = "AID";

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => string) private _tokenURIs;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(address to, string calldata handle) external returns (uint256 tokenId) {
        tokenId = uint256(keccak256(bytes(handle)));
        require(_owners[tokenId] == address(0), "already minted");
        require(to != address(0), "zero address");
        _owners[tokenId] = to;
        _balances[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function setTokenURI(uint256 tokenId, string calldata uri) external {
        _tokenURIs[tokenId] = uri;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "nonexistent token");
        return owner;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        return _tokenURIs[tokenId];
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        // ERC-721 (0x80ac58cd) and ERC-721 metadata (0x5b5e139f)
        return interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }
}
