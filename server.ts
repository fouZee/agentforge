// AgentForge — standalone entrypoint (Binance Agent ID Hackathon).
// Serves the git forge (app.ts), Agent ID auth (agentid.ts) and the UI
// from one process. Run:  node --experimental-strip-types server.ts
//
// Env:
//   PORT                  default 8080
//   DATA_FILE             default ./data/forge.json (store persistence)
//   AGENTFORGE_DEV_VIEWER=1  local-dev only: any Bearer token = fixed viewer
//   CHAIN_ID              Agent ID chain (56 mainnet default, 97 testnet)
//   BSC_RPC_URL           BSC JSON-RPC endpoint
//   AGENT_ID_REGISTRY     Agent ID ERC-721 address
//   CONTRACT_ADDRESS      ForgeRegistry address ('' = not deployed yet)
//   FORGE_CHAIN_ID        chain the ForgeRegistry lives on (default CHAIN_ID)

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicClient, http } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { createApp, loadStore, serializeStore } from './app.ts';
import { AGENT_ID_REGISTRY, BSC_RPC_URL, FORGE_CHAIN_ID, FORGE_CONTRACT_ADDRESS, handleAgentId, resolveSession } from './agentid.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? '8080');
const DATA_FILE = process.env.DATA_FILE ?? join(here, 'data', 'forge.json');
const DEV_VIEWER = process.env.AGENTFORGE_DEV_VIEWER === '1';

// ---------------------------------------------------------------------------
// Persistence: load at startup, debounced save on every mutation.
// ---------------------------------------------------------------------------

if (existsSync(DATA_FILE)) {
  try {
    loadStore(readFileSync(DATA_FILE, 'utf8'));
    console.log(`[agentforge] loaded store from ${DATA_FILE}`);
  } catch (err) {
    console.error(`[agentforge] WARNING: could not load ${DATA_FILE}: ${err instanceof Error ? err.message : String(err)} — starting empty`);
  }
}

let saveTimer: NodeJS.Timeout | null = null;
let savePending = false;
function saveNow(): void {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    writeFileSync(DATA_FILE, serializeStore());
    savePending = false;
  } catch (err) {
    console.error(`[agentforge] WARNING: could not save ${DATA_FILE}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function scheduleSave(): void {
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 500);
}

// ---------------------------------------------------------------------------
// On-chain bounties: ForgeRegistry.getBounty via BSC RPC, cached 30s.
// Returns null when no contract is configured (bounty buttons stay disabled).
// ---------------------------------------------------------------------------

const FORGE_ABI = [
  { type: 'function', name: 'getBounty', stateMutability: 'view', inputs: [{ name: 'repoId', type: 'uint256' }, { name: 'issueId', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
] as const;

const bountyClient = createPublicClient({
  chain: FORGE_CHAIN_ID === 97 ? bscTestnet : bsc,
  transport: http(BSC_RPC_URL),
});
const bountyCache = new Map<string, { value: string | null; expiresAt: number }>();

async function bountyFor(chainRepoId: number, issueNumber: number): Promise<string | null> {
  if (FORGE_CONTRACT_ADDRESS === '') return null;
  const key = `${chainRepoId}:${issueNumber}`;
  const cached = bountyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  let value: string | null = null;
  try {
    const amount = await bountyClient.readContract({
      address: FORGE_CONTRACT_ADDRESS,
      abi: FORGE_ABI,
      functionName: 'getBounty',
      args: [BigInt(chainRepoId), BigInt(issueNumber)],
    });
    value = amount.toString();
  } catch {
    value = null;
  }
  bountyCache.set(key, { value, expiresAt: Date.now() + 30_000 });
  return value;
}

// ---------------------------------------------------------------------------
// UI static files (GET / and /ui/*). No QR-code login anywhere: the UI uses
// the injected EIP-1193 provider (MetaMask / Binance Wallet extension) only.
// ---------------------------------------------------------------------------

const UI_DIR = join(here, 'ui');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function sendText(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) });
  res.end(body);
}

async function handleUi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (req.method !== 'GET') return false;
  // Runtime config for the browser UI (public values only — no secrets).
  if (url.pathname === '/ui/config.js') {
    sendText(
      res,
      200,
      `window.AGENTFORGE_CONFIG = ${JSON.stringify({
        contractAddress: FORGE_CONTRACT_ADDRESS,
        chainId: FORGE_CHAIN_ID,
        rpcUrl: BSC_RPC_URL,
        agentIdRegistry: AGENT_ID_REGISTRY,
      })};\n`,
      'text/javascript; charset=utf-8',
    );
    return true;
  }
  if (url.pathname === '/ui/abi.json') {
    const abiPath = join(here, 'abi', 'ForgeRegistry.json');
    if (existsSync(abiPath)) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      createReadStream(abiPath).pipe(res);
      return true;
    }
    return false;
  }
  let filePath: string | null = null;
  if (url.pathname === '/') filePath = join(UI_DIR, 'index.html');
  else if (url.pathname.startsWith('/ui/')) {
    const rel = decodeURIComponent(url.pathname.slice('/ui/'.length));
    const resolved = resolve(UI_DIR, rel);
    if (resolved.startsWith(UI_DIR + '/') || resolved === UI_DIR) filePath = resolved;
  }
  if (filePath === null || !existsSync(filePath) || !filePath.startsWith(UI_DIR)) return false;
  const ext = extname(filePath);
  res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(res);
  return true;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const server = createApp({
  resolveSession,
  devViewer: DEV_VIEWER,
  onMutate: scheduleSave,
  bountyFor,
  extraHandler: async (req, res) => {
    if (await handleAgentId(req, res)) return true;
    if (await handleUi(req, res)) return true;
    return false;
  },
});

server.listen(PORT, () => {
  console.log(`[agentforge] listening on :${PORT}`);
  console.log(`[agentforge] chain ${FORGE_CHAIN_ID}, agent-id registry ${AGENT_ID_REGISTRY}`);
  console.log(`[agentforge] forge contract: ${FORGE_CONTRACT_ADDRESS === '' ? '(not deployed yet — set CONTRACT_ADDRESS)' : FORGE_CONTRACT_ADDRESS}`);
  console.log(`[agentforge] dev viewer fallback: ${DEV_VIEWER ? 'ON (local dev only)' : 'off'}`);
});

function shutdown(signal: string): void {
  console.log(`[agentforge] ${signal} — saving store`);
  if (savePending) saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
