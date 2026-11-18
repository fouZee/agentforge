# AgentForge — promotion drafts (Binance Agent ID Hackathon)

Status: DRAFTS ONLY. Do not post until the forge is live on a public URL and
the ForgeRegistry contract is deployed + verified on BNB mainnet. Replace
`[LIVE URL]` and `[CONTRACT]` with the real values before posting.

Community Promotion Award: 20 winners share 2,000 USDC ($100 each) for
original X posts about participating projects, with hashtags
#BinanceWalletHackathon and #AgenticWallet. Submit the X link via the
official campaign survey (app.binance.com link from the announcement).

## Post 1 — project intro (English)

AgentForge: a git forge where your Binance Agent ID *is* your identity. 🛠️

- Repos owned by `.ai` names, not usernames
- Collaborators must hold an Agent ID
- Bounties escrowed in BNB on-chain, released on merge

Built on a GitHub-compatible forge (git smart HTTP, REST, GraphQL, MCP).
Live now: [LIVE URL]
Contract: [CONTRACT]

#BinanceWalletHackathon #AgenticWallet

## Post 2 — how Agent ID is used (English, depth angle)

How AgentForge uses Agent ID — not as a login badge, but as the core:

1. You sign in with the wallet that holds your `.ai` name
2. The server verifies on-chain: `ownerOf(keccak256(handle)) == your address`
3. Every repo action (create, collaborate, bounty) is gated on
   `balanceOf(your address) > 0` in the ForgeRegistry contract

Agent ID is soulbound, so reputation sticks to the name. No transfer, no
selling your identity.

Try it: [LIVE URL]

#BinanceWalletHackathon #AgenticWallet

## Post 3 — intro (Bahasa Indonesia)

AgentForge: git forge yang identitasnya pakai Binance Agent ID. 🛠️

Repo dimiliki nama `.ai`, kolaborator wajib pegang Agent ID, bounty BNB
di-escrow on-chain dan cair pas PR di-merge.

Coba langsung: [LIVE URL]
Kontrak: [CONTRACT]

#BinanceWalletHackathon #AgenticWallet

## Posting plan

1. Deploy contract to mainnet + verify on BscScan; host forge on Render.
2. Post 1 (intro) once live; submit its X link via the campaign survey.
3. Post 2 after the first real repo + bounty exists on the live site.
4. Post 3 (Bahasa) to reach the Indonesian builder community.
5. Pin the live URL + contract in the replies; engage with every reply —
   the 30-Agent-ID-addresses bar for the Innovation Award is the real goal,
   the $100 X posts are a bonus, not the main prize.
