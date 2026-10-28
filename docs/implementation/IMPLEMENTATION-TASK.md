# CanLang implementation task

## Objective

Bring the complete original 24-source CanLang draft composition to **zero native diagnostics** on a buildable, tested, committed main, preserving permission checks, original source correspondence, evaluation order, atomicity and replay.

This is the executable task list for the [complete work inventory](WORK-INVENTORY.md). Work through the zero-diagnostic sequence first. The wider inventory is assigned concrete follow-on tasks below; pull one forward only when it supplies a demonstrated dependency of the zero-diagnostic work. Optional proposals do not expand the objective automatically.

## Current baseline — 26 October 2026

The scoped ANY/Values compiler implementation has **13 E6008 diagnostics** in
its complete original native capture: zero analysis errors, all 26 unchanged
source records from the 24 original operands plus saved contributions, zero
omissions, exit 10 in 488.72 seconds. Original `move_membership_days` clears;
every other diagnostic object is identical to the preceding 14-diagnostic run.
The draft submodule is initialized at `5749c75b`. Prototype results do not change
this measured count until integrated and captured.

The build repair, nullable receipt migration, WHERE/SELECT scopes, shared
constructor COUNT/returned-Model/Values joins, checked Model cohorts, selected
profile reference/version observations, generated hook lexical bindings and native
void CREATE-prefix binding have landed. Original hold, hold_days, move_days and
review_swap now lower. Their scope-specific passing integrations are reusable;
complete original runtime qualification remains required where still open.

The latest fully inspected CI run (`d0248133`) passed browser/security and failed
compiler/editor and workspace/installed artifacts. Its Invoice created-root failures
and obsolete event-SEND expectation have since been repaired and exercised locally.
The original Chat compiler closures are repaired and locally qualified on
`44eb8ce8`; Event, booking/rescheduling and Mail runtime timeouts remain open
until qualified on current source. No all-green final CI is claimed.

Seven code files in the normal checkout contain unfinished Refer work. Preserve
that work and use coherent isolated candidates. Account proof reuse is committed. The shared Chat constructor/nominal projection/conditional-loop mechanism is qualified at the compiler and selected protected SEND runtime boundary; it does not grant withheld fields or qualify every original Chat workflow. Shift staged capture work remains an isolated candidate awaiting complete original runtime qualification and integration. These changes do not alter the measured original24 count without a complete capture.

On 27 October 2026 the unchanged original24 command was run from branch
`goal/production-ready` (= `origin/main` `e5af510f`) with a release compiler built
from that source and the native catalog rebuilt from that source (`ca50fdca…`,
byte-identical before and after the rebuild): complete artifact, 26/26 sources,
60 modules, 482 operations, zero diagnostics, empty stderr. The 13-diagnostic
count above was measured on feature-branch source and is superseded for main.
Runtime qualification and CI closure on this source remain open (Z18).

Z18 closure, 27 October 2026: all three CI jobs are green on `e5af510f`
(Workspace and installed artifacts, Browser and security journeys, Compiler and
editor: completed/success), covering the full runtime corpus on a clean
checkout. Local gates on `goal/production-ready` (`e5af510f` + docs only) also
pass: `bun run build` 26/26, `bun run typecheck` 40/40, `check:unitban`,
`lint:compiler`, `check:boundaries` (0 violations). No temporary instrumentation
was added. The zero-diagnostic objective is closed on this source; the B01–B27
broader-product queue remains.

B24 closure (installed Linux release), 27 October 2026, on
`goal/production-ready`: refreshed the dev-server notice manifest for the
profile-only Cargo.toml change (lock byte-identical, dependency closure
unchanged); packed `can-0.1.2-linux-x64.tar.gz` (113MB) from branch-built
release `can`/`can-dev`; `verify-install` 23/23 green; cold install into a
scratch HOME green (`can 0.1.2`, commit `e5af510f`); tutorial Tasks journey
(check/compile/dev/check/serving preview/auth/create/list) green on installed
bits only; `verify-installed-types` (193 exports, 13 packages) and
`verify-installed-worker` (315 modules, Wasm, production execution) green.
Minimum-Node22 variants not runnable locally (need exactly Node 22.0.0; base
CI covered them). Publication remains a separately requested action.

B25 mechanism (installed migration/upgrade recovery), 27–28 October 2026, on
`goal/production-ready`: delivered and committed the upgrade mechanism core
over the State migration engine — persisted owner/predecessor/desired
coordinator (`coordinateUpgrade`, binding re-verified every run, engine
progress rows as the durable record), pending-work inventory producer from
the live State outbox (`buildUpgradeInventory` + operation-path
handler-contract mapping, fail-closed), live apply backend
(`liveApplyUpgrade`, stop-before-activate deploy-then-flip, `--yes` gate,
wrangler-leg join), all proven by 20 integration tests over memory and real
D1 (miniflare) adapter stores. Remaining B25 units, each needing cross-lane
design: (1) plan compilation — schema-diff old→desired directives plus
snapshot minting from artifacts (L1 intake; transitions are caller-compiled
today); (2) dispatch-layer in-flight/uncertain supplier join for drain
(State-outbox inventory covers undispatched work exactly); (3) activate
gate-4 wiring (needs 1: no transition source in the bundle yet); (4) `deploy
--yes` CLI wiring through the preparation host (needs 1+3).

B27 dev-preview blockers (original-app journeys on installed bits), 28 October
2026: `can dev` preview fails for CanTable with IDENTITY_UNAVAILABLE (login
descriptor route failed) on both installed and checkout toolchains, with and
without `--preview-roles '{"Ava":["host"]}'`; the documented role-based
VerifiedTasks preview works on the same installed bits, so the failure is
CanTable-specific (host-role-only auth surface suspected, unproven). CanReport
preview stops earlier: `use report {ReportsV1 as Reports}
from=deployment.reports` is "outside the captured closure" — dev sessions do
not capture deployment-sourced imports. CanExpense (no deployment imports,
finance role seeded) fails later with SDK_OPERATION_FAILED on testkit.stage.
Pattern: toy apps (Tasks, VerifiedTasks) preview on installed bits; no tried
original app does. All three need dev-server lane fixes before original-app
preview journeys can qualify B22/B27. No model-provider credentials exist in
this environment, so supported-host generation is also untestable here.

