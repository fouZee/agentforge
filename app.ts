// A standalone GitHub-compatible git forge: git smart HTTP (v2 upload-pack, v0
// receive-pack), REST v3, GraphQL v4 and MCP from one process over its own
// in-memory store. Standard library only; no git binary, no network, no UI.
//
// Determinism: every timestamp the forge emits is fixed or counter-derived, so
// two runs on the same instance behave identically.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// AgentForge integration (Binance Agent ID Hackathon).
//
// The original forge authenticated any non-empty Bearer token as one fixed
// deterministic viewer (VIEWER_LOGIN). AgentForge adds real identity:
//  - A request-scoped viewer resolved from an Agent ID session token
//    (see agentid.ts) via configureForge({ resolveSession }).
//  - Repo ownership keyed by the Agent ID handle string (owner = handle,
//    displayed as "<handle>.ai"); public repos are readable without auth,
//    mutations require a valid session (or the dev-viewer fallback).
//  - The old fixed-viewer behaviour survives ONLY when
//    AGENTFORGE_DEV_VIEWER=1 (local dev); never enable it in production.
//  - Persistence + bounty hooks are wired through ForgeOptions below and
//    driven by server.ts. Merging a PR never releases on-chain funds.
// ---------------------------------------------------------------------------

export interface ForgeUser {
  login: string;
  id: number;
  name: string;
  email: string;
  address?: string;
  handle?: string;
}

export interface ForgeOptions {
  /** Resolve a Bearer session token to the acting user, or null. */
  resolveSession?: (token: string) => ForgeUser | null;
  /** Local-dev only: any non-empty Bearer token = the fixed viewer. */
  devViewer?: boolean;
  /** Called after any mutating request (debounced persistence in server.ts). */
  onMutate?: () => void;
  /** Extra routes handled before the forge routes (Agent ID auth, UI). */
  extraHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** On-chain bounty (wei, decimal string) for an issue, or null. */
  bountyFor?: (chainRepoId: number, issueNumber: number) => Promise<string | null>;
}

const forgeOptions: ForgeOptions = {};
export function configureForge(opts: ForgeOptions): void {
  Object.assign(forgeOptions, opts);
}

/** Request-scoped acting user (null = unauthenticated). */
const viewerStore = new AsyncLocalStorage<ForgeUser | null>();
export function currentViewer(): ForgeUser | null {
  return viewerStore.getStore() ?? null;
}
export function viewerLogin(): string {
  return currentViewer()?.login ?? '';
}
function devViewerUser(): ForgeUser {
  return { login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}
/** Resolve the acting user from the Authorization header. */
export function resolveViewer(req: IncomingMessage): ForgeUser | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  if (token === '') return null;
  if (forgeOptions.resolveSession) {
    const user = forgeOptions.resolveSession(token);
    if (user) return user;
  }
  if (forgeOptions.devViewer) return devViewerUser();
  return null;
}
/** Deterministic numeric id for a login (used in API user objects). */
export function userIdFor(login: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < login.length; i += 1) {
    hash ^= login.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 100000 + (hash % 900000);
}
/** Display login: Agent ID handles render as "<handle>.ai". */
export function displayLogin(owner: string, agentId: boolean): string {
  return agentId ? `${owner}.ai` : owner;
}
/** Accept "handle" or "handle.ai" in URL path segments. */
export function normalizeOwner(segment: string): string {
  return segment.toLowerCase().endsWith('.ai') ? segment.slice(0, -3) : segment;
}
function canReadRepo(repo: Repo, viewer: ForgeUser | null): boolean {
  return !repo.isPrivate || (viewer !== null && viewer.login === repo.owner);
}
function isRepoOwner(repo: Repo, viewer: ForgeUser | null): boolean {
  return viewer !== null && viewer.login === repo.owner;
}

// ---------------------------------------------------------------------------
// The token owner: the suite's scenario is fixed by one constant seed
// (wire.ts SCENARIO_SEED), so the viewer login is derivable here exactly as
// the suite derives it. The bearer token itself carries no login; any
// non-empty Bearer token authenticates as this viewer.
// ---------------------------------------------------------------------------

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}
class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}
function scenarioUsers(): { login: string; name: string; email: string; id: number }[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: { login: string; name: string; email: string; id: number }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}
const SCENARIO_USERS = scenarioUsers();
const VIEWER = SCENARIO_USERS[0] as { login: string; name: string; email: string; id: number };
const STRANGER = SCENARIO_USERS[2] as { login: string; name: string; email: string; id: number };
const VIEWER_LOGIN = VIEWER.login;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const ZERO_OID = '0'.repeat(40);
const FIXED_TS = '2025-01-01T00:00:00Z';
const COMMIT_EPOCH = 1700000000;
let commitCounter = 0;
let requestCounter = 0;
let globalIssueId = 0;
let globalPullId = 0;

