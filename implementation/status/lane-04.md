# Lane 04: Durable work, provider capabilities and files

Status: active. Coordinator launched 2026-10-04.

- Worktree: `/Users/vince/Projects/canlang-worktrees/lane-04-work-services-files` (owned; cleanup: coordinator removes it after all writers/viewers release; branch `muse/lane-04-work-services-files/plan` at `b06d873`, tracking `origin/main`).
- Session: `01a10711-2b5f-78b3-aa6f-ad06a5a57d11`; native goal `goal-01a10713-180f-78e3-afcb-d5f1ecf8e026` (no token budget).
- Owner prompt: [lane 04](../prompts/04-work-services-files.md). Primary checkout `/Users/vince/Projects/canlang` is untouched (dirty, owned by draft coordinator).

## Current implementation evidence (2026-10-04, base `b06d873`)

- No `packages/` tree exists; no `.github/`; no root Node manifest/lock. My lane owns `packages/work/`, `packages/services/`, `packages/files/`, `packages/contracts/src/{work,services,files}.ts`, `.github/workflows/lane-04.yml`, this file.
- All sibling lanes 01/02/03/05/06/07 are `awaiting human launch`: no producer contracts exist yet (no L1 catalog envelope, no L2 values, no L3 commit kernel, no L6 identity/wire, no L7 workspace/runner). Lanes 01–03 have plan-branch worktrees only.
- Normative inputs read: PLAN/WORKFLOW/CONTRACTS/DIAGNOSTICS, AGENTS.md, REQUIREMENTS §§Packages/Runtime, DESIGN §§6–8.1, GRAMMAR When/examples, DECISIONS audit + Oct-04 entries (delivery association, receipt leaf grants, attachment handoff, payment/billing evidence, fixtures).
- Accepted first slice witnesses (read-only, draft-owned): `draft/CanApprove.can` (`delivery(Mail.send)?` field, `fixture attempt=Mail.send`, `send Mail.send … when=… as attempt`). `examples/TeamTasks.can` and `examples/ExpenseFlow.can` contain no send/schedule/file use: B1 does not exercise this lane; the B2 attachment/approval/notice journey must come via draft/L7 integration.
- Model/judgment/media: `design/AI-AND-SERVICE-DRAFTS.md` and `design/research-ai-capabilities-20261004.md` are explicitly **research/proposal, unadopted**. Accepted mechanisms (typed capabilities, durable `send`, verified events, completions, receiving-app finalization) already cover final replies/answers/submissions; typed fetch, observable-run, JEV-batch declaration and ComfyUI workflow-mapping language contracts are **design dependencies, not to be invented**. Provider evidence (Ollama chat/streaming/errors/tools/abort, ComfyUI native + v2, TypeSafe HTTP) is documented there for adapter reuse.
- Toolchain verified: node v24.21.0, npm 11.19.0, gh 2.101.0 authenticated as veighnsche, 10 CPUs.

## Resolved consequential choices

1. No new grammar, no new `std.*` registry entries, no shared-envelope invention. This lane authors provider-owned capability contracts + TS adapter implementations through the accepted `capability`/`use … from=deployment.…` mechanism (DESIGN §8). `std.EmailV1`/`std.PaymentsV1`/`std.ErrorsV1` get typed surfaces + a reference EmailV1 adapter; model/judgment/media ship as provider adapters with typed inputs/results/features, not language forms.
2. Packages build and test standalone first (own `package.json` + `tsconfig` + runner per package; relative imports into `packages/contracts/src/*.ts`) until L7 assembles the root workspace. Root lock/config changes route to L7 with exact manifests; never hand-merged.
3. No duplicate commit engine. State machines are storage-port-based; L3's D1/DO ports plug in when they land. Until then, minimal test-only L3 fixture interfaces (declared as such, replaced at the kernel join) back the first slices.
4. Reuse, each qualified by a compatibility test before reliance: native `fetch`; maintained provider clients where they run under workerd (ollama-js per-stream client for abort semantics); R2 through a blob-store port with a local FS-backed implementation for slices and R2-binding evidence via the L7 runner; Queues/Workflows/DO only where a mapping test proves the guarantee (at-least-once + outbox receipts/guards; no exactly-once claim).
5. Whole-population/recurrence limits stay diagnostic/design dependencies: `every` covers D1 team/app scopes only; root-bound `every` and general recurrence grammar are unsupported (DESIGN §6); no invented scan that drops records.

