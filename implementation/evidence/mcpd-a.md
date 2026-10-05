# MCP-deploy P-A (serving-path wiring) — evidence

Date: 2026-10-05. Branch: `muse/closeout/mcp-deploy`. Packet: `/tmp/mcpd-scope.md` §c P-A.

## Files (only these)

New:

- `packages/cloudflare/src/worker/main.ts` — deploy worker main. Default-exports
  `{ fetch }`; P-B bundles the compiled `dist/worker/main.js` as the deploy main.
  The fetch is the REAL `createWorkerApp` binding gate (`./entry.js`, dynamic
  import) in front of the REAL `assembleWorker` dispatch (`./assembly.js`,
  dynamic import like P2's `loadSiblingFn` pattern), plus `POST /mcp/grants`
  routed to P-C's pinned `handleMcpGrant`. Loader injection
  (`createMainFetch`) covers the in-flight joins; every default loader is the
  production dynamic import.
- `packages/cloudflare/test/worker-main.test.ts` — 14 tests (see proofs).
- `implementation/evidence/mcpd-a.md` — this file.

Modified: none. `src/worker/entry.ts` untouched (not needed: `createWorkerApp`
already takes `requiredBindings`; main passes the real list).

Untouched per scope: `src/deploy/*`, `src/cli/*`, `src/runtime/*`, `src/dev/*`,
`packages/identity/*`. No commit (per instructions).

## Route table (main fetch, gate outermost)

| Request | env | Response | Owner |
|---|---|---|---|
| any path, `DB` absent | `{}` | 500 `missing-binding` (`binding: "DB"`) via the REAL `createWorkerApp` | P-A (`entry.ts`, unchanged) |
| `POST /mcp/grants`, grant join present | `DB` set | P-C `handleMcpGrant(req, { identityStore })` passthrough | P-C |
| `POST /mcp/grants`, `../runtime/grant-route.js` absent | `DB` set | 501 `deploy-join-pending` naming `handleMcpGrant`/`grant-route` | P-A |
| `GET /mcp/grants` (any non-POST) | `DB` set | falls through to assembly → 404 `not_found` | assembly (unchanged) |
| `POST /mcp`, `./mcp-handler.js` absent | `DB` set | assembly's own interim 501 naming `AssemblyDeps.mcp.createHandler` — byte-parity with calling `assembleWorker` directly without a factory (tested) | assembly (unchanged) |
| `POST /mcp`, factory present | `DB` set | delegates to `mcp.createHandler` with the assembled `McpDeps` | assembly via P-A-passed `mcp` |
| `GET /` (+ any page path) | `DB` set | assembled worker dispatch (descriptor admit/render) | assembly (unchanged) |
| any assembled path, `./artifact.js` absent | `DB` set | 500 `deploy-join-missing` naming `./artifact.js` | P-A |
| any assembled path, `../runtime/env-assembly.js` absent | `DB` set | 500 `deploy-join-missing` naming `buildProductionDeps` | P-A |
| any assembled path, staged shape bad / `assembleWorker` throws | `DB` set | 500 `worker-assembly-failed` naming the bad export/cause | P-A |
| any sibling present but wrong export | — | 500 `deploy-join-missing` (bundler bug, always loud) | P-A |

Load order inside assembly (staged first: no store is constructed — no DDL
migrate — for a deploy whose payload never staged): staged deployment →
`buildProductionDeps(env)` → MCP factory (optional) → `assembleWorker`.
Assembly is cached per `env` object (production isolates reuse one `env`, so
they assemble once); loader failures evict so the next request retries.

## requiredBindings

`REQUIRED_BINDINGS = ["DB"]` (exported from `main.ts`, asserted by test).

- `DB` (D1): consumed by P-C's `buildProductionDeps(env)` via
  `createD1Storage(db)`; the store, the D1-backed identity store, and the
  INTERIM_DDL migrate step all hang off it.
- Nothing else today: `handleMcpGrant` takes the already-built
  `identityStore`, not `env`. **Join note for P-C:** if the deps
  constructor grows further `env` reads, extend this list.

## Pinned contracts consumed (not renegotiated)

1. Default-export fetch at `src/worker/main.ts` → `dist/worker/main.js`;
   P-B bundles it as the deploy main. Verified: package `build` emits
   `dist/worker/main.js`; node probe loads it (`default: { fetch }`) and the
   emit serves the gate (500 `missing-binding` without `DB`, 500
   `deploy-join-missing` naming `./artifact.js` with `DB`).
2. `buildProductionDeps(env)` from `../runtime/env-assembly.js` →
   `Promise<{ store, identityStore }>`; called per `env` inside the worker.
3. `handleMcpGrant(req, { identityStore })` from `../runtime/grant-route.js`;
   `POST /mcp/grants` routes to it with the production identity store
   (identity asserted with `toBe`).
4. MCP bundle path convention: sibling `./mcp-handler.js` next to main;
   canonical export **named `createHandler`** (`default` accepted as a
   fallback — documented in `main.ts`). Absent file → no factory →
   assembly's exact 501.

## Conventions defined for P-B (./artifact.js)

P-B emits `./artifact.js` next to the bundled main exporting exactly:

- `artifact: CompileArtifact` (needs `pages[]` + `callables[]`),
- `modules: AssembledModules`-shaped portable map (needs `moduleUrls`;
  workerd-loadable URLs, never node file-URLs),
- `verdict: ActivationVerdict` (`{active:true}` or `{active:false,reasons}`,
  computed by `activate` at deploy; refusal keeps serving through this main).

Main validates this shape fail-fast (500 `worker-assembly-failed` naming the
bad export); `assembleWorker` still owns the deep compat check. All six
sibling specifiers are imported via `string` constants (never literals) so
both `tsc` (no premature resolution) and P-B's bundler (leave as runtime
imports; emit the siblings next to the bundle) stay honest.

## Known gaps (honest, not masked)

- `AssemblyDeps.mcp.permissions` stays unset (assembly's deny-closed
  interim): no pinned P-C export supplies L3 permissions yet. When P-C pins
  one, main adopts it at the single `assemblyDeps` construction site.
- An OPTIONAL sibling whose import rejects reads as absent (workerd has no
  filesystem to distinguish missing-file from eval-error); deploy-time checks
  own that gap. Present-but-wrong exports are always loud 500.

## Boundary proof

`test/worker-boundary.test.ts` green (2/2): `src/worker/main.ts` is
`import type`-only statically (contracts + sibling types); all six runtime
siblings load via dynamic `import()`. Second boundary test (no worker imports
from node files) untouched and green.

## Test results

- New `test/worker-main.test.ts`: 14/14 (failing-first: suite failed pre-impl
  with `Cannot find module '../src/worker/main.js'`).
- Full cloudflare suite: 25 files, 254/254 (incl. boundary 2/2).
- `bun run --filter @canlang/cloudflare typecheck`: exit 0.
- Root `bun run typecheck` (`tsconfig.check.json`): clean.
- Package `build` (tsc emit): exit 0; `dist/worker/main.js` smoke-probed.