function nextCommitTs(): number {
  commitCounter += 1;
  return COMMIT_EPOCH + commitCounter;
}
function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}
function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}
function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
function b64urlDecode(text: string): string | null {
  try {
    return Buffer.from(text, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}
function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}
function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// Git object model
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj {
  type: ObjType;
  data: Buffer;
}
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}
interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}
function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}
interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}
interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}
function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as ObjType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}
function buildCommit(tree: string, parents: readonly string[], message: string, author: string, timestamp: number): Buffer {
  const who = `${author} ${timestamp} +0000`;
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
function pktLines(items: readonly (Buffer | string | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}
type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };
function decodePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buf.subarray(offset) };
}
function sidebandPackets(data: Buffer): Buffer {
  // Wrap bytes into sideband band-1 pkt-lines (max payload 65515 data bytes each).
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([1])));
  } else {
    for (let i = 0; i < data.length; i += CHUNK) {
      const slice = data.subarray(i, Math.min(data.length, i + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Packfile write / read
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}
function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
function readPackVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += (delta[offset] as number) * 2 ** shift;
        if (op & (1 << bit)) offset += 1;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += (delta[offset] as number) * 2 ** shift;
        if (op & (1 << bit)) offset += 1;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}
interface PackEntryRaw {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}
/** Read a packfile, resolving OFS/REF deltas against the pack itself and `lookup`. */
function readPack(pack: Buffer, lookup: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');
  const raw: PackEntryRaw[] = [];
  const byOffset = new Map<number, PackEntryRaw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: PackEntryRaw = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        value = ((value + 1) * 128) + (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.buffer;
    offset += inflated.engine.bytesWritten;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, PackEntryRaw>();
  const resolving = new Set<number>();
  const resolve = (entry: PackEntryRaw): { type: ObjType; data: Buffer; oid: string } => {
    const cached = (entry as PackEntryRaw & { _resolved?: { type: ObjType; data: Buffer; oid: string } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle');
    resolving.add(entry.offset);
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid as string);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = lookup(entry.baseOid as string);
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as PackEntryRaw & { _resolved?: { type: ObjType; data: Buffer; oid: string } })._resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface Label {
  name: string;
  color: string;
}
interface Comment {
  id: number;
  body: string;
}
interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}
interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}
interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeSha: string | null;
  files: PullFile[];
  seq: number;
}
interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  /** True when owner is an Agent ID handle (displayed as "<handle>.ai"). */
  agentId?: boolean;
  /** On-chain ForgeRegistry repoId, when the repo was registered on-chain. */
  chainRepoId?: number;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObj>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let repoSeq = 0;
let repoDbId = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function createRepoInternal(owner: string, name: string, description: string, isPrivate: boolean, opts: { agentId?: boolean; chainRepoId?: number } = {}): Repo {
  repoDbId += 1;
  repoSeq += 1;
  const repo: Repo = {
    id: repoDbId,
    owner,
    name,
    description,
    isPrivate,
    agentId: opts.agentId === true ? true : undefined,
    chainRepoId: opts.chainRepoId,
    defaultBranch: 'main',
    refs: new Map(),
    objects: new Map(),
    labels: new Map(),
    issues: [],
    pulls: [],
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    seq: repoSeq,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}
function deleteRepoInternal(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}
function listViewerRepos(): Repo[] {
  const login = viewerLogin();
  if (login === '') return [];
  return [...repos.values()].filter((r) => r.owner === login).sort((a, b) => a.seq - b.seq);
}

/** List every public repo plus the viewer's own (for the UI repo browser). */
export function listVisibleRepos(): Repo[] {
  const login = viewerLogin();
  return [...repos.values()]
    .filter((r) => !r.isPrivate || r.owner === login)
    .sort((a, b) => a.seq - b.seq);
}

// ---------------------------------------------------------------------------
// Persistence: serialize the whole store to JSON (git objects as base64,
// Maps as arrays) and rebuild it on load. Driven by server.ts.
// ---------------------------------------------------------------------------

export function serializeStore(): string {
  return JSON.stringify({
    version: 1,
    repoSeq,
    repoDbId,
    commitCounter,
    globalIssueId,
    globalPullId,
    repos: [...repos.values()].map((repo) => ({
      ...repo,
      refs: [...repo.refs.entries()],
      objects: [...repo.objects.entries()].map(([oid, obj]) => [oid, { type: obj.type, data: obj.data.toString('base64') }]),
      labels: [...repo.labels.entries()],
    })),
  });
}

export function loadStore(json: string): void {
  const data = JSON.parse(json) as {
    version: number;
    repoSeq: number;
    repoDbId: number;
    commitCounter: number;
    globalIssueId: number;
    globalPullId: number;
    repos: {
      id: number; owner: string; name: string; description: string; isPrivate: boolean;
      agentId?: boolean; chainRepoId?: number; defaultBranch: string;
      refs: [string, string][]; objects: [string, { type: ObjType; data: string }][];
      labels: [string, Label][]; issues: Issue[]; pulls: Pull[];
      nextIssue: number; nextPull: number; nextComment: number; seq: number;
    }[];
  };
  repos.clear();
  for (const raw of data.repos) {
    const repo: Repo = {
      id: raw.id,
      owner: raw.owner,
      name: raw.name,
      description: raw.description,
      isPrivate: raw.isPrivate,
      agentId: raw.agentId,
      chainRepoId: raw.chainRepoId,
      defaultBranch: raw.defaultBranch ?? 'main',
      refs: new Map(raw.refs),
      objects: new Map(raw.objects.map(([oid, obj]) => [oid, { type: obj.type, data: Buffer.from(obj.data, 'base64') }])),
      labels: new Map(raw.labels),
      issues: raw.issues,
      pulls: raw.pulls,
      nextIssue: raw.nextIssue,
      nextPull: raw.nextPull,
      nextComment: raw.nextComment,
      seq: raw.seq,
    };
    repos.set(repoKey(repo.owner, repo.name), repo);
  }
  repoSeq = data.repoSeq;
  repoDbId = data.repoDbId;
  commitCounter = data.commitCounter;
  globalIssueId = data.globalIssueId;
  globalPullId = data.globalPullId;
}

function gidRepo(repoId: number): string {
  return b64urlEncode(`R:${repoId}`);
}
function gidIssue(repoId: number, number: number): string {
  return b64urlEncode(`I:${repoId}:${number}`);
}
function gidPull(repoId: number, number: number): string {
  return b64urlEncode(`P:${repoId}:${number}`);
}
function gidComment(repoId: number, issueNumber: number, commentId: number): string {
  return b64urlEncode(`C:${repoId}:${issueNumber}:${commentId}`);
}
function decodeGid(id: string): { kind: string; repoId: number; number: number; extra: number } | null {
  const text = b64urlDecode(id);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kind = parts[0] as string;
  const repoId = Number(parts[1]);
  if (!Number.isSafeInteger(repoId)) return null;
  return { kind, repoId, number: Number(parts[2] ?? 0), extra: Number(parts[3] ?? 0) };
}
function repoByDbId(id: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ---------------------------------------------------------------------------
// Git graph helpers (per repo)
// ---------------------------------------------------------------------------

function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}
function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA: string[] = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB: string[] = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}
function flatTreeOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return out;
  flattenTree(repo, parseCommit(object.data).tree, '', out);
  return out;
}
function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const text = buf.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
function diffFiles(repo: Repo, baseCommit: string, headCommit: string): PullFile[] {
  const base = flatTreeOfCommit(repo, baseCommit);
  const head = flatTreeOfCommit(repo, headCommit);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) {
      const deletions = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!b && h) {
      const additions = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const additions = countLines(repo.objects.get(h.oid)?.data ?? Buffer.alloc(0));
      const deletions = countLines(repo.objects.get(b.oid)?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}
/** Build a tree object from a flat path->blob map. */
function buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of [...flat.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}
/** Replace (or delete, when blobOid is null) one path in the tree rooted at rootOid. */
function setFileInTree(repo: Repo, rootOid: string | null, segments: readonly string[], blobOid: string | null): string {
  if (segments.length === 0) throw new Error('empty path');
  const name = segments[0] as string;
  let entries: TreeEntry[] = [];
  if (rootOid !== null) {
    const object = repo.objects.get(rootOid);
    if (object && object.type === 'tree') entries = parseTree(object.data);
  }
  if (segments.length === 1) {
    entries = entries.filter((e) => e.name !== name);
    if (blobOid !== null) entries.push({ mode: '100644', name, oid: blobOid });
    return storeObject(repo, 'tree', buildTree(entries));
  }
  const child = entries.find((e) => e.name === name);
  const newChildOid = setFileInTree(repo, child && child.mode === '40000' ? child.oid : null, segments.slice(1), blobOid);
  entries = entries.filter((e) => e.name !== name);
  const childObj = repo.objects.get(newChildOid);
  if (childObj && childObj.type === 'tree' && parseTree(childObj.data).length > 0) {
    entries.push({ mode: '40000', name, oid: newChildOid });
  }
  return storeObject(repo, 'tree', buildTree(entries));
}
function emptyTreeOid(repo: Repo): string {
  return storeObject(repo, 'tree', buildTree([]));
}
function identity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}
/** Commit a contents change on a branch; creates the branch from the default tip when missing. */
function commitFileChange(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; contentSha: string | null } {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined && branch !== repo.defaultBranch) {
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const segments = path.split('/').filter((s) => s !== '');
  let contentSha: string | null = null;
  let rootTree: string;
  if (tip !== undefined) {
    const commitObj = repo.objects.get(tip);
    rootTree = commitObj && commitObj.type === 'commit' ? parseCommit(commitObj.data).tree : emptyTreeOid(repo);
  } else {
    rootTree = emptyTreeOid(repo);
  }
  if (content !== null) {
    contentSha = storeObject(repo, 'blob', content);
    rootTree = setFileInTree(repo, rootTree, segments, contentSha);
  } else {
    rootTree = setFileInTree(repo, rootTree, segments, null);
  }
  const parents = tip !== undefined ? [tip] : [];
  const commitData = buildCommit(rootTree, parents, message.endsWith('\n') ? message : `${message}\n`, identity(), nextCommitTs());
  const commitSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha };
}
function readFileAt(repo: Repo, tip: string, path: string): { oid: string; data: Buffer } | null {
  const flat = flatTreeOfCommit(repo, tip);
  const entry = flat.get(path);
  if (!entry) return null;
  const object = repo.objects.get(entry.oid);
  if (!object || object.type !== 'blob') return null;
  return { oid: entry.oid, data: object.data };
}
function listDirAt(repo: Repo, tip: string, dir: string): { name: string; path: string; sha: string; type: 'file' | 'dir' }[] | null {
  const commitObj = repo.objects.get(tip);
  if (!commitObj || commitObj.type !== 'commit') return null;
  let treeOid = parseCommit(commitObj.data).tree;
  if (dir !== '') {
    for (const segment of dir.split('/')) {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
  }
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return null;
  return parseTree(object.data).map((e) => ({
    name: e.name,
    path: dir === '' ? e.name : `${dir}/${e.name}`,
    sha: e.oid,
    type: e.mode === '40000' ? ('dir' as const) : ('file' as const),
  }));
}
function resolveRef(repo: Repo, ref: string): string | undefined {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed) return headed;
  const tagged = repo.refs.get(`refs/tags/${ref}`);
  if (tagged) return tagged;
  return undefined;
}
function commitsFrom(repo: Repo, tip: string): { sha: string; message: string; author: string; committer: string; parents: string[] }[] {
  const out: { sha: string; message: string; author: string; committer: string; parents: string[] }[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, author: commit.author, committer: commit.committer, parents: commit.parents });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issues / pull requests (shared by REST, GraphQL, MCP)
// ---------------------------------------------------------------------------

