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
10. Miniflare is pinned to the v4 stable line (`4.20260730.0`, exact, same pin as lane 03) with its flat options API. Lane 07 briefly shipped v5-alpha (`workers[].config` API) in PR2–PR4, then aligned down to v4 for delivery-infrastructure stability and a single workerd binary. Test compatibility dates stay within v4 workerd's range (newest supported: 2026-08-06). A joint v5 migration happens only when v5 stabilizes.

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
- [x] PR2 `muse/lane-07-platform/cloudflare-scaffold`: merged as #9 (`540a281`). Compat check, deploy plan, local dev, worker entry, all-12-module assembly with 5 interim conflict picks, root-lock integration of every workspace.
- [x] PR3 `muse/lane-07-platform/testkit-scaffold`: merged as #11 (`50a5a18`). Table runner, deterministic accounts, assertions, reports, per-row workerd isolation, L1 loader handoff.
- [x] PR4 `muse/lane-07-platform/ci-skeleton`: merged as #14 (`53f6f29`). Integration/release CI, harness skeleton, setup doc, fresh-clone proof.
- [ ] PR5 `muse/lane-07-platform/release-b1-prep`: live release.yml verification (dispatch), L3 S2 join absorption, B1 harness deepening as producers land.
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
- Lane 02 PR1 merged as PR #8 (`48dbb77`): `contracts/src/values.ts` + `@canlang/values` + `lane-02.yml` + JEV evidence. PR2 assembles the module and integrates the workspace. One NEW conflict: `DeliveryError` (services documented `{code,message}` vs values readonly same shape; interim: services, pinned). Handoff to L2+L4 to deduplicate.
- Testkit row-spec builder handoff to L1: PR3's runner consumes `TableRowSpec` closures; the `ArtifactTestModule` loader that builds them from emitted test JS (the §13 `exampleFixtures` runtime shape) needs L1's exact emission contract. Until then only `test/` doubles construct specs; production invoke paths report `unsupported`. Row isolation is one fresh local workerd instance per row (measured ~1.2s/instance cold; scaling follow-up at B4).
- Lane 05 S2 merged as PR #10 (`28f022c`): `presentation.ts` extended (no new barrel collisions), `@canlang/ui` adopted the root workspace and RETIRED its nested lock (L5 follow-up closed). PR3 regenerates the root lock accordingly; ui suite green (101/101).
- Lane 06 S2 merged as PR #12 (`f092bbb`): identity core; `identity.ts` +3 lines, no new barrel exports, no manifest/lock changes. No lane-07 join action; identity suite green (33/33).
- Fresh-clone verification (PR4, commit `173e4b6`): clean `git clone` + branch checkout, then `npm ci`, `npm run build`, `npm run typecheck`, `npm test` (44/44), `test_jev.py` (3/3), `cargo build --locked` — all green, no credentials, no extra steps. `docs/dev-setup.md` follows this script verbatim.
- Release verification (PR5): dispatched `release.yml` on main `53f6f29` (run 37208041505) — all 3 jobs green. Artifacts confirmed: 5 tarballs, `can` binary (193KB), editor zip (11KB). No publishing (by design).
- Lane 03 S2 merged as PR #15 (`5a271a6`): revision-fenced storage + real-D1/DO conformance via miniflare v4 + `@cloudflare/workers-types`; `state.ts` +82 (no barrel collisions). PR6 absorbs the v4 subtree into the root lock (hoisted, zero nested entries) and keeps the v4 flat-options alignment. State suite green (60/60). Their nested lock remains a follow-up pending L3 ack.
- Lane 02 PR2 merged as PR #17 (`c949174`): `DeliveryError` dedup (services now owns it) + runner-safe demo suite. `DeliveryError` interim pick CLOSED in PR6 (explicit line + pin removed; `export *` carries services' shape). Handoff: L2's relative `../contracts/src` imports → `@canlang/contracts` switch still pending their ack.
- Lane 04 S3+S4 merged as PR #13 (`b7f0ebc`): workflow admission credentials + end-to-end integration; `@canlang/interfaces` +1077 lines with `@canlang/contracts` declared dep. PR6 absorbs the new dep edge into the root lock. Interfaces suite green (60/60, was 7).
- Lane 06 S3 merged as PR #19 (`f5a1db6`): auth resolution + delegation chaining, unsigned/fixture guards in local contexts; `@canlang/identity` declares `@canlang/contracts` dep. PR6 absorbs the dep edge. Identity suite green (33/33). Fixture-vs-real separation aligns with the testkit isolation contract.
- Lane 02 PR3 merged as PR #20 (`2f2585e`): `values.ts` extended (no new collisions), JEV merge-evidence handoff to L5. No lock changes; no lane-07 join action beyond the collision re-scan.
- Lane 05 S3 merged as PR #16 (`f5f2b5e`): themes + `@canlang/ui` daisyui devDep; `presentation.ts` +104 (no new barrel collisions). PR6 absorbs daisyui into the root lock. Ui suite green (183/183, was 101/101 at S2).
- No lock/manifest integration requests pending beyond the L2/L3/L4 nested-lock + package-import follow-ups above (L5 closed). No requests sent yet.

