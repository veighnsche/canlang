# Remaining implementation tasks

Updated after the seven implementation commits ending at `eb8a8544` on 23 October 2026. This is the execution checklist for the audit-derived backlog: **21 open named packets**, plus the next native-diagnostic measurement. Nine packets have implemented results below; File admission retains the stated support limits. Packet counts are not estimates of effort or diagnostic counts.

The [reviews](reviews/index.md) retain the original source reasoning at audit baseline `8d48f969`. Current completion status is recorded here. The [broader product roadmap](../implementation/REMAINING-WORK.md) also contains older feature proposals and app-specific requirements; this checklist does not declare all of those satisfied or all external app semantics reviewed.

## Start here

- [ ] **Measure the current full native corpus.** Run the existing complete native corpus check once against current source and correctly built producers (the last recorded corpus contained 26 sources). Record the complete diagnostic list by source, code and owning mechanism, including any omissions or timeouts. Keep native compilation separate from analysis-only results. The last recorded full run had **56 diagnostics before the latest seven commits**; the current count is unknown. Use this result to select the next shared repair toward zero, rather than guessing which backlog item removes which diagnostics. Do not suppress diagnostics, omit sources, enlarge timeouts or weaken permissions to reach zero.

After that measurement, start with generation retry correctness and the development lifecycle fixes below. A demonstrated repeated compiler/runtime root may move ahead of that order. Independent ready work can proceed without waiting for unrelated design questions.

## 1. Fix request replay and development lifecycle

These are the next correctness fixes. The two generation tasks share one controls/lifecycle owner; the two development tasks need coordinated owner/preview changes.

- [ ] **GEN-REQUEST-C1 — Prevent duplicate external generation launches.** Durably bind request ID, input and attempt before launch. Concurrent or interrupted identical resends must recover that execution or report unknown; changed input must conflict. Preserve finite recovery, attempt fences, candidates and current code. Verify real concurrent requests and reopen/interruption through the existing generation lifecycle.
  - Owner: Cloudflare `generation/controls.ts` and `generation/lifecycle.ts`; CLI forwards outcomes. [Source review](reviews/host-invocation-delivery.md).
- [ ] **GEN-C1 — Report incomplete requested generation outcomes honestly.** A composed `accept:true` request must report failure/unknown if required outputs remain incomplete. Preserve `accepted:false`, current code, original ledger replay, finite attempts and lease/journal promotion checks. Verify the public control and CLI result, including exit forwarding.
  - Owner: Cloudflare `generation/controls.ts`, with `cli/gen.ts`. Coordinate with GEN-REQUEST-C1; no replacement state machine. [Source review](reviews/saved-generation.md).
- [ ] **DEV-C1 — Honor cancellation at final preview publication.** Check an observed cancellation at the existing candidate selection/publication fence, including cancellation after final worker recapture. Preserve revision/currentness checks, the previous preview and typed cleanup. Existing stop admission is a separate boundary.
  - Owner: `dev-server/src/owner.rs`. Verify through existing real lifecycle integrations. [Source review](reviews/native-development.md).
- [ ] **DEV-C2 — Retain fixture staging until release is confirmed.** Register the staging directory in the existing generation resource paths. Unconfirmed SDK operations or failed cleanup must retain custody; partial fixture writes remain explicit. Do not automatically replay the work.
  - Owner: `dev-server/src/preview.rs`, coordinated with SDK/host/example bindings. [Source review](reviews/native-development.md).

## 2. Close bounded validation, delivery and tooling defects

These tasks are independently actionable. Coordinate V-LOOKUP-C1 with any other Values schema writer; the optional Wasm fixes retain their distinct domain and ordering requirements.

- [ ] **V-LOOKUP-C1 — Use own declarations for schema lookup.** Resolve operation/contract/enum names with own membership or null-prototype maps. Unknown `toString`/`constructor` must follow ordinary ValueError/model-reference behavior while explicitly declared names remain legal. Verify real public schema and nominal inputs.
  - Owner: Values `src/internal/schema-core.ts`. [Source review](reviews/values.md).