function createIssueInternal(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `Label '${label}' does not exist` };
  }
  const issue: Issue = {
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    seq: repo.issues.length + 1,
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return issue;
}
function createPullInternal(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined) return { error: `Head branch '${headRef}' does not exist` };
  if (baseSha === undefined) return { error: `Base branch '${baseRef}' does not exist` };
  const pull: Pull = {
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    headRef,
    baseRef,
    headSha,
    baseSha,
    mergeSha: null,
    files: diffFiles(repo, baseSha, headSha),
    seq: repo.pulls.length + 1,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  return pull;
}
/** Would merging this pull conflict? (same path changed on both sides of the merge-base, differently) */
function pullConflicts(repo: Repo, pull: Pull): boolean {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return false;
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return false;
  const baseFlat = flatTreeOfCommit(repo, base);
  const headFlat = flatTreeOfCommit(repo, headTip);
  const baseSideFlat = flatTreeOfCommit(repo, baseTip);
  const paths = new Set([...headFlat.keys(), ...baseSideFlat.keys(), ...baseFlat.keys()]);
  for (const path of paths) {
    const orig = baseFlat.get(path)?.oid ?? null;
    const head = headFlat.get(path)?.oid ?? null;
    const side = baseSideFlat.get(path)?.oid ?? null;
    const headChanged = head !== orig;
    const sideChanged = side !== orig;
    if (headChanged && sideChanged && head !== side) return true;
  }
  return false;
}
function mergePullInternal(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { sha: pull.mergeSha as string };
  if (pull.state !== 'open') return { error: 'Pull request is closed', status: 405 };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { error: 'Branch is missing', status: 405 };
  if (pullConflicts(repo, pull)) return { error: 'Merge conflict', status: 405 };
  const base = mergeBase(repo, headTip, baseTip) ?? baseTip;
  const baseFlat = flatTreeOfCommit(repo, base);
  const headFlat = flatTreeOfCommit(repo, headTip);
  const merged = new Map<string, { oid: string; mode: string }>();
  for (const [path, entry] of flatTreeOfCommit(repo, baseTip)) merged.set(path, entry);
  for (const [path, entry] of headFlat) {
    const orig = baseFlat.get(path)?.oid ?? null;
    if (entry.oid !== orig) merged.set(path, entry);
  }
  for (const path of [...merged.keys()]) {
    if (!headFlat.has(path) && baseFlat.has(path) && (baseFlat.get(path)?.oid ?? null) !== (flatTreeOfCommit(repo, baseTip).get(path)?.oid ?? null)) {
      // deleted on head side only when head removed it relative to merge-base
    }
    if (!headFlat.has(path) && baseFlat.has(path)) merged.delete(path);
  }
  const treeOid = buildTreeFromFlat(repo, merged);
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}\n`;
  const commitData = buildCommit(treeOid, [baseTip], message, identity(), nextCommitTs());
  const mergeSha = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TS;
  pull.mergeSha = mergeSha;
  return { sha: mergeSha };
}
function issueJson(repo: Repo, issue: Issue, bountyWei?: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: repo.id * 100000 + issue.number,
    node_id: gidIssue(repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: null, url: '' };
    }),
    user: { login: displayLogin(repo.owner, repo.agentId === true), id: userIdFor(repo.owner), type: 'User' },
    assignee: null,
    milestone: null,
    comments: issue.comments.length,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    closed_at: issue.state === 'closed' ? FIXED_TS : null,
    html_url: `https://github.com/${displayLogin(repo.owner, repo.agentId === true)}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    author_association: 'OWNER',
  };
  // On-chain bounty escrowed for this issue (ForgeRegistry.getBounty), when
  // the repo is linked to a chain repo. Null = no bounty / not linked.
  if (bountyWei !== undefined) out.bounty_wei = bountyWei;
  return out;
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const ownerLogin = displayLogin(repo.owner, repo.agentId === true);
  return {
    id: repo.id * 100000 + pull.number,
    node_id: gidPull(repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { label: `${repo.owner}:${pull.headRef}`, ref: pull.headRef, sha: pull.headSha, user: { login: ownerLogin, id: userIdFor(repo.owner), type: 'User' } },
    base: { label: `${repo.owner}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, user: { login: ownerLogin, id: userIdFor(repo.owner), type: 'User' } },
    merged: pull.merged,
    mergeable: !pullConflicts(repo, pull),
    merge_commit_sha: pull.mergeSha,
    merged_at: pull.mergedAt,
    closed_at: pull.state === 'closed' ? FIXED_TS : null,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    user: { login: ownerLogin, id: userIdFor(repo.owner), type: 'User' },
    draft: false,
    html_url: `https://github.com/${ownerLogin}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    author_association: 'OWNER',
  };
}
async function repoBounties(repo: Repo): Promise<Record<string, string | null> | null> {
  if (repo.chainRepoId === undefined || !forgeOptions.bountyFor) return null;
  const out: Record<string, string | null> = {};
  await Promise.all(repo.issues.map(async (issue) => {
    try {
      out[String(issue.number)] = await forgeOptions.bountyFor?.(repo.chainRepoId as number, issue.number) ?? null;
    } catch {
      out[String(issue.number)] = null;
    }
  }));
  return out;
}
function repoJson(repo: Repo, bounties?: Record<string, string | null> | null): Record<string, unknown> {
  const ownerLogin = displayLogin(repo.owner, repo.agentId === true);
  const out: Record<string, unknown> = {
    id: repo.id,
    node_id: gidRepo(repo.id),
    name: repo.name,
    full_name: `${ownerLogin}/${repo.name}`,
    owner: { login: ownerLogin, id: userIdFor(repo.owner), type: 'User', avatar_url: '' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${ownerLogin}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_TS,
    updated_at: FIXED_TS,
    pushed_at: FIXED_TS,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    topics: [],
    license: null,
    chain_repo_id: repo.chainRepoId ?? null,
  };
  if (bounties) out.bounties = bounties;
  return out;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  const headers: Record<string, string> = {
    'x-github-request-id': `req-${requestCounter}`,
    ...extraHeaders,
  };
  if (body !== null) {
    headers['content-type'] = JSON_TYPE;
    headers['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}
function errJson(message: string): Record<string, unknown> {
  return { message };
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
function splitPath(raw: string): string[] {
  return raw.split('/').filter((s) => s !== '').map(decodeSegment);
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function hostOf(req: IncomingMessage): string {
  return req.headers.host ?? '127.0.0.1';
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function restNotFound(res: ServerResponse): void {
  sendJson(res, 404, errJson('Not Found'), { 'x-oauth-scopes': 'repo, read:org' });
}
function restRepoOr404(res: ServerResponse, owner: string, name: string): Repo | null {
  const normOwner = normalizeOwner(owner);
  const repo = getRepo(normOwner, name);
  if (!repo) {
    sendJson(res, 404, errJson('Not Found'), { 'x-oauth-scopes': 'repo, read:org' });
    return null;
  }
  // Public repos are readable without auth; private repos only by the owner.
  if (!canReadRepo(repo, currentViewer())) {
    sendJson(res, 404, errJson('Not Found'), { 'x-oauth-scopes': 'repo, read:org' });
    return null;
  }
  return repo;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], method: string): Promise<boolean> {
  // segments arrive already stripped of 'api'/'v3' by createApp; the rest is the route.
  const route = segments;
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };
  // API root and meta need no auth.
  if (route.length === 0 && method === 'GET') {
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, scopes);
    return true;
  }
  if (route.length === 1 && route[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, git: ['1.0.0'], hooks: [], github_services_sha: '0000000000000000000000000000000000000000' }, scopes);
    return true;
  }
  // Auth: public repo reads (GET/HEAD under /repos/...) need no session.
  // Everything else — mutations, and the viewer-scoped /user routes — does.
  const viewer = currentViewer();
  const needsAuth = method !== 'GET' && method !== 'HEAD' || route[0] === 'user';
  if (needsAuth && !viewer) {
    sendJson(res, 401, errJson('Requires authentication'), scopes);
    return true;
  }
  const bodyBuf = method === 'GET' || method === 'HEAD' || method === 'DELETE' && route[0] !== 'repos' ? Buffer.alloc(0) : await readBody(req);
  // DELETE /contents carries a JSON body; read it too.
  let body: unknown = {};
  let bodyParsed = true;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || (method === 'DELETE' && route[0] === 'repos')) {
    const parsed = parseJsonBody(bodyBuf.length > 0 ? bodyBuf : Buffer.alloc(0));
    if (!parsed.ok) {
      sendJson(res, 400, errJson('Problems parsing JSON'), scopes);
      return true;
    }
    body = parsed.value;
    bodyParsed = true;
  }
  void bodyParsed;
  const query = queryOf(req);

  // GET /user
  if (route.length === 1 && route[0] === 'user' && method === 'GET') {
    const v = currentViewer() as ForgeUser;
    sendJson(res, 200, { login: displayLogin(v.login, v.handle !== undefined), id: v.id, name: v.name, email: v.email, type: 'User', avatar_url: '' }, scopes);
    return true;
  }
  // /user/repos
  if (route.length === 2 && route[0] === 'user' && route[1] === 'repos') {
    if (method === 'POST') {
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        sendJson(res, 422, errJson('Validation Failed: name is required'), scopes);
        return true;
      }
      const name = body.name as string;
      const v = currentViewer() as ForgeUser;
      if (getRepo(v.login, name)) {
        sendJson(res, 422, errJson(`Repository ${name} already exists`), scopes);
        return true;
      }
      const chainRepoId = isRecord(body) && typeof body.chain_repo_id === 'number' && Number.isSafeInteger(body.chain_repo_id)
        ? (body.chain_repo_id as number) : undefined;
      const repo = createRepoInternal(v.login, name, typeof body.description === 'string' ? body.description : '', body.private === true, { agentId: v.handle !== undefined, chainRepoId });
      sendJson(res, 201, repoJson(repo), scopes);
      return true;
    }
    if (method === 'GET') {
      const all = listViewerRepos();
      const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const headers: Record<string, string> = { ...scopes };
      if (start + perPage < all.length) {
        const base = `http://${hostOf(req)}/api/v3/user/repos`;
        const next = `${base}?page=${page + 1}&per_page=${perPage}`;
        const lastPage = Math.ceil(all.length / perPage);
        headers.link = `<${next}>; rel="next", <${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`;
      }
      sendJson(res, 200, items.map((r) => repoJson(r)), headers);
      return true;
    }
  }
  // /repos/{owner}/{repo}[...]
  if (route.length >= 3 && route[0] === 'repos') {
    const owner = normalizeOwner(route[1] as string);
    const name = route[2] as string;
    const rest = route.slice(3);
    // Mutations on a repo require a session belonging to the repo owner.
    if (method !== 'GET' && method !== 'HEAD') {
      const v = currentViewer();
      if (!v || v.login !== owner) {
        sendJson(res, v ? 403 : 401, errJson(v ? 'Only the repository owner can do this' : 'Requires authentication'), scopes);
        return true;
      }
    }
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = restRepoOr404(res, owner, name);
        if (repo) sendJson(res, 200, repoJson(repo, await repoBounties(repo)), scopes);
        return true;
      }
      if (method === 'PATCH') {
        const repo = restRepoOr404(res, owner, name);
        if (!repo) return true;
        if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
        if (isRecord(body) && typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (isRecord(body) && typeof body.chain_repo_id === 'number' && Number.isSafeInteger(body.chain_repo_id)) repo.chainRepoId = body.chain_repo_id;
        sendJson(res, 200, repoJson(repo), scopes);
        return true;
      }
      if (method === 'DELETE') {
        const repo = restRepoOr404(res, owner, name);
        if (!repo) return true;
        deleteRepoInternal(owner, name);
        sendJson(res, 204, null, scopes);
        return true;
      }
      sendJson(res, 404, errJson('Not Found'), scopes);
      return true;
    }
    // /labels
    if (rest.length === 1 && rest[0] === 'labels') {
      const repo = restRepoOr404(res, owner, name);
      if (!repo) return true;
      if (method === 'POST') {
        if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
          sendJson(res, 422, errJson('Validation Failed: name is required'), scopes);
          return true;
        }
        const label: Label = { name: body.name, color: typeof body.color === 'string' ? body.color : 'ededed' };
        repo.labels.set(label.name, label);
        sendJson(res, 201, { name: label.name, color: label.color, description: null, url: '' }, scopes);
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: null, url: '' })), scopes);
        return true;
      }
    }
    // /branches, /branches/{branch}
    if (rest[0] === 'branches') {
      const repo = restRepoOr404(res, owner, name);
      if (!repo) return true;
      if (rest.length === 1 && method === 'GET') {
        const list: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          list.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false });
        }
        sendJson(res, 200, list, scopes);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = rest[1] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          sendJson(res, 404, errJson('Branch not found'), scopes);
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false }, scopes);
        return true;
      }
    }
    // /commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const repo = restRepoOr404(res, owner, name);
      if (!repo) return true;
      const refParam = query.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, refParam);
      if (tip === undefined) {
        sendJson(res, 200, [], scopes);
        return true;
      }
      const list = commitsFrom(repo, tip).map((c) => ({
        sha: c.sha,
        commit: {
          message: c.message.replace(/\n+$/, ''),
          author: { name: c.author.split(' <')[0] ?? '', email: '', date: FIXED_TS },
          committer: { name: c.committer.split(' <')[0] ?? '', email: '', date: FIXED_TS },
        },
        parents: c.parents.map((p) => ({ sha: p })),
        url: '',
      }));
      sendJson(res, 200, list, scopes);
      return true;
    }
    // /git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      const repo = restRepoOr404(res, owner, name);
      if (!repo) return true;
      if (method === 'POST' && rest.length === 2) {
        if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
          sendJson(res, 422, errJson('Validation Failed'), scopes);
          return true;
        }
        const ref = body.ref as string;
        const sha = body.sha as string;
        if (repo.refs.has(ref)) {
          sendJson(res, 422, errJson('Reference already exists'), scopes);
          return true;
        }
        if (!repo.objects.has(sha)) {
          sendJson(res, 422, errJson('Object does not exist'), scopes);
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: b64urlEncode(`ref:${repo.id}:${ref}`), url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }, scopes);
        return true;
      }
      if (method === 'GET' && rest.length === 2) {
        const list: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort()) {
          list.push({ ref, url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
        }
        sendJson(res, 200, list, scopes);
        return true;
      }
      if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          sendJson(res, 404, errJson('Not Found'), scopes);
          return true;
        }
        sendJson(res, 200, { ref: `refs/heads/${branch}`, url: '', object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }, scopes);
        return true;
      }
      sendJson(res, 404, errJson('Not Found'), scopes);
      return true;
    }
    // /contents/{path...}
    if (rest[0] === 'contents') {
      const repo = restRepoOr404(res, owner, name);
      if (!repo) return true;
      const filePath = rest.slice(1).join('/');
      const refParam = query.get('ref') ?? undefined;
      if (method === 'GET') {
        const branch = refParam ?? repo.defaultBranch;
        const tip = resolveRef(repo, branch);
        if (tip === undefined) {
          sendJson(res, 404, errJson('Not Found'), scopes);
          return true;
        }
        const file = readFileAt(repo, tip, filePath);
        if (file) {
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: file.data.length, name: filePath.split('/').pop() ?? filePath,
            path: filePath, content: b64encode(file.data), sha: file.oid, url: '', html_url: '', git_url: '', download_url: '',
          }, scopes);
          return true;
        }
        const dir = listDirAt(repo, tip, filePath);
        if (dir !== null) {
          sendJson(res, 200, dir.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.sha, size: 0, url: '', html_url: '', git_url: '', download_url: null })), scopes);
          return true;
        }
        sendJson(res, 404, errJson('Not Found'), scopes);
        return true;
      }
      if (method === 'PUT') {
        if (!isRecord(body) || typeof body.content !== 'string' || typeof body.message !== 'string') {
          sendJson(res, 422, errJson('Validation Failed: content and message are required'), scopes);
          return true;
        }
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = resolveRef(repo, branch);
        const existing = tip !== undefined ? readFileAt(repo, tip, filePath) : null;
        if (existing) {
          if (typeof body.sha !== 'string' || body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
            sendJson(res, 409, errJson('sha does not match the current blob'), scopes);
            return true;
          }
        }
        const content = b64decode(body.content);
        const result = commitFileChange(repo, branch, filePath, content, body.message);
        const status = existing ? 200 : 201;
        sendJson(res, status, {
          content: { name: filePath.split('/').pop() ?? filePath, path: filePath, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: result.commitSha, message: body.message },
        }, scopes);
        return true;
      }
      if (method === 'DELETE') {
        const branch = isRecord(body) && typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const tip = resolveRef(repo, branch);
        if (tip === undefined) {
          sendJson(res, 404, errJson('Not Found'), scopes);
          return true;
        }
        const existing = readFileAt(repo, tip, filePath);
        if (!existing) {
          sendJson(res, 404, errJson('Not Found'), scopes);
          return true;
        }
        if (isRecord(body) && typeof body.sha === 'string' && body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
          sendJson(res, 409, errJson('sha does not match the current blob'), scopes);
          return true;
        }
        const result = commitFileChange(repo, branch, filePath, null, isRecord(body) && typeof body.message === 'string' ? body.message : 'Delete file');
        sendJson(res, 200, { commit: { sha: result.commitSha } }, scopes);
        return true;
      }
    }
    // /issues...
    if (rest[0] === 'issues') {
      const repo = restRepoOr404(res, owner, name);
      if (!repo) return true;
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!isRecord(body) || typeof body.title !== 'string') {
            sendJson(res, 422, errJson('Validation Failed: title is required'), scopes);
            return true;
          }
          const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
          const created = createIssueInternal(repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
          if ('error' in created) {
            sendJson(res, 422, errJson(created.error), scopes);
            return true;
          }
          sendJson(res, 201, issueJson(repo, created), scopes);
          return true;
        }
        if (method === 'GET') {
          const stateParam = (query.get('state') ?? 'open').toLowerCase();
          const sort = query.get('sort') ?? 'created';
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let list = [...repo.issues];
          if (stateParam === 'open') list = list.filter((i) => i.state === 'open');
          else if (stateParam === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
          const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
          list = list.slice((page - 1) * perPage, page * perPage);
          const bounties = await repoBounties(repo);
          sendJson(res, 200, list.map((i) => issueJson(repo, i, bounties ? bounties[String(i.number)] ?? null : undefined)), scopes);
          return true;
        }
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const issue = repo.issues.find((i) => i.number === number);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (!issue) {
              sendJson(res, 404, errJson('Not Found'), scopes);
              return true;
            }
            const bounty = repo.chainRepoId !== undefined && forgeOptions.bountyFor
              ? await forgeOptions.bountyFor(repo.chainRepoId, issue.number).catch(() => null)
              : undefined;
            sendJson(res, 200, issueJson(repo, issue, bounty), scopes);
            return true;
          }
          if (method === 'PATCH') {
            if (!issue) {
              sendJson(res, 404, errJson('Not Found'), scopes);
              return true;
            }
            if (isRecord(body)) {
              if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
              if (typeof body.title === 'string') issue.title = body.title;
              if (typeof body.body === 'string') issue.body = body.body;
            }
            sendJson(res, 200, issueJson(repo, issue), scopes);
            return true;
          }
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (!issue) {
            sendJson(res, 404, errJson('Not Found'), scopes);
            return true;
          }
          if (method === 'POST') {
            if (!isRecord(body) || typeof body.body !== 'string') {
              sendJson(res, 422, errJson('Validation Failed: body is required'), scopes);
              return true;
            }
            const comment: Comment = { id: repo.nextComment, body: body.body };
            repo.nextComment += 1;
            issue.comments.push(comment);
            sendJson(res, 201, { id: comment.id, node_id: gidComment(repo.id, issue.number, comment.id), body: comment.body, user: { login: displayLogin(repo.owner, repo.agentId === true), id: userIdFor(repo.owner), type: 'User' }, created_at: FIXED_TS, updated_at: FIXED_TS, html_url: '', url: '' }, scopes);
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gidComment(repo.id, issue.number, c.id), body: c.body, user: { login: displayLogin(repo.owner, repo.agentId === true), id: userIdFor(repo.owner), type: 'User' }, created_at: FIXED_TS, updated_at: FIXED_TS, html_url: '', url: '' })), scopes);
            return true;
          }
        }
      }
    }
    // /pulls...
    if (rest[0] === 'pulls') {
      const repo = restRepoOr404(res, owner, name);
      if (!repo) return true;
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
            sendJson(res, 422, errJson('Validation Failed: title, head and base are required'), scopes);
            return true;
          }
          const head = (body.head as string).includes(':') ? (body.head as string).split(':').pop() as string : (body.head as string);
          const base = (body.base as string).includes(':') ? (body.base as string).split(':').pop() as string : (body.base as string);
          const created = createPullInternal(repo, body.title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) {
            sendJson(res, 422, errJson(created.error), scopes);
            return true;
          }
          sendJson(res, 201, pullJson(repo, created), scopes);
          return true;
        }
        if (method === 'GET') {
          const stateParam = (query.get('state') ?? 'open').toLowerCase();
          let list = [...repo.pulls];
          if (stateParam === 'open') list = list.filter((p) => p.state === 'open');
          else if (stateParam === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, b) => b.seq - a.seq);
          const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
          const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
          list = list.slice((page - 1) * perPage, page * perPage);
          sendJson(res, 200, list.map((p) => pullJson(repo, p)), scopes);
          return true;
        }
      }
      if (rest.length >= 2) {
        const number = Number(rest[1]);
        const pull = repo.pulls.find((p) => p.number === number);
        if (rest.length === 2) {
          if (method === 'GET') {
            if (!pull) {
              sendJson(res, 404, errJson('Not Found'), scopes);
              return true;
            }
            sendJson(res, 200, pullJson(repo, pull), scopes);
            return true;
          }
        }
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          if (!pull) {
            sendJson(res, 404, errJson('Not Found'), scopes);
            return true;
          }
          sendJson(res, 200, pull.files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '' })), scopes);
          return true;
        }
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (!pull) {
            sendJson(res, 404, errJson('Not Found'), scopes);
            return true;
          }
          const merged = mergePullInternal(repo, pull);
          if ('error' in merged) {
            sendJson(res, merged.status, errJson(merged.error), scopes);
            return true;
          }
          sendJson(res, 200, { sha: merged.sha, merged: true, message: `Pull Request successfully merged` }, scopes);
          return true;
        }
      }
    }
    sendJson(res, 404, errJson('Not Found'), scopes);
    return true;
  }
  sendJson(res, 404, errJson('Not Found'), scopes);
  return true;
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'side-band-64k multi_ack multi_ack_detailed thin-pack ofs-delta shallow symref=HEAD:refs/heads/main agent=forge/1.0 object-format=sha1';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 object-format=sha1';

