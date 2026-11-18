# AgentForge — Contracts

Foundry project for the AgentForge git forge (Binance Agent ID Hackathon).
Solidity 0.8.24, forge 1.9.0.

## Contracts

| Contract | Purpose |
|---|---|
| `src/ForgeRegistry.sol` | Repo registry + BNB bounty escrow. Identity-gated by Agent ID. |
| `src/MockAgentId.sol` | Minimal stand-in for the SPACE ID Agent ID ERC-721 (tests + BSC testnet only). Mirrors `balanceOf` / `ownerOf` / `tokenURI` / `name` / `symbol`; `tokenId = uint256(keccak256(bytes(handle)))`, handle lowercase without `.ai`. **Never deploy on mainnet.** |

### `ForgeRegistry` interface

- `constructor(address agentId)` — mainnet: `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`; testnet: the `MockAgentId` deployed alongside.
- `registerRepo(string name, string visibility) returns (uint256 repoId)` — visibility `"public"` | `"private"`.
- `addCollaborator(uint256 repoId, address collaborator)` — only repo owner; collaborator must hold an Agent ID.
- `postBounty(uint256 repoId, uint256 issueId) payable` — `msg.value > 0`; multiple posts accumulate.
- `releaseBounty(uint256 repoId, uint256 issueId, address contributor)` — only repo owner; sends escrowed BNB to the contributor, zeroes escrow first.
- `cancelBounty(uint256 repoId, uint256 issueId)` — only repo owner; refunds escrowed BNB to the owner.
- Views: `getRepo(uint256)` → `(owner, name, visibility, createdAt)`, `getBounty(uint256,uint256)`, `isCollaborator(uint256,address)`, `repoCount()`.
- `AGENT_ID` is `immutable`, set once in the constructor.
- Plain BNB transfers are rejected (`receive()` reverts) — bounties must go through `postBounty` so they are always attributed to a `(repoId, issueId)`.

### Owner permissions: NONE

There is **no admin, no owner, no Ownable, no pause, no upgrade** in
`ForgeRegistry`. The deployer has no special powers after deployment — nobody
can move escrowed bounty funds except through the rules above (repo owner
releases to a contributor, or refunds to themselves on cancel). This is
deliberate and is part of the hackathon submission's security story.

### Identity gating

Every state-changing function requires `AGENT_ID.balanceOf(msg.sender) > 0`
(`AgentIdRequired` revert otherwise). `addCollaborator` additionally requires
the collaborator to hold an Agent ID.

## Addresses

| Network | MockAgentId | ForgeRegistry |
|---|---|---|
| BSC testnet (97) | _not yet deployed — deployer unfunded, see below_ | _not yet deployed_ |
| BSC mainnet (56) | n/a (real registry `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`) | `0x8ce4e9192A5825621BC0B0966C24C674D5ABe269` — **deployed 2026-11-18 19:19 WIB**, tx `0xf70314885d68584046951eac6eef2ca4b5dbfa7b0c8323182bfe0d43c955733e`, block 134310274, deploy cost 0.000082111 BNB |

**Mainnet deployed 2026-11-18 19:19 WIB** (ForgeRegistry `0x8ce4e9192A5825621BC0B0966C24C674D5ABe269`); testnet rehearsal skipped by user choice. Source verification still pending (Sourcify rate-limited, no BscScan API key, BscScan API Cloudflare-blocked from VM).
Deployer EOA (fresh, generated 2026-11-18): `0xCC3956F3A86492e9cD1Bd19b7711a2f8d99EABC6` — funded 0.00189 BNB (user sent 0.002, ~0.00011 lost to sending fee), spent 0.000082111 BNB on the mainnet deploy, balance now ~0.00181 BNB.
Its private key is in `../deployer.key` (mode 600, gitignored, never printed
or committed). Balance on BSC testnet: **0 tBNB** (checked 2026-11-18 ~11:52 WIB).

## Tests — 25/25 passing

```bash
cd contracts
forge test                                   # unit tests (22)
BSC_RPC_URL=https://bsc-dataseed.bnbchain.org forge test   # full suite incl. fork tests (25)
```

