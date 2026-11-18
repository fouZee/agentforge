# github-core-clone-01 — a GitHub-compatible git forge

A standalone GitHub-compatible git forge for [the contest](https://make.fun/bounty/github-core-clone-01):
git smart HTTP (protocol v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP from one
process over an in-memory store. Standard library only — no dependencies, no git binary, no network,
no UI. Local conformance: **120/120 checks, perf 132/200, score 932/1000** against the kit's
`sdk/run.ts` (Node 22.18.0).

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib` and its
own `app.ts` only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
   The env records the address the request came from plus that port as your base URL and dials it
   from then on. The first register wins.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   exit before it says `true`.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-OAuth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer/repository/node/`__type`, issues/pullRequests connections with cursor pagination, and the five mutations |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover` (2026-07-28), `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` |
| anything else | 404 `{"message":"Not Found"}` |

Determinism: every timestamp the forge emits is fixed or counter-derived, so two runs on the same
instance behave identically. Packfiles carry plain objects only (no deltas); received packs resolve
OFS/REF deltas. Shallow fetches honour `deepen` and shallow boundaries; non-fast-forward pushes are
refused per-ref with `non-fast-forward`.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the whole server — scenario-derived viewer identity, git object model and packfiles,
  the in-memory store, REST v3, the GraphQL parser/executor, MCP, and routing.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.