- [ ] **V-ORDER-C1 — Preserve validation and error order in the optional Wasm path.** Keep original operation guards, property access and errors before tagging selected calls. Use genuine provenance or canonical compatibility paths; never eagerly inspect arbitrary values to classify them as inert. Default TypeScript behavior remains. Compare real getter/error traces through public selected-backend consumers.
  - Owner: Values `bindings/backend.ts`, coordinated with carriers and decimal calls. [Source review](reviews/values.md).
- [ ] **V-BOUNDS-C1 — Enforce inclusive bounds in native owned-value validation.** Apply constraints after exact scalar decoding, preserving omitted/null/array handling and ordered errors. Implement the owning comparison or explicitly refuse unsupported constrained joins. Preserve HTTP/MCP postchecks; no silent TypeScript fallback after native failure.
  - Owner: Values `semantics/src/validation.rs`, with profiles/bindings handoff. Verify below/at/above-bound real profile inputs. [Source review](reviews/values.md).
- [ ] **PROVIDER-C1 — Reject inherited provider choices.** Require own membership for legacy SystemOne choice results while preserving complete own probability keys, confidence and sum validation. Explicitly declared option names remain legal; the installed JudgmentV1 contract stays distinct.
  - Owner: Services `src/judgments/systemone.ts`; existing public adapter/provider-response integration. [Source review](reviews/providers-work-files.md).
- [ ] **DELIVERY-C1 — Verify the bytes actually published.** Compare the consumed staged buffer with the retained reviewed identity immediately before writing. Preserve preview refusal, destination containment, cleanup and honest sequential partial-write reporting; do not imply filesystem-wide atomicity.
  - Owner: Cloudflare `src/preparation/publication.ts`; existing publication integration. [Source review](reviews/delivery-upgrade.md).
- [ ] **AUTHOR-C1 — Repair editor transport framing and cleanup.** Bound retained headers, parse exact unambiguous lengths and preserve UTF-8 frame boundaries. On unrecoverable framing, retire pending requests, documents and transport state. Verify malformed, split and oversized peers through existing process/lifecycle integrations.
  - Owner: `editors/vscode/src/client.ts`. Keep the current protocol owner; no new facade or mandatory library migration. [Source review](reviews/authoring.md).
- [ ] **SETUP-C1 — Migrate stale setup integration calls.** Replace four old `getD1Database` calls with the current private administrator/production handoff. Preserve real unsafe-lock cases and keep the SDK database handle out of production.
  - Owner: Cloudflare `test/soda-writer.integration.test.ts`; existing native provisioning/Identity consumers. [Source review](reviews/runtime-setup.md).
- [ ] **REPO-DOC-C — Correct developer commands.** Repair absent `verify:turbo-cache`/`check:complexity` references and obsolete CI guidance against the current manifest and workflow. Preserve useful historical measurements with their scope; do not recreate removed tooling to fit old prose.
  - Owner: `docs/dev-setup.md`. Documentation verification only. [Source review](reviews/repository-current.md).

## 3. Continue receipt/profile simplification

The copy-limit defect is fixed. These tasks address the remaining shared workflows; file moves alone do not complete either task.

- [ ] **RT-C1 — Consolidate the next complete receipt/profile workflow.** Select one source-backed profile and trace its original-stage/current authority, complete domain, effects, File handling and failure behavior across compiler, State and host. Replace duplicated workflow logic with the shared mechanism. Verify genuine renamed sources, forged inputs, stale state, races and replay. Preserve private issuance, source/ancestor/Identity checks, effect order and final revalidation; no global cap increase or app exception.
  - Dependency: RT-MAX-I is now resolved; select the actual next profile before implementation. Owners: one compiler collector writer, one State receipt writer and one host integration writer. [Source review](reviews/receipt-profiles.md).
- [ ] **P-CODEC — Finish persisted decoding consolidation after deciding compatibility.** Explicitly settle which historical/current rows are accepted, the projection and fault order. Then replace duplicated Cloudflare dispatch decoding with the shared Work-owned mechanism where compatible. Work's stricter reader is not an interchangeable replacement merely because the code looks similar. Verify real accepted/refused persisted rows.
  - Dependency: accepted-domain/error-order decision before substitution. Owners: Work `src/kernel/tables.ts` and Cloudflare `src/runtime/invoke.ts`. [Source review](reviews/host-invocation-delivery.md).