B01/B02 verification (branch source), 28 October 2026: discriminator suites
green — any_first_composition 7/7, collection_calls 2/2,
boolean_operation_admission 8/8, decision_source_facts 14/14,
stored_query_profiles 9/9, model_hook_profile 12/12; the outcome12
compile-side refusal is closed (CanMaintain `when=can_work(...)` guards
present in the zero-diagnostic corpus). Open remainders, both runtime-matrix
test-authoring work for the B-lane: (1) CAN18 outcome5 full guard/body
execute matrix (absence, mismatch, denial, rollback, replay, recovery) for
the positive ANY dual through the runtime; (2) outcome12 candidate-context
membership framing proof for the `maintain.Asset.update` can_work-guarded
CRUD at runtime.

B15 triage (operational services), 28 October 2026: Errors intake
(FP.INSTRUMENTATION, `interfaces/src/instrumentation/intake.ts`) is
substantially implemented (versioned admission, key/throttle/bounds/sink)
but has ~1 test mention in the interfaces suites — needs its intake
contract suite. Ping/Alerts/Reports (FP.PING/FP.REPORTS, CanCheck/CanReport
consumers) are blocked on deployment provider bindings
(`deployment.pings/alerts/reports` manifests have no package
implementation) plus bounded ingress; CanCheck scenarios reference them
but no ingress exists. Consent/session tracking and maintenance admission
show no implementation. Smallest units in order: (1) intake contract
suite for the existing Errors boundary; (2) deployment provider binding
design (cross-lane); (3) bounded Ping ingress for CanCheck PingV1.

B14 triage (mailbox/payments/connectors), 28 October 2026: language
correspondence is done everywhere (`*_source_producer` suites green but
self-report unqualified ingress/File authority); the residual in all five
sub-areas is receiving/adapter/provenance work. Mailbox: send-only
transport exists; missing owning MailboxV1 catalog/coordinator +
authenticated MIME receiving producer (M). Payments: collect/refund owner
decisions + terminal receipt paths exist; missing verified-event →
original-attempt mapping joined to durable dispatch (M). Namespaces:
inbound-only `mapVerifiedIngress` exists; missing one configured versioned
binding + committed-outcome correlation (S-M, smallest first). Outward
adapters (Discover/Enrich/Sync/WorkSources/Device): declarations only;
start with Discover `page` end-to-end (M). HR handoff: declarations +
examples only; needs authenticated-cause join + once-only handoff path
(S-M, takes the namespace cause first).

B09 triage (files/resource lifetime), 28 October 2026: completion bar is
satisfiable per-consumer; none of five areas fully closed. (1)
Separate-store publication: single-store atomicity + serial paths exist;
smallest unit is one same-intent serialization primitive + two-owner
interruption/reopen witness (M). (2) Receiving joins: identity +
verified-ingress paths exist; needs one FP.SOURCE-MAPPINGS binding
connected to one receiving occurrence (M-L). (3) Quota/override: no
producer exists at all (static declarations only); needs a profile
decision (per-app FilePolicy vs deployment ProviderLimits) before one
admission-point enforcement + test (S once decided). (4) Provenance: base
exists, business-field authority unfinished; one protected-field file join
(M). (5) Expiry/disposal: Files GC + State retirement guard exist;
owner-level disposal missing; start with one authored expiry consumer
(M). TECH-F01/F02/FP.LIFETIME rows already point at the same units.

B08 triage (durable Work/progress), 28 October 2026: (1) Bundled
receipt observer: serving seam + staging shipped, but B-half
`packages/state/src/receipt/observer.ts` does not exist (loader target
absent; production resolves via injection or work-loader leg), and the
D3B contract's relative specifier drifted from the shipped
package-specifier seam. Smallest unit (S): author observer.ts +
reconcile drift one way + no-injection bundled test with invocation
marker and refusal cases. (2) Relation/progress: pure kernel covers all
17 targets; durable consumers exist only for Email/Judgment/workflow-review
+ TextGeneration; Payments/Images/Mailbox/Errors need one `stage*` join
each. (3) Availability: kernel + runtime mapping exist; injection into
`DriveDispatchFenceInput` missing (stated inline as follow-up). (4)
Fanout matrix: T34 + D1 cohort proofs accepted on synthetic fixtures;
missing cell is the original CanVolunteer `Opportunity.updated` source
route + `every(...)` durable path.

