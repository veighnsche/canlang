# Implementation of faithful CanLang draft workflows

This is the complete execution checklist for the user-authorized challenge audit implementation. It derives from the deliberate draft-first audit and the saved 41-task plan. One existing Muse coordinator executes it at Muse Spark 1.3 Contributor MAX; Codex owns independent review and the runtime monitor. The goal is faithful, executable applications with useful safety guarantees and concise authoring.

## Handoff contract

| Requirement | Intended behavior and why | Observable acceptance | Source or decision status |
| --- | --- | --- | --- |
| RQ01 | Treat original drafts as authoritative intent and retain evidence | Site ledger, all 49 file intents, root/consequence attribution and command/results | User challenge-audit prime directive and bias controls |
| RQ02 | Accept coherent expression while preserving demonstrated safety | Original positives accepted; meaningful invalid controls retained; exact/default semantics proven | Audit top ten and T03/T05-T11/T30/T35; opposite verdict and confidence flip required |
| RQ03 | Generate executable apps using canonical state and owned contracts | Actual compiler artifact invokes verified admission/storage/history/replay; no alternate interpreter | Saved execution strategy T04/T15-T18/T28-T32 |
| RQ04 | Execute compiled inline examples honestly | Real calls, isolated fixtures, independent expected values/observations; wrong expectations fail | T21-T23; .mjs is desired output, not proof |
| RQ05 | Preserve durable bounded provider-backed workflows | Atomic effects, selected receipts, fenced progress, finalized files and adopted fanout | T12-T14/T24-T27/T33-T34; unsettled decisions explicitly gated |
| RQ06 | Keep browser/forms/HTTP/MCP interfaces coherent | Checked operation inputs, context, writable allowlist, CSRF/errors and authority parity | T19/T20; retain completed full catalog |
| RQ07 | Qualify original end-to-end workflows and report release scope | T37-T40 real app gates and T41 corpus/release evidence; exact unavailable mandatory features | User requests all implementation; partial slices do not finish parents |
| RQ08 | Resolve consequential decisions fairly without silently rewriting intent | Three fresh equivalent independently worded JEV requests, saved advice/uncertainty, adopted or scoped contract | Repository AGENTS.md; T28/T31a/T32a/T33 blocked until accepted decisions |
| RQ09 | Execute in one inspectable sustained Muse session within laptop limits | Native goal before delegation, exclusive reservations, compact evidence, bounded load, released handoff | Explicit muse-implementation invocation and tmux viewing request |

- Constraints: finite saved scope, no mass draft rewrite, no false runtime claims, no second Muse CLI coordinator. No production deployment, live provider spending, destructive remote action or broad architecture refactor follows from this plan. Preserve unrelated content. Do not contact people.
- Investigation: source HEAD c681d866a494d2d5dfe9e78ab918ead36ef9c826, draft submodule 2d673127e03e8b8bc369a7a34858165c034df131. Earlier installed-binary observation was 4524 diagnostics from 52 sources; it is not a fresh build. Canonical state/UI/progress producers and many B4 fixes already exist. Revalidate actual code before replacement. Known visible joins: runtime/invoke.ts direct execution, testkit loader no-op/unsupported call path, e2e compiled-artifact rejection.
- Selected design and opposing cases: [challenge audit recommendations](/Users/vince/Projects/canlang/implementation/CHALLENGE-AUDIT-PLAN.md). Extend canonical owners; use source-derived descriptors and independent examples. Semantic disposition and implementation availability remain separate.
- Strategy: freeze T04a and exact interfaces, then next-ready scoped producer/consumer handoffs. T04a -> T09/T15a -> T16 -> T17/T18 -> T19a/T20a + T21/T22a/T23a -> original pilot. Durable interfaces progress independently through T24/T25/T26/T27. Containment/hooks/read/fanout require accepted decision gates. Do not impose unrelated rich-provider gates on core-only slices.
- Rules: read root AGENTS.md, REQUIREMENTS.md, implementation/PLAN.md, CONTRACTS.md, DIAGNOSTICS.md and relevant status/WORKFLOW. This user's one-coordinator Muse request supersedes historical seven human-launched coordinators. Lane ownership, source examples, ## comments, executable bindings in do and complete workflows remain applicable. After every merge reconcile all changes since docs/ideal-filetree-plan.md checkpoint; bookkeeping is not implementation authority.
- Load: one existing checkout and build cache, up to THREE active implementation agents, one heavy build/test process at a time. Prepare disjoint work in parallel. No extra worktrees, node_modules copies, private target caches, full transcript bundles, Docker/OS cache cleanup or unrequested broad benchmarks. Native long-command cadence below. Stop new large allocations under 10 GiB free and report capacity blocker.
- Monitoring record: [Codex runtime record](/Users/vince/Projects/canlang/implementation/challenge-audit-run/monitor.md). Muse never edits it; runtime fields live only there.

The Muse coordinator alone edits checklist progress/evidence, keeps reservations and manages Git. Agents edit only explicitly reserved exact paths and report their evidence. Codex may revise a plan/contract only after acknowledgment that affected writers have released ownership. Record each command, exit/result and relevant revision compactly; do not retain all raw diagnostic/transcript output. Completed task evidence links actual tests and artifacts. Suffix slices release matching consumers but parent boxes remain open until full acceptance. Preserve Codex R01/C01 unticked.

Before delegation inspect native get_goal. Reuse a matching new-task goal; create_goal for this checklist once the prior completed handoff is verified. Never replace an unrelated unfinished goal. No arbitrary goal token budget. report_progress tracks evidenced tasks, 100% only at released review-ready handoff; update_goal complete only then. Missing/rejected native goal tools are a blocker to report.

In every agent prompt: routine reinspection of long commands waits 1-5 minutes, default 2, from last check. Native bash initial yield_time_ms 120000, adjustable 60000-300000. Retain handle/deadline in Muse command state; goal wakeups do not reset it or trigger empty bash_input polling. Await automatic completion; background inspection only through runtime-overdue route respecting deadline. Act on delivered completion/failure/input/approval/intervention. Preserve deadlines across shorter supported increments or report the cap; no invented timers or duplicate commands. This is Muse cadence, not Codex heartbeat.

## Lanes and interfaces

Exact task paths below are initial reservation candidates, not permission for multiple lanes to edit the same file. Before an assignment record one writer, exact paths, base revision, contract input/output, acceptance and release condition. New necessary test files may be assigned explicitly by the coordinator in the same owning package. Shared normative docs have one reserved writer after accepted semantic decision.

| Lane | Owned boundary | Contract handoff and parallel safety |
| --- | --- | --- |
| L1 | compiler analysis/codegen/tests; contracts artifact/diagnostic; Rust/editor metadata | Sole Rust writer including L2/L4 requests; serialize types/resolve/examples and entire effects->IR->JS->artifact chain |
| L2 | values implementation/tests; contracts values | Independent expected semantics and conformance; L1 patches Rust, L3 executes defaults |
| L3 | state engine/tests; contracts state | Sole state admission/registry/invoke/mutation/transaction/effects writer; L7 patches platform assembly |
| L4 | work/services/files packages/tests; contracts work/services/files | Canonical owner schemas to L1 checking and other consumers; serialize dispatch/receipt/observation files |
| L5 | UI rendering/forms/context/tests; contracts presentation | Actual generated form join with L6; preserve delivered catalog |
| L6 | identity and interfaces packages/tests; contracts identity/wire | Verified context and checked operation transport; L7 owns platform runtime/MCP assembly |
| L7 | testkit/e2e, cloudflare assembly, contracts examples/deployment/index, root Node config/lock/CI | Real compiled execution and release evidence; sole shared export/manifest/platform writer |
| Draft owner | Individually proven draft corrections and paired intent witnesses | Only exact adjudicated submodule paths; no checker-driven blanket rewrite; coordinator owns submodule Git |

## Tasks

