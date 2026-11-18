// AgentForge browser UI.
// Identity: injected EIP-1193 provider ONLY (window.ethereum). No QR login.
// Login = sign a SIWE-style challenge; server verifies the signature AND
// checks on-chain that the signer owns the Agent ID for the handle.
// Bounties: postBounty / releaseBounty / cancelBounty on ForgeRegistry,
// always via the user's own wallet — every tx is user-confirmed.
// Only the LOGGED-IN user's own handle is ever displayed; there is no
// name -> address lookup anywhere in this UI.

import { createPublicClient, createWalletClient, custom, http, formatEther, parseEther, decodeEventLog } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

const CFG = window.AGENTFORGE_CONFIG ?? { contractAddress: '', chainId: 56, rpcUrl: '', agentIdRegistry: '' };
const CHAIN = CFG.chainId === 97 ? bscTestnet : bsc;
const $ = (id) => document.getElementById(id);
const logEl = $('log');
function log(msg) {
  logEl.textContent += `${new Date().toLocaleTimeString()} ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  const token = localStorage.getItem('agentforge_session');
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(typeof body === 'object' && body !== null && body.message ? body.message : (body?.error ?? `${res.status} ${res.statusText}`));
  return body;
}

let abi = null;
async function loadAbi() {
  if (abi) return abi;
  try {
    abi = await (await fetch('/ui/abi.json')).json();
  } catch {
    abi = [];
  }
  return abi;
}

let walletClient = null;
let publicClient = null;
let account = null;
let me = null; // { address, handle, handleAi, avatarUrl }

function clients() {
  if (!window.ethereum) throw new Error('No injected wallet found. Install MetaMask or the Binance Wallet extension.');
  if (!walletClient) {
    walletClient = createWalletClient({ chain: CHAIN, transport: custom(window.ethereum) });
    publicClient = createPublicClient({ chain: CHAIN, transport: http(CFG.rpcUrl || undefined) });
  }
  return { walletClient, publicClient };
}

async function ensureChain() {
  const { walletClient } = clients();
  const current = await walletClient.getChainId();
  if (current === CFG.chainId) return;
  try {
    await walletClient.switchChain({ id: CFG.chainId });
  } catch (err) {
    // Chain not added to the wallet (common for BSC testnet): add it, then switch.
    if (CFG.chainId === 97) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{ chainId: '0x61', chainName: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 }, rpcUrls: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545'], blockExplorerUrls: ['https://testnet.bscscan.com'] }],
      });
    } else {
      throw err;
    }
  }
}

$('connectBtn').onclick = async () => {
  try {
    const { walletClient } = clients();
    const [addr] = await walletClient.requestAddresses();
    account = addr;
    $('walletAddr').textContent = addr;
    $('loginBtn').disabled = false;
    log(`Wallet connected: ${addr}`);
  } catch (err) {
    log(`Connect failed: ${err.shortMessage ?? err.message}`);
  }
};

$('loginBtn').onclick = async () => {
  const handle = $('handleInput').value.trim().toLowerCase().replace(/\.ai$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle)) { log('Enter a valid handle: lowercase, without .ai'); return; }
  if (!account) { log('Connect your wallet first.'); return; }
  try {
    const { message, nonce } = await api('/agentid/login', { method: 'POST', body: JSON.stringify({ handle, address: account }) });
    const { walletClient } = clients();
    log(`Signing login challenge for ${handle}.ai …`);
    const signature = await walletClient.signMessage({ account, message });
    const { token } = await api('/agentid/verify', { method: 'POST', body: JSON.stringify({ handle, address: account, signature, nonce }) });
    localStorage.setItem('agentforge_session', token);
    await refreshMe();
    log(`Signed in as ${handle}.ai`);
  } catch (err) {
    log(`Sign-in failed: ${err.message}`);
  }
};

async function refreshMe() {
  try {
    me = await api('/agentid/me');
  } catch {
    me = null;
    localStorage.removeItem('agentforge_session');
    return;
  }
  $('profile').innerHTML = me.avatarUrl
    ? `<img class="avatar" src="${me.avatarUrl}" alt=""> <strong>${me.handleAi}</strong> <span class="muted">${me.address}</span>`
    : `<strong>${me.handleAi}</strong> <span class="muted">${me.address}</span>`;
  $('createRepoBtn').disabled = false;
  await loadRepos();
}

async function loadRepos() {
  const repos = await api('/api/v3/user/repos?per_page=100');
  const list = $('repoList');
  if (repos.length === 0) { list.innerHTML = '<p class="muted">No repos yet — create one above.</p>'; return; }
  list.innerHTML = '';
  for (const r of repos) {
    const div = document.createElement('div');
    div.className = 'card';
    div.innerHTML = `<strong>${r.full_name}</strong> <span class="muted">${r.private ? 'private' : 'public'}</span><br>
      <span class="muted">${r.description ?? ''}</span>
      ${r.chain_repo_id != null ? `<br><span class="muted">on-chain repo #${r.chain_repo_id}</span>` : '<br><span class="muted">not registered on-chain</span>'}`;
    const btn = document.createElement('button');
    btn.className = 'secondary';
    btn.textContent = 'Open issues';
    btn.onclick = () => openRepo(r);
    div.appendChild(document.createElement('br'));
    div.appendChild(btn);
    list.appendChild(div);
  }
}

$('createRepoBtn').onclick = async () => {
  const name = $('repoName').value.trim();
  if (!name || !me) return;
  const description = $('repoDesc').value.trim();
  const isPrivate = $('repoPrivate').checked;
  try {
    let chainRepoId;
    if (CFG.contractAddress) {
      await ensureChain();
      const { walletClient, publicClient } = clients();
      const registry = await loadAbi();
      log(`Registering "${name}" on-chain — confirm in your wallet…`);
      const hash = await walletClient.writeContract({
        account, chain: CHAIN, address: CFG.contractAddress, abi: registry,
        functionName: 'registerRepo', args: [name, isPrivate ? 'private' : 'public'],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      for (const entry of receipt.logs) {
        try {
          const evt = decodeEventLog({ abi: registry, data: entry.data, topics: entry.topics });
          if (evt.eventName === 'RepoRegistered') chainRepoId = Number(evt.args.repoId);
        } catch { /* not our event */ }
      }
      log(`On-chain repo #${chainRepoId} registered (tx ${hash.slice(0, 18)}…)`);
    } else {
      log('No ForgeRegistry deployed yet — creating an off-chain-only repo.');
    }
    const repo = await api('/api/v3/user/repos', {
      method: 'POST',
      body: JSON.stringify({ name, description, private: isPrivate, ...(chainRepoId !== undefined ? { chain_repo_id: chainRepoId } : {}) }),
    });
    log(`Repo created: ${repo.full_name}`);
    await loadRepos();
  } catch (err) {
    log(`Create repo failed: ${err.shortMessage ?? err.message}`);
  }
};