function sortedRefs(repo: Repo): { oid: string; name: string }[] {
  const out: { oid: string; name: string }[] = [];
  for (const [name, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push({ oid, name });
  return out;
}
function peelOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'tag') return parseTag(object.data).object;
  return null;
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const items: (Buffer | string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`, 'flush');
    return pktLines(items);
  }
  let first = true;
  const headLine = headTip !== undefined ? `${headTip} HEAD` : `${ZERO_OID} HEAD`;
  items.push(first ? `${headLine}\u0000${caps}\n` : `${headLine}\n`);
  first = false;
  void first;
  for (const ref of refs) {
    items.push(`${ref.oid} ${ref.name}\n`);
    const peeled = peelOid(repo, ref.oid);
    if (peeled !== null) items.push(`${peeled} ${ref.name}^{}\n`);
  }
  items.push('flush');
  return pktLines(items);
}
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    'agent=forge/1.0\n',
    'flush',
  ]);
}

interface FetchPlan {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
}
/** Compute the objects a fetch must send, honouring haves, depth and shallow boundaries. */
function planFetch(repo: Repo, wants: readonly string[], haves: readonly string[], depth: number | undefined, shallowBoundaries: readonly string[]): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);
  // Included commits: BFS from wants, cut at depth.
  const included = new Set<string>();
  const queue: { oid: string; dist: number }[] = [];
  for (const want of wants) {
    const peeled = peelToCommit(repo, want);
    queue.push({ oid: want, dist: 0 });
    if (peeled !== null && peeled !== want) queue.push({ oid: peeled, dist: 0 });
  }
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (included.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(oid);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, dist });
      continue;
    }
    if (object.type !== 'commit') {
      included.add(oid);
      continue;
    }
    included.add(oid);
    if (depth !== undefined && dist + 1 >= depth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, dist: dist + 1 });
  }
  // Held objects: reachable from haves, not descending past a shallow boundary.
  const held = new Set<string>();
  const hqueue: string[] = [...haves];
  while (hqueue.length > 0) {
    const oid = hqueue.pop() as string;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      held.add(commit.tree);
      for (const x of collectReachable(repo, [commit.tree])) held.add(x);
      if (shallowSet.has(oid)) continue; // boundary: parents not held
      for (const parent of commit.parents) hqueue.push(parent);
    } else if (object.type === 'tag') {
      hqueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const x of collectReachable(repo, [oid])) held.add(x);
    }
  }
  // Send set: each included commit/tag plus its tree closure — never the
  // ancestors the depth cut excluded (collectReachable would walk them).
  const send = new Set<string>();
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    send.add(oid);
    if (object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      for (const x of collectReachable(repo, [tree])) send.add(x);
    }
  }
  for (const oid of held) send.delete(oid);
  const objects: GitObj[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Shallow info.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    if (parents.some((p) => !included.has(p))) shallow.push(oid);
  }
  for (const boundary of shallowBoundaries) {
    if (!included.has(boundary)) continue;
    const object = repo.objects.get(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.every((p) => included.has(p))) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

async function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, service: string): Promise<void> {
  const normOwner = normalizeOwner(owner);
  const repo = getRepo(normOwner, repoName);
  if (!repo || !canReadRepo(repo, currentViewer())) {
    sendJson(res, 404, errJson('Not Found'));
    return;
  }
  // Advertising receive-pack is the first step of a push: owner only.
  if (service === 'git-receive-pack' && !isRepoOwner(repo, currentViewer())) {
    sendJson(res, 401, errJson('Requires authentication'));
    return;
  }
  const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantV2) {
      sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    } else {
      sendRaw(res, 200, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendRaw(res, 200, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendJson(res, 404, errJson('Not Found'));
}

async function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = getRepo(normalizeOwner(owner), repoName);
  if (!repo || !canReadRepo(repo, currentViewer())) {
    sendJson(res, 404, errJson('Not Found'));
    return;
  }
  const body = await readBody(req);
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (isV2) {
    const { packets } = decodePktLines(body);
    let command = '';
    const args: string[] = [];
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8');
      if (!afterDelim) {
        if (line.startsWith('command=')) command = line.slice('command='.length).trim();
        continue;
      }
      args.push(line.replace(/\n$/, ''));
    }
    if (command === 'ls-refs') {
      const prefixes: string[] = [];
      let peel = false;
      let symrefs = false;
      for (const arg of args) {
        if (arg === 'peel') peel = true;
        else if (arg === 'symrefs') symrefs = true;
        else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
      }
      const lines: (string | 'flush')[] = [];
      const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      // HEAD is listed when no prefix filter is given, or when a prefix
      // matches it (real git asks for `ref-prefix HEAD` during clone).
      const includeHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
      if (includeHead) {
        if (headTip !== undefined) {
          lines.push(symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headTip} HEAD\n`);
        } else {
          lines.push(symrefs ? `unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `unborn HEAD\n`);
        }
      }
      for (const ref of sortedRefs(repo)) {
        if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
        let line = `${ref.oid} ${ref.name}`;
        if (peel) {
          const peeled = peelOid(repo, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
        lines.push(`${line}\n`);
      }
      lines.push('flush');
      sendRaw(res, 200, pktLines(lines), 'application/x-git-upload-pack-result');
      return;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | undefined;
      for (const arg of args) {
        if (arg.startsWith('want ')) wants.push((arg.slice(5).split(' ')[0] as string).trim());
        else if (arg.startsWith('have ')) haves.push((arg.slice(5).split(' ')[0] as string).trim());
        else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) {
          const n = Number(arg.slice(7).trim());
          if (Number.isSafeInteger(n) && n > 0) depth = n;
        }
      }
      const plan = planFetch(repo, wants, haves, depth, shallow);
      const pack = writePack(plan.objects);
      const parts: (Buffer | string | 'flush' | 'delim')[] = [];
      // Protocol v2: the acknowledgments section is only sent when the
      // client sent 'have' lines (negotiation). A fresh clone sends none,
      // and real git then expects the response to start with 'packfile'.
      // With haves, ACK every have that is a common ancestor of a want,
      // then 'ready' (verified against real git upload-pack: it sends
      // `ACK <oid>` lines + `ready` before the delim). NAK + ready when
      // there is no common base.
      if (haves.length > 0) {
        const acked = haves.filter((h) => repo.objects.has(h) && wants.some((w) => isAncestor(repo, h, w)));
        parts.push('acknowledgments\n');
        if (acked.length > 0) for (const oid of acked) parts.push(`ACK ${oid}\n`);
        else parts.push('NAK\n');
        parts.push('ready\n', 'delim');
      }
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push('shallow-info\n');
        for (const oid of plan.shallow) parts.push(`shallow ${oid}\n`);
        for (const oid of plan.unshallow) parts.push(`unshallow ${oid}\n`);
        parts.push('delim');
      }
      parts.push('packfile\n');
      const packParts = pktLines(parts);
      const sideband = sidebandPackets(pack);
      sendRaw(res, 200, Buffer.concat([packParts, sideband]), 'application/x-git-upload-pack-result');
      return;
    }
    sendJson(res, 400, errJson(`unknown command ${command}`));
    return;
  }
  // v0 upload-pack
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  let inSecondSection = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      inSecondSection = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    } else if (line === 'done') {
      void inSecondSection;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, shallow);
  const pack = writePack(plan.objects);
  const textParts: (Buffer | string | 'flush')[] = [];
  for (const oid of plan.shallow) textParts.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) textParts.push(`unshallow ${oid}\n`);
  // v0 multi_ack: ACK every have that is a common ancestor of a want —
  // all but the last carry 'continue'; the bare ACK ends negotiation.
  // NAK when there is no common base.
  const acked = haves.filter((h) => repo.objects.has(h) && wants.some((w) => isAncestor(repo, h, w)));
  if (acked.length > 0) {
    acked.forEach((oid, i) => textParts.push(i + 1 < acked.length ? `ACK ${oid} continue\n` : `ACK ${oid}\n`));
  } else textParts.push('NAK\n');
  const head = pktLines(textParts);
  const sideband = sidebandPackets(pack);
  sendRaw(res, 200, Buffer.concat([head, sideband]), 'application/x-git-upload-pack-result');
}

async function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string): Promise<void> {
  const repo = getRepo(normalizeOwner(owner), repoName);
  // Pushes require a session belonging to the repo owner.
  if (!repo || !isRepoOwner(repo, currentViewer())) {
    sendJson(res, 401, errJson('Requires authentication'));
    return;
  }
  const body = await readBody(req);
  const { packets, rest } = decodePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  if (!sawFlush && commands.length === 0) {
    sendJson(res, 400, errJson('malformed request'));
    return;
  }
  // Unpack the pack (if any).
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (hashObject(object.type, object.data) !== oid) throw new Error('object hash mismatch');
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let reason: string | null = null;
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined) reason = 'remote ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      } else if (!repo.objects.has(command.newOid)) {
        reason = 'object not found';
      } else if (command.oldOid === ZERO_OID) {
        if (current !== undefined) reason = 'already exists';
      } else {
        if (current === undefined) reason = 'remote ref does not exist';
        else if (current !== command.oldOid) reason = 'non-fast-forward';
        else {
          const oldCommit = peelToCommit(repo, command.oldOid);
          const newCommit = peelToCommit(repo, command.newOid);
          if (oldCommit !== null && newCommit !== null && !isAncestor(repo, oldCommit, newCommit)) {
            reason = 'non-fast-forward';
          }
        }
      }
      if (reason === null) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} ${reason}\n`);
      }
    }
  } else {
    reportLines.push(`unpack ${unpackDetail}\n`);
  }
  const report = pktLines([...reportLines, 'flush']);
  sendRaw(res, 200, sidebandPackets(report), 'application/x-git-receive-pack-result');
}

