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

- 2026-10-04: S1 merged (PR #1, squash `50b46b4`). S2 submitted for review on `muse/lane-04-work-services-files/contracts` (rebased onto `origin/main@fb8cf1f`). Toolchain: typescript@5.9.3, @types/node@24.19.1, node 24, `node:test` glob discovery (`node --test test/` does not discover `.ts`). `node_modules/` untracked per package; root `.gitignore` still needed from L7. Next reservations: S3 `packages/work/src/**` (worker-A), S4 `packages/services/src/{http,mail}/**` (worker-B).

## Interface requests and handoffs

- 2026-10-04, to L3/L6/L7/L1/L2 (all unlaunched): requests listed above; no producer PRs to read yet. Consumer-side test-only fixtures will be explicit and replaced at joins.
- 2026-10-04, producer arrivals: L3 `state.ts` v0 merged (`fb8cf1f`, PR #3) with `OperationId`/`Revision`/`InvocationContext` — S8 join target; S2 stays self-contained with no cross-contract imports. L7 B0 PR #4 (root workspace) open — my standalone packages absorb into it later; rebase if it merges first. L1 B0 PR #2 open (no lane-4 impact yet).

## PR and verification evidence

- PR #1 (S1 plan): head `aa04129`, docs-only single owned file, `mergeStateStatus=CLEAN`, no CI configured yet, self-reviewed diff, squash-merged as `50b46b4`. Limitation: plan only; all implementation pending.

## Remaining work and cleanup

- Full authorized scope per slices S1–S8. Worktree/build resources retained until all writers/viewers release; coordinator removes the worktree at lane completion.
- Risks: producers unlaunched (kernel/L6/L7 joins wait on real contracts — mitigated by ports + explicit fixtures); no live-provider credentials (controlled endpoints only — stated per PR); B2 journey inputs live in drafts/examples owned elsewhere (join via L7 + draft owner); eighth-lane split only on human decision with ownership transfer.