## Exact desired tree within ownership

```text
packages/contracts/src/work.ts        # intent/occurrence/outbox/claim/receipt/observation types
packages/contracts/src/services.ts    # capability/adapter/ingress/completion/error types
packages/contracts/src/files.ts       # upload intent/content/finalize/provenance/GC types
packages/work/
  package.json, tsconfig.json
  src/intent/ src/event/ src/schedule/ src/dispatch/ src/receipt/ src/recovery/
  src/catalog.ts src/ports.ts
  test/  # state-machine, guard, retry, supersession, occurrence fixtures
packages/services/
  package.json, tsconfig.json
  src/http/ src/mail/ src/models/ src/judgments/ src/media/
  src/catalog.ts src/ports.ts
  test/  # adapter mapping, ingress verification, pagination/limits, reconciliation
packages/files/
  package.json, tsconfig.json
  src/upload/ src/finalize/ src/provenance/ src/retention/
  src/bridge.ts src/catalog.ts src/ports.ts
  test/  # intent/content/finalize, validation, provenance, GC horizon
.github/workflows/lane-04.yml         # per-package typecheck + unit/contract tests on owned paths
implementation/status/lane-04.md      # this file
```

Modules are created only with their first real use. `contracts` stays type-only; no execution engine, no second catalog.

## Interfaces and dependencies

Supply (producer, mine):

- `work.ts`: stable intent/occurrence IDs, frozen args, dispatch guard evaluation shape, claim identity, completion/unknown/skipped outcomes, receipt observation revision + retention, pending-work inventory for L7 recovery.
- `services.ts`: bound provider identity, supported operation/features, typed inputs/results, verified ingress envelope, completion validation rules, `DeliveryResult`/`DeliveryError` closed shapes.
- `files.ts`: upload intent/content/finalize shapes, finalized file identity, provenance binding, retention/GC horizons, bridge v1 wire contract for L6 transport.
- Typed upload/event ports for L6; operational status/recovery hooks for L7; staged intent/commit ports for L3. No side-channel operation schemas.

Request (consumer of, recorded here + in PR bodies):

- L3 (unlaunched): invocation/commit ports — atomic staging of outbox intents + keyed schedule replacement/cancellation under the owner fence; claim path; receipt-observation revision enrollment in the read fence. Needed by kernel-join slice; test-only fixture interface until then.
- L6 (unlaunched): identity context shape for bridge auth (`/files/intents` same-principal/team), upload transport join. Needed by bridge slice.
- L7 (unlaunched): root workspace assembly (`package.json`, lock, `tsconfig.base.json`), `contracts` package manifest + index assembly, local workerd/R2 runner, B1/B2/B3 orchestration. Needed incrementally from first source slice.
- L1/L2 (unlaunched): common catalog envelope/version join; my `catalog.ts` entries stay additive and versioned for that join.
- Draft owner: CanApprove/CanExpense witnesses stay read-only for me; corrections go through the draft owner.
- Design (accepted first): typed fetch contract, observable-run contract, JEV-batch declaration, ComfyUI workflow mapping. JEV three-rewrite process via `tools/jev.py` only if a difficult choice in my scope needs it.

## Subtasks and worker reservations

One coordinator; at most two active implementation subagents plus short read-only reviews. Subagents share this worktree, receive disjoint exact files, run no git/worktree commands. Long commands: `yield_time_ms:120000` (60k–300k), 2-minute default reinspect, no polling.

