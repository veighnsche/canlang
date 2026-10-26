# CanLang work inventory

Use the [implementation task](IMPLEMENTATION-TASK.md) for the dependency-ordered
checklist and completion criteria. Zero native diagnostics is its primary objective.

Inventory baseline: 25 October 2026 at main `a0918b49`, with draft submodule `5749c75b` initialized. That baseline did not build: selected Rust and TypeScript additions landed in the wrong locations, while local tests had covered the working tree. **Z00 repairs all six misplaced files and formats the existing integration change (`73094a16`).** The exact corrected source was verified in an isolated checkout: all 26 package build tasks, all 40 workspace typecheck tasks, 75 compiler integrations, the real helper permission/replay integration, Clippy and both test-policy gates pass. Z01 now confirms the same 18-diagnostic result on repaired commit `73094a16`; final CI remains pending. This inventory separates delivered changes, current failures, unfinished local implementation, broader product requirements and optional proposals. The older roadmap contains overlapping IDs and completed subparts; its rows are not an additive count of defects or an effort estimate.

The immediate objective remains zero native diagnostics for the original 24-source composition, preserving permissions, original source correspondence, evaluation order, atomicity and replay. Achieving that compile result will not by itself qualify every application or make every roadmap feature release-ready.

## Current position

| Area | Verified position | Remaining work |
| --- | --- | --- |
| Original native composition | Feature source committed as `18cd1d34`: 15 E6008 diagnostics, zero analysis errors, 26 unchanged source records, zero omissions, exit 10, 770.65 seconds. Review_swap clears; the strict new outer-DATA phase check exposes reconcile. Original hold/day-hold/day-move refusals remain cleared. | Finish the refusals listed below; produce the complete native artifact and qualify affected runtime workflows. |
| Main | Z00 restores the intended created-version implementation in all six misplaced files; the repair uses the exact source validated in isolation. | Obtain current CI and original-corpus results; preserve unfinished WIP outside the repair. |
| Focused verification | Against the working tree, 68 native receipt compiler integrations and seven query producer integrations pass. Nullable helper production integration passes all 11 modes and existing cases. Created-version cases cover CREATE, optional SET, replay, conflicts and forged/missing observations. Clippy and both test-policy gates pass at their recorded working checkpoints. | The isolated Z00 repair separately passes these focused integrations and workspace checks. Full compiler, browser, installed-package and original application coverage remain distinct checks. |
| Latest inspected CI | [Commit `d0248133`](https://github.com/veighnsche/canlang/actions/runs/40240156644): browser/security passed; compiler and workspace failed. Compiler exposes four original Chat closures. Workspace exposes three runtime timeouts, two Invoice native created-root registrations and an obsolete-or-regressed event-SEND refusal expectation. | Obtain all three completed green jobs on final source; running jobs do not prove success. |
| Earlier CI | At `14d92c78`, browser/security passed; compiler/editor and workspace/installed-artifacts failed. | Diagnose the earlier test failure after the current build blockers; inspect any separate workspace failure once builds are repaired. |
| Release | [Linux x86-64 v0.1.2](https://github.com/veighnsche/canlang/releases/tag/v0.1.2) exists, targeting `8301d40f`. | Changes after that release are not in the published archive. Qualify final Linux artifacts when a new release is wanted. Mac release remains deferred by user instruction. |
| Local work | Seven tracked code files in the normal worktree retain the unfinished Refer aggregate packet. The returned-primary COUNT and required-reference loop-parent mechanisms are now qualified. Isolated account-body and private-cohort extensions remain unfinished. Z03's WHERE/SELECT binding implementation is committed as `ac5fe4d6`; original day-hold/day-move now lower through the shared Values-plus-COUNT mechanism. Original runtime qualification and account/cohort work continue. | Keep unfinished aggregate and isolated extensions separate from qualified commits without losing another packet's work. No temporary receipt tracing remains in source. |

The current native count comes from `/tmp/canlang-combined-final-native.json`; the preceding 15-diagnostic Values/COUNT capture is `/tmp/canlang-values-count-original24.json`. This is a diagnostic capture, not a successful full-corpus artifact. Temporary logs are useful local evidence, not retained release assets.

## Work already delivered

These changes should be reused rather than restarted. Completion applies to the named scope and its recorded consumers.

| Delivered work | Result or reference |
| --- | --- |
| Draft recovery and source cleanup | Draft submodule is initialized. The CanLeave fixture/enum ambiguity is repaired; complete original analysis is clean. |
| Grammar, editor and developer tooling corrections | Earlier audit packets align the selected grammar surface, repair editor framing/cleanup and correct developer commands. Broader authoring qualification remains separate. |
| Generation replay and lifecycle | Persisted launch claims, honest incomplete/unknown outcomes, final preview cancellation and fixture custody repairs are completed in the audit checklist. |
| Shared receipt/profile workflows | Original/renamed account reference-array workflows, source-decision domains and related permission/replay consumers are qualified. Persisted Work decoding uses a shared lifecycle projection; its completed consolidation removed 74 production lines without splitting files. |
| Staged Mail migration | Shared staged-decision handling replaces the earlier Mail-specific path at its qualified scope; persisted decoding and claim-time validation retain their distinct responsibilities. |
| Typed Event SEND | Declaration-owned typed Event slots preserve capture and dispatch authority (`4841f6dc`). |
| Query Values and loops | Shared staged mutation prefixes, ordered item history, exact query Values maps/enum captures and private repeated-query item phases are committed (`d4d3b757`, `f02c0a32`, `5c03e73a`, `286a6271`). They are prerequisites, not proof that Refer.settle works. |
| Helper CONTROL/DATA | Genuine matching DATA witnesses support scalar and nullable scalar helper CONTROL reads (`b039551a`, `048e46f2`). The original move_membership refusal is gone in the complete capture. |
| Created Model metadata | Exact created-parent count provenance is committed (`14d92c78`). State-owned staged version reads pass isolated runtime integration; Z00 restores the intended implementation after the incorrectly assembled `a0918b49` commit. Both Booking holds pass version analysis; the exact returned-primary COUNT work now removes original hold's compiler refusal. hold_days and the original hold runtime qualification remain open. |
| Selected runtime and provider journeys | Setup recovery, retained due/cohort D1 execution, generated auth/team delivery, browser refresh and the selected Creative inspect/validate/publish journey are completed at the scopes in the audit checklist. They do not establish complete applications or all live provider profiles. |
| Migration foundation | Migration contract and bounded unique-claim exchanges are completed; installed migration binding/custody and full activation remain open. |
| Linux delivery and cleanup | v0.1.2 Linux release is published. Confirmed inactive CanLang build trees reclaimed 18.9 GB while preserving source, active builds and retained artifacts. |

Detailed earlier completion evidence remains in [the audit checklist](../ideal-filetree-plan/tasks.md), especially its completed packets. Historical diagnostic tables there are superseded by the count above.

## Immediate native work

The latest complete original-corpus capture of the feature source committed as `8f8d01e0` has 17 diagnostics across 11 scenario entrypoints, 26 unchanged source records and no omissions (267.60 seconds). Original hold now lowers; its runtime qualification remains open. Some remaining diagnostics are consequences of unfinished child workflows, not independent implementations.

| Work | Current source | Diagnostics | Remaining mechanism and acceptance |
| --- | --- | ---: | --- |
| Refer settlement | CanRefer:69, 72, 79, 80, 84 | 5 | Complete bounded Credit loop with repeated staged SUM queries, conditional Allocation CREATE and original Settlement return. Preserve actual order, parent/item identity, local query outcomes, DATA permissions, finite budgets and replay witnesses. Then qualify the original settle workflow. |
| Membership day movement | CanRent:531 | 1 | Compose the genuine leading Movement ANY with Values-query influence census. Preserve all original ANY dependencies; admitting Values alone is insufficient. Then qualify later body stages. |
| Arrival | CanRent:742 | 1 | Support the original is_open helper's dates/collection closure with exact nested query/capture authority. |
| Cancellation | CanRent:769 | 1 | Complete the original Movement query closure and ordered cancellation workflow, including its stored query after earlier writes. |
| Free fulfillment | CanRent:1030 | 1 | The original constructor census succeeds but its contained-query stored-schema join refuses, leaving no supplied query plan. Localize that schema failure before altering query classifications; preserve all guard, field and stage checks. Shared multi-guard publication is already qualified. |
| Account confirmation | CanRent:1041 | 1 | Establish the original finite mutation owner for the filtered BillingProfile domain and execute the complete body. |
| Parent check-in/cancel calls | CanRent:1748/1750 and 1756/1758 | 4 | Complete arrive/cancel_booking child receipts first, then original parent CALL closure, authority, ordering, rollback and replay. Two child-closure failures and two CALL failures are counted here. |
| Shift reconciliation | CanShift:188 | 1 | Review_swap now lowers and passes the real cohort runtime matrix. The newly checked native outer DATA phase refuses reconcile; join it to its genuine native receipt observations without dropping required loans or using raw getters. |
| **Total** | **24 original operands retained** | **15** | **Repeat the complete native compile after qualified changes; a changed refusal reason is not a completed workflow.** |

Original hold, hold_days and move_days now lower; their exact original runtime journeys remain open. Existing shared constructor/Values runtime cases already pass permission, stale/race, rollback and replay controls.

Source line numbers refer to the initialized draft revision above. Current root attribution comes from the complete capture plus the actual prepared-source collector run; later stages may expose additional unsupported behavior.

The shared Model-cohort and selected-profile reference/version mechanisms now pass their complete existing runtime recipients, including real D1 races, current permissions, strict hidden-row denial, source tampering and replay. The combined implementation passes 99 existing Rust integrations, Clippy and all 40 workspace typechecks. Its completed full original24 capture retains 15 diagnostics because the cleared review_swap is replaced by the explicit reconcile outer-DATA refusal; no net diagnostic reduction is claimed. Original account confirmation now reaches the analysis resource bound, which must be solved through shared proof reuse without increasing the cap. The original hold intake also exposed and repaired a generated multi-hop hook lexical redeclaration; actual hold execution awaits its refreshed artifact.

### Implementation packet status

1. **WHERE binder correspondence — implemented and qualified.** Commit `ac5fe4d6` compares the WHERE binder with fresh IR and gives WHERE/SELECT their separate JavaScript scopes. Existing integrations qualify granted WHERE/order, unreadable filters, withheld SELECT fields and filtered-empty results; all 75 compiler integrations and Clippy pass. The complete original capture still has 18 diagnostics with identical source/diagnostic arrays, so the original day workflows remain unfinished. Separate ANY-plus-Values composition is not implemented.
2. **Constructor COUNT publication — shared mechanism qualified.** `802d8fd4` publishes independently sealed constructor COUNT plans ahead of the old mixed-plan restriction and registers those same sources in the emitter, preserving overall bounds and original guard census. Existing compiler integrations and the real single/many-guard State permission/race/replay matrix pass. The complete original capture still has 18 diagnostics, 26 identical sources and no omissions in 314.19 seconds: fulfill_free advances beyond the first-query refusal but retains a complete source-guard blocker. Exact returned-primary Model support is being qualified separately; it is not delivered by this change. Exact returned-primary Model support is now also qualified with the original whole-body and return-influence proofs, auxiliary COUNT schema/field/stage checks and separate result policy. All 84 focused Rust integrations and the actual returned-Model permission/race/replay recipient pass. This still does not qualify original hold/hold_days.
3. **Refer aggregate loop.** Local contracts and State parsers add query occurrences, created-parent identity, aggregate census and complete ordered-selection witnesses. Compiler work adds explicit parent scope and initial source-loop/LET/conditional-CREATE facts. The latest Rust additions are uncompiled. New created/global aggregate Consumer paths still refuse; execution, occurrence minting, DATA association and replay are incomplete. A source-mapped State no-emit check passed for an earlier protocol slice; no new production runtime outputs were emitted. This packet is not ready to commit or publish.

The Refer packet still needs this dependency order:

- Finish exact original loop/body and Model-result analysis, then compile it.
- Independently join fresh source facts to native Consumer/transport and actual QueryValue descriptors.
- Reuse State's final staged view under the genuine active-item lease; authenticate the created Settlement and selected Credit filter.
- Mint private query/DATA occurrence identity, retain empty selection and all repeated occurrences, and associate exact conditional CREATE stamps.
- Replay historical observations under current grants without re-SUMming postcommit Allocation domains or treating per-item empty/nonempty as a global return answer.
- Exercise a genuine native Model workflow: positive, empty, replay, hidden/withheld DATA, Identity changes, forged/omitted occurrence, wrong parent/item, stale phase, budget exhaustion and late rollback; then the original Refer operation and full corpus.

## CI and verification work

- **Z00 repaired the actual main snapshot.** Baseline CI failed on `compiler/src/codegen/js.rs:9532` because a new match arm landed inside an unrelated tuple, and on `packages/contracts/src/state.ts:336–337` because a new intrinsic union arm landed outside its type. There is also a Rust formatting difference in `native_first_count_pair.rs`. All selectively assembled changes were reviewed, all six malformed files corrected, and the exact repair verified in an isolated checkout. The qualified WHERE packet is committed; unfinished COUNT and aggregate packets remain separate. [Compiler failure](https://github.com/veighnsche/canlang/actions/runs/40234228234/job/121294302415), [workspace failure](https://github.com/veighnsche/canlang/actions/runs/40234228234/job/121294302269).
- **Z02 resolved the observed compiler CI test failure.** At `14d92c78`, `native_scenario_receipts::opt_in_native_capture_retains_selected_paths_replays_and_current_state_projection` failed at `compiler/tests/native_scenario_receipts.rs:839` with `whole unsupported recipe omitted: absent`. The nullable-access expectation was obsolete. Its replacement asserts exact absent/present receipt paths and adds real permission, stale-reference, update-race, replay and lifetime controls. All five existing native receipt integration tests pass; the other five unsupported recipe cases remain refused. [Failed job](https://github.com/veighnsche/canlang/actions/runs/40230805281/job/121283840126).
- **Complete all three jobs at the final commit.** Compiler/editor must reach dev-server, grammar and actual LSP checks; workspace must finish runtime suites and installed declarations/Worker/minimum-Node checks; browser/security must pass for that same source. The earlier browser pass does not certify newer main.
- **Qualify current WIP before publication.** Separate incomplete aggregate work from small independently testable fixes so an uncompiled intermediate change does not prevent their verification. Preserve all existing changes while doing so.
- **Obtain zero native diagnostics and a complete artifact.** Keep all original operands, saved contributions and owning catalog. Run the affected original runtime journeys; focused substitute fixtures alone do not close this requirement.
- **Resolve the current Creative workspace refusal.** The repaired `73094a16` CI run reaches the original CanCreative graph review/publication integration, then native compile refuses the first nullable stored-delivery selector in the publish guard (`revision.validation?.status`). This is separate from the 18 original24 diagnostics. The bounded selector fix now passes the unchanged original SQLite/R2/Work journey, denied role/owner, pending/invalid outcomes, replay/current-authority revocation and a new status-only grant that refuses result DATA without writes. All five existing native receipt integrations pass; the combined COUNT/Creative compiler passes all-target Clippy. Original guards and runtime permission checks remain intact. Final GitHub CI remains unqualified.
- **Remeasure genuine failures/timeouts where still present.** Historical root typecheck errors, model-policy failures, due fixture grant refusals and the working-app duplicate Alias.delete form are earlier observations, not proven current failures. Reproduce each before changing code or carrying it as an active defect. An earlier CI workspace typecheck passed; do not continue reporting historical errors as current facts.
- **Keep CI strict and representative.** Preserve source membership, permission negatives, current producer/catalog prerequisites and installed artifact checks. Avoid hidden skips or treating analysis-only success as native success.

## Structural simplification still required

The shared mechanisms delivered so far have not completed the architectural simplification. Current oversized modules still combine substantial responsibilities: scenario disclosure analysis (about 36.6k lines), receipt code generation (24.2k), JavaScript emission (24.4k), IR (25.9k), State receipt execution (13.1k) and Cloudflare invocation (27.2k). Counts include current local work and are indicators, not acceptance criteria.

- Consolidate remaining repeated query/capture, constructor count, created-parent, loop, helper and return handling into shared mechanisms with original source proof and explicit authority.
- Share recurring profile decoding, validation, runtime observation and replay checks where the same contract actually applies. Preserve distinctions such as private CONTROL versus DATA and planner projection versus dispatch-time full validation.
- Retire superseded application-specific and narrow shape paths only when all actual callers use the shared mechanism and relevant refusal/error-order behavior is preserved.
- Reconstruct the historical complexity residual against current source before dispatching its remaining work. The older 221-identity figure is a historical scope, not a newly measured current total.
- Split a cohesive owner only when its interface stays small and the change reduces dependency and branching complexity. Moving lines between files is not completion.

## Broader required product work

These streams remain in the broader roadmap. They contain overlapping requirements and some completed subparts. They require consumer-level revalidation before selecting a new repair; the immediate compiler count does not prove or disprove their complete product behavior.

| Stream | Remaining outcome | Existing roadmap references |
| --- | --- | --- |
| Language and source semantics | Residual original query/helper/hook/call/dispatch, imported lifetime and context graphs; source-derived UI collection/control behavior; locale/timezone and typed outbound sinks. Reuse qualified original workflows. | CAN18 outcomes 3–13; C02–C19 |
| State and Identity | Remaining conditional transaction participants, model-rule/hook/lock/invariant/reverse/delete graphs, current-authority disclosure and cross-store limits. | SEQ-005/010/011; FP.IDENTITY-CONTRACT |
| Invocation values and examples | Protected Workbench/Task/publication invocation consumers, genuine File/provider/delivery fixtures and original table/sequence expectations. | FP.INVOCATION; SEQ-039; challenge T22/T23; LG02 |
| Browser and preferences | Remaining catalog-wide forms/navigation/polling, self/owner/app/team preferences, dependent CountryRegion/Approve/Rent forms and concrete approval journeys. | FP.BROWSER/PREFERENCES; SEQ-037/038 |
| Retained Work | Real bundled receipt observer route; durable progress/notifications; configured target availability and terminal dispatch; remaining full fanout/cohort/schedule matrix. | challenge T25/T26/T34; FP.DISPATCH-AVAILABILITY; SEQ-048 |
| Files and resource lifetime | Multiple-owner separate-store publication, authenticated receiving File causality, quota/override producers, protected provenance, expiry and sensitive-copy disposal. | TECH-F01/F02; FP.FILES-DURABLE/LIFETIME; SEQ-024 |
| Import, export and documents | Original source-derived CSV import/replay, compiled mounted File/browser export and Print consumer, immutable issued/receipt PDF snapshots and downloads. Reuse the accepted durable export backend. | FP.CSV/EXPORT/AW-REPLAY-IMPORT/AW-DOCUMENTS; DEL-B02 |
| Production AI and accounting | Actual text/media/structured profiles; current attempt stop/reconcile/deadline; atomic Chat/Knowledge reservations; once-only settlement, late usage and release; typed Judgment and corpus retrieval authority. | SEQ-021/022/042/043/046/047; FP.CORPUS |
| Recovery protocol | One actual reversible definite-success effect with its own uncertainty/reconciliation lifecycle. | SEQ-045 |
| Provider applications | Mailbox/MIME/reply/reconcile, verified Payments events/reconciliation, authenticated source mappings/connectors and HR/onboarding/course-progress handoff. | FP.AW-MAILBOX/PAYMENTS/SOURCE-CONNECTOR/ONBOARD-HANDOFF |
| Operational services | Configured trusted maintenance, provisioned Ping health ingress, safe Alerts, minimized authenticated Errors intake, consent/session tracking and finite historical reporting. | FP.MAINTENANCE/PING/ALERTS/INSTRUMENTATION/TRACKER/REPORTS |
| Native preparation | Replace the completed-TypeScript-bundle input with native-owned construction and consumed final output; qualify the final executable and package. | ports P04–P09; C04.preparation-join/native-release |
| Native Values/validation/Work | Remaining carrier/error/order profiles, native demand/predicate/codec/lifetime joins, actual State/MCP callers and durable F5/F7 Work consumers; final Wasm/glue/vendor inventory, explicit selection/disposal and whole-call resource decisions. | ports A07–A10/V03–V11/W02–W08; C04/C05 |
| Development loop | Stable session origin, coalesced save checks, authenticated draft-safe reload, conservative change classification, CSS and bounded region updates. Existing invariant producer-bundle reuse is completed; further reuse needs an observed remaining cost. | dev-server T18–T30 |
| Draft frontends and generation | Selected composed-app admission/watch, exact resource closure, real supported model output, meaningful functional/visual/accessibility journeys and saved-output CI. Historical 108 references/828 discovered cases need current selection reconciliation; discovery is not passing acceptance. | DFE-01–07; BGI-06/13; FP.QUALIFY |
| Full application qualification | Complete each original application's required actor/policy/provider/File/unknown/stale/rollback/replay/recovery matrix. Selected Customer, Purchase, Rent and Creative successes remain bounded reusable results. | FP.QUALIFY; SEQ-025/026/040 |
| Installed release | Consume the final changed producer/binary/vendor/editor/runtime assets, cold-install outside the checkout and qualify actual Linux CLI/Worker/browser tooling. Current v0.1.2 publication does not contain later fixes. | FP.INSTALLED-RELEASE; C04.complete |
| Upgrade and migration | Immutable predecessor/desired/code/policy/release binding, protected-value coverage, physical owner inventory, custody/fencing, persisted coordinator, pending-work compatibility and interrupted activation/recovery. Reuse the existing engine and unique-claim fix. | MIG-CONTRACT implementation; FP.UPGRADE-JOIN; SEQ-027 |
| Source and legacy closure | Remaining actual-diff draft migration acceptance, exact retained-viewer cleanup, demonstrated array-requiredness/description discrepancies and recorded business ambiguities. | muse-migration C01/C02; FP.DOC-REQUIREDNESS/APP-ADJUDICATION |
| Full product acceptance | Required original workflows through the supported installed release with truthful provider support, upgrade and recovery. This consumes the streams above rather than adding another implementation of them. | FP.FULL; SEQ-060–063 |

The complete existing requirement-row cross-reference follows below so narrower feature leaves remain discoverable. Its source is the [broader roadmap](REMAINING-WORK.md#dependency-ready-work-and-engineering-dependencies), not a new claim that every older allegation remains reproducible.

## External inputs and decisions

- Real provider/model/account/tokenizer/usage/cancellation/reconciliation profiles hold only their matching production consumer. Local source, adapter and controlled integration work can continue independently.
- Supported authenticated generation tools and model/host/MCP capabilities are required for actual generator qualification and corresponding draft output. Do not substitute handcrafted output for a generation result.
- The original model benchmark, recipient-specific BDD3 and OUTBOX target/binding releases retain their own exact inputs; they do not block unrelated compiler repairs.
- Native default adoption, physical TypeScript retirement and live activation/deployment retain their separate owner decisions. Local implementation, packaging and rollback verification are not automatically blocked by them.
- Mac release is deferred explicitly. Linux qualification does not imply Mac qualification.

## Optional work outside the immediate required sequence

New scheduler work, multisession resume, new calendar/default/statechart/package-parameter syntax, additional Rust ports/common ICU parser, optional dependency/history semantics, research portfolios and extra ranking/cache optimizations remain conditional proposals. Each needs its recorded real consumer, counterexample or measured benefit. They should not expand the zero-diagnostic task automatically.

## Recommended execution order

1. Repair the malformed main commit, preserving the tested implementation and all unrelated WIP. Validate the exact committed snapshot and resolve the observed CI failures.
2. Preserve and separate the three unfinished packets; establish a coherent buildable checkpoint for each.
3. Qualify the small WHERE and many-guard COUNT fixes, then unify exact returned-primary constructor counts and ANY-plus-Values composition.
4. Complete the native Refer aggregate loop and its permission/replay/rollback integration.
5. Finish remaining arrival/cancellation/account/Shift workflows and dependent parent calls; use complete captures to establish the actual new count and all three green CI jobs.
6. Qualify original affected runtime journeys and the current Linux installed artifacts/demo.
7. Take the broader product streams by concrete consumer dependency; continue architectural consolidation inside those changes without turning file moves or optional ports into prerequisites.

No completion percentage or delivery estimate is justified by these diagnostic, scenario, task or line counts.

## Requirement cross reference

These are the existing roadmap rows, grouped under the consolidated inventory above. Overlapping IDs refer to shared work and must not be counted twice. “Roadmap residual” identifies a remaining requirement to reconcile, not a freshly reproduced defect.

### Source, canonical execution and presentation references

| Existing requirement | Recorded outcome or residual | Current disposition |
| --- | --- | --- |
| CAN18 outcomes3/4/8/13; challenge:T08; C02/C03/C19 | Resolve original event alpha-renaming, Member collection-call and Shift Boolean-observer disagreements; qualify same-grant selector/permission correspondence. | Roadmap residual; revalidate completed subparts before implementation. |
| CAN18 outcome5; C02/C04/C19 | Complete original query/helper/body closures, including Customer accept, stored ANY+first and remaining original derived/public/periodic consumers. | Roadmap residual; revalidate completed subparts before implementation. |
| CAN18 outcome12; C07; challenge:T31 | Fix the original retirement-hook compilation refusal and remaining staged/context/helper graphs, including newly staged Cancellation references. | Roadmap residual; revalidate completed subparts before implementation. |
| CAN18 outcomes9/11; C06/C18/C19 | Finish Invoice result/collected/refunded/checkout_cancelled/reconciled triggers and the seven recorded original parent calls. | Roadmap residual; revalidate completed subparts before implementation. |
| CAN18 outcome10; C02/C04; challenge:T24/T32 | Complete original Maintain retry/replay and remaining SEND guard/Rule/IR correspondence. | Roadmap residual; revalidate completed subparts before implementation. |
| CAN18 outcome6; C10/C11 | Complete remaining original value/result-array pages, stats/history/skeleton/container behavior, copy-label/false-step findings and operation-bound forms. | Roadmap residual; revalidate completed subparts before implementation. |
| CAN18 outcome7; C10/C17; S9-Q01/SEM-R05 | Finish original formatted business statements/call arguments and canonical Alert sink identity at the used locale/timezone profiles. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.COMPILED-DECIMAL; challenge:T15 | Closed: exact decimal expression lowering already has accepted source-generated consumer evidence. | Completed at exact-expression scope; reuse existing evidence. |
| SEQ-005; challenge:T04/T15/T16/T18 | Close only the still-used source/context/rule/saved-influence/opaque File/corpus descriptor and generated-default contract boundaries. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-010; FP.CONTEXT | Carry every actually used actor/team/clock/operation/locale/timezone/hook before-after/reserved-version/subject fact through its verified scope. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-011; challenge:T17/T18/T29/T31/T32 | Complete the original ordered rule/hook/lock/invariant/reverse/nested/delete graph and imported lifetime/parent joins. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.IDENTITY-CONTRACT / FP.IDENTITY | Finish the remaining typed J2/conditional identity lifecycle and durable proof at its original scope. | Roadmap residual; revalidate completed subparts before implementation. |
| challenge:T22/T23; LG02 | Finish rich compiled examples: genuine finalized-file/provider/delivery fixtures and original table/sequence execution. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.INVOCATION; SEQ-039 | Finish original Workbench context/approval, Task.update/complete, publication and transcript/ANY/call consumers. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.POLICY-REVIEW | Qualify staff-facing business review derived from checked owner facts. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.DOC-REQUIREDNESS | Resolve the recorded ordinary-array versus required-array creation-reference discrepancy if still demonstrated. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.PREFERENCES | Qualify remaining self/owner/app/team reference preference/default/reset/conflict/cancel/bound-tab profiles. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.BROWSER; challenge:T19/T20 | Complete remaining installed catalog-wide DOM/form/navigation/polling lifecycle qualification. | Roadmap residual; revalidate completed subparts before implementation. |

### Durable work, receiving resources and application services references

| Existing requirement | Recorded outcome or residual | Current disposition |
| --- | --- | --- |
| challenge:T25; D3B Q4-C | Qualify the real bundled selected-receipt observer route without test injection. | Roadmap residual; revalidate completed subparts before implementation. |
| challenge:T26 | Complete durable observable relation/progress/notification consumers. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.DISPATCH-AVAILABILITY | Finish actual deployment target/capability availability and durable terminal dispatch mapping. | Roadmap residual; revalidate completed subparts before implementation. |
| TECH-F01; FP.FILES-DURABLE | Finish original multiple-owner separate-store file publication serialization and interruption/reopen. | Roadmap residual; revalidate completed subparts before implementation. |
| TECH-F02; SEQ-024; challenge:T27 | Finish authenticated receiving-file request/source/revision and once/replay/lifetime joins, including required image outputs. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.LIFETIME | Implement and qualify remaining owner expiry/sensitive-copy disposal. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.CSV / FP.AW-REPLAY-IMPORT | Finish original source-derived import operation/current File/reference and replay qualification. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.EXPORT; DEL-B02 | Finish the original compiled mounted File/browser export/Print consumer; durable descriptor/status/download/expiry backend is accepted. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-021; FP.SERVICE-CATALOG | Finish original production text/media profiles and declared structured runtime-AI capability consumers. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-022 | Finish current-guarded provider attempt stop/reconcile/deadline behavior. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-042 | Finish original same-owner Chat/Knowledge admission, reservation and outbox atomicity. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-043 | Finish associated exactly-once settlement and late usage/release. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-045 | Select and finish one original genuinely reversible definite-success domain effect. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.AW-JUDGMENT; SEQ-046 | Finish original Knowledge/Triage Judgment producer and remaining domain workflow. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.CORPUS; SEQ-047 | Finish Handbook/model-bound corpus retrieval, index and all-supplied-context authority. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.MAILBOX / FP.AW-MAILBOX | Finish MailboxV1 owning catalog/coordinator and authenticated installed MIME receiving/reply/reconcile. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.AW-PAYMENTS | Finish verified payment account/provider event and original financial reconciliation. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.AW-DOCUMENTS | Finish immutable issued/receipt snapshot PDF and receiving-file download. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.SOURCE-MAPPINGS / FP.AW-SOURCE-CONNECTOR | Finish configured source namespaces, cross-app cause/outcome binding and original outward source/read/conditional-write adapters. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.AW-ONBOARD-HANDOFF | Finish verified HR→onboard and delegated course-progress handoff. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.MAINTENANCE | Finish configured trusted maintenance through canonical owner admission. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.PING | Finish provisioned heartbeat ingress and health lifecycle. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.ALERTS | Finish safe installed AlertsV1 adapter. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.INSTRUMENTATION | Finish configured authenticated ErrorsV1 intake for minimized browser capture. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.TRACKER | Finish consent/session tracker SDK and canonical Analytics intake. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.REPORTS | Finish source-derived finite reporting and required historical facts. | Roadmap residual; revalidate completed subparts before implementation. |
| challenge:T34; SEQ-048; F8 M1–M10 | Finish original complete fanout/cohort/schedule durable matrix. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-037 | Finish original CountryRegion/Approve/Rent dependent-form vertical joins. | Roadmap residual; revalidate completed subparts before implementation. |
| SEQ-038 | Finish original ExpenseReview and CreativeRevisionReview workflow/page joins. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.APP-ADJUDICATION; challenge:T36; migration A03 remainder | Resolve only the recorded original business/source ambiguities before correction. | Roadmap residual; revalidate completed subparts before implementation. |

### Rust responsibility completion and delivery references

| Existing requirement | Recorded outcome or residual | Current disposition |
| --- | --- | --- |
| ports:P04–P08 / C04.preparation-join | Replace finished-TS-bundle handoff with native-owned final construction/output consumption. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:P09 / C04.native-release | Qualify the changed final constructor executable and claimed installed hosts. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:A07–A09; remaining A01/A02 clauses | Finish only remaining exact carrier/error/evaluation/identity and actual package/stdlib/generated consumer qualification. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:V03–V07 | Finish outstanding selected validation policy/host-predicate/codec/retained-result/lifetime behavior. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:V06/V08/V09 / C04.validation-join; TECH-V03 | Finish production selection, State admission/read and ordinary MCP native consumers. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:W02–W06 | Join full-family native Work calculations to actual F5/F7 durable consumers. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:C04.values-assets / C04.work-assets; A08/W05 | Qualify final full-family binary/glue/vendor/import/inventory delivery. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:A10/V11/W07–W08/P10 / C05.complete | Finish original whole-call/resource comparisons and budget/reuse decisions. | Roadmap residual; revalidate completed subparts before implementation. |
| ports:A10.2/V11.2/W08.2/P10.2 | Finish remaining packaged explicit selection/disposal/persisted-byte/rollback scope. | Roadmap residual; revalidate completed subparts before implementation. |

### Development and deferred complexity references

| Existing requirement | Recorded outcome or residual | Current disposition |
| --- | --- | --- |
| dev-server:T18–T21; T30 consumer | Finish stable-origin generation routing, coalesced saves and authenticated draft-safe reload. | Roadmap residual; revalidate completed subparts before implementation. |
| dev-server:T22/T23; conditional T27–T29 | Resolve measured remaining producer/capture/compiler/resource reuse. | T22 invariant bundle reuse completed; remaining measured reuse only. |
| dev-server:T24–T26; T30 consumer | Finish checked change classification, CSS replacement and one bounded authorized region update. | Roadmap residual; revalidate completed subparts before implementation. |
| CAN-COMPLEXITY-SCOPE-003; Complexity:T00–T04 | Finish the221 deferred original complexity identities as one scoped outcome. | Roadmap residual; revalidate completed subparts before implementation. |

### Draft frontend and generation consumers references

| Existing requirement | Recorded outcome or residual | Current disposition |
| --- | --- | --- |
| DFE-01 | Finish selected requirements→journey/resource/closure mapping and only demonstrated source corrections. | Roadmap residual; revalidate completed subparts before implementation. |
| DFE-02 | Finish selected-app/import-closure source generation and explicit authenticated preview/watch. | Roadmap residual; revalidate completed subparts before implementation. |
| DFE-03 | Finish actual declared app resource/profile joins. | Roadmap residual; revalidate completed subparts before implementation. |
| DFE-04 | Qualify real model-generation provenance and complete candidate acceptance for each draft category. | Roadmap residual; revalidate completed subparts before implementation. |
| DFE-06 | Finish actual desktop/mobile route/state/locale/theme capture and functional UX acceptance. | Roadmap residual; revalidate completed subparts before implementation. |
| DFE-07 | Finish source-derived all-app saved-output CI/regression coverage. | Roadmap residual; revalidate completed subparts before implementation. |
| BGI-06 | Qualify remaining required Muse Code/Claude Code/OpenCode generation adapters and host submission. | Roadmap residual; revalidate completed subparts before implementation. |
| BGI-13 | Complete the recorded agent-only Todo observation. | Roadmap residual; revalidate completed subparts before implementation. |

### Composition, release and residual closure references

| Existing requirement | Recorded outcome or residual | Current disposition |
| --- | --- | --- |
| CAN18 outcome14; challenge:T41 current corpus component | Produce the missing post-release original24 composition result and truthful root attribution. | Current capture completed: 18 diagnostics; native repairs remain open. |
| FP.QUALIFY; challenge:T37–T40/G3/G4; SEQ-025/026/040; DFE-05 | Finish full original app/companion required workflow matrices once each. | Roadmap residual; revalidate completed subparts before implementation. |
| FP.INSTALLED-RELEASE; ports:C04.complete | Finish changed final source/producer/dependency/browser/vendor/native full installed release closure. | v0.1.2 Linux published; final changed release qualification remains. |
| FP.UPGRADE-JOIN; SEQ-027; CAN18 outcome15/C21/S9-Q08 | Finish original predecessor→desired schema/default/lock/retained-work staged upgrade and recovery. | Contract/unique-claim fix completed; installed binding/custody/activation remains. |
| FP.FULL; challenge:G1/G2/G5/R01; ports:A11/V12/W08.3/P11/C01–C05.complete; SEQ-060–063 | Deliver the required original application workflows through the supported installed release, with safe upgrades and recovery. | Roadmap residual; revalidate completed subparts before implementation. |
| muse-migration:C01/C02 | Finish finite legacy draft/desired-output migration acceptance and final owned closure. | Roadmap residual; revalidate completed subparts before implementation. |