- `test/ForgeRegistry.t.sol` — 22 unit tests against `MockAgentId`: registration
  (+ bad visibility / empty name / non-holder reverts), collaborators (owner-only,
  Agent-ID-required), bounty post/accumulate/release/cancel (owner-only, refunds,
  zero-value and empty-escrow reverts), direct-transfer rejection, constructor guards.
- `test/ForgeRegistryFork.t.sol` — 3 mainnet-fork tests against the **real**
  Agent ID registry: confirms `balanceOf(0xd176c8EEf179B2807c11Ed479Fb3e9Ed387aCdF9) > 0`
  (holder of Agent ID `"fouzye"`), `registerRepo` succeeds via `vm.prank` on that
  address (no real funds move), and a non-holder reverts with `AgentIdRequired`.

Note: `forge build` emits two lint warnings (`reentrancy-events`) on
`releaseBounty`/`cancelBounty` — the events are emitted after the external call
on purpose (only after the transfer succeeds), and the escrow is zeroed *before*
the call (checks-effects-interactions), so there is no reentrancy risk.

## ABI

Exported for the frontend: `../abi/ForgeRegistry.json` (25 ABI entries).
Regenerate after any contract change:

```bash
forge build && jq '{contractName: "ForgeRegistry", abi: .abi}' \
  out/ForgeRegistry.sol/ForgeRegistry.json > ../abi/ForgeRegistry.json
```

## Funding the deployer (testnet) — BLOCKED

The deployer needs ~0.1 tBNB for the rehearsal deploy. The official faucet
requires a browser (and, per current guides, a 0.002 BNB mainnet balance on the
claiming address as an anti-bot check):

- Official faucet: https://testnet.bnbchain.org/faucet-smart (0.3 tBNB / 24h)
- Docs: https://docs.bnbchain.org/bnb-smart-chain/developers/faucet/
- Alternatives (also browser/captcha/account-gated): QuickNode faucet,
  Chainstack faucet, or the BNB Chain Telegram bot `@bnbchain_official_bot`.

No unauthenticated faucet API endpoint is available from this VM — a plain
`curl` probe of the faucet page returned no usable API, and all listed faucets
require a browser/captcha or an account. **To unblock: open the official faucet
in a browser, paste `0xCC3956F3A86492e9cD1Bd19b7711a2f8d99EABC6`, complete the
check, then re-run the deploy below.** (The deployer holds no mainnet BNB, so
the faucet's 0.002 BNB mainnet-balance check may also block it — the Telegram
bot route has no such requirement per the docs.)

Once funded, deploy to testnet:

```bash
cd contracts
forge script script/Deploy.s.sol:Deploy \
  --rpc-url bsc_testnet --broadcast \
  --private-key $(cat ../deployer.key)
```

This deploys `MockAgentId`, then `ForgeRegistry` pointing at it, then mints
Agent ID `"deployer"` to the deployer so the rehearsal can call `registerRepo`.
Record both addresses in the table above.

Verify on testnet (BscScan website is Cloudflare-blocked from this VM — use
the API, or Sourcify):

```bash
forge verify-contract <FORGE_REGISTRY_ADDRESS> src/ForgeRegistry.sol:ForgeRegistry \
  --chain 97 --constructor-args $(cast abi-encode "constructor(address)" <MOCK_AGENT_ID_ADDRESS>) \
  --etherscan-api-key <BSCSCAN_API_KEY>
# or: --verifier sourcify
```

## Deploying to mainnet (only when the deployer is funded with ~0.01 BNB)

Do **not** deploy `MockAgentId` on mainnet. Deploy `ForgeRegistry` with the
real Agent ID registry as the constructor argument:

```bash
cd contracts
forge create src/ForgeRegistry.sol:ForgeRegistry \
  --rpc-url https://bsc-dataseed.bnbchain.org \
  --private-key $(cat ../deployer.key) \
  --constructor-args 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
```

Estimated deploy gas is ~0.0002–0.0005 BNB (contract is small, no proxies).
Verify with `forge verify-contract ... --chain 56` as above, then record the
address in the table and in the workspace `README.md`. Mainnet deployment is
**not** done until the user confirms the deployer is funded and approves it.