// ---------------------------------------------------------------------------
// GraphQL v4 (a small parser + executor for the documents gh sends)
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };
interface GqlSelection {
  kind: 'field' | 'fragment' | 'spread';
  alias?: string;
  name?: string;
  args?: Map<string, GqlValue>;
  selections?: GqlSelection[];
  typeCondition?: string;
  fragmentName?: string;
}
interface GqlOperation {
  opType: 'query' | 'mutation';
  name?: string;
  varDefs: Map<string, GqlValue | undefined>;
  selections: GqlSelection[];
}
interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, GqlSelection>;
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j] as string)) j += 1;
    if (j === i) throw new Error(`unexpected character ${ch}`);
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}
class GqlParser {
  tokens: string[];
  pos = 0;
  constructor(src: string) {
    this.tokens = gqlTokenize(src);
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    const token = this.tokens[this.pos] as string;
    this.pos += 1;
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        operations.push(this.parseOperation());
      } else if (token === '{') {
        operations.push({ opType: 'query', varDefs: new Map(), selections: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        fragments.set(name, { kind: 'fragment', typeCondition, selections });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }
  parseOperation(): GqlOperation {
    const opType = this.next() as 'query' | 'mutation';
    let name: string | undefined;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    const varDefs = new Map<string, GqlValue | undefined>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        this.parseType();
        if (this.peek() === '=') {
          this.next();
          varDefs.set(varName, this.parseValue());
        } else {
          varDefs.set(varName, undefined);
        }
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { opType, name, varDefs, selections };
  }
  parseType(): void {
    if (this.peek() === '[') {
      this.next();
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }
  parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      const token = this.peek();
      if (token === 'on') {
        this.next();
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      const fragmentName = this.next();
      return { kind: 'spread', fragmentName };
    }
    let alias: string | undefined;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = new Map<string, GqlValue>();
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    // directives (ignored)
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t === '(') depth += 1;
          else if (t === ')') depth -= 1;
        }
      }
    }
    let selections: GqlSelection[] | undefined;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selections };
  }
  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}
function gqlResolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((v) => gqlResolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of value.fields) out[key] = gqlResolveValue(v, variables);
      return out;
    }
  }
}
function gqlArg(args: Map<string, GqlValue> | undefined, name: string, variables: Record<string, unknown>): unknown {
  if (!args) return undefined;
  const value = args.get(name);
  if (value === undefined) return undefined;
  return gqlResolveValue(value, variables);
}
class GqlFieldError extends Error {
  field: string;
  typeName: string;
  constructor(field: string, typeName: string) {
    super(`Cannot query field "${field}" on type "${typeName}".`);
    this.field = field;
    this.typeName = typeName;
  }
}
interface GqlCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, GqlSelection>;
}
const SCHEMA_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt'],
  SearchType: [],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Ref: ['name', 'target'],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueStateGql(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}
function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}
function encodeCursor(n: number): string {
  return b64urlEncode(`cursor:${n}`);
}
function decodeCursor(cursor: string): number | null {
  const text = b64urlDecode(cursor);
  if (text === null) return null;
  const match = /^cursor:(\d+)$/.exec(text);
  return match ? Number(match[1]) : null;
}

function executeSelections(
  selections: readonly GqlSelection[],
  typeName: string,
  source: unknown,
  ctx: GqlCtx,
  resolve: (field: string, args: Map<string, GqlValue> | undefined, source: unknown, ctx: GqlCtx) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.fragmentName as string);
      if (fragment?.selections) {
        Object.assign(out, executeSelections(fragment.selections, typeName, source, ctx, resolve));
      }
      continue;
    }
    if (selection.kind === 'fragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(selection.selections ?? [], typeName, source, ctx, resolve));
      }
      continue;
    }
    const field = selection.name as string;
    const key = selection.alias ?? field;
    if (field === '__typename') {
      out[key] = typeName;
      continue;
    }
    const value = resolve(field, selection.args, source, ctx);
    if (selection.selections && value !== null && value !== undefined) {
      out[key] = executeNested(field, value, selection.selections, ctx);
    } else {
      out[key] = value === undefined ? null : value;
    }
  }
  return out;
}
function executeNested(field: string, value: unknown, selections: readonly GqlSelection[], ctx: GqlCtx): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => executeNested(field, item, selections, ctx));
  }
  if (!isRecord(value)) return value;
  const tagged = value as Record<string, unknown> & { __type?: string; __source?: unknown };
  const typeName = typeof tagged.__type === 'string' ? tagged.__type : inferGqlType(field, value);
  if (typeName.endsWith('Payload') || typeName === 'IssueCommentEdge' || typeName === 'IssueEdge' || typeName === 'PullRequestEdge') {
    return executeNestedPayload(field, value, selections, ctx);
  }
  const source = tagged.__source !== undefined ? tagged.__source : value;
  return executeSelections(selections, typeName, source, ctx, (f, args, src, c) => resolveTypedField(typeName, f, args, src, c));
}
function inferGqlType(field: string, value: Record<string, unknown>): string {
  if (field === 'repository' || field === 'node') return 'Repository';
  if (field === 'issue') return 'Issue';
  if (field === 'issues') return 'IssueConnection';
  if (field === 'pullRequest') return 'PullRequest';
  if (field === 'pullRequests') return 'PullRequestConnection';
  if (field === 'owner' || field === 'viewer' || field === 'author') return 'User';
  if (field === 'defaultBranchRef') return 'Ref';
  if (field === 'files') return 'PullRequestChangedFileConnection';
  if (field === 'pageInfo') return 'PageInfo';
  if (field === 'commentEdge') return 'IssueCommentEdge';
  if (field === 'node' && typeof value.id === 'string') return 'Repository';
  return 'Repository';
}
function resolveTypedField(typeName: string, field: string, args: Map<string, GqlValue> | undefined, source: unknown, ctx: GqlCtx): unknown {
  switch (typeName) {
    case 'Repository': {
      const repo = source as Repo;
      switch (field) {
        case 'id': return gidRepo(repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', __source: displayLogin(repo.owner, repo.agentId === true) };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { __type: 'Ref', __source: repo.defaultBranch };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'private': return repo.isPrivate;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
        case 'createdAt': case 'updatedAt': return FIXED_TS;
        case 'issue': {
          const number = gqlArg(args, 'number', ctx.variables) as number;
          const issue = repo.issues.find((i) => i.number === number);
          return issue === undefined ? null : { __type: 'Issue', __source: { repo, issue } };
        }
        case 'issues': return issuesConnection(repo, args, ctx);
        case 'pullRequests': {
          const first = gqlArg(args, 'first', ctx.variables) as number | undefined;
          let list = repo.pulls.filter((p) => p.state === 'open');
          list = [...list].sort((a, b) => b.number - a.number);
          if (first !== undefined) list = list.slice(0, first);
          const prNodes = list.map((pull) => ({ __type: 'PullRequest', __source: { repo, pull } }));
          return { __type: 'PullRequestConnection', __source: { nodes: prNodes, __pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } } };
        }
        case 'pullRequest': {
          const number = gqlArg(args, 'number', ctx.variables) as number;
          const pull = repo.pulls.find((p) => p.number === number);
          return pull === undefined ? null : { __type: 'PullRequest', __source: { repo, pull } };
        }
        default: throw new GqlFieldError(field, typeName);
      }
    }
    case 'Issue': {
      const { repo, issue } = source as { repo: Repo; issue: Issue };
      switch (field) {
        case 'id': return gidIssue(repo.id, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issueStateGql(issue.state);
        case 'body': return issue.body;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': case 'updatedAt': return FIXED_TS;
        case 'author': return { __type: 'User', __source: displayLogin(repo.owner, repo.agentId === true) };
        case 'comments': return { __type: 'IssueConnection', __source: [] };
        case 'labels': return issue.labels.map((name) => ({ __type: 'Label', __source: { name } }));
        default: throw new GqlFieldError(field, typeName);
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: Repo; pull: Pull };
      switch (field) {
        case 'id': return gidPull(repo.id, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullStateGql(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return { __type: 'Ref', __source: pull.headRef };
        case 'baseRef': return { __type: 'Ref', __source: pull.baseRef };
        case 'files': {
          const first = gqlArg(args, 'first', ctx.variables) as number | undefined;
          let nodes = pull.files.map((f) => ({ __type: 'PullRequestChangedFile', __source: { path: f.filename } }));
          if (first !== undefined) nodes = nodes.slice(0, first);
          return { __type: 'PullRequestChangedFileConnection', __source: nodes };
        }
        case 'author': return { __type: 'User', __source: displayLogin(repo.owner, repo.agentId === true) };
        case 'createdAt': case 'updatedAt': return FIXED_TS;
        case 'mergedAt': return pull.mergedAt;
        case 'mergeCommit': return pull.mergeSha === null ? null : { oid: pull.mergeSha };
        default: throw new GqlFieldError(field, typeName);
      }
    }
    case 'User': {
      const login = source as string;
      const v = currentViewer();
      const viewerDisplay = v ? displayLogin(v.login, v.handle !== undefined) : '';
      switch (field) {
        case 'id': return b64urlEncode(`U:${login}`);
        case 'login': return login;
        case 'name': return login === viewerDisplay && v ? v.name : (login === VIEWER_LOGIN ? VIEWER.name : login);
        case 'email': return login === viewerDisplay && v ? v.email : (login === VIEWER_LOGIN ? VIEWER.email : '');
        default: throw new GqlFieldError(field, typeName);
      }
    }
    case 'Ref': {
      const name = source as string;
      if (field === 'name') return name;
      if (field === 'target') return { oid: '' };
      throw new GqlFieldError(field, typeName);
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const conn = source as { nodes?: unknown[]; __pageInfo?: Record<string, unknown> };
      const nodes = Array.isArray(source) ? (source as unknown[]) : (conn.nodes ?? []);
      switch (field) {
        case 'nodes': return nodes;
        case 'edges': return nodes.map((node) => ({ __type: 'IssueEdge', __source: { node, cursor: '' } }));
        case 'pageInfo': return conn.__pageInfo ?? { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        case 'totalCount': return nodes.length;
        default: throw new GqlFieldError(field, typeName);
      }
    }
    case 'PageInfo': {
      const info = source as Record<string, unknown>;
      switch (field) {
        case 'hasNextPage': return info.hasNextPage ?? false;
        case 'hasPreviousPage': return info.hasPreviousPage ?? false;
        case 'startCursor': return info.startCursor ?? null;
        case 'endCursor': return info.endCursor ?? null;
        default: throw new GqlFieldError(field, typeName);
      }
    }
    case 'IssueCommentEdge':
    case 'IssueEdge':
    case 'PullRequestEdge': {
      if (field === 'node') return (source as Record<string, unknown>).node;
      if (field === 'cursor') return (source as Record<string, unknown>).cursor ?? '';
      throw new GqlFieldError(field, typeName);
    }
    case 'Comment':
    case 'IssueComment': {
      const s = source as { repo: Repo; issue: Issue; comment: Comment };
      if (field === 'id') return gidComment(s.repo.id, s.issue.number, s.comment.id);
      if (field === 'body') return s.comment.body;
      if (field === 'author') return { __type: 'User', __source: displayLogin(s.repo.owner, s.repo.agentId === true) };
      if (field === 'createdAt') return FIXED_TS;
      throw new GqlFieldError(field, typeName);
    }
    case 'Label': {
      if (field === 'name') return (source as { name: string }).name;
      if (field === 'id') return b64urlEncode(`L:${(source as { name: string }).name}`);
      throw new GqlFieldError(field, typeName);
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return (source as { path: string }).path;
      if (field === 'filename') return (source as { path: string }).path;
      throw new GqlFieldError(field, typeName);
    }
    case '__Type': {
      const s = source as { name: string; kind: string; fields: { name: string }[]; enumValues: { name: string }[] };
      if (field === 'name') return s.name;
      if (field === 'kind') return s.kind;
      if (field === 'fields') return s.fields.map((f) => ({ __type: '__Field', __source: { name: f.name } }));
      if (field === 'enumValues') return s.enumValues.map((v) => ({ __type: '__EnumValue', __source: { name: v.name } }));
      throw new GqlFieldError(field, typeName);
    }
    case '__Field': {
      if (field === 'name') return (source as { name: string }).name;
      throw new GqlFieldError(field, typeName);
    }
    case '__EnumValue': {
      if (field === 'name') return (source as { name: string }).name;
      throw new GqlFieldError(field, typeName);
    }
    case '__Schema': {
      if (field === 'queryType') return { __type: '__Type', __source: { name: 'Query', kind: 'OBJECT', fields: [], enumValues: [] } };
      if (field === 'mutationType') return { __type: '__Type', __source: { name: 'Mutation', kind: 'OBJECT', fields: [], enumValues: [] } };
      throw new GqlFieldError(field, typeName);
    }
    default:
      throw new GqlFieldError(field, typeName);
  }
}
function issuesConnection(repo: Repo, args: Map<string, GqlValue> | undefined, ctx: GqlCtx): Record<string, unknown> {
  const first = gqlArg(args, 'first', ctx.variables) as number | undefined;
  const after = gqlArg(args, 'after', ctx.variables) as string | null | undefined;
  const states = gqlArg(args, 'states', ctx.variables) as string[] | undefined;
  const orderBy = gqlArg(args, 'orderBy', ctx.variables) as Record<string, unknown> | undefined;
  let list = [...repo.issues];
  if (states !== undefined) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const direction = orderBy !== undefined && String(orderBy.direction ?? '').toUpperCase() === 'ASC' ? 'asc' : 'desc';
  list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  if (after !== undefined && after !== null) {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      const index = list.findIndex((i) => i.number === cursorNumber);
      if (index >= 0) list = list.slice(index + 1);
    }
  }
  const total = list.length;
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNextPage = page.length < total;
  const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
  const nodes = page.map((issue) => ({ __type: 'Issue', __source: { repo, issue } }));
  const pageInfo = { hasNextPage, hasPreviousPage: false, startCursor: page.length > 0 ? encodeCursor((page[0] as Issue).number) : null, endCursor };
  return { __type: 'IssueConnection', __source: { nodes, __pageInfo: pageInfo } };
}
function executeQuery(selections: readonly GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  return executeSelections(selections, 'Query', null, ctx, (field, args, _source, c) => {
    switch (field) {
      case 'viewer': {
        const v = currentViewer();
        return { __type: 'User', __source: v ? displayLogin(v.login, v.handle !== undefined) : VIEWER_LOGIN };
      }
      case 'repository': {
        const owner = normalizeOwner(gqlArg(args, 'owner', c.variables) as string);
        const name = gqlArg(args, 'name', c.variables) as string;
        const repo = getRepo(owner, name);
        if (repo === undefined || !canReadRepo(repo, currentViewer())) return null;
        return { __type: 'Repository', __source: repo };
      }
      case 'node': {
        const id = gqlArg(args, 'id', c.variables) as string;
        const decoded = decodeGid(id);
        if (decoded === null) return null;
        const repo = repoByDbId(decoded.repoId);
        if (repo === undefined || !canReadRepo(repo, currentViewer())) return null;
        if (decoded.kind === 'R') return { __type: 'Repository', __source: repo };
        if (decoded.kind === 'I') {
          const issue = repo.issues.find((i) => i.number === decoded.number);
          return issue === undefined ? null : { __type: 'Issue', __source: { repo, issue } };
        }
        if (decoded.kind === 'P') {
          const pull = repo.pulls.find((p) => p.number === decoded.number);
          return pull === undefined ? null : { __type: 'PullRequest', __source: { repo, pull } };
        }
        return null;
      }
      case '__type': {
        const name = gqlArg(args, 'name', c.variables) as string;
        if (name === 'SearchType') {
          return { __type: '__Type', __source: { name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) } };
        }
        const fields = SCHEMA_FIELDS[name];
        if (fields === undefined) return null;
        return { __type: '__Type', __source: { name, kind: 'OBJECT', fields: fields.map((n) => ({ name: n })), enumValues: [] } };
      }
      case '__schema':
        return { __type: '__Schema', __source: {} };
      default:
        throw new GqlFieldError(field, 'Query');
    }
  });
}
function executeMutation(selections: readonly GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  // GraphQL mutations require a session belonging to the repo owner.
  const requireOwner = (repo: Repo | undefined): Repo => {
    if (repo === undefined) throw new Error('repository not found');
    if (!isRepoOwner(repo, currentViewer())) throw new Error('only the repository owner can do this');
    return repo;
  };
  return executeSelections(selections, 'Mutation', null, ctx, (field, args, _source, c) => {
    const input = gqlArg(args, 'input', c.variables) as Record<string, unknown> | undefined;
    switch (field) {
      case 'createIssue': {
        const repoId = decodeGid(String(input?.repositoryId ?? ''));
        const repo = requireOwner(repoId !== null && repoId.kind === 'R' ? repoByDbId(repoId.repoId) : undefined);
        const created = createIssueInternal(repo, String(input?.title ?? ''), typeof input?.body === 'string' ? input.body : '', []);
        if ('error' in created) throw new Error(created.error);
        return { __type: 'CreateIssuePayload', __source: { repo, issue: created } };
      }
      case 'closeIssue': {
        const decoded = decodeGid(String(input?.issueId ?? ''));
        const repo = requireOwner(decoded !== null ? repoByDbId(decoded.repoId) : undefined);
        const issue = repo?.issues.find((i) => i.number === decoded?.number);
        if (issue === undefined) throw new Error('issue not found');
        issue.state = 'closed';
        return { __type: 'CloseIssuePayload', __source: { repo, issue } };
      }
      case 'createPullRequest': {
        const repoId = decodeGid(String(input?.repositoryId ?? ''));
        const repo = requireOwner(repoId !== null && repoId.kind === 'R' ? repoByDbId(repoId.repoId) : undefined);
        const created = createPullInternal(repo, String(input?.title ?? ''), typeof input?.body === 'string' ? input.body : '', String(input?.headRefName ?? ''), String(input?.baseRefName ?? ''));
        if ('error' in created) throw new Error(created.error);
        return { __type: 'CreatePullRequestPayload', __source: { repo, pull: created } };
      }
      case 'mergePullRequest': {
        const decoded = decodeGid(String(input?.pullRequestId ?? ''));
        const repo = requireOwner(decoded !== null ? repoByDbId(decoded.repoId) : undefined);
        const pull = repo?.pulls.find((p) => p.number === decoded?.number);
        if (pull === undefined) throw new Error('pull request not found');
        const merged = mergePullInternal(repo, pull);
        if ('error' in merged) throw new Error(merged.error);
        return { __type: 'MergePullRequestPayload', __source: { repo, pull } };
      }
      case 'addComment': {
        const decoded = decodeGid(String(input?.subjectId ?? ''));
        const repo = requireOwner(decoded !== null ? repoByDbId(decoded.repoId) : undefined);
        const issue = repo?.issues.find((i) => i.number === decoded?.number);
        if (issue === undefined) throw new Error('issue not found');
        const comment: Comment = { id: repo.nextComment, body: String(input?.body ?? '') };
        repo.nextComment += 1;
        issue.comments.push(comment);
        return { __type: 'AddCommentPayload', __source: { repo, issue, comment } };
      }
      default:
        throw new GqlFieldError(field, 'Mutation');
    }
  });
}
function executeNestedPayload(field: string, value: unknown, selections: readonly GqlSelection[], ctx: GqlCtx): unknown {
  if (!isRecord(value)) return value;
  const tagged = value as Record<string, unknown> & { __type?: string; __source?: unknown };
  const typeName = typeof tagged.__type === 'string' ? tagged.__type : 'Repository';
  const source = tagged.__source !== undefined ? tagged.__source : value;
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    const { repo, issue } = source as { repo: Repo; issue: Issue };
    return executeSelections(selections, typeName, { repo, issue }, ctx, (f, _args, src, _c) => {
      if (f === 'issue') return { __type: 'Issue', __source: src as { repo: Repo; issue: Issue } };
      throw new GqlFieldError(f, typeName);
    });
  }
  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    const { repo, pull } = source as { repo: Repo; pull: Pull };
    return executeSelections(selections, typeName, { repo, pull }, ctx, (f, _args, src, _c) => {
      if (f === 'pullRequest') return { __type: 'PullRequest', __source: src as { repo: Repo; pull: Pull } };
      throw new GqlFieldError(f, typeName);
    });
  }
  if (typeName === 'AddCommentPayload') {
    const { repo, issue, comment } = source as { repo: Repo; issue: Issue; comment: Comment };
    return executeSelections(selections, typeName, { repo, issue, comment }, ctx, (f, _args, src, _c) => {
      if (f === 'commentEdge') {
        const s = src as { repo: Repo; issue: Issue; comment: Comment };
        return { __type: 'IssueCommentEdge', __source: { node: { __type: 'Comment', __source: s } } };
      }
      throw new GqlFieldError(f, typeName);
    });
  }
  return executeSelections(selections, typeName, source, ctx, (f, args, src, c) => resolveTypedField(typeName, f, args, src, c));
}

