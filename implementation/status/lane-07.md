# Lane 07: Cloudflare delivery, development and executable qualification

Status: active coordinator. B0 planning complete; implementing first slice.
Owner prompt: [lane 07](../prompts/07-platform.md).

- Worktree: `/Users/vince/Projects/canlang-worktrees/lane-07-platform` (owned, created 2026-10-04 from `origin/main` at `b06d873`; branch `muse/lane-07-platform/plan`). Cleanup: coordinator removes this worktree only after all writers/viewers release it; never touches the primary checkout.
- Branch prefix: `muse/lane-07-platform/`. All file/shell/child work stays in the owned worktree.
- Session: `01a10712-a07a-7ab2-a3d7-9ed5a2b9f86a`. Native goal `goal-01a10714-2c58-7c43-bf5f-444dd5fd91cb` (active, no token budget).
- Toolchain observed: rustc/cargo 1.99.0, node v24.21.0, npm 11.19.0, gh 2.101.0 (auth veighnsche), wrangler 4.125.0, python 3.14.7, npm registry reachable.

## Current implementation evidence (2026-10-04, base b06d873)

- No `packages/`, `tests/`, or `.github/` directories exist yet. All producer lanes still read "awaiting human launch"; no producer contracts have landed and `origin` has no lane branches. Lane 07 is the first active coordinator.
- `compiler/` is a single-file Rust scaffold (`src/main.rs`, `canlang-compiler 0.1.0`); no analysis/codegen/artifact yet.
- `examples/TeamTasks.can` + `examples/ExpenseFlow.can` are the B1/B2 reference sources. `draft/` holds 39 app sources and 21 handwritten desired `.mjs` witnesses (proposed `@canlang/stdlib` / `@canlang/ui` contracts, unimplemented).
- `tools/can_parser.py` parses the corpus (tables + fixture shapes; sequence bodies proposed, not parsed). `tools/jev.py` is the three-rewrite JEV caller (`TYPESAFE_API_KEY`).
- Normative inputs read: PLAN/WORKFLOW/CONTRACTS/DIAGNOSTICS, REQUIREMENTS (full), DESIGN §5.1 + §11 + §13, GRAMMAR examples/fixture/migration productions, DECISIONS Cloudflare/compiler sections, AGENTS.md.

## Consequential planning decisions (settled for B0)

1. Root Node workspace (`npm workspaces`) owns TS/JS only. Rust stays in `compiler/` (L1). TS sources compile to JS for distribution; no Can-to-TS stage.
2. Package names (compatible additive proposal): `@canlang/contracts`, `@canlang/cloudflare`, `@canlang/testkit`. Internal only; generated apps keep `@canlang/stdlib` + `@canlang/ui`.
3. `contracts` is types + version constants only, never an engine. `deployment.ts`/`examples.ts` (L7-owned) carry: artifact/runtime compatibility descriptors, binding requirements + secret references, environment selection, staged activation/upgrade state, example fixture/report envelopes.
4. Test runner: `vitest` at root (single runner) now; `@cloudflare/vitest-pool-workers` joins when the first real Worker-bundle test lands. Pure contract-shape tests use vitest without the workers pool.
5. Local dev/serve: programmatic `miniflare` API for D1(local)/R2/DO/queues/scheduled; `wrangler` CLI (pinned) spawned for deploy/D1-migration apply/remote ops, not its JS API. Row-level BDD isolation is explicit runner work: Cloudflare per-test-file storage isolation does not isolate table rows (DESIGN §5.1).
6. Until L1/L3/L4 land, lane 07 consumes **test-only fixtures** (clearly marked, in `test/` dirs) and returns precise `unsupported` failures for unlanded producer behavior. No duplicate catalog, no second interpreter, no green "supported" flag from a stub.
7. Integration cases are contributed per-owner under `tests/integration/`; L7 owns the harness/skeleton and the B1 join, not every case body.
8. JEV three-rewrite consultation is reserved for genuinely difficult decisions (none at B0; candidates later: row-isolation strategy, activation state machine, report envelope if producers disagree).
9. Root `tsconfig.check.json` / `vitest.config.ts` cover lane-07 paths plus the full contracts assembly only. Producer packages keep their own runners/tsconfigs (lane 03 uses `node:test`) until their owners route an opt-in; nested per-package locks coexist with the root lock until the owner routes integration to L7. Root `npm run build` builds the contracts assembly including landed producer modules.

## Exact desired tree within this ownership