- [x] **M00 — Accept new scope, native goal, ownership and baseline**
  - Prerequisites: prior coordinator handoff/writer release verified; new explicit user authorization.
  - Owner / files / interfaces: Muse coordinator; this checklist/progress and exact owned branch. Codex monitor remains read-only.
  - Changes / traceability: RQ09; acknowledge the task supersedes old no-compiler implementation restriction for this finite scope; inspect native old goal, create matching new goal before delegation, record session/goal refs and all released old writers. Create a codex/challenge-audit-implementation branch from actual HEAD if none matching exists, without force/reset; preserve modified challenge plan and new authorized run docs. No independent agent uses Git.
  - Acceptance: actual contributor/MAX, one active coordinator, matching native goal, cleanly separated new ownership and exact reservations; historical draft work remains unchanged. Native unfinished unrelated goal is reported, not overwritten.
  - Evidence: session 01a106e7-49b5-7543-b54f-eb6ad9540769; new goal goal-01a10cc5-cd99-7ce2-9706-0d1eab1dec92 (prior goal-01a106e7 complete 100%, no unrelated unfinished goal). Branch codex/challenge-audit-implementation from c681d86 (no force/reset); draft submodule clean 2d67312; modified CHALLENGE-AUDIT-PLAN.md + run docs preserved. Transfer verified: 27/27 old writers released, zero active, no child heavy commands. New-task scope supersedes old no-compiler restriction per explicit user authorization; historical draft checklist untouched. H034 main-sync hold does not apply: user-directed work isolated on owned branch, main untouched.

- [x] **T01 — Create the root cause ledger**
  - Prerequisites: M00.
  - Owner / files / interfaces: L1; implementation/challenge-audit-run/evidence/root-causes.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ01/RQ02; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1 with draft owner. Deliver sampled intent, root/consequence, bucket, opposing case, confidence, owner and proof. Done when audited sites are traceable without treating diagnostic codes as uniform defects.
  - Acceptance: Fresh sampled sites cite full context and intended expression, root/consequence, one a-e bucket, opposite case, confidence/flip evidence; record command and result, binary/catalog/source identities.
  - Evidence: writer 01a10cc6-5416-7f51-b29b-fbeb15824638 released evidence/root-causes.md (638 lines, only path + T03 companion). Repro revalidated exact: exit 10, complete=true, omitted=0, 4524 diagnostics; binary/catalog/bundle hashes match plan baseline (coordinator re-verified binary+catalog sha256). 30 roots R01-R30 each with intent/root-vs-consequence/bucket/opposing/confidence+flip/positive+negative; 7 consequence chains C1-C7; family coverage incl deferred E5001/E5004; R30 multi-root method note. Heavy lock acquired+released, no stale lock.

- [x] **T02 — Record per file intent and capability status**
  - Prerequisites: T01; inventory preparation can start at M00.
  - Owner / files / interfaces: L7; implementation/challenge-audit-run/evidence/app-intent.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ01/RQ07; canonical design/task: Accountable lead: L7. Contributors and owning boundaries: L1/L7 with draft owner. Depends on T01. Give all 49 apps accepted workflow intent, demonstrated source defects, unresolved proposals and unavailable implementations. Preserve runtime negatives. Done when every file has an explicit disposition and exact blockers.
  - Acceptance: All 49 top-level apps have accept/reject intent and exact capability blockers; runtime error examples are retained; explicit whole-file negatives require evidence.
  - Evidence: PREP writer 01a10cc8-f27d-79a1-b522-efc016516d27 (scaffold, 830/830 negatives, 0 whole-file negatives — coordinator reproduced) + RECONCILE writer 01a10ccd-be76-7fa1-a7bd-24d8e0b2ab46 RELEASED: 49/49 dispositions cite exact T01 roots/buckets/owners/flips (coordinator verified 0 remaining PENDING, 30/30 distinct R-roots cited, 49 negatives-retained lines); unsampled apps honestly UNADJUDICATED with exact blockers, no invented negatives.

- [x] **T03 — Specify ordinary continuation facts**
  - Prerequisites: M00.
  - Owner / files / interfaces: L1; implementation/challenge-audit-run/evidence/continuation-contract.md; DESIGN.md, GRAMMAR.md, DECISIONS.md only after exact reservation. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1. Define null true/false facts, Boolean composition, branches, successful requirements, joins and invalidation. Done when sampled patterns follow one rule and existence supplies no permission.
  - Acceptance: One sound contract covers true/false null tests, NOT/AND/OR, successful require, joins and invalidation; presence grants no permission; opposing rule defense and costs retained.
  - Evidence: writer 01a10cc6-5416-7f51-b29b-fbeb15824638 released evidence/continuation-contract.md (262 lines, PROPOSED, adopts nothing). One-sentence contract + 15 sections: null facts, short-circuit composition, branches/joins/loops, require-carries-facts, declaration+path keying, immutable/mutable distinction, invalidation, presence-grants-nothing, 6 sampled patterns clean, 8 invalid controls IC1-IC8, retained small-narrowing defense + costs, proposed-but-unapplied DESIGN/GRAMMAR/DECISIONS deltas. Normative docs untouched.

- [ ] **T04 — Agree the generated execution contract**
  - Prerequisites: M00; T04a frozen before matching producers.
  - Owner / files / interfaces: L3; packages/contracts/src/state.ts, packages/contracts/src/artifact.ts (L1 writes), packages/contracts/src/examples.ts (L7 writes), implementation/challenge-audit-run/evidence/execution-contract.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ04; canonical design/task: Accountable lead: L3. Contributors: L1/L2/L6/L7 and affected producers. Deliver T04a first, including emitted-example calls, independently authored expected values/observations and compatibility; then T04b's remaining joins. Done when actual producers/consumers agree on models/operations/defaults/hooks and verified invocation.
  - Acceptance: T04a versioned descriptor/invoke/example contract agreed by L1/L2/L3/L6/L7; independent expected values/observations; T04b recursive/provider/hook joins and compatibility required for parent completion.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T05 — Implement ordinary nullable flow**
  - Prerequisites: T03.
  - Owner / files / interfaces: L1; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1. Depends on T03. Extend ordered guards, false continuations, joins and invalidation. Done when Affiliate/Approve/Catch/Chat/Check/Contract positives pass and unguarded/invalidated controls fail.
  - Acceptance: Original Affiliate/Approve/Catch/Chat/Check/Contract guarded cases pass; unguarded, read-before-guard, OR-null, alias-write, join and zero-iteration controls fail appropriately.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.
  - Coordinator note: checker-file path is compiler/tests/b4_check.rs (NOT compiler/src/analysis/b4_check.rs — earlier briefs misstated; T08 writer corrected per tasks.md). Future L1 briefs must use the tests/ path.