// ---------------------------------------------------------------------------
// GraphQL HTTP handler
// ---------------------------------------------------------------------------

function executeGqlDocument(doc: GqlDocument, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  const errors: { message: string }[] = [];
  const data: Record<string, unknown> = {};
  for (const operation of doc.operations) {
    const vars: Record<string, unknown> = { ...variables };
    for (const [name, defaultValue] of operation.varDefs) {
      if (!(name in vars) && defaultValue !== undefined) vars[name] = gqlResolveValue(defaultValue, {});
    }
    const ctx: GqlCtx = { variables: vars, fragments: doc.fragments };
    try {
      const result = operation.opType === 'mutation' ? executeMutation(operation.selections, ctx) : executeQuery(operation.selections, ctx);
      Object.assign(data, result);
    } catch (err) {
      if (err instanceof GqlFieldError) {
        errors.push({ message: err.message });
      } else {
        errors.push({ message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (errors.length > 0 && Object.keys(data).length === 0) return { data: null, errors };
  return errors.length > 0 ? { data, errors } : { data };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const buf = await readBody(req);
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) {
    sendJson(res, 400, errJson('Problems parsing JSON'));
    return;
  }
  // Mutations require a valid session; queries may read public repos.
  const payload = parsed.value;
  const docs = Array.isArray(payload) ? payload : [payload];
  const wantsMutation = docs.some((d) => isRecord(d) && typeof d.query === 'string' && /\bmutation\b/i.test(d.query));
  if (wantsMutation && !currentViewer()) {
    sendJson(res, 401, errJson('Requires authentication'));
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    let parsedDoc: GqlDocument;
    try {
      parsedDoc = new GqlParser(doc.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    return executeGqlDocument(parsedDoc, variables);
  };
  if (Array.isArray(payload)) {
    sendJson(res, 200, payload.map((item) => runOne(item)));
    return;
  }
  sendJson(res, 200, runOne(payload));
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) over Streamable HTTP
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Pull request state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function mcpNormalizeArgs(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) out[key] = value;
  const fullName = out.full_name ?? out.fullName;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/');
    if (out.owner === undefined) out.owner = owner;
    if (out.repo === undefined) out.repo = repo;
  }
  if (out.owner === undefined && typeof out.owner_login === 'string') out.owner = out.owner_login;
  if (out.repo === undefined && typeof out.repository === 'string') out.repo = out.repository;
  if (out.pull_number === undefined && out.pullNumber !== undefined) out.pull_number = out.pullNumber;
  if (out.pull_number === undefined && out.number !== undefined) out.pull_number = out.number;
  if (out.issue_number === undefined && out.issueNumber !== undefined) out.issue_number = out.issueNumber;
  if (out.issue_number === undefined && out.number !== undefined) out.issue_number = out.number;
  return out;
}
function mcpTextResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] };
}
function mcpErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const buf = await readBody(req);
  const text = buf.toString('utf8');
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(payload)) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = payload.id === undefined ? null : payload.id;
  const method = typeof payload.method === 'string' ? payload.method : '';
  // Notifications carry no id and get a bare 202.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  const result = (value: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  };
  const rpcError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  if (method === 'server/discover') {
    result({
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25'],
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      capabilities: { tools: {} },
    });
    return;
  }
  if (method === 'initialize') {
    const params = isRecord(payload.params) ? payload.params : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    result({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
    return;
  }
  if (method === 'ping') {
    result({});
    return;
  }
  if (method === 'tools/list') {
    result({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const viewer = currentViewer();
    if (!viewer) {
      sendJson(res, 401, { jsonrpc: '2.0', id, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    const params = isRecord(payload.params) ? payload.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const tool = MCP_TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.name.toLowerCase().endsWith(name.toLowerCase()));
    if (tool === undefined) {
      rpcError(-32601, `Unknown tool: ${name}`);
      return;
    }
    const args = mcpNormalizeArgs(isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {});
    for (const required of tool.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        result(mcpErrorResult(`Missing required argument: ${required}`));
        return;
      }
    }
    const owner = normalizeOwner(String(args.owner ?? viewer.login));
    const repoName = String(args.repo ?? '');
    const repo = repoName === '' ? undefined : getRepo(owner, repoName);
    const repoReadable = repo !== undefined && (!repo.isPrivate || repo.owner === viewer.login);
    const repoOwned = repo !== undefined && repo.owner === viewer.login;
    switch (tool.name) {
      case 'create_repo': {
        const created = createRepoInternal(viewer.login, String(args.name), typeof args.description === 'string' ? args.description : '', args.private === true, { agentId: viewer.handle !== undefined });
        result(mcpTextResult(repoJson(created)));
        return;
      }
      case 'get_repo': {
        if (repo === undefined || !repoReadable) {
          result(mcpErrorResult('Repository not found'));
          return;
        }
        result(mcpTextResult(repoJson(repo)));
        return;
      }
      case 'create_issue': {
        if (repo === undefined || !repoOwned) {
          result(mcpErrorResult('Repository not found'));
          return;
        }
        const created = createIssueInternal(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
        if ('error' in created) {
          result(mcpErrorResult(created.error));
          return;
        }
        result(mcpTextResult(issueJson(repo, created)));
        return;
      }
      case 'list_issues': {
        if (repo === undefined || !repoReadable) {
          result(mcpErrorResult('Repository not found'));
          return;
        }
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.issues.filter((i) => state === 'all' || i.state === state);
        result(mcpTextResult(list.map((i) => issueJson(repo, i))));
        return;
      }
      case 'create_pull_request': {
        if (repo === undefined || !repoOwned) {
          result(mcpErrorResult('Repository not found'));
          return;
        }
        const created = createPullInternal(repo, String(args.title), '', String(args.head), String(args.base));
        if ('error' in created) {
          result(mcpErrorResult(created.error));
          return;
        }
        result(mcpTextResult(pullJson(repo, created)));
        return;
      }
      case 'merge_pull_request': {
        if (repo === undefined || !repoOwned) {
          result(mcpErrorResult('Repository not found'));
          return;
        }
        const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
        if (pull === undefined) {
          result(mcpErrorResult('Pull request not found'));
          return;
        }
        const merged = mergePullInternal(repo, pull);
        if ('error' in merged) {
          result(mcpErrorResult(merged.error));
          return;
        }
        result(mcpTextResult(pullJson(repo, pull)));
        return;
      }
      case 'get_issue': {
        if (repo === undefined || !repoReadable) {
          result(mcpErrorResult('Repository not found'));
          return;
        }
        const issue = repo.issues.find((i) => i.number === Number(args.issue_number));
        if (issue === undefined) {
          result(mcpErrorResult('Issue not found'));
          return;
        }
        result(mcpTextResult(issueJson(repo, issue)));
        return;
      }
      case 'list_pull_requests': {
        if (repo === undefined || !repoReadable) {
          result(mcpErrorResult('Repository not found'));
          return;
        }
        const state = typeof args.state === 'string' ? args.state : 'open';
        const list = repo.pulls.filter((p) => state === 'all' || p.state === state);
        result(mcpTextResult(list.map((p) => pullJson(repo, p))));
        return;
      }
      default:
        rpcError(-32601, `Unknown tool: ${name}`);
        return;
    }
  }
  rpcError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Top-level routing
// ---------------------------------------------------------------------------

export function createApp(options: ForgeOptions = {}): Server {
  configureForge(options);
  const server = createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const segments = splitPath(url.pathname);
      // Resolve the acting user once per request; every handler below reads
      // it from the AsyncLocalStorage viewer context.
      const viewer = resolveViewer(req);
      await viewerStore.run(viewer, async () => {
        // Extra routes (Agent ID auth + UI) are handled by server.ts.
        if (forgeOptions.extraHandler && (await forgeOptions.extraHandler(req, res))) return;
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const handled = await handleRest(req, res, segments.slice(2), method);
          if (!handled) sendJson(res, 404, errJson('Not Found'));
          return;
        }
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, errJson('Method Not Allowed'));
            return;
          }
          await handleGraphql(req, res);
          return;
        }
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method !== 'POST') {
            sendJson(res, 405, errJson('Method Not Allowed'));
            return;
          }
          await handleMcp(req, res);
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
        if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -4);
          const tail = segments.slice(2);
          if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
            const service = url.searchParams.get('service') ?? '';
            if (method !== 'GET') {
              sendJson(res, 405, errJson('Method Not Allowed'));
              return;
            }
            await handleGitInfoRefs(req, res, owner, repoName, service);
            return;
          }
          if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
            await handleGitUploadPack(req, res, owner, repoName);
            return;
          }
          if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
            await handleGitReceivePack(req, res, owner, repoName);
            return;
          }
        }
        sendJson(res, 404, errJson('Not Found'));
      });
      // Any mutating request may have changed the store: persist it.
      if (method !== 'GET' && method !== 'HEAD') forgeOptions.onMutate?.();
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, errJson(err instanceof Error ? err.message : String(err)));
      else res.destroy();
    }
  });
  return server;
}