```text
package.json, package-lock.json          # L7: workspace root (this lane integrates lock requests)
tsconfig.base.json                       # L7: shared TS config
.gitignore                               # L7: shared ignores (append-only, minimal)
packages/
  contracts/                             # L7: manifest + export assembly
    package.json                         # L7 (file bodies owned per PLAN table)
    src/index.ts                         # L7 re-export assembly
    src/deployment.ts                    # L7: artifact/compat/binding/secret/env/activation types
    src/examples.ts                      # L7: BDD fixture/report envelopes
    test/deployment.test.ts              # L7: shape/version tests
    test/examples.test.ts
  cloudflare/                            # L7; Node build/deploy code NEVER enters Worker bundles
    package.json, src/index.ts
    src/build/    # artifact packaging, catalog-version checks
    src/dev/      # miniflare local runner, fixture Worker for smoke only
    src/deploy/   # binding mapping, wrangler plan/spawn, environment selection
    src/upgrade/  # install/upgrade orchestration, staged activation/recovery
    src/worker/   # Worker-side entry assembly (no Node imports; enforced by test)
    test/         # unit + local-D1 smoke (miniflare), deploy-plan golden
  testkit/                               # L7: compiled inline-BDD execution
    package.json, src/index.ts
    src/fixtures/   # deterministic accounts/files/clock provisioning
    src/runner/     # table + sequence execution over COMPILED artifacts
    src/assertions/ # typed equality incl. exact-value tags (via L2 when landed)
    src/reporting/  # machine-readable JSON results
    test/           # runner tests on marked fixture artifacts (until L1 lands)
tests/integration/                       # L7 harness; case bodies contributed per owner
  README.md, b1-team-tasks.md (join script + evidence log)
.github/workflows/
  integration.yml, release.yml           # L7 (lane-0N.yml belong to other lanes)
implementation/status/lane-07.md         # this file
docs/dev-setup.md                        # fresh-machine setup (new; L7 release duty)
```

## Interfaces and dependencies (producer contracts)

| Need | Producer | Earliest milestone | Fallback until landed |
| --- | --- | --- | --- |
| Compiled artifact shape (`appDefinition`, registry, pages, resources, source maps, test artifact, versions) | L1 (`contracts/src/artifact.ts`) | B1 | Marked fixture artifact in `test/`; runner refuses real paths with `unsupported` |
| Canonical diagnostic envelope + source maps for operational errors | L1 (`diagnostic.ts`) | B3 | Plain errors with file/byte span strings; no invented codes |
| Exact-value equality + wire encodings | L2 (`values.ts`) | B1 (assertions) | Structural JSON equality limited to JSON-safe scalars; BigInt/decimal must fail loudly, never coerce |
| Invocation/commit ports (admission, fence, versions, clock) | L3 (`state.ts`) | B1 | Test-only local admission double for harness plumbing; BDD-over-real-handlers blocked and labeled |
| Pending-work inventory + compatibility | L4 (`work.ts`) | B3 | Upgrade orchestration validates shape only; activation blocked without inventory |
| Provider/file fixtures (test authority) | L4 (`services.ts`, `files.ts`) | B2 | Table rows needing provider/file fixtures report `unsupported` setup, never pass |
| Authenticated context + operation envelope | L6 (`identity.ts`, `wire.ts`) | B1 | Two-user local auth double for plumbing; real permission evidence blocked and labeled |
| Component/page descriptor runtime | L5 (`presentation.ts`) | B1 (UI leg) | Serve check limited to HTTP reachability until landed |

Dependency requests go out as committed status entries + PR descriptions naming producer, exact type/behavior, consuming example, and milestone (none sent yet; producers not launched).

## Subtasks, worker reservations, PR order

Coordinator works inline for small slices; at most two active implementation subagents, disjoint exact files, no git commands from children; one bounded read-only review subagent on meaningful diffs.

- [x] PR1 `muse/lane-07-platform/plan`: merged as #4 (`14fa6a0`). Root workspace + `@canlang/contracts` + L1/L3 assembly join + root-lock integration of `@canlang/state`.
- [ ] PR2 `muse/lane-07-platform/cloudflare-scaffold`: `packages/cloudflare` (build/dev/deploy/upgrade/worker split, Node/Worker import-boundary test, miniflare local-D1 smoke over a fixture Worker, deploy-plan golden). No live credentials.
- [ ] PR3 `muse/lane-07-platform/testkit-scaffold`: `packages/testkit` (report envelope, table-runner core on marked fixture artifacts, per-row isolation proof, loud `unsupported` for unlanded producers).
- [ ] PR4 `muse/lane-07-platform/ci-skeleton`: `integration.yml` + `release.yml` (minimal, growing per milestone), `tests/integration` harness skeleton, `docs/dev-setup.md` verified on this machine.
- [ ] B1 join: smallest real emitted app → local workerd + D1, two users, browser+MCP legs, denied/stale/replay rows, inline examples over compiled handlers, CLI/LSP same-error check. Blocked on L1 artifact + L3 admission + L6 context; harness ready before producers.
- [ ] B2–B5: durable-work/file evidence, schema-upgrade orchestration + recovery, coverage mapping, one coherent release (binary + JS libs + editor) with local/emulator/live evidence stated separately.

Active reservations: none (coordinator holds all owned files until first delegation).

## Test cases (lane-owned, per slice)