## PR and verification evidence

- PR #4 (branch `muse/lane-07-platform/plan`, reviewed head `c5a48a8`, base `e204d07`, squash-merged as `14fa6a0`): root workspace + `@canlang/contracts` + L1/L3 assembly join. Checks: `npm ci` clean; `npm run build` emits dist (assembly loads versions 1/1/1/1); `npm run typecheck` clean (covers src+test); vitest 10/10; lane-03 standalone flow green (typecheck 0, node:test 2/2); independent read-only subagent review (no blocking findings; 8 nits, 5 fixed incl. test typecheck coverage, 3 accepted/deferred). Limits: no CI on the PR itself (PR4); L3 nested-lock/package-import follow-up pending their ack.
- PR #9 (branch `muse/lane-07-platform/cloudflare-scaffold`, reviewed head `ffce35c`, base `48dbb77`, squash-merged as `540a281`): `@canlang/cloudflare` (compat, plan, local dev, worker entry) + full 12-module assembly + root-lock integration of all 9 workspaces. Checks: typecheck/build clean; vitest 25/25 (7 files); emitted worker entry import-free; producer suites green (values 19, work/services 7 each, files 5, ui 48, identity 4, interfaces 7); independent review (no blockers; 6 nits fixed + 1 disputed with observed TS2308 evidence kept). Limits: no CI yet; schedules unmapped (OPEN-139); 5 interim conflict picks + 4 nested-lock follow-ups need owner acks.
- PR #11 (branch `muse/lane-07-platform/testkit-scaffold`, reviewed head `ad86b1c`, base `28f022c`, squash-merged as `50a5a18`): `@canlang/testkit` (§5.1 table runner, accounts, assertions, reports, per-row workerd+D1 isolation) + L5 S2 lock absorption. Checks: typecheck/build clean; vitest 41/41 (12 files); ui suite 101/101; independent review (2 material findings fixed with regression tests + 8 nits fixed). Limits: tables only; L1 loader + L3 engine joins pending; no CI yet.
- PR #14 (branch `muse/lane-07-platform/ci-skeleton`, reviewed head `bab29b3`, base `f092bbb`, squash-merged as `53f6f29`): integration/release CI, harness skeleton, setup doc. Checks: integration.yml GREEN ON THE PR ITSELF (workspace 22s node 22, tools 8s); fresh-clone verbatim proof (44/44, jev 3/3, cargo); release steps executed locally (5 tarballs with dist, 147KB editor zip, can binary runs); independent review (1 material + 6 nits fixed, incl. private-pack exclusion and producer pre-build). Limits: release.yml never executed remotely yet (PR5 dispatches it); B1 blocked on L1 emission + L3 engine.