## 4. Finish integrations with explicit contracts

These are support gaps and design-dependent joins. Resolve each task's stated dependency and implement one real consumer at a time; unrelated work remains available.

- [ ] **MIG-CONTRACT — Define the complete migration and recovery contract.** Bind immutable predecessor, target, body, release and migration ID. Specify the producer for protected values, locks, scope and lifetime, plus stop/writer/cleanup/dispatch custody and retained-release inventory during partial activation. Bare IDs or pending rows do not prove compatibility. Native migration is currently refused.
  - Owners: State/contracts, Files/Work, compiler and deployment at their defining boundaries. This is a dependency for installed migration support. [Source review](reviews/state-migration.md).
- [ ] **MIG-C1 — Handle unique-claim exchanges across migration chunks.** Implement bounded, persisted, collision-safe progress for deterministic cross-chunk exchanges. Preserve complete final-set uniqueness and atomic row/history/claim/cursor updates. Verify real compiled mapping, reopen and failure cases.
  - Dependency: MIG-CONTRACT before installed cutover. Owner: State migration activation, coordinated with memory/D1/Durable Object adapters. [Source review](reviews/state-migration.md).
- [ ] **BROWSER-C3 — Connect explicitly armed refresh operations.** Join checked refresh-operation metadata to a user-armed canonical POST with retained validated arguments, current CSRF/context and one outstanding request. Preserve disposal and operation permissions. GET polling must remain read-only.
  - Owners: compiler page descriptors, contracts/UI shell and browser lifecycle through one coordinated change. [Source review](reviews/browser-presentation.md).
- [ ] **AUTH-DELIVERY-C — Mount existing auth and team primitives in generated transport.** Connect OAuth metadata/consent and canonical team/invitation routes using owning app/team/source-role policy. Addressed invitation acceptance and removal staging must use existing Identity/State authority. Verify real generated registries/routes and consent/invitation/removal journeys.
  - Owners: Worker main/assembly/bundle, Interfaces and compiler registry handoffs. No parallel app-auth model or second identity service. [Source review](reviews/identity-authority.md).
- [ ] **PRODUCER-JOINS — Complete selected missing provider/adapter journeys.** Choose a concrete required consumer before adding installed Images inspection/validation, Mailbox/inbound-attachment replay, held CLI adapter/resume or default fanout cancellation. Close permission, custody and unknown/recovery behavior at the actual receiving adapter. Do not infer provider success from compilation or blindly resend work.
  - Owners: Services/Files/Cloudflare/generation adapters with their canonical contracts. [Source review](reviews/providers-work-files.md).

**File admission support limits:** current native grants/retries are implemented, but source-level quota/override producers remain absent and protected provenance unsupported by preparation refuses safely. Select and define those contracts before extending support. Final business guards and attachment admission remain independent. Do not relabel these limitations as completed by the passing upload integration.

## 5. Verify the remaining recovery and retained-work gaps

Run these against the relevant implementation/contract, using real retained state and existing integration recipients. Reuse applicable prior results; a broad passing suite does not substitute for these specific journeys.

- [ ] **SETUP-V1 — Verify setup ambiguity and recovery.** Cover lost acknowledgement, rollback including the setup claim, persisted foreign operation/token/context, initial receipt-publication failure, matching unexpired recovery, expiry refusal and custom-D1 post-commit ambiguity. Deleting a receipt after a successful setup is narrower evidence.
  - Owners: existing Identity bootstrap and runtime integration drivers. Pair with SETUP-C1 where its test/API migration supplies the consumer. [Source review](reviews/runtime-setup.md).
- [ ] **HOST-V1 — Verify actual retained due/cohort execution.** Exercise a nonempty private-due FIRST and real cohort tick/fanout through restart, races, navigation and termination. Establish actual executable selectors; a handler probe or fixture JSON does not qualify retained scheduling. This task does not create a scheduler for this chat.
  - Owners: existing native due/cohort, State and Work recipients. [Source review](reviews/host-invocation-delivery.md).

## Implementation constraints

