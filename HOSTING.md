# AgentForge — Hosting

Last updated: 2026-11-18 ~18:40 WIB. Status: **NO live public URL yet — blocked, see below.**
Forge code owner: the forge agent (`server.ts` does not exist yet; the tunnel/Render
deploy below points at `localhost:8080` / `$PORT` either way, so no hosting change
is needed once the real server lands).

## Test evidence (2026-11-18)

- VM has public IPs (v4 `104.29.193.195`, v6 `2606:54c1:1:16e::1c:2ae`) but
  **inbound connections are blocked**: a test HTTP server on port 18080 answered
  `200` on `127.0.0.1` but timed out/failed via both public IPs. Direct hosting
  from this VM is impossible — a tunnel or an external host is required.
- `cloudflared` **installed**: `~/workspace/hackathon/agentforge/bin/cloudflared`,
  version 2026.11.1 (built 2026-11-17). Free, no account needed for quick tunnels.
- **Quick tunnel is blocked from this VM**: `cloudflared tunnel --url
  http://127.0.0.1:8080` fails with `tls: first record does not look like a TLS
  handshake` when requesting a tunnel, and `curl` to `https://trycloudflare.com`
  and `https://api.trycloudflare.com` returns **403** through the VM's egress
  proxy. The trycloudflare API is not reachable from here, so no quick-tunnel
  URL can be created on this VM. (Same egress proxy also blocks `vercel.com`.)
- Reachable from this VM (good for deploys): `github.com`, `api.github.com`,
  `registry.npmjs.org`, `render.com` (200), `fly.io` (200), `railway.app` (301).
- `gh` CLI is **not logged in** (`gh auth status`: not logged into any GitHub
  hosts), so no free-tier host could be created from here without a login.
- `systemd` is PID 1 and running; this VM runs as root. No `crontab` binary.

## Chosen option: Render free tier (recommended)

Most reliable free option needing **no payment method**. Needs only a Render
account (email / GitHub / Google login) — that login step needs the user (or an
agent with a browser), which is why it is not set up yet. Do NOT use a paid plan.

### Setup steps (user / browser agent)

1. Push the AgentForge code to a public GitHub repo (e.g. `fouZee/agentforge`).
   The repo must contain `package.json` (name `agentforge`, `start` script
   `node --experimental-strip-types server.ts`), `server.ts`, `contracts/`,
   and `README.md`. Do NOT commit `contracts/deployer.key` or `data/`.
2. Create a free account at https://render.com (sign up with GitHub).
   No credit card is required for free web services.
3. Dashboard → **New + → Web Service → Build and deploy from a Git repository**
   → connect the AgentForge repo.
4. Settings: Runtime **Node**, Build Command `npm install`, Start Command
   `npm start`. Instance type **Free**. Render sets `$PORT` automatically;
   the server must bind `0.0.0.0:$PORT` (spec says `$PORT`, default 8080).
5. Deploy. Render gives a stable URL like
   `https://agentforge-xxxx.onrender.com` — put it in `SUBMISSION.md` and below.
6. Verify: `curl https://<url>/healthz` returns 200.

### Caveats (Render free)

- **Sleeps after ~15 min of inactivity**; first request after sleep takes
  ~30–60 s to wake. Acceptable for a hackathon demo, but warm it before judging.
- **Ephemeral filesystem**: `data/forge.json` (repo store) is lost on redeploy /
  restart. Repos created on the live site will disappear after a restart.
  A persistent disk is a paid Render feature — do not buy one without asking.
  Mitigation: re-seed demo repos after a restart, or keep the canonical repo
  data in the git repo / re-create via the UI.
- Free tier has limited hours; fine for the ~3 weeks until 2026-12-09.

## Fallback: cloudflared quick tunnel (only from an unrestricted network)

Works from a laptop/home network, NOT from this VM (egress proxy blocks it).

```bash
# 1. Start the forge (binds $PORT, default 8080)
cd ~/workspace/hackathon/agentforge && npm start

# 2. In another terminal — binary already on this VM:
./bin/cloudflared tunnel --url http://127.0.0.1:8080
# or, on another machine: download from
# https://github.com/cloudflare/cloudflared/releases/latest
# then: cloudflared tunnel --url http://localhost:8080
```

- Cloudflared prints a URL like `https://<random>.trycloudflare.com` — that is
  the public website URL. Copy it into `SUBMISSION.md` and into
  `hosting/current-url.txt`.
- **Caveats**: the URL is random and **changes on every restart**; quick
  tunnels have no uptime guarantee and die if the process/VM stops. Not stable
  enough to submit as the website URL unless re-checked right before submitting.
- Keep-alive: run it under systemd so it restarts. Unit (NOT installed here,
  because it would fail against the blocked egress proxy):

```ini
# /etc/systemd/system/agentforge-tunnel.service
[Unit]
Description=AgentForge Cloudflare quick tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/workspace/hackathon/agentforge
ExecStart=/root/workspace/hackathon/agentforge/bin/cloudflared tunnel --url http://127.0.0.1:8080
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now agentforge-tunnel
journalctl -u agentforge-tunnel -f   # read the current trycloudflare URL from the log
```

- A named tunnel (stable hostname) needs a Cloudflare account + a domain —
  not set up; needs the user to provide both.

## Why not the others

- **Fly.io**: free allowance exists, but signup requires a credit card — blocked
  (no payment method; do not add one without the user).
- **Railway**: account + usage-based billing; free trial is limited and the
  hobby path needs a payment method for sustained use — worse than Render.
- **Vercel**: `vercel.com` is unreachable from this VM, and the forge is a
  long-lived Node server, a poor fit for serverless.
- **Direct VM hosting**: inbound ports blocked (tested above).

## Current live URL

_(none yet — fill in once Render is deployed)_

- Website URL: TBD
- Health check: TBD (`/healthz`)
- Tunnel URL file: `hosting/current-url.txt` (created when a tunnel runs)

## How to restart

- Render: Dashboard → service → **Manual Deploy → Deploy latest commit**;
  or push to the connected GitHub repo (auto-deploy if enabled).
- Quick tunnel (unrestricted network only): re-run the `cloudflared tunnel`
  command above; the URL changes — update `SUBMISSION.md` and
  `hosting/current-url.txt`.

## Temporary placeholder (delete me)

`hosting/placeholder.mjs` is a minimal Node server that served `/` and
`/healthz` on port 8080 only to prove the tunnel path. It was stopped after
testing. Delete the file once `server.ts` exists; the tunnel/Render config
does not depend on it.

## Update 2026-11-18 — temporary tunnel attempt FAILED

Tried localhost.run as a temporary public URL (no account needed): SSH is blocked — the egress proxy (198.19.0.1:3128) resets the connection (`kex_exchange_identification: read: Connection reset by peer`, exit 255). cloudflared quick tunnels are also blocked (403 for trycloudflare.com). No account-free tunnel works from this VM. Render free tier remains the only path to a stable public URL.

The forge server was restarted in production mode (no `AGENTFORGE_DEV_VIEWER`) on port 8090 and verified healthy: `/healthz` OK, UI 200, unauthenticated mutations and `/agentid/me` return 401. It is ready to expose as soon as hosting lands. Note: a VM restart will stop this server; it needs `PORT=8090 node --experimental-strip-types server.ts` (no dev flag) to come back.