- PR #18 (branch `muse/lane-07-platform/release-b1-prep`, reviewed head `254e727`, base `f5f2b5e`, squash-merged as `6980555`): miniflare v4 alignment + release proof (PR5) + six-producer join (PR6). Checks: release.yml dispatched on main `53f6f29` (run 37208041505, 3/3 green); integration.yml green on PR (workspace 30s, tools 7s); typecheck clean; vitest 45/45 (13 files); producer suites green (state 60/60, identity 33/33, interfaces 60/60, ui 183/183); `npm ci` clean from regenerated lock (miniflare v4 hoisted, zero nested); independent review (MERGEABLE, no blocking findings). Limits: B1 still blocked (L1 emission + L3 invocation engine); 4 interim conflict picks + L2/L3/L4 nested-lock follow-ups need owner acks.
- L1 IR-03 ANSWERED (PR7, this branch): `can-platform` CLI in `@canlang/cloudflare` (`src/cli/platform.ts`, bin-linked via `node_modules/.bin` after install). Contract: `can-platform <run|test|build|deploy> --artifact <path> [--env <name>]`, one JSON envelope on stdout, exit 0/2/1; until producers land, all four commands exit 2 with `missing-producer` naming the exact contract. Documented in `packages/cloudflare/README.md`; covered by `test/cli.test.ts` (14 cases incl. envelope-shape + exit-code assertions; review follow-ups added `--help`-envelope, alias, `--env`, duplicate-flag, and missing-value cases). L1 thin entries can wire against this now.

- PR #21 (branch `muse/lane-07-platform/b1-survey`, reviewed head `89b2f00`, base `6980555`, squash-merged as `3b75c61`): `can-platform` CLI (L1 IR-03). Checks: integration.yml green on PR (workspace 29s, tools 8s); typecheck clean; vitest 58/58 (14 files); independent review caught 1 blocking finding (`--help` emitted no envelope) fixed with regression test + 5 nits fixed/accepted, re-review MERGEABLE. Limits: all four commands gate on L1 emission (honest `missing-producer`); B1 still blocked.
- Deterministic-build probe (PR8, local): two clean `tsc -b` rebuilds of contracts/cloudflare/testkit produce byte-identical dist (sha256 `d3c49db2…` both runs, `.js/.d.ts/.map` only). Promoted to an `integration.yml` gate (rebuild + `cmp`); B5 reproducibility evidence. Fresh-clone proof on PR8 head `cf12283`: clean clone + `npm ci` + build + typecheck + 59/59 tests, no credentials.
- Producer-request sweep (PR8, base `3b75c61`): no open PRs; every L7 request in sibling status files is stale/satisfied (L2 assembly + dedup done, L4 `.gitignore` shipped in PR1 — verified zero tracked build artifacts, L3 check-invite optional, L1 IR-03 answered). No action owed.

- PR #25 (branch `muse/lane-07-platform/b2-readiness`, reviewed head `627e96d`, base `3b75c61`, squash-merged as `8766be9`): deterministic-build CI gate + CLI test NITs + evidence. Checks: integration.yml green on PR (workspace 34s incl. new gate, tools 7s); typecheck clean; vitest 59/59 (14 files); fresh clean-clone on PR head green; independent review MERGEABLE (2 NITs: gate `set -u`/empty-guard folded into PR9, `-h` stderr/`--env` trailing-flag cases optional).
- Lane 03 S3 merged as PR #23 (`21dd47f`): canonical invocation/admission/replay/role checks. No contracts or manifest changes (no assembly/lock action). State suite green (125/125, +65 invocation cases). Engine behavior is real but unexported from the package index; registry interim pending L1 op descriptors. B1 recall updated; no lane-07 code join yet.
- Open-producer survey (PR9): L6 S4 PR #22 was open at survey time (merged during PR10 as `9a01b51` — see join entry above); L4 S5+S6 PR #24 (file lifecycle + bridge — B2 surface, no B1 impact). L1 still quiet (no emission PR); B1.1/B1.2/B1.5 remain L1-blocked.

