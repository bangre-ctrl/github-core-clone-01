# github-core-clone-01 — a GitHub-compatible git forge

A single-process, in-memory forge written in TypeScript for Node 22+,
using only the Node standard library (`node:http`, `node:crypto`,
`node:zlib`). It speaks enough of GitHub's surface to be driven by a real
git client, by `gh`-style GraphQL documents, and by an MCP client — all
against the same store.

## Running

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` binds port 0, registers the port with the environment
(`$MAKEFUN_ENV_URL/register`), then polls `$MAKEFUN_ENV_URL/done` until the
environment says it is finished and exits 0. For local development you can
start just the app instead:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types -e \
  "import('./app.ts').then(m => m.createApp().listen(18080))"
```

## What it implements

- **REST v3** (`/api/v3`): repositories (create/list/get/patch/delete,
  `Link` pagination), branches, commits, contents (create/update with
  stale-sha 409, delete), labels, issues (create/list/get/patch/comments),
  pull requests (create/get/list/files, squash merge with conflict
  detection). Every response is JSON, carries a non-empty
  `X-GitHub-Request-Id`, and unknown routes return 404 with a `message`.
- **Git smart HTTP** (`/{owner}/{repo}.git`): `info/refs` for
  `git-upload-pack` (protocol v2 and v0) and `git-receive-pack` (v0),
  packfile creation and parsing (OFS/REF deltas, thin packs, sideband),
  shallow fetch / deepen / unshallow, fast-forward push checks with
  per-ref `ok`/`ng` report-status.
- **GraphQL** (`/api/graphql`): `viewer`, `repository` (fields, issues and
  pull-request connections with cursor pagination, `__type` introspection
  for `Issue`/`PullRequest`/`Repository`/`SearchType`), `node(id:)` global
  IDs, and mutations `createIssue`, `closeIssue`, `createPullRequest`,
  `mergePullRequest`, `addComment`. Batched operation arrays are answered
  in order; unknown fields produce GraphQL errors with HTTP 200.
- **MCP** (`/mcp`, streamable HTTP): `server/discover` (modern era) and
  legacy `initialize`, plus `tools/list` and `tools/call` for six tools —
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request` — acting on the same store
  as REST and GraphQL.

## Notes on the model

- The store is in-memory and deterministic: generated commits use a fixed
  epoch plus a monotonic counter, and REST objects use fixed timestamps, so
  two runs export the same bytes.
- Authentication is a Bearer token from `MAKEFUN_SHOP_TOKEN` (if the
  variable is empty, any non-empty Bearer is accepted, for local use only).
  `/healthz` needs no token. A repository under another owner is 404,
  never 403.
- Fetch responses are cached per (repository, wants, haves, shallow,
  depth); objects are content-addressed and immutable, so a cached pack
  can never go stale.