- Keep permission, original-stage/current decisions, evaluation/error order, atomicity, replay and recovery behavior intact. Diagnostic reduction must come from correct supported behavior.
- Prefer shared mechanisms over app-specific exceptions. Split a file only for a cohesive responsibility; moving code alone is not complexity reduction.
- Commit coherent tested changes early and often. Coordinate writers to shared compiler, Values, State, host and browser files; avoid competing build-output writers.
- Verify meaningful behavior in existing integration/end-to-end tests; unit tests remain prohibited by repository policy. Build the actual affected producers and their required staging/catalog steps. Reuse passing evidence and avoid unrelated rebuilds or audit refreshes.
- Keep unsupported joins explicit and preserve unrelated work and commits.

## Completed in the latest implementation batches

| Completed packet | Result |
| --- | --- |
| LANG-PROOF-C | Original parsed fields/anchors authenticate unique-condition metadata; nine integration tests pass. |
| CHECK-C1 | Retention checks follow resolved helper/member/default dependencies. |
| CHECK-C2 | Expected example values receive compatibility checks; checker/example suites pass 38 + 30 tests. |
| EMIT-C1 | All seven emitted decimal helpers pin the owning family; three decimal integrations pass. |
| LANG-VALUE-EXPECTATIONS | Stale compile-refusal assertions corrected while genuine unsupported cases remain; ten inventory integrations pass. |
| RT-MAX-I | Authenticated source-copy loops reuse the ordered bounded guard bank; all 21 proposal cases pass, including maximum/overflow, permission races and replay. Ordinary limits remain unchanged. |
| FILE-INTENT-C1 — native portion | Shared current-context admission and Values draft validation cover grants/retries, nested/union inputs, required records, versions, CSRF and membership. Three durable Files cases pass. Support limits remain listed above. |
| BROWSER-C1 | Current denial removes private content and blocks late restoration; obsolete denials cannot clear a new page. |
| BROWSER-C2 | Shared stale feedback retains authorized drafts, consumes its marker before a fresh morph and preserves retry behavior. Both native browser journeys pass. |

Seven commits: `0dbb0adb`, `2ed796d7`, `1e8ddad8`, `6a8412c6`, `7c62f0cf`, `66fe1a24`, `eb8a8544`. They also fix the manual draft-session initial-check handshake. Builds, unit-test bans and whitespace checks pass at that implementation boundary; this documentation reorganization does not rerun runtime checks.

## Reference material

<details>
<summary>Audit slice-to-packet mapping</summary>

This is responsibility coverage, not a second execution order. Use the checklist above for current completion and priorities.


| Slice | Primary completion packet / recipient |
| --- | --- |
| L01 | Completed checker source trace; CHECK-C1/C2; completed bounded Given source trace; GEN-C1 |
| L02 | LANG-PROOF-C; completed L-REVIEW-PROOF source boundary; completed profile source trace; completed general emission source trace; EMIT-C1; LANG-VALUE-EXPECTATIONS; RT-C1 gated |
| L03 | Completed bounded Given/authoring source trace; GEN-C1; AUTHOR-C1; completed generation/tool source trace recipient |
| L04 | Completed native development source trace; DEV-C1/C2 |
| L05 | Completed native/TS Values source trace; V-ORDER-C1; V-LOOKUP-C1; V-BOUNDS-C1 |
| RT.CONTRACTS | completed receipt source trace; completed authority/final-disclosure source trace; producer/consumer protocol recipients |
| RT.STATE.ADMIT | completed authority/final-disclosure source trace; completed receipt source trace |
| RT.STATE.QUERY | completed authority/final-disclosure source trace; completed receipt source trace |
| RT.STATE.MUTATE | completed authority/final-disclosure source trace; completed receipt source trace |
| RT.STATE.RECEIPT | completed receipt source trace; RT-C1 gated |
| RT.STATE.MIGRATE | Completed RT-MIGRATION-REVIEW source trace; MIG-CONTRACT; MIG-C1 |
| RT.WORK.OCCURRENCE | Completed bounded provider/Work recovery trace; completed migration source trace; MIG-CONTRACT; completed host fanout source trace |
| RT.WORK.DISPATCH | Completed bounded provider/Work recovery trace; completed host invocation source trace; P-CODEC gated |
| RT.WORK.RECOVER | Completed bounded provider/Work recovery trace; completed migration source trace; MIG-CONTRACT; completed host fanout source trace |
| RT.IDENTITY | Completed bounded authority/setup source review; completed authority/final-disclosure source trace; SETUP-C1; SETUP-V1 |
| RT.FILES.INTAKE | Completed bounded intake source trace; FILE-INTENT-C1; completed receipt source trace |
| RT.FILES.RETAIN | Completed migration/File source trace; MIG-CONTRACT; completed receipt source trace |
| RT.SERVICES | Completed bounded provider source trace; PROVIDER-C1 |
| RT.VALUES | Completed Values source trace; V-ORDER-C1; V-LOOKUP-C1; V-BOUNDS-C1 |
| P-ARTIFACT | completed delivery source trace; DELIVERY-C1; completed generation/tool source trace; L-REVIEW-EMIT recipient |
| P-SERVING | completed host invocation source trace; completed authority/final-disclosure source trace recipient |
| P-PRESENTATION | Completed browser source trace; BROWSER-C1/C2/C3 |
| P-DELIVERY | completed host invocation source trace; completed host fanout source trace; P-CODEC gated |
| P-AUTHORING-HOST | completed generation/tool source trace; L-REVIEW-GIVEN recipient |
| P-DISTRIBUTION | Completed setup/delivery source review; SETUP-C1/V1; DELIVERY-C1; MIG-CONTRACT |
| REPO.GOVERNANCE | completed contract ownership review; completed native policy source trace |
| DOC.CONTRACTS | completed contract ownership review; completed native policy source trace |
| DOC.EVIDENCE | completed parent input-owner review |
| DOC.DELIVERY | Completed source delivery review; REPO-DOC-C; DELIVERY-C1 |
| DOC.PLAN | Root reconciliation across all review packets; inventory/tree/task/challenge consistency |
| DRAFT.INPUTS | completed parent input-owner review |