- PR #27 (branch `muse/lane-07-platform/s3-join`, reviewed head `0796b81`, base `8766be9`, squash-merged as `7f13f84`): determinism-gate hardening (`set -u` + empty-dist guard) + L3 S3 survey + evidence. Checks: integration.yml green on PR (workspace 30s, tools 9s); typecheck clean; vitest 59/59; gate script + guard path run locally; state suite 125/125; independent review MERGEABLE (2 NITs: partial-dist scenario accepted — tsc never exits 0 partial, so the job dies before the gate; b1 doc overlap fixed in PR10). Limits: B1 still L1-blocked.
- Release verification (PR10): dispatched `release.yml` on main `7f13f84` (run 37210281584) — all 3 jobs success. Artifacts: `can-ubuntu-x86_64` (193KB), `node-libraries` (248KB), `editor-bundle` (11KB). Second green release run after PR5's (53f6f29); assembly holds across 6+ merges. No publishing (by design).
- Lane 06 S4 merged as PR #22 (`9a01b51`): canonical HTTP dispatch (`createHttpHandler`, POST `/api/operations/<op>`, `/auth/*`, page GET/HEAD; `HttpDeps` doc assigns L7 worker assembly as the B1 deps constructor). PR10 absorbs the manifest changes (identity packaging metadata; interfaces +`@canlang/identity`/`@canlang/ui` dep edges) into the root lock (+3/−1 hunk carrying the interfaces dep edges; the identity packaging metadata has no lock footprint). No contracts changes — collision scan still exactly the 4 interim picks. Interfaces suite green (120/120, was 60); identity 33/33. L6 side of B1 unblocked, ready-pending-L1 (review caught the mid-flight merge; reworded from survey to join).
- Lane 02 PR4 merged as PR #28 (`64d459a`): text/ICU/locale + array/equality builtins, values package only (no contracts/manifest impact; no lane-07 join action). Values suite green (369/369).

- PR #29 (branch `muse/lane-07-platform/b1-watch`, reviewed head `e813bf1`, base `64d459a`, squash-merged as `e38b9f8`): release re-verification + L6 S4/L2 PR4 join + evidence. Checks: release.yml run 37210281584 on main 3/3 success with artifacts; integration.yml green on PR (workspace 34s, tools 7s); typecheck clean; vitest 59/59; `npm ci` clean; producer suites green (interfaces 120/120, identity 33/33, values 369/369); collision scan still 4 interim picks; independent review caught a mid-flight merge as BLOCKING (stale S4-open lines) → rebased + joined, re-review MERGEABLE (1 cosmetic NIT, corrected in PR11). Limits: B1 L6-side unblocked but ready-pending-L1; B1.1/B1.2/B1.5 remain L1-blocked.
- Lane 05 S4 merged as PR #26 (`83656cf`): canonical forms/actions, `PRESENTATION_CONTRACT_VERSION` 0.3.0→0.4.0, `presentation.ts` re-exports 4 wire types + `DeliveryStatus`. No manifest changes (no lock action). Join finding: same-symbol re-exports do NOT shadow `export *` (verified: new pins typecheck with zero index change), so the barrel is intact; `assembly.test.ts` gains 8 identity pins (barrel≡wire≡presentation per name) as divergence guards. Also fixed the stale "still to land" header (all 12 modules landed). Ui suite green (259/259, was 183).
- Lane 01 B0 merged as PR #30 (`bc008f7`): dependency-free lexer/layout/CST/recoverable parser, compiler-only (no contracts/emission impact; no lane-07 join action). Release-path confidence: `cargo build --locked` + `cargo test --locked` green (23 lib + 4 + 43 integration). L1 progressing toward emission; B1.1/B1.2/B1.5 still pending it.