| Slice | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| S1 plan (this) | coordinator | `implementation/status/lane-04.md` | merged plan PR |
| S2 contracts + CI | coordinator | `packages/contracts/src/{work,services,files}.ts`, `.github/workflows/lane-04.yml` | type-only, closed schemas, CI green on empty-tree-safe checks |
| S3 durable work kernel | worker-A | `packages/work/**` | outbox/guard/claim/retry/supersession/occurrence state machines + fixtures |
| S4 EmailV1 adapter | worker-B | `packages/services/src/{http,mail}/**`, `src/catalog.ts`, `src/ports.ts` | typed send, controlled-endpoint evidence, failure transitions |
| S5 file lifecycle + bridge | worker-C | `packages/files/**` | local-store finalized attachment journey, bridge v1, provenance/GC |
| S6 observation + receipts | worker-A | `packages/work/src/{receipt,recovery}/**` | selected-property observation, revision fencing, recovery hooks |
| S7 models/judgments/media | worker-B | `packages/services/src/{models,judgments,media}/**` | partial/final/cancelled, NOUL/choice/score, Ollama/ComfyUI mappings, limits |
| S8 kernel + lane joins | coordinator | ports + join tests | real L3 staging/claim, L6 upload/events, L7 recovery paths |

Current reservations: S1 coordinator (this file). S3/S4 may run in parallel once S2 merges (disjoint trees).

## Reused packages and qualification

- Native `fetch` (workerd + node): qualify via controlled-endpoint adapter tests (no live-provider claims without credentials/authorization).
- `ollama/ollama-js` (abort-per-client), TypeSafe HTTP via fetch, ComfyUI native/v2 via fetch: qualify version-by-version; record supported features + limits per release; never assume SDK behavior.
- R2: port + local FS-backed implementation first; R2-binding evidence through L7 runner when available.
- Queues/Workflows/DO alarms: mapping tests only; dispatcher defaults to shared D1 due-work scan behind the storage port.
- `tools/jev.py`: JEV consultation CLI if a difficult design choice arises (preauthorized; three rewritten equivalents; save responses/uncertainty).

## Provider compatibility (S7 evidence; no live-provider claims)

- `std.EmailV1` (S4): controlled endpoint; send/reconcile mapping, delivery-id idempotency, redirect refusal, aggregate transport limit, redacted errors. No live mailbox.
- `ai.ChatV1` via Ollama (S7a): `POST /api/chat` final + NDJSON streaming, mid-stream error objects, `done:true` completion rule, per-run abort (fetch equivalent of documented client-per-stream), model allowlist, output ceiling, reconcile honestly `unknown` (no documented run lookup). Verified against Ollama chat/streaming/error docs + ollama-js abort README; tools/format/vision are unrepresentable in the input (unsupported iff absent). `ollama-js` NOT installed: fetch covers the documented need; revisit only for SDK-parity features.
- `ai.SystemOneV1` via TypeSafe JEV (S7b): `{model,state,questions}` request and exact answer-key/type/choice rules from in-repo `tools/jev.py`; answer field names (`noul`, `choice`/`probabilities`/`confidence`, `score`/`legend`/string-indexed `probabilities`, `usage.{input,output}_tokens`) from convergent independent doc mirrors (official pages JS-bloated past fetch truncation). Limits are binding config: JEV 255 options/10 levels, local 2–26 + 64 KiB request cap. No thresholds anywhere (business policy). Reconcile honestly `unknown`.
- `ai.ImagesV1` via native ComfyUI (S7c): `/prompt` accept/validation shapes, `/history` entry shapes (`status_str` success/error/executing, `completed`, `messages`, node outputs), `/view` params, `/api/jobs` targeted cancel (upstream-only; 404 probed as unsupported) — verified against ComfyUI routes docs, the official websockets example, and convergent mirrors. Omitted honestly: `/queue` tier (queued/running polling refinement, shapes unverified), `/ws` (polling is authoritative), node class requirements (existence only), native `cancelled` marker (does not exist in verified shapes; cancel returns the post-cancel observation).
- Comfy API v2: NOT implemented. Verified but insufficient: `/api/v2/jobs` submit/poll/cancel paths, terminal states (succeeded/failed/expired/canceled), single-use `Idempotency-Key` + 422 reuse, poll-authoritative/SSE-enhancement principle (proxy README, smoke test, SDK READMEs). Unmet contract for a later slice: stable submit/job/output field reference — no parser invented against the 0.1.x beta.

## Test cases (finite, per slice)

