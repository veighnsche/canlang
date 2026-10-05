# MCP P2 (worker /mcp route) — evidence

Date: 2026-10-05. Branch: `muse/closeout/mcp`. Packet: `/tmp/mcp-scope.md` §c-P2.

## Files (only these)

New:

- `packages/cloudflare/src/runtime/mcp-registry.ts` — artifact→`OperationRegistry`
  adapter (join J3): `createArtifactRegistry`, `createArtifactCatalog`,
  `createDenyClosedMcpPermissions`. Ports.ts types mirrored verbatim
  (each cites its source line); worker-safe (type-only contracts import,
  no `node:` builtins, pure functions).
- `packages/cloudflare/test/mcp-route.test.ts` — 13 tests: raw JSON-RPC
  initialize/list/call through the assembled worker (see route proofs).

Modified:

- `packages/cloudflare/src/worker/assembly.ts` — `POST /mcp` route
  (`handleMcpRequest`): assembles the real `McpDeps` per request and
  delegates to the injected `createMcpHandler`. `AssemblyDeps` gains
  `mcp?: McpJoin` (`createHandler` + optional `permissions` override).
  `buildInterimFetch` now takes an `InterimDispatchContext` (same page
  behavior; see no-regression proof). Dynamic-`import()` only for the
  registry sibling; `test/worker-boundary.test.ts` still green.

Untouched per scope: `compiler/`, `contracts/`, `runtime/artifact.ts`,
`tests/e2e/`. No commit (per instructions).

## P1 join (confirmed, not assumed)

`CompileArtifact.operations` has not landed, so the builders read it
defensively (absent → empty registry, never a throw). The SHAPE is
confirmed against the sibling's in-flight contract, read on 2026-10-05:

- `compiler/tests/mcp_p1.rs` golden: entries carry exactly
  `{name, kind, description, inputs}` with
  `inputs = {fields: [{name, field, required}]}`; op kinds observed:
  `create`/`update`/`delete`/`scenario` (all in the `McpOperationKind`
  vocabulary); field schemas `{kind}` + `model`/`requireVersion` for
  `ref`, `values` for `enum`; `description: ""` when no `#` text.
- `test/artifact-operations.test.ts` compat: `operations` additive
  (old artifacts load without it); strict dotted-path errors.

The adapter accepts exactly this contract (`inputs` object with a
`fields` array — a first draft assumed a bare array and was corrected
before landing) and mirrors P1's dotted-path error vocabulary
(`operations[0].inputs.fields[2].field.values must be a non-empty
array of strings`, …). It additionally rejects duplicate operation
names and duplicate input names (ambiguous mappings fail loud).
Residual risk: if P1's LANDED contracts type spells anything
differently from its own tests, the route answers 500 `mcp-registry`
naming the entry (contained to `/mcp`; pages keep serving) until the
two are reconciled — the failure is loud, never silent.

## McpDeps assembly (per `/mcp` request, in `handleMcpRequest`)

| Member | Binding | Join status |
|---|---|---|
| `app` | `interimAppInfo(artifact)` (existing) | interim (L1 binds real `AppInfo` at the appDefinition join) |
| `registry` | `createArtifactRegistry(artifact)` via dynamic import | PRODUCTION (join J3) |
| `permissions` | `mcp.permissions` override, else `createDenyClosedMcpPermissions()` | INTERIM deny-closed (join J2 pending — see below) |
| `invoker` | `buildInvoker(artifact, asm, store)` — THE same bridge `HttpDeps` consumes at the HTTP join | PRODUCTION bridge (one invoker, both transports) |
| `catalog` | `createArtifactCatalog(artifact)` via dynamic import, same entries as registry | PRODUCTION (join J3) |
| `files` | `usesFiles` from `deps.files`, `intentsUrl` = `/files/intents` | interim URL (same-origin path; deploy join may absolutize) |
| `identity.store` | `deps.identityStore` threaded through (`unknown` by worker-boundary design) | join seam (deploy binds the real `IdentityStore`) |
| `identity.mail` | fail-closed thrower (no MCP flow sends mail) | interim (never called on this path) |
| `identity.clock` / `clock` | `deps.now ?? Date.now` | assembled |
| `identity` URLs / `sessionMaxAgeSeconds` | `""` / `0` (unused on the MCP path; grant challenge derives origin from the request URL) | HTTP/auth join binds real values |
| `logger` | worker `console` (`[mcp] <level> <message>`; fields are safe-envelope members only) | interim (no sink join yet) |
| `createHandler` | injected `AssemblyDeps.mcp.createHandler` (the REAL `createMcpHandler`; absent → 501 naming the interfaces join) | deploy join bundles `@canlang/interfaces` for workerd |

