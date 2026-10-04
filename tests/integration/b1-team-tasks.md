# B1 join: one real connected app

Status: harness ready; producers pending. This log records evidence only —
no row passes until it executes against real components.

## Join script (target)

1. L1 compiles a supported TeamTasks-style source to `CompileArtifact`.
2. L7 serves it via `startLocalDev` with local D1; two authenticated users
   (L6 context) act through browser (L5) and MCP legs on the same operation.
3. Inline examples execute through `@canlang/testkit` over the compiled
   handlers with real L3 admission/transactions.
4. Rows exercised: denied read, stale update (`conflict`), mutation replay,
   plus the source's own expected business rejections.
5. CLI and LSP report the same deliberate source error (L1).

## Evidence log

| # | Check | Environment | Result | Source revision | Date |
| --- | --- | --- | --- | --- | --- |
| B1.0 | Harness boots local workerd + D1 | local | PASS (dev-smoke, isolation) | `50a5a18` | 2026-10-04 |
| B1.1 | TeamTasks compiles to `CompileArtifact` | local | BLOCKED on L1 emission | — | — |
| B1.2 | Served app, two users, browser+MCP | local | BLOCKED on L1/L3/L5/L6 | — | — |
| B1.3 | Inline examples over compiled handlers | local | BLOCKED on L1 loader + L3 engine | — | — |
| B1.4 | Denied/stale/replay rows | local | BLOCKED on L3 admission | — | — |
| B1.5 | CLI/LSP same-error parity | local | BLOCKED on L1 | — | — |

## Blocked-on recalls (unmet contracts)

- L1: `can compile` emission + `ArtifactTestModule` loader shape (§13
  `exampleFixtures` runtime contract). IR-03 consumed: thin entries exec
  `can-platform` verbatim (B0 #36, verified end to end in PR12 — B5
  interop evidence). `can compile` still check-only; emission is L1
  slice 4 (named unblock for B1.1/B1.2/B1.3/B1.5).
- L3: invocation/commit engine behind the `state.ts` ports. S6 (`160db71`)
  exports `createInvoker`/`BoundInvoker` + staging + system registry
  (328/328 suite), but the registry is interim ("replaced outright at
  the L1 codegen join") and `admit`/`invoke` stay unexported. Engine
  side B1-ready; B1.3/B1.4 critical path is now L1 emission + op
  descriptors only. No testkit wiring until real handlers exist
  (interim-registry execution would be a mock pass).
- L6: `createHttpHandler(deps, sub)` WHATWG handler MERGED (S4 PR #22,
  `9a01b51`; interfaces suite 120/120). Its `HttpDeps` doc names the L7
  worker assembly as the B1 constructor of deps from environment bindings:
  `{app, pages, invoker, catalog, limiter, logger, clock, identity,
  secureCookies}`. Production sources: L1 (registry/catalog/app), L3
  (invoker), durable rate-limit counters. The L6 side of the B1 join is
  now unblocked: `createWorkerApp` will build `HttpDeps` from bindings +
  producer surfaces and serve the handler via `startLocalDev`; no
  test-only fakes in the served path. S5 (`090f7b4`) adds the exported
  `interfaces/src/mcp/*` server shape (B1 MCP-leg surface).
  Ready-pending-L1: invoker needs the L3 exported surface + L1 op
  descriptors; still needed from L6: the local two-user authenticated
  context helper for the B1 legs.
- L5: page descriptor runtime for the browser leg.