let currentRepo = null;
async function openRepo(repo) {
  currentRepo = repo;
  $('issues').hidden = false;
  $('issueRepoName').textContent = repo.full_name;
  await loadIssues();
}

async function loadIssues() {
  const repo = currentRepo;
  const issues = await api(`/api/v3/repos/${repo.owner.login}/${repo.name}/issues?state=all&per_page=100`);
  const list = $('issueList');
  list.innerHTML = '';
  if (issues.length === 0) { list.innerHTML = '<p class="muted">No issues yet.</p>'; return; }
  for (const issue of issues) {
    const div = document.createElement('div');
    div.className = 'card';
    const bounty = issue.bounty_wei != null ? formatEther(BigInt(issue.bounty_wei)) : null;
    div.innerHTML = `<strong>#${issue.number} ${issue.title}</strong> <span class="muted">${issue.state}</span><br>
      <span class="muted">${issue.body ?? ''}</span><br>
      <span>Bounty escrowed: <strong>${bounty === null ? '—' : `${bounty} BNB`}</strong></span>`;
    const row = document.createElement('div');
    row.className = 'row';
    if (CFG.contractAddress && repo.chain_repo_id != null) {
      const amt = document.createElement('input');
      amt.placeholder = 'BNB amount'; amt.size = 10;
      const post = document.createElement('button');
      post.textContent = 'Post bounty';
      post.onclick = () => postBounty(repo, issue, amt.value);
      const contrib = document.createElement('input');
      contrib.placeholder = 'contributor address (0x…)'; contrib.size = 42;
      const release = document.createElement('button');
      release.textContent = 'Release to contributor';
      release.onclick = () => releaseBounty(repo, issue, contrib.value.trim());
      const cancel = document.createElement('button');
      cancel.className = 'secondary';
      cancel.textContent = 'Cancel bounty (refund owner)';
      cancel.onclick = () => cancelBounty(repo, issue);
      row.append(amt, post, contrib, release, cancel);
    } else {
      const span = document.createElement('span');
      span.className = 'muted';
      span.textContent = 'Bounties need a deployed ForgeRegistry and an on-chain-registered repo.';
      row.appendChild(span);
    }
    div.appendChild(row);
    list.appendChild(div);
  }
}