Q4-C closed (B-half + proof), 28 October 2026:
`packages/state/src/receipt/observer.ts` serves Work's
`observeSelectedReceipt` through a literal dynamic leg (declared
boundary exception; ambient shape keeps state buildable without
work's dist; vendor map rewrites the leg). D3B drift reconciled to
the shipped package-specifier seam. B-owned proof drives
`invokeSelectedReceiptRead` with no injection against produced bundle
bytes: authorized + B-marker, injected equality, denied, hiding,
null-association, stale-fence, closed-inputs, link failures,
present-but-broken loudness, fallback control. Installed-worker
verifier flips absence pins to presence (316 modules). Remaining
B08 follow-ups: (a) one more durable relation, (b) availability
injection, (c) original cohort cell; full D-owned `/mcp` journey
still open per row 231.

Images submit relation closed, 28 October 2026: durable journey
(`images-submit-progress`) drives file-free submit rich progress
through the real dispatcher over persisted D1 with scripted provider
transport — progress envelopes, uncertain record, genuine restart,
recovery reconcile to terminal, replay + post-terminal restart
immutability. Fixed a real gap the journey exposed: images reconcile
staging enrolled a commit check on a hand-built (never
registry-issued) context, so every observed reconcile threw;
authority revalidation already happens via `admitGenerationRecovery`
in `revalidateReconciledReceipt`, so the broken enrollment is removed.
Follow-ups: terminal `ProgressTerminalNotification` has no durable
consumer for any relation (cross-lane design); file-output submit
variant still open.

B14 namespaces first binding closed, 28 October 2026: configured
versioned BillingIngress (`standard-webhooks-v1-billing`) with
env-loaded binding, HMAC verifier reusing the shared webhooks
mechanics (pure helpers moved top-level, behavior unchanged), and a
committing sink with put-if-absent outcome correlation by
`producer_event_id`. Cross-route suite (8/8): accept + correlate,
replay identity, non-matching lookup miss, fail-closed tamper/version,
unknown namespace, key rotation, loader fast-fail. Installed-worker
and preview suites re-greened after catalog re-emit (build-order
artifact, hashes stable). Durable outcome-store backend + second
binding (SalesIngress) remain.

B08 original cohort cell scoped (not started), 28 October 2026: only
CanVolunteer carries the combined `on=X.updated` + `each=` route
(`refresh_reminders`); CanShift has each shape split across routes.
Its compile closure cascades to the full corpus (rent_reservations
via CanRent → customer/invoice/propose/report/...), so a journey
test needs corpus-artifact infrastructure (precompile + cache with a
staleness rule), not a per-test compile. The durable path itself is
mapped: commit auto-stages updated sources via
`canonicalCommittedSourceStage` + `createCommittedModelSourceStager`,
ticks drive via `createCanonicalCommittedCohortBody`; test would
invoke a real Opportunity update, tick to per-signup cancel +
Reminder schedules, and prove restart exactly-once.

## Next implementation queue

Use the order below to select work. These are subdivisions of Z00–Z18, not extra
requirements to count twice. Finish one coherent packet, review it, run its smallest
meaningful checks, commit/push it, then take the next ready packet. A prerequisite
applies to its required output, not to every activity in the preceding row.

| Order / task | Concrete implementation and current owner | Required result / dependency |
| --- | --- | --- |
| 1. **Z14a — Bound repeated account analysis through proof reuse** | In `compiler/src/analysis/scenario_disclosure.rs`, qualify the owner-attempt expression cache keyed by exact original statement, depth, environment, authorization and result context. Reuse only successful effect-free expression proofs; keep walking every actual statement/effect. Account analysis writer. | Compare the complete original corpus with main: unchanged sources, no new refusal, original account within unchanged resource limits. Existing Native FIRST/hook and affected State runtime integrations pass. Qualified cache completes original account analysis in 1,838 steps. Independent complete-corpus comparison preserves all 26 source records and all then-current 15 refusal locations; only the account resource-bound reason becomes a later receipt refusal. All 99 existing Native FIRST/hook integrations, all-target Clippy and three affected real runtime recipients pass. This is not account closure; investigate its later consumer refusal under Z14c. |
| 2. **Z16a — Preserve existing native DATA ownership for reconcile** | The exact-site trace shows these original scalar LETs have no existing native dependencies; the old overlapping-observer hypothesis is discarded. Preserve their original stage-zero snapshots by joining the existing authenticated source Require capture census and ordered mutation-prefix phase. Account writer after Z14a; coordinator integrates shared codegen/State changes. | Original CanShift:188 lowers using its genuine typed native DATA observer. Keep exact receiver/source/model/field/type provenance. Unrelated outer-phase DATA, missing loans, hidden fields and forged/stale observations still refuse. Do not delete the new fail-closed guard. |
| 3. **Z04a — Repair fulfill_free's missing query/schema join** | Trace checked owner facts separately from `checked_stored_contracts_inner`, its parameter/expression/decision/query/create/observer seeds and closed schema inventory. Repair the failing producer in `scenario_disclosure.rs` / `scenario_queries.rs`; rejoin through `scenario_receipts.rs`. Coordinator owns attribution; query writer owns agreed producer changes. | Original CanRent:1030 gets a fully checked plan and executes its complete constructor/guard body. Attribution now confirms owner facts exist but the observer-field declaration census counted 16,385 visits for only 2,447 distinct source nodes. The shared census now deduplicates exact source nodes while retaining its 16,384-distinct-node bound; all 99 existing Native FIRST/hook integrations and all-target Clippy pass. The complete original24 native run now clears fulfill_free and retains all other diagnostic objects unchanged: 14 remain, with 26 identical source records and zero omissions. Original fulfill_free runtime acceptance remains open. No broadened schema matching or waived guard census. Depends only on the identified producer output. |
| 4. **Z05a — Qualify the original hold/day runtime consumers** | Use the unchanged original composition and complete prepared modules with `packages/state` and Cloudflare runtime. Query/runtime writer owns the existing booking recipient. Remove temporary diagnostic export/logging changes before publication. | Actual hold and hold_days execute native CREATE/SET/event/schedule/order/rollback/replay paths; move_days uses its genuine Values/COUNT dependencies. Partial diagnostic exports may aid investigation but cannot close Z17 or certify the complete artifact. The Cloudflare facade now re-exports the existing Values `action`, `divideDecimal`, `lower`, `round` and `subtractDecimal` producers. All 112 actual emitted stdlib imports resolve and the CF emit/type build passes. Original hold/day runtime execution is still under qualification; do not rewrite the artifact or strip owners. Keep Z16a as a dependency only if its binding is actually needed. |
| 5. **Z18a — Finish unchanged Chat native closures** | Compiler analysis/codegen plus State loop/receipt execution: share exact returned CREATE handling, declared nominal scalar observation and closed per-item conditional SEND/SET accounting. Browser/security lane owns its isolated candidate; coordinator merges shared files. | Unchanged `original_chat_model_policies` integration and actual original Chat runtime pass. Whole owning-field DATA permission and genuine protected File observation remain required. True/false branches, missing grants, races and replay pass without fixture/source edits or a fake File observer. The unchanged original Chat now compiles with zero diagnostics and its original pure-policy callbacks pass. The integrated candidate passes 100 Native FIRST/hook/original Chat Rust integrations, all-target Clippy, State/CF builds and the complete existing SEND scalar DATA integration (15.87 seconds). This includes conditional skips, genuine attached Files, whole-field denials, Identity/field/File races, rollback/history and replay. Five additional native receipt integrations pass at the feature-branch scope. Full Chat application acceptance remains separate under B23; withheld request fields remain denied. This is a CI repair outside the measured diagnostic table; final GitHub CI remains pending. |
| 6. **Z06 / Z14c — Finish membership and account consumers** | Reuse sealed ANY/Values facts and selected BillingProfile reference/version observations. Complete the original account receipt after Z14a removes its analysis bound. Z06 now composes the sealed contained ANY and Values proof through shared source/IR, declared enum predicate, admitted parent and complete CONTROL census. The integrated three-file candidate passes 106 existing compiler/query integrations (including six new runtime cases), formatting, and the complete original13 capture. Full original move_membership_days runtime acceptance remains open. Compiler consumer and State runtime owners. | Original CanRent:531 and :1041 lower and execute with all original guards, finite domain and current authority. Empty/mismatched profile, hidden DATA, stale/revoked reference, late failure and replay behave correctly. Account prototype's later generic refusal remains open. |
| 7. **Z12 → Z13 → Z15 — Arrival, cancellation, then parent CALLs** | Complete the original dates/helper/query closure; support ordered Movement observations after prior writes; consume complete child plans through the existing same-owner CALL mechanism. Analysis/query, receipt and State owners hand off exact facts. | Original arrive and cancel_booking pass first, then check_in/cancel. Preserve full arguments/context, child effects, late parent rollback, grant/time boundaries and replay. Clears six measured diagnostics only when the full capture confirms it. |
| 8. **Z07 → Z08 → Z09 → Z10 → Z11 — Refer settlement** | Finish exact loop/LET/conditional-CREATE/Model-result analysis; independently join fresh source/IR; execute repeated staged queries under State's private item lease; retain all ordered occurrence/DATA/replay witnesses. Compiler producer, compiler consumer and State protocol writers work sequentially on shared files. | Original settle positive/empty/multi-item/overflow/late-failure workflow works with exact Credit order, created Settlement parent and conditional Allocation effects. Forged/missing/reordered witnesses, wrong parent/item, stale phase and withheld grants refuse. Removes five measured diagnostics when confirmed; preserve all seven existing WIP files. |
| 9. **Z18b — Resolve the three real CI timeouts** | Reproduce Event change/routing, original booking/rescheduling and original Mail triage separately against coherent production outputs. Attribute time to compile, module binding, database, work or runtime before changing that owner. Runtime/CI writer. | Complete original recipients pass with their denial, race, rollback and replay cases. Remove repeated work or fix termination where demonstrated; no blind timeout increases, hidden skips or reduced cases. Reuse existing qualified Invoice and nullable SEND results. |
| 10. **Z17 — Complete integrated original24 capture** | Coordinator builds the integrated committed candidate with the owning native Cloudflare catalog and runs the durable unchanged command to completion. | Exit 0, zero diagnostics, zero omissions, unchanged complete source membership and a usable full artifact. Attribute newly exposed failures and route them back to the appropriate owner. Do not run another full capture merely while an identical live one is pending. |
| 11. **Z18 — Final native/runtime/CI closure** | Coordinator reviews exact committed source, source/permission/order/atomicity joins and temporary instrumentation removal. Run warranted original runtime and installed checks, then all three normal CI jobs on final main. | Every completion criterion below passes on the same source. Commit/push qualified fixes early throughout; final green status closes the zero-diagnostic goal. A new release is a separately requested action. |

### Immediate runtime dependencies of Z05 / Z18b

These are demonstrated blockers in the actual original composition. They belong
to the existing runtime tasks, rather than a separate optimization project:

- [ ] **Z05b — Reuse an assembler-owned immutable artifact.** The reviewed `assembly-verification.ts` / `file-inventory.ts` implementation is committed as `3e2347e6`. Reuse verification only for the exact private issued snapshot; caller-owned or non-JSON input retains full checks. Preserve live file/module/URL closure checks and checks around every external await. All eight mutation integrations and two Notice/File integrations pass; the coordinator CF build also passes. The measured verification step improves from about 3 seconds to 53 milliseconds on the same 516 MB artifact; complete original workflow runtime remains required before claiming an end-to-end improvement.
- [x] **Z05c — Scope committed-source metadata to its actual source handlers.** Each checked source retains its complete handler group and every private event/name header for omitted-handler detection, under the unchanged 20,000-node bound. Genuine large-composition loading passes above the former aggregate bound, including two handlers on one source and complete completion-route identities. Omitted sources and changed handlers/invocations refuse. All 14 unchanged Invoice terminal cases pass (81.6 seconds). The full original artifact passes its earlier 20,372-node failure and reaches a separate structured read-admission disagreement; no hold business-workflow success is claimed.
- [ ] **Z05d — Run the unchanged original hold/day workflows.** After Z05b/Z05c, use the genuine complete prepared modules, current coherent runtime outputs and real authority. Exercise CREATE/SET/event/schedule ordering, rollback and replay. The earlier run failed during installation before invoking hold; it is not a business-workflow pass. Then qualify fulfill_free and move_days at their actual runtime boundary under Z04/Z05.
- [x] **Z05e — Compare structured read-admission guards through their existing decoder.** The original `member_terms.access_review` installs two independently emitted but equal OR guards; reference-identity comparison wrongly refuses them. Reuse the existing closed, bounded own-data policy decoder and compare ordered canonical guards, retaining exactly one policy term and the actual current admission checks. The existing resource-report integration passes all original hidden/current-authority cases plus member/reviewer admission, owner denial, and altered/getter/cyclic guard refusals (2.4 seconds). Full original hold/day installation and invocation remain Z05d outputs.

### Measured diagnostic ownership

| Original location | Count | Implementation tasks |
| --- | ---: | --- |
| CanRefer:69, 72, 79, 80, 84 | 5 | Z07–Z11 |
| CanRent:742 | 1 | Z12 |
| CanRent:769 | 1 | Z13 |
| CanRent:1041 | 1 | Z14a / Z14c / Z14 |
| CanRent:1748, 1750, 1756, 1758 | 4 | Z15 after Z12/Z13 |
| CanShift:188 | 1 | Z16a |
| **Complete current capture** | **13** | **Z17 measures the integrated result** |

A workflow may emit several diagnostics; a cleared refusal may expose a later one.
Neither task counts nor compiler acceptance alone are runtime completion counts.
Original CanRent:1030 (fulfill_free) cleared through Z04a; CanRent:531
(move_membership_days) clears through Z06. Z04 and Z06 remain open for their
complete original runtime acceptance.

## Completion criteria for the zero-diagnostic objective

- [ ] The actual committed main builds from a clean checkout; tests have not merely exercised a different dirty working tree.
- [ ] A current optimized compiler runs the [original complete command](REMAINING-WORK.md#next-original24-composition-capture--outcome14--t41) with `--native-scenario-receipts` and the owning native Cloudflare catalog: exit 0, complete output, zero diagnostics, zero omissions, all 24 original operands and both saved contributions included, and a complete usable artifact.
- [ ] Repaired original workflows execute with genuine native receipts. Relevant withheld DATA, hidden row, stale reference, Identity/revision race, forged source/receipt, rollback and replay controls pass through their actual runtime owners.
- [ ] Compiler/editor, workspace/installed-artifacts and browser/security CI all complete successfully on that same committed source. Correct real failures; retain meaningful negative coverage.
- [ ] Completed fixes are committed and pushed, temporary diagnostic instrumentation is removed, and remaining unsupported product behavior is recorded honestly.

A later refusal, analysis-only success, missing receipt, legacy fallback, narrower fixture or reduced source list does not satisfy the objective. The wider product backlog has its own completion below; it does not delay declaring this specific objective achieved once these requirements are actually met.

## Working rules

- Preserve existing source/Git and every contributor's unfinished work. Separate a small repair from incomplete aggregate implementation before building or committing it.
- Prefer shared mechanisms over application-name branches, special-case shapes or file moves. Preserve original private CONTROL versus DATA authority and exact source/field/type identity.
- Keep actual query, command, decision and observation limits. Do not raise caps, omit required observations, suppress diagnostics, weaken permissions or change application business rules to obtain zero.
- Use existing integration/end-to-end recipients and meaningful fixtures. Follow the repository unit-test ban and existing JEV consultation requirements. Reuse passing results at their actual scope.
- Review, validate and commit coherent changes early. Direct main pushes are already authorized; do not create PRs for these changes. Validate the actual staged/committed source before pushing, including when other work remains dirty.
- Coordinate one writer per overlapping mechanism and one compiler build at a time. Independent investigation may proceed while a specific prerequisite runs. No scheduler or automation is part of this task.

## Stable zero-diagnostic task definitions

### Restore a trustworthy implementation baseline

- [x] **Z00 — Repair the malformed main snapshot.** Compare every selectively committed `a0918b49` change with the intended, locally tested implementation. Correct misplaced Rust getter/match additions, the TypeScript intrinsic union and any other displaced but parseable hunks; format the existing integration changes. Preserve all unrelated WIP. Owners: Compiler codegen/analysis, Contracts and State. **Done when:** the exact proposed commit builds and its relevant native/query/created-version integrations pass in an isolated checkout, then the repair is committed and pushed. Do not rely on zero-context selective patches landing at unverified offsets.
- [x] **Z01 — Establish the repaired full-corpus baseline.** After Z00, build the current optimized compiler and refresh only genuinely stale producer prerequisites. Run the unchanged original command with the native host catalog to completion. Record the real exit, diagnostics, omissions and sources; use the resulting failures to update the following tasks. **Done when:** the count is measured from the repaired implementation and each current refusal has an owning mechanism. The historical 18 is a starting measurement, not a guaranteed new total.
- [x] **Z02 — Resolve the observed receipt integration failure.** Reproduce `native_scenario_receipts::opt_in_native_capture_retains_selected_paths_replays_and_current_state_projection` and its `whole unsupported recipe omitted: absent` assertion on repaired source. Determine whether a negative expectation became obsolete or behavior regressed. Extend the actual supported consumer if appropriate and retain genuine unsupported/permission controls. **Done when:** the complete existing recipient passes without weakening its authority checks. Start after Z00; this can proceed alongside diagnostic repairs with nonconflicting ownership.

### Complete the smaller shared query and constructor mechanisms

- [x] **Z03 — Qualify normalized WHERE correspondence.** Finish the local `checked_native_value_query_plan` change: compare the generated WHERE binder with its corresponding fresh IR query, retaining full original semantic correspondence. Owners: Compiler receipt codegen and existing query producer integration. **Done when:** genuine WHERE/order, withheld-field and filtered-empty cases pass; binder/source/IR mutants refuse; original hold_days/move_days reach or pass the next stage. Depends on Z00 and a coherent local packet.
- [ ] **Z04 — Publish sealed constructor COUNT plans with many guard queries.** Qualify the local producer change that performs independently sealed constructor selection before the old specialized whole-plan three-query restriction. Preserve the complete leading-Require census, ordinary mixed-plan rules and overall finite bounds. **Done when:** the existing multi-guard constructor integration and original fulfill_free execute with genuine receipts, including permission/race/replay controls. Depends on Z00; owns `scenario_queries.rs` and its existing recipient.
- [ ] **Z05 — Unify constructor COUNT with an exact returned primary CREATE.** Replace only demonstrated void-only/two-CREATE restrictions with the existing proof of the original primary CREATE/return and complete auxiliary effect sequence. Reuse created-row lifetime, count, policy/evidence, schedule and version mechanisms. **Done when:** both original hold and hold_days have complete native receipts and pass relevant CREATE/optional SET/event/schedule/rollback/replay cases. Depends on Z04, Z03 for the day path, and the repaired created-version implementation from Z00.
- [ ] **Z06 — Compose leading ANY with Values queries.** Retain the exact original Movement ANY producer and all its influences alongside the genuine Values query plan. Keep local empty/nonempty outcomes and source-stage observations distinct. **Done when:** original move_membership_days passes complete native lowering and relevant runtime/forgery/permission controls. Depends on Z03; do not replace the influence census with a blanket allowance.

### Finish Refer's complete native settlement workflow

- [ ] **Z07 — Complete aggregate-loop source analysis.** Finish and compile the local exact original For/LET/conditional CREATE recognizer: required root, genuine earlier Settlement CREATE, contained Credit domain/filter/order, authored finite limit, remaining/unpaid/part values, conditional Allocation CREATE and original Model return. **Done when:** the complete source fact describes the real body and altered domain/order/parent/item/effect/return inputs refuse. Depends on Z00; owns the relevant `scenario_disclosure.rs` regions.
- [ ] **Z08 — Complete independent native Consumer and transport.** Join Z07's facts against fresh original source/IR; transport created/global query-parent facts, iteration/read census, complete Model-result association and actual QueryValue descriptors. Keep unsupported paths refusing until their full proof exists. **Done when:** genuine complete native Model compilation succeeds and altered facts/IR cannot produce a recipe. Depends on Z07; coordinate Compiler receipt, query and source-loop writers.
- [ ] **Z09 — Execute repeated queries under State's genuine item phase.** Reuse the actual final staged view and private active-item lease. Authenticate the created Settlement parent, Credit reference filter and prior/within-item mutation stamps; mint occurrence identity inside State and associate each DATA observation with its real query occurrence. **Done when:** ordered items see the intended prior/own writes while wrong item/parent, stale phase, hidden/withheld DATA, Identity/revision races and actual budget exhaustion refuse atomically. Depends on Z08; owners Contracts, State query/receipt execution and runtime bridges.
- [ ] **Z10 — Finish repeated-query receipt and replay witnesses.** Retain every occurrence rather than selecting the first by query ID. Save the complete ordered loop selection, including empty; verify required per-item query/DATA witnesses and exact conditional CREATE completion. Replay historical observations under current grants without re-SUMming the postcommit Allocation domain or treating item-local empty/nonempty as a global return answer. **Done when:** missing/duplicate/reordered/forged witnesses refuse; historical replay preserves the original result and creates no duplicate effects. Depends on Z09.
- [ ] **Z11 — Qualify original Refer.settle end to end.** Use the actual original Model-return workflow with positive, empty, multi-item, replay, permission, race, forgery, overflow and late-failure cases. **Done when:** the original five settlement/query refusals are absent from a completed full capture and the actual native workflow passes. Depends on Z07–Z10. Earlier source-only two-item phase tests remain prerequisites, not substitutes.

### Finish the remaining original scenario closures

- [ ] **Z12 — Complete arrival's dates/helper closure.** Support the original is_open helper's pure dates collection and nested stored queries through the shared source/capture mechanism. **Done when:** original arrive lowers and executes with its complete guards, policy/evidence writes, schedule and event; relevant grant, time/boundary, race, rollback and replay cases pass. Depends on Z00 and only the query outputs actually used.
- [ ] **Z13 — Complete cancellation's staged Movement closure.** Preserve ordered iteration, earlier writes, subsequent Movement observations, membership/billing cancellation, conditional release/refund, failure order and current authority. **Done when:** original cancel_booking has a complete native receipt and atomic/replay qualification. Depends on the relevant staged query/loop mechanisms; reuse Z08–Z10 only where the actual mechanism matches.
- [ ] **Z14 — Complete account confirmation's finite domain.** Supply the original filtered BillingProfile query's finite mutation owner and qualify the complete confirm_account body. **Done when:** original success, absent/mismatched profile, stale/revoked authority, late failure and replay behave correctly. Depends on Z00 and its exact query consumer.
- [ ] **Z15 — Complete parent check-in/cancel CALLs.** Consume complete arrive/cancel_booking child plans through the existing same-owner call mechanism. Preserve original arguments/context, child effects, late parent failure and replay. **Done when:** the two child-closure and two CALL refusals disappear and original check_in/cancel execute correctly. Depends on Z12/Z13.
- [x] **Z16 — Complete Shift review's FIRST mutation consumer.** Retain travel_entered's exact selected row/helper/native mutation association and current authority. **Done when:** original review_swap lowers and passes absence, wrong/stale/hidden row, permission, rollback and replay cases. Depends on Z00 and only its demonstrated FIRST dependency. Qualified through the shared cohort consumer and original D1 runtime; the newly exposed reconcile ownership failure remains open separately as Z16a.

### Close the zero-diagnostic objective

- [ ] **Z17 — Drive the full original composition to zero.** After each coherent qualified batch, run the original complete command when the result will determine the next action. Attribute any newly exposed failure to its existing owner and continue the sequence until exit 0, zero diagnostics, zero omissions and a complete usable artifact. Never decrement the count from a narrower test or a changed refusal message. Depends on the repaired baseline and all remaining original source paths, including failures newly exposed by this work.
- [ ] **Z18 — Qualify the final committed result and finish CI.** Review the final permission/source/order/atomicity/replay joins; reuse relevant passing runtime evidence and run checks warranted by changed behavior. Resolve actual compiler, workspace, browser and installed-artifact failures. Commit/push completed fixes and obtain all three green jobs for that exact source. Confirm the original complete compile and artifact against the final commit, with no temporary trace or incomplete implementation accidentally included. **Done when:** every objective completion criterion above is demonstrated. Depends on Z17 and the relevant runtime consumers; CI repairs can start earlier.

## Wider inventory implementation tasks

These tasks account for the complete inventory, including its existing requirement cross-reference. They follow the zero-diagnostic sequence unless a concrete dependency pulls a bounded part forward. Before changing an older allegation, reproduce its remaining part on current source; reuse completed behavior. A row closes through its original consumer and relevant denial/failure/recovery cases, not by changing only a serializer or by repeating a historical assertion.

| Task | Implementation and dependency | Completion check / existing requirements |
| --- | --- | --- |
| **B01 — Remaining language and source facts** | After Z00, close residual event/member/Boolean observer, helper/query, source ownership, typed descriptor/default and actor/team/clock/locale/subject scope gaps outside the repaired corpus. Add only the typed fact required by an actual caller. | Original inline/import/helper consumers agree and source/IR substitutions refuse. CAN18 outcomes 3/4/5/8/13; SEQ-005/010; C02/C03/C04/C19; challenge T08. |
| **B02 — Rule, hook and lifetime graphs** | Finish remaining original before/after/staged/null-actor hook graphs, ordered rules/locks/invariants/reverse/nested/delete and imported parent/lifetime joins in the existing owner transaction. | Original graphs preserve evaluation order, current grants, one commit/version, late rollback and replay. CAN18 outcome 12; SEQ-011; challenge T17/T18/T29/T31/T32. |
| **B03 — Calls, completion and SEND correspondence** | Reuse Z15 and existing call/dispatch owners for remaining original parent calls, Invoice completion triggers and Maintain retry/replay. Attribute any timeout to its real stage before repairing it. | Genuine terminal payload/current target, complete original body, effect order, stale/revoked authority and no duplicate SEND. CAN18 outcomes 9/10/11; C06/C18; challenge T24/T32. |
| **B04 — UI, forms, sinks and preferences** | Consume actual source/query outputs for remaining result arrays, stats/history/containers, operation forms, copy-label/step behavior, reference preferences/default/reset/conflict and locale/timezone/Alert sinks. Extend the existing browser lifecycle. | Real DOM/HTTP/State behavior preserves drafts, clear/default semantics, focus, current versions, visibility and revocation; original sinks preserve escaping/freeze/order. CAN18 outcomes 6/7; FP.PREFERENCES/BROWSER; challenge T19/T20; S9-Q01/SEM-R05. |
| **B05 — Identity transaction boundaries** | Resolve the exact remaining Identity/State transaction participants and implement the required J2/conditional lifecycle variants through existing authoritative storage. Reuse accepted invitation/recovery/removal work. | One winner, last-owner protection, durable rollback/replay and honest cross-store limits. FP.IDENTITY-CONTRACT/FP.IDENTITY. |
| **B06 — Protected invocation and staff review** | Finish actual Workbench context/approval, Task update/complete and publication consumers using frozen allowlisted arguments/reference provenance, protected preview and current target admission. Staff review derives checked owner facts. | Parent/child effects and late invariants commit or roll back together; forged/stale/wrong-owner calls refuse. FP.INVOCATION/POLICY-REVIEW; SEQ-039. |
| **B07 — Rich executable examples** | Extend Testkit's existing owning fixtures and observation/dispatch hooks for genuine finalized Files, provider/delivery outcomes and original tables/sequences. | Actual emitted examples assert independent expected values; false expectations fail and setup failure cannot count as business rejection. challenge T22/T23; LG02. |
| **B08 — Durable Work and progress** | Complete the real bundled receipt observer route, relation/progress/notification consumers, deployment target availability/terminal mapping and remaining durable fanout/cohort/schedule matrix. Reuse accepted D1 due/cohort tests. | Actual installed route and persisted restart/race/recovery/revocation behavior; no injected substitute route or duplicate effect. challenge T25/T26/T34; D3B Q4-C; FP.DISPATCH-AVAILABILITY; SEQ-048/F8. |
| **B09 — Files and resource lifetime** | Implement remaining multiple-owner separate-store publication, original authenticated receiving request/source/revision joins, quota/override producers, supported protected provenance, expiry and sensitive-copy disposal. | Atomicity or explicit uncertainty, once/replay, real reopen, wrong cause/owner/File/lifetime refusal and no unauthorized byte access. TECH-F01/F02; FP.FILES-DURABLE/LIFETIME; SEQ-024. |
| **B10 — Import, export and documents** | Complete original CSV import/current File/reference/replay, compiled mounted File/browser export/Print and immutable issued/receipt PDF/download consumers. Reuse accepted durable export backend; take B09 outputs only where needed. | Actual source-derived operations and current-authority downloads preserve immutable snapshots, expiry, partial failure and replay. FP.CSV/AW-REPLAY-IMPORT/EXPORT/AW-DOCUMENTS; DEL-B02. |
| **B11 — Production AI, cancellation and accounting** | Finish declared text/media/structured production profiles, current-attempt stop/reconcile/deadline, same-owner Chat/Knowledge request/reservation/outbox commit, associated once-only settlement and late usage/release. | Genuine profile/usage identity, concurrent cap admission, stale/wrong-attempt refusal, uncertain recovery and no duplicate settlement or request. SEQ-021/022/042/043; FP.SERVICE-CATALOG. |
| **B12 — Judgment and corpus authority** | Finish original Knowledge/Triage typed Judgment and Handbook/model-bound retrieval/index/provenance consumers. Consume B09/B11 outputs only for their actual File/provider requirements. | Exact options/distributions/usage reject malformed evidence; current authority covers all supplied context, including uncited material, withdrawal and supersession. FP.AW-JUDGMENT/CORPUS; SEQ-046/047. |
| **B13 — Concrete reversible recovery** | Select and implement one actual reversible definite-success domain effect with its own pending/success/failure/unknown/escalation protocol. | Authorized refund/withdraw/repair survives duplicate/crash/reconciliation and refuses irreversible or uncertain reversal; no cross-service rollback promise. SEQ-045. |
| **B14 — Mailbox, payments and connectors** | Finish configured owning Mailbox/MIME/reply/reconcile, verified payment account/events/reconciliation, source namespaces/cross-app cause/outcome and authenticated source/read/conditional-write adapters, plus HR/onboarding/course handoff. | Each original receiving workflow authenticates the actual cause, source, account, authority and revision and survives replay/recovery. FP.MAILBOX/AW-MAILBOX/AW-PAYMENTS/SOURCE-MAPPINGS/AW-SOURCE-CONNECTOR/AW-ONBOARD-HANDOFF. |
| **B15 — Operational services** | Finish configured maintenance through canonical admission, provisioned Ping, safe Alerts, minimized authenticated Errors intake, consent/session tracking and finite historical reports. | Real configured ingress/adapter consumers preserve authorization, consent, historical facts and durable failure/recovery. FP.MAINTENANCE/PING/ALERTS/INSTRUMENTATION/TRACKER/REPORTS. |
| **B16 — Dependent forms and concrete approvals** | Consume required source/query/rule/context outputs for original CountryRegion/Approve/Rent forms and ExpenseReview/CreativeRevisionReview journeys; integrate with B04/B06 only where used. | Parent-change/late responses, forged or revoked choices, accessibility/drafts, self/duplicate/ineligible votes, frozen evidence and separately authorized final actions pass. SEQ-037/038. |
| **B17 — Native preparation construction** | Replace completed-TypeScript-bundle handoff with raw facts, native-owned final construction and consumed output/publication. Qualify the final executable on the claimed host. | Exact original dependencies/output, cancellation, custody and artifact closure hold in the actual installed constructor. ports P04–P09; C04.preparation-join/native-release. |
| **B18 — Native Values, validation and Work consumers** | Finish residual carrier/error/order/identity, demand/predicate/codec/lifetime, State admission/read and ordinary MCP joins; wire existing full-family Work calculations into actual F5/F7 consumers. | Real complete calls preserve original error/evaluation/default/disposal rules, current admission and durable outcomes; unsupported profiles refuse without semantic-error fallback. ports A07–A09/V03–V09/W02–W06; TECH-V03. |
| **B19 — Native asset delivery and resource decisions** | Consume B17/B18's final producer bytes/glue/vendor/import inventory. Finish explicit backend selection/disposal/restart/persisted-byte scope and the original whole-call comparison with a stated budget. | Correct installed assets load; rollback/reselection preserves persisted state; record actual retain/native/adoption disposition without assuming speed. ports A08/A10/V11/W05/W07–W08/P10; C04.values-assets/work-assets; C05. |
| **B20 — Development loop and measured reuse** | Finish stable session origin, coalesced saves, authenticated draft-safe reload, conservative change classification, CSS replacement and one bounded authorized region update. Reuse completed T22 producer caching; select further reuse only from a demonstrated remaining cost. | Same-tab edit/burst/error/recovery, current credentials, draft preservation, cancellation/cleanup and stale/late refusal work. T18–T21 precede matching T24–T26 consumers; T23/T27–T30 follow their actual inputs and measured go/no-go. |
| **B21 — Architectural and complexity reduction** | Consolidate repeated receipt/profile/query/constructor/read/replay mechanisms while their functional owners change. Recover the original complexity residual against current source before broader dispatch; split only cohesive small-interface owners. | Remove actual duplicate branches/special cases with caller parity and permission/error-order coverage; measure affected bodies rather than merely moving lines. CAN-COMPLEXITY-SCOPE-003; Complexity T00–T04. This is continuous work, not a prerequisite to each diagnostic repair. |
| **B22 — Draft generation and frontend acceptance** | Map selected original requirements/closure/resources; enable selected composed-app preview/watch; join actual resources; generate through the supported authenticated host/model; qualify complete functional, accessible desktop/mobile/locale/theme journeys and saved-output CI. Reconcile historical case/reference denominators. | One actual app first, then the remaining original app/category requirements; genuine generation provenance, prompt fidelity and no-model regression. DFE-01–07; BGI-06/13; FP.QUALIFY; SEQ-025/026/040. No handcrafted replacement for required model output. |
| **B23 — Full original application qualification** | Reuse Z18 and B01–B22 outputs to complete each original app/companion's required actors, permissions, providers, Files, callbacks/history, unknown/stale/denied outcomes and recovery. Do not rerun accepted identical units without a changed concern. | Complete original workflow matrices once at their real scope; selected-operation success does not qualify a whole app. FP.QUALIFY; challenge T37–T40/G3/G4; SEQ-025/026/040. Shares the same app results as B22. |
| **B24 — Installed Linux release qualification** | Consume the final changed compiler/dev-server/library/editor/producer/vendor assets; package and cold-install outside the checkout; verify actual CLI, Worker, declarations, minimum Node and browser tooling. | Current Linux x86-64 artifacts work on the target computer. Existing v0.1.2 is reused at its scope; publication is a separate requested action and Mac remains deferred. FP.INSTALLED-RELEASE; C04.complete. |
| **B25 — Installed migration and upgrade recovery** | Implement immutable predecessor/desired/body/policy/release binding, protected-value coverage, physical owner inventory, custody/fences and persisted coordinator; integrate pending-work compatibility and staged activation/recovery. Reuse MIG-CONTRACT and bounded unique-claim exchange. | Original predecessor→desired upgrades preserve data/history/identity/retained work and survive interruption, lost acknowledgement, forward-only partial activation and permitted rollback/refusal. FP.UPGRADE-JOIN; SEQ-027; CAN18 outcome15/C21/S9-Q08. Live activation remains a distinct authorization boundary. |
| **B26 — Source, requiredness and legacy closure** | Resolve recorded business/source ambiguities with their actual contracts; reproduce required-array/creation-reference and description discrepancies before fixing; accept remaining original draft diffs and perform exact remaining owned cleanup. | Actual affected app/design diffs satisfy intended semantics and existing consumers; completed recoveries/migrations are not restarted. FP.APP-ADJUDICATION/DOC-REQUIREDNESS; challenge T36; muse-migration C01/C02. |
| **B27 — Full supported-product acceptance** | Consume the applicable original application, installed release, provider and migration results from B23–B26 and the native owners. | Required workflows work through the shipped supported release with safe upgrades/recovery and explicit unsupported profiles. FP.FULL; SEQ-060–063; ports A11/V12/W08.3/P11/C01–C05. This aggregate closes by consuming results once, not by building another implementation. |

The accepted compiled-decimal requirement (`FP.COMPILED-DECIMAL`, challenge T15), recovered drafts, persisted decoder consolidation, selected grammar/editor/generation/auth/setup/browser/runtime repairs and existing T22 invariant bundle reuse are already completed at their recorded scopes. Reopen only for a demonstrated regression or a changed consuming boundary. The original24 measurement requirement (CAN18 outcome14/T41) is implemented repeatedly by Z01/Z17/Z18, not by an additional capture project.

## External inputs and optional proposals

- Record a missing real provider/model/account/tokenizer/usage/cancel/reconcile profile against only its matching B09–B15/B22 consumer. Continue available local source and controlled integration work independently.
- Preserve the original benchmark/tool/MCP host and recipient-specific BDD3/OUTBOX release requirements at their actual scope. They do not block unrelated zero-diagnostic engineering.
- Default native adoption, physical TypeScript retirement, live activation/deployment and new release publication retain their specific decisions. Do not manufacture approval gates for ordinary authorized local repairs.
- Keep Mac release, scheduler work, multisession resume, new syntax/statecharts/package parameters, additional Rust ports/common ICU parser, optional dependency/history semantics and research/ranking/cache proposals deferred or conditional until their existing trigger is met. They are not mandatory subtasks of zero diagnostics.

## Verification entry points

Run these from a coherent checkout with the actual producer prerequisites required
by [CI](../../.github/workflows/ci.yml). They are selected by the changed behavior;
do not run the whole sequence again for an unchanged documentation update.

```sh
bun run build
bun run typecheck
bun run check:unitban
bun run lint:compiler
cargo test --locked --release --manifest-path compiler/Cargo.toml \
  --test native_first_query --test query_source_producer
```

The complete original native compile uses the [durable 24-operand command](REMAINING-WORK.md#next-original24-composition-capture--outcome14--t41), a current optimized compiler and `packages/cloudflare/dist/native-catalog.json`. The normal complete compiler/dev-server, runtime, browser, installed-package and minimum-Node checks remain the commands in the three CI jobs; focused tests do not replace their final result. After an incorrect selective commit, validating a clean checkout of the actual proposed commit is essential even when the dirty working tree already passed.

## How to resume

The execution loop is: select a ready task → trace the exact failing owner →
implement the smallest shared correction → review permissions and failure behavior
→ run affected existing integration checks → commit and push → select the next
ready task. Refresh the complete diagnostic count after a qualified compiler
change that can alter it; runtime-only progress does not change that count.

Read the current baseline and next implementation queue above. Select the first
ready incomplete output; do not restart completed baseline repairs or treat older
measurements as current. The detailed Z definitions retain stable identifiers and
acceptance contracts; the queue supplies their current order and subdivisions.

Keep a single physical writer for overlapping analysis/codegen/State mechanisms
and one shared Cargo writer. Use immutable compiler copies for long captures and
stable package outputs for runtime imports. Inspect other work read-only until an
explicit handoff. A live capture is a dependency to poll, not a reason to launch
another copy. Do not start a scheduler.

For a blocked packet, identify the exact missing input, list practical ways to
unblock it and choose the smallest correct approach within existing authorization.
Continue independent ready work. Missing permission or protected authority must
be supplied through its genuine owner; a refusal must not be bypassed to obtain
zero. Keep unsupported behavior visible until implemented correctly.

After each qualified packet, record its actual scope in the existing task entry,
commit/push the coherent change and update the measured total only after a complete
original capture. Once Z18 closes, the B01–B27 tasks remain the comprehensive
broader-product queue; take them by their stated dependencies when requested.