- Outbox: commit failure causes no send; guard false → skipped; supersession cancels undispatched intents only; provider-accepted work may complete after supersession.
- Schedule: keyed replacement/cancellation commits with business changes; admitted occurrences keep stable IDs; `every` UTC-slot coalescing per team/app scope; missed/new/removed scope rules; root `every` rejected.
- Retry: exponential backoff ≤8 attempts/24h default; permanent stops; transient retries same occurrence; authored `require` false is terminal; lost response stays unknown until authoritative evidence; reconciliation reuses original identity.
- Delivery association: `delivery(Target)` id/status/result/error observation at owner checkpoint; revision enrollment invalidates on intervening updates; no domain version churn; safe summary retention after content expiry; `Target.completed` envelope validation (succeeded/failed/unknown/skipped shapes); inconsistent envelopes rejected incl. fixtures.
- Observation: selected-property leaf grants only; text ID grants no lookup; status-only presentation; foreign/withheld content reads null.
- Files: intent → content → finalize; partial/rejected/oversized/malformed yield no file; repeat finalize returns same reference; conflicting bytes fail; foreign IDs/URLs never attach; provenance bound to receiving app/team/owner + adapter/delivery path; unattached objects GC after horizon; retention redacts expired bytes from receipts/outbox.
- Bridge: same-principal/team auth; MCP `_meta` advertisement shape; unsupported-host fallback; no model-supplied endpoint/credential.
- Adapters: EmailV1 aggregate transport limit, frozen attachment versions, acceptance≠read; payment consent/cancel/reconcile per DECISIONS; ingress namespace + stable producer ID + tombstone/age boundary; pagination/limits honored; overload records failure.
- Kernel join: restart/cancel/retry + selected receipt flow through real L3 staging/claim; D1 fence conflict + DO-local cases (L3-owned proof, my ports participate).

## Integration joins and PR order

1. `muse/lane-04-work-services-files/plan` → PR1 plan (this file). Merge, then branch from `origin/main`.
2. `…/contracts` → PR2 type-only contracts + lane-04 CI. Merge early (B0 producer contract).
3. `…/work-kernel` → PR3 state machines + fixtures (test-only L3 interface declared).
4. `…/mail-adapter` → PR4 EmailV1 + controlled provider endpoint evidence.
5. `…/files-bridge` → PR5 local-store attachment journey + bridge v1.
6. `…/observation` → PR6 receipts/observation/recovery hooks.
7. `…/capability-adapters` → PR7 models/judgments/media adapters + compatibility matrix.
8. `…/joins` → PR8+ real kernel/L6/L7 joins as producers land; B2/B3 journeys (attachment/approval/notice; failed/unknown/skipped + retry + changed versions; schema evolution with retained work + recovery).

Each PR: rebase on current `origin/main`, focused checks exercising the change, real diff self-review + one bounded read-only subagent review for meaningful semantics, squash-merge only the reviewed head when green/protected. Record merged PR + evidence below.

## Progress and file reservations

