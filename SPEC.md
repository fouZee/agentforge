# AgentForge — Build Spec (Binance Agent ID Hackathon)

Submission deadline: **2026-12-09 08:00 UTC / 15:00 WIB**. Pool $60k USDC.
Workspace: `~/workspace/hackathon/agentforge/`. Original make.fun repo at
`~/workspace/makefun/github-core-clone-01/` — DO NOT modify; copies live here.

## Product

A live git forge where Binance Agent ID (`name.ai`) is the identity layer:
- Login by signing a SIWE-style message; server verifies the signature and checks
  on-chain that `ownerOf(keccak256(handle)) == signer` and `balanceOf(signer) > 0`.
- Repos owned by Agent IDs (owner key = handle, displayed as `handle.ai`).
- Collaborators must hold an Agent ID (enforced on-chain).
- Repo bounties escrowed in BNB on-chain, released by the repo owner on merge.

## Verified on-chain facts (BSC mainnet, chainId 56)

- Agent ID registry: `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`, SPACE ID Agent ID,
  ERC-721, non-transferable (`transferFrom` reverts Soulbound `0xa4420a95`).
- `tokenId = uint256(keccak256(bytes(handle)))`, handle LOWERCASE, WITHOUT `.ai`.
  Verified: `ownerOf(keccak256("fouzye")) = 0xd176c8EEf179B2807c11Ed479Fb3e9Ed387aCdF9`;
  `ownerOf(keccak256("fouzye.ai"))` reverts.
- Interface that EXISTS: `balanceOf(address)`, `ownerOf(uint256)`, `tokenURI(uint256)`,
  `name()`, `symbol()`, `supportsInterface(bytes4)`.
- Does NOT exist: `totalSupply()`, `tokenOfOwnerByIndex()`, `handleOf()`.
  No on-chain reverse lookup (address -> handle); record the handle at first
  interaction (user supplies it, server verifies via `ownerOf`).
- Gate pattern: `require(AGENT_ID.balanceOf(msg.sender) > 0, "Agent ID required")`.
- `baw` CLI CANNOT deploy contracts (no CREATE path; key is MPC-held). Mainnet
  deployment uses a separate fresh deployer EOA via Foundry.
- BscScan website is Cloudflare-blocked from this VM — verify via
  `forge verify-contract` (API) or Sourcify, never by browsing bscscan.com.
- BSC RPCs: `https://bsc-dataseed.bnbchain.org`, `https://bsc-rpc.publicnode.com`.
  BSC testnet chainId 97 (tBNB faucet) — rehearse there first.

## Hackathon red lines (must not violate)

- NO web QR-code login for Agentic Wallet anywhere in the UX. Use standard
  injected wallet (EIP-1193, e.g. MetaMask / Binance Wallet extension).
- No prompts that bypass user transaction confirmation.
- No unauthorized / scheduled / bundled transfers, no hidden unlimited approvals.
- Contracts open-source, owner permissions documented.
- No "Binance"/"BNB" brand impersonation in names/domains. Product name: AgentForge.
- No collecting seed phrases / private keys / API secrets / pairing codes.
- No promised returns. Show risk warnings if trading is involved (it is not).
- Do NOT build a public "look up someone's wallet by name" page. Only ever
  display the LOGGED-IN user's own handle.

## Contract — `ForgeRegistry.sol` (Foundry project: `contracts/`)

`AGENT_ID` is a constructor parameter (mainnet: `0x60B9...022F`; testnet: a mock
Agent ID ERC-721 deployed alongside, same interface).

```solidity
registerRepo(string name, string visibility) returns (uint256 repoId)
  // gated: balanceOf(msg.sender) > 0. visibility "public"|"private".
  // event RepoRegistered(uint256 indexed repoId, address indexed owner, string name, string visibility)

addCollaborator(uint256 repoId, address collaborator)
  // only repo owner; require collaborator holds an Agent ID.
  // event CollaboratorAdded(uint256 indexed repoId, address indexed collaborator)

postBounty(uint256 repoId, uint256 issueId) payable
  // require msg.value > 0; escrows BNB per (repoId, issueId); multiple posts accumulate.
  // event BountyPosted(uint256 indexed repoId, uint256 indexed issueId, address indexed poster, uint256 amount)

releaseBounty(uint256 repoId, uint256 issueId, address contributor)
  // only repo owner; sends escrowed BNB to contributor, zeroes escrow.
  // event BountyReleased(uint256 indexed repoId, uint256 indexed issueId, address indexed contributor, uint256 amount)

cancelBounty(uint256 repoId, uint256 issueId)
  // only repo owner; refunds escrowed BNB to the owner (issue closed without a merge).
  // event BountyCancelled(uint256 indexed repoId, uint256 indexed issueId, uint256 amount)

getRepo(uint256 repoId) view returns (address owner, string name, string visibility, uint256 createdAt)
getBounty(uint256 repoId, uint256 issueId) view returns (uint256)
isCollaborator(uint256 repoId, address who) view returns (bool)
repoCount() view returns (uint256)
```

- No admin/owner powers at all (no Ownable, no pause, no upgrade). Document this.
- Full Foundry tests: unit tests + a mainnet-fork test against the real registry
  (fork BSC mainnet RPC, impersonate an address that holds an Agent ID, e.g.
  `0xd176...CdF9`, and call `registerRepo`).
- Deployer: generate a FRESH EOA, store key in `deployer.key` (mode 600, never
  print, never commit). Report only its address. Testnet first (tBNB faucet);
  mainnet only when the user funds the deployer with ~0.01 BNB.

## Forge integration (modify the copy of `app.ts` in this workspace)

