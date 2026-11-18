// Agent ID auth for AgentForge (Binance Agent ID Hackathon).
//
// Flow (plain message, EIP-191):
//   POST /agentid/login  {handle, address}            -> challenge + nonce
//   POST /agentid/verify {handle, address, signature} -> on-chain check, session token
//   GET  /agentid/me     (Bearer session)             -> {address, handle, handleAi, avatarUrl}
//
// Flow (typed data, EIP-712) — same challenge/on-chain checks, for wallets
// that can only sign typed data (e.g. Binance Agentic Wallet via baw CLI):
//   POST /agentid/login-typed  {handle, address}            -> challenge + typedData
//   POST /agentid/verify-typed {handle, address, signature} -> on-chain check, session token
//
// On-chain check (BSC, registry is a constructor/env parameter):
//   tokenId = uint256(keccak256(bytes(handle)))   // handle lowercase, WITHOUT ".ai"
//   ownerOf(tokenId) == address  AND  balanceOf(address) > 0
// The handle is supplied by the user and verified on-chain; there is no
// on-chain reverse lookup (address -> handle), so we never resolve arbitrary
// names to addresses — only the logged-in user's own handle is ever shown.
//
// No private keys, seed phrases or pairing codes are ever handled here.
// Sessions are random 32-byte tokens, server-side only, 24h expiry.

import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createPublicClient, http, keccak256, toHex, verifyMessage, verifyTypedData, type Address } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import type { ForgeUser } from './app.ts';

// ---------------------------------------------------------------------------
// Config (env-overridable; defaults are BSC mainnet per SPEC.md)
// ---------------------------------------------------------------------------

export const AGENT_ID_REGISTRY_MAINNET = '0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F' as Address;
const CHAIN_ID = Number(process.env.CHAIN_ID ?? '56');
export const AGENT_ID_REGISTRY = (process.env.AGENT_ID_REGISTRY ?? AGENT_ID_REGISTRY_MAINNET) as Address;
export const BSC_RPC_URL = process.env.BSC_RPC_URL
  ?? (CHAIN_ID === 97 ? 'https://data-seed-prebsc-1-s1.bnbchain.org:8545' : 'https://bsc-dataseed.bnbchain.org');
export const FORGE_CONTRACT_ADDRESS = (process.env.CONTRACT_ADDRESS ?? '') as Address | '';
export const FORGE_CHAIN_ID = Number(process.env.FORGE_CHAIN_ID ?? CHAIN_ID);

const chain = CHAIN_ID === 97 ? bscTestnet : bsc;
const publicClient = createPublicClient({ chain, transport: http(BSC_RPC_URL) });

const AGENT_ID_ABI = [
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'tokenURI', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'string' }] },
] as const;

// ---------------------------------------------------------------------------
// Challenges + sessions (in-memory; sessions also accepted as Bearer tokens
// for the REST / GraphQL / MCP endpoints via resolveSession)
// ---------------------------------------------------------------------------

const NONCE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

interface Challenge { nonce: string; message: string; expiresAt: number }
const challenges = new Map<string, Challenge>();

// Stateless nonces: `<hex ms timestamp>-<16 hex random chars>`.
// The timestamp is part of the nonce itself, so verify can check freshness
// without the in-memory challenges map — the map is only a best-effort
// fallback. This matters on hosts that recycle/sleep the process between the
// login and verify requests (the map would be empty on verify, and every
// login would fail with "challenge expired").
export function issueNonce(): string {
  return `${Date.now().toString(16)}-${randomBytes(8).toString('hex')}`;
}

function nonceIssuedAtMs(nonce: unknown): number | null {
  if (typeof nonce !== 'string') return null;
  const m = /^([0-9a-f]+)-[0-9a-f]{16}$/.exec(nonce);
  if (!m) return null;
  const ms = Number.parseInt(m[1], 16);
  return Number.isSafeInteger(ms) ? ms : null;
}

function nonceIsFresh(nonce: unknown): boolean {
  const issuedAt = nonceIssuedAtMs(nonce);
  if (issuedAt === null) return false;
  const now = Date.now();
  return issuedAt <= now + 60_000 && now - issuedAt <= NONCE_TTL_MS;
}

export interface Session { address: Address; handle: string; expiresAt: number }
const sessions = new Map<string, Session>();

export function tokenIdForHandle(handle: string): bigint {
  return BigInt(keccak256(toHex(handle)));
}

export function challengeMessage(handle: string, nonce: string): string {
  return `Sign in to AgentForge as ${handle}.ai\n\nNonce: ${nonce}`;
}

// ---------------------------------------------------------------------------
// EIP-712 typed-data login (same nonce/challenge, signed as typed data).
// Domain chainId follows FORGE_CHAIN_ID (56 on mainnet, 97 on testnet).
// ---------------------------------------------------------------------------