async function contractWrite(fn, args, value) {
  await ensureChain();
  const { walletClient, publicClient } = clients();
  const registry = await loadAbi();
  const hash = await walletClient.writeContract({
    account, chain: CHAIN, address: CFG.contractAddress, abi: registry,
    functionName: fn, args, ...(value !== undefined ? { value } : {}),
  });
  log(`${fn} submitted: ${hash} — waiting for confirmation…`);
  await publicClient.waitForTransactionReceipt({ hash });
  log(`${fn} confirmed.`);
}

async function postBounty(repo, issue, amountStr) {
  let value;
  try { value = parseEther(amountStr); } catch { log('Enter a valid BNB amount, e.g. 0.01'); return; }
  if (value <= 0n) { log('Bounty must be > 0 BNB.'); return; }
  try { await contractWrite('postBounty', [BigInt(repo.chain_repo_id), BigInt(issue.number)], value); await loadIssues(); }
  catch (err) { log(`Post bounty failed: ${err.shortMessage ?? err.message}`); }
}

async function releaseBounty(repo, issue, contributor) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(contributor)) { log('Enter the contributor wallet address (0x…).'); return; }
  try { await contractWrite('releaseBounty', [BigInt(repo.chain_repo_id), BigInt(issue.number), contributor]); await loadIssues(); }
  catch (err) { log(`Release failed: ${err.shortMessage ?? err.message}`); }
}

async function cancelBounty(repo, issue) {
  try { await contractWrite('cancelBounty', [BigInt(repo.chain_repo_id), BigInt(issue.number)]); await loadIssues(); }
  catch (err) { log(`Cancel failed: ${err.shortMessage ?? err.message}`); }
}

$('createIssueBtn').onclick = async () => {
  const title = $('issueTitle').value.trim();
  if (!title || !currentRepo) return;
  try {
    await api(`/api/v3/repos/${currentRepo.owner.login}/${currentRepo.name}/issues`, { method: 'POST', body: JSON.stringify({ title }) });
    $('issueTitle').value = '';
    await loadIssues();
  } catch (err) { log(`Create issue failed: ${err.message}`); }
};

// Boot
$('contractNote').textContent = CFG.contractAddress
  ? `ForgeRegistry: ${CFG.contractAddress} (chain ${CFG.chainId})`
  : 'ForgeRegistry not deployed yet — repos work off-chain; bounty buttons appear once CONTRACT_ADDRESS is set.';
(async () => {
  if (localStorage.getItem('agentforge_session')) await refreshMe();
})();
