# Remaining CanLang work

## Current consolidated list — 18 October 2026

**77 canonical outcomes reviewed; 76 remain open.** The second source-grounded pass found that FP.COMPILED-DECIMAL's exact expression-lowering scope was already accepted; its row is retained as closed traceability, not a new job. Canonical IDs are retained; multiple IDs on one row name the same shared output or its consumers, not extra assignments. **Nine proposed/conditional groups** and **five actual human/external gate groups** follow separately. No completion percentage is derived from historical task counts.

Reconciled against main476347fdd and the four final owning handoffs. All four efforts are stopped, their released work is committed/pushed, their supervision is retired, and secondary task worktrees/branches are removed. This documentation reconciliation starts no implementation worker, application/model generation, automation or test programme. “Ready” below means dependency-ready if later work is requested.

**Execution preparation at `104d87b63`, 18 October:** **50** outcomes have a
directly actionable next bounded unit (**D**), **22** consume a specific missing
engineering output (**E**), **4** first need a named decision or external input
(**B**), and **1** is already satisfied (**C**). These mutually exclusive labels
describe the **next unit**, not full-parent completion or current authorization.
Later provider/host/publication leaves still apply to matching consumers; the five
shared gate groups are not counted again. No implementation, builds or runtime tests ran.

The next-unit column adds the starting point and order that the original contract
columns lacked. A large row is a parent: perform its stated first unit, release the
concrete output, then its next listed consumer. Do not dispatch the entire parent
as one undifferentiated rewrite. Luna is suitable for a well-defined fixture,
extraction or released consumer recipe; use an experienced executor for compiler
authority, transactions, recovery and architecture decisions. Model suitability
is not an additional gate or a reason to invent certainty.

### Recommended priority for the next available work

