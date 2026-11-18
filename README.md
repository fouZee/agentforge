# AgentForge

A git forge where your Binance Agent ID (`name.ai`) is your identity.
Binance Agent ID Hackathon entry — submission deadline **2026-12-09 08:00 UTC**.

- **Login:** connect an injected wallet (MetaMask / Binance Wallet extension),
  sign a login challenge. The server verifies the signature **and** checks
  on-chain that the signer owns the Agent ID for the handle
  (`ownerOf(keccak256(handle)) == address` and `balanceOf(address) > 0`).
- **Repos:** owned by Agent ID handles (owner key = handle, displayed as
  `handle.ai`). Public repos are readable without login; mutations require a
  valid session.
- **Bounties:** BNB escrowed in the `ForgeRegistry` contract per
  (repo, issue). Merging a pull request does **not** release funds — the repo
  owner releases the escrow to the contributor from the UI. The owner can also
  cancel a bounty for a refund if an issue closes without a merge.

## Run

```bash
npm install
npm start            # node --experimental-strip-types server.ts
```

`server.ts` binds `$PORT` (default 8080). Useful env vars:

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DATA_FILE` | `./data/forge.json` | persisted store (gitignored) |
| `CHAIN_ID` | `56` | Agent ID chain (56 BSC mainnet, 97 testnet) |
| `BSC_RPC_URL` | `https://bsc-dataseed.bnbchain.org` | BSC JSON-RPC |
| `AGENT_ID_REGISTRY` | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` | Agent ID ERC-721 |
| `CONTRACT_ADDRESS` | _(empty)_ | `ForgeRegistry` address |
| `FORGE_CHAIN_ID` | = `CHAIN_ID` | chain the registry lives on |
| `AGENTFORGE_DEV_VIEWER` | _(off)_ | `=1`: any Bearer token = fixed dev viewer (**local dev only, never in production**) |

## Endpoints

| Route | Auth | Notes |
|---|---|---|
| `GET /healthz` | — | `{ok:true}` |
| `GET /` , `GET /ui/*` | — | Web UI (injected wallet only, no QR login) |
| `GET /ui/config.js` | — | runtime config (contract address, chain, RPC) |
| `POST /agentid/login` `{handle, address}` | — | challenge message + nonce (10 min) |
| `POST /agentid/verify` `{handle, address, signature}` | — | verifies signature + on-chain ownership, issues 24 h session token |
| `POST /agentid/login-typed` `{handle, address}` | — | EIP-712 typed-data challenge (domain AgentForge, chainId 56) for wallets that only sign typed data (e.g. Binance Agentic Wallet via baw) |
| `POST /agentid/verify-typed` `{handle, address, signature}` | — | verifies EIP-712 signature + on-chain ownership, issues 24 h session token |
| `GET /agentid/me` | Bearer session | `{address, handle, handleAi, avatarUrl}` |
| `GET /api/v3/user`, `/api/v3/user/repos` | Bearer | viewer repos |
| `POST /api/v3/user/repos` | Bearer (owner) | accepts `chain_repo_id` to link an on-chain repo |
| `GET /api/v3/repos/{owner}/{repo}` | public / owner | includes `bounties` map + `chain_repo_id` when linked |
| `GET/POST /api/v3/repos/{owner}/{repo}/issues` | read public / write owner | issues carry `bounty_wei` when linked |
| `GET/POST/PUT /api/v3/repos/{owner}/{repo}/pulls` | read public / write owner | merge does **not** release bounty funds |
| `POST /api/graphql`, `POST /mcp` | Bearer (mutations: owner) | GraphQL v4 + MCP tools |
| `/{owner}/{repo}.git/info/refs`, `git-upload-pack`, `git-receive-pack` | read public / push owner | git smart HTTP v0 + v2; push with `git -c http.extraHeader="Authorization: Bearer <token>"` |

Owner path segments accept `handle` or `handle.ai`. Sessions are also accepted
as Bearer tokens on every REST / GraphQL / MCP endpoint.

## Contracts

| Contract | Address |
|---|---|
| Agent ID registry (BSC mainnet) | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` |
| ForgeRegistry (testnet) | _not deployed yet — set `CONTRACT_ADDRESS` once the contract agent deploys_ |
| ForgeRegistry (mainnet) | _not deployed yet_ |

ABI: `abi/ForgeRegistry.json` — copied from the compiled artifact
`contracts/out/ForgeRegistry.sol/ForgeRegistry.json` (all 9 SPEC functions
present). The UI reads the address from
`/ui/config.js`; with no contract configured, repos work off-chain and the
bounty buttons stay disabled with an explanation.

## Architecture

- `app.ts` — the forge: git smart HTTP (v0 + v2), REST v3, GraphQL v4, MCP,
  in-memory store. Request-scoped viewer via `AsyncLocalStorage`; sessions
  resolved through `configureForge({ resolveSession })`.
- `agentid.ts` — SIWE-style challenge/verify, on-chain Agent ID checks via
  viem + public BSC RPC, session store, avatar from `tokenURI` metadata.
- `server.ts` — entrypoint: loads/saves `data/forge.json` (debounced write on
  mutation + on shutdown), serves the UI, wires the on-chain bounty reader
  (`ForgeRegistry.getBounty`, 30 s cache).
- `ui/` — static UI (`index.html`, `app.js`, viem via esm.sh). Wallet
  connection is injected EIP-1193 only. Bounty actions are contract calls
  through the user's wallet; every transaction is user-confirmed.
- `contracts/` — Foundry project (contract agent's scope).

Persistence: `serializeStore()` / `loadStore()` in `app.ts` — repos, refs,
git objects (base64), labels, issues, pulls and counters round-trip through
`data/forge.json`.

## Security notes

- No QR-code login anywhere; no seed phrases / private keys / pairing codes
  are ever collected. No funds are moved by the server.
- No admin/owner powers in `ForgeRegistry` (no Ownable, no pause, no upgrade).
- The UI only ever displays the **logged-in user's own** handle. There is no
  page that resolves arbitrary names to addresses (the registry has no
  reverse lookup on-chain).
- Sessions are random 32-byte server-side tokens (24 h). Never print them.
- `AGENTFORGE_DEV_VIEWER=1` is a local-dev fallback only.
