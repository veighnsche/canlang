# Remaining CanLang work

## Current four-plan execution view — 2026-10-11

This view reconciles the four requested plans at local main
`d11745e10d240c7e3185fcfc5f67dc8343d06da8`. Their task entries remain authoritative
for detailed actions and evidence; this index supplies ownership and execution
order, not a second task ledger. Active/unmerged worker changes are not accepted
by this snapshot. Apply [finite execution](../AGENTS.md#finite-execution).

| Plan | Remaining at its declared scope | Authoritative execution entry |
| --- | --- | --- |
| Packages | **28 of 48 selected packets unfinished:** 15 partial, 12 open, 1 human-held. The packets reference 100 distinct existing canonical IDs; this is not completion of the original 333 duties. | [Queue](../docs/research/package-library-audit-20261006/repair-queue/queue.json): top-level `current_execution` and each existing packet's `current_execution`. Historical `ready` and authorization fields are labeled separately. |
| Compiler | **9 of 67 canonical references unfinished; 58 finished at recorded scope.** OR-06, OUT-R05, S9-Q01, S9-Q02, S9-Q05, S9-Q07, S9-Q08, SEM-R05, SEM-R08. They overlap across shared producers, consumers, decisions and holds. | [Current remainder](compiler-completion/README.md#current-remainder-and-finite-completion); local work-row labels index residuals without adding canonical tasks. |
| Capability | **31 of 63 task stages unfinished; 32 accepted stages.** SEQ-005, 010, 011, 021, 022, 024–027, 037–040, 042–048, 051–054, 057–063: 20 contract/implementation/qualification tasks, seven conditional/deferred gates, four cycles attached to actual releases. Stage acceptance is not whole-product acceptance. | [Roadmap](capability-roadmap-20261008/README.md) current execution view reconciles sequence requirements with the coordinator's execution state and later component outcomes. |
| Can dev server | **T04 and T11 have explicit first-slice implementation/qualification gaps; G2 and G3 remain open.** Other T00–T13 producer/consumer results are reused at their scope; final criterion closure still follows G2. G1 has a recorded passing shared-join result. | [Declared first-slice remainder](can-dev-server/PLAN.md#current-execution-finish-the-declared-first-slice), including existing platform handoffs outside Office supplies. |

These counts use different task/stage units and share outcomes. **Do not sum
them into an independent-job count, progress percentage or estimate.** An
accepted output can satisfy several existing references without several new
implementations, tests or reviews. Historical records below retain their own
dates and authority; they do not freeze current workers or override these plans.

### Dependency order and independent lanes

1. **Resolve only actual defining gaps.** Packages publishes its selected finite
   contract/host/resource outputs; Compiler and Capability resolve the named
   source, membership, event-identity or policy decisions needed by an existing
   workflow. Obtain the concrete output instead of waiting for an entire plan.
   Routine reversible implementation choices use the existing contract; difficult
   design decisions use the existing three-request JEV rule and record advice
   and uncertainty once. Unspecified wider profiles remain bounded decision
   gates, not implementation mandates.
2. **Release connected producers.** Compiler emits checked original
   declarations/sites/types; Capability supplies actual State/Work
   authority, observation, persistence and commit-lifetime behavior; Packages
   owns shared codecs, adapters and gates. Keep sole writers for shared files.
   Evidence of an already accepted component is a reusable input, not a new
   intake-only task.
3. **Connect the missing real consumer.** Dev/UI/Interfaces/Testkit use the
   actual generated source and owning producer. Finish only the named
   caller/host/profile and its current authority, order, failure/replay and
   cleanup criteria. Correct failures in their defining owner. Components may
   proceed while unrelated policy, original-app, preparation or provider gates
   are held.
4. **Finish Office independently.** T04's source-grounded eligible diagnostic
   branch unlocks T11; exact external-packet authorization gates transmission.
   Then G2 joins Office A1–A6, followed by the finite G3/A7 study. Files,
   providers, composed apps, schedules and deployment are outside the declared
   first slice and do not block it. Retain their existing platform tasks.
5. **Close selected outcomes once.** Reuse valid results, run changed integration
   joins proportionately, and perform the required independent final review on
   the real released scope. A review finding receives its affected correction
   check; a review verdict does not receive another review packet. Failed support
   trials are reported with their original denominators rather than repeated
   until a desired result appears.

### Finishability and preserved release conditions

The package queue's declared dependencies are acyclic. Cross-plan reciprocal
joins are staged as defining contract → producer → consumer → affected outcome;
consumer feedback may identify a concrete correction, but does not create a
whole-plan waiting cycle. The terminal-completion join is now qualified Dev original private late-write
rollback/replay → Compiler supported public Email publication → Dev changed public
receiving case. Reviewed8c/main758 satisfies the original private outcome; it
must not be reopened or wait for that final publication.

Every remaining entry must name a finite deliverable, accountable owner,
concrete prerequisite and observable exit. If its original requirement does not
yet select the source/profile/outcome, the next deliverable is that decision and
its release condition. The full program cannot honestly be declared complete
while human BDD3/Task22/native preparation, excluded source edits, exact external
packet disclosure, provider/data/installed-host or other recipient-specific
gates remain unresolved. This planning refresh preserves them; it neither
requests their release nor authorizes product implementation or publication.

## Historical consolidated inventory — 2026-10-06

Reconciled from the old three-plan lists against consolidated main `7fd8c6bf4717feeffc70b46819377b74b353e117` on 2026-10-06 (Europe/Brussels). The old checklists and contracts are preserved. Counts and machine task assessments below retain that historical snapshot; the post-migration qualifications below identify newer evidence to reuse before assigning work. This index does not restart implementation.

**Completed scoped first priority:** [package boundaries and Bun/Turborepo](PACKAGE-BOUNDARIES-AND-TURBO.md), committed through main `309644a6881909d8dba32560bc6711f67e00a7ab`, with [independent local migration acceptance](turbo-scheduling/evidence/final-acceptance/migration/README.md). Native discovery/checker probes, package dependencies/exports/producer builds/cycles, installed Worker assets, Turbo cache correctness and local CI/release/documentation cutover are credited at their exact evidence scope. Original native/product/installed-host parents remain open.

**Current authorized refinement:** [workerd deployment handoffs and acceptance](../docs/ideal-filetree-plan.md#workerd-deployment-refinement-2026-10-06), mapped into the existing [challenge original-app packet](CHALLENGE-AUDIT-PLAN.md#proposed-workerd-deployment-execution-and-handoff) and [Rust delivery qualifications](RUST-PORT-LANES.md#workerd-delivery-readiness-after-the-build-migration). Reuse the migration foundations and T21's completed loader; qualify T37 live serving, browser startup/assets, worker-safe receipts, actual Rust consumers and claimed installed hosts independently. This is planning refinement, with no new canonical IDs/counts, worker restart, native HOLD release or deployment.

**Historical snapshot: 236 required source-task/gate records remain**, plus **9 accepted-conditional records** and **5 deferred records**. 83 records are complete at their declared scope. These are task and acceptance identities, not that many independent coding jobs or wall-time estimates. Post-migration readiness credits above are not a recalculated task count or blanket completion of their original parents.

## Complete remaining lists

- [Challenge, D01–D08 and original gates/review/closure](remaining-work/challenge.md)
- [Rust values, input validation, work transitions, preparation and shared gates](remaining-work/rust-ports.md)
- [Finished-product workflows and documentation](remaining-work/product.md)
- [All original identities, status, concrete actions, acceptance, dependencies and evidence](remaining-work/tasks.json)
- [Alias, app, duty, layout/retirement and historical-packet crosswalk](remaining-work/traceability.json)

## What the counts mean

| Old source group | Total identities | Complete | Still open |
| --- | ---: | ---: | ---: |
| Challenge T01–T41 plus original gates/handoff/review | 51 | 19 | 32 |
| Description D01–D08 | 8 | 7 | 1 |
| Rust ports and shared gates | 230 | 54 | 176 |
| Additional finished-product outcomes | 37 | 0 | 37 |
| Documentation duties | 7 | 3 | 4 |

The finished-product manifest repeats all 230 port, 41 challenge and eight description records. They occur once here. The 27 remaining-lane packet aliases, historical filetree packets, app requirements and target/retirement clauses are mapped to their owning tasks rather than counted again. G1–G5, H01, R01 and C01 remain visible as original acceptance/closure obligations.

## Next concrete work and acceptance gaps

| Area | Concrete remainder | Existing IDs |
| --- | --- | --- |
| Compiler / canonical execution | Finish recursive/provider policy descriptors and compatibility; exact decimal execution and verified context carriers; same-context selector parity. | T04, T08, T15, FP.CONTEXT, FP.COMPILED-DECIMAL |
| Rust values / validation | Complete semantic adapter/ABI parity and protected owned-input lifetime, current/prepared/whole-call budgets, actual supported consumers and explicit selection/rollback. Retain credited native foundations. | A07–A11, V03, V07, V09–V12 |
| Rust work | Assemble standalone decisions into the Cargo/ABI library, deliver actual Wasm and integrate state/runtime durable consumers; prove race, crash, restart and resources. | W04.4, W05, W06, W07, W08 |
| Native preparation | Finish host/native phases, verify actual staged bytes before publication, installed supported-host packaging and full consumer parity/economics. D’s task-specific human HOLD remains. | P05, P07, P09–P11 |
| Runtime receipts / progress / fanout | Finish worker-safe receipt observer/no-injection populated serving, real send-association/progress/notification and membership/revocation joins, plus the original fanout matrix. | T24–T27, T31–T34, D3B Q1/Q4-C |
| Browser and authority | Mount built assets/bootstrap/polling and real operation binding; qualify preferences, CSV, exports/Print and authoritative identity/owner expiry/files. | T19, T20, FP.BROWSER, FP.IDENTITY, FP.PREFERENCES, FP.CSV, FP.EXPORT, FP.LIFETIME, FP.FILES-DURABLE |
| Required product consumers | Complete configured maintenance/ping/instrumentation, mailbox/payment/document/source/report/tracker/model consumers and genuine original app workflows. | FP.MAINTENANCE–FP.AW-REPLAY-IMPORT, T36–T40 |
| Delivery / independent acceptance | Actual values/work/native assets and supported installs, fenced upgrades, corpus/source closure, remaining gates, independent original/port/product review and final closure. | C04/C05, FP.INSTALLED-RELEASE, FP.UPGRADE-JOIN, FP.QUALIFY, FP.SOURCE-CLOSURE, FP.FULL, G1–G5, H01, R01, C01 |

This is a dependency-aware set of work areas, not a new fixed lane allocation. Use disjoint ready slices and actual command capacity when a later start is authorized; do not hold a whole worker behind one heavy verification command or wait for an unrelated full parent. The JSON retains exact dependencies and old defining-owner paths.

## Preserved completion and limits

- Existing description parser/reference/renderer/IDE and accepted repair evidence stay credited. D08 closure is separate from the D07 implementation/review scope.
- Consolidation preserved and verified Rust values, kernel/preparation checkpoints, browser assets and joined runtime mechanisms. Successful build/typecheck and narrow Rust/Node/Vitest suites do not certify complete installed workflows or native default adoption.
- Current Q2/Q3 observer seams exist. Older blanket claims that every receipt bridge is absent are superseded; current Q4 proves only its stated checkout/injected-observer and bundled fail-closed scope.
- A real staged-file integrity defect is recorded under the incomplete preparation publication adapter. Owned-token exposure and native/TS registry lifetime findings retain source-observation/evidence limits.
- Authored `.can` intent and deliberate negative witnesses remain authoritative. Do not close parents from partial slices, reduced app projections, historical ticks or process percentages.
- Layout is flexible guidance. Conditional structural moves/retirements need actual caller/import/build/install cutover; retained evidence and semantic owners are preserved. Named editor lifecycle and upgrade mapping gaps are carried in the crosswalk.
- Optional W09 scheduling, localization of MCP, automatic translation, public publication/production deployment and unrelated implementation are not silently added to required acceptance.

## Execution state

At this October 6 historical snapshot, all eight Muse instances were stopped and the heartbeat was PAUSED; there were no lane assignments for that run. These are historical facts, not a stop instruction for the four existing local workers. This inventory creates no goals, sessions, timers or command grants. D’s artifact-preparation port stays human-held. Old runtime IDs, queued-message banners, startup checkboxes and deadlines are historical rather than current dispatch authority.

## Reconciliation verification

All 323 canonical manifest records and ten original auxiliary identities are accounted for, with unique namespaces and no missing dependency identities. All 230 port records retain 220 required versus ten conditional/deferred dispositions. Completed rows have no new work assigned; every required open row has concrete remaining actions. Original acceptance clauses and source/evidence paths remain available in the machine ledger. This inventory used read-only source and existing execution evidence; it ran no new product build/tests and advanced no complete source-review checkpoint.

[Reconciliation checks and independent review](remaining-work/verification.json) record the exact coverage, evidence-link and preservation checks for this snapshot.