**Repeated effort first: take dev-server:T22's invariant MCP/HTTP producer-bundle
reuse unit at the next safe owner boundary.** Current
[`bundle.ts`](../../packages/cloudflare/src/deploy/bundle.ts) calls
`buildMcpBundle` and `buildHttpOperationsBundle` for every portable build. Their
producer entries do not depend on the changing Can artifact, yet each invokes
`runBrowserBundle` → a separate `node --eval ESBUILD_DRIVER`/esbuild build. Native
Dev's `bundle.build` reaches those calls through
[`buildOwnedDeployBundleWithAssets`](../../packages/cloudflare/src/deploy/owned-bundle.ts)
and its fresh one-build child. The [retained phase observation](../specification/DECISIONS.md#2026-10-18--reduce-repeated-local-dev-capture-work)
puts **total portable bundling near two seconds per check** on its historical
TypeScript tuple. Current source proves the repeated producer work remains; that
aggregate timing does not prove the pair's current cost or promise two seconds saved.
This is the first concrete repeated-work reduction supported by the current
findings, ahead of fresh corpus capture and feature work. The broader objective is
less repeated build/test/setup/capture/integration and manual work; it does not
limit future priority to build time alone.

**The finite T22 unit:** use the accepted T16 owned-build boundary and T17 evidence;
retain only completed, validated MCP/HTTP producer bytes under an exact consumed
source/resolution/tool/options identity, with bounded owner lifetime and cleanup.
Reuse must cross the fresh child boundary: a module-local map inside
`owned-bundle-entry` would disappear after every build. Keep artifact-dependent
assembly, source-current admission, permissions, cancellation and publication
fresh. Reuse the existing process/ownership contract rather than introducing a
repository-wide cache service. Required controls are unchanged-producer hit,
changed dependency/resolution/tool/options miss, missing/corrupt/partial-output
refusal, cancellation and owned release, with actual output equivalence/loadability.
Extend the existing `bundle-execution`, `owned-bundle` and `bundle-entry-cleanup`
fixtures; refresh only the changed Cloudflare producer closure and run those
focused tests plus one existing real edit/build consumer. In that normal affected
comparison, count the avoided producer builds and record their elapsed cost once.
The **remaining uncertainty** is the current pair's share of a repeated bundle build
when its closure is unchanged. If it is immaterial or no meaningful reuse occurs,
record the existing T22 no-go and stop; do not start a benchmark project or broader cache.

The benefit is fewer repeated esbuild producer builds in `can dev check`/preview
and genuine portable-Worker integration consumers used by Dev, draft journeys and
State/Work/Files/Interfaces qualification. It applies only across builds sharing
the admitted producer closure and cache owner; cold one-off builds and changed
producer closures miss. It does **not** accelerate `cargo build`/`cargo test`,
TypeScript package emission, Can analysis/codegen, or browser reload itself. The
package/Turbo migration is already accepted; no remaining source-backed Cargo or
TypeScript-build speed repair has been identified in this pass. If those commands
are the user's dominant cost, the missing fact is their attributable repeated
phase/cache miss from an ordinary existing run, not another full build survey.

The order below selects among the existing next units; it adds no task IDs,
acceptance conditions or authorization. It applies to the next available owner,
not to a user's already-running local Muse unit. Preserve that writer and its
inputs through the coherent stop boundary. Do not freeze the live Muse
compiler/runtime closure for this prioritization. If a required closure is being
changed, take DFE-01's mapping or a disjoint ready unit below instead of interrupting
the writer or accepting an unstable capture. Cost descriptions are comparative
scope judgments, not delivery estimates. Retained timings keep their original
tuples; current savings remain hypotheses until the affected consumer demonstrates them.

| Priority | Existing bounded unit and stop boundary | Why this order; readiness, cost and risk |
| --- | --- | --- |
| 1 | **dev-server:T22:** reuse the two invariant MCP/HTTP producer bundles across owned build children, then one affected warm-build comparison or the existing evidence-based no-go. | The repeated Node/esbuild calls are present now, and retained total bundling cost supports trying this bounded reuse first. T16/T17 foundations exist; T18–T21 automatic/browser work is not required. A bounded producer-cache change has invalidation and cleanup risk but a smaller scope than native construction or compiler caching. Stop at real avoided producer work plus equivalent loadable output; current milliseconds saved and reuse frequency remain unmeasured. 2026-10-18: implemented — exact-key reuse (entry text plus metafile input-byte digests with nearest package.json, esbuild version/binary/options, driver template; at most one completed record per kind in the calling process; corrupt/missing inputs fall back to fresh builds). Real pair: ~220ms steady (~345ms cold), byte-identical, workerd-loadable; warm builds avoid 2 esbuild spawns. Fixtures bundle-execution/bundle-entry-cleanup/owned-bundle extended, 37 passing. Full-assembly proof remains blocked by the pre-existing values-bindings vendor sync gap (another lane's in-flight `vendor/values-bindings/` design; identical failures on base). |
| 2 | **CAN18 outcome14 / T41:** the one complete current original24 capture and root attribution. | Available recipe and released inputs; no new architecture. It supplies shared diagnosis for original source/CALL/hook/UI and qualification consumers, reducing repeated attribution. Requires a stable consumed closure and a current executable/catalog; refresh only stale producers. Stop at the recorded result, with no automatic repair sweep. |
| 3 | **CAN18 outcome5 / C02/C04/C19:** first reproduce positive stored ANY→first, then repair only its demonstrated owning mismatch and run the original affected consumer. Substitute the capture's other repeated source root if it has stronger actual consumer evidence. | Query/body outputs feed original invocation, conditional forms and application workflows; one owner repair can replace several downstream workarounds. Existing `scenario_receipts.rs`, `scenario_first_query_sources` and native consumers make the discriminator bounded. The complete repair may cross Compiler/State/runtime and is higher-risk than the probe. Release the exact query/context/child-plan output; do not wait for all compiler outcomes. |
| 4 | **DFE-01 → DFE-02:** map CanTable's original reservation/seating journey and exact closure, then supply checked selected-app identity/source membership and admit/watch that closure in native Dev. | The current [`admit_single_app_profile`](../../dev-server/src/compiler.rs) rejects `use` and anything other than one app; the selected-app compiler handoff is missing. This shared boundary can remove repeated per-app admission work for later composed drafts. Mapping is a small independent start; compiler/native membership and freshness are a larger, riskier join. Stop with one genuine selected composed app and invalidation/refusal controls. Do not merely remove the guard or claim all drafts work. |
| 5 | **Shared service foundations:** take challenge:T25 / D3B Q4-C's actual bundled receipt-read route first; then FP.SOURCE-MAPPINGS / FP.AW-SOURCE-CONNECTOR’s authenticated binding and TECH-F01 / FP.FILES-DURABLE separate-store publication for their first ready consumers. | Q4-C reuses Q1–Q3 and existing seeded tests, so it is a bounded route/packaging join with useful denial/stale controls. Binding and File outputs have broader receiving Files/Mailbox/Payments/Onboard consumers, but greater authority and atomicity risk. They are independent of the compiler capture and of each other except where a row names the consumed output. Release one route/binding/publication contract with its real consumer; do not implement all service families together. |
| 6 | **DFE-03/04 → FP.QUALIFY/DFE-05 → DFE-06/07:** finish the first ready app's resources, actual generation, meaningful functional/visual journey and saved-output CI. | This turns the earlier producer outputs into one reusable regression path and catches integration drift before repeating work across the corpus. It is a multi-owner integration unit, not a cheap screenshot job. Use the selected app's exact source/resource outputs; generation needs its real Sol/medium host, and live providers only where declared. If those are absent, move to the next ready unit rather than fabricating output or blocking unrelated work. Stop after one app and its no-model regression job. |
| 7 | **dev-server:T18 → T19 → T20 → T21:** stable protected origin, coalesced demand, authenticated generation delivery and one same-tab edit/error/recovery journey. | This can reduce repeated browser reopening, login/setup and manual check/reload actions during later frontend work. It is a moderate-to-large lifecycle/browser join with freshness and authority risks, not demonstrated compiler acceleration. Start on an already supported app; composed-app support is needed only for that consumer. Reuse accepted Rust/Ratatui/manual lifecycle behavior. These tools improve the loop independently; they are not prerequisites for ranks 1–6. |
| 8 | **ports:P04–P08**, then its **P09/C04.preparation-join** installed consumer; take an independently ready exact/validation/Work consumer in the same tier when its owner is free. | Native construction has an explicit remaining ownership gap: [`host.ts`](../../packages/cloudflare/src/preparation/host.ts) still calls `ensureBundle` at `LOAD_MODULES`, while the native protocol already accepts raw facts. Raw host facts → Rust output → publication is a larger integration change with ordering/cancellation risk. Finishing it removes that duplicate construction responsibility and releases the changed installed constructor; it does not yet prove a faster complete build. Avoid native work whose only justification is assumed speed. |
| 9 | **Other ready original consumers**, selected by their exact released input: remaining source/UI/Testkit leaves, receiving resources, reservation → settlement, configured admission → its Ping/maintenance consumer, mounted CSV/export, reports and remaining app journeys. | Follow the dependency streams below within this tier. Prefer the next consumer that exercises an already-released shared output, or a bounded independently reproduced defect, over starting another broad parent. Use the accepted export backend and closed component evidence. Cost and risk vary by selected consumer; provider/account or policy leaves hold only the matching branch. Changed installed/recovery qualification follows its actual released bytes; FP.FULL consumes results once at the end. |
| 10 | **Complexity:T00–T04**, FP.DOC-REQUIREDNESS, description:D08 and migration:C01/C02: one mapped residual/body, one reproduced reference mismatch, or one exact remaining handoff. | These are legitimate bounded maintenance/correctness units with lower demonstrated cross-task acceleration. They suit disjoint available ownership and need not wait for all higher rows. Recover the original residual correspondence before bulk complexity work; no broad refactor is a prerequisite to compiler/native delivery. Preserve any user's active unit. Close satisfied handoffs without runtime reruns; review actual unresolved diffs, not prior review verdicts. |

The existing CAN18 outcome10 / challenge:T24/T32 Maintain retry consumer has a
recorded timeout beyond 600 seconds. If that same case is repeatedly blocking the
next consumer, its already-scoped compiler/setup/admission/replay/Workerd phase
attribution moves into rank 3 alongside the source discriminator. Repair the
actual stalled or repeated stage and qualify that case; do not expand the timeout,
run a broad performance survey, or infer that every compiler check has that cost.

**Next build-speed candidates:** T23 visibly restages compiler/catalog/source
bytes in [`compile_inner`](../../dev-server/src/compiler.rs), but its remaining
staging cost is not isolated in retained evidence; basic no-op compiler-spawn
avoidance is already accepted in [`Loop::reuse_serving`](../../dev-server/src/owner.rs)
and the [unchanged-check decision](../specification/DECISIONS.md#2026-10-18--bound-unchanged-check-and-inventory-path-reuse).
After T22, advance only the specifically measured remaining T23 duplication ahead
of corpus/feature work, consuming T19's shared check admission where its contract
requires it. Compiler execution and Cargo compilation are different costs; staging
reuse claims neither. The native P04–P08 construction join still needs raw host
facts → Rust output → publication, with no demonstrated repeated-build saving, so
it retains its delivery priority. The installed 7.248-second startup observation
and browser continuity are not build-speed evidence. T24–T26 retain their own
T18/T20 dependencies; T27–T29 remain conditional on their recorded decision.

The next non-build unit is CAN18 outcome14 / T41's [current original24 capture](#next-original24-composition-capture--outcome14--t41),
whose last complete result predates accepted repairs. Its roughly ten-minute
historical scope buys shared attribution, not speed. Run it only at a coherent
producer boundary, stop after the complete result, then select the repeated actual
source root. A missing timing fact or cache no-go does not block independently
ready work, and no higher priority preempts the user's current coherent unit.

**Decision/input requests are early side work, not serial gates:** the Identity/State
participant decision, SEQ-045 reversible-effect choice, FP.APP-ADJUDICATION policy
questions and actual BGI-06 operator/tool inputs can be resolved while independent
ready work proceeds. No priority here selects their semantics or manufactures
credentials. A newly available exact output can move its consumer forward; a
named blocker moves only that consumer back. The ranking is deliberately revisable
after the first current capture or a completed unit, without reopening unchanged
accepted scope or requiring a new planning pass.

### Dependency streams within that priority

These are dependency streams, not additional tasks or a serial all-repository plan:

1. **Original source:** event/Member/Shift discriminators, positive ANY→first and
   retirement-hook repairs can begin at their real owners. Their exact query,
   context, child-plan and model-policy outputs release original invocation,
   forms, dependent-input and app consumers. Serialize overlapping compiler files;
   independent UI leaves, reference requiredness and Testkit fixtures need not wait.
2. **Durable services:** Q4-C bundled observation, dispatch availability,
   separate-store File serialization and the shared authenticated source binding
   have concrete local starts. Feed only the needed producer output to receiving
   Files/Mailbox/Payments/Onboard. Same-owner reservation precedes settlement;
   canonical configured admission precedes the matching Ping/maintenance consumer.
   Mounted CSV/export consumers reuse their already accepted backends now.
3. **Native ports:** raw preparation host → native constructed output → installed
   final constructor; exact/validation/Work consumer joins can proceed independently
   except at shared assembly/runtime files. Package a released owner output, then
   compare its complete call and qualify its rollback. Final C04/C05 aggregates
   never gate the producer they consume.
4. **Development:** T18 stable origin and T19 coalescing → T20 delivery → T21
   same-tab journey. T24 classification takes T18/T20 identity; CSS and one region
   class then proceed independently. T22/T23 measured reuse is a separate stream;
   T27–T29 stay conditional on their own measured decision.
5. **Drafts and release:** CanTable requirements → exact source closure → native
   preview/resources → genuine generation → functional/visual acceptance → first
   saved-output CI job. Repeat per app; CanPromptLab adds its generation categories.
   FP.QUALIFY consumes those same journeys. Final installed/upgrade/full release
   uses the matching changed artifacts and results, not another universal rerun.

Resolve the three decision-held outcomes early with their defining owners while
independent work continues: remaining Identity/State transaction participants;
SEQ045's concrete reversible effect/protocol; and the recorded original-app policy
discrepancies, especially Partner lock editing and Volunteer material changes.
Their existing contracts name the competing meanings; difficult selections use
the existing JEV procedure. This preparation does not select those semantics.
BGI06's fourth **B** row needs the actual authenticated tool/model/operator inputs.

### Focused validation entry points

Use the exact fixture named in the row/owning plan, after refreshing only its
changed producer closure. Future commands include
`cargo test --locked --manifest-path compiler/Cargo.toml --test <existing-target>`,
`node scripts/run-tasks.mjs build --filter=@canlang/<owner>`, then its emitted
`node --test <existing-test.js>`, or root
`bunx vitest run packages/cloudflare/test/<existing-test>.test.ts` for Vitest
consumers. The placeholders are selections from the named existing files, not new
commands or promised APIs. Cloudflare runtime Node tests emit to `dist/runtime/`;
State/UI/Interfaces use their existing `dist/test/` layout. The [DFE batches](#draft-frontend-acceptance),
[native units](#native-port-unit-contracts),
[dev extension order](#development-extension-contracts) and
[integration units](#service-and-integration-contracts)
give their actual commands. Existing resource rules and accepted results apply.
If a named required output is absent or its contract conflicts with current code,
stop only that consumer and return the exact symbol/behavior to its defining owner;
do not weaken the fixture, infer a passing result or reopen unrelated scope.

This is the **one current remaining-work list**. The absorbed contracts and consumer recipes appear below under the same IDs. Original source manifests and qualification records retain their requirement identities and observations; they do not supply another execution queue or current task count. Old native-source preparation holds were lifted; public deployment, automatic defaults and TS retirement have separate remaining holds.

### Accepted work to reuse

- Native development T00–T17/manual/physical lifecycle/public41/native133 and recorded Linux installed23/macOS manual/browser/example qualification remain accepted at their actual tuples. The later automatic-refresh/reuse/partial-update work below is distinct.
- Compiler source receipt/context/query closures; typed filters/Money currency; Resource/Location/WeeklyHours/Success hooks; Employee→Shift delivery; archive/grouped queries/Board pagination; inline bool/text/int preferences; Customer recover and Purchase operations remain accepted. Complete original workflows are not inferred.
- Rust arithmetic/registry, structural interpreter and format/distinctBy/excludedIds, selected recovery/helpers/int-CSV, merged actual-Wasm HTTP/exact27/27 and Work facade3/3 remain accepted. Remaining host/native selection, full families and installed changed binaries are explicit below.
- Package/Turbo cutover, scoped Identity/store/presession/browser admission, selected State durable mutation/tuple/scalar-parent and bounded recovery, CSV public browser review/confirm, V05 host corpus and existing installed Worker asset profiles remain closed.
- The resumed compiler audit is58 accepted references and nine remaining consumer aliases, already mapped into CAN18 outcomes; the old50/67 allocation is superseded. FAIL-R04 Cargo/Git watching is closed. Enum SEQ028–032, dependent-binding SEQ033–036, no-push055, no-await056 and finite no-pilot052 stay closed.
- challenge:H01/C01 operational handoff/shutdown/heartbeat cleanup is complete for the released runs. Product/R01 acceptance remains under FP.FULL. Description D01–07 and six independent repairs, completed120-item design evaluation, ordinary draft migrations and accepted build-generation engine/PromptStudio/persistence stay closed.

## Dependency-ready work and engineering dependencies

No broad plan completion is a prerequisite. A row with its named input already available is dependency-ready; a missing local source/API/backend is finishable engineering work owned by that row, not an external hold. Actual external/human leaves are isolated in the gate table.

**Dependency-ready starting points, if implementation is requested:**

- Original source/authority/query/hook/UI and Maintain retry repairs can use the retained original sources, compiler and controlled consumers. They need no provider credential or new plan approval; only their specific late provider/host consumers have external leaves.
- Native preparation's raw-layer/frontend handoff and the remaining State/Work native joins can use the merged owner code and exports. Missing demanded facts or final constructed outputs are the named producer's engineering work, not a wait for C04/C05 or the whole Rust port.
- Dev T18–T21 stable-origin/automatic-save work and measured reuse have their defining inputs. Complexity's original1070 census/closeout are available; recover the exact221 residual mapping before bulk dispatch, with one unchanged score21 body already identified. Later CSS/region consumers take the exact generation/asset output they need; no unrelated application must finish first.
- Files TECH-F01 separate-store publication has a finite local recipe. DEL-B02's durable large-output backend is already accepted; its original compiled mounted File/browser consumer can proceed without rebuilding that backend. Neither waits for every receiving provider or all Identity work.
- DFE-01 can reconcile the existing original frontend requirements now. DFE-02 consumes only its actual selected closure fixes; real generation/captures wait on their named model/host/output rather than the entire frontend corpus.

**Engineering-dependent consumers:** receiving-file/provider workflows require their exact authenticated cause/asset output; settlement needs reservation plus real usage; dependent forms need their selected source/query facts; installed delivery and staged upgrades need the changed final binary/schema tuple. The defining producer may progress while its consumer waits. Final FP.FULL/port aggregates consume accepted outputs once and are not additional producer gates.

### Source, canonical execution and presentation

| Existing IDs / outcome | Unmet behavior | Defining owner; concrete input | Finite acceptance / reuse | Defining contract | Next bounded unit / dependency |
| --- | --- | --- | --- | --- | --- |
| CAN18 outcomes3/4/8/13; challenge:T08; C02/C03/C19 | Resolve original event alpha-renaming, Member collection-call and Shift Boolean-observer disagreements; qualify same-grant selector/permission correspondence. | **Compiler source/IR + State + Cloudflare.** Exact original source and current grant facts; no credential gate. | Original inline/import/helper cases agree; denial, revocation and late failure preserve state/receipts. | [Source](#compiler-source-constraints) | **D** — Take event alpha-renaming, Member collection calls and Shift `Coverage.met` as three separate discriminators. Start compiler `scenario_disclosure.rs`, `scenario_decisions.rs`, `CheckedStandardCompletionSources` and runtime `native-read-boolean.ts`; extend `collection_calls` / `decision_source_facts` / `boolean_operation_admission` / `standard_completion_ir` as indicated. Repair the first actual source/IR mismatch, then its original consumer; same-grant correspondence is a concern to prove, not an assumed defect. |
| CAN18 outcome5; C02/C04/C19 | Complete original query/helper/body closures, including Customer accept, stored ANY+first and remaining original derived/public/periodic consumers. | **Compiler query/receipt/JS + State query + runtime frame.** Only the missing source/query/hook output used by that consumer. | Full original guard and body execute success, absence, mismatch, denial, rollback, replay and recovery. Customer recover and Purchase stay accepted. | [Source](#compiler-source-constraints) | **D** — First positive stored ANY→first inventory in `scenario_receipts.rs::{checked_any_query_ir,checked_any_first_query_ir}`; then unchanged Customer `accept` guards/body and actual State query receipt. Use `scenario_first_query_sources` and the real native consumer. `original-source.testing.ts::originalScenarioSource` retains declarations/rules but strips examples: preserve their original denominator separately. |
| CAN18 outcome12; C07; challenge:T31 | Fix the original retirement-hook compilation refusal and remaining staged/context/helper graphs, including newly staged Cancellation references. | **Compiler policy/IR/JS + State pipeline + Cloudflare.** Identify the first unsupported node in each original graph. | Real canonical hooks retain before/after/staged values, initiating/null actor, current grants, effect order, failure/replay/cancellation. Accepted hook families stay closed. | [Source](#compiler-source-constraints) | **D** — Start the existing `hook-first-delivery.test.ts` case “whole original asset retirement” (`maintain.retire_asset` → new Cancellation → queued CancellationStep). Trace first refusal in compiler model policy/IR/JS; qualify that whole hook before separate staged-content/reference-tail cases in `hook_hookrem`. Reuse the owner mutation session; do not replace references with raw IDs. 2026-10-18: first refusal repaired — `hook_snapshot_field` resolves declarations on the read model's owning module (cross-package stored-reference leaf reads such as `event.after.location.timezone` in `local_date`), plus the missing `local_date` re-export in Cloudflare `stdlib.ts`; new `model_hook_profile` regression passes and the extracted retirement source compiles with policies and no diagnostics. Exact remainder: candidate-context membership framing for the CRUD `when=can_work(...)` guard — no owner-stage sites or frame exist for `maintain.Asset.update`, so the guard refuses before commit; needs compiler-emitted sites plus invoke/State framing (next defining owners: Compiler decisions, Cloudflare invoke, State membership). |
| CAN18 outcomes9/11; C06/C18/C19 | Finish Invoice result/collected/refunded/checkout_cancelled/reconciled triggers and the seven recorded original parent calls. | **Compiler calls/receipts + State/Work + receiving owner.** Exact child signature/plan/result or verified terminal payload, never the entire target application. | Original caller/context/protected fields, returned/null values, source order and declared failure/replay boundaries pass. | [Source](#compiler-source-constraints) | **D** — One parent CALL whose child plan exists first: Propose revise, Rent prepare/arrive/depart/cancel, Maintain report/inspect remain separate units. Start `scenario_calls.rs::collect_static_scenario_calls`, `cross_operation_calls` and State receipt CALL. Invoice standard completion and authenticated payment events are distinct subunits; only the latter await their exact provider payload. |
| CAN18 outcome10; C02/C04; challenge:T24/T32 | Complete original Maintain retry/replay and remaining SEND guard/Rule/IR correspondence. | **Compiler SEND/source + sealed dispatch runtime.** The retained full retry consumer, which exceeds600s; attribute the actual failing/costly stage before changing it. | Original retry/replay completes with current authority/revocation and no repeated effect; stale-version control proves its intended refusal. Assignment, failed-mail receipt and32-hop guard remain accepted. | [Source](#compiler-source-constraints) | **D** — Attribute compiler/setup/admission/replay/Workerd stages of the existing 600s original Maintain case in `test/native-created-guarded-email.test.ts` before selecting a repair. Preserve retry/replay assertions and fix the stale-version control at its current version. Validate the affected case with Vitest `-t 'original Maintain assignment'`; separate SEND/Rule correspondence follows its demonstrated source root. |
| CAN18 outcome6; C10/C11 | Complete remaining original value/result-array pages, stats/history/skeleton/container behavior, copy-label/false-step findings and operation-bound forms. | **Compiler IR/JS + UI/Interfaces + runtime queries.** The exact emitted page/control and its source-derived domain. | Actual HTTP/State consumer preserves order/current versions/defaults/clear/errors/revocation. Reuse six filter combinations, archive/grouped queries, Board pagination and inline scalar preferences. | [Source](#compiler-source-constraints) | **D** — Reproduce copy-label/null and false-step leaves in UI `test/leaves.test.ts` first. Then release the actual value/result-array domain before dependent Report/Field containers and operation forms. Start compiler `ui_original_bindings`, runtime `native-ui-query.ts::wrapNativeUiQueryFactory`, UI collections/settings and Interfaces source-form binding; compile-only success does not close emitted HTTP behavior. |
| CAN18 outcome7; C10/C17; S9-Q01/SEM-R05 | Finish original formatted business statements/call arguments and canonical Alert sink identity at the used locale/timezone profiles. | **Compiler sink classification + Values/UI/outbound owners.** Exact declared sink and, only where absent, its specific temporal/dispatch output. | Original locale/escaping/source/freeze/evaluation order and failure behavior execute through the genuine sink. Selected V05 host corpus stays closed. | [Source](#compiler-source-constraints) | **D** — Start `compiler/src/codegen/js.rs::{outbound_sink_paths,pinned_alert_notify,lower_business_expr}`: separate canonical declared Alert identity from local alias while preserving signature/version/message checks. Qualify that discriminator with `localized_format`, then each original business statement/call argument through its real sink. Handler-body substitution is not source-lowering proof; no blanket temporal gate. |
| FP.COMPILED-DECIMAL; challenge:T15 | Closed: exact decimal expression lowering already has accepted source-generated consumer evidence. | **Compiler + Values constructor owner.** Current exact-spelling lowering and retained decimal materialization checks are available. | Compiled output preserves integral magnitude/scale without Number/i64 intermediaries and rejects invalid/ambiguous/range cases. Library arithmetic and Money-filter acceptance are reused. | [Source](#service-and-integration-contracts) | **C** — Already satisfied at exact-expression scope: current JS lowers through `parseDecimal`; retained `decimal_runtime`2/2 and generated public-owner checks cover magnitude/scale/defaults/range. Reuse the [accepted materialization](compiler-completion/temporal-values/decimal-materialization/ASSESSMENT.md). Native metadata/schema and wider call consumers keep their own IDs; no new implementation or unchanged rerun. |
| SEQ-005; challenge:T04/T15/T16/T18 | Close only the still-used source/context/rule/saved-influence/opaque File/corpus descriptor and generated-default contract boundaries. | **Defining Compiler/Contracts/Values/State/runtime owners.** Each real consuming site identifies its missing typed output or exact unresolved decision. | Current recursive/provider/default/hook descriptors reach canonical admission and consumers with original omission/null/evaluation/error rules; no umbrella DTO or full-owner prerequisite. | [Source](capability-roadmap-20261008/README.md) | **E** — Consume a concrete failing declaration from query/hook/context/invocation or corpus work, then add only its missing owning typed fact. Start the contract inventory, existing `modelPolicies`, `observeScenarioInputComputedDefault` and opaque File/query influence seams. End at the real emitted consumer; no umbrella DTO/serializer-only job or independent duplicate of the producer. |
| SEQ-010; FP.CONTEXT | Carry every actually used actor/team/clock/operation/locale/timezone/hook before-after/reserved-version/subject fact through its verified scope. | **Compiler + State/Identity + runtime.** Specific scope carrier, not completion of all context work. | Original compiled consumers preserve readonly identity, null/wrong-scope/revocation/evaluation-order controls; accepted nonhook/source-context profiles stay closed. | [Source](capability-roadmap-20261008/README.md) | **D** — Take one original hook/trusted scope first through runtime `context.ts` and State `buildContext`; preserve null actor, read versus mutation identity and reserved versions. Use `hook_context_scope` and affected typed-context serving tests. Page clock/locale is a separate scope; exact hook/ingress consumers wait only for their own graph, not all context. |
| SEQ-011; challenge:T17/T18/T29/T31/T32 | Complete the original ordered rule/hook/lock/invariant/reverse/nested/delete graph and imported lifetime/parent joins. | **Compiler + State + runtime.** Used graph metadata and exact owning session/transaction output. | Actual D1/DO where claimed: late rollback, one commit/version, replay, parent/lifetime/cycle and current authority. Existing State core and selected graph proofs are reused. | [Source](capability-roadmap-20261008/README.md) | **D** — The accepted `model-rule-contract.md` selects native callbacks and one owner mutation finalization. Start `beginOwnerMutation` / `bindArtifactOwnerModelPolicies`; find one original graph's missing emitted `modelPolicies`/binding dependency, repair that owner and run `composed_rule_owners` plus the affected `native-local-rules-d1` consumer. Imported lifetime/reverse/delete are separate units, not a second interpreter. |
| FP.IDENTITY-CONTRACT / FP.IDENTITY | Finish the remaining typed J2/conditional identity lifecycle and durable proof at its original scope. | **Identity + State conditional participant + Interfaces.** Exact unresolved transaction participants/context/fence decision, then only the dependent lifecycle variant. | One winner and atomic rollback/replay for remaining token/last-owner/role/recovery/membership cases. Reuse accepted ordinary store, presession, invitation, recovery, signed/internal removal and mounted-admission profiles. | [Source](#service-and-integration-contracts) | **B** — Identity/State owner must settle the remaining transaction participants after excluding accepted invitation/recovery/signed-removal and local last-owner commands in Identity `storage/d1.ts`. Compare Identity-local conditional batch against actually required business-State participation; do not promise cross-database atomicity. Then implement one remaining variant with D1 race/rollback tests. The historical J2 proposal alone is not a current absence inventory. |
| challenge:T22/T23; LG02 | Finish rich compiled examples: genuine finalized-file/provider/delivery fixtures and original table/sequence execution. | **Testkit + Compiler + relevant provider/file owners.** Specific fixture producer and dispatch/observation/CallOutcome/query-cell output. | Actual emitted callers/prior commits assert independent values, denial/no-change and false-expectation failures; setup failure cannot count as business rejection. Accepted native example qualification is reused. | [Source](#current-consolidated-list--18-october-2026) | **D** — Extend Testkit `fixtures/recipes.ts`, `runner/loader.ts::prepareRowCells` and dispatch hooks with one genuine finalized File fixture, then a controlled actual delivery/observation fixture. Run changed `test/loader.test.ts` / `dispatch.test.ts`, followed by the original compiled row/sequence and a false-expectation negative. Setup failure is never business rejection; only recipient-specific BDD3 actions remain held. |
| FP.INVOCATION; SEQ-039 | Finish original Workbench context/approval, Task.update/complete, publication and transcript/ANY/call consumers. | **Compiler + State/Interfaces + runtime.** Frozen allowlisted typed arguments/reference provenance, current protected preview and target admission; supported TextGeneration File[] output only for that original consumer. | Same-owner approval/effects commit or roll back together; current roles/version/defaults/refusal/replay hold. Accepted State/current337 components remain closed. | [Source](capability-roadmap-20261008/README.md) | **E** — First release Workbench `context`'s actual Fact[] projection; then its unchanged approve sequence rereads facts, invokes stored call and checks late invariants in one owner session. Start `CanWorkbench.can`, State `bindScenarioReceiptCallProducer` / `invokeScenarioReceiptCall`, compiler `invocation_references`. Task and publication consumers follow separately; TextGeneration File[] is required only by its matching branch. |
| FP.POLICY-REVIEW | Qualify staff-facing business review derived from checked owner facts. | **Compiler/reference + Interfaces/UI.** Actual permissions/actions/exceptions/defaults/assumptions/examples, plus truthful provider availability. | A real consumer displays unresolved intent and source-owned policy without a second copied prose policy. | [Source](#service-and-integration-contracts) | **D** — Extract one owner's checked permission/action/guard/default/example facts at compiler/reference ownership, then mount a real staff review. `contracts/reference.ts` currently excludes policy inventories; UI `review.ts` only renders supplied slots. Extend the owning facts, not copied prose or a presumed nonexistent `review.rs`. Source changes must update the projection; experienced compiler ownership is appropriate. |
| FP.DOC-REQUIREDNESS | Resolve the recorded ordinary-array versus required-array creation-reference discrepancy if still demonstrated. | **Compiler docs + Values + Forms/MCP/State.** Compare the exact current stored-field facts; parameter requiredness stays separate. | Reference and actual creation consumers agree: ordinary omitted arrays default empty and required arrays differ. Repair only a reproduced disagreement. | [Source](#service-and-integration-contracts) | **D** — Reproduce the specific stored-array mismatch: `compiler/src/docs.rs` lacks the ordinary-array exclusion used by Values `internal/schema-core.ts`. Add ordinary `text[]` beside `text[]!` in `compiler/tests/docs.rs`, repair only stored-field extraction, and compare genuine creation/reference behavior. Operation-parameter requiredness stays separate; use affected docs/docs-reference tests. |
| FP.PREFERENCES | Qualify remaining self/owner/app/team reference preference/default/reset/conflict/cancel/bound-tab profiles. | **Compiler metadata + UI/Interfaces + preference storage.** Exact current source-owned preference key and reference fallback. | Real consumer preserves current identity, save/reset/cancel/revocation without granting business authority. Inline bool/text/int nullable/CAS/save-reload profiles are closed. | [Source](#service-and-integration-contracts) | **D** — Trace one original reference preference through Interfaces `pages.ts::{loadPreferenceField,handlePagePreferencePost}`, UI settings/bootstrap and runtime `page-preferences.ts::createD1PagePreferenceStore`. Existing scoped key and version CAS are available. Qualify reference fallback/reset/cancel/conflict, then other remaining scopes; reuse scalar editors. Historical State preferences and separate HTTP preferences paths are absent. |
| FP.BROWSER; challenge:T19/T20 | Complete remaining installed catalog-wide DOM/form/navigation/polling lifecycle qualification. | **UI/Interfaces/browser + runtime.** Matching actual emitted controls and installed assets/current operation binding. | Required68 catalog bindings and rich input/file/error/CSRF/authority cases retain keyboard/focus/drafts/history and obsolete-response/logout termination. Reuse accepted shell/manual/browser/native profiles. | [Source](#service-and-integration-contracts) | **E** — Take the exact emitted control/page output from outcome6, map only unqualified catalog profiles, and qualify one coherent installed DOM/form family before navigation/polling. Start UI `registeredBinderIds` / `startBrowserClient`, Interfaces source forms and existing native browser tests. `native-plain-action-browser` does not itself prove emitted .can actions; accepted manual/browser foundations remain closed. |

### Durable work, receiving resources and application services

| Existing IDs / outcome | Unmet behavior | Defining owner; concrete input | Finite acceptance / reuse | Defining contract | Next bounded unit / dependency |
| --- | --- | --- | --- | --- | --- |
| challenge:T25; D3B Q4-C | Qualify the real bundled selected-receipt observer route without test injection. | **State/Work observer + Cloudflare bundle/transport.** Specific worker-safe observer/B-half output; Q1–Q3 foundations already exist. | Bundled /mcp receipt-read returns authorized projection, denied-as-missing, stale-fence and closed-input refusals; dropping observer bytes fails. Reuse Node/checkout and selected observer proofs. | [Source](#durable-work-receiving-resources-and-application-services) | **D** — Boot the actual deploy bundle and call `/mcp` without observer injection, reusing `typed-delivery-observer.test.ts` / `d3b-selected-receipt.test.ts` seeds. Trace State receipt join and portable Work receipt loader only for a demonstrated bundle gap. Add authorized/denied/stale/closed-input plus one dropped-bundle negative; stop at Q4-C, not all T26. |
| challenge:T26 | Complete durable observable relation/progress/notification consumers. | **Work + State association/receipt + runtime.** Matching producer/receipt association and the selected authorized observer output. | For each declared relation, duplicates/cancel/late usage/restart/terminal immutability and notification correlation hold on the actual durable path. | [Source](#current-consolidated-list--18-october-2026) | **D** — One real durable relation first through Work `observation/association.ts::applyRetainedRelatedProgress` and runtime `receipt-progress.ts::stageReceiptProgress`; then remaining unqualified relation families. `T26_KNOWN_RELATION_TARGETS` lists17 targets, but shape tests do not establish durable behavior. Extend existing durable recovery/observer fixtures with notification correlation and reopen/late cases. |
| FP.DISPATCH-AVAILABILITY | Finish actual deployment target/capability availability and durable terminal dispatch mapping. | **Work/Services + Cloudflare physical driver.** Owning target binding/availability contract and matching W01/W04/W06/W07 profiles. | Lifecycle→availability→guard→revalidation→claim ordering, missing/broken/temporary outcomes, persisted terminal receipts and recovery execute without unsafe redrive. Pure kernel return is not enough. | [Source](#service-and-integration-contracts) | **D** — Wire existing Work `TargetAvailabilityPort` into runtime `DriveDispatchFenceInput`/`bound-dispatch.ts`, preserving lifecycle→availability→guard→revalidation→claim, then persist unavailable terminal receipts. `invoke.ts::runFenceGate` is the actual ordering seam. Extend `t24b-dispatch-{execution,durable}` and `dispatch-unavailable` with short-circuit negatives. This is local transactional engineering, requiring an experienced executor, not provider credentials. |
| TECH-F01; FP.FILES-DURABLE | Finish original multiple-owner separate-store file publication serialization and interruption/reopen. | **Files producer + physical host consumer.** Exact serialization primitive and original interruption witness; no new R2/hardware-power-loss matrix. | Final identity/immutable bytes survive; malformed/partial/foreign/refused writes never publish. Existing two-connection SQLite and serial FS/SQLite criteria stay closed. | [Source](../research/package-library-audit-20261006/repair-queue/queue.json) | **D** — Define one same-intent/publication serialization primitive for the selected separate-store host, then its two-owner interruption/reopen witness. Start Files `ports.ts`, `createSqliteFileBindings`, `createFsBlobStore`, `finalizeUpload` and existing finalize tests. Reuse serial/SQLite acceptance; no new finalization algorithm, R2 or power-loss matrix. |
| TECH-F02; SEQ-024; challenge:T27 | Finish authenticated receiving-file request/source/revision and once/replay/lifetime joins, including required image outputs. | **Files/Services + Compiler + receiving runtime.** Exact supported provider event, immutable bytes/digest/MIME/size and receiving authority. | Cumulative/foreign/partial/replayed/retired inputs refuse correctly; genuine receiving finalization occurs once and survives restart. Provider-void remains explicitly unsupported. | [Source](capability-roadmap-20261008/README.md) | **E** — Take the selected authenticated namespace/request binding from FP.SOURCE-MAPPINGS, then connect `ingestVerifiedEventBytes` / `finalizeProviderOutput` through runtime callback origin/file staging to one receiving occurrence. Extend `native-generation-receiving.test.ts`; local fixtures precede the exact real provider event. Preserve source/revision/digest/cumulative identity and provider-void refusal. |
| FP.LIFETIME | Implement and qualify remaining owner expiry/sensitive-copy disposal. | **State lifetime + Work/Files retention owners.** Declared archival/lock/subtree/reference lifetime and safe replay identity contract. | Expired/archived/locked access refuses; history/receipt/outbox/private copies and blobs are disposed with honest delay/restart behavior. File GC alone does not close it. | [Source](#service-and-integration-contracts) | **D** — One authored expiry consumer first: CanCheck Transition/Notice or CanStats AcceptedEvent. Carry its checked lifetime to canonical admission/read, then bounded restartable disposal using existing Files retention/file-retirement inventory; proposed State retention directories do not exist. Join sensitive copies/tombstones afterward without creating a generic carrier before finding a metadata gap. |
| FP.CSV / FP.AW-REPLAY-IMPORT | Finish original source-derived import operation/current File/reference and replay qualification. | **Interfaces/CSV + State + actual app consumer.** Specific canonical review/commit operation and receiving File authority. | Per-row replay-safe outcomes preserve invalid/excluded/unknown/failed rows, changed-candidate renewed consent and historical nullable facts. Accepted public browser review/confirm consumer DEL-C02 stays retired. | [Source](#service-and-integration-contracts) | **D** — Choose one original import, e.g. CanInvoice `retain_legacy`, and connect actual File/reference review-confirm to its replay-safe operation. Reuse Interfaces `http/csv.ts`, UI CSV helpers, `reviewed-csv` and accepted native browser setup. Add only the selected actual source consumer, preserving changed-candidate consent and historical nullable semantics. |
| FP.EXPORT; DEL-B02 | Finish the original compiled mounted File/browser export/Print consumer; durable descriptor/status/download/expiry backend is accepted. | **Interfaces + Files + runtime/browser.** Accepted durable D1 status/read/download backend and existing browser helpers; consume actual compiled File/page authority. | Guarded current row/field/file access, completeness/limits/currency/ID/version/formula rules, cancel/restart/replay/expiry and source-declared Print hold at the original mounted scope. | [Source](#service-and-integration-contracts) | **D** — Backend already accepted: use runtime `export-downloads.ts`, Interfaces `http/{export,print}.ts` and UI browser owners. Next is the original compiled mounted File/page: actual finalized bytes → descriptor/status/download/Print with current authority and failure cleanup. Consume DEL-B02's released backend; do not rebuild or rerun its unchanged CAS/reopen suite. |
| SEQ-021; FP.SERVICE-CATALOG | Finish original real production text/media/service model/account/tokenizer/limit consumers. | **Services/provider + Capability + runtime.** Required supported provider/account/profile and genuine output/progress/usage. | Original CC/CH vectors prove exact request/result association, limits, terminal/order/late/unknown/restart behavior. Harness/export presence and successful packaging are insufficient. | [Source](capability-roadmap-20261008/README.md) | **D** — Select one original CC/CH profile and wire source request/progress/usage to the existing Ollama/ComfyUI/SystemOne/catalog owner and its exact installation limits/tokenizer. Controlled owner results are reused; real profile qualification then needs that provider/account. Do not call local packaging or a substituted model production acceptance. |
| SEQ-022 | Finish current-guarded provider attempt stop/reconcile/deadline behavior. | **Work/Compiler + runtime + selected provider.** The original supported cancel/reconcile protocol and current receipt association. | Actual provider races/unknown/idempotency/deadlines preserve current authority and immutable terminal state. Accepted component APIs are reused. | [Source](capability-roadmap-20261008/README.md) | **E** — Take only CanChat/CanCreative's missing source rule/context/SEND outputs, then join existing bound TextGeneration/Images cancel/reconcile and retained dispatch controls to those original scenarios. Qualify original attempt/deadline/stop-success races; real protocol evidence waits on the selected provider. Do not build another control API or infer zero usage from stop. |
| SEQ-042 | Finish original same-owner Chat/Knowledge admission, reservation and outbox atomicity. | **App/Compiler + State/runtime.** Only used context/rule/invocation outputs from SEQ010/011/039. | Concurrent last-slot/cap/overflow/stale/revoked/later-failure/replay/crash cases cannot dispatch a rejected request; reservation and owning commit agree. | [Source](capability-roadmap-20261008/README.md) | **E** — Compile one unchanged original Chat/Knowledge ask with its exact query/context/rule outputs, then prove last-slot/later-failure atomic request+reservation+outbox on D1. Start original ask and State owner sessions. `native-original-canchat.pending.ts` is unfinished, not a runnable passing suite; diagnose its timeout before promoting it. This output releases SEQ043's reservation identity. |
| SEQ-043 | Finish associated exactly-once settlement and late usage/release. | **Accounting/Work + provider + runtime.** SEQ042 reservation identity and genuine provider usage output. | Duplicate/forged/unknown/late/restart cases settle the correct original request, preserve terminal-null→late usage and never refund consumed slots. | [Source](capability-roadmap-20261008/README.md) | **E** — Consume SEQ042's exact admitted reservation plus associated usage. Join original Chat `reply_progressed` through runtime `text-generation-progress.ts` / receipt progress in the same fence; test duplicate/forged/late/restart observations. Terminal-null may receive late usage; running-slot release is distinct from consumed daily charge. Genuine accounting remains the provider-specific final leaf. |
| SEQ-045 | Select and finish one original genuinely reversible definite-success domain effect. | **App + provider/reconciliation owner; mechanism unassigned.** Exact effect/reconcile protocol decision; Payments only if selected. | Pending/success/failure/unknown/denied/irreversible/crash/replay retain source authority and recovery. Email is not made reversible. | [Source](capability-roadmap-20261008/README.md) | **B** — App/provider owner selects one actual definite-success reversible effect and reconciliation identity before implementation; no chosen contract exists. Compare original-payment refund with an actually required withdraw/repair effect under JEV, preserving unknown/crash/replay/authority and irreversibility. Payments is used only if selected; Email is not reversible and no compensation syntax is implied. |
| FP.AW-JUDGMENT; SEQ-046 | Finish original Knowledge/Triage Judgment producer and remaining domain workflow. | **Judgment/Services + runtime.** Real approved model/account/tokenizer/options/usage and declared rubric/schema. | Request/model/version association and every probability/option/level/decimal bound, malformed/retry/unknown/current-authority case pass; no argmax substitution. | [Source](capability-roadmap-20261008/README.md) | **D** — Map original Knowledge/Triage rubric to existing Services `judgments/{specification,systemone}.ts` and runtime `bound-judgment.ts`, then execute its actual callback. Reuse `static_judgment_runtime` and bound-judgment durable fixtures; add missing original policy/association cases. Remote model/account/tokenizer/usage qualification is a later exact leaf, not a reason to recreate the producer. |
| FP.CORPUS; SEQ-047 | Finish Handbook/model-bound corpus retrieval, index and all-supplied-context authority. | **Compiler/Contracts + index/provider + runtime.** Accepted opaque Answer and immutable eligible source revision/withdrawal contract; no new corpus-adoption decision. | Revoked uncited context, expiry/corruption/unknown index and missing provenance withhold disclosure equally in UI/MCP; current grants and honest coverage/as-of survive repair. | [Source](capability-roadmap-20261008/README.md) | **D** — Start CanKnowledge Handbook plus `compiler/tests/corpus_admission.rs`: checked source currently deliberately refuses shipping with E6008. First emit its owning descriptor/interface with opaque Answer/all supplied provenance; then index/withdraw eligible immutable revisions and join canonical disclosure. Only remove refusal when the real output exists; selected index/model access affects the final consumer. |
| FP.MAILBOX / FP.AW-MAILBOX | Finish MailboxV1 owning catalog/coordinator and authenticated installed MIME receiving/reply/reconcile. | **Services/Mailbox + Files + private receiving owner.** Configured authenticated namespace/cause and genuine receiving-file contract. | Bounded passive IncomingEmail reports honest original attachment count/completeness; frozen reply, conflicting redelivery, retry and terminal not_sent never create a later original send. | [Source](#service-and-integration-contracts) | **D** — Contracts already define IncomingEmail/MailReply/Outcome; Services catalog has no Mailbox. Add the owner-derived catalog/coordinator, then one authenticated MIME receiving producer using the shared binding/File outputs. Start CanInbox received/sent/reconciled and `mailbox_source_producer`. Send-only Email is not Mailbox; exact provider configuration gates only its real observation. |
| FP.AW-PAYMENTS | Finish verified payment account/provider event and original financial reconciliation. | **Payments/Services + Work + app owner.** Concrete account/transport and original attempt/amount/currency/revision/consent identities. | Checkout cancellation, mandate consent, exact refund identity and late real funds preserve original authority/replay; unknown is not fabricated failure. | [Source](#service-and-integration-contracts) | **D** — Start Contracts Payment inputs/states, CanInvoice Payments and `payment_completion_handlers` / `payment_state_identity`. Prepare one actual account/transport adapter's verified-event/original-attempt mapping, then join durable dispatch and original source. No Services payment adapter exists. Name unavailable profile/configuration exactly; local association work remains possible, and decimal lowering is already available. |
| FP.AW-DOCUMENTS | Finish immutable issued/receipt snapshot PDF and receiving-file download. | **Documents renderer/provider + Files + app.** Exact source/revision snapshot and bounded renderer output. | Real finalized bytes/provenance/current download grant pass missing/wrong artifact, restart and replay controls; no success placeholder. | [Source](#service-and-integration-contracts) | **D** — Implement one bounded renderer for CanInvoice's immutable DocumentsV1 issued snapshot, then receipt, using actual PDF bytes and Files provenance/finalization. Connect `bound-files.ts` current download authority; validate missing/wrong bytes/restart/replay. Renderer selection is local engineering; separate-store concurrency is required only if that host claim uses it. |
| FP.SOURCE-MAPPINGS / FP.AW-SOURCE-CONNECTOR | Finish configured versioned source namespaces and reusable cross-app cause/outcome binding. | **Contracts/Services + source/receiving apps + runtime.** Exact approved producer/app/team/customer/resource namespace, request digest and operation contract. | Only matching committed outcome associates to delivery; source-domain changes/reversals/null/precreation fences stay distinct; receiving Can operation owns authority, with no cross-owner transaction claim. | [Source](#service-and-integration-contracts) | **D** — One configured versioned BillingIngress/SalesIngress binding first using Interfaces `IngressBinding/Verifier/Sink` and `ingress/mapping.ts::mapVerifiedIngress`; then matching committed-outcome correlation. Existing mapper keeps actor null; proposed provider source modules are absent. This shared output releases receiving/file/mailbox/payment/onboarding consumers once, without cross-owner atomicity or name guessing. |
| FP.AW-ONBOARD-HANDOFF | Finish verified HR→onboard and delegated course-progress handoff. | **HR/Onboard source owners + Identity + runtime.** Genuine caller and exact employee/template/candidate match. | Canonical onboard.start creates one handoff; queued continuations reauthorize without staff grants or private CV copying. | [Source](#service-and-integration-contracts) | **E** — Take FP.SOURCE-MAPPINGS' exact authenticated cause, then genuine CanHire→CanOnboard `start` with employee/template/candidate and once-only reference; later join CanLearn delegated progress. Existing State canonical admission owns authority. `CanHR.can` is not a current source. Test mismatch/replay and membership removal between queued steps; no staff grant or CV copy. |
| FP.MAINTENANCE | Finish configured trusted maintenance through canonical owner admission. | **Cloudflare transport + State maintenance owner.** Configured source/team/version and exact maintenance operation contract. | Constraints/hooks/fence/history/replay/outbox commit together; Check/Catch use the same authority, with no direct SQL or invented configuration tools. | [Source](#service-and-integration-contracts) | **D** — Implement one configured source/team/version maintenance admission from an actual CanCheck/CanCatch need over existing State `ports/system.ts` and canonical owner constraints/hooks. Proposed maintenance modules are absent. Join history/outbox/fence to that commit and test D1 bad binding, late failure and replay; no direct SQL bypass or general settings UI. |
| FP.PING | Finish provisioned heartbeat ingress and health lifecycle. | **Ingress/Services + State/Work + app.** Configured namespace/secret and canonical ping source. | Bounded noncached GET/POST acknowledges only after durable ping; key/revision/unknown/revoked/restart/due/pause/recovery races hold. Notice acceptance does not reset health. | [Source](#service-and-integration-contracts) | **E** — Consume only the needed configured binding/admission output, then implement bounded noncached Ping GET/POST for original CanCheck PingV1/Heartbeat. Resolve trusted namespace/token and wait for durable canonical ping before ACK. Test revoked key/current revision/restart and ping-deadline-pause races; notification acceptance is not recovered health. |
| FP.ALERTS | Finish safe installed AlertsV1 adapter. | **Services/egress + Work + app owner.** Owning acceptance/source/destination/message schema and explicit provider mapping. | Bounded public HTTPS/redirect/destination/credential restrictions and current dispatch guard hold; notice delivery remains distinct from external job success. | [Source](#service-and-integration-contracts) | **D** — Implement the configured AlertsV1 transport declared by CanCatch/CanCheck, using Services HTTP/mail error conventions. Start bounded public-HTTPS/redirect/credential-safe egress controls, then join Notice to the actual dispatch availability/receipt output. Real credential release affects only that configured send; no accepted-health claim or double-send on unknown. |
| FP.INSTRUMENTATION | Finish configured authenticated ErrorsV1 intake for minimized browser capture. | **Browser SDK + intake/State/Work + app.** Source/project binding and quota/replay/work fence. | UTF8 bound and pinned redaction precede queue/group/files; SDK is nonblocking/nonrecursive; deleted-project suppression, replay tombstones and independent raw/diagnostic retention survive retry. | [Source](#service-and-integration-contracts) | **D** — Bind existing Interfaces `IntakeSink.store` to the actual CanCatch project: redact before queue/group/File storage and atomically enforce quota/replay/work. Reuse UI `browser/instrumentation.ts` and intake tests. Then join deletion suppression and independent raw/diagnostic retention from FP.LIFETIME; do not recreate capture helpers. |
| FP.TRACKER | Finish consent/session tracker SDK and canonical Analytics intake. | **Tracker SDK + Services/State + Analytics app.** Configured event schema/source and current consent/reset/session contract. | Public key confers no read/truth authority; normalization/quota/receipt/work fence and30-day identifier disposal preserve safe replay and actual consumer behavior. | [Source](#service-and-integration-contracts) | **D** — CanStats owns TrackerV1/WebEvent/AcceptedEvent/Dimensions; no tracker SDK/intake exists. First configure write-only binding, consent/session/reset normalization and atomic accepted-event/quota/replay/work; then viewer-authorized dimensions and retention. Consume shared binding/lifetime outputs only when needed. No `CanAnalytics.can`, public read authority or fabricated sales proof. |
| FP.REPORTS | Finish source-derived finite reporting and required historical facts. | **Reports/Values + delegated source owner.** Typed dimensions/weighted intervals, immutable financial digest and exact historical-day/calendar/price verdicts. | Checkpoint/range/site/reversal coverage and current audience hold; currencies/units remain distinct with truthful N/A/unavailable, no invented backfill/SQL. | [Source](#service-and-integration-contracts) | **D** — One truthful nonfinancial backlog or already-supported Rent interval projection first from CanReport ReportsV1/Checkpoint/Contribution/Run, with current audience and honest completeness/as-of. Financial/reversal joins follow immutable source digests. Historical Rent denominator waits only on FP.APP-ADJUDICATION's exact policy choice; no invented absent history or all-report hold. |
| challenge:T34; SEQ-048; F8 M1–M10 | Finish original complete fanout/cohort/schedule durable matrix. | **Compiler + Work/State + Capability/runtime.** Actual source/handler/default Worker/cursor output, including original Opportunity.updated where used. | 499/500/501/1000, both spellings, crash/restart/concurrent change/revocation/fairness/exhaustion/two-occurrence cases and honest unsupported/resource negatives pass. Reuse accepted recovery and cohort pieces. | [Source](capability-roadmap-20261008/README.md) | **D** — Map F8 M1–M10 to accepted current tests, then implement one genuinely missing original source/runtime cell through durable fanout, State cohort and runtime `cohort-tick`. Start Volunteer `Opportunity.updated` reminder refresh while preserving accepted cancellation/reminder semantics; material reschedule awaits FP.APP-ADJUDICATION. Use existing emitted-cohort fixtures, not timer substitutes or repeated accepted matrix cells. |
| SEQ-037 | Finish original CountryRegion/Approve/Rent dependent-form vertical joins. | **Compiler + UI/Interfaces + runtime.** Original source/query/grant output and current final-admission contract. | Stale/draft/focus/locale/simultaneous identity cases pass through real native source→query→UI→canonical submission. Accepted binding grammar and bounded browser fixture stay closed. | [Source](capability-roadmap-20261008/README.md) | **E** — First release original CountryRegion breadcrumb/edit/table emission and checked conditional grants, plus CanApprove's selected query facts; start existing dependent-input comparison originals and `compiler/tests/input_choices.rs`. Then qualify original authorized choices→UI→canonical submission with stale/revoked parent changes. Accepted reduced actor/direct-parent fixtures do not release these full originals. |
| SEQ-038 | Finish original ExpenseReview and CreativeRevisionReview workflow/page joins. | **App + Compiler + runtime.** Exact frozen evidence, reviewer and separately authorized reimburse/publish contracts. | Original10/12 scenarios retain self/duplicate/ineligible/stale/revoked/concurrent decision, expiry/reject/supersede and evidence behavior. No approval bypass. | [Source](capability-roadmap-20261008/README.md) | **E** — Take Expense's exact Locations/employee.can_work source fixes and current Creative+Chat closure; compile existing `approval-compositions/{ExpenseReview,CreativeRevisionReview}.can`. Then execute original10/12 scenario vectors under owner admission and frozen evidence. Provider/File holds apply only to the matching Creative branch; no reduced approval fixture or generic quorum. |
| FP.APP-ADJUDICATION; challenge:T36; migration A03 remainder | Resolve only the recorded original business/source ambiguities before correction. | **Defining application/language owners; unassigned individual verdicts.** Exact Mail/Reception/Rent/Discover/Catch/Affiliate/Event/Stock countercases; Partner authorized lock edit; Volunteer historical-versus-current material-change recipients. | Explicit intended policy versus defect/missing implementation is recorded, with uncertainty/negatives preserved. Volunteer stale-consent denial and atomic conflict decision are specified together; cancellation/reminder subset stays accepted. | [Source](#service-and-integration-contracts) | **B** — Source/application owner resolves recorded Mail/Reception/Rent/Discover/Catch/Affiliate/Event/Stock policy discrepancies and Partner's legitimate lock edit versus immutability before corrections. Volunteer must preserve historical recipients and immediately invalidate stale consent, or explicitly adopt a fully specified alternative; compare via JEV in existing `progress-design.md`. Use an experienced design executor; unaffected accepted cancellation/reminder work stays closed. |

### Rust responsibility completion and delivery

| Existing IDs / outcome | Unmet behavior | Defining owner; concrete input | Finite acceptance / reuse | Defining contract | Next bounded unit / dependency |
| --- | --- | --- | --- | --- | --- |
| ports:P04–P08 / C04.preparation-join | Replace finished-TS-bundle handoff with native-owned final construction/output consumption. | **Cloudflare native preparation + host/frontend owners.** Raw host layers/frontend facts and actual producer results; C04/C05 aggregate completion is not a prerequisite. | Installed explicit-native build/preview/contained mocked apply consumes Rust-built JS/browser/resource/plan/publication outputs with original error/cancel/evaluation/partial-write cleanup order. | [Source](#native-port-unit-contracts) | **D** — Split `packages/cloudflare/src/preparation/host.ts::runNativeDeploy` raw layer/frontend observations → existing Rust job construction → native publication/plan consumption, in that order. Reuse `layers`/`authoredMaps`/`artifactFacts`; `ensureBundle` still constructs TS output. Follow the [native units](#native-port-unit-contracts); use an experienced integration executor. |
| ports:P09 / C04.native-release | Qualify the changed final constructor executable and claimed installed hosts. | **Native/release delivery owner.** Final native constructor output, source/release inventory and exact claimed host. | Final bytes/launch/verifier/integrity/installed consumer pass. Reuse accepted Darwin/Linux selected CLI, mocked apply and rollback; public upload is separate. | [Source](#native-port-unit-contracts) | **E** — After P04–P08 releases the final constructor bytes, package one claimed host and run `node packages/cloudflare/scripts/verify-preparation.mjs --dir <stageDir>`, then its installed build/preview/mocked-apply witness. Start in `packages/cloudflare/scripts/package-preparation.mjs` and `src/preparation/executable.ts`; no all-C04 dependency. |
| ports:A07–A09; remaining A01/A02 clauses | Finish only remaining exact carrier/error/evaluation/identity and actual package/stdlib/generated consumer qualification. | **Values owner + specific callers.** Repaired broad binding and the exact consumed original operation/profile. | Original declared call semantics and errors/identity hold through genuine consumers. Arithmetic/69-operation registry and merged HTTP actual-Wasm27/27 are not reimplemented. | [Source](#native-port-unit-contracts) | **D** — At `packages/values/bindings/exact-route.ts::routeExact`, select one unqualified original carrier/error/evaluation clause and its real caller; qualify/repair that closure before the next. Use `conformance/ports/exact/` and existing `exact-backends`/`exports-conformance`/`stdlib-pure` tests. Broad routing and HTTP27/27 already exist; changing the public compatibility domain requires an explicit decision. |
| ports:V03–V07 | Finish outstanding selected validation policy/host-predicate/codec/retained-result/lifetime behavior. | **Values validation owner.** Specific codec output and genuine owner plan/token. | Selected profile preserves generation/bounds/disposal/error order and identity. Structural interpreter/shape/constraints/format/distinctBy/excludedIds already exist and are not absence claims. | [Source](#native-port-unit-contracts) | **D** — Start `packages/values/bindings/validation.ts::{classifyOwnedSelection,resolveDeferredValidation,withOwnedRequest}` with one consumed missing codec/predicate profile. Join the existing native demand loop at the original evaluation point; qualify retained identity/default/disposal with existing `validation-binding`, `owned-input` and native input-validation fixtures. No structural interpreter rewrite. |
| ports:V06/V08/V09 / C04.validation-join; TECH-V03 | Finish production selection, State admission/read and ordinary MCP native consumers. | **Interfaces/State/runtime + Values.** Exact codec, protected plan/token and specific runtime handoff; HTTP token/package join27/27 is accepted. | Replay-before-normalization/current authority/durable replay/disposal hold in actual consumers. Original HTTP adoption gets its bounded accept-or-evidenced-decline disposition; decline leaves adoption gap. | [Source](#native-port-unit-contracts) | **D** — First connect State `invocation/registry.ts::validatePreparedInputs` / `admission.ts::validateCallInputs` to its native plan/token after replay/authority gates. Separately join actual MCP `server.ts` to `mcp/prepared.ts`; preserve their different profiles. Use `owned-admission`, `owned-mcp`, `prepared-validation.workerd` consumers. HTTP installer disposition is a separate subunit, reusing HTTP27/27. |
| ports:W02–W06 | Join full-family native Work calculations to actual F5/F7 durable consumers. | **Work/State + Cloudflare.** Matching final binary/export and stable invoke handoff, not the entire validation plan. | Original call-local refs/clone/fault order, authority/atomic children/winner/refusal/crash/restart criteria pass. Reuse seven-family conformance, pure consumers/helpers and selected recovery. | [Source](#native-port-unit-contracts) | **D** — Thread the existing `createWorkKernel({backend:'wasm',module})` selection into one genuine F5/F7 durable caller, then remaining family calls; helpers currently default to `tsWorkKernel`. Start Work `test/state-fanout/t34-f5-*`, `test/dispatch/t34-f7-*` and Cloudflare `t34c-work-installed.integration.test.ts`. Final installed checks consume C04.work-assets, not all validation. |
| ports:C04.values-assets / C04.work-assets; A08/W05 | Qualify final full-family binary/glue/vendor/import/inventory delivery. | **Delivery + Values/Work consumers.** The specific final rebuilt owner binary/glue and consumer exports. | Installed Node/Worker/staged workerd prove byte integrity, cold/warm one-instance behavior, missing/corrupt/wrong ABI refusal and cleanup. Graph/typed-assets/int-CSV/recovery delivery stays accepted. | [Source](#native-port-unit-contracts) | **D** — Package one full-family producer's current bytes/glue/import inventory through Values `scripts/stage-semantics.mjs`, Work-kernel `scripts/stage-recovery-wasm.mjs` and Cloudflare `deploy/package-assets.ts`. Then qualify the final changed consumer when its output arrives. Use existing package-assets/worker-boundary tests and `verify-installed-worker.mjs --skip-build`; earlier helper binaries do not close final acceptance. |
| ports:A10/V11/W07–W08/P10 / C05.complete | Finish original whole-call/resource comparisons and budget/reuse decisions. | **Each defining Rust/TS subsystem owner.** Actual complete calls/output tuple and comparable current/prepared TS baseline. | Startup/conversion/host/heap/linear-memory/disk/assets measured at original scope; budgets are ratified or replaced with justified disposition. Retain-TS is valid; provisional20%/10% is no automatic blocker. | [Source](#native-port-unit-contracts) | **D** — Nominate one original complete-call workload, TS comparator and scoped budget before measuring. Preparation has `conformance/preparation/{workloads,differential}.mjs`; old Values/Work measurement runners are proposals. Final comparisons wait only for the matching finished call and package. Record retain-TS/native-reuse/adoption disposition; [native units](#native-port-unit-contracts) give the order. |
| ports:A10.2/V11.2/W08.2/P10.2 | Finish remaining packaged explicit selection/disposal/persisted-byte/rollback scope. | **Subsystem + release owners.** Final selected packaged outputs and unchanged persisted representation. | Original rollback/resource/refusal behavior passes without semantic TS retry or data migration; accepted selected rollback is reused. Automatic defaults stay separate. | [Source](#native-port-unit-contracts) | **E** — Consume the matching final package plus C05's resource disposition. Exercise explicit selection → actual operation → disposal → restart/TS reselection for one subsystem with unchanged persisted bytes, using its existing backend/bootstrap tests. Add only changed refusal/resource observations; no semantic-error fallback or default switch. |

### Development and deferred complexity

| Existing IDs / outcome | Unmet behavior | Defining owner; concrete input | Finite acceptance / reuse | Defining contract | Next bounded unit / dependency |
| --- | --- | --- | --- | --- | --- |
| dev-server:T18–T21; T30 consumer | Finish stable-origin generation routing, coalesced saves and authenticated draft-safe reload. | **Rust owner/gateway + browser + target adapter.** Accepted T14–T17/manual lifecycle and exact current generation/asset identity. | One sentence edit/burst/error/correction reaches the same tab without manual check/open; one active/latest demand, last-good state, retained drafts/login/data/schema safety and cleanup. | [Source](#development-extension-contracts) | **D** — T18 moves `dev-server/src/owner.rs::Generation`'s gateway to session lifetime; T19 independently adds one active/latest demand in owner/watch/state. T20 takes T18 identity, then T21 qualifies one real same-tab edit/burst/error/correction. Follow the [native extension order](#development-extension-contracts); accepted manual control/currentness is reused. |
| dev-server:T22/T23; conditional T27–T29 | Resolve measured remaining producer/capture/compiler/resource reuse. | **Rust capture/cache + bundle/compiler owners.** A demonstrated duplicate/cost and exact-key resource boundary; basic unchanged/currentness capture is already accepted. | Bounded reuse or evidence-based no-go preserves invalidation/cancel/currentness/output equivalence in one actual consumer. No unlimited incremental compiler or two-second target is added. | [Source](#development-extension-contracts) | **D** — Attribute one remaining cost/key in native capture/compiler/preview bundle first, then implement one bounded T22/T23 reuse or record no-go. T27 consumes T24/T25 CSS identity plus observed cost; T28/T29 require a measured finite compiler decision. No new cache before identifying consumed inputs, no reopening accepted unchanged reuse. |
| dev-server:T24–T26; T30 consumer | Finish checked change classification, CSS replacement and one bounded authorized region update. | **Target facts + Rust publication + browser/UI.** Only T18/T20 identity and actual schema/route/policy/binding compatibility used by the change. | Admitted CSS/region changes preserve drafts/focus/current authority/generation; incompatible changes safely reload. No generalized HMR requirement. | [Source](#development-extension-contracts) | **E** — Take T18/T20 generation and asset publication from the automatic-save row. T24 defines conservative compatibility; T25 CSS and T26 one explicitly selected authorized text/template class then proceed independently. Start native `preview/bundle.rs` and UI `browser/bootstrap.ts`; choose T26's class with an experienced owner before implementation. Failed fetch/revocation/pending mutations retain safe fallback. |
| CAN-COMPLEXITY-SCOPE-003; Complexity:T00–T04 | Finish the221 deferred original complexity identities as one scoped outcome. | **Existing complexity/lint owners across TS/Rust.** Original1070 cleanup census at /private/tmp/can-complexity-muse-20261018/baseline.json and closeout01c5e8b3f; tracked enforcement allowances are a different set. Recover residual/current-owner correspondence before bulk edits. | Behavior-preserving refactors meet existing≤20 rule and affected checks without suppressions/raised limits. Closeout849/1070 (468TS/381Rust) and deferred162TS/59Rust are branch-scope counts, not a fresh merged census. | [Source](../specification/DECISIONS.md) | **D** — First map the original1070 census to closeout `01c5e8b3f`, then the221 residual identities to current owners; inputs and method are in the [complexity decision](../specification/DECISIONS.md#2026-10-18--finish-the-released-rust-complexity-batch). Verified first body: State `invocation/registry.ts#compareGivenBounds` (original21, unchanged). Refactor one coherent file closure; measure residual/new helpers directly as well as the grandfathered CLI gate. |

### Draft frontend and generation consumers

| Existing IDs / outcome | Unmet behavior | Defining owner; concrete input | Finite acceptance / reuse | Defining contract | Next bounded unit / dependency |
| --- | --- | --- | --- | --- | --- |
| DFE-01 | Finish selected requirements→journey/resource/closure mapping and only demonstrated source corrections. | **Draft/frontend source owner.** Actual original required journey; action migration is already complete. | Selected batch has faithful routes/states/resources/requirements mapping without weakening original policy or examples. | [Source](#draft-frontend-acceptance) | **D** — Map CanTable's source/companion to its existing `playwright/app.spec.ts` first (currently only `/cafe` denial). Add the missing host reservation/seating journey contract without inventing source behavior. Use existing `selectedInventory`/coverage as discovery, not compiler truth; then repeat per app via the [DFE batches](#draft-frontend-acceptance). |
| DFE-02 | Finish selected-app/import-closure source generation and explicit authenticated preview/watch. | **Compiler + build-generation + native Dev.** Exact complete selected closure and released producer definitions. | CanTable36 complete-operand emission errors and31 one-file missing-provider findings are resolved or precisely disposed; current/failure/last-good behavior remains faithful. | [Source](#draft-frontend-acceptance) | **E** — Consume DFE-01's exact CanTable closure and the compiler's selected declaration/transitive emitted outputs. Then extend native `compiler.rs::admit_single_app_profile` and `capture.rs` to capture/watch that closure. The compiler/native selected-app handoff is missing local engineering, not permission to remove guards or revive TS orchestration; [DFE-02](#draft-frontend-acceptance) owns the join. |
| DFE-03 | Finish actual declared app resource/profile joins. | **Defining resource owners + Dev.** Only the selected app resource/profile outputs. | Actual success/refusal/failure/recovery runs through existing owners; no fabricated alternate resource layer. | [Source](#draft-frontend-acceptance) | **E** — Take one DFE-01 resource inventory plus DFE-02 checked artifact. Bind only that app's declared resources through their existing owners and observe success/refusal/recovery before adding the next family. Missing file/export/provider outputs refer to their canonical rows; a live-provider hold affects only that branch. |
| DFE-04 | Qualify real model-generation provenance and complete candidate acceptance for each draft category. | **Build-generation + draft/frontend + MCP host.** Required Sol6.1/medium/authenticated host and complete original source/reference payload. | Actual generation submission/provenance and complete candidate acceptance are retained. Accepted local engine, PromptStudio/persistence and100 handcrafted records do not establish corpus acceptance. | [Source](#draft-frontend-acceptance) | **E** — After the selected source/resource closure works, use accepted native `can gen` / `can validate` and `draft/can.gen.toml` with actual Sol6.1/medium provenance. Start CanTable style, then CanPromptLab's additional categories. Missing authenticated model/host capability holds that observation; no substitute handcrafted acceptance or other-adapter prerequisite. |
| DFE-06 | Finish actual desktop/mobile route/state/locale/theme capture and functional UX acceptance. | **Draft/frontend + browser reviewer.** Generated/current routes and selected meaningful workflow output. | All108 required references and functional accessible controls/prompt fidelity are inspected at their actual tuple; screenshot helper success is not application acceptance. | [Source](#draft-frontend-acceptance) | **E** — After one app's FP.QUALIFY/DFE-05 journey and generated output, use its existing desktop/mobile Playwright projects and `tests/e2e/drafts/visual.ts`. Inspect actual meaningful states against declared prompts/references, approve only inspected baselines, then expand app-by-app; 108 mappings remain the corpus denominator. |
| DFE-07 | Finish source-derived all-app saved-output CI/regression coverage. | **Draft/frontend integration + CI.** Accepted generated outputs and meaningful journey results from FP.QUALIFY/DFE-05. | 828 discovered cases have truthful category/selection/current-source coverage and no-model regression; discovery alone is not a passing corpus. | [Source](#draft-frontend-acceptance) | **E** — Take the first accepted DFE-01–06 app, add its saved-output run to existing CI, then extend selection as other apps qualify. Reuse `playwright.drafts.config.ts`, app configs and the existing runbook; discovery of 828 cases does not justify running all cases before the first useful no-model regression unit. |
| BGI-06 | Qualify remaining required Muse Code/Claude Code/OpenCode generation adapters and host submission. | **Build-generation adapter + authenticated operator/host.** Actual supported tool/model credentials and bounded request/MCP host interface. | Each required adapter proves authenticated bounded generation, host submission and actual OS no-write behavior. Reuse20 adapter controls; no tool/account substitution is implied. | [Source](../design/proposals/build-generation/implementation-plan.md) | **B** — One real authenticated adapter at a time: start `generation/adapters.ts::{adapterFor,probeExecutable}` and accepted adapter controls. Operator supplies supported executable/model/account; then verify host-MCP submission and actual protected-root OS write refusal. Muse/Claude/OpenCode observations are separately unreleased; no old coordinator restart or tool substitution. |
| BGI-13 | Complete the recorded agent-only Todo observation. | **Build-generation/Dev observation owner.** Exact original Todo source/operator/host tuple. | Original agent-only observation is recorded honestly; accepted local engine/PromptStudio/persistence criteria are reused. | [Source](../design/proposals/build-generation/implementation-plan.md) | **D** — Prepare and observe `examples/Todo.can` through the existing native generation/validation workflow and supported authenticated host. Record agent-only named/inline styling, whole-set retry and saved reuse, linking unchanged engine results. Stop on a concrete missing runner capability; do not repeat PromptStudio or create a new engine. |

### Composition, release and residual closure

| Existing IDs / outcome | Unmet behavior | Defining owner; concrete input | Finite acceptance / reuse | Defining contract | Next bounded unit / dependency |
| --- | --- | --- | --- | --- | --- |
| CAN18 outcome14; challenge:T41 current corpus component | Produce the missing post-release original24 composition result and truthful root attribution. | **Compiler capture owner.** Frozen exact producer/catalog/original-input closure after the released changes. | Complete real child exit/diagnostics; last retained complete212E6008 predates later batches. No zero-diagnostic or current-count claim is inferred from source merges. | [Source](#compiler-source-constraints) | **D** — One frozen post-release capture with the exact 24 operands and current compiler/catalog. The [durable argv](#next-original24-composition-capture--outcome14--t41) replaces dependence on temporary filenames. Retain actual child exit/completeness/root attribution, then stop; do not silently turn capture into an unlimited repair batch. |
| FP.QUALIFY; challenge:T37–T40/G3/G4; SEQ-025/026/040; DFE-05 | Finish full original app/companion required workflow matrices once each. | **Application integration + actual defining producer/receiver owners.** Only each app’s missing exact source/provider/file/context output, not every unrelated parent. | 49 intent ledgers plus original Chat/Creative/Approve/Email/Loan and127 frontend journeys prove required actors/grants/callback snapshots/history/denial/unknown/stale/rollback/replay/recovery. Reuse accepted Customer recover/Purchase/native examples; no reduced projections. | [Source](#service-and-integration-contracts) | **E** — Take one original app's specific emitted source/resource/provider outputs, then implement its missing role/fixture consumer and complete that app's required journeys. Start CanTable only after its selected closure/preview. Use existing app specs and [integration units](#service-and-integration-contracts); FP.QUALIFY and DFE-05 consume the same result once. |
| FP.INSTALLED-RELEASE; ports:C04.complete | Finish changed final source/producer/dependency/browser/vendor/native full installed release closure. | **Delivery + exact producing subsystem.** Final assets from the Rust delivery/native-constructor rows and explicitly claimed host. | Outside-checkout cold/full CLI/Worker and actual selected Values/Work binaries load correctly. Reuse accepted TS/runtime/manual/macOS/Linux inventories at their proved versions, without reopening package/Turbo cutover. | [Source](#service-and-integration-contracts) | **E** — Consume the exact changed final native/Values/Work assets, update `scripts/pack-install.mjs` and actual producer/package inventory, then run `node scripts/verify-install.mjs <archive>` for one claimed host. [Current owners](#service-and-integration-contracts) replace absent historical release paths. Public upload/default/retirement stays separate. |
| FP.UPGRADE-JOIN; SEQ-027; CAN18 outcome15/C21/S9-Q08 | Finish original predecessor→desired schema/default/lock/retained-work staged upgrade and recovery. | **Migration/lineage + State/Work + Dev.** Exact predecessor/desired output and pending-work inventory; only actual activation is separately held. | Bounded complete-state/work inventory, compatibility/refusal, fenced staging, interruption/recovery/rollback and source-current consumer pass with truthful online limits. | [Source](#service-and-integration-contracts) | **D** — `upgrade/apply.ts::applyUpgrade` is dry-run only; implement one persisted owner/predecessor/desired coordinator over State `migration/index.ts` first, then pending-work inventory and installed interruption/recovery. Existing State engine supplies staging/fences/recovery. Follow [integration units](#service-and-integration-contracts); live activation alone is held, not local backend engineering. |
| FP.SOURCE-CLOSURE | Finish only the still-unreviewed accumulated source/body/test-expectation and mixed-duty coverage. | **Defining source owners + independent review owner.** Exact retained unreviewed delta; accepted58 compiler-audit references and nine current consumer aliases are reused. | Caller/authority/failure/termination and ownership coverage resolves substantive findings; complete filetree checkpoint advances only after its original review is complete. No review-of-review work. | [Source](#service-and-integration-contracts) | **D** — Choose one actually unreviewed owner/delta from retained filetree and consolidation coverage, inspect code and expectations, resolve substantive findings, then the next. Reuse incremental accepted coverage; do not reconstruct all history or review verdicts. Missing precise coverage is an owner reconciliation item, not a new full-repository audit. |
| FP.FULL; challenge:G1/G2/G5/R01; ports:A11/V12/W08.3/P11/C01–C05.complete; SEQ-060–063 | Finish the remaining supported-release acceptance/reporting at the declared full scope. | **Integration/release + defining reviewers.** Concrete missing original outputs from the rows above; aggregate review never circularly blocks producers. | Required/conditional/deferred/declined duties, source/artifact/examples/runtime/installed/economics/upgrade evidence and unresolved findings are reconciled. This is one final consumer of prior results, not repeated tests or new intake packets. | [Source](#service-and-integration-contracts) | **E** — Consume each missing original app, installed, economics, upgrade and source-coverage result once in the existing finished-product record. Complete the original final release disposition after those outputs, without circularly blocking producers or launching another verification programme. Conditional/declined outcomes stay explicit. |
| description:D08 supplement | Complete the remaining supplemental description handoff/owned-resource closure. | **Description/reference owner; final handoff unassigned.** D01–07 behavior and all six independent findings are accepted; stale locale/root-build annotation is corrected in this reconciliation. | Record final truthful supplemental handoff/cleanup using existing records; no new parser/renderer/IDE/MCP source-repair assignment. | [Source](DESCRIPTION-REFERENCE-PLAN.md) | **D** — Description maintainer reconciles `description-reference-run/{tasks,review}.md` and `evidence/integration.md` with accepted six repairs and wind-down. Record the exact supplemental output/remaining owned viewer limitation or close it if none. No behavior rerun, source feature or historical-session restart. |
| muse-migration:C01/C02 | Finish finite legacy draft/desired-output migration acceptance and final owned closure. | **Draft migration source + independent acceptance/closure owner.** Actual released migration diffs and existing findings; the Volunteer material-change decision is counted only under FP.APP-ADJUDICATION. | Substantive actual-diff acceptance and exact remaining cleanup/retained-viewer limitation are recorded; no old Muse session restarts and runtime acceptance remains separate. | [Source](#legacy-draft-and-description-closure) | **D** — Review only unaccepted A02–A06/N10 actual app/design diffs, one coherent unit at a time, against existing accepted designs; root paths moved to `draft/apps/`. Resolve substantive findings with the current source owner. Reconcile C02 cleanup against completed wind-down, preserving any precisely identified viewer; Volunteer semantics belong solely to FP.APP-ADJUDICATION. |


## Actual human and external leaves — five gate groups

These are release conditions on matching outcomes, not five extra implementation assignments. An unavailable provider/model/host blocks only its exact consumer.

| Existing gate / affected outcomes | Missing output or decision | Owner and release condition |
| --- | --- | --- |
| CAN18 outcome17/C13; Dev G3/A7 benchmark | Required gpt-6.1-sol account/executor and original six-arm3D3J counterbalanced tiny intro-task protocol, medium/20min40k denominator tuple. Original D/PRETURN had zero inference; J returned HTTP400; arms3–6 are unrun. | Dev benchmark/human account owner supplies the required supported model and exact protocol. No substitution, favorable replay or rank-proposal implementation. [Dev plan](#development-extension-contracts). |
| Real provider/model/account leaves; SEQ021/022/024/043/046 and provider applications | Genuine selected transport/model/tokenizer/usage/cancel/reconcile/credential output unavailable for the particular original workflow. Local adapter/source work stays available. | Relevant provider/account owner supplies that exact supported profile and approved configuration. Controlled fixtures are labelled; no all-provider or all-account barrier. [Capability](capability-roadmap-20261008/README.md). |
| BGI06/DFE04 and named CAN18 outcome17/C22 host consumers | Required authenticated generator/tool/MCP host, or the particular GUI/editor/map/Images/browser/application tuple where absent. Selected V05 Node/ICU corpus is already closed. | Actual operator/host owner releases that named capability. Unknown other-host support is not an invented universal matrix. [Generation](../design/proposals/build-generation/implementation-plan.md), [compiler](#compiler-source-constraints). |
| CAN18 outcome18/C14 and C23 | Recipient/action-specific BDD3 returned/result/payload/as/disclosure/live/context/input-slot release; separately Task22 OUTBOX target/binding/deploy/source/revision lookup release. | Original human/policy/Testkit or target recipient owner releases only the named action/output. Unrelated examples or local consumer work do not wait. [Compiler held leaves](#compiler-source-constraints). |
| Backend adoption/default/physical TS retirement; activation/public deployment/publication | Actual automatic-default/retirement decision and separately the recipient/action-specific live activation/deployment/publication authorization. Native-source implementation is no longer held. | Human deployment/adoption owner releases the exact action. Local explicit-native output, contained mocked apply, packaging, inventory, validation and rollback work are not blocked by this leaf. [Rust current view](#native-port-unit-contracts). |

Engineering decisions are not silently escalated into human gates: J2’s exact typed transaction, Partner’s authorized lock edit, Volunteer material-change recipients, source business verdicts, reversible-effect protocol and measured cache/budget choices stay with their listed defining owners and existing consultation requirements.

## Proposed, optional or conditional — nine non-additive groups

| Existing IDs / idea | Current disposition and finite trigger |
| --- | --- |
| SEQ051 | Multisession resume remains conditional on an actual consumer and fair comparison with ordinary drafts. |
| SEQ053/054 | Business-calendar helper and repeated vocabulary/default graphs need the recorded two real working-app/model witnesses before new syntax. |
| SEQ057/058/059 | Compensation/package parameters/statecharts need two working reversal/same-protocol examples or an actual nested/parallel counterexample versus qualified flat alternatives. SEQ045’s required concrete recovery remains separate. |
| ports:W09; conditional SDK/forms/native mixed-Wasm | Scheduler is deferred; optional consumer/profile branches activate only for an actual matching need. Ordinary MCP/State native consumer requirements above remain required. |
| Additional package Rust opportunities / common ICU core | Shared Rust ICU, exact static Judgment parser, total-order State/generation-diff, demand-triggered File digest, migration/media/UI ideas remain comparisons/proposals until their recorded consumed-input/benefit decision. Accepted ICU sharing is not reopened. [Audit](../ideal-filetree-plan/rust-package-audit/README.md). |
| Optional dependency closure; typed Rent history | Both are unadopted proposals. Ordinary A05 import and A04 retained-fact migrations are accepted without adopting new optionality/history semantics. [Closure](../design/optional-dependency-closure-20261004.md), [history](../design/rent-history-growth-20261004.md). |
| Evaluation R1–R12 and research portfolios |120 evaluation items are complete. Recommendations and demanding-app/AI candidate portfolios are not automatic new implementation. Adopted descendants are counted only under their actual owning rows. [Adoption](../design/evaluation/ADOPTION.md). |
| Filetree R01–R08; DOC03–DOC06; conditional retirements | Future structural realization, setup/prose consolidation, Python/JSON/map/catalog replacement and optional evidence-storage dedup retain exact caller/parity/reconstruction triggers. This task consolidates overlapping planning/status documents; unrelated structural refactors and raw evidence retirement remain conditional. [Tree packets](../ideal-filetree-plan/tasks.md), [documentation](#service-and-integration-contracts). |
| Stronger Miniflare restart veto; extra dev ranking/optimization | Stronger pre-spawn/immediate inner-restart observation and rank-comparison proposals are not missing accepted T14–T17 gates. Additional T27–T29 changes need their measured go/no-go; original automatic-save/CSS-region requirements remain in the accepted list. [Dev](#development-extension-contracts), [ranking](../design/can-dev-jev-ranking.md). |

## Defining contracts and evidence

This document alone owns current outcomes, order, status, dependency handoffs and acceptance.
The former product/challenge/port snapshots, lane launches, run checklists and duplicated
README plans are removed; Git history preserves their historical execution narrative.
The detailed sections below are part of this same execution view, not another set of jobs.

Retain distinct technical responsibilities:

- [Language requirements](../specification/REQUIREMENTS.md), [design](../specification/DESIGN.md) and [grammar](../specification/GRAMMAR.md), [shared execution contracts](CONTRACTS.md), app `.can` sources/companions and original workflow/requirement ledgers define behavior.
- [Development state/protocol](../design/can-dev-server.md), session/error contracts and the benchmark protocol define interfaces and the exact held experiment; they contain no independent remaining-work queue.
- [Generation requirements](../specification/BUILD_GENERATION_REQUIREMENTS.md), [implementation contract](../design/proposals/build-generation/implementation-contract.md) and [frontend validation runbook](../draft-frontend-validation.md) define producer interfaces and how to run their consumers.
- [Description/reference representation](DESCRIPTION-REFERENCE-PLAN.md) remains because compiler source names this frozen contract. It has no status checklist.
- Original package-port manifests, capability contract/source records, [finished-product requirements](../ideal-filetree-plan/finished-product/requirements.json) and [workflow ledgers](../ideal-filetree-plan/finished-product/workflows.md) preserve detailed scope/identity and observations. They do not dispatch work or supply current totals.
- [DECISIONS.md](../specification/DECISIONS.md) owns choices/rationale; [filetree coverage](../ideal-filetree-plan.md) owns accumulated source/merge coverage. Neither is a second backlog. Raw qualification evidence remains at its original scope; deleted historical-plan citations use their Git version where evidence requires it.

One short compatibility pointer remains at the old build-generation plan path because
`scripts/audit-draft-frontends.mjs` emits that path. No other deleted plan receives a redirect stub.

## What was verified and what remains uncertain

The first reconciliation used tracked plan inventories, owning records, final handoffs and accepted results. This preparation then inspected current source/test entry points for all77 rows, with focused read-only help for source, services and native/dev families. It corrected retired/proposed paths, existing exact Decimal lowering, accepted durable export storage, later Identity commands and native dev ownership. The original complexity cleanup census was found; its exact221 residual mapping remains the first finite reconciliation unit, with one unchanged deferred function identified. No broad source audit, compiler build, application test, generation/JEV call or historical replay was performed. Documentation checks preserved all77 row IDs/order and the50D/22E/4B/1C totals, resolved81 added/migrated local links and anchors, and checked whitespace plus syntax of the three adjusted historical documentation scripts. Forty-six redundant files are removed. Three source comments now point to retained contracts; executable product code is unchanged. Historical source readers retain pinned Git inputs; the generator no longer writes a competing task Markdown list. These checks do not establish runtime readiness.

Counts describe this consolidated list’s distinct outputs, not a refreshed333-task status census. Historical base failures/timeouts (compiler20 fixture/catalog/qualification cases, TS base-matching191 failures/64 environment errors, UI resolution uncertainty, saved-result and staged recovery-module cases) remain qualification limitations at their recorded tuples; they do not prove current-main failures and are not221 extra complexity tasks. The specific Maintain timeout, retirement-hook refusal and absent post-batch original24 capture remain named current gaps. No full-application, full-port, full-host or complete semantic-review claim is made.

## Compiler source constraints

The headings below group the existing outcomes; they are not new task IDs. An unresolved discriminator is labeled as diagnosis, not promoted into a proven root cause. Diagnostic-family counts are retained capture facts, not post-merge remaining-task counts. Later accepted mechanisms above supersede older missing-mechanism descriptions; their original whole-page/workflow acceptance remains separate.

### Source ownership, authority and semantic identity — outcomes 3, 4, 8, 9, 13; C02/C03/C19

**Ready local work.** Defining owners: Compiler `analysis/scenario_disclosure.rs`, `codegen/ir.rs`, `scenario_decisions.rs`, `scenario_receipts.rs`; State invocation/mutation; Cloudflare `runtime/invoke.ts` and `runtime/native-read-boolean.ts`.

- Resolve the retained authority findings: hook value grants through commit and phase-A source-predicate authority through phase-B disclosure. These are statically traced risks awaiting an actual compiled-source discriminator, not proven runtime failures. Reproduce the specific original boundary; either repair it or close the concern with the required behavior.
- Restore exact source-owned semantic identity where the implementation selects incidental spellings: declared completion event identity instead of app-name allowlists. The reviewed event alpha-rename failure is concrete. Localized Alert sink classification belongs with the formatting root below.
- Finish the exact `CanMember` checked collection-call/source disagreement and `CanShift row.met` Boolean observer. No catalog credential is needed; current original24 has **no E6007**.
- Preserve original predicate-read policy execution where consumed. Registry-only predicate metadata fallback is intentional; it is not evidence the executable policy path is complete or permission to erase its predicate.
- **Outcome8:** finish remaining original ordered Boolean operation/policy admission consumers, including actual role expressions, short circuit, current roles and resolver failures, with CRUD `when` sealed separately. Reuse accepted Boolean/default/membership components. Absence of a dedicated current diagnostic does not close this original criterion.

**Exit:** the named original source/consumer retains exact owner, type, occurrence and current grants; equivalent inline/imported/helper spellings agree; denial/revocation and late-failure cases leave the required state/receipts unchanged. Never widen authority to make a compiler/profile gate pass.

### Query, helper and whole-body composition — outcome 5, shared 3/9/12; C02/C04/C19

**Ready local work; several causes still need isolation.** Owners: `scenario_disclosure.rs`, `scenario_queries.rs`, `scenario_receipts.rs`, `scenario_decisions.rs`, `scenario_feasibility.rs`, `js.rs`; State `scenario-query-plan.ts`, `scenario-query-selection.ts`, `scenario-receipt.ts`; Cloudflare `scenario-receipt-frame.ts` / `invoke.ts`.

1. **Closed at its original guard/body scope — CanCustomer recover:** `by=customer_manager`, `customer_staff(actor,org)` → positive `any(org.locations … can_work(person,location))`, then first/create-or-reactivate. `locations` is a **Location[] reference array** with an imported helper, not a stored-model scan. Custom role, current row/field authority through commit, helper context, lazy order, both branches and replay are validated by actual compiled Can. Reuse this output; do not reopen it as another helper prerequisite. The unrelated whole-cohort IR gate no longer orphans this independently sealed observer; ordinary predicate/send gates stay strict.
2. **Additional demonstrated discriminator:** a leading positive stored `require any(p.C …)` plus a companion first produces E6008; the debug disclosure declines with “query closure is not supported” before the ANY enters the plan. This proves that finite source-inventory gap only. It does not prove that mirroring the stored-ANY recipe implements recover's reference-array/helper closure.
3. **Original CanCustomer accept:** compose verified-email/address/status/expiry/parent guards, `has_role` and location `all` helpers, the accepted negated ANY + first prerequisite, create-or-reactivate, invitation update and emission. Keep the actual authored inputs and examples. The full operation is still open.
4. **Other first-query refusals:** identify each original consumer's first declined defining function and group consumers sharing that mechanism. The current 25 occurrences remain after the two private-handler batches (originally87, including67 handler sites). Remaining consumers include public operations, model-change hooks, periodic handlers and derive queries; these are neither25 tasks nor proof of one common fix. Derive consumers must not be forced into scenario-only receipt profiles. Handler sites consume the required hook output below, not completion of all hook work.
5. **Remaining query-order forms:** consume the original expression ordering and required example expressions; preserve complete domains, stable order and declared limits. Extend only demonstrated original profiles.

**Dependencies:** reuse the accepted query/enum/navigation/void engines. Take only the specific source/authority or typed handler output the consumer needs. If the reference-array receipt representation is genuinely missing, name that exact design decision and compare existing mechanisms before introducing a carrier; use the required JEV consultation for a difficult design choice.

**Exit:** each targeted original operation/derive/handler compiles through its complete original closure and executes the required success, absence, mismatch, denial, rollback/replay and recovery cases using actual compiled Can. A reduced probe can close a prerequisite, never the entire original workflow.

### Whole-hook admission, context and effects — outcome 12; C07/C02/C03

**Ready local work.** Owners: Compiler `ir.rs`, `model_policies.rs`, `model_policy_profile.rs`, `js.rs`; State `mutation/pipeline.ts`; Cloudflare `runtime/invoke.ts`.

- The original retirement-hook consumer still refuses compilation. Trace its first unsupported node; reuse the accepted Resource/Location/WeeklyHours and Success hooks plus Employee→Shift delivery above. Whole-policy fallback means the historical 22 contextual-now errors do **not** establish 22 missing clocks.
- Complete the required query/helper source closure, original event.before/event.after/context transfer and the demonstrated staged-value content gap (including Rent policy snapshot sequence). Consume the query output needed by that hook, not the whole query backlog.
- Finish the reviewed helper discrepancies: top-level identity-only reference helpers must not require an unrelated parent, and imported reference fields must retain inline/helper parity.
- Connect original parent/staged reads and emissions through their actual lifecycle owner. Reuse accepted parent/query/Work engines. Preserve initiating author, null actor, guard/effect order, cancellation and failure boundaries; later handler failure must not undo an already committed source.

**Exit:** the complete targeted original hook graph executes through the canonical pipeline, with current consuming-site decision/value grants, before/after/staged values, late failure, replay and cancellation tested at the declared scope. No blanket scope-2 or all-hooks requalification.

### Standard handler carriers and cross-operation calls — outcomes 9, 11; C02/C04/C06/C18/C19

**Ready local producer work.** Owners: Compiler `ir.rs`, `scenario_calls.rs`, `scenario_receipts.rs`, `js.rs`; canonical State/Work invocation and Cloudflare call/verified-event receivers.

- Finish Invoice `result`, `collected`, `refunded`, `checkout_cancelled`, `reconciled` at their actual declared trigger/carrier joins. The five failures are not proof of one missing carrier. Use declared source/event identity, protected fields and genuine verified terminal payloads; source metadata alone is not native receiving.
- Admit the seven original calls: `propose.revise`; `rent_reservations.prepare/arrive/depart/cancel_booking`; `maintain.report/inspect`. Each needs the exact child signature/plan/output, not the target application's whole plan.

**Exit:** actual original parent/handler consumers preserve caller/context, protected inputs, returned/null values, source order, current authority and the declared transaction/failure/replay boundary. No direct-handler bypass or pretend atomicity across independent owners. A missing real provider tuple holds only its named receiving test, not local emission/adapter implementation.

### Dispatch guards and original execution closure — outcome 10; C02/C04

**Ready local work.** Owners: `send_guards.rs`, `scenario_decisions.rs` / `FreshSourceContext`, `scenario_receipts.rs`, `js.rs`; canonical sealed-dispatch invocation receiver.

- Diagnose 23 exact guard/receipt/Rule correspondence refusals at their source owner.
- Diagnose the four whole-IR mismatch sites separately: Success109/118, Shift250, Maintain354. Do not alter the authored predicate to bypass a stale/fresh-source mismatch.
- Finish the original Maintain retry/replay consumer: assignment and genuine failed-mail receipt pass and retry commits, but its complete retry/replay run exceeds600s. The parent-only CPU profile cannot attribute child/workerd cost; no cause or speculative speed repair is accepted. Preserve current authority, once-only delivery, retained receipt and recovery behavior. Reuse the accepted persistence and bounded32-hop compiled SEND slices.
- Correct the retained stale-version test: use a valid current version and exact expected refusal, including current membership revocation. An arbitrary early error at hardcoded version1 is not permission-denial evidence.

**Dependencies:** the exact scenario/query/hook/handler closure consumed by a send; no wait for unrelated source profiles. Formatting supplies frozen content where used.

**Exit:** the targeted original send stages exactly once only after its guards, persists declared results, preserves source order and frozen content, and leaves no writes/outbox on required rejection/rollback; retry/replay/revocation stay correct.

### UI source-to-factory and collection-consumer joins — outcome 6; C10/C11/C02

**Ready local work.** Owners: Compiler `ir.rs` / `js.rs`; UI `collections.ts`, `settings.ts`, `leaves.ts`; owning Interfaces contracts; Cloudflare `native-ui-query.ts`.

| Required original profile | Remaining scope / prerequisite |
| --- | --- |
| Filters | The six scalar/contained-parent filter/default combinations are accepted above. Remaining original page qualification must consume those outputs; add a mechanism change only for a demonstrated unsupported original selector. Historical16 diagnostics are not16 remaining repairs. |
| Collection domains | Value/result-array domains remain outside the accepted grouped stored-query collector. Reuse the accepted grouped Event/list/table source mechanism; preserve original row/context/types instead of relabeling arrays as stored scans. |
| Archive and board continuation | Recorded archive/include and Board page mechanisms are accepted above with actual compiled HTTP/cursor/current-authority controls. Whole original pages consume these outputs; they are not new archive/pagination implementation tasks. |
| Preferences | Inline bool/text/int editors, nullable clear and save/reload are accepted above, including recorded Member/Rent/Leave shapes. Any independent inventory-free text/date settings defect and complete original page consumers remain; do not reopen accepted editor/storage behavior or manufacture empty enum options. |
| Stat/history/skeleton | Three multi-value stats, Invoice owning-row history and Field skeleton at existing component owners. |
| Containers | Report/Field collapse and Event compact hero have nonempty authored suites. First repair rejected child domains/skeleton, then check any independent container remainder; do not invent an empty-content redesign. |
| Runtime review findings | Nullable/empty copy labels must not crash, and an authored false steps-item guard must withhold its content. Reuse the closed toggle fix. |
| Original operation-bound forms | Retain current selected-row versions, actual authorized operations and interaction semantics; a rendering-only component is insufficient. |

**Dependencies:** exact collection/source/field contract outputs only. UI rendering can progress independently of unrelated hook/dispatch work. A compiler IR/JS change uses the compiler writer, not a competing UI writer.

**Exit:** each targeted original page/profile compiles and its emitted installed UI/HTTP/State path proves authorized results, authored position/order, request/default/clear semantics, empty/error behavior, pagination, field denial and final revocation as applicable. Never replace the emitted query/policy/columns with handwritten handlers to claim original closure.

### Typed localized sinks — outcome 7; C10/C17, C16 only for temporal consumers

**Ready local work.** Owners: Compiler `js.rs` source classification plus owning typed presentation/outbound adapters and shared localization producer.

- Consume the eight original formatted business statements and one formatted call argument through their declared human/outbound sink contract, with locale, escaping and freeze/order semantics.
- Resolve the reviewed canonical Alert-operation spelling exception through the owning declared contract; an alias/rename alone must not change classification. Its final executable discriminator currently also needs the relevant dispatch closure.

**Exit:** the original source reaches the real declared sink with equivalent locale/text and failure behavior; outbound retry uses frozen content. Only a temporal sink requiring a missing release dataset depends on that exact C16 output. No blanket dataset hold on ordinary formatting.

### Original composition and retained native consumers — outcomes 14, 15, 16; existing C/reference owners

These are required acceptance outputs, not a second feature backlog.

- **Original24:** after a relevant released producer batch, run the unchanged authored composition once with a pinned compiler/catalog/consumed-input closure; retain the actual child exit, complete diagnostics and full source/multiset comparison. Regroup changed residuals at their defining owner. Reaching zero compiler diagnostics does not itself close runtime delivery.
- **Original executable workflows:** required success, rejection, late rollback, replay, current authority and recovery through actual compiled modules and canonical installed consumers. Reuse CRM promotion, Partner source/invariant/page, accepted PromptLab/File and other unchanged evidence at its exact scope.
- **Two recorded UI golden failures:** `catalog_factories_lower_from_source`, `golden_expenseflow_structure`. Check against the changed producer and intended source contract. Historical passes do not establish current qualification; do not blindly rewrite goldens to current output.
- **Partner capture / lock editing:** capture submission remains. The old lock-edit fixture bypasses entry locks and selected Models expose no update operation. The exact local source/workflow decision is **which authorized original operation, if any, performs the edit**. Resolve with the defining source/Testkit owner: if immutable behavior is intended, correct the test scope; if editing is required, identify its legitimate source operation first. Never invent update grants.
- **Maintenance/lineage (outcome15/C21/S9-Q08):** only named predecessor→desired-revision, defaults/locks/interruption/recovery and retained-work consumers. Missing local engines are ready engineering. Actual unavailable predecessor/activation-host output holds only its consumer; no activation is authorized.
- **Retained integration consumers (outcome16):** original verified Payments/Mailbox ingress; generation/cancel/reconciliation and native/optional Chat receiving; frozen Judgment request/options/association/results; already named Corpus consumers. Link each to the exact local producer or real receiving tuple it consumes. Do not mark all of outcome16 externally held.
- **Opaque File receiving (C09, shared outcomes14/16):** Capability's historical declarations plus the original Dev/Files receiver own the remaining origin/handler/result/raw-default/lifetime/reopen and all-writer consumers. Require the actual opaque receiver/current-authority/retirement output; preserve no restoration replay and permanent retirement. Accepted File/Images/array/deferred/retirement components remain closed; metadata snapshots do not close native lifetime behavior.
- **Configured installed routes (C12, shared outcome14 and C22):** deployment/host contract and Dev own the named mount/action/static/poll/auth/Files routes, using the actual released app/source/configuration. Prove supported original installed routes plus missing/foreign configuration refusal. Reuse configured-root/Office source acceptance; do not expand to an all-host matrix or treat a missing local route engine as an external hold.
- **Emitted suites and routing (C15/S9-Q07, outcome14):** Testkit/Dev consume actual source-owned expected rows and canonical invocation/request/returned-payload/command outputs. Execute the original rows, deliberate negatives and cleanup in isolated current scopes; zero-row substitution is not acceptance. Keep only the exact C14 parts held and continue policy-free consumers.
- **Typed receiver handoffs (SEM-R08; C03/C06/C18/C19, outcome16):** the defining Capability/source producer and actual State/Dev receiver own the remaining named nominal/facade authority, scalar/default/server/public-bytes joins. Consume the original declaration and frozen receiver output with current authority and failure behavior; reuse closed scalar/default/containment components instead of reopening them.

| Retained reference | Required consumer output linked to the sections above |
| --- | --- |
| OR-06 | Original generated suite/invocation/disclosure/disposal and named GUI/application consumers; Testkit/Dev, including the File/route outputs they actually consume |
| OUT-R05 | Named supported host/browser map navigation and attribution; Dev/editor consumes released source/routes and the exact host tuple |
| S9-Q01 | Original human/outbound localization sink output; owning UI/capability/Dev consumer |
| S9-Q02 | Original order/default/short-circuit/failure, dispatch/event/hook/container execution; consume the corresponding shared compiler/runtime repair once |
| S9-Q05 | Named temporal/presentation handoff from the exact released Values/runtime tuple; C16/C17 |
| S9-Q07 | Actual generated example/request/returned-payload/command routing; Testkit/Dev, with only exact BDD3 scope held |
| S9-Q08 | Original page current-row admission, migration/lineage and named browser/application consumers; source plus durable/native receiver |
| SEM-R05 | Actual timezone membership/data and required formatter context at the pinned Values/runtime tuple |
| SEM-R08 | Named nominal/facade/scalar/default/server/public-bytes producer-to-current-receiver handoffs above |

These are links to existing acceptance outputs, not nine new programmes or host/provider matrices.

The [five shared gate groups](#actual-human-and-external-leaves--five-gate-groups) apply only to their named consumers. Compiler diagnostics are local engineering inputs; an incomplete capture is not a new diagnostic total.

### Next original24 composition capture — outcome14 / T41

The next bounded unit is one complete capture of the released producer changes,
not another source-repair batch. Freeze the actual compiler, catalog and these
original operands; reuse compatible built output, rebuilding only if stale.
The retained argv at `/private/tmp/cancrm-helper-invariants-card-20261015-argv.json`
was present during planning. Its durable operand spelling is below so removal of
that temporary file does not become an external blocker. `CAN_COMPILER` must name
the selected current compiler executable, not the obsolete temporary binary from
the historical argv.

```sh
"$CAN_COMPILER" compile --format=json --native-scenario-receipts \
  --catalog=packages/values/dist/catalog.json \
  draft/apps/CanCRM/CanCRM.can draft/apps/CanCustomer/CanCustomer.can \
  draft/apps/CanBook/CanBook.can draft/apps/CanPropose/CanPropose.can \
  draft/apps/CanAffiliate/CanAffiliate.can draft/apps/CanInvoice/CanInvoice.can \
  draft/apps/CanMember/CanMember.can draft/apps/CanRefer/CanRefer.can \
  draft/apps/CanRent/CanRent.can draft/apps/CanReport/CanReport.can \
  draft/shared/Employees.can draft/shared/Locations.can \
  draft/apps/CanExpense/CanExpense.can draft/apps/CanPurchase/CanPurchase.can \
  draft/apps/CanSuccess/CanSuccess.can draft/apps/CanDesk/CanDesk.can \
  draft/apps/CanEvent/CanEvent.can draft/apps/CanShift/CanShift.can \
  draft/apps/CanLeave/CanLeave.can draft/apps/CanContract/CanContract.can \
  draft/apps/CanMaintain/CanMaintain.can draft/apps/CanStock/CanStock.can \
  draft/shared/Suppliers.can draft/apps/CanField/CanField.can
```

Retain the actual child exit and complete diagnostic/artifact envelope in the
existing capture location; record completeness/omissions and root attribution in
this record. A tool timeout or incomplete output is not a new diagnostic total.
Allow the recorded roughly ten-minute capture scope; do not substitute the
30-second all-draft audit or reduce operands to get a passing result. Stop after
the one valid capture and assign any changed source root to its existing owner;
this outcome does not authorize silently repairing all discovered errors. No
capture was run during task preparation.

## Native port unit contracts

These unit contracts belong to the rows above. Implementation remains paused.
Keep the original outcome IDs and acceptance, with these coherent internal units:

1. **P04–P08:** start in `packages/cloudflare/src/preparation/host.ts`
   (`runNativeDeploy`, `ensureBundle`, `finishNativeDeploy`). `LOAD_MODULES`
   currently obtains a completed TS bundle. The Rust job already accepts ordered
   `layers`, `authoredMaps`, `artifactFacts` and `PUBLISH_NATIVE_MODULES`.
   First wire actual raw layer/bundler observations into that input; next add the
   required frontend/browser/resource facts at their demand positions; finally
   consume Rust constructed bytes/digest/plan/publication through
   `PublicationSession` and `publishDeployAndApply`. Remove the duplicate finished
   TS construction only when its native consumer works. Preserve partial-write,
   cancellation and evaluation order. Existing `preparation/tests/{modules,
   modules_facts,outputs,vectors,protocol}.rs` and Cloudflare
   `test/preparation-{inputs,shared-phases,protocol,publication}.test.ts` cover
   the seams. Extend one real browser/MCP artifact witness: the current
   `conformance/preparation/workloads.mjs` artifact has neither pages nor callables.
2. **A07–A09 / V03–V07:** qualify one still-unaccepted original operation/profile
   through its genuine caller, then move to the next. Exact binding/public routing
   already exists in `packages/values/bindings/{backend,carriers,exact-route}.ts`;
   structural validation exists in `bindings/validation.ts` and
   `semantics/src/{profiles,validation}.rs`. Do not rebuild these mechanisms from
   the old absence descriptions. For validation, connect one demanded codec or
   host predicate at its original evaluation point, retaining result identity,
   defaults and disposal. Use the existing exact differential corpus and affected
   `validation-binding`, `validation-join`, `owned-input` or native input-validation
   tests; a narrowed public compatibility domain requires an explicit decision.
3. **V06/V08/V09:** State's `invocation/registry.ts::validatePreparedInputs` and
   `admission.ts::validateCallInputs` still call TS validation. Join the native
   plan/token after the existing replay/age/authority gates without changing the
   State-specific scalar/version/ref/default profile. Separately connect ordinary
   `packages/interfaces/src/mcp/server.ts` to `mcp/prepared.ts`'s owned plan path;
   preserve MCP framing and sealed handles. Existing State `owned-admission` and
   Interfaces `owned-mcp` / `owned-http-validation` tests plus Cloudflare's
   `prepared-validation.workerd.test.ts` are the focused consumer anchors. Reuse
   accepted HTTP27/27; do not wait for every Values profile.
4. **W02–W06:** thread `createWorkKernel({backend:'wasm',module})` through one
   actual F5/F7 durable consumer whose helpers currently default to `tsWorkKernel`.
   Extend selection to the remaining required families after that real join.
   Use Work's `test/state-fanout/t34-f5-*`, `test/dispatch/t34-f7-*` and Cloudflare
   `src/runtime/t34c-work-installed.integration.test.ts`; preserve transaction and
   authority ownership. Pure family/facade tests are already accepted components.
5. **P09 / C04 assets:** package the specific final producer output and matching
   glue/import inventory, then qualify its actual installed consumer. Preparation
   uses `packages/cloudflare/scripts/verify-preparation.mjs --dir <stageDir>`;
   Worker asset joining uses `node scripts/verify-installed-worker.mjs --skip-build`
   after the final outputs exist. Do not claim final binary acceptance from an
   earlier selected helper binary. One claimed host is a finite unit, not a demand
   for an invented platform matrix.
6. **C05 / rollback:** choose one original complete-call workload and its TS
   comparator/budget before measurement, then compare the final selected tuple.
   Preparation's existing `conformance/preparation/differential.mjs` supports
   `--run --cli … --backend native|prepared-ts --out …` and `--compare … …`.
   Old proposed Values/Work `measurement/` runners do not exist; add only the
   smallest owner-local observer needed. Record retain-TS/native-reuse/adoption
   disposition, then exercise explicit selection → operation → disposal →
   restart/TS reselection against unchanged persisted bytes for that subsystem.
   No semantic-error fallback, automatic default or public deployment follows.

Use experienced executors for raw construction, admission ordering and durable
joins; a released single-profile fixture, packaging or measurement recipe can be
executed by Luna. No tests or comparisons were run by this preparation update.

### Native preparation completion criteria

**Original scope:** P04–P09, remaining P10/P11 implementation/qualification/disposition,
with C04.preparation-join and C04.native-release consumed at their actual outputs.
Accepted CLI/integrity source `4ed0d38fe`, facts `1e018e714`, module/plan wiring
`6fb752375` and release alignment `c105bf2c4` remain inputs, not repeat assignments.

**Outcome:** real installed `build`, `deploy --preview` and contained confirmed
mocked apply use one retained Rust job for the current admitted preparation
policy, module/package construction, final identities, plan and reviewed bytes.
The host no longer gives Rust a finished TS bundle or supplies an independent TS
bundle for publication. Current selected scope includes JS and browser resources;
Values/recovery Wasm in preparation remains an explicitly conditional mixed profile.

**One coherent implementation, with internal activities rather than new gates:**

- Complete native-route semantic artifact/companion admission, indexes, compiled
  identity, lockstep and preparation compatibility from host-read lossless data.
  Preserve filesystem/JSON syntax attribution and original lazy reads, including
  the current local-defaults reload. Remove native-route dependence on TS semantic
  loader/lockstep work; retain activation's own compatibility/authority gate.
- Complete current module construction: ordered layers, path/reserved/alias rules,
  selected producer import rewrites, source-map composition/inline suffixes,
  portable assembly metadata, frozen assembly registration/literal import switch,
  generated facade/artifact modules, markers and loadability/link policy. Existing
  Rust stager/renderer helpers lag current source and must be updated, not assumed
  complete because their APIs exist. The accepted JS frontend supplies exact
  observations, including any minimal additional rewrite facts needed; no second
  JavaScript parser or generic AST framework is selected.
- Complete current browser package preparation: selected resource inventory,
  generated client/style inputs, http-assets module, appended browser metadata,
  resource manifests and final package layout. Owning UI/browser/catalog producers
  remain authoritative. Host executes actual bundlers at the original demanded
  positions; Rust owns migrated deterministic validation/templates/assembly.
- Retain constructed buffers through final v1/resource identity, plan, prior-plan
  demand, exact review/config and publication handoff. The old digest-only proposal
  is absorbed here. Host publishes those exact prepared outputs through existing
  contained writers and mocked apply, without rebuilding in TS. Preserve missing-
  worker legacy main/zero producer calls, preview precedence, compiler gate, error
  attribution, cancellation, cleanup and the original partial-write/apply policy.

**Defining files / writer:** one native integrator owns
`packages/cloudflare/preparation/src/{artifact,modules,job,plan,render,review}.rs`,
necessary existing protocol/input modules and matching
`packages/cloudflare/src/preparation/`. The same stream owns the necessary pure/host
split in `deploy/{bundle,module-maps}.ts`, CLI and package-local conformance/scripts.
Shared bundle/release edits have this one delivery writer; compiler/runtime business
changes remain foreign. Existing source-map, frontend and UI producer contracts
are inspected at the actual cutover; no optional producer project is added.

**Finish once:** affected semantic/byte/order cases; one frozen installed fixture
with real operations/MCP, a page/browser mount/style and edited source maps; TS/Rust
final module/resource/plan/config equality; run the produced Worker and MCP handler;
preview and contained confirmed mocked apply consume those same outputs. Qualify
the changed binary outside checkout on the claimed Darwin/Linux hosts and retain
honest supported-host limits. Reuse unaffected executable-integrity controls and
accepted rollback; measure full-job resources using the existing C05 procedure,
record the original P10/P11 scope ledger, and stop. No public provider call occurs.

**TS intentionally retained:** file/package reads, exact-source parser/scope
libraries, actual bundlers, owning catalog/UI/browser producers, activation, CLI
presentation, executable bootstrap, contained filesystem publication and external
apply. Public synchronous TS preparation helpers may remain for reference/rollback.
Keeping a whole TS module constructor behind a renamed callback fails this outcome.

### Exact Values completion criteria

**Original scope:** remaining A01–A11 required outcomes; shared A/V assembly and
actual C04 Values assets. Preserve accepted integer/ASCII→CSV and full existing
native numeric/temporal/aggregate dispatch. This is not a rewrite of already
implemented arithmetic and not another scalar smoke project.

**Outcome:** every selected exact operation crosses the real synchronous Wasm
boundary with original public structural carriers/classes, error ownership and
safe pre-evaluation profile routing. Full package/stdlib/generated helper consumers
exercise it; the whole-input consumer joins owned validation below. Do not limit
completion to the current six-operation TS comparison registry.

**One coherent implementation:** finish full binding/comparison registry and
carrier/error/lossless transport; join all selected integer, decimal, money,
temporal, numeric aggregate/comparison and scalar-codec operations; wire the real
package/stdlib profiles and supported generated helper chains; deliver one final
binding asset closure. Preserve arbitrary raw BigInt inputs, operation-specific
narrowing/guards, half-even rounding, final-only sum bounds and original winning-
object identity. Stored Decimal scale -0 and dynamic UTF16/number diagnostics must
be preserved under the existing full contract: transport loss is a bug to fix,
not an implied new exclusion. Any proposed narrower compatibility policy needs
its exact decision and cannot silently redefine full completion.

**Owners:** `packages/values/semantics/src/{numeric,temporal,aggregates,codecs,transport}`,
existing bindings/carriers/bootstrap and public numeric/stdlib routing; currency/
catalog/contracts keep their existing defining producer. One Values integrator
serializes Cargo/module/binding/generated assembly with validation. Algorithm and
consumer work can overlap using released interfaces; validation does not wait for
A10/A11 paperwork to receive an already proved numeric codec.

**Finish once:** whole selected operation differential over the actual binding,
carrier/error/evaluation/identity controls, supported generated/stdlib caller and
the real whole-input HTTP consumer (qualified with validation, counted once), final
installed Node/Worker assets, complete-call resources and persisted/profile rollback.
Use existing fixtures/observers and accepted int/CSV results; do not replay unchanged
ICU/Work/preparation suites. Report remaining host-observable compatibility domains.

**TS intentionally retained:** public guards/getter order, construction/freezing/
error reconstruction, arbitrary observable object/array shells, nonnumeric equality,
identity-returning orchestration and default/reference implementations. A selected
safe call must actually compute in Rust; a façade delegating all work to TS fails.

### Owned validation completion criteria

**Original scope:** V03–V09 and required V11/V12, with V06 profiles and the original
V10 conditional/deferred producer disposition. Reuse accepted ordinary TS serving
correspondence, plan/default ownership, source identity and request cleanup. Those
are foundations, not native validation execution.

**Outcome:** a complete Rust owned interpreter/codecs and required policy profiles
run at the actual HTTP handler and State admission/read points, with canonical
invocation and durable replay intact. Implement the ordinary MCP profile at its
original scope; actual SDK/form adoption remains governed by its originally
conditional producer requirement, with an explicit disposition rather than a false
execution claim. No new HTTP server or SDK-provenance project blocks ready HTTP/State.

**One coherent implementation:**

- Implement the missing interpreter and structured codecs in the shared Values
  core: nested contracts/unions/arrays, presence/default/trim/bounds/ref behavior,
  ordered accumulated violations, normalization/materialization and retained-result
  encoding at its real consumed seam. ProfileHost currently implements ownership/
  plan lifecycle, not validation. Prepared TS codec/validation delegates are the
  comparator, not the native implementation.
- Complete current owner-plan information: lossless names/text/default metadata,
  aliases and currently owned format/distinctBy/excludedIds duties that the old
  prepared plan rejects. No current full-owner claim may silently drop them.
  Preserve default/array/Decimal identity and absence/null distinctions. Host URL,
  Intl/locale/timezone predicates run only when demanded at the original position.
- Join existing HTTP framing/binding, State generated input validation and ordinary
  MCP profile actions to genuine Rust execution, preserving distinct errors and
  deferrals. Actual handler/parser/loader ownership establishes provenance; freezing
  arbitrary input does not. State raw hash and receipt replay precede normalization;
  age/auth, ordered reference loads, revision/archive/fence checks and atomic commit
  retain their owners. Selected mode is fixed before evaluation, no TS retry.
- Finish ownership generations, bounded input/plans/calls, stale/foreign/disposed
  refusal and success/error/cancel disposal at the actual request/call seams.
  Preserve legacy unknown-input behavior through declared preselected compatibility
  routing; never use a new bound to silently reject a previously valid legacy call.

**Owners:** `packages/values/semantics/src/{input,plans,profiles}.rs` and the
validation module/operation dispatch, `values/src/prepared/`, matching bindings,
`interfaces/src/{envelope,http,mcp}` existing evaluators, State's
`invocation/{prepared-inputs,admission}.ts` responsibilities and necessary owning
Cloudflare handler joins. Exact filenames follow current owners; proposed missing
modules are created only to implement these existing duties. One Values assembly
writer and one shared runtime writer prevent collisions; they release concrete
interfaces/edits as soon as ready, not entire parent plans.

**Finish once:** actual owner schema and protected parser-produced input pass full
create/update/codec profiles through genuine installed Wasm; actual HTTP operation
and State mutation/read plus durable receipt/backend-swap replay; competing-error,
default/clone/ref/permission/source/lifetime controls at the changed seams; complete-
handler resources and rollback. Share the numeric whole-input result with Values.
Report any genuinely unexercised optional SDK/form branch separately. No default
activation or TS deletion is necessary for the explicit selected Rust route.

**TS intentionally retained:** parser/transport ownership, WHATWG/Intl predicates,
public arbitrary objects, error/default object reconstruction, raw hashing/replay,
authorization/reference loading and storage/invocation authority. A TS schema-core
call hidden under a Rust-selected profile fails this outcome.

### Work transition kernel completion criteria

**Original scope:** remaining W01–W08 required outcomes, especially W02.5/W03/W04.4,
W05 asset/consumer joins, W06 State/F7 handoff and W07/W08 original resource/rollback
outcomes. W09 scheduler stays deferred. Seven registered Rust families already
exist; production binary/facade currently selects recovery only.

**Outcome:** rows, retry, recurrence/every, lifecycle, receipts, recovery and linkage
execute the selected closed-data calculations in Rust through actual Work, State
and Cloudflare callers and final installed Wasm. A family registration or standalone
differential is insufficient. Keep these together: they share rows/linkage/ABI,
asset delivery and runtime writers; separate tiny family gates would strand halves.

**One coherent implementation:** finish current closed facts/error/opaque-reference
joins; extend the existing producer/bootstrap/transport to the full selected families;
route actual Work receipt/commands/every, State row/outcome/checkpoint/linkage and
F5/F7 durable consumer calculations; deliver one genuine final asset/import closure.
Carry current generation/queue/mail/File provenance and State Text/Image/Judgment
receipt contexts. Old historical row codecs cannot wholesale replace these owners.
Retain original pending-pin versus executed-attempt policies, callback/RNG/evidence
short-circuit order, original thrown identity, sync signatures, Work JSON-safety-
before-clone versus State clone-only, and call-local opaque result identity.

**Owners:** `packages/work-kernel/{decisions,src,bindings}` and the existing Wasm
producer, matching pure joins in Work kernel/receipt/commands, State fanout/receipt/
ports and Cloudflare's owning runtime seam. State retains live lifecycle/member/
history reads, grants, retention, admission and transaction authority; Cloudflare
retains guard/authority rechecks, clocks/provider effects, fenced claims and commits.
Claim and child execution stay separate units; child outcome/checkpoint and its
existing domain/history/replay/outbox/schedule effects remain one atomic unit.

**Finish once:** changed-family Rust/TS differential and fault/identity traces,
affected Work/State owner cases, actual final installed package/staged workerd binary,
F5/F7 D1/DO winner/refusal/atomic child/crash-restart/progress cases and persisted
byte/backend rollback. Measure complete calls with existing observers and record
original W08 reuse/benefit disposition. Reuse accepted planRecoveryScan durable
qualification, fanout consolidation and ten-helper installed results unless a
relevant source change invalidates them. No optional scheduler or new loader project.

**Concrete dependencies:** final matching ABI/binary/export asset output under
C04.work-assets and a stable released `invoke.ts` capture closure. W06.runtimehandoff
and V09.1 sequence shared writers; neither requires all validation acceptance.
C04.complete/C05.complete consume these outcomes and cannot block them circularly.

## Development extension contracts

The accepted native state/protocol contract is in [the development design](../design/can-dev-server.md). Only the extension units below remain; original T14–T17 acceptance is reused.

#### T18 — Session-lifetime protected origin and generation routing

- **Owner:** Rust preview gateway and generation selection, A, consuming C's
  Workerd readiness/release interface. Current `dev/preview-bridge.ts` and
  `preview-builder.ts` supply behavior to preserve, not a second gateway owner.
- **Prerequisite output:** T14 safe-origin/promotion interface and release of its
  builder hook edits; current protected access and retained-state behavior (T09).
- **Remaining change / observable outcome:** own the listener/access state at the
  session, configure every candidate's auth host with that same origin, and select
  only a ready current candidate. Pin each request to one backend; bound retirement
  and compatible asset retention so an old document cannot mix incompatible
  resources. No backend at startup means unavailable. Token issuance stays explicit.
- **Checks / completion:** same origin across two valid replacements; protected
  bootstrap/expiry, Identity/CSRF/host refusal and independent-session isolation;
  in-flight read/mutation, failed/superseded candidate, asset mismatch and retirement.
  Never replay uncertain mutation or reuse permission results. E1 is consumed for
  repeated failure admission. Done for one session lifetime; restart scope is explicit.

#### T19 — Coalesced automatic checks and recovery

- **Owner:** the same Rust session state-machine writer under `dev-server/`; terminal
  mode projection is a small T15 consumer update through its existing owner.
- **Prerequisite output:** T14 operation/currentness shape, accepted capture checks,
  and E1 no-growth/retry output before unattended replacement acceptance.
- **Remaining change / observable outcome:** explicit automatic mode runs the
  declared initial check and coalesces saves to one active preparation plus the
  newest pending demand. Reconcile membership/bytes; hints are not changes. Safely
  cancel only owned cancellable work; otherwise finish/discard/clean it. Manual
  check and automatic demand share serialization. Source correction resumes;
  changed imported producers and cleanup failure visibly pause instead of looping.
- **Checks / completion:** fake-clock/state tests for burst/add/delete/rename,
  identical hints, edit during check/preparation, manual-check collision, error then
  correction, restart-required and stop. Only latest valid current work publishes;
  no unbounded queue or runtime growth. Data/schema refusal stays intact. Done when
  those scheduler outcomes feed the same truthful presenter.

#### T20 — Authenticated update delivery and safe automatic reload

- **Owner:** A owns the Rust gateway notification route; B owns the dev-only
  browser consumer through `packages/ui/src/browser/bootstrap.ts` or its narrow
  dev entry. D owns only the necessary resource-injection call site in `deploy/bundle.ts`.
- **Prerequisite output:** T18 stable origin, current ready publication and asset
  identity; T14 ordered generation/status shape. T19 is needed for save-triggered
  integration, not for implementing/qualifying notification after manual checks.
- **Remaining change / observable outcome:** notify publication once, reconnect to
  latest serving generation and reject obsolete messages. Reload the same tab
  automatically when safe; visibly defer with unsaved drafts/in-flight mutation,
  offer an explicit reload and resume when settled. Access expiry/disconnect is
  actionable. Browser acknowledgement is generation-bound and optional; only its
  receipt permits “browser applied,” never “business behavior passed.”
- **Checks / completion:** real authenticated channel covers reconnect/lost/duplicate
  events, old generation, access expiry, denied origin and stop; browser covers
  clean reload and deferred draft/mutation. No token/credentials/source payload leak,
  no automatic access renewal and no dev client in release output. Done at reload scope.

#### T21 — First complete automatic save-to-page join

- **Owner:** session/preview integration, existing native/browser dev fixture.
- **Prerequisite output:** T17 terminal delivery, T18–T20 and E1; prepared current
  compiler/runtime and retained state, with one source/asset generation frozen per check.
- **Remaining change / observable outcome:** connect save detection, checking,
  atomic publication and same-tab delivery. Update human mode labels and onboarding.
- **Checks / completion:** one warm sentence edit appears without check/open;
  a burst publishes only latest, syntax error preserves labeled last-good preview,
  correction recovers. Same login/team/data/database identity persists; schema
  mismatch preserves data; owned stop releases listener/runtime. Reuse component
  security and failure checks; add only distinct joined risks. Record save→paint
  and the relevant interaction separately. This closes automatic workflow, not a
  two-second promise or arbitrary state-preserving HMR.

#### T22 — Reuse invariant producer bundles

- **Owner:** target build producer, `deploy/bundle.ts` MCP/HTTP builders and its
  adapter cache implementation; Rust owns process/cache-scope lifetime and admission.
  Same target producer writer as T16; A owns the Rust cache-policy integration.
- **Prerequisite output:** T16 isolated build seam and T17 phase evidence showing
  whether repeated producer bundling is material; current captured installed closure.
- **Remaining change / observable outcome:** first candidate is bounded exact-key
  reuse of invariant MCP/HTTP bundles, leaving artifact-dependent assembly fresh.
  Key the actual consumed closure/resolution plus esbuild binary/version/options,
  target/config and producer identities. Admit only completed coherent output,
  bound memory/disk ownership and eviction. A retained rebuild context is an
  alternative only if evidence favors it; do not implement both speculatively.
- **Checks / completion:** unchanged producer hit, changed dependency/config/tool
  miss, missing/corrupt/partial output refusal and source-current publication;
  compare one affected warm edit to T17 with output equivalence/loadability. Report
  measured benefit or lack of it. If cost is immaterial, close the decision as
  deferred with evidence instead of adding a cache. Permission outcomes are never cached.

#### T23 — Reuse coherent capture, compiler staging and exact unchanged checks

- **Owner:** Rust capture/compiler adapter, A, consuming actual target input
  inventory. Current `dev/source-capture.ts`, `preview-inputs.ts`, `compiler-check.ts`
  supply behavior/evidence. Basic capture ports under T14; T23 owns only additional reuse.
- **Prerequisite output:** T17 attribution, E1's identified capture/inventory
  source from `da726fc78`/`dbedbb249`, and T19's shared check admission. Port only
  the measured remaining duplicate; existing source is not another owner-release gate.
- **Remaining change / observable outcome:** reuse already coherent captures only
  across a valid generation boundary; retain verified compiler/catalog staging by
  identity. For an exact unchanged full input identity, reuse bounded successful
  check/artifact output before another compiler spawn. No broader semantic cache.
  Preserve current evidence and diagnostics provenance; a watcher alone is insufficient.
- **Checks / completion:** no-op hit plus source membership/add/delete/symlink,
  compiler/catalog/flag/profile/producer change and mid-capture mutation invalidate
  correctly. Refuse incomplete/stale identity; never promote failed/superseded output.
  One direct no-op/copy-edit comparison proves the specific avoided work. Reuse E1
  acceptance; implement only the uncovered measured duplication, or record deferral.

#### T24 — Checked change classification and compatibility facts

- **Owner:** artifact/resource comparison in `deploy/bundle.ts` and dev publication;
  compiler owner only for a demonstrated missing emitted identity. No token/text diff heuristic.
- **Prerequisite output:** T18/T20 generation/asset shape and existing emitted style,
  browser, route, model/policy/binding identities. Coordinate bundle writer after T22.
- **Remaining change / observable outcome:** compare validated outputs to classify
  no page change, CSS-only, candidate compatible page update, or reload/restart.
  Include locales, dependencies, executable/client and authority/form identity;
  unknown is incompatible. Publish the smallest checked facts consumers need.
- **Checks / completion:** representative style, message/template, behavior/query,
  route, policy/binding, schema and producer changes choose their declared path;
  a literal change cannot masquerade as presentation-only. Done when T25/T26 have
  evidence-backed eligibility and safe fallback, without a generalized new IR.

#### T25 — CSS replacement without resetting the page

- **Owner:** dev browser/resource lifecycle, B; D supplies checked resources.
- **Prerequisite output:** T20 delivery, T24 CSS-only result and coherent versioned
  assets from the normal validated build. Backend skipping is not a prerequisite.
- **Remaining change / observable outcome:** load the checked new sheet before
  removing the old one; retain DOM/focus/drafts. Reject out-of-order generations and
  handle unavailable style bytes explicitly, falling back to safe reload as needed.
- **Checks / completion:** one actual style edit changes the page with no reload or
  lost draft/focus; incompatible markup/client change and failed resource fetch
  cannot partially apply a generation. Report frontend continuity separately from
  unchanged backend build cost. Stop at the declared CSS class.

#### T26 — One bounded authorized page/region update

- **Owner:** existing UI binder/mount/morph lifecycle in
  `packages/ui/src/browser/bootstrap.ts` and owning authorized page render path.
- **Prerequisite output:** T20 delivery and T24 compatibility facts; existing morph
  behavior is evidence to reuse, not proof it is safe across code generation.
- **Remaining change / observable outcome:** select one text/template edit class
  with same route/context and compatible executable/form contract. Obtain a fresh
  authorized render, dispose/rebind generated mounts and transfer only explicitly
  safe draft/focus/navigation state. Do not retain obsolete nonce/CSRF/version/action
  authority merely because ordinary in-generation morphing retains it.
- **Checks / completion:** real selected edit preserves supported drafts/focus;
  revoked read/action, changed binding, incompatible client, pending mutation and
  failed render take the declared deny/defer/reload path. No duplicate handlers or
  stale privileged controls. Done at this class; arbitrary component HMR is unselected.

#### T27 — Decide and, if justified, deliver one resource-only partial build

- **Owner:** resource publication/build and existing compiler asset owner.
- **Prerequisite output:** T24/T25 classification and an observed remaining backend
  cost for a CSS edit; complete resource/Worker digest and admission relationship.
- **Remaining change / observable outcome:** decide whether a coherent independent
  resource-publication boundary is worth adding. Current CSS is folded into Worker
  resources, so a browser sheet swap alone cannot skip backend work. If justified,
  implement only checked CSS publication with unchanged behavior/schema/policy
  output and atomic matching resource identity; otherwise retain normal builds.
- **Checks / completion:** selected branch proves skipped backend work, correct
  digest/invalidation, retained access/currentness, interrupted publication and safe
  fallback. A no-go records measured reason and closes this decision without a new
  carrier. No general asset pipeline or claim that all UI edits can skip checking.

#### T28 — Select a finite compiler reuse boundary from measured cost

- **Owner:** existing compiler owner, `compiler/src/` check/source/analysis/codegen
  boundary; dev adapter supplies T17/T22/T23 timings and actual consumed inputs.
- **Prerequisite output:** attributed compiler cost after reusable non-compiler work
  is accounted for, and a released finite compiler file scope. Existing active compiler
  changes remain with their owner; this plan cannot claim those files concurrently.
- **Remaining change / observable outcome:** compare full-check retention, persistent
  process/parse reuse and one dependency-aware declaration/query or emitted-unit cache
  against the same edits and correctness needs. Select the smallest material win,
  exact dependency/invalidation key, bounded memory/cancellation and fallback contract.
  Disk persistence is a separate decision, not implied by a persistent process.
- **Checks / completion:** bounded experiment on unchanged, one local edit and one
  importer/interface invalidation, preserving diagnostics/spans/source membership.
  Record measured go/no-go and the exact T29 boundary. Stop on a no-go; never open
  an unlimited “incremental compiler” prerequisite. Existing JEV sequencing advice
  does not decide a new compiler architecture.

#### T29 — Implement only the selected compiler partial-work slice

- **Owner:** compiler, with A consuming its exact check-adapter interface.
- **Prerequisite output:** T28 go decision, selected source/query/output boundary
  and independent equivalence expectations. **Conditional; not ready without these.**
- **Remaining change / observable outcome:** retain only the selected work; invalidate
  transitive consumers on interface/policy/config/membership change. An equivalent
  semantic output may avoid downstream work but never carries obsolete spans,
  source evidence, evaluation order or authority. Cold/full fallback remains available.
- **Checks / completion:** compare selected cached and full results on the bounded
  edit set, invalidation, error/correction, cancellation and bounded repeated requests;
  one real dev consumer proves current generated output. Record speed/memory observations.
  Close this slice without a whole-compiler rewrite, portable cache or universal latency claim.

#### T30 — Final changed-scope interaction, latency and recovery join

- **Owner:** dev integration and local-development documentation, with actual
  UI/compiler/runtime owners supplying completed selected outputs.
- **Prerequisite output:** T21, resolved T22/T23 decisions (consume implementations
  where selected), implemented T25/T26, and resolved T27/T28 choices with T29
  completed only if selected. Deferred techniques remain visible, not falsely
  “implemented,” and valid no-go decisions do not block this join.
- **Remaining change / observable outcome:** validate the complete available
  experience on one frozen coherent producer closure and retained authenticated
  browser/state. Update usage/troubleshooting and record completion in this view.
- **Checks / completion:** reuse T21 and owner results wherever inputs/behavior are
  unchanged. Add only affected no-op, copy, CSS, rapid-save/error recovery and supported
  morph interactions; use one relevant canonical action to distinguish painted from
  usable. Observe current grants/login/data, generation-correct resources and owned
  cleanup. Separate cold startup, warm edit, browser applied and usable timings;
  report sample conditions and improvements without a two-second gate. Completed
  selected outcomes close once; unresolved external/conditional scope stays named.

## Draft frontend acceptance

### Executable batches after wind-down — 18 October 2026

Keep DFE-01–07 as parents. Dispatch **one selected app and one stage** at a time:
CanTable requirement/fixture mapping → its missing compiler closure → native
preview admission/capture → its declared resource joins → real generation →
functional journeys → visual inspection → saved-output CI. CanPromptLab follows
for the additional generation categories; other apps follow their own required
outputs, not completion of that showcase. DFE-05 is the consumer of FP.QUALIFY,
not another copy of the same app journey.

- **DFE-01:** begin with `draft/apps/CanTable/CanTable.can`, its companion and
  `playwright/app.spec.ts`. The existing spec covers only the denied `/cafe`
  state. Map the host reservation/seating/clearing journey before adding assertions;
  `readDraftSource` / `selectedInventory` in `tests/e2e/drafts/source.ts` supply
  lexical discovery, not compiler authority. Use the existing `@coverage` result
  to identify missing assertions; do not mark a requirement covered by naming it.
- **DFE-02:** first complete the original CanTable multi-operand compiler
  closure and attribute its emission errors to existing compiler owners. Then
  extend native `dev-server/src/compiler.rs::admit_single_app_profile` / `compile`
  and `capture.rs::{CaptureRequest,capture_with_phases,is_current_with_phases}`
  to consume compiler-resolved source membership and selected app identity.
  The current guard rejects `use` and multiple app declarations; the old blanket
  package/`app uses=` refusal description is historical. No checked app-selection
  CLI/interface is assumed to exist: the compiler/native owners must expose the
  selected declaration plus complete operand/generated closure before the browser
  consumer can proceed. Preserve existing single-app behavior; a lexical scan or
  removal of the guard is not that output. Imported/generated edits, ambiguity,
  missing inputs and stale candidates are the focused negative cases.
- **DFE-03/04:** for that selection, join only the resource bindings actually
  declared, then generate its required style through the accepted native
  `can gen` / `can validate` lifecycle. Preserve the specified Sol/medium recipe.
  Missing authenticated runner capability holds the real-generation observation,
  not local closure/resource work. Do not regenerate accepted PromptStudio output.
- **DFE-06:** after the same app's functional journey passes, inspect its actual
  populated/empty/error desktop/mobile states with `tests/e2e/drafts/visual.ts`.
  Finish that app's reference/functional comparison before widening to the next
  batch. Existing 108 reference mappings remain the eventual corpus denominator.
- **DFE-07:** add one accepted app's saved-output run to existing CI first, then
  extend selection as each app is accepted. Do not make all 828 discovered cases
  a prerequisite for the first useful regression job or convert discovery into
  acceptance.

The existing focused commands are
`bun run test:draft -- CanTable/playwright/app.spec.ts --project=coverage`, then
the same file with `--project=examples`, `--project=desktop` and `--project=mobile`
as their inputs become available. Use `bun run typecheck:draft` after shared helper
edits. These are future validation commands, not results of this planning update.
The [runbook](../draft-frontend-validation.md) owns setup and capture details;
refresh only affected producers and freeze their consumed closure for execution.

### DFE-01 — Map requirements and correct the original sources

**Status:** planned; reuse the existing inventory and two accepted corrections.

**Owner / files:** draft integration owner; `scripts/audit-draft-frontends.mjs`, `draft/apps/*/*.can`, adjacent requirement companions and `draft/shared/`. Compiler defects remain with the defining Compiler task.

**Prerequisite output:** current source inventory and companion requirements for the selected batch. Semantic closure checks additionally need the relevant compiler/BGI-01 output; initial requirement mapping can start immediately.

**Change:** connect each selected app's requirements, routes, operations, examples and declared resources to its existing tests or a concrete missing journey. Once source carriers are supported, compile each selected app closure and classify failures as source mistakes, missing compiler/runtime capability, missing generation, or missing binding. Fix demonstrated source mistakes without erasing intent, weakening permissions or replacing the original app. Record an actual ambiguity as the exact decision needed. A difficult new design choice follows the repository's three-request JEV policy; this ordering of accepted work needs no new architecture consultation.

**Done when:** every selection in the batch has complete, source-current analysis and a requirement-to-test/result mapping. Each demonstrated source defect is corrected with its focused check, or remains explicitly open. Undefined/unsupported behavior cannot count as a successful check. Reuse shared rows and their evidence across consumers; do not create a second authored app registry or one ticket per cascading diagnostic.

### DFE-02 — Serve a selected composed app in the dev server

**Status:** planned.

**Owner / files:** native development owner in `dev-server/src/compiler.rs`, `capture.rs` and the existing command/session modules; compiler selection in `compiler/src/cli.rs` and `source.rs`; existing `tests/integration/can-dev-server/` consumers. The Cloudflare `src/dev` tree is retired. Reuse accepted native manual behavior and owner-only controls.

**Prerequisite output:** compiler-owned selected app/package/import closure, ordinary artifact/page contracts, and BGI-02/04 saved-input and reader/promotion handoffs for generated files. Ordinary composition work can proceed before live generation.

**Change:** expose explicit selection of an authored app through the existing CLI/control protocol; reject ambiguous selection. Derive the full required source and accepted generated contribution/module/CSS/asset closure from owning declarations and compiler output. Capture and watch that closure, including additions/removals, against one revision. Feed its actual artifact into the protected preview. Rebuild on relevant source or accepted-output edits; preserve the working preview and identify its revision while a candidate fails or awaits acceptance. Keep session ownership, isolation, error redaction and bounded cleanup.

**Done when:** the original CanTable sources plus their genuine shared dependencies serve `/cafe`; source, imported-source and accepted-style edits update the correct preview revision. Ambiguous selection, missing dependency, stale build and failed promotion remain explicit; unrelated app edits do not invalidate a closure that does not consume them. Auth, required assets and owned stop work. Later batches add only demonstrated closure cases. Deleting admission checks or passing an incomplete root file does not close this task.

### DFE-03 — Join each app's required resources and runtime owners

**Status:** planned, assessed per selected app; independent ready apps continue.

**Owner / files:** existing Compiler, State, Values, Interfaces, UI, Files, Work, Capability and Cloudflare owners, linked through the [existing platform handoffs](#development-extension-contracts). DFE owns the draft consumer, not a duplicate implementation of their mechanisms.

**Prerequisite output:** DFE-01's exact requirement/resource inventory and the checked compiler artifact. Request the specific missing descriptor, owner port, binding or lifecycle outcome from its defining task.

**Change:** install the declared local D1/Identity, file/image, query, event, schedule, provider and configured-route resources actually consumed by that app. Reuse qualified owner outputs. For example, configured Files/export routes consume OUT-R05/S9-Q08 and DEL-B02; provider/ingress joins consume TECH-I01/I02; Chat/Creative callback predicates consume SEQ-025. Preserve their existing finite scopes and holds. Do not create a permissive resource whitelist, fabricate authority or label a provider double as a live provider result.

**Done when:** every required resource in the selected closure has an actual admitted local/target binding and its declared success, refusal, failure and recovery behavior is observed at the draft consumer. A provider contract test may pass independently while the named live-provider journey remains held. Required human/external releases remain visible with owner and release condition; they do not block unrelated apps or authorize production deployment.

### DFE-04 — Generate and adopt real Sol-medium draft output

**Status:** planned; generation implementation stays under BGI.

**Owner / files:** BGI owners supply the engine; draft integration owns `draft/can.gen.toml`, source-compatible saved groups and their adoption. Preserve handwritten witness provenance until genuinely replaced through the accepted lifecycle.

**Prerequisite output:** BGI-01/02/03/04/05/10 plus applicable BGI-11/12 outputs for styles. Views additionally need BGI-09; traits and custom keywords need their respective BGI-07/08 outputs. Consume these handoffs separately rather than wait for all of BGI-13 or the other CLI adapters.

**Change:** replace illustrative recipe placeholders with the validated Codex configuration requesting `gpt-6.1-sol` and medium for every effective recipe, including the showcase's explicit `careful` profile. Inspect effective settings and actual producer evidence; report unavailable or unverified settings instead of silently substituting. Run the actual CLI with protected source/current/candidate roots unwritable by the generator. Supply whole active Then context and checked component/theme contracts; admit Given contributions before their frontend consumers. Submit all generated content through host-owned MCP targets, validate it and accept the complete candidate set. Reconcile provisional associations conservatively; retain direct edits and prior working output until acceptance.

**Done when:** actual requested-model output serves in the selected draft, each required output kind has truthful provenance, and the relevant BGI owner results cover named reuse, zero-AI saved builds, full-app retry including already successful prompts, and failure/cancel/conflict preservation. CanPromptLab separately passes named/inline model traits, named/inline field traits, views and its genuinely novel named keyword. No inline keyword or generated When body is introduced. A pure handwritten helper check or a passing trait is not keyword acceptance.

### DFE-05 — Execute complete functional journeys

**Status:** partial implementation. All 50 app groups now have local configs, entries and 127 concrete journey bodies: source-specific permitted/denied access, fresh-store views and reloads, saved preferences, incomplete-input refusal and CanApprove validation/create/readback. All 57 coverage checks still fail for listed unmet workflows/states and permitted identities; these bodies are authored, not accepted app executions. Real business-role/serving-data provisioning and composed preview remain prerequisites. The actual CanTable attempt fails `PROFILE_UNSUPPORTED` before capture. See the current rollout result below; source examples and initial-page checks cannot close this task.

The shared session helper is qualified on actual ModelFreePreview authentication/rendering/capture and all four HelpOffice example rows, with matching source/build identity and owned cleanup. Two concrete preview bundle omissions were fixed in the existing Cloudflare owner: stage `export-downloads.js` and expose its existing `canonicalJson` dependency through the HTTP facade. This restores the ordinary preview seam and does not implement composed-app support.

**Owner / files:** `draft/apps/*/playwright/app.spec.ts` and adjacent journey notes, shared `tests/e2e/drafts/` session/suite helpers, and owning runtime/example tests. Use the existing Playwright dependency and owner-only dev protocol.

**Prerequisite output:** DFE-01 coverage for the app; current DFE-02 preview, relevant DFE-03 resources and accepted DFE-04 outputs. Journey authoring can start earlier from the source requirements.

**Change:** drive real authenticated browser controls through the actual dev server, with isolated stores, deterministic representative data and the source's actual roles. Run authored examples with complete denominators. Connect each requirement/operation to its allowed outcome and relevant denied/invalid outcome; include persistence after reload, validation recovery, canonical mutation/readback, stale updates, replay and atomic failure where the workflow declares them. Exercise API/MCP-only behavior through its canonical interface instead of adding UI solely to test it. External effects use isolated test accounts/endpoints where available and keep live-provider claims separate.

**Done when:** every requirement in the selected batch has its expected outcome observed; all applicable authored rows execute with zero failures, skips or unsupported rows. A legitimately example-free declaration uses explicit journey coverage and is reported as such, not as an example pass. Each declared UI control is covered in its meaningful state; hidden/denied controls cannot bypass authority through direct calls. Browser requests, resources and console have no unexplained failures. Reuse existing owner edge-case tests and add only the missing draft integration observations.

**First finite journeys:** CanTable covers host versus member/location authority; waiting/reserved/seated/cleared states; overlapping reservations, invalid party/time values and occupied-table refusal; explicit clearing, cancellation reasons, filters/preferences and reload. CanPromptLab consumes the exact fixtures in its [companion](../../draft/apps/CanPromptLab/CanPromptLab.md): archive/restore attribution, notes, UTF-8 and EAN-13 validation, canonical-key collisions/scopes, atomic swap/rollback, removal/replay and collision-checked activation. Keep those canonical fixture expectations in their owner rather than copy another checklist here.

### DFE-06 — Inspect prompt fidelity, images and responsive quality

**Status:** partial setup. The app specs now map 108 current reference concepts to source routes. App-local capture/accessibility/side-by-side reports and tolerant inspected-baseline regression checks are implemented. A direct Chromium helper qualification passes pending capture, matching baseline and material mismatch reporting; it qualifies the helper only. No original draft capture or visual acceptance is claimed. A separate agent supplies app-local reference concepts; this implementation generates none.

**Owner / files:** UI/draft quality owner; source style/view prompts and generated editable outputs; app-local `playwright/references/`, `playwright/baselines/` and ignored `playwright/results/`; shared `tests/e2e/drafts/visual.ts`.

**Prerequisite output:** current DFE-05 setup and meaningful browser states. Capture only after consumed source, runtime outputs, catalog and accepted generated groups are fixed.

**Change:** capture every admitted route at the existing 1440×1000 and 390×844 viewports, with representative content and the relevant empty, populated, validation, loading and failure states. Cover declared locale/theme variants; use long labels/content and keyboard navigation. Inspect each image against its actual prompt: hierarchy, readable typography, consistent spacing, useful emphasis, unclipped controls, focus, contrast and mobile reflow. Test canonical pending/errors and permissions while styles/views are mounted. Correct source intent when needed and use the requested model for generated style/component fixes through the same acceptance lifecycle.

Image-bearing apps additionally use genuine admitted test image files through their File/upload/gallery paths: preview, aspect ratio/cropping, alt text, load failure and revoked access where declared. Include their real media layouts in screenshots. An image-free fixture cannot satisfy image functionality; nonvisual file formats retain their own workflow checks.

**Done when:** every required route/state has an inspected, satisfactory image and its corresponding functional assertions pass. Record a short prompt-specific visual verdict and any defect beside the capture; smoke checks or pixel similarity alone cannot approve appearance. Only inspected captures become regression baselines. Later comparisons use matching state, viewport, locale and theme; intentional changes receive inspection rather than automatic baseline replacement. Reuse identical shared-component states, while still visiting each composed route to catch integration/layout defects.

### DFE-07 — Roll out the corpus and keep the result repeatable

**Status:** partial rollout. All 50 app-local `playwright.config.ts` files are compatible with candidate acceptance; the shared suite consumes candidate source bytes while retaining authored companion requirements. `test:draft`, `test:draft:coverage` and `typecheck:draft` discover 828 cases across 50 entries. Coverage still fails for every selection, and no saved-output CI acceptance is claimed. Existing DFE-01–06 gaps remain prerequisites for acceptance, not prerequisites for adding the local test files.

**Owner / files:** draft integration owner; existing audit/capture scripts, Playwright config/specs, appropriate existing CI workflow and [runbook](../draft-frontend-validation.md).

**Prerequisite output:** the first accepted DFE-01–06 app, then each ready batch. This task consumes their results and does not review their reviews or create a second evidence system.

**Change:** add one documented command that selects authored apps, runs their saved-output functional/visual checks and emits the coverage summary using existing reports. Derive selection/routes from checked source rather than a parallel app manifest; test-specific fixture data and expected outcomes remain in the owning tests. CI validates accepted saved output without model calls. Real generation is a separate explicit, bounded qualification run after relevant prompt/generator changes. Publish screenshots and diffs as test artifacts, with missing/stale/held coverage clearly distinct from passes.

**Done when:** all current source groups and selected app declarations are accounted for, every required journey and route/state passes, and no required binding/provider/visual gate remains unreported. Shared package examples and generator mechanisms are counted once and linked to every consumer; composed apps still exercise their own routing, authority and layout joins. A new app, route or requirement causes an explicit coverage gap until added. Full acceptance is withheld while any required row is failed, unsupported, uninspected or externally held. Changed inputs rerun only affected checks; unchanged acceptance is reused.

## Service and integration contracts

**Prepared decision boundary, 18 October:** SEQ-045 first requires the app/provider
owner to name one originally required definite-success reversible effect, its
original-attempt identity and reconciliation output. Compare an original-payment
refund with an actually required withdrawal/repair alternative using verified
source/provider contracts and the existing three-request JEV procedure. Compare
unknown outcomes, irreversibility, current authority and crash/replay recovery on
equal terms. No effect is selected by this preparation; Payments is a dependency
only if selected, and Email acceptance is not reversible. This finite experienced
owner decision can proceed independently of ordinary source/service producers.
The canonical list supplies their order; do not adopt compensation syntax or a
generic reversal framework to avoid this concrete choice.

The canonical list selects the next unit; these recipes clarify the large
parents without creating more outcomes. Paths below were checked at `104d87b63`.
Earlier “defining-owner paths from the old plan” are historical suggestions where
they differ from these current owners.

- **FP.QUALIFY:** select one original app from
  `docs/ideal-filetree-plan/finished-product/workflows.md` and its original
  `draft/apps/<app>/` source/companion. Map only its unmet workflow to existing
  canonical producer outputs. First implement the missing fixture/role/operation
  consumer, then run that app's complete required positive and negative journey.
  Start frontend integration with CanTable after DFE-02's actual closure/preview
  output. The existing entry is `draft/apps/CanTable/playwright/app.spec.ts` using
  `tests/e2e/drafts/suite.ts::defineDraftAppSuite`; the old proposed
  `tests/e2e/journeys/original-corpus.spec.ts` and delivery/analytics siblings do
  not exist. Extend existing app entries rather than require a new master suite.
  Keep the 49 original intent ledgers and the distinct frontend selections intact;
  neither count substitutes for the other. Consume the same result for DFE-05.
- **FP.INSTALLED-RELEASE:** take one changed final native/Values/Work artifact
  closure, integrate its inventory in `scripts/pack-install.mjs`,
  `packages/cloudflare/src/deploy/producer-files.ts` / `package-assets.ts` and
  `src/release/manifest.ts`, then qualify one explicitly claimed installed host.
  Use `node scripts/verify-install.mjs <archive>` on the assembled archive;
  `verify-installed-worker.mjs` owns the Worker-specific seam. Supply the final
  changed artifacts first; do not rerun unrelated accepted installer profiles.
  Old `src/release/inputs.ts` and `deploy/producer-inventory.ts` paths do not exist.
  Local packaging does not authorize public upload, default selection or retirement.
- **FP.UPGRADE-JOIN:** local engineering starts at
  `packages/cloudflare/src/upgrade/apply.ts::applyUpgrade`, which currently walks
  dry-run states and explicitly refuses live staged-store application. The
  missing output is an actual persisted upgrade coordinator, not an unavailable
  deployment account. First join one owner/predecessor/desired schema to
  `packages/state/src/migration/index.ts` (`resumeMigration`, staged validation,
  activation and recovery exports). Serialize the same owner, close admissions,
  retain cursors/fences and classify pre-flip versus activation failure using the
  existing engine contract. Then add the bounded pending-work/file inventory join;
  finally qualify interrupted/restarted/rollback behavior through the installed
  consumer. `src/upgrade/host.ts` and `test/upgrade-installed.test.ts` are proposed
  old names, not existing APIs/tests. Begin with
  `bunx vitest run packages/cloudflare/test/deploy-apply.test.ts` and the affected
  emitted `packages/state/dist/test/migration/{stage,resume,activate,recover}.test.js`
  under `node --test` after the owning build. Those unit checks alone do not close
  installed acceptance. Live activation remains a separate action-specific hold.
- **FP.SOURCE-CLOSURE:** use retained coverage in `docs/ideal-filetree-plan.md`
  and `finished-product/consolidation-review.json` to select one genuinely
  unreviewed source delta/owner, inspect its actual code and expectations, and
  record substantive findings in the existing owner record. Reuse the incremental
  compiler/native/complexity merge coverage; do not review verdicts or reconstruct
  every accepted diff from the old complete checkpoint. Escalate an actual missing
  coverage boundary; do not silently advance the complete checkpoint.
- **FP.FULL:** after each exact missing producer/consumer result arrives, reconcile
  its duty once in the existing finished-product record. Final release disposition
  consumes original-app, installed, economics, upgrade and source-coverage outputs;
  it starts no new implementation queue or universal retest. Keep unresolved
  required outcomes open and optional/declined outcomes explicit. A review of
  this reconciliation is not another prerequisite.

These commands and sequences are prepared work, not newly executed validation.
Security/transaction and cross-subsystem integration units warrant an experienced
executor; repetitive single-app/fixture or inventory follow-through can use Luna.

**Prepared decision units:** handle one recorded source discrepancy at a time
using the current `draft/apps/` source/companion and existing delivery/work review
findings. Mail frozen/latest address, Reception repeat/guest destination, Rent
historical denominator, Discover committed hook, Catch cumulative/daily counts,
Affiliate cancellation, Event public availability and Stock reverse conservation
need an explicit intended-policy/defect/negative/missing-implementation disposition.
Partner additionally needs a legitimate original lock-edit operation or an explicit
immutable-case test correction; inventing update grants is not a repair.
Volunteer material changes remain in the existing
[progress design](../design/muse-migration-20261004/progress-design.md): compare
preserving historical recipients through bounded capture/freezing with a fully
specified current-recipient/consent-generation alternative. Both must immediately
deny stale consent, preserve atomic conflict checks and handle superseding changes,
withdrawal, replay/crash and current authority. An experienced source owner resolves
these difficult choices with JEV before the corresponding edits. Unaffected
cancellation/reminder and ordinary draft migrations stay accepted.

## Generation observations

The accepted [implementation contract](../design/proposals/build-generation/implementation-contract.md) and [requirements](../specification/BUILD_GENERATION_REQUIREMENTS.md) define source/MCP/promotion behavior; they are not task queues.

**Next finite unit (2026-10-18):** one authenticated adapter observation, starting
at `packages/cloudflare/src/generation/adapters.ts::{adapterFor,probeExecutable}`
and `adapters.test.ts`. The common implementation and 20 controls are accepted;
do not rewrite them merely to dispatch. The operator supplies the selected
installed executable and approved model/account. Inspect that tool's current
supported controls, run one bounded host-MCP submission with protected output
roots, and verify actual OS write refusal plus outcome/provenance. Record a
missing capability against that adapter only. Repeat for the other required
adapters when available; do not start an old Muse coordinator. A fake executable
or another tool's successful run cannot close its external observation.

**Remaining Todo unit (2026-10-18):** use `examples/Todo.can` and the original
style-first scenario below through the existing native `can gen` / `can validate`
commands, host-owned MCP submission and saved-output rebuild. Prepare the actual
source/settings/model/host tuple before execution; the operator supplies any
missing authenticated runner capability. Observe named/inline styling, whole-set
retry and no-model saved reuse from the agent workflow, linking unchanged engine
results rather than repeating PromptStudio qualification. This is an observation
unit, not a new generation engine or permission to resume historical runs.

## Legacy draft and description closure

D08 consumes the accepted description/reference representation, renderer and six repairs once; the description maintainer reconciles only the supplemental handoff and any exactly identified owned viewer/resource limitation. Existing `description-reference-run/review.md` and `evidence/integration.md` retain the accepted observations. No source feature or behavior rerun is required.

Migration C01 reviews only the still-unaccepted A02–A06/N10 actual app/design diffs, one coherent unit at a time, against the existing progress, mail-recovery, dependency, history and extraction contracts. Preserve original policy, effect order, frozen recipients/revisions, current-attempt correlation, diagnostics, permissions and meaningful examples. The same Can construct has one canonical desired-JS translation; handwritten targets do not prove implemented runtime APIs. Canonical `delivery(Target)` and authorized leaf projections must not erase business state. Use current `draft/apps/` paths; optional dependency/history proposals remain unadopted. C02 reconciles existing monitor/review against completed wind-down; retire only a specifically identified remaining owned resource after release or name the retained-viewer limitation. No historical session/PID grants ownership. Volunteer material-change semantics are counted only under FP.APP-ADJUDICATION.


## Deferred complexity method

CAN-COMPLEXITY-SCOPE-003 remains one
outcome. Its actual cleanup census is
`/private/tmp/can-complexity-muse-20261018/baseline.json` (same rows in
`eligible.json`), base `69d45c33c65dd0627ff9f38c02fe3dcacbd560bb`, 1070 explicit
identities (630 TS/440 Rust), TypeScript 5.9.3 / rust-analyzer 1.99.0 eligibility.
The tracked `scripts/complexity-baseline.json` is the older enforcement allowance
set, not this cleanup queue. `monitor.json` records 849 resolved/221 deferred at
`01c5e8b3fe3338ac3379a771ac369c2236f21cd4`, after TS `3ac71ab6e`.

No explicit 221-row residual list was found. The first reconciliation unit maps
only those original 1070 identities to that closeout commit with the existing
analyzer, retains the still->20 identities, explicitly resolves moved/anonymous
bodies, and maps those owners forward to main. Absence is not automatic closure;
an unresolved correspondence is named against its original identity. These
retained local inputs exist but are not Git-backed; preserve them until this
finite mapping is complete. This is not a new current-tree census or an expansion
of the original scope.

One verified starting body is
`packages/state/src/invocation/registry.ts#compareGivenBounds`: the original
score21 body is unchanged between the census base, closeout and inspected main.
Refactor that one owner closure, preserving left/right decode and error order and
the shared `malformed_descriptor` catch. For each subsequent mapped body, use
existing `analyzeSources(new Map([[file, source]]))` and `keyOf` exports from
`scripts/check-complexity.mjs` to require ≤20 for the selected residual and its
new helpers. The CLI has no file/strict-score option: its grandfathered allowance
pass alone is insufficient. Also run
`node scripts/check-complexity.mjs --base <pre-edit-commit> --head worktree`
and the affected owner's behavioral/type/compile check once. Do not edit baseline,
eligibility, threshold or suppressions. Close original identities once; commit
coherent per-file batches without waiting for all221. No scoring or implementation
ran during this preparation.


## Capability acceptance details

These original technical constraints elaborate the same canonical outcomes above. Current D/E/B/C status and next units come only from those rows; process IDs and conditional choices add no jobs. Accepted components remain closed.

| Original ID / scope | Source and producer constraints | Required behavior |
| --- | --- | --- |
| SEQ-005 — narrow contracts | Reuse its reviewed storage, State/Work and genuine native outputs at `capability-roadmap-20261008/execution-state.json#SEQ-005/worker_update/cohort_resource_contract`. Defining owners release only missing source/context/rule, saved-influence, opaque File and corpus/recovery boundaries actually used below. Packages repairs common DTOs only when a concrete absent field is demonstrated. | Every consuming row has an exact available producer/consumer scope or named decision blocker, supported types and exclusions; no new umbrella contract or parallel registry. |
| SEQ-010 — verified context | Compiler checked user/hook/trusted-event actor/team/clock/operation, input/before/after/reserved-version and subject/conditional-grant facts; Dev genuine binding. User and bounded hook components already exist. | Close the remaining sites in existing `verified-context-inventory`, including used locale/timezone, actor-null and wrong-scope controls. No ambient variables, forged human actors or replacement State context API. |
| SEQ-011 — ordered rules/machines | Compiler complete rule/hook/lock/invariant/reference/reverse-selector dependencies; Dev verified owner-session assembly. Consume exact outputs for the selected app, not an entire compiler plan. | Original rule-order/managed-field matrix passes: ordered provisional aliases, actual per-hook versions, one reserved commit version, CRUD/set/nested/hook/delete protection and late-failure rollback of records/history/outbox/schedules. Preserve existing SM.QUALIFY acceptance. |
| SEQ-021 — typed progress | Services supplies production provider/model/account/tokenizer and enforceable limits, authentic progress/usage; Capability runs unmet CC/CH progress criteria. | Exact original operation/source/revision/sequence, duplicate/reordered/late observations, terminal immutability, missing/withheld progress, truthful unknown acceptance, late usage and restart at the selected real profile. Reuse controlled progress/replacement/recovery cases. |
| SEQ-022 — targeted stop/reconcile | Compiler remaining current rules/context/send-guard facts; provider original-attempt stop/reconcile evidence. Deadline branch consumes accepted SEQ-019 only where used. | Original attempt/binding/owner/principal/current association, pending suppression, denied/repeated stop, stop-success race, unsupported cancel and original-job reconcile remain distinct; never infer zero usage/refund or release from intent alone. Qualify unmet CC-08–12/CH-05–09 cases, not the tested control API again. |
| SEQ-024 — receiving-app finalization | Services authentic assets; Packages receiving Files profile; Dev native receiving association; Compiler original policy/source. | Applicable CC-12–13 and CH file cases: genuine bytes/digest/MIME/size/limits, stable cumulative positions, duplicate/conflicting/foreign/partial outputs, failure between bytes/metadata/association, re-admission/restart and current app policy. |
| SEQ-025 — lifecycle UI | Retire those exact components at `capability-roadmap-20261008/execution-state.json#SEQ-025/worker_update/failure_presentation`. The exact original diagnostic selector and independent grants are now authored; checked/native behavior is unfinished. Capability selected A: an explicit typed nonstored protected selector, independent ordinary/recovery grants and the narrow Chat Branch parent-link recovery policy in `source_proposal/callback_declaration`. Saved advice A,D,A remains low-confidence; the inferred generic human design-acceptance gate is removed. Compiler needs the exact checked type/selection/independent grant handoff there; Dev connects the original native consumer and supplies actually consumed snapshot evidence for current/repair attribution. The inferred source-approval restriction is also removed after original-instruction verification. Original policies and localized receipt/historical failure outlets are authored at draft998df30; direct check finds zero syntax errors but semantic/native qualification remains blocked on the exact checked selector/type/grants, original semantics and typed-array collection lowering. Authored-stage review CLEAR and exact source checkpoint integrated in LOCAL main; no unchanged producer rerun. Provider progress/output and SEQ-024 remain required only for their original criteria. | CC-14/CH page rows render domain versus provider state, null/queued/running/success/failure/cancelled/unknown and absent/withheld output. Current guards control actions, drafts survive, obsolete attempt never paints replacement, gallery requires nonnull authorized successful output. Historical callback failures remain separate from current provider snapshots and immutable after repair. |
| SEQ-026 — whole private image app | Exact required SEQ-010/011/021/022/024/025 outputs and real browser/MCP/provider/storage profile; reuse 014–020/023 where applicable. | Every CC/CH row and applicable focused/common/gap criterion above has a meaningful actual outcome with two actors, denied output, rollback/replay/restart/late completion. Controlled providers are not remote acceptance. |
| SEQ-027 — image upgrades | Upgrade owner supplies installed predecessor/desired schema and existing activation/compatibility path. | Stored jobs/snapshots and outstanding original requests migrate compatibly or refuse explicitly; interrupted activation/recovery preserves fences/identities, no reset, silent reinterpretation or duplicate provider work. Use G-UPG-01 and FP.UPGRADE-JOIN. |
| SEQ-037 — dependent forms vertical | Compiler/Contracts checked conditional row grants/model rules/subject roles; UI actual CountryRegion breadcrumb/edit/table forms currently E6008; Dev generated native final admission. | Complete CountryRegion and CanApprove comparison from existing [source/vectors](capability-roadmap-20261008/dependent-input-comparison/README.md), retaining the supplementary CanRent available→hold advisory comparison: parent-change/delayed response, candidate and final authority parity, stale/forged/revoked selection, correctable drafts, keyboard/focus/localization and simultaneous identities. Do not rerun the accepted actor-role/direct-parent fixture unchanged. |
| SEQ-038 — concrete approvals | Existing ExpenseReview/CreativeRevisionReview source/cases/pages; Compiler related-user/query/rule/grant/current-context and Dev runtime outputs. `operation_id` example failure is resolved, not another blocker. | Execute both original concrete compositions including all Expense10/Creative12 scenarios/pages and their declared policies: self/duplicate/ineligible/stale/revoked votes, concurrent decisions, exact frozen evidence, expiry/rejection/superseding resets and separately authorized reimburse/publish. Ordinary/template/package comparison preserves all costs/outcomes; no generic quorum replaces CanApprove. |
| SEQ-039 — reviewed invocation values | Durable membership and general loop consumers need their defining closure/association, not an entire producer plan. Follow the canonical units above for original Workbench context/approve, Task.update/complete and one publication operation. | Owning normalized/frozen allowlisted arguments/ref versions/provenance; readable protected preview; current target admission; same-owner child/parent commit and post-call workplace invariant rollback. Wrong target/owner, forged/stale/revoked/unreadable values, replay/nested failure reject. No string dispatcher or synthetic checked IDs. |
| SEQ-040 — whole approval app | Original CanApprove rule/grant/context/form/file/timer/event outputs and concrete D1/R2/EmailService profile. SEQ-039 is conditional: the published CanApprove has no protected invocation value. | Every CA/EM/LO row and applicable focused/common/gap criterion, real reviewers/browser/enabled MCP, current downloads, rejection/replacement/reassignment, durable restart/replay and stored/pending-work upgrade. SEQ-038 protocol tables alone are insufficient. |
| SEQ-042 — admission/hold/request | CanChat73–81/invariant32 plus Knowledge unfinished-question admission; Compiler/Dev SEQ-011 outputs, real selected owner. SEQ-041 units/owner choice is accepted. | Original same-owner request+hold+Run/Turn or Question+outbox commit: last-token/slot and concurrent exact/over-cap, overflow/unit/owner mismatch, stale/revoked/later failure, replay/crash. Rejected admission stages no request; no mirror counter/shared accounting DSL. |
| SEQ-043 — settlement/late usage | Accounting/provider owners release original associated usage; generation uses exact SEQ-021 output, not all image work. | Once-only evidence/admission identity settlement, independent slot release, terminal null→late usage, duplicate/stale/forged/mismatched evidence, uncertain stop/skipped proof/restart. Unknown commitments retain holds; Knowledge daily request charge is not refunded by slot release. |
| SEQ-044 — second cancellation consumer | Original Text and Images native cases, current-attempt policy/evidence comparison and exact source review qualify the recorded stage; reuse them. | No unrelated/new attempt is cancelled; late success and unknown usage survive; no cancel_scope syntax or coordinator package is introduced. Original application and production-provider/profile requirements retain their separate owning rows. |
| SEQ-045 — explicit recovery | App/provider owner selects one reversible definite-success effect with stable identity and reconciliation. Email receipt success does not qualify refund/withdrawal. Payment selection needs existing FP.AW-PAYMENTS. | One complete authorized refund/withdraw/repair protocol with own pending/success/failure/unknown/escalation; registration/dispatch/receipt crashes, duplicate, irreversible/denied/uncertain reversal. No cross-service rollback promise. |
| SEQ-046 — typed judgments | Judgment/Services owner supplies remote model/account/tokenizer/usage and selected original consumer; no image-provider dependency. | Source rubric/version/static or exact runtime options and single derived schemas reach authentic request/result; missing/extra options, malformed distributions/numeric bounds, model/version/usage mismatch, retry/unknown refusal. Advice grants no approval; reuse actual durable controlled static/runtime tests. |
| SEQ-047 — corpus lifecycle | Compiler currently refuses corpus emission; Contracts/index/provider owners release the bounded Handbook owning declaration, immutable eligible revisions, withdrawal and opaque all-supplied-source provenance. | Actual lifecycle and equal UI/MCP current-authority disclosure: revoke uncited used context, withdrawal/supersession, corrupt provenance, file expiry, unknown provider; withhold answer as required and refuse plain-text/provider-input escapes. Reuse finalized File bridge, not an ACL/index mirror. |
| SEQ-048 — cohort executor | Compiler complete committed-model source/handler projection; Dev event-ID/current owner/invoke-local memo and default installed Worker assembly; Packages existing durable cursor/rotation where unmet. | Original [T34 F8 M1–M10 matrix](challenge-audit-run/evidence/t34-plan.md): 499/500/501/1000 both forms, enum/claim/effect/checkpoint crash/restart, duplicate/concurrent insert/move/delete, reject/revoke isolation, exhaustion/fairness, two independent occurrences, unchanged Shift/Volunteer and honest unsupported/resource/cross-owner/loop controls; frozen membership, independent outcomes, all matching ordinary/cohort routes. Complete original CanVolunteer Opportunity.updated source route, not a scheduled substitute. Credit accepted ordinary/private/multichunk/member-load-failure cases. |
| SEQ-051 — wizard pilot | App/UI owner identifies an actual multi-session resume consumer and ordinary-draft/form comparison; long forms alone do not trigger it. | If useful, explicit private versioned draft/save/read/submit, reload/two-tab conflict/revocation/expiry/discard/final replay and file retention if used. Navigation never submits business work. Otherwise record no-pilot disposition; inferred draft storage/grammar stays deferred. |
| SEQ-052 — typed-view pilot | Capability compared both CanApprove candidate lists after existing read/default reuse. Complete inline cost72 tokens; only14 tokens duplicate, with at most12-token optimistic reuse headroom before required declaration/parameter/action/identity syntax. No residual correctness gap established. | If useful, minimal typed two-use rendering with existing factories: scope/acyclic imports/stable IDs, denied fields, foreign actions/type mismatch/recursion/collision and pending edits/localization. Read-only witness does not wait for all form work. Otherwise no-pilot, no new fragment registry. |
| SEQ-053 — calendar pilot | Existing CanBook/CanLeave/Locations/CanMember assessment does not establish matching rules current helpers cannot express concisely. Holiday authority and timezone/calendar revisions apply only to the chosen used policy. | Reopen for two apps needing the same business-calendar rule that current fixed durations/pure helpers cannot express concisely. Then applicable finite DST gaps/folds/month/leap/holiday/revision/missed/overlap vectors and pure next-UTC helper; SEQ-019 only if durable scheduling is claimed. No general recurrence grammar implied. |
| SEQ-054 — flat-machine reuse | Compiler/State SEQ-011 exact outputs plus two qualified models with stable repeated states/defaults or graph. | Compare vocabulary reuse before edges; nominal/default/identity/upgrade preserves distinct permissions, stored states and late attempt guards, refuses writer bypass. No hierarchy/entry-exit expansion. No useful pair means defer, not new implementation. |
| SEQ-057 — compensation reconsideration | SEQ-045 gives first actual recovery; select second only within existing required recovery scope. | Finite equal-outcome registration/order/crash/current-authority/uncertain reversal comparison. Domain policy stays explicit; no DSL implementation assignment. Fresh verified JEV3 only before a consequential future grammar choice. |
| SEQ-058 — package parameters | Existing Expense/Purchase differences and Employees/Locations/Suppliers imports do not meet the value gate. | Reopen only when imports/templates cannot address stable full-workflow duplication. Compare finite instances with nominal/owner/role/identity/migration/effect costs; JEV3 before any syntax. No automatic grants or generic package implementation now. |
| SEQ-059 — statecharts reconsideration | SEQ-011 qualified flat alternative plus one actual workflow whose flat composition fails the simplicity/value comparison. | Finite semantics/value record for target/conflict/order/history/entry-exit/migration together, JEV3 before separate implementation. No shared-graph prerequisite when irrelevant; no statechart coding task yet. |
| SEQ-060 — integrate each slice | Author supplies focused diff/direct result; coordinator performs authorized local integration and necessary review only. | Owning source/tests/related docs together, preserved foreign index/holds and file handback. Retire the slice once met; no standing reviewer, review-of-review or unrelated full-plan wait. |
| SEQ-061 — claimed installed/durable scope | Installed/backend owners select exact outside-checkout release/profile and unmet acceptance criteria; preserve preparation HOLD. | Actual package/artifact/browser/backend and relevant provider/crash/upgrade outcomes for that claim only. Reuse unchanged accepted rows and distinguish mock/native/deployed. Whole-app claims consume 026/040 matrices; other 49-app FP.QUALIFY scope is not this worker's invented global prerequisite. |
| SEQ-062 — coverage/decision reconciliation | Handling integrator reconciles accumulated changes against living checkpoint using existing registration plus new/uncovered delta. | Coverage and decisions retain all changes since checkpoint, both-parent ownership/allocations and real remaining gaps. Advance complete checkpoint only when review is complete. No repeated full-history reconstruction or maintenance-of-maintenance proof chains. |
| SEQ-063 — status/handback | Coordinator updates existing 21-proposal/task status from direct outcomes, accepted stages and exact remaining/deferred gates. | Claims name actual source/runtime/provider/profile stage; conditional no-pilot/defer is explicit; release leases/workers. Remote publication stays held; local status is not permission to deploy/push. |

Guarded SEND remains unfinished at `SEQ-039/worker_update/preclaim_original_stage_join/authored_send` only for its original Compiler/Dev native join. The retained lexical census and genuine same-store pending/skipped receipt preparation are coordinator-reviewed CLEAR and integrated in LOCALmain7a1a4125; retire those finite criteria at their existing State/Work scope. Original model SEND0a4 is also reviewed/integrated at LOCALad7. Exact reviewed Packages1ac now supplies the installed static Generation profile; the State/Work matcher and actual installed pending/null/skipped/rich receipt-to-completion consumer are implemented/tested in `SEQ-039/worker_update/model_call_result/related_send_prerequisites/generation_origin`, awaiting coordinator review. Dev derives each exact runtime request from the genuine original native frame and connects the full existing origin; original workflow acceptance remains unfinished. Reviewed Deva61 per-physical-store registry is a released finite prerequisite, with its unchanged owning result reused. Exact f715 receipt-only origin preserves zero skipped dispatch/outbox. Provider-void is explicitly unsupported until defining Contracts/Compiler release an actual delivery result representation; caller-void metadata does not substitute. Continue exact Compiler/Dev intake and original workflow qualification within the existing holds.
