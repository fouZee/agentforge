# AgentForge — Submission prep (DO NOT SUBMIT)

Last updated: 2026-11-18 ~18:40 WIB. **Nothing has been submitted.**
Final submission is confirmed with the user first.

## Official source

- Announcement: https://www.binance.com/en/support/announcement/detail/95f5dbe0ea674a48a739b59e046648bf
  (also mirrored on Binance Square: https://www.binance.com/en/square/post/389517345917641)
- Hackathon: Binance Wallet × BNB Chain — Agent ID Hackathon, 60,000 USDC total.

## ⚠️ Submission form link: NOT FOUND (blocked item)

The announcement says: *"Submit your project name, website, contract
address(es), Agent ID usage description, and other required materials during
the Submission Period. No registration needed."* — but **neither the
announcement nor the Square mirror links a project-submission form**, and web
searches for "Agent ID Hackathon submission" (2026-11-18) surface no project
form either.

The ONLY survey link in the announcement is the **community-promotion
campaign survey** (for submitting X-post links for the 2,000 USDC X-post pool,
NOT confirmed as the project form):
https://app.binance.com/uni-qr/user-survey/ff6832f8d2984af289068c9450a3c98c
(a direct fetch of this link timed out on 2026-11-18; do not assume it is the
project form).

**Action needed before submitting:** re-check the announcement page, the
Binance Square post, and @BinanceWallet on X for a project-submission form
(Binance survey link). Do not submit through the X-campaign survey unless
Binance confirms it is the same form. If no form appears, the project may be
submitted via a Binance survey link published later in the Submission Period —
check again before 2026-12-09.

## Deadlines (WIB = UTC+7)

| Milestone | UTC | WIB |
|---|---|---|
| Submission Period | 2026-11-18 08:00 → 2026-12-09 08:00 | 2026-11-18 15:00 → **2026-12-09 15:00** |
| Internal Review Period | 2026-12-09 08:00 → 2026-12-17 08:00 | 2026-12-09 15:00 → 2026-12-17 15:00 |
| Public Review Period | 2026-12-17 08:00 → 2026-12-20 08:00 | 2026-12-17 15:00 → 2026-12-20 15:00 |

**Submission deadline: 2026-12-09 15:00 WIB.**

What happens after (per the announcement T&Cs):
- After submissions close, an **8-day review period** follows, then a **3-day
  public announcement period** (matches the Internal + Public Review dates
  above). Winners are announced officially by the Binance Wallet team after
  the public review period.
- **Rewards are distributed within 14 business days after the public
  announcement period ends**, sent to the **reward receiving address provided
  during project submission**. Keep the Binance account/wallet active — rewards
  are NOT sent to users who delete or deactivate their Binance Wallet/Account.
- Cheating can be reported until the end of the public announcement period
  (audit@binance.com). Each team may submit **one project only**. Each project
  can receive **one award** only. Winners of the two project-award tracks also
  each get one eligibility spot to claim a two-digit Agent ID.

## Submission materials (draft)

### Project name
**AgentForge**

### One-paragraph description
AgentForge is a live git forge where Binance Agent ID (`name.ai`) is the
identity layer. Developers sign in by signing a message with their wallet;
the server verifies the signature and checks on-chain that the signer owns
the Agent ID (`ownerOf(keccak256(handle))`). Repositories are owned by Agent
IDs, collaborators must hold an Agent ID, and repo bounties are escrowed in
BNB in the ForgeRegistry smart contract and released by the repo owner to the
contributor on merge. It is a working developer tool — code hosting, issues,
pull requests and bounties — with Agent ID enforced at every step instead of
bolted on.

### Website URL
**TBD — no live URL yet.** See `HOSTING.md`. Recommended path: Render free
tier (needs a Render account login by the user). Do not submit a
trycloudflare quick-tunnel URL unless it is re-verified live immediately
before submitting, as it changes on every restart.

### Contract addresses
| Contract | Network | Address | Status |
|---|---|---|---|
| ForgeRegistry | BSC testnet (chainId 97) | TBD | **Not deployed yet** — contract agent owns deployment; rehearse on testnet first |
| MockAgentId (test Agent ID ERC-721) | BSC testnet (97) | TBD | Not deployed yet; deployed alongside ForgeRegistry on testnet |
| ForgeRegistry | BSC mainnet (56) | `0x8ce4e9192A5825621BC0B0966C24C674D5ABe269` | **Deployed 2026-11-18 19:19 WIB**, tx `0xf70314885d68584046951eac6eef2ca4b5dbfa7b0c8323182bfe0d43c955733e`, block 134310274, deploy cost 0.000082111 BNB; source verification pending |
| Agent ID registry (reference, not ours) | BSC mainnet (56) | `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F` | SPACE ID Agent ID, ERC-721, soulbound |

Requirements before submitting: contract deployed on BNB Chain, **source
verified and open-sourced on BscScan**, code in a public repo. Mainnet deploy
is required for the on-chain ranking (Project Awards count only submitted
contract addresses; interacting addresses must hold an Agent ID).

### Agent ID usage description (for the form)
Agent ID is the identity and access-control layer of AgentForge, used in four
places: (1) **Login/identity** — a user signs a SIWE-style challenge
(`Sign in to AgentForge as <handle>.ai` + nonce); the server verifies the
signature and checks on-chain that `ownerOf(keccak256(handle))` equals the
signer and `balanceOf(signer) > 0` before issuing a session. (2) **Repo
ownership** — repositories are owned by Agent ID handles and displayed as
`handle.ai`. (3) **Collaborator gating** — only addresses holding an Agent ID
can be added as collaborators, enforced on-chain by ForgeRegistry.
(4) **Bounty escrow** — bounties are escrowed in BNB in ForgeRegistry and
released by the repo owner (an Agent ID holder) to the contributor on merge.
Agent ID is never used to look up other people's wallets by name: only the
logged-in user's own handle is ever displayed.

### Owner permissions (for the form / README)
ForgeRegistry has **no admin/owner powers at all**: no Ownable, no pause, no
upgrade, no mint, no freeze, no fund withdrawal except the defined
`releaseBounty` (owner → contributor) and `cancelBounty` (refund to owner).
Documented in the repo README.

### Source code / repo
- GitHub repo: TBD (code currently only in `~/workspace/hackathon/agentforge/`;
  must be pushed to a public repo, e.g. `fouZee/agentforge`, before submission).
- BscScan verification links: pending (contract deployed 2026-11-18 19:19 WIB;
  Sourcify rate-limited 429, no BscScan API key; BscScan API Cloudflare-blocked
  from this VM — retry Sourcify later or verify via browser).

### Reward receiving address
TBD — must be supplied at submission time (per the announcement, rewards are
sent to this address). Confirm with the user which address to use
(BNB Chain address able to receive USDC).

## Checklist — everything the form is expected to ask for

Based on the announcement ("project name, website, contract address(es),
Agent ID usage description, and other required materials") plus the eligibility
rules. Items marked ☐ are not yet ready.

- [x] Project name: AgentForge
- [x] Description (one paragraph, above)
- [ ] Website URL — live, public, reachable (see HOSTING.md; Render deploy pending)
- [x] Contract address(es) — ForgeRegistry deployed on BNB mainnet `0x8ce4e9192A5825621BC0B0966C24C674D5ABe269` (testnet rehearsal skipped by user choice)
- [x] Agent ID usage description (above)
- [ ] Reward receiving address (confirm with user)
- [ ] Public source-code repo link (GitHub; code not pushed yet)
- [ ] BscScan source-verified contract links (contract deployed 2026-11-18; verification pending — Sourcify rate-limited 429 on 2026-11-18 19:21 WIB, no BscScan API key, BscScan API Cloudflare-blocked from VM)
- [ ] Product live with core features working (login, repos, issues/PRs, bounties)
- [ ] Red-line compliance: no web QR-code login (injected wallet only); every
  user-asset action confirmed in the user's own wallet; no scheduled/bundled/
  hidden transfers; no unlimited approvals; no seed phrase / private key /
  API secret collection; no "Binance"/"BNB" brand impersonation in the name
  or domain; no promised returns; no name→wallet lookup page
- [ ] Innovation Award eligibility (if targeting it): **≥30 Agent ID addresses
  interacting with the submitted contract(s) during the Submission Period** —
  needs active outreach to Agent ID holders; currently 0 interactions
- [ ] Submission form link itself — NOT FOUND yet (see top of this file)
- [ ] One project per team — AgentForge is the only submission

## Awards (for context)

- **Agent ID Ecosystem Pioneer Award** (on-chain ranking: interacting Agent ID
  addresses, volume, tx count) — top 10 share 29,000 USDC
  (1st 10,000 / 2nd 6,000 / 3rd 4,000 / 4th 3,000 / 5th 2,000 / 6th–10th 800).
- **Agent Application Innovation Award** (judged, 100 pts: Agent ID depth 30%,
  practicality 25%, completion 25%, innovation 20%) — top 10 share 29,000 USDC
  (same split); needs ≥30 interacting Agent ID addresses and a live product.
- **Community Promotion (X posts)** — 20 winners share 2,000 USDC; post with
  #BinanceWalletHackathon and #AgenticWallet, submit the X link via the
  campaign survey above.

## Blocked / open items

1. **No project submission form link found** — re-check Binance channels
   before 2026-12-09 15:00 WIB.
2. **No live website URL** — Render deploy needs an account login (user).
3. **Contracts not deployed** (testnet or mainnet) — contract agent's work.
4. **Code not in a public GitHub repo yet** — `gh` is not logged in on this VM.
5. **0 Agent ID interactions so far** — the Innovation Award's 30-address
   threshold needs outreach once live.

## Update 2026-11-18 — project submission form check (no form exists yet)

Searched the Binance support announcement, the Binance Square mirror post (binance.com/en/square/post/389517345917641), and web coverage: there is NO public project-submission form or link for the Agent ID Hackathon as of 2026-11-18. The announcement says "Submit your project name, website, contract address(es), Agent ID usage description, and other required materials during the Submission Period. No registration needed." but names no destination. The only survey link anywhere in the announcement is the X-post Community Promotion campaign survey (app.binance.com) — that is for the 2,000 USDC X-post pool, NOT the project submission. Do NOT submit the project there.

Most likely the project form will be published later in the submission window. Re-check the announcement page, @BinanceWallet on X, and Binance Square before 2026-12-09. If a form appears, record its exact URL here before submitting anything.
