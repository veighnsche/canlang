# Integration cases

Lane 07 owns this harness; each case body is contributed by its owner lane.
This directory coordinates joins, not a giant replacement test framework.

## Layout

- `readiness.test.ts` — real harness mechanics (local workerd boot,
  machine-readable report assembly) plus an informational producer-presence
  table. Always runs under root `npm test`.
- `b1-team-tasks.md` — the B1 join plan and evidence log: one real connected
  app over local workerd/D1, two users, browser + MCP legs, denied/stale/
  replay rows, inline examples over compiled handlers.
- Future milestone joins (`b2-*.md`, …) land here with their evidence.

## Contribution contract

A contributed case is one focused `.test.ts` (or a `bN-*.md` evidence log for
manual/credentialed legs) that:

- drives producers only through their owned contracts/CLIs — never by
  copying their implementation into this directory;
- labels every evidence row `local`, `emulator`, or `live-provider`;
- fails loudly on missing producers (`unsupported`), never green on mocks;
- cleans up its processes and temp state (use `t.tmpdir()`-style isolation).

## Milestone gates (PLAN)

- B1: TeamTasks compiled, served locally, exercised per `b1-team-tasks.md`.
- B2–B5: appended here as their producer contracts land.
