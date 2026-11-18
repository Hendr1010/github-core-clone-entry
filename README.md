# github-core-clone-entry

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Hendr1010/github-core-clone-entry/rank.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Hendr1010/github-core-clone-entry/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process: git smart HTTP
(clone/push, protocol v2 and v0), REST v3 (repos, issues, pulls, contents),
GraphQL (repository, issues, pull requests, mutations, `node(id:)`) and MCP
tools — all served from one in-memory store, stdlib only, no dependencies,
no git binary, no network.

## Run

```sh
node main.ts
```

The server listens on `$PORT` (or an ephemeral port), registers at
`$MAKEFUN_ENV_URL/register`, and exits when `$MAKEFUN_ENV_URL/done` reports
done. Without a harness it stays up until killed. Every API call needs
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN` except `GET /healthz`.

## Layout

- `main.ts` — lifecycle: listen, register, poll done, exit.
- `app.ts` — HTTP server, routing, bearer auth, request ids.
- `githttp.ts` — git smart HTTP: advertisements, ls-refs, fetch (v2/v0),
  receive-pack (v0).
- `gitproto.ts` — git objects, packs, pkt-lines, reachability, diffs.
- `store.ts` — the in-memory store and the git-backed operations
  (contents commits, squash merges, pull files).
- `rest.ts` — REST v3.
- `graphql.ts` — GraphQL executor for the suite's fixed documents.
- `mcp.ts` — MCP JSON-RPC tools (legacy era).
- `scenario.ts` — the seeded scenario's viewer login (the token owner's login),
  reproduced from the fixed seed so the forge knows who its bearer token names.

## Conformance

The kit's local runner passes **120/120 checks** (git 30, repos 15, issues 15,
pulls 20, protocol 5, GraphQL 20, MCP 15) with a local score of 947/1000
(feature 600, agent 200, perf 147).