- [ ] **T06 — Complete actor facts in policies and CRUD**
  - Prerequisites: T05.
  - Owner / files / interfaces: L1; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02/RQ03; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1. Depends on T05. Carry caller admission through composite policies and by-to-when. Done when admitted actor use passes while public, other-subject and preauthorization cases remain nullable.
  - Acceptance: Composite admitted actor and CRUD by-to-when facts pass; public/preauthorization/other-subject actor remains nullable; existence does not grant authority.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T07 — Propagate filtered row facts**
  - Prerequisites: T05.
  - Owner / files / interfaces: L1; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1. Depends on T05. Bind facts to selected row/snapshot and collection children. Done when CRM/Rent patterns pass without alias/sibling/nested-row leakage.
  - Acceptance: CRM/Rent filtered rows and collection children inherit only their selected snapshot facts; alias, sibling and nested-row controls prove no leakage.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T08 — Unify readable selector resolution**
  - Prerequisites: M00; L3/L5 review semantic member contract.
  - Owner / files / interfaces: L1; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs, packages/ui/src/policyPage.ts (L5 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1 with L3/L5 review. Resolve parent, safe metadata and value members canonically. Done when valid policy/UI paths agree and invalid leaves/descent/disclosure still fail.
  - Acceptance: Canonical parent/safe metadata/money selectors agree across policy/UI; unknown leaf, invalid descent, disclosure and metadata-write controls retained; selector checking provides no flow or permission fact.
  - Evidence: Rust slice done (writer 01a10ccc, types.rs +203/-83, tests/b4_check.rs +184; resolve.rs needed no change): unified navigate_selector, read-context metadata, 18 boundary tests (9 pos/9 neg). L5 policyPage slice done (writer 01a10cd4-c565, +314/-0, tsc 0; fail-closed guards for every R07/R08 negative; ok-carries fact:null/permission:null/writable:false). Coordinator: cargo check 0; family recount 4524→4364 with E2013 403→243 as the ONLY moved family (all others bit-identical) = pure intended acceptance. Parent OPEN: draft_outcome_table re-pin slice queued (analysis.rs).

- [ ] **T09 — Preserve creation metadata through the compiler**
  - Prerequisites: T04a for emitted contract; semantic preparation ready at M00.
  - Owner / files / interfaces: L2 with exclusive L1 Rust writer; packages/values/src/schema.ts, packages/values/src/array.ts, packages/contracts/src/values.ts; compiler/src/analysis/effects.rs, compiler/src/codegen/ir.rs, compiler/src/codegen/js.rs, compiler/src/codegen/artifact.rs, packages/contracts/src/artifact.ts, compiler/tests/codegen.rs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02/RQ03; canonical design/task: Accountable lead: L2; L1 owns Rust/effects/IR/emission patches. Carry ordinary/required arrays, null/default/server/derived distinctions through the full descriptor chain. Done when omission semantics and independent values conformance agree and contradictory emission expectations are corrected.
  - Acceptance: ordinary/required arrays, nullable/default/server/derived fields preserve omission semantics in analysis, effects, IR, descriptors and actual creation; contradictory old [] expectations repaired with independent conformance.
  - Evidence: TS slice done (parent OPEN; Rust emission remains): writer 01a10cd4-c68b released values.ts (+23/-0 ArrayOmission/FieldDefaultOrigin), array.ts (+45/-1 EMPTY_ARRAY/applyArrayOmission), schema.ts (+181/-14 marker-driven omission, ENGINE_RESOLVED sentinel, server/derived threaded). Old nullability-conflated requiredness removed = the R09 repair. values+contracts tsc 0 (coordinator re-verified).

- [ ] **T10 — Validate contextual structural literals**
  - Prerequisites: M00; expected owner contracts available.
  - Owner / files / interfaces: L2 with exclusive L1 Rust writer; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs, packages/values/src/schema.ts, packages/contracts/src/values.ts. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L2; L1 owns Rust checking. Supply closed recursive semantics and conformance for expected contracts. Done when qualification/research/alert/executed-party positives pass and shape/enum/reference/provenance negatives fail.
  - Acceptance: Closed recursive expected-structural literals accept qualification/research/alert/executed-party shapes; invalid shape/enum/reference/provenance reject without broad coercion.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T11 — Contextually type exact integral decimal literals**
  - Prerequisites: M00; exact value contract agreed.
  - Owner / files / interfaces: L2 with exclusive L1 Rust writer; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs, packages/values/src/decimal.ts, packages/values/src/wire.ts. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L2; L1 owns Rust expected-type behavior. Preserve exact expected-decimal literals without variable coercion. Done when defaults/bounds/inputs/wire values agree and ambiguity/range negatives remain.
  - Acceptance: Contextual integral decimal literals remain exact across bounds/defaults/inputs/wire; variable coercion, ambiguity and range controls remain; no binary Number shortcut.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [x] **T12 — Inventory standard and bound declarations**
  - Prerequisites: M00.
  - Owner / files / interfaces: L4; implementation/challenge-audit-run/evidence/interface-inventory.md, packages/services/src/catalog.ts, packages/work/src/catalog.ts, packages/files/src/catalog.ts, packages/stdlib/src/index.ts. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ01/RQ03; canonical design/task: Accountable lead: L4. Contributors and owning boundaries: L4 with L1/L2/L3. Map all imports to accepted owner contracts, versions and availability. Done when each unresolved interface has a producer or explicit decision question.
  - Acceptance: Every imported standard/bound declaration has its actual producer, version, accepted scope and availability or a precise decision blocker; preserve completed producers.
  - Evidence: writer 01a10cc6-5696-79a0-a764-5a88d8e5e84d released. 84 distinct declarations mapped (26 std + 58 bound non-std, all resolving); 12 precise blockers B1-B12, none silent; checker cross-checks exact (24 E2005 = unbound-std lines; 86 E3019 = 65 sends + 21 recipes). Zero catalog/index code changes with recorded rationale (no new provider semantics). Coordinator reproduced 49 use-std lines + 45 delivery forms via rg. All read-only; no heavy commands.

- [ ] **T13 — Export and consume versioned interface schemas**
  - Prerequisites: T12.
  - Owner / files / interfaces: L4, producer-owned schemas; L1 consumes; packages/contracts/src/services.ts, packages/contracts/src/work.ts, packages/contracts/src/files.ts, packages/services/src/catalog.ts, packages/work/src/catalog.ts, packages/files/src/catalog.ts, compiler/src/analysis/catalog.rs (L1 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ05; canonical design/task: Accountable lead: L4; each producer retains its definitions and L1 owns compiler consumption. Depends on T12. Deliver scoped T13a before richer T13b. Done when the full accepted inventory supplies canonical request/result/error/effect/event/observable declarations and invalid members/bindings reject.
  - Acceptance: Canonical requests/results/errors/effects/events/observable relations reach consumers; T13a common delivery then T13b rich relations; invalid members and binding/provenance reject per actual schema.
  - Evidence: T13a PRODUCER slice done (writer 01a10ccb) + CONSUME slice done (parent OPEN; T13b remains; prior text: L1-consume pending): writer 01a10ccb-5fb9-7902-9a5d-78a1c91622b3 released 3 contracts files (+212/-2, tsc exit 0 re-verified by coordinator). SERVICES/WORK/FILES_CONTRACT_VERSION=1 + STD_EMAIL/ERRORS/PAYMENTS_V1 contracts v1; EmailV1 send-only (reconcile port-op excluded with rationale); Errors/Payments contract-only per B10 (no catalog adds); B9 recorded (attachments required, flagged T14a); B1/B11/B12 preserved; T13b untouched. Catalogs untouched. CONSUME: writer 01a10cd0-1865-7701-9e14-c3f793777d04 RELEASED compiler/src/analysis/catalog.rs (+500/-0 additive-only verified). B1 explicit (compiler-known std module fed by T13 schemas); E3019 preserved for all T13b scope via None lookups; unit tests mirror frozen producers. Coordinator cargo check DEFERRED to T08 release (shared crate, lock discipline).

- [ ] **T14 — Type bound sends and fixture recipes**
  - Prerequisites: matching T13a/T13b and applicable T10.
  - Owner / files / interfaces: L1 with L4 schema input; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs, compiler/src/analysis/catalog.rs, compiler/src/analysis/examples.rs, compiler/tests/b4_examples.rs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02/RQ05; canonical design/task: Accountable lead: L1 with L4. Depends on applicable T10 and corresponding T13a/T13b. Deliver T14a and richer T14b against actual owner schemas. Done when requests/recipes validate and wrong associations/protected-handle fabrication fail across the promised scope.
  - Acceptance: Actual bound sends and recipe classes validate against owner schema; wrong association and protected handle fabrication fail; record rich scope remaining after T14a.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T15 — Emit canonical model and operation descriptors**
  - Prerequisites: T04a plus relevant T09/T10/T11 and actual pilot types; full T04 for full scope.
  - Owner / files / interfaces: L1; compiler/src/analysis/effects.rs, compiler/src/codegen/ir.rs, compiler/src/codegen/js.rs, compiler/src/codegen/artifact.rs, packages/contracts/src/artifact.ts, compiler/tests/codegen.rs, compiler/src/analysis/examples.rs, compiler/src/codegen/bdd.rs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ04; canonical design/task: Accountable lead: L1. T15a depends on T04a and relevant T09/T10/T11 facts for the complete pilot scope; full completion requires T04/T09/T10 and applicable exact/provider facts. Done when actual recursive schema/ownership/callable and separate example artifacts are consumed without alternate handbuilt descriptors.
  - Acceptance: Source-derived recursive model/operation/callable ownership descriptors and separate examples are actually consumed; complete original pilot types; no handbuilt alternate descriptors or omitted source behavior.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T16 — Join generated invocation to state admission**
  - Prerequisites: matching T15a and T04a.
  - Owner / files / interfaces: L3 with L6/L7 integration; packages/state/src/invocation/registry.ts, packages/state/src/invocation/admission.ts, packages/state/src/invocation/invoke.ts, packages/state/src/mutation/models.ts, packages/state/src/mutation/pipeline.ts, packages/state/src/mutation/crud.ts; packages/cloudflare/src/runtime/invoke.ts, packages/cloudflare/src/runtime/stdlib.ts, packages/cloudflare/src/runtime/context.ts, packages/cloudflare/src/runtime/env-assembly.ts, packages/cloudflare/src/runtime/mcp-registry.ts, packages/cloudflare/src/worker/assembly.ts (L7 writes); packages/identity/src/authentication/context.ts (L6 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03; canonical design/task: Accountable lead: L3 with L1/L6/L7. Depends on T15a for matching core scope, and later descriptors for richer scope. Connect verified context, validation, admission and projection. Done when generated denied/stale/rejected/replayed calls use canonical behavior across the promised scope.
  - Acceptance: Generated invocation uses canonical verified-context admission, query/mutation ports; unauthorized/forged context fails; source-generated registry/operations are used, not parallel engine.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T17 — Replace interim data plane operations**
  - Prerequisites: T16.
  - Owner / files / interfaces: L3 with L7 assembly; packages/state/src/invocation/registry.ts, packages/state/src/invocation/admission.ts, packages/state/src/invocation/invoke.ts, packages/state/src/mutation/models.ts, packages/state/src/mutation/pipeline.ts, packages/state/src/mutation/crud.ts, packages/state/src/storage/d1.ts, packages/state/src/storage/durable-object.ts, packages/state/src/ports/transact.ts; packages/cloudflare/src/runtime/invoke.ts, packages/cloudflare/src/runtime/stdlib.ts, packages/cloudflare/src/runtime/context.ts, packages/cloudflare/src/runtime/env-assembly.ts, packages/cloudflare/src/runtime/mcp-registry.ts, packages/cloudflare/src/worker/assembly.ts (L7 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03; canonical design/task: Accountable lead: L3 with L7 assembly. Depends on T16. Migrate create/set/delete/query to the existing state engine. Done when required history/replay and readable projection exist and migrated interim consumers are retired.
  - Acceptance: Actual generated operations persist through canonical transaction/history/replay/projection with D1/DO evidence where claimed; rollback/no-change/duplicate/stale cases proved; retain completed engine.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T18 — Execute defaults and server initialization correctly**
  - Prerequisites: T09/T16/T17.
  - Owner / files / interfaces: L2 acceptance; L3 execution; L1 emission; packages/state/src/invocation/registry.ts, packages/state/src/invocation/admission.ts, packages/state/src/invocation/invoke.ts, packages/state/src/mutation/models.ts, packages/state/src/mutation/pipeline.ts, packages/state/src/mutation/crud.ts; compiler/src/analysis/effects.rs, compiler/src/codegen/ir.rs, compiler/src/codegen/js.rs, compiler/src/codegen/artifact.rs, packages/contracts/src/artifact.ts, compiler/tests/codegen.rs (L1 writes); packages/values/src/schema.ts (L2 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02/RQ03; canonical design/task: Accountable lead: L2; L3 owns runtime execution and L1 emission. Depends on T09/T16/T17. Preserve context/order, update omission and protected fields. Done when actual creation/null/parent/actor/time/replay cases agree.
  - Acceptance: Create/default/null/parent/actor/time evaluation order, update omission/protected fields and replay once agree in actual generated execution, not descriptor-only tests.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T19 — Derive forms and MCP inputs from checked operations**
  - Prerequisites: T19a: T15a/T16/T18 and pilot types; T19b: exact/bound/file scope.
  - Owner / files / interfaces: L6 with L1/L2/L3/L5 input; packages/interfaces/src/http/operations.ts, packages/interfaces/src/mcp/schemas.ts, packages/interfaces/src/mcp/tools.ts, packages/contracts/src/identity.ts, packages/contracts/src/wire.ts; packages/ui/src/forms.ts (L5 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ06; canonical design/task: Accountable lead: L6 with L1/L2/L3/L5. T19a depends on T15a/T16/T18 and the pilot's types. T19b needs T11 for decimal, matching T13/T14 for bound inputs and applicable file/contract semantics. Done when the full promised input/descriptors/interfaces agree on writable fields, bound arguments, defaults, versions and provenance.
  - Acceptance: Forms/HTTP/MCP derive versioned writable inputs from checked operations; bound args/defaults/exact values/files/provenance match; allowlist and equal-authority submission controls pass.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T20 — Complete presentation context and submission joins**
  - Prerequisites: matching T19a/T19b.
  - Owner / files / interfaces: L5 with L6/L7 integration; packages/ui/src/forms.ts, packages/ui/src/settings.ts, packages/ui/src/appearance.ts, packages/ui/src/shell.ts, packages/contracts/src/presentation.ts; packages/interfaces/src/http/presentation.ts, packages/interfaces/src/http/context.ts, packages/interfaces/src/http/formErrors.ts (L6 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ06; canonical design/task: Accountable lead: L5 with L6/L7. T20a follows matching T19a; T20b follows richer T19b and remaining context/preferences requirements. Done when full/partial rendering, metadata, CSRF, errors and actual generated forms use the real dispatcher.
  - Acceptance: Real generated form dispatch shows full/partial rendering, context/metadata/preferences/CSRF/error behavior; preserve existing full UI catalog and shell.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T21 — Enable the compiled e2e artifact path**
  - Prerequisites: T16/T17.
  - Owner / files / interfaces: L7; tests/e2e/fixtures/artifact-loader.ts, tests/e2e/fixtures/e2e-test.ts, packages/cloudflare/src/runtime/artifact.ts. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ04; canonical design/task: Accountable lead: L7. Contributors and owning boundaries: L7. Depends on T16/T17. Reuse validation/assembly for real compilation. Done when journeys assert compiled identity and run generated callables on actual local storage.
  - Acceptance: E2e loader really compiles .can, asserts compiled identity and runs emitted callables on actual local storage; handbuilt fixtures stay distinguishable.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T22 — Implement compiled fixture provisioning**
  - Prerequisites: T22a: T15a/T16/T17, T18 for omission and relevant T36; b finalized files; c matching T13/T14.
  - Owner / files / interfaces: L7 with producer inputs; packages/testkit/src/fixtures/seeds.ts, packages/testkit/src/fixtures/accounts.ts, packages/testkit/src/scopes/local.ts, packages/testkit/src/runner/loader.ts, tests/e2e/fixtures/seed.ts. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ04; canonical design/task: Accountable lead: L7 with L2/L3/L4/L6. T22a core fixtures require T15a/T16/T17, T18 for defaults/omissions and applicable T36 authority decisions. T22b adds actual finalized files; T22c needs matching T13/T14 provider/delivery schemas. Done only when all promised isolated fixture classes validate and setup failures cannot satisfy business expectations.
  - Acceptance: Isolated model/user/grant fixtures then real file/provider/delivery fixtures meet accepted contracts; setup failure cannot count as expected business rejection; parent stays open after core slice.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T23 — Execute compiled tables and sequences**
  - Prerequisites: matching T22a/b/c and T04 emitted-example contract.
  - Owner / files / interfaces: L7 with L1/L3 contributions; packages/testkit/src/runner/loader.ts, packages/testkit/src/runner/table.ts, packages/contracts/src/examples.ts, compiler/src/analysis/examples.rs, compiler/src/codegen/bdd.rs; compiler files L1-only. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ04; canonical design/task: Accountable lead: L7 with L1/L3. T23a follows T22a and the emitted-example contract; T23b follows matching T22b/T22c and actual capabilities. Done only when the full promised calls/callers/prior commits/independent observations/rejection/no-change assertions execute and deliberately broken expectations fail.
  - Acceptance: Actual compiled tables/sequences execute callers/prior commits/independent values and observations, denial/no-change assertions; deliberately false expectation fails; entire promised fixture scope required.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T24 — Join generated effects to durable dispatch**
  - Prerequisites: T16/T17 and matching effect contracts; bound sends matching T13/T14.
  - Owner / files / interfaces: L4 with L3/L7 join; packages/work/src/dispatch/index.ts, packages/work/src/intent/index.ts, packages/work/src/kernel/commands.ts, packages/work/src/recovery/index.ts; packages/state/src/effects/staging.ts, packages/state/src/ports/transact.ts (L3 writes); packages/cloudflare/src/runtime/invoke.ts, packages/cloudflare/src/runtime/stdlib.ts, packages/cloudflare/src/runtime/context.ts, packages/cloudflare/src/runtime/env-assembly.ts, packages/cloudflare/src/runtime/mcp-registry.ts, packages/cloudflare/src/worker/assembly.ts (L7 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ05; canonical design/task: Accountable lead: L4 with L3/L7. Depends on T16/T17 and the relevant effect/operation contracts; bound sends additionally require matching T13/T14 slices. Stage domain/history/replay/outbox/dispatch atomically. Done when the full promised rollback, guards, skipped outcomes, retry and recovery satisfy their contracts.
  - Acceptance: Atomic domain/history/replay/outbox staging connects actual generated effects to dispatch; origins/guards/skips/rollback/retry/recovery proved; never infer cross-store atomicity.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T25 — Implement authorized selected receipt access**
  - Prerequisites: T24 and matching T14.
  - Owner / files / interfaces: L4 with L1/L3; packages/work/src/receipt/index.ts, packages/work/src/observation/association.ts, packages/work/src/observation/observation.ts, packages/work/src/observation/ports.ts, packages/contracts/src/work.ts; compiler analysis L1, state L3. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ05; canonical design/task: Accountable lead: L4 with L1/L3. Depends on matching T14 operation/recipe checking and T24 dispatch. Join locator, selected leaves, disclosure and revision fencing. Done when stale association and status-only access boundaries are demonstrated across the promised scope.
  - Acceptance: Selected receipt locator/association/leaf authorization and revision fence execute; stale attempts cannot overwrite newer associations; status-only disclosure remains restricted.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T26 — Implement associated observable progress**
  - Prerequisites: matching T13 relations and T25.
  - Owner / files / interfaces: L4 with L1/L3; packages/work/src/receipt/index.ts, packages/work/src/observation/association.ts, packages/work/src/observation/observation.ts, packages/work/src/observation/ports.ts, packages/contracts/src/work.ts, packages/work/src/event/index.ts, packages/work/src/recovery/index.ts. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ05; canonical design/task: Accountable lead: L4 with L1/L3. Depends on each relation's matching T13 declaration and T25 receipt support. Use existing producer machinery and qualify relations independently. Done when the full promised correlation, duplicates, cancellation, late usage, restart, terminal immutability and notification behavior execute.
  - Acceptance: Correlated observation proves duplicates/cancellation/late usage/restart/terminal immutability/notification per relation using existing machinery; no new incompatible progress engine.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T27 — Prove generated image finalization**
  - Prerequisites: image-relevant T26 and actual file lifecycle.
  - Owner / files / interfaces: L4 with L3/L6; packages/services/src/media/mapping.ts, packages/services/src/media/harness.ts, packages/files/src/finalize/index.ts, packages/files/src/provenance/index.ts, packages/files/src/bridge.ts, packages/contracts/src/files.ts. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ05; canonical design/task: Accountable lead: L4 with L3/L6. Depends on image-relevant T26 progress and the file lifecycle. Materialize receiving-app finalized files. Done when ownership, provenance, permissions, invalid output and replay use the real lifecycle.
  - Acceptance: Generated image result materializes real finalized receiving-app file; ownership/provenance/permissions/invalid result/replay all proved; controlled provider output identified as such.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T28 — Settle imported containment semantics**
  - Prerequisites: Prepare at M00; decision requires JEV protocol and full scope evidence.
  - Owner / files / interfaces: L3 design, L1/L4/L7 contributors; implementation/challenge-audit-run/evidence/containment-decision.md, DESIGN.md, GRAMMAR.md, DECISIONS.md under one reservation. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02/RQ03/RQ08; canonical design/task: Accountable lead: L3 with L1/L7 and draft owner. Prepare early. Distinguish declaring identity, local/remote dependency, parent/storage/authority, reverse relationships and migration. Done when an accepted rule preserves workflows and handles cycles/lifecycle.
  - Acceptance: Adopted rule separates declaration owner from storage/containment authority and local versus bound remote models, with fair alternatives and three equivalent reworded JEV requests/responses/uncertainty; no silent assumption.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T29 — Implement imported containment**
  - Prerequisites: accepted T28.
  - Owner / files / interfaces: L3 with L1/L7; packages/state/src/mutation/models.ts, packages/state/src/mutation/pipeline.ts, packages/state/src/query/engine.ts, packages/contracts/src/state.ts; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs (L1 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03; canonical design/task: Accountable lead: L3; L1 owns resolution/checking. Depends on T28 and matching T15/T16/T17. Preserve canonical Employee/Customer relationships. Done when aliases/composition agree and invalid parent/team/lifetime/cycle cases fail in checking and applicable actual storage.
  - Acceptance: Static imported containment and canonical storage/permission behavior follow accepted T28; imported aliases cannot confer accidental storage or access authority.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T30 — Replace spelling based event mutation checks**
  - Prerequisites: M00; resolved provenance available.
  - Owner / files / interfaces: L1 with L3/L4 review; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1 with L3/L4 review. Distinguish parameter/event/reference/snapshot/pending provenance. Done when renaming event changes no validity and immutable snapshot controls remain.
  - Acceptance: Parameter name event can be renamed without validity change; immutable event/reference/snapshot/pending distinctions come from resolution/provenance; invalid mutation controls remain.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T31 — Implement permitted secondary hook writes**
  - Prerequisites: T31a accepted secondary-hook decision via JEV; then T30 and canonical runtime; T28 alone insufficient.
  - Owner / files / interfaces: L3 with L1/L4; packages/state/src/mutation/pipeline.ts, packages/state/src/mutation/crud.ts, packages/state/src/mutation/models.ts, packages/contracts/src/state.ts; compiler/src/analysis/effects.rs, compiler/src/codegen/ir.rs, compiler/src/codegen/js.rs, compiler/src/codegen/artifact.rs, packages/contracts/src/artifact.ts, compiler/tests/codegen.rs (L1 writes); implementation/challenge-audit-run/evidence/hook-decision.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ08; canonical design/task: Accountable lead: L3 with L1. Settle T31a's own accepted rule first; T28 alone is insufficient. Implementation depends on T16/T17/T30 and applicable T28/T29 ownership when imported references are used. Done when staged revision invalidation, atomic rollback, versions/history/replay and forbidden recursion/deletion are proved.
  - Acceptance: Accepted secondary writes execute staged parent hooks with rollback, version conflict and reentry/evaluation-order rules; memory evidence cannot prove durable transaction behavior.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T32 — Define and implement authoritative predicate reads**
  - Prerequisites: T32a decision at M00 with JEV; T32b T16/T17; spent effects also T24.
  - Owner / files / interfaces: L3 with L4/L6/L7; packages/state/src/ports/read.ts, packages/state/src/query/engine.ts, packages/state/src/invocation/admission.ts; packages/identity/src/authentication/revocation.ts (L6); packages/work/src/dispatch/index.ts (L4); implementation/challenge-audit-run/evidence/read-decision.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ03/RQ05/RQ08; canonical design/task: Accountable lead: L3 with L1/L4/L6. Prepare T32a's read/snapshot/revalidation contract early. T32b policy/admission proof needs T16/T17; dispatch/spending additionally needs T24. Done when all claimed contexts preserve revocation/stale-state boundaries and transitive effects.
  - Acceptance: Authoritative bounded reads have accepted permission/revision/revocation fence, including stale reads and revocation between read and effect; no cached snapshot silently authorizes spend.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T33 — Decide scoped durable fanout**
  - Prerequisites: Prepare alternatives early; final decision matching T28/T24 evidence and JEV.
  - Owner / files / interfaces: L4 with L1/L3/L7; implementation/challenge-audit-run/evidence/fanout-decision.md, packages/contracts/src/work.ts; shared normative docs reserved. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ05/RQ08; canonical design/task: Accountable lead: L4 with L1/L3/L7. Prepare fair alternatives early. Final acceptance requires applicable T28 ownership and T24 dispatch evidence plus the design consultation protocol. Done when cohort/checkpoint/identity/concurrent-change/failure/supersession semantics are adopted or explicitly scoped with complete reasons.
  - Acceptance: Explicit adopt or scope with reasons for cohort/checkpoint/identity/concurrent change/failure/supersession and costs; three independent equivalent JEV formulations saved/investigated; required unsupported app remains blocked.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T34 — Implement and qualify adopted fanout**
  - Prerequisites: adopted T33, T24, applicable T28/T29/T32.
  - Owner / files / interfaces: L4 with L1/L3/L7; packages/work/src/dispatch/index.ts, packages/work/src/recovery/index.ts, packages/work/src/kernel/tables.ts, packages/contracts/src/work.ts; owning compiler/state/assembly writer handoffs. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ05; canonical design/task: Accountable lead: L4 with L1/L3/L7. Depends on T24/T33 and applicable accepted T28 ownership; add T29/T32 when cohort or child authority uses those semantics. Done when sizes/crashes/duplicates/concurrent changes/rejected children/retry/supersession prove completeness. If scoped, record deferred reasons rather than implementation completion.
  - Acceptance: Adopted finite fanout proves 499/500/501/1000 cohort completeness, crash/duplicates/concurrent changes/rejected children/retry/supersession. Scoped disposition is explicitly deferred, never ticked as implemented.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T35 — Repair smaller established compiler defects**
  - Prerequisites: Each packet ready only with its actual producer; reserve sequentially.
  - Owner / files / interfaces: L1 with relevant producers; compiler/src/analysis/types.rs, compiler/src/analysis/resolve.rs, compiler/tests/b4_check.rs, compiler/src/analysis/examples.rs, compiler/src/analysis/catalog.rs, compiler/src/codegen/bdd.rs, compiler/tests/b4_examples.rs, compiler/tests/b4_resolve.rs; packages/values/src/icu.ts (L2 writes). Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ02; canonical design/task: Accountable lead: L1. Contributors and owning boundaries: L1 with relevant producers. Handle named titles, ICU arguments, business request bindings, imported CRUD sequences, payload metadata names and query ordering as focused packets. Done per packet when valid/invalid boundaries and source behavior are proved.
  - Acceptance: Per packet prove named titles, ICU arguments, request bindings, imported CRUD sequences, payload id/version vs protected metadata, datetime ordering; preserve negative boundaries and do not redo delivered B4 fixes.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T36 — Adjudicate residual draft and design cases**
  - Prerequisites: T01/T02 plus applicable repaired roots and decisions.
  - Owner / files / interfaces: Draft owner agent under same Muse coordinator; Only specifically adjudicated draft/*.can and their matching .requirements.md/.mjs files, exact paths reserved before edit; draft is an independent git submodule. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ01/RQ02/RQ08; canonical design/task: Accountable lead: existing draft owner with relevant design/compiler producers. Depends on T01/T02 and applicable root repairs. Review collisions/cycles/trusted selectors/fixture parents/secrets/cardinality. Done when each case has an evidence-based verdict and only demonstrated corrections are applied.
  - Acceptance: Every correction has demonstrated evidence for collisions/cycles/trusted handlers/fixture parent/secret/cardinality; preserve original desired workflow and runtime negatives; no mass normalization. Submodule commits/pointer provenance retained.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T37 — Qualify a small original CRUD or work app**
  - Prerequisites: Actual original pilot T02 blockers, T05/T06/T08/T18/T19a/T20a/T21/T22a/T23a; bound/file gates if used.
  - Owner / files / interfaces: L7 with relevant lanes; tests/e2e/apps/challenge-pilot.spec.ts (new), tests/e2e/fixtures/artifact-loader.ts, implementation/challenge-audit-run/evidence/pilot.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ07; canonical design/task: Accountable lead: L7 with relevant lanes. Depends on applicable T05/T06/T08/T18/T19a/T20a/T21/T22a/T23a and every actual T02 blocker. Provider/file extensions are mandatory only if used. Done when unchanged source proves generated operations, distinct users, denied read, persistence, stale update, replay, browser/MCP parity and real examples.
  - Acceptance: One unchanged small authoritative app proves generated operations, two actors, denied read, persistence, stale update, replay, browser/MCP parity and genuine executed examples; no reduced source projection.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T38 — Qualify Expense and Leave or Onboard**
  - Prerequisites: T37; each app T02 blockers and matching T29/T31/attachments/T24/T25.
  - Owner / files / interfaces: L7 with L3/L4/L6; tests/e2e/apps/challenge-expense.spec.ts, tests/e2e/apps/challenge-leave-onboard.spec.ts (new), implementation/challenge-audit-run/evidence/expense-leave.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ07; canonical design/task: Accountable lead: L7 with L3/L4/L6. After T37, qualify app slices independently: matching T29 containment, T31 hooks where used, T22b attachments/T24/T25 delivery where used, and T02 blockers. Done when all promised original workflows prove authority, finalized evidence, defaults and revision invalidation.
  - Acceptance: Original Expense and Leave/Onboard qualify independently for actual authority/finalized evidence/defaults/revision invalidation and hook/imported parent needs; explain skipped app and missing gate.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T39 — Qualify receipt and external recovery workflows**
  - Prerequisites: T37; each app matching T23/T25 and T02 blockers.
  - Owner / files / interfaces: L7 with L3/L4; tests/e2e/apps/challenge-receipts-recovery.spec.ts (new), implementation/challenge-audit-run/evidence/receipts-recovery.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ07; canonical design/task: Accountable lead: L7 with L3/L4. Depends on T37, each app's matching T23/T25 evidence and its blockers. Graduate Approve or Grant, Mail and Sync independently. Done when all promised selected isolation, uncertain outcomes, reconciliation and conflict-preserving recovery execute.
  - Acceptance: Approve/Grant, Mail and Sync separately prove selected isolation, uncertain external outcomes, reconciliation and conflict-preserving recovery through actual source-generated workflows.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T40 — Qualify complex bounded workflows**
  - Prerequisites: T37; Chat matching T26/T32; Creative/Gallery T27; Shift/Volunteer adopted T34; per-app T02 blockers.
  - Owner / files / interfaces: L7 with relevant producers; tests/e2e/apps/challenge-complex.spec.ts (new), implementation/challenge-audit-run/evidence/complex-workflows.md. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ07; canonical design/task: Accountable lead: L7 with relevant producers. After T37, Chat needs matching T26/T32 and its blockers; Creative/Gallery additionally need T27; Shift/Volunteer need adopted T34 and their authority/fixture gates. Record app results independently. Done only when every promised supported workflow proves its accounting/revocation/cancellation/finalized-output/approval/completeness behavior.
  - Acceptance: Per original app prove budgets/accounting/revocation/cancellation/finalized output/approval/cohort completeness as needed; Chat need not wait images/fanout; scoped mandatory workflows remain explicit gaps.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [ ] **T41 — Reconcile corpus and release evidence**
  - Prerequisites: T02 and repairs plus qualifications required by actual advertised scope.
  - Owner / files / interfaces: L7 all-lane consolidation; implementation/challenge-audit-run/evidence/corpus-release.md, implementation/DIAGNOSTICS.md, implementation/status/lane-07.md, docs/ideal-filetree-plan.md after merges; package/version/CI paths under L7 reservation. Serialize overlapping producer-owned writes.
  - Changes / traceability: RQ01/RQ07; canonical design/task: Accountable lead: L7 with all producers. Depends on T02, relevant completed repairs and qualification required by advertised scope. Recheck 52 sources and reattribute remaining roots. Done when supported workflows are faithful/executable, unavailable mandatory features still block and deferred/undecided scope is precisely owned. Partial release evidence does not complete the entire backlog.
  - Acceptance: Recheck all 52 sources with current source-built compiler; reattribute roots, positive/negative guarantees and real runtime evidence; version supported scope and precise deferred/undecided gaps; no blanket suppression/count edits or false full-backlog completion.
  - Evidence: pending; record revision, commands/results, positive/negative/runtime level and released handoff.

- [x] **G0 — Verify integration gate**
  - Prerequisites: T01/T02 relevant pilot inventory, T03, T04a, T12.
  - Owner / files / interfaces: Muse coordinator with producer/consumer leads; checklist evidence and bounded gate record.
  - Changes / traceability: RQ01-RQ09; join actual compatible producer revisions and check the saved plan gate.
  - Acceptance: Root ledger and original pilot blockers agree with frozen artifact/invoke/examples and continuation contracts.
  - Evidence: Coordinator-verified (no writer): T02 cites 30/30 T01 roots with buckets/owners/flips; T03 one-rule covers R01-R06+R28 with §10/§11 controls; T12 resolves R11/R12 (E2005/E3019) to inventory + B1-B12; all 30 roots singly owned (R30 anti-double-count); T04a frozen e22b59f. Inputs FROZEN for consumers at 64f1458/9422d80.

- [ ] **G1 — Verify integration gate**
  - Prerequisites: Relevant T05-T11/T13/T14/T15 slices.
  - Owner / files / interfaces: Muse coordinator with producer/consumer leads; checklist evidence and bounded gate record.
  - Changes / traceability: RQ01-RQ09; join actual compatible producer revisions and check the saved plan gate.
  - Acceptance: Checked original positives and retained negatives join source-derived versioned descriptors and actual owner schemas.
  - Evidence: pending.

- [ ] **G2 — Verify integration gate**
  - Prerequisites: Matching T16/T17/T18/T21.
  - Owner / files / interfaces: Muse coordinator with producer/consumer leads; checklist evidence and bounded gate record.
  - Changes / traceability: RQ01-RQ09; join actual compatible producer revisions and check the saved plan gate.
  - Acceptance: Generated callables use verified canonical admission/persistence/history/replay and applicable real local storage; missing core joins prevent acceptance.
  - Evidence: pending.

- [ ] **G3 — Verify integration gate**
  - Prerequisites: T19a/T20a/T22a/T23a/T37; independently T24-T26 and T29/T31/T32 slices.
  - Owner / files / interfaces: Muse coordinator with producer/consumer leads; checklist evidence and bounded gate record.
  - Changes / traceability: RQ01-RQ09; join actual compatible producer revisions and check the saved plan gate.
  - Acceptance: Record basic pilot, durable work and authority branch acceptance separately. No blanket dependency on unrelated branches.
  - Evidence: pending.

- [ ] **G4 — Verify integration gate**
  - Prerequisites: Each original app T38/T39/T40 and its own actual capability gates.
  - Owner / files / interfaces: Muse coordinator with producer/consumer leads; checklist evidence and bounded gate record.
  - Changes / traceability: RQ01-RQ09; join actual compatible producer revisions and check the saved plan gate.
  - Acceptance: Independent per-app workflow results prove source faithfulness and permission/recovery examples at the claimed level; scoped app gaps remain visible.
  - Evidence: pending.

- [ ] **G5 — Verify integration gate**
  - Prerequisites: T41 and all promised scope; all producer handoffs released.
  - Owner / files / interfaces: Muse coordinator with producer/consumer leads; checklist evidence and bounded gate record.
  - Changes / traceability: RQ01-RQ09; join actual compatible producer revisions and check the saved plan gate.
  - Acceptance: Corpus/release/upgrade report reconciles roots, negative guarantees, supported scope and exact remaining mandatory gaps without false total completion.
  - Evidence: pending.

- [ ] **H01 — Release all writers and hand off implementation**
  - Prerequisites: all Muse-owned required task/gate acceptances, or a truthful genuinely blocked handoff with exact unfinished tasks still open.
  - Owner / files / interfaces: Muse coordinator; this checklist/progress, compact evidence, coherent exact-path commits and reviewable diff/PR if appropriate.
  - Changes / traceability: RQ09; verify roster and command cessation, record release of every path/Git ownership, actual native goal status and outstanding limitations. Do not merge before required independent review. Attach every created PR through the app if available or record exact URL for Codex attachment.
  - Acceptance: zero writers/reservations/heavy commands, evidence complete for every claimed task; do not call a blocked scope complete. No arbitrary step/time stop, no partial projection disguised as completion. Native 100%/complete only for finished review-ready Muse scope. TUI available for viewing.
  - Evidence: pending.

- [ ] **R01 — Independently review and verify acceptance**
  - Prerequisites: H01 and verified writer release; Codex sole reviewer, Muse leaves unticked.
  - Owner / files / interfaces: Codex; implementation/challenge-audit-run/review.md and released exact diff/evidence. Muse performs authorized bounded repairs in the same session.
  - Changes / traceability: RQ01-RQ09; review actual requirements/diffs/negative guarantees and relevant acceptance checks; identify material risk before commissioning repeat broad review. Verify repaired affected behavior. Complete required pre-merge checks; after any normal merge reconcile living file-tree plan against accumulated changes.
  - Acceptance: required checks pass, substantive findings resolved, claims match evidence, no identified material uncertainty; concrete residual scoping/blockers explicitly retained. Approval does not mean unrelated platform completeness.
  - Evidence: pending.

- [ ] **C01 — Preserve evidence and close owned follow-up**
  - Prerequisites: R01, repairs, writer/process release and viewer check; Codex only, Muse leaves unticked.
  - Owner / files / interfaces: Codex monitor/review and exact newly owned temporary resources. Historical directory is foreign; no worktree was allocated for this run.
  - Changes / traceability: RQ09; preserve compact source/command/review/exit evidence, remove only released new prompt/buffer resources, preserve attached bounded terminal with explicit pending cleanup owner, retire only this run's matching heartbeat after no follow-up remains. Do not kill a shared server or delete old foreign resources/caches/swap.
  - Acceptance: exact cleanup and heartbeat retirement confirmed, or precise remaining viewer/cleanup limitation and owner recorded. Never claim implementation stopped merely because monitoring paused.
  - Evidence: pending.

## Coordinator progress and reservations

Pending new-task acknowledgment. Record actual native session/goal refs here once observed. Progress entries are evidence-backed and compact. Reserve exact paths before any worker starts; mark each released handoff and unresolved question. Codex owns the linked monitor and does not edit this progress while Muse holds it.

- ACK M00 2026-10-05: new user-authorized challenge-audit scope accepted in existing session 01a106e7-49b5-7543-b54f-eb6ad9540769 under new goal goal-01a10cc5-cd99-7ce2-9706-0d1eab1dec92. One coordinator (muse-spark-1.3-contributor MAX, TUI, worktree off). Owned branch codex/challenge-audit-implementation from c681d86; exclusive Git/index ownership by coordinator; no agent uses Git.
- RESERVED batch 1 (3/3 slots, base c681d86): (1) L1 T01+T03 writer — evidence/root-causes.md + evidence/continuation-contract.md (new; may create evidence/); release on evidenced ledger + contract. (2) L3 T04a writer — packages/contracts/src/state.ts + evidence/execution-contract.md; artifact.ts/examples.ts explicitly excluded (later owners); release on agreed T04a slice. (3) L4 T12 writer — evidence/interface-inventory.md + services/work/files catalog.ts + stdlib/src/index.ts; release on mapped inventory. DESIGN/GRAMMAR/DECISIONS read-only for all (no reservation granted). Heavy-command lock: implementation/challenge-audit-run/.heavy-lock (mkdir-held, ONE heavy at a time).
- DONE slice T04a: writer 01a10cc6-5556-7ba2-88fc-ff8223bff371 RELEASED evidence/execution-contract.md (new, 9 sections: pinned v1 x7, agreement inputs, descriptor/invocation/example rules, supported types, compatibility, excluded-owner expectations, T04b remainder) + state.ts (+149/-0 appended version constants + descriptor types). Coordinator verified: excluded files untouched, tsc contracts exit 0. Parent T04 stays OPEN (T04b pending). T04a FROZEN for T09/T15a consumers.
- DISPATCH batch 2 (slot freed x1): L7 T02 inventory PREP writer (evidence/app-intent.md; dispositions pending T01, parent open). L1 T01+T03 and L4 T12 still running.
- DONE T12: writer 01a10cc6-5696-79a0-a764-5a88d8e5e84d RELEASED evidence/interface-inventory.md (new file only; catalogs/index untouched with rationale). Task ticked complete (see T12 evidence).
- DISPATCH batch 3 (slot freed x1): L4 T13a producer-slice writer (contracts services/work/files.ts + 3 catalogs restrained; catalog.rs EXCLUDED for L1 follow-up). L1 T01+T03 and L7 T02-prep still running. Queued: T08/T30 (L1 Rust, after T01/T03 release), T13a-L1-consume, T14a.
- DONE T02-prep: writer 01a10cc8-f27d-79a1-b522-efc016516d27 RELEASED evidence/app-intent.md (49/49 sections, 830/830 negatives reproduced, parent T02 OPEN). Task NOT ticked (dispositions need T01).
- DISPATCH batch 4 (slot freed x1): L1 T08-Rust-slice writer (types/resolve/b4_check.rs; policyPage.ts EXCLUDED for L5 follow-up after T03). L1 T01+T03 (evidence-only, disjoint) and L4 T13a still running. Queued: T30, T13a-L1-consume, T14a, T02-reconcile.
- Coordinator note: bundled:agents skill prescribes agents.py lanes + never-subagent_spawn; retained the user-authorized native-subagent protocol instead (shared checkout, worktree off, exact-path reservations, coordinator-only Git) — switching machinery mid-run would break reservations/branch discipline/Codex monitor expectations.
- DONE T01+T03: writer 01a10cc6-5416-7f51-b29b-fbeb15824638 RELEASED evidence/root-causes.md + evidence/continuation-contract.md (only paths; hashes re-verified; lock released). Both tasks ticked complete (see T01/T03 evidence).
- DISPATCH batch 5 (slot freed x1): L7 T02-reconcile writer (fills 49 T01 slots from landed ledger; WRITE ONLY app-intent.md). L4 T13a and L1 T08-Rust still running. T30 BLOCKED on T08 release (same Rust files — serialized). Queued: T30, T05 (needs L2 case requests), T09-reservations, T13a-L1-consume, T14a. G0 freeze when T02 ticks.
- DONE T13a-producer: writer 01a10ccb-5fb9-7902-9a5d-78a1c91622b3 RELEASED 3 contracts files (catalogs/catalog.rs untouched per brief). Parent T13 OPEN (T13b + consume remain; see T13 evidence).
- CORRECTION: T05 prereq is T03 only (no L2 case requests — earlier queue note wrong). Checker-file serialization chain: T08 → T05 → T10 → T30 → T14a all share types/resolve/b4_check.rs. T14a additionally needs T13a-consume + applicable T10.
- DISPATCH batch 6 (slot freed x1): L1 T13a-consume writer (WRITE ONLY compiler/src/analysis/catalog.rs — disjoint from T08's files). L1 T08-Rust and L7 T02-reconcile still running. Queued: T05 (after T08), T10, T30, T14a. G0 freeze when T02 ticks.
- DONE T02: writer 01a10ccd-be76-7fa1-a7bd-24d8e0b2ab46 RELEASED evidence/app-intent.md (49/49 reconciled, 30/30 roots cited, negatives preserved). Task ticked complete (see T02 evidence).
- DONE T13a-consume: writer 01a10cd0-1865-7701-9e14-c3f793777d04 RELEASED compiler/src/analysis/catalog.rs (+500/-0 additive, B1 explicit, E3019 preserved). Parent T13 OPEN (T13b remains; see T13 evidence).
- G0 FROZEN: coordinator agreement check passed (T01/T02/T03/T04a/T12 joins verified; see G0 evidence). G0 ticked.
- DISPATCH batch 7 (slots freed x2): L5 T08-policyPage writer (packages/ui/src/policyPage.ts — L5 writes, T03 landed) + L2 T09-TS-slice writer (values schema/array.ts + contracts values.ts; Rust emission is a later L1 slice). L1 T08-Rust still running. Queued: T05→T10→T30→T14a checker chain, T09-Rust, T13b, JEV-prep alternatives.
- DONE T08-policyPage: writer 01a10cd4-c565-7a70-862f-8c455cd9b96a RELEASED packages/ui/src/policyPage.ts (+314/-0, tsc 0 re-verified). Parent T08 OPEN (see T08 evidence).
- DONE T08-Rust: writer 01a10ccc-6e1b-7743-8ec4-8c55c2bfc389 RELEASED types.rs + tests/b4_check.rs (resolve.rs untouched, needed no change). PATH CORRECTION: brief said src/analysis/b4_check.rs (nonexistent); writer correctly used compiler/tests/b4_check.rs per tasks.md — all future L1 briefs use tests/ path. Parent T08 OPEN (table re-pin queued; see T08 evidence).
- DONE T09-TS: writer 01a10cd4-c68b-7451-b9bf-a9d71ea814cc RELEASED 3 TS files (R09 repair verified, tsc 0). Parent T09 OPEN (Rust emission remains; see T09 evidence).
- VERIFY: cargo check 0; full suite 28 pass + draft_outcome_table FAILS with pure-reduction delta (28 files, zero increases); coordinator family recount proves E2013-only move (403→243, all other families bit-identical) = intended T08 acceptance. Table re-pin is legitimate expectation repair with attribution, queued as T08-table slice. Precedent: each behavior-changing checker slice re-pins the table with per-family attribution.
- DISPATCH batch 8 (slots freed x3): L1 T08-table writer (WRITE ONLY compiler/tests/analysis.rs table values) + L3 T28-prep writer (WRITE ONLY evidence/containment-decision.md NEW; alternatives + JEV-pending markers, NO JEV calls, NO normative edits) + L1 T09-Rust writer (effects/ir/js/artifact.rs + contracts/artifact.ts + tests/codegen.rs; emission per frozen T09-TS interface). Zero writers running otherwise. Queued: T05 (after green table), T10, T30, T14a, T13b, T31a/T32a/T33-prep.