Every slice has a primary completion route. Exact defining file/duty selectors live in its source review, and retained leaf dispositions remain in the inventory. These tasks expose correction/support/investigation/qualification gates; the audit does not claim complete runtime conformance or zero native diagnostics.


</details>

<details>
<summary>Historical implementation evidence before the latest seven commits</summary>

The following retained record describes earlier source and executed checks. Its 56-diagnostic corpus measurements and previously open maximum/assertion failures are historical; current status and resolved items are listed above.


These are prior performed implementation results, now reconciled to committed source `8d48f969`; they are not fresh results from this documentation audit. Permission checks, State issuance/session/budget maps, source-context construction and owner-loop generation selection retain their defining owners.

| Packet | Current result and performed verification | Remaining scope |
| --- | --- | --- |
| LANG-01 | Implemented grammar, Python and TextMate phase syntax; native/prototype accepted/rejected forms agree; real highlighting checks cover 69 files. | No native parser semantics changed. |
| P-CI | Four default variants, fourteen genuine Work modes each, plus source metadata/persisted-mode/header controls; all five named integration tests pass without skips. | No environment selector required for this regression matrix. |
| RT-M1 / RT-M2 / RT-M3 | All three pure State successors implemented with compatibility exports. State build/typecheck and Cloudflare typecheck pass; original declaration bodies conserved; genuine current-membership and parent receipt/replay checks pass. | Purchase ALL and boolean-reader failures are repaired at their owning compiler lowering and scoped fixture setup. Viewer 3/3, boolean graph 1/1 and callback/read 2/2 pass, including race/replay and forbidden-field access checks. |
| LANG-02 / LANG-03 | Five private CLI modules and two source-proof modules implemented. Fresh compiler build; CLI 5, source-proof 68 and docs 31 integrations pass; 28 CLI compatibility comparisons agree. Another 78 saved-generation integrations pass, covering actual persistence/lease conflicts and recovery, import confinement/closure fingerprints and lifecycle selector admission; actual downstream platform accept/reset execution was not exercised. Two receipt-free validation fixtures were updated for the existing required derived_bool_receipts field. | No public source-proof constructor or copied cache/state. |
| LANG-04 | Complete dev worker implementations extracted; cargo check and four real HTTP gateway integrations pass. | Owner loop retains currentness/publication; real lifecycle verification below also passes. |
| P-ERRORS / P-UI | Read-only error mapper and neutral field-binding successors implemented; public reexports retained; UI/browser and Cloudflare builds/typechecks pass; actual assembled handler throw maps to original source. | Installed Worker verification passes with 312 modules and three browser resources, including actual Worker execution. No authority-bearing execution moved. |
| LANG-05 | Removed admitted-code mirror after exact ordered equality of all 165 codes; compiler now uses existing Values lookup. Shape/excluded/unknown diagnostic branches retained; independently reviewed. | No new table or native backend. |
| P-RETIRE | Removed obsolete executors.ts after no supported export, current symbol/import caller or pinned/staged dependency remained; current real Work matrix passes. Historical embedded fixture bytes retained. | No public occurrence API retirement or legacy fixture deletion. |
| ROOT-POLICY | Reconciled the 114 legacy source tests: real filesystem/capture, claim, transport, compiler process, SDK resource, watch, CLI and HTTP refusal subjects now run through 44 public-boundary integrations. Shared compile-time guard enabled with zero test markers in the 25 affected source files. Normal dev-server discovery passes 64 cases (44 boundary, four gateway, one full owner lifecycle, fifteen existing state cases), without skips. Lifecycle includes real attached PTY commands/resize/stop refusal/detach and unsafe retained-metadata mode/symlink/schema refusal while preserving the original preview. | Pure private parser/render/key-order/JSON helper assertions retired; no test façade added to production. The full physical Chromium journey and the selected cancellation integration also pass, including actual anonymous recovery, exact auth/owner snapshots and context cleanup. |
| Distribution repair | Fresh installed verification exposed Cloudflare Acorn range selecting 8.19.0 against existing exact 8.18.0 bundle requirement. Aligned owner manifest and existing resolved lock entry; preserved version checks. | Native generated bindings were legitimately rebuilt to satisfy migration freshness; glue/types unchanged and all 309 old/new actual Wasm conformance requests agree, including 157 error outcomes. Ordinary bundles now exclude optional bootstrap/glue; selected assets retain verified bytes. Installed verification uses the real synchronous esbuild child backend without granting WorkerThreads, updates stale Work import/call assertions, and removes its stale invocation of a fixture deliberately deleted in the earlier test cleanup. Its actual Worker, canonical module identity, corruption, raw/foreign/expired File and source-stage guards still run. |
| Shared receipt/profile mechanisms | Consolidated the seven large analysis/codegen/State/Cloudflare files without splitting files: shared checked-query reconstruction and resolved-type traversal; eight decision emitters use one typed layout/emitter; transport codecs share one implementation; trusted Mailbox/Payments source proofs, statement-write provenance joins, and the closed 56-shape scalar table each have one owner; twelve State source comparisons, four domain readers and nine commit revalidations share private mechanisms; nine host callbacks and five query-view traversals share implementations; Require/IF and Event formatters share original-stage observation and revalidation. Shared contextual input checking covers twelve binding paths; predicate traversal/leaf proof and complete stored-field validation are reused by receipt proof and emission. Eleven State interval validators and six source-site censuses share private implementations in the existing scenario-plan owner. Profile/Run reference admission and FIRST/COUNT containment-parent source proof each now have one complete private workflow; their distinct profile and receiver checks remain explicit. Write effects now share one disclosure lifecycle across seven verbs; required stored-Model parameters share admission across row, File-array and Profile/Run receivers; ordinary and private-due FIRST queries share their complete checked-census loader. Net reduction: 2,115 lines across five passes (755 plus 471 plus 432 plus 240 plus 217), with no new production files. | Source/role/parent/phase/lease checks, independent source copies, revision fences, Identity revalidation and differing domain caps/error order remain with their original owners. No new business profile or authority API. |
| Compiler responsibility splits | Extracted complete Given contract checking into private `analysis/types/given.rs` and artifact descriptor/wire encoding into private `codegen/js/descriptors.rs`. Existing `types::*` and `js::*` import paths are explicit reexports; shared checker helpers remain private, and emitter/session state stays with its original owner. Parent files are 1,743 and 1,201 lines shorter. Moved bodies match the originals after module-path and parent-only visibility adjustments. 84 existing checks pass, including actual CLI-to-Cloudflare artifact loading; eight complete artifacts are byte-identical. Repaired the existing artifact fixture constructor with the required empty `derived_bool_receipts`, retaining its byte assertions. | Two standard-value inventory assertions still fail; both inputs produce byte-identical successful output with the pre-extraction and new CLI. No authority checks were relaxed. This is an ownership/navigation improvement, not an algorithmic reduction. |
| Persisted receipt decoding | Extracted the complete saved-association decoder and shared stateless wire/row helpers into internal `scenario-receipt-decoding.ts`. Its only installed-source interface is two lazy budget callbacks, invoked at the original copy and changed-row validation points. Recursive child decoding retains ordinary limits. The original owner keeps current registry/source/callee checks, private issuance maps and projection/revalidation. All 198 remaining live function bodies and 16 moved bodies match, apart from the two budget delegations. State emit, Cloudflare typecheck, both unit-ban gates and six selected runtime checks pass, including replay, query privacy, real File handling and malformed receipt-copy rollback. | The full proposal run reaches the existing `parent-max` whole-source field-grant refusal; the exact pre-extraction runtime reproduces it. Source-grant replay and forged-copy checks completed before that refusal, but maximum-size success is not established. The receipt owner is 348 lines shorter; total production size increases 39 lines from the boundary. No new authority API or tests. |
| RT-C1 / P-CODEC / RETAIN-REVIEW | Original per-profile phase/authority/complete-domain/effect/File gates and accepted-row/error-order distinctions remain. | No next business family or incompatible codec is selected by a file move; no diagnostic suppression. |