const TYPED_LOGIN_DOMAIN = { name: 'AgentForge', version: '1', chainId: FORGE_CHAIN_ID } as const;
const TYPED_LOGIN_TYPES = { Login: [{ name: 'handle', type: 'string' }, { name: 'nonce', type: 'string' }] } as const;

export function typedDataForLogin(handle: string, nonce: string) {
  return {
    domain: TYPED_LOGIN_DOMAIN,
    types: TYPED_LOGIN_TYPES,
    primaryType: 'Login' as const,
    message: { handle, nonce },
  };
}

function sessionUser(session: Session): ForgeUser {
  return {
    login: session.handle,
    id: 100000 + (Number(BigInt(`0x${createHash('sha256').update(session.handle).digest('hex').slice(0, 8)}`)) % 900000),
    name: `${session.handle}.ai`,
    email: '',
    address: session.address,
    handle: session.handle,
  };
}

export function resolveSession(token: string): ForgeUser | null {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return sessionUser(session);
}

// ---------------------------------------------------------------------------
// Avatar: tokenURI(tokenId) metadata, cached, failure tolerated
// ---------------------------------------------------------------------------

const avatarCache = new Map<string, { url: string | null; expiresAt: number }>();

async function fetchAvatar(handle: string): Promise<string | null> {
  const cached = avatarCache.get(handle);
  if (cached && cached.expiresAt > Date.now()) return cached.url;
  let url: string | null = null;
  try {
    const uri = await publicClient.readContract({
      address: AGENT_ID_REGISTRY,
      abi: AGENT_ID_ABI,
      functionName: 'tokenURI',
      args: [tokenIdForHandle(handle)],
    });
    const metaUrl = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice('ipfs://'.length)}` : uri;
    const res = await fetch(metaUrl, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const meta = (await res.json()) as { image?: string };
      if (typeof meta.image === 'string' && meta.image !== '') {
        url = meta.image.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${meta.image.slice('ipfs://'.length)}` : meta.image;
      }
    }
  } catch {
    url = null; // Avatar is best-effort; login works without it.
  }
  avatarCache.set(handle, { url, expiresAt: Date.now() + 10 * 60 * 1000 });
  return url;
}

// ---------------------------------------------------------------------------
// HTTP plumbing (shared shape with app.ts helpers)
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
  res.end(text);
}

async function readJsonBody(req: IncomingMessage): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  if (chunks.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return { ok: true, value: typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {} };
  } catch {
    return { ok: false };
  }
}

function validHandle(handle: unknown): handle is string {
  return typeof handle === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(handle);
}

