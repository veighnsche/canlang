# MCP P3 (e2e MCP leg) — failing-first evidence

Date: 2026-10-05. Branch: `muse/closeout/mcp`. Packet: `/tmp/mcp-scope.md` §c-P3.

## Files written (new only; no existing file touched)

- `tests/e2e/bridges/mcp-bridge.ts` — minimal MCP JSON-RPC client over
  `HttpBridge`: one `fetch` POST of `{jsonrpc,id,method,params}` to
  `<bridge.url>/mcp` per call, `{status, body}` returned verbatim, plus
  narrowers (`rpcResult`, `rpcErrorFrom`, `toolsFromList`,
  `toolResultFromCall`). Shapes mirror the `createMcpHandler` contract
  (`packages/interfaces/src/mcp/server.ts`, proven by
  `packages/interfaces/test/mcp-server.test.ts`): grant-only Bearer auth,
  401 `{error:{code,message}}` for bad grants, `initialize`/`tools/list`/
  `tools/call` result shapes, `isError` denials, `-32602` framing errors.
- `tests/e2e/fixtures/mcp-grants.ts` — `mintMcpGrant(baseUrl,
  sessionToken, clientId)` fixture: drives the TEST-ONLY
  `POST /__e2e/mcp-grant` worker endpoint (session cookie in, `{token,
  grant_id, user_id, team_id}` out), the same pattern as `seedTeamUsers`.
  The endpoint mints via real L6 `issueMcpGrant`; this module only
  transports and never invents identity semantics.
- `tests/e2e/apps/teamtasks-mcp.spec.ts` — B1 MCP leg: real workerd/D1,
  two team users (alice, bob) plus a second-team outsider; grant →
  `tools/list` contains `TeamTasks.Todo.create` → `tools/call` round-trip
  → denied read is `isError` with the safe projection → parity row vs the
  HTTP leg (MCP-created and HTTP-created tasks render together and persist
  in the same D1 table).

## Expected-failure transcript (today: all 4 fail, right reasons)

`bun run test:e2e -- tests/e2e/apps/teamtasks-mcp.spec.ts` → `4 failed`.
`beforeAll` (label, D1 seed, 3 users over 2 teams) passes; every failure is
a missing MCP piece:

1. `mcp route requires grant auth (401, never 404)` — **Expected: 401,
   Received: 404.** The fixture worker has no `POST /mcp` route (falls
   through to `not found`). This is scope §b.3.
2. `tools/list contains the .can operation with its closed schema` —
   `e2e mcp-grant: worker answered 404 (needs the TEST-ONLY
   POST /__e2e/mcp-grant endpoint, which mints via real L6 issueMcpGrant)`.
   This is scope §b.5; past it, the test would exercise the route (§b.3)
   and descriptors (§b.1–2).
3. `tools/call round-trips through the same worker as HTTP (parity row)` —
   same grant-endpoint 404.
4. `denied read is isError with the safe projection` — same grant-endpoint
   404.

Descriptors gap (static, scope §b.1–2): the fixture artifact declares
`callables: []` (`tests/e2e/fixtures/handbuilt/teamtasks.ts:72`) and zero
`OperationRegistry` impl exists outside `interfaces/src/testing.ts` fakes,
so even a routed `/mcp` could list no `.can` operation today.

Regression check: `teamtasks.spec.ts` + `scaffold.spec.ts` → **11 passed**;
`bun run typecheck:e2e` clean. `git status` shows only the three new files
above plus this doc. Nothing committed.

## What P1/P2 must deliver for this spec to pass

From P1 (codegen descriptors):

- Canonical operation names the spec pins: `TeamTasks.Todo.create` and
  `TeamTasks.Todo.read`, derived from `app TeamTasks` + `crud Todo`
  (`examples/TeamTasks.can:2,13`) in `package.Model.verb` form. **If P1
  emits a different package case or verb set, these two spec constants are
  the one-line fix** — flag the names on landing.
- `Todo.create` descriptor inputs with `title` required (source:
  `title:text`, no default) so the closed schema's ordinary branch carries
  `title` + framing `operation_id`; non-empty description text per tool.

From P2 (worker `/mcp` route):

- `POST /mcp` → `createMcpHandler` with assembled `McpDeps` (registry =
  join J3 over P1 artifact data, permissions = join J2 over L3 grants,
  invoker = the same canonical invocation the HTTP leg uses).
- Unauthenticated `initialize` → HTTP 401 `{error:{code:"forbidden",
  message:"Authentication required."}}` (spec test 1 pins this).
- Member `tools/call TeamTasks.Todo.create {operation_id, title}` commits
  a D1 row the `/` page renders (`done = 0`); non-member `tools/call
  TeamTasks.Todo.read {}` → `isError`, `structuredContent.code =
  "forbidden"`, uniform safe message (permission check precedes framing,
  so empty args must still deny, never `-32602`).
- TEST-ONLY `POST /__e2e/mcp-grant` on the worker the e2e suite drives:
  verifies the session cookie with real `resolveIdentity`, mints with real
  `issueMcpGrant`, returns `{token, grant_id, user_id, team_id}`.

Join warning (for whoever wires the fixture): P2's seam is
`packages/cloudflare/src/worker/assembly.ts`, but e2e drives the
hand-built fixture worker (`tests/e2e/fixtures/handbuilt/`), which does
not use that assembly — the fixture worker must also gain the `/mcp` and
`/__e2e/mcp-grant` routes (or e2e must switch to the real assembly) before
this spec can pass. Likewise, if P2 lands with an interim deny-closed
permissions adapter, the member round-trip test stays red by design until
join J2 lands.