Current state (inspect before changing):
- Single process, Node stdlib only, `createServer` returns the HTTP server;
  `main.ts` is a make.fun harness — DO NOT reuse it.
- Store: `repos: Map<string, Repo>` keyed `owner/name`; `Repo` has
  `owner: string` (a login), `name`, `description`, `isPrivate`, `refs: Map`,
  `objects: Map<string, GitObj>` (Buffer data), `labels`, `issues: Issue[]`,
  `pulls: Pull[]`, `nextIssue/nextPull/nextComment`, `seq`.
- Auth today: any non-empty `Authorization: Bearer <redacted>` = one fixed
  deterministic viewer (`VIEWER_LOGIN`, from a seeded scenario). Many handlers
  hard-code `VIEWER_LOGIN`.
- Routes: `GET /healthz`, `/api/v3/*` (REST), `POST /api/graphql`,
  `POST /mcp`, git smart HTTP `/{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}`.

Required changes:
1. New standalone entrypoint `server.ts` binding `$PORT` (default 8080). No
   make.fun lifecycle code.
2. Agent ID auth (`agentid.ts`, new file):
   - `POST /agentid/login` body `{handle, address}` -> returns a challenge
     message + nonce: `Sign in to AgentForge as <handle>.ai\n\nNonce: <hex>`.
     Nonces are stateless: `<hex ms timestamp>-<16 hex random>` — verify
     checks the embedded timestamp (10-min expiry) from the `nonce` the
     client sends back, so login survives hosts that recycle the process
     between login and verify (the in-memory challenge map is only a
     fallback for clients that don't send the nonce).
   - `POST /agentid/verify` body `{handle, address, signature, nonce?}` -> verify
     signature over the challenge (use `viem` as a dependency — allowed now),
     then verify on-chain via public BSC RPC JSON-RPC `eth_call`:
     `ownerOf(keccak256(handle)) == address` AND `balanceOf(address) > 0`.
     On success issue a random session token (32 bytes hex), store
     `{address, handle, expiresAt}` server-side.
   - `POST /agentid/login-typed` / `POST /agentid/verify-typed` — same flow,
     but the challenge is signed as EIP-712 typed data instead of a plain
     message, for wallets that can only sign typed data (e.g. Binance
     Agentic Wallet via the `baw` CLI). `login-typed` returns
     `typedData = {domain: {name: "AgentForge", version: "1", chainId},
     types: {Login: [{name: "handle", type: "string"}, {name: "nonce",
     type: "string"}]}, primaryType: "Login", message: {handle, nonce}}`;
     `verify-typed` checks the typed-data signature with
     `viem.verifyTypedData`, then the same on-chain check and session token.
     The plain-message flow is unchanged.
   - `GET /agentid/me` with `Authorization: Bearer <session>` -> returns
     `{address, handle, handleAi: "<handle>.ai", avatarUrl}` where avatar comes
     from `tokenURI(tokenId)` metadata (fetch, cache; tolerate failure).
   - Sessions also accepted as `Bearer` tokens for the REST/GraphQL/MCP
     endpoints: resolve the acting user from the session; repo ownership is
     keyed by the handle string (owner = handle, displayed as `handle.ai`).
     Unauthenticated requests may read public repos only; mutations require a
     valid session. Keep the old fixed-viewer behaviour only as a local-dev
     fallback when `AGENTFORGE_DEV_VIEWER=1` is set (never in production).
3. Persistence: serialize the store to `data/forge.json` on every mutation
   (debounced write is fine) and load at startup. Git objects are Buffers —
   store as base64. `Repo.refs`/`objects`/`labels` are Maps — serialize as
   arrays. On load, rebuild Maps. Data dir must be gitignored.
4. Bounty wiring: repo detail responses include the on-chain bounty for each
   issue (`getBounty` via BSC RPC, cached briefly). Merging a PR (existing
   `mergePullInternal`) does NOT auto-release funds on-chain — the owner
   releases via the contract from the UI. Document this clearly in the UI.
5. UI served by the same process (`GET /` and static assets under `/ui/`):
   connect wallet (injected EIP-1193 provider only — NO QR login), profile
   card (handle + avatar), repo list/create, issue list, bounty post/release
   buttons that call the contract through the user's wallet (viem, via esm.sh
   or a small bundled build — pick the reliable option), risk-free: every
   transaction is user-confirmed in their wallet. No page that resolves
   arbitrary names to addresses.
6. `package.json`: rename to `agentforge`, add `viem` dependency, `start`
   script `node --experimental-strip-types server.ts`. Keep Node >= 22.
7. `README.md` in this workspace: architecture, how to run, contract
   addresses (testnet + mainnet once deployed), Agent ID usage, owner
   permissions (none), security notes.

## Hosting

Give the forge a stable public URL for ~3 weeks. Evaluate: this VM + a free
tunnel (e.g. cloudflared quick tunnel — no account) vs a free-tier host
(Render/Railway/Fly free tier — only if no payment method / credentials we
don't have are needed). Do NOT sign up for paid services. Do NOT ask for
anyone's passwords. Set up the chosen option if it needs no payment or
third-party credentials; otherwise report the recommendation + exact steps.

## Submission prep (do NOT submit)

Find the official submission form/link for the hackathon and prepare materials:
name "AgentForge", website URL, contract addresses, Agent ID usage description.
Final submission is confirmed with the user first.

## Funds / secrets — hard rules

- Do not move any funds. Do not ask the user for a private key, seed phrase,
  or Binance credentials.
- Fresh deployer EOA key: file mode 600, never printed, never committed.
- Never print session tokens, API keys, or private keys in logs or reports.
