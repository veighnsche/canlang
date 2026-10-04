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
  `exampleFixtures` runtime contract). IR-03 answered by L7 (`can-platform`
  CLI, PR7): thin entries can wire now; execution still needs emission.
- L3: invocation/commit engine behind the `state.ts` ports. S2 delivered
  storage ports + memory/D1/DO backends only (`stateCatalog().entries`
  still empty at `5a271a6`); no invocable surface yet.
- L6: authenticated context for two local test users.
- L5: page descriptor runtime for the browser leg.