- PR #31 (branch `muse/lane-07-platform/s4-b0-join`, reviewed head `480df6c`, base `e38b9f8`, squash-merged as `efdcdad`): S4 re-export identity pins + PR29 evidence + L1 B0 survey. Checks: integration.yml green on PR (workspace 32s, tools 6s); typecheck clean; vitest 59/59; ui 259/259; cargo build + test green (23+4+43); independent review MERGEABLE with zero findings. Limits: B1 still L1-blocked.
- Hold state (base `efdcdad`): all lane-07 platform slices landed; only open PR repo-wide is L4 S5+S6 #24 (B2 surface). B1 joins wait on L1 emission (+ op descriptors), L3 engine export, L6 two-user context. No L7 requests outstanding. Next lane-07 PR triggers on the next producer merge; this branch holds the PR31 evidence entry until then.
- PR #24 join prep (surveyed open, no code): S5+S6 touches `packages/files` + `packages/work` only — zero contracts and zero manifest changes, so the merge needs no assembly/lock action, just a files/work suite spot-check + handoff line. B2 surface (file lifecycle, bridge v1, receipt observation); no B1 impact.

- PR12 mega-join (this branch, base `92655e8`): 14 producer merges absorbed. Collision re-scan across `presentation.ts` (+239), `services.ts` (+217), `state.ts` (+67): still exactly the 8 known names (4 interim picks + 4 S4 re-export identities) — zero new collisions, zero assembly changes. Lock: producers #32/#34/#40 updated the root lock directly in their merges (handshake bypass — outcome verified correct: MCP SDK 1.32.0, happy-dom 20.14.5, decimal.js 10.6.0 all hoisted, zero nested, `npm ci` clean, so no revert; handshake reminder stands). `PRESENTATION_CONTRACT_VERSION` 0.4.0→0.9.0 across S5/C1/C2a/C2b/C3 (version-only for the barrel).
- Lane 04 S5+S6 #24 (`727ab61`, as pre-surveyed: files/work only, no join action) + S7 #38 (`ae8bc12`, services.ts capability adapters, no new collisions). Suites: files 53/53, work 126/126, services 105/105.
- Lane 06 S5 #32 (`090f7b4`, MCP server on official SDK — `interfaces/src/mcp/*` exported, the B1 MCP-leg shape) + S6 #44 (`3819b23`, upload/finalize bridge routing). Suites: interfaces 199/199 (was 120), identity 38/38.
- Lane 03 S4 #33 (`471f1ed`, authorized queries — `queryRecords`/`queryAggregate` exported) + S5 #41 (`2c3610a`, mutation pipeline — `crudExecute`/`runMutationWrites` exported, `Interim*` defs pending L1 descriptors). `admit`/`invoke` still unexported. Suite: state 247/247 (was 125). B1.3/B1.4 closer: query/mutation invocable, canonical invoke pending.
- Lane 02 PR5 #40 (`742c618`, +decimal.js) + PR6 #48 (`d32c1ab`, conformance fixtures + `tests/integration/lane02-values.test.ts`). The join case is ACCEPTED as the first contributed case (reviewed all 590 lines: real-producer present path + honest all-unsupported absent path, both verified green locally; 2 permanent L1/L3 block rows; fail-loud fixtures). Registered in `tests/integration/README.md`; L2 owns the pinned catalog count (54). Values suite: 674 pass + 1 owner skip, 0 fail.
- Lane 05 S5 #34 (`19ea4d6`) + C1 #37 (`f9fe9bc`) + C2a #42 (`78da0ca`) + C2b #45 (`5dd18e6`) + C3 #47 (`92655e8`, leaves/media): presentation 0.5.0→0.9.0, ui +happy-dom. Suite: ui 372/372 (was 259).
- Lane 01 #36 (`fb226e0`, CLI dispatch + LSP + vscode client): thin `run|test|build|deploy` entries exec `can-platform` verbatim with `CAN_PLATFORM_BIN` override + E7004 (exactly the IR-03 contract). Verified end to end: `can run --help` → help envelope exit 0; missing artifact → `missing-artifact` exit 2; present artifact → `missing-producer` (lane-01 emission) exit 2 — B5 thin-entry interop evidence. `can compile` still check-only ("emission lands in slice 4"): B1.1 still L1-blocked, now with a named slice.
- PR12 behavior changes: (1) `can-platform` honors `--help`/`-h` in subcommand position (exit-0 help envelope) because L1 passes flags verbatim — reverses the PR21-blessed exit-2-on-`run --help` deliberately, with test + README. (2) `release.yml` editor-bundle now compiles the LSP client (pinned tsc 5.9.3, empty type root reproducing L1's isolation — their ambient `require` shim collides with workspace @types/node; revisit at slice 2b) and ships `out/` (previously the zip lacked the `main` entry — client could not activate). Verified with exact release commands + bundle load smoke (`activate=function`, `CanLanguageClient=function`). `editors/vscode/out/` gitignored.
- H010 git hold: scoped to the shared primary checkout (draft↔Codex); the awaited merges are on main (`bcb6f9a`/`b1aa78e`); lane-07 worktree flow unaffected. Draft/docs/migrate commits in range touch no lane-07 files.

- PR #52 (branch `muse/lane-07-platform/b1-hold`, reviewed head `c51e0fb`, base `92655e8`, squash-merged as `4ad9ba7`): 14-merge join + subcommand `--help` + editor client bundle + L2 case coordination. Checks: integration.yml green on PR (workspace 30s, tools 8s); typecheck clean; vitest 61/61 (15 files); `npm ci` clean; producer suites green (values 680 = 679+1skip, interfaces 199, ui 372, identity 38, state 247, work 126, services 105, files 53); `can`↔`can-platform` chain verified end to end; editor bundle replicated + load-smoked; independent review MERGEABLE (2 cosmetic NITs folded into PR13). Limits: B1 still L1-slice-4-blocked.
- Lane 02 completion #50 (`346c6de`, status-only): lane complete except producer-blocked B1/B2 calls; unmet contracts restated incl. "L7 pretest values build" — ANSWERED in PR13 (below). Values suite re-verified at 680 (679 pass + 1 owner skip, 0 fail), matching their 680/680 claim modulo the skip.
- PR13 (this branch): (1) root `pretest` now runs `build:joins` (`npm run build -w @canlang/values`), so `npm test` exercises the L2 join case on the present path — verified by wiping `packages/values/dist` and re-running (rebuilt, 312ms real-producer run, 62/62). `build:joins` is the demand-driven list: it grows only when a join case imports a producer dist. (2) L2 `ABSENT_SENTENCE` refreshed (my dir, my pretest) + README registration updated; L2 owns the catalog count (54). (3) PR52 NITs: subcommand `-h` case (parametrized), npm cache on editor setup-node.
- Open-producer survey (PR13): L4 S8 PR #49 (L2-values/files bridge joins; S8b re-exports `UploadIntentRequest`/`FileTransferMeta` from wire — my 2 interim lines become droppable on merge; S8b runtime-pin handoff + S8d fixture-seed/orchestrator-input handoffs to L7 RECEIVED, act on merge — pin needs a files dist or TS-source import since files has no build, S8d design gets a focused slice not an improvised answer). L6 S7 PR #51 (provider ingress + OAuth; survey on merge).

- PR #54 (branch `muse/lane-07-platform/s8-watch`, reviewed head `eb06eb4`, base `4ad9ba7`, squash-merged as `673e848`): pretest values build + PR52 NITs + evidence. Checks: integration.yml green on PR (workspace 43s incl. values build, tools 10s); typecheck clean; vitest 62/62 (15 files, L2 case on present path); values dist-wipe rebuild proof; values 680 (679+1skip); independent review MERGEABLE (2 informational NITs, no action). Limits: B1 still L1-slice-4-blocked.
- Lane 03 S6 merged as PR #53 (`160db71`): outbox/schedule staging + transaction/read/system ports — `createInvoker`/`BoundInvoker`, `stageOutboxIntents`/`stageScheduleOps`, system registry now EXPORTED (state 328/328, was 247). Registry still interim ("replaced outright at the L1 codegen join"); `admit`/`invoke` stay unexported. L3 engine side B1-ready modulo L1; B1.3/B1.4 critical path is now L1 emission + op descriptors only.
- Lane 06 S7 merged as PR #51 (`2cbd471`): provider ingress + OAuth authorization server; `identity.ts` + `OAuthClientId`/`OAuthClient`/`AuthCode` (each single-module — no new collisions; full scan still the 8 known). No manifest changes (no lock action). Suites: identity 47/47 (was 38), interfaces 237/237 (was 199).
- Worktree note (PR14): identity build initially failed here with TS2305 on the new OAuth names — stale contracts dist in the tree, not a main breakage (rebuilt, green). Producer dists that import `@canlang/contracts` must build after the contracts dist; root pretest order already guarantees this for values.
- Open-producer survey (PR14): L4 S8 PR #49 still open (S8b pin + interim-drop + S8d design act on merge); L5 C4a PR #55 open (field controls/calendar, survey on merge).

- PR #56 (branch `muse/lane-07-platform/s6s7-join`, reviewed head `57da1aa`, base `673e848`, squash-merged as `5185a09`): S6/S7 join survey + evidence. Checks: integration.yml green on PR (workspace 42s, tools 6s); typecheck clean; vitest 62/62 (15 files); state 328/328, identity 47/47, interfaces 237/237; collision scan still 8 known; independent review MERGEABLE (2 informational NITs: registry-quote wording + typo, fixed in PR15). Limits: B1 critical path now L1 emission + op descriptors only.
- DECISION (PR15, answers L4 S8d handoff): B2 provider/file fixtures use SCENARIO-DATA playback. `TableRowSpec.seed` holds scenario refs (`<provider>:<scenario>`, e.g. `mail:send-retry-success`); L4 authors scenario tables over their closed completion/error shapes; testkit row scopes play back per-call outcomes. Rationale: covers all stated B2 needs as data; lane split holds (L4 authors semantics, testkit plays back — generic machinery, no invented provider behavior); rows stay hermetic with zero new topology; lowest L4 cost (tables vs porting node:http harnesses to workerd). JEV three-rewrite consulted (evidence `implementation/evidence/jev/lane-07-seed-design-20261004/`): 3/3 leaned fixture-server but at confidence 0.08–0.12 with near-uniform probabilities — preserved as weak advice; simplicity + lane-split win on the verified constraints. Escape hatch (named trigger): if a B2 journey needs behavior unexpressible in tables, L7 defines the workerd fixture-server interface then. Scenario-table SHAPE is a proposal for L4 confirmation (below), not a unilateral spec.
- S8d scenario-table proposal (for L4 confirmation before authoring): `{provider, scenario, calls: Array<{match?: {operation, args?}, outcome: DeliveryResult | DeliveryError-shaped}>}` — nth matching call gets nth outcome; unmatched calls fail loud (no silent default). Seed refs select `(provider, scenario)` tables. Parser + grammar shipped in `@canlang/testkit` (`src/fixtures/seeds.ts`); playback interpreter lands with the B2 slice.

## Remaining work and cleanup

Full authorized scope remains except B0 planning. Owned resources: one worktree (above), no background processes, no cloud credentials used. Cleanup on completion: release subagents, remove worktree after merges settle, record final revisions.