function validAddress(address: unknown): address is Address {
  return typeof address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(address);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function handleAgentId(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  if (req.method === 'POST' && path === '/agentid/login') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'Problems parsing JSON' });
      return true;
    }
    const { handle, address } = parsed.value;
    if (!validHandle(handle) || !validAddress(address)) {
      sendJson(res, 400, { error: 'handle (lowercase, without .ai) and a valid address are required' });
      return true;
    }
    const nonce = issueNonce();
    const message = challengeMessage(handle, nonce);
    challenges.set(address.toLowerCase(), { nonce, message, expiresAt: Date.now() + NONCE_TTL_MS });
    sendJson(res, 200, { handle, handleAi: `${handle}.ai`, address, nonce, message });
    return true;
  }

  if (req.method === 'POST' && path === '/agentid/login-typed') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'Problems parsing JSON' });
      return true;
    }
    const { handle, address } = parsed.value;
    if (!validHandle(handle) || !validAddress(address)) {
      sendJson(res, 400, { error: 'handle (lowercase, without .ai) and a valid address are required' });
      return true;
    }
    const nonce = issueNonce();
    const typedData = typedDataForLogin(handle, nonce);
    // Stored in the same challenges map as the plain flow; verify-typed
    // reconstructs the typed data from the stored nonce.
    challenges.set(address.toLowerCase(), { nonce, message: JSON.stringify(typedData), expiresAt: Date.now() + NONCE_TTL_MS });
    sendJson(res, 200, { handle, handleAi: `${handle}.ai`, address, nonce, typedData });
    return true;
  }

  if (req.method === 'POST' && path === '/agentid/verify') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'Problems parsing JSON' });
      return true;
    }
    const { handle, address, signature, nonce } = parsed.value;
    if (!validHandle(handle) || !validAddress(address) || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      sendJson(res, 400, { error: 'handle, address and signature are required' });
      return true;
    }
    // Resolve the signed message: prefer the client-supplied stateless nonce
    // (its timestamp proves freshness), fall back to the stored challenge.
    let message: string;
    if (typeof nonce === 'string' && nonce !== '') {
      if (!nonceIsFresh(nonce)) {
        sendJson(res, 401, { error: 'challenge expired — request a new one via /agentid/login' });
        return true;
      }
      message = challengeMessage(handle, nonce);
    } else {
      const challenge = challenges.get(address.toLowerCase());
      if (!challenge || challenge.expiresAt < Date.now()) {
        sendJson(res, 401, { error: 'challenge expired — request a new one via /agentid/login' });
        return true;
      }
      message = challenge.message;
    }
    // 1) Signature must match the challenge for this handle.
    let sigOk = false;
    try {
      sigOk = await verifyMessage({ address, message, signature: signature as `0x${string}` });
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      sendJson(res, 401, { error: 'signature does not match the challenge' });
      return true;
    }
    // 2) On-chain: the signer must own the Agent ID for this handle.
    const tokenId = tokenIdForHandle(handle);
    try {
      const [owner, balance] = await Promise.all([
        publicClient.readContract({ address: AGENT_ID_REGISTRY, abi: AGENT_ID_ABI, functionName: 'ownerOf', args: [tokenId] }),
        publicClient.readContract({ address: AGENT_ID_REGISTRY, abi: AGENT_ID_ABI, functionName: 'balanceOf', args: [address] }),
      ]);
      if (owner.toLowerCase() !== address.toLowerCase() || balance === 0n) {
        sendJson(res, 403, { error: `address does not own the Agent ID for ${handle}.ai` });
        return true;
      }
    } catch (err) {
      sendJson(res, 502, { error: `on-chain Agent ID check failed: ${err instanceof Error ? err.message : String(err)}` });
      return true;
    }
    challenges.delete(address.toLowerCase());
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { address, handle, expiresAt: Date.now() + SESSION_TTL_MS });
    sendJson(res, 200, { token, handle, handleAi: `${handle}.ai`, address, expiresInSeconds: SESSION_TTL_MS / 1000 });
    return true;
  }

  if (req.method === 'POST' && path === '/agentid/verify-typed') {
    const parsed = await readJsonBody(req);
    if (!parsed.ok) {
      sendJson(res, 400, { error: 'Problems parsing JSON' });
      return true;
    }
    const { handle, address, signature, nonce } = parsed.value;
    if (!validHandle(handle) || !validAddress(address) || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      sendJson(res, 400, { error: 'handle, address and signature are required' });
      return true;
    }
    // Resolve the signed nonce: prefer the client-supplied stateless nonce
    // (its timestamp proves freshness), fall back to the stored challenge.
    let nonceValue: string;
    if (typeof nonce === 'string' && nonce !== '') {
      if (!nonceIsFresh(nonce)) {
        sendJson(res, 401, { error: 'challenge expired — request a new one via /agentid/login-typed' });
        return true;
      }
      nonceValue = nonce;
    } else {
      const challenge = challenges.get(address.toLowerCase());
      if (!challenge || challenge.expiresAt < Date.now()) {
        sendJson(res, 401, { error: 'challenge expired — request a new one via /agentid/login-typed' });
        return true;
      }
      nonceValue = challenge.nonce;
    }
    // 1) Signature must match the typed-data challenge for this handle.
    const typedData = typedDataForLogin(handle, nonceValue);
    let sigOk = false;
    try {
      sigOk = await verifyTypedData({
        address,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: signature as `0x${string}`,
      });
    } catch {
      sigOk = false;
    }
    if (!sigOk) {
      sendJson(res, 401, { error: 'signature does not match the challenge' });
      return true;
    }
    // 2) On-chain: the signer must own the Agent ID for this handle.
    const tokenId = tokenIdForHandle(handle);
    try {
      const [owner, balance] = await Promise.all([
        publicClient.readContract({ address: AGENT_ID_REGISTRY, abi: AGENT_ID_ABI, functionName: 'ownerOf', args: [tokenId] }),
        publicClient.readContract({ address: AGENT_ID_REGISTRY, abi: AGENT_ID_ABI, functionName: 'balanceOf', args: [address] }),
      ]);
      if (owner.toLowerCase() !== address.toLowerCase() || balance === 0n) {
        sendJson(res, 403, { error: `address does not own the Agent ID for ${handle}.ai` });
        return true;
      }
    } catch (err) {
      sendJson(res, 502, { error: `on-chain Agent ID check failed: ${err instanceof Error ? err.message : String(err)}` });
      return true;
    }
    challenges.delete(address.toLowerCase());
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { address, handle, expiresAt: Date.now() + SESSION_TTL_MS });
    sendJson(res, 200, { token, handle, handleAi: `${handle}.ai`, address, expiresInSeconds: SESSION_TTL_MS / 1000 });
    return true;
  }

  if (req.method === 'GET' && path === '/agentid/me') {
    const header = req.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const session = token === '' ? undefined : sessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (session) sessions.delete(token);
      sendJson(res, 401, { error: 'Requires authentication' });
      return true;
    }
    const avatarUrl = await fetchAvatar(session.handle);
    sendJson(res, 200, { address: session.address, handle: session.handle, handleAi: `${session.handle}.ai`, avatarUrl });
    return true;
  }

  return false;
}