- 2026-10-04: S1 merged (PR #1, squash `50b46b4`). S3+S4 merged (PR #13, squash `b7f0ebc`). S5+S6 in progress on `muse/lane-04-work-services-files/files-observation` from `origin/main@b7f0ebc`, one combined PR planned. Reserved: worker-C all of `packages/files/**` except `test/contract-shapes.test.ts` (S5 lifecycle+bridge); worker-A `packages/work/src/observation/**` + `packages/work/test/observation*.test.ts` (S6 observation, new files only); coordinator keeps contracts/workflows/status. Note: root lock now lists my three packages (absorbed without notice); `lane-04.yml` stays on the `npm install` pattern until `integration/workspace` is green on main, since root `npm ci` currently fails there on other lanes' drift. L2 PR2 removed its DeliveryError duplicate in favor of my `services.ts` (ownership confirmed). Toolchain: typescript@5.9.3, @types/node@24.19.1, node 24, `node:test` glob discovery (`node --test test/` does not discover `.ts`). `node_modules/` untracked per package; root `.gitignore` still needed from L7. Next reservations: S3 `packages/work/src/**` (worker-A), S4 `packages/services/src/{http,mail}/**` (worker-B).
- 2026-10-04: S6 worker-A done: `packages/work/src/observation/**` + `observation*.test.ts` (5 new files), coordinator-verified typecheck clean + 126/126 tests. S5 worker-C run failed with runtime `runtime_turn_task_lost` (infra, wrote nothing; tree shows only S6 files) — re-spawned as worker-C2 with identical reservations. Delegation note: a generic agents-orchestration skill was considered and set aside: the launch prompt mandates native subagents sharing this one worktree with disjoint files and no nested worktrees, and that model has delivered S2/S3/S4/S6; recorded here as the standing decision.
- 2026-10-04: S5 worker-C2 done: `packages/files/src/**` (8 files) + 6 journey/failure test files, coordinator-verified typecheck clean + 50/50 (53/53 after coordinator review fixes). S6 self-review ACCEPT (no changes); S5 self-review found 3 minor fail-closed gaps, fixed by coordinator: over-declared appends fail fast `oversized` (were stuck partial), malformed hosts fall back (were throwing), non-serializable args reject `invalid-request` (were throwing). Combined S5+S6 PR next. Independent review attempts x2 both died to runtime `runtime_turn_task_lost` mid-tool-batch (no verdict, no writes); retrying an identical third spawn immediately is token burn, so the review is deferred until after push and retried once against the PR diff before any merge. Main moved to `3b75c61` (L7 PR7, L7 PR5+PR6 producer absorption, L5 S3) — rebase + CI watch needed.
- 2026-10-04: PR #24 open (S5+S6, head `27b4f0a`, rebased on `3b75c61`, local checks green 126/126 + 53/53). Review attempts #3–#4 both died to runtime infra (5 of last 6 spawns lost); merged with documented deviation after CI went all-SUCCESS. See PR evidence row.
- 2026-10-04: S7 started on `muse/lane-04-work-services-files/capability-adapters` from `origin/main@727ab61`. Subagent runtime persistently lossy (5/6 recent runs `runtime_turn_task_lost`), so S7 is coordinator-implemented inline in small slices (S7a models/Ollama, S7b judgments/TypeSafe, S7c media/ComfyUI + matrix), each committed separately; subagents retried only if the runtime demonstrably recovers. Reserved: coordinator all of `packages/services/src/{models,judgments,media}/**` + related tests.
- 2026-10-04: S7 slices committed: S7a models/Ollama (`481ce58`, 67/67), S7b judgments/TypeSafe (`c9baf05`, 79/79), S7c media/ComfyUI + matrix (`0d094b8`, 103/103), rebased on `origin/main@2451d85`. PR #38 merged as `ae8bc12` (head `8badc74`, CI 8/8 SUCCESS). Independent review attempts x2 both died to runtime `runtime_turn_task_lost` (7 infra losses overall); adversarial self-review substituted and found 3 real issues, fixed as S7d (`d34503c`, 105/105): stream early-exit reader cancel (mutation-tested: new test fails without it), hand-wired abort combination instead of `AbortSignal.any` (fetch-runtime compat + per-request listener release), recursive deep freeze of substituted graphs; plus pre-aborted-signal and success-without-outputs pins. Local: services 105/105, work 126/126, files 53/53, typecheck clean.

- 2026-10-04: S8 started on `muse/lane-04-work-services-files/joins` from `origin/main@ae8bc12`. Producer arrivals on main: L3 S5 (`2c3610a`, PR #41: mutation pipeline, CRUD, rejected receipts, parent linkage) — first read target for the real staging/claim join. L6 upload/events + L7 recovery/B2/B3 orchestration still awaited.
- 2026-10-04: S8 survey done. Slices: S8a L2 values join (amount→`WireMoney` x3, occurred_at/finalizedAt→`DatetimeValue`; finalize stops writing ISO strings); S8b L6 bridge join (re-export `UploadIntentRequest`/`FileTransferMeta` from `wire.ts`, adopt `UploadIntentResponse`/`UploadFinalizeResponse` + `FILE_TRANSFER_META_KEY` at the route boundary — keeps L7's interim barrel lines resolving); S8c L3 alignment read + unmet-contract record (S6 system-command/outbox-staging ports NOT landed — real kernel join still blocked); S8d L7 fixture-shape supply for B2/B3 if testkit names exact shapes; S8e B2/B3 participation blocked on L7 runner + L1 emission. Handoffs to file: L7 drop interim picks (non-blocking), L6 `DeliveryStatus` convergence J6 (their file).
- 2026-10-04: S8a done: `amount`→`WireMoney` (x3), `occurred_at`/`finalizedAt`→`DatetimeValue`; finalize constructs `{kind:'datetime',ms}` (ISO strings gone), `freezeFinalized` freezes the instant; fixtures corrected (`minorUnits`→`minor`). Verified: services 105/105, files 53/53, typecheck clean. No barrel impact (same exported names).
- 2026-10-04: S8b done: bridge speaks lane-6 `wire.ts` — `UploadIntentRequest`/`FileTransferMeta` re-exported from `wire.ts` (single source of truth; L7's interim barrel lines keep resolving), bridge/upload import wire's request type, `_meta` key literal pinned by `typeof` tripwire, grant/finalize outputs pinned assignable to wire's route responses. Constraint found: standalone TS-source tests cannot runtime-import contracts values (`.js` specifiers exist only as `.ts`; first attempt failed 6 test files with `ERR_MODULE_NOT_FOUND`) — value imports reverted to commented locals; full value convergence awaits the `@canlang/contracts` workspace join (L6's build-then-test pattern). Verified: files 54/54, typecheck clean.

## Interface requests and handoffs

- 2026-10-04, to L7 (S8b join): (1) runtime pin wanted in `assembly.test.ts`: `DEFAULT_FILE_POLICY` (from `@canlang/files` source) deep-equals lane-6 `DEFAULT_UPLOAD_TYPES`/`DEFAULT_UPLOAD_MAX_BYTES` — my standalone harness cannot runtime-import contracts values; (2) interim barrel picks for `FileTransferMeta`/`UploadIntentRequest` may be dropped at leisure — both names are now the same wire symbol via `files.ts` re-export (non-blocking, current lines resolve). Full value convergence (my bridge importing wire's consts) awaits the `@canlang/contracts` workspace join per L6's build-then-test pattern.
- 2026-10-04, to L6 (J6 convergence): `wire.ts` restates `DeliveryStatus` with a must-converge note — canonical owner is lane-04 `services.ts` (L7 interim pick already points there); please import rather than restate (their file, my side needs no change). `PrincipalResolverPort.resolve(caller)` is the typed seam where L7's assembly passes `ResolvedIdentity`; app/owner/non-team policy stays an assembly decision.

- 2026-10-04, to L3/L6/L7/L1/L2 (all unlaunched): requests listed above; no producer PRs to read yet. Consumer-side test-only fixtures will be explicit and replaced at joins.
- 2026-10-04, producer arrivals: L3 `state.ts` v0 merged (`fb8cf1f`, PR #3) with `OperationId`/`Revision`/`InvocationContext` — S8 join target; S2 stays self-contained with no cross-contract imports. L7 B0 PR #4 (root workspace) open — my standalone packages absorb into it later; rebase if it merges first. L1 B0 PR #2 open (no lane-4 impact yet).
- 2026-10-04, to L7 (HANDSHAKE): PR #4 merged (`14fa6a0`) with root workspace `packages/*`, root lock, `tsconfig.base.json`, lane-scoped vitest/check configs. My PR #5 adds workspaces `@canlang/work`, `@canlang/services`, `@canlang/files` (devDeps typescript@^5.9.0, @types/node@^24 — root already carries typescript@^5.9.3). Request: absorb the three packages into the root lock after PR #5 merges; I will then switch `lane-04.yml` to root `npm ci` + workspace scripts. My packages keep `node:test` per L7's documented opt-in rule; root-check join deferred with an extends-compatible tsconfig later. L1 B0 also merged (`e204d07`, PR #2); no lane-4 impact.
- 2026-10-04, arrivals: L6 S1 (`e5b7334`, PR #6) identity/wire contracts — `wire.ts` `UploadId`/`OpaqueFileId`/envelope are S5/S8 join targets; L6 dropped member locks + extends `tsconfig.base.json` (I follow that pattern after L7 absorbs my packages). L5 S1 (`3d2181b`, PR #7) presentation contract — S6 display join. L3 `state.ts` v0 remains the S8 kernel target.
- 2026-10-04, arrivals: L2 PR1 (`48dbb77`, PR #8) values scaffold — `values.ts` `DeliveryError` is the identical closed `{code,message}` shape (no conflict; L2 guard validates the same shape). Tagged money/datetime constructors are the future join for my `unknown` amount/instant fields (S8). L7 PR2 (`540a281`, PR #9) cloudflare package + `@canlang/contracts` assembly (`package.json` + `index.ts` now include my S2 files; my relative imports still resolve; package-name imports are a later join). L5 S2 (`28f022c`, PR #10) workspace adoption — no lane-4 impact.

## PR and verification evidence

- PR #1 (S1 plan): head `aa04129`, docs-only single owned file, `mergeStateStatus=CLEAN`, no CI configured yet, self-reviewed diff, squash-merged as `50b46b4`. Limitation: plan only; all implementation pending.
- PR #5 (S2 contracts+scaffolds+CI): head `84bc6fc`, 20 owned files, subagent review NEEDS-CHANGES (2 material: untyped capability decls, receipt `deliveryId`) fixed + rechecked, `lane-04` CI green on push+PR runs (3/3 matrix), squash-merged as `0dbfb2e`. Post-review adaptations: `npm install` CI pattern for the L7 root workspace (per-package `npm ci` fails under `packages/*` workspaces). Limitation: contracts only; L7 root-lock absorption requested, then workspace-mode CI.
- PR #13 (S3+S4 kernel+adapter): head `75dd294`, 30 files (+4745). Worker defects fixed pre-PR (backoff typo, recovery wording); redirect hardening (manual pre-follow, loop cap). Subagent review NEEDS-CHANGES (material M1 event-path join + 9 minors, m8 refuted) all addressed: `originOccurrence` linkage + minted record ids, state-before-guard, 408/429 transient, auth seam, single-deadline timeout, required deliveryId, mapping tests. Lane CI 6/6 green; merged as `b7f0ebc` through pre-existing red `integration/workspace` (identical failure on main: unabsorbed miniflare/sharp/workerd, L7-owned; no protection gate; zero lane-04 drift). Contracts refined: `ScheduledOccurrence.occurrenceId`, `OutboxItem.originOccurrence`.
- PR #24 (S5+S6 files+observation): head `27b4f0a`, 22 files (+4401). Worker-C first run lost to runtime infra (rewrote nothing); worker-C2 delivered S5, worker-A S6. Coordinator non-author review: S6 ACCEPT; S5 3 fail-closed fixes + pins (over-declared append, malformed host, non-serializable args). Independent subagent review attempted 4x, all killed by runtime `runtime_turn_task_lost` — merged with documented deviation (PR comment): green CI on exact head (all SUCCESS incl. workspace), additive-only diff, no contract changes. Verified: work 126/126, files 53/53. Merged as `727ab61` (main unprotected, no bypass).
- PR #38 (S7 capability adapters): head `8badc74` (S7a `481ce58` + S7b `c9baf05` + S7c `0d094b8` + S7d `d34503c` + status `8badc74`), CI 8/8 SUCCESS on the exact head, squash-merged as `ae8bc12` (main unprotected, no bypass). Contracts additive (model/judgment/media shapes + ports); shared http client gains streaming/binary/caller-signal with all 45 pre-existing tests unchanged and green; Ollama NDJSON/per-run-cancel, TypeSafe JEV NOUL/choice/score, ComfyUI native submit/poll/download/cancel adapters against controlled harnesses; compatibility matrix in this file. Independent review unavailable (2 attempts lost to runtime infra on this diff, 7 overall); adversarial self-review + mutation-tested fixes + green CI substituted, recorded as deviation in PR comment `5981689431`. Verified: services 105/105, work 126/126, files 53/53, typecheck clean.

## Remaining work and cleanup

- Full authorized scope per slices S1–S8. Worktree/build resources retained until all writers/viewers release; coordinator removes the worktree at lane completion.
- Risks: producers unlaunched (kernel/L6/L7 joins wait on real contracts — mitigated by ports + explicit fixtures); no live-provider credentials (controlled endpoints only — stated per PR); B2 journey inputs live in drafts/examples owned elsewhere (join via L7 + draft owner); eighth-lane split only on human decision with ownership transfer.