Static proof: `mcp-route.test.ts` assigns `createArtifactRegistry` /
`createArtifactCatalog` / `createDenyClosedMcpPermissions` results to
the REAL `ports.ts` types imported from interfaces dist, and the
assembled `McpDeps` mirror (modulo the documented `identity.store`
seam) to the real `McpDeps` — these assertions compile only on exact
structural identity. Runtime proof: the real `createMcpHandler` runs
against the assembled deps in every route test below.

## Interim permissions status (DOCUMENTED LIMITATION)

Join J2 (L3 grant rechecks) is unavailable: the worker has no
per-operation grant store, so `McpPermissions` cannot be honestly
implemented yet. The default is deny-CLOSED
(`createDenyClosedMcpPermissions`: `canDiscover`/`canCall` always
false) — never fail-open. Consequences while interim:

- With default permissions, `tools/list` is `[]` and every `tools/call`
  answers `isError`-forbidden (uniform safe projection), even for
  valid grants. Proven by the deny-closed test.
- Tests (and, later, the L3 join) override via
  `AssemblyDeps.mcp.permissions`.
- No existence oracle is introduced by the adapter itself: unknown
  tools answer `-32602` while known-but-denied tools answer
  `isError`-forbidden, which is the DESIGN taxonomy (operation names
  are not secret).

## Route proof transcript (assembled worker, real grant, real invoker)

12 of 13 tests use the allow-all override to prove the route; the
deny-closed test uses the production default:

- `initialize` → 200 `serverInfo.name "can-mcp"`, protocol `2025-11-25`.
- `tools/list` → both fixture ops, descriptions verbatim; read op gets
  the plain closed schema, the mutation an `anyOf` with required
  `operation_id` + `title`.
- `tools/call acme.Todo.read {}` → op-module payload
  (`rows: [{id "t1", …}]`), `caller` = grant user id (not anonymous).
- `tools/call acme.Todo.create {operation_id, title}` → `{status:
  "committed", operation_id, title}` echo.
- SAME-invoker proof: `buildInvoker(artifact, asm,
  store).invokeMutation(sameEnvelope, resolvedGrantIdentity)` deep-equals
  the MCP payload (`{result: mcpPayload}`).
- No grant → 401 `{error:{code:"forbidden"}}` + `www-authenticate:
  Bearer`; bogus token → 401.
- Unknown tool → `-32602` (`Unknown tool 'nope.unknown'`); missing
  required / unknown member / missing `operation_id` → `-32602`.
- Malformed `operations[]` → 500 `{code:"mcp-registry"}` naming
  `operations[0].kind` (contained; pages unaffected).
- Artifact without `operations` → 200 with `tools: []` (P1-pending tolerance).
- No factory → 501 `{code:"assembly-interim"}` naming the interfaces join.
- Pages + `opCount` unchanged (1 page serves 200, `opCount` 2).

## Verification

- `bunx vitest run packages/cloudflare/test/mcp-route.test.ts
  packages/cloudflare/test/worker-boundary.test.ts
  packages/cloudflare/test/assembly.test.ts` → 3 files, 37 tests, ALL PASS.
- Full cloudflare suite → 22/23 files, 216/232 tests pass; the 16
  failures are ALL in the sibling P1's `test/artifact-operations.test.ts`
  (failing-first red against its unlanded `runtime/artifact.ts`
  validation — P1's packet, explicitly out of P2 scope; not authored or
  touched here).
- `bun run --filter @canlang/cloudflare build` → exit 0 (composite
  `rootDir` compliance for the new runtime module).
- `bun run typecheck` → the only 5 errors repo-wide are in P1's
  `test/artifact-operations.test.ts` (references unlanded
  `CompileArtifact.operations`); zero errors in `mcp-registry.ts`,
  `mcp-route.test.ts`, `assembly.ts`.
- Failing-first transcript: new test red on missing module (run 1),
  then 10 behavioral failures incl. 404s on `/mcp` with only the
  registry present (run 2), then green after the assembly route (run 3);
  the `inputs`-shape correction was re-proven green after the P1
  alignment edit (final: 13/13).

## Open items for the coordinator

1. P3's evidence assumes a TEST-ONLY `POST /__e2e/mcp-grant` worker
   endpoint minting via `issueMcpGrant` — no packet (P1/P2/P3) is scoped
   to add it to `assembly.ts`. P3's e2e leg needs an owner for that endpoint.
2. SDK-under-workerd (`PLAN.md:130`) is NOT verified here: the route
   runs the real SDK server under vitest/node, but the deploy join that
   bundles `@canlang/interfaces` + `@modelcontextprotocol/sdk` for
   workerd does not exist yet. First workerd smoke of `/mcp` stays open.
3. `McpFilesInfo.intentsUrl` returns the same-origin path
   `/files/intents`; confirm the deploy join wants a path (not an
   absolute URL) in the `_meta` file-transfer advertisement.