- PR1: workspace installs reproducibly (`npm ci` from lock); `tsc --noEmit` clean; contract version constants parse; deployment/examples shape tests green.
- PR2: fixture Worker serves HTTP via miniflare; local D1 batch writes/reads; deploy-plan generator maps fixture binding requirements to wrangler config deterministically (golden); `src/worker` imports no Node builtins (static test).
- PR3: table runner executes fixture-artifact rows with per-row isolation (mutation in row N invisible to row M); sequence runner commits across steps and preserves pre-rejection state on expected error; report JSON validates against `examples.ts` envelope; unlanded-producer paths emit `unsupported`, never pass.
- PR4: `integration.yml` green on PR; `release.yml` assembles can-binary + packed libs + extension artifacts; fresh-clone setup doc followed verbatim on this machine.
- B1+: TeamTasks BDD rows from §5.1 semantics (incl. `members,true,0 -> error(conflict)`, `public,true,1 -> error(forbidden)`); denied read, stale update, mutation replay; upgrade rejects incompatible pending work and recovers safely.

## Integration joins

- B1 join script lives in `tests/integration/` (L7), calling producer CLIs/libs only through their owned contracts; producer case bodies are contributed, not rewritten by L7.
- Lock/manifest integration: lane branches route root lock updates to L7 with exact manifest diffs; L7 merges them promptly (none pending).

## Interface requests and handoffs

- Lane 04 S1 merged as PR #1 (`50b46b4`, status plan only, no code). L4 S2 will add `packages/contracts/src/{work,services,files}.ts` (their bodies) and needs root workspace + `contracts` manifest/index: delivered by this lane's PR1. Coordination: when L4 S2 lands, lane 07 adds the `src/index.ts` re-exports (index assembly is L7-owned); L4 must not silently extend the assembly in passing.
- Lane 01 B0 merged as PR #2 (`e204d07`): `contracts/src/{artifact,diagnostic}.ts` v1. Lane 07 assembly re-exports both in PR1 (no export collisions; standalone-CI note in `lane-01.yml` still holds for their files).
- Lane 03 S1 merged as PR #3 (`fb8cf1f`): `contracts/src/state.ts` v1 + `@canlang/state` with own manifest/lock/tsconfig (their interim note names this lane's workspace as the join). PR1 re-exports `state.ts` and integrates `@canlang/state` into the root lock via `npm install` (lockfile only; their nested lock and standalone flow untouched and verified green). Follow-up with L3 ack: switch their relative `../../contracts` imports to `@canlang/contracts`, adopt root workspace install, retire nested lock.
- Lane 06 S1 merged as PR #6 (`e5b7334`): `contracts/src/{identity,wire}.ts` v1 + `@canlang/identity` + `@canlang/interfaces`. PR2 assembles both modules and integrates both workspaces into the root lock. Their standalone suites verified green (identity 4/4, interfaces 7/7).
- Lane 05 S1 merged as PR #7 (`3d2181b`): `contracts/src/presentation.ts` v1 + `@canlang/ui` (own lock). PR2 assembles the module and integrates the workspace into the root lock. Standalone suite green (48/48). Same nested-lock follow-up as L3 applies, pending L5 ack.
- CONFLICT handoff to L3+L6: `state.ts` and `wire.ts` both export `OperationId` (branded `string & {__brand}` vs plain `string`). `export *` ambiguity is a TS2308 error (observed at `index.ts`), so the barrel carries an interim explicit re-export of the state (narrower) form. The owners must reconcile to one canonical definition; lane 07 will drop the interim line when they do.
- Lane 04 S2 merged as PR #5 (`0dbfb2e`): `contracts/src/{work,services,files}.ts` + `@canlang/{work,services,files}` scaffolds + `lane-04.yml` with an explicit L7 handshake (absorb the three packages into the root lock). PR2 assembles the modules and integrates the workspaces. Three NEW conflicts found by export scan, all L4-vs-L6 duplicates needing owner reconciliation (barrel carries documented interim picks + a pinning `assembly.test.ts`): `DeliveryStatus` (identical text; interim: services), `FileTransferMeta` (files mutable vs wire readonly+documented; interim: wire), `UploadIntentRequest` (divergent shapes — possible accidental collision needing a rename, not a merge; interim: files).
- No lock/manifest integration requests pending beyond the L3/L4/L5 nested-lock follow-ups above. No requests sent yet.

## PR and verification evidence

- PR #4 (branch `muse/lane-07-platform/plan`, reviewed head `c5a48a8`, base `e204d07`, squash-merged as `14fa6a0`): root workspace + `@canlang/contracts` + L1/L3 assembly join. Checks: `npm ci` clean; `npm run build` emits dist (assembly loads versions 1/1/1/1); `npm run typecheck` clean (covers src+test); vitest 10/10; lane-03 standalone flow green (typecheck 0, node:test 2/2); independent read-only subagent review (no blocking findings; 8 nits, 5 fixed incl. test typecheck coverage, 3 accepted/deferred). Limits: no CI on the PR itself (PR4); L3 nested-lock/package-import follow-up pending their ack.

## Remaining work and cleanup

Full authorized scope remains except B0 planning. Owned resources: one worktree (above), no background processes, no cloud credentials used. Cleanup on completion: release subagents, remove worktree after merges settle, record final revisions.