The TypeScript content gate now handles removed tracked files before staging while still scanning new production sources. This supports normal source retirement without changing its prohibited imports or allowlists. Unit tests were not introduced.

Verification scope: the fresh 24-operand/26-source semantic check completes with zero analysis diagnostics, but this is distinct from native compilation. The full native compilation now completes all 26 sources with no omissions in 153.25 seconds (previous fresh release: 215.59 seconds). Its source and diagnostic arrays exactly match the complete 56-diagnostic baseline. Shared model-rule validation avoids a duplicate fresh IR build; the corrected declaration guard and forged/stale-source refusal integrations pass 9/9. Local-rule capture now passes all eight integrations, including rollback, permission refusals, locks and staged artifact tampering. Both actual D1 integrations pass: saved scalar/array/derive/machine/default/replay coverage in 350.93 seconds and static scalar/void coverage in 68.52 seconds. The private adapter shares the production compiled-entry parse-and-plan mechanism. Enum cases and computed-default markers are matched exactly before explicit Values profile selection; typed HTTP validation, source-current checks and State-owned permission-scoped evaluation remain. Fixture parsing now reads the canonical renewed-attempt error envelope, and physical snapshots batch the same table census and row digests. The comprehensive integration and its caller-owned worker/gateway/preview harness lifetimes are bounded at 420 seconds; one-shot policy decisions and production deadlines retain their existing limits. Whole-crate formatting and the full boundary scan also report pre-existing repository drift; dependency-only checks and the TS unit-ban checks pass. These outcomes are not converted into passing behavior claims or relaxed checks.

Consolidation verification: this pass has 149 passing compiler integrations and ten passing runtime integrations. Four newly exercised call-reference failures exactly reproduce against the pre-edit compiler library. The due-handler failure also reproduces with the exact pre-edit compiler and runtime: genuine original source DATA grants are still required. No permission checks or tests were waived. Actual execution covers hidden-row ANY/FIRST decisions, target selection, commit-race retry, COUNT/FIRST paid-seat capacity admission, cross-model promotion, parent SET/replay, and post-write Purchase ALL with staged receipt/amendment aggregates and rollback. Purchase ALL exceeded its existing timeout with the debug compiler and passed with the optimized compiler; no timeout was changed. The private-due census shares the checked FIRST loader, but nonempty due-FIRST execution is not established by these fixtures. Eight genuine owner fixtures produce byte-identical complete artifacts. The full native corpus completes all 26 sources with zero omissions in 374.53 seconds; its entire source and 56-diagnostic arrays exactly match the preceding pass. This is a completion measurement, not a controlled performance comparison. Cloudflare TypeScript checking and emission pass; State remains unchanged in this pass. Both unit-ban gates and diff whitespace checks pass. This pass adds no tests, public authority APIs or production files.

</details>
