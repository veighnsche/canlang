# Rust migration: current implementation and prioritized remainder

## Current execution view — 2026-10-18

This is the single current execution view for the existing Rust migration. Source inspection: main `ede59d051`; later accepted package outcomes are credited below. The original task IDs, dependencies, acceptance clauses and defining owners remain in [tasks.json](remaining-work/tasks.json) and the [subsystem plans](../research/package-subsystem-ports-20261006/implementation-plans/README.md). The numbered historical sequence below is evidence, not another dispatch queue. Unreleased implementation remains stopped and existing holds remain in force; the separately released Shared TS syntax completion is credited below.

### Finite packet detail reconciled after origin sync

The [finite packet detail](rust-port-orchestration/current-plan.md) and
[machine packet queue](rust-port-orchestration/next-packets.json) refine the
priorities below. They add no canonical tasks or implementation permission.
Ordinary TS isolated-Worker qualification remains the first priority; changed-byte
Values installed/vendor qualification can proceed independently. Shared fanout
TS integration includes only its actual consumer graph and installer handoff.
Current-byte Node binding smoke recorded below is already credited; it does not
replace installed/vendor/workerd delivery evidence. No accepted recovery work is
reopened. All native-preparation/source-adoption/default/publication holds remain.

### Additional package opportunities — TS syntax completed; other packets unreleased

The [full packages opportunity audit](../ideal-filetree-plan/rust-package-audit/README.md)
at merged source `08dc8c392` covers all 13 packages and 1,511 tracked paths.
It retains the priorities below and proposes finite contract/cost evaluations
for message syntax, exact Judgment response decoding, State batch ordering and
generation diffing. Files byte analysis is conditional on actual workload demand.
These add no canonical tasks or prerequisites for existing A/V/W/C04 outcomes.
Only the separately released TS syntax packet below is complete; other candidates
remain unreleased. Native preparation and all original holds remain in force as
recorded below.

The [ICU shared-parser plan](../ideal-filetree-plan/rust-package-audit/icu-shared-parser-plan.md)
retains its historical source matrix at `0bb480bef`. The user approved its grammar
profile and released only **Shared TS syntax**, now complete: Values owns one TS
syntax/normalization/diagnostic implementation behind its compatible public
wrapper; UI consumes its AST through root `parseMessageSyntax` and keeps its own
renderer. The duplicate UI parser/AST is removed. Contracts/Values/UI emitted and
typechecked. The focused ICU/locale/messages/components run passed 241 tests;
after diagnostic fixes the affected ICU/messages run passed 165, reusing the
unchanged 76 results. Shared grammar corpus coverage is 24 accepted and 40 refused
cases, with owner diagnostics, depth and rendering checks.

Compiler parse/usage consolidation and UI full-signature/all-branch/all-variant
usage remain **unreleased proposals**; joined compiler completion remains pending.
The finite plan reuses existing C09I corrections and keeps a single Rust/Wasm
parser as a separate dormant evaluation. This adds no dependency to the three
current port packets and does not release native preparation.

### Implemented and credited

| Owner / original scope | Current implementation and evidence | Limit that remains |
| --- | --- | --- |
| R1 / `A03–A07` exact values | Registered Rust integer/decimal/money, temporal, aggregate and scalar-codec modules; broad [operation dispatcher](../../packages/values/semantics/src/transport/exact.rs); generated Wasm, synchronous bootstrap and integrity-checked assets. [Step9 acceptance](rust-port-orchestration/runs/codex-step9-20261007T012914Z/acceptance.json) credits its actual Node/Bun/workerd profile. | Six operations have the matching qualified TS comparison profile; Rust dispatch supports more. Public helpers still run TS. Full boundary parity, public routing and adoption are unfinished. |
| R2 / `V02–V03`, `V07` validation foundation | Rust structural transport, owner/plan handles and release scaffolding. Ordinary TS has frozen parser-created input, copied Date/Decimal plan defaults, trusted serving registration, source/revision fences and request cleanup. [Current V03 record](../research/package-library-audit-20261006/repair-queue/queue.json) retains accepted components and the unfinished serving checkpoint. | [Rust profile dispatch](../../packages/values/semantics/src/profiles.rs) has input/owner/plan operations, no validation operation. TS serving is explicitly `ordinary-ts-serving`; no Rust HTTP/state/MCP adoption. |
| R3 / `W03–W06` selected recovery | Registered Rust decision families; explicit [recovery Wasm producer](../../packages/work-kernel/package.json) and [startup-selected facade](../../packages/work-kernel/bindings/recovery-planner.ts). Accepted `TECH-W03` at `6fe652c4b932e8c095ab8c5c8fdedee9de6bd537` exercised the actual durable recovery path with TS and Wasm, 26 planner calls each. | The selected `planRecoveryScan` outcome is closed at that scope. Other families, final distribution/installed-host coverage and wider original W gates remain open; do not redispatch accepted recovery qualification. |
| R4 / `P04–P06` preparation candidate | Registered Rust artifact, compatibility, release, module, plan, render and review algorithms, retained protocol/job prefix and separate host/publication adapters. | Native job still omits module/plan phases; real CLI build/deploy stays TS. Executable verifier is not connected to launch. Candidate source is not full CLI acceptance. Preparation/native release remains human-held. |
| Shared / `C04` delivery | Values generated assets are manifest-checked and staged as binary; mixed asset/bundle plumbing exists. Cloudflare now declares the work-kernel dependency, and Work has an explicit recovery asset producer. | Ordinary Work emit does not produce recovery Wasm; final Work package/deploy/release inventories and claimed host coverage remain separate. Do not require unused consumers to add dependencies. |

### Prioritized remaining work

Ranks order the existing outcomes, not new task identities or permission to execute. After a future finite release, use exact available prerequisite outputs; independent Work delivery can proceed alongside Values work. Shared delivery and measurements are counted once and linked to their consumers. Do not reopen an accepted component or demand completion of another owner's entire plan.

| Rank / existing IDs | Defining owner and prerequisite output | Remaining change and finite acceptance |
| --- | --- | --- |
| 1 — `V02.6`, `V03.3`, `V08.4` / selected `TECH-V03` | R2 Values/Interfaces with Cloudflare serving assembly; consume existing trusted source/owner/revision catalog and copied-default implementations. | Finish the remaining actual serving association/isolated Worker qualification at the preserved checkpoint. Reuse accepted factory/default/HTTP controls and compiled installed HTTP+State-memory evidence; check only missing deployed/isolated linking and affected lifetime/source fences. Close this ordinary TS prerequisite only; no Rust or whole V08 credit. |
| 2 — `A04.5`, `A07.3`, `A08` | R1 shared values assembly; existing Rust semantics, committed Wasm and actual host adapters. | Complete admitted carrier/error/profile parity and the matching comparison registry, then route only proved public profiles before evaluation. Resolve exact UTF-16/truncation, signed-zero and observable-object exclusions explicitly. Done when full claimed vectors use actual delivered adapters with original error/order/identity behavior and unsupported profiles retain declared TS routing. The selected int/ASCII source/adoption slice stays held below. |
| 3 — remaining `W03.3–W04.4`, `W05–W06`, `C04.graph`, `C04.work-assets` | R3 Work/global delivery; consume the existing recovery producer/facade and accepted durable recovery result. State and Cloudflare retain authority and commit ownership. | Complete only unmet family demand/provenance/consumer obligations and the actual required package/deploy/installed asset closure. Preserve `W05.1 → W05.2 → C04.work-assets → W05.4 → W05.3` for missing delivery, plus the original runtime writer handoff. Done when each claimed remaining family has required trace/fault/persisted behavior and its named installed/workerd evidence. Selected recovery remains credited; no scheduler expansion. |
| 4 — `V04–V07` | R2 validation, with R1 applying shared registrations; consume released numeric/codec/error contracts and immutable owner plans. | Implement the missing ordered Rust validator, defaults/materialization, codec joins and distinct supported profiles; finish matching TS/Rust budget, retirement and cleanup policy. Done when original ordering, presence/default identity, error projection and stale/foreign/disposed refusals match through actual bindings. Work needing the held selected int/ASCII contract waits for that exact release; disjoint preparation does not inherit a blanket hold. |
| 5 — `A09.2`, `V08–V09`, `C04.validation-join` | R2 real HTTP/state consumers with R3 delivery/runtime handoff; require the relevant proved interpreter/profile and protected parser-to-Rust boundary. | Join actual owning handlers and canonical state sequencing. Preserve raw-input hash/replay before age/auth/normalization, one selected backend and no semantic-error retry. Done at original installed/workerd/durable scopes, with actual protected input rather than fixture-only transport. Rank 1 TS serving does not satisfy this native join. |
| 6 — `A10–A11`, `V11–V12`, `W07–W08`, shared `C02.complete`, `C03.complete`, `C04.complete`, `C05.complete` | Each defining subsystem and R3 delivery; consume the exact completed consumer/profile releases above. | Measure complete operations and resources, qualify packaged selection/disposal/persisted rollback, then record pass/retain-TS decisions and close only met original gates. Reuse unchanged evidence. No default switch or TS retirement without its existing explicit release; local/scalar timing is not full-handler acceptance. |

### Holds and deferred scope — unchanged

| Existing scope | Owner and release condition |
| --- | --- |
| Native preparation `P04–P11` and `C04.native-release` / selected `DEL-D05` | Human HOLD. Only explicit release permits remaining native job/module/plan joins (`P05.4`, `P06.3`), verified executable launch, exact reviewed-byte publication, actual CLI and supported-host qualification. The differential backend flag currently labels output without selecting native execution; repair it before using it as native parity evidence. This hold does not block ordinary Values/Work delivery. |
| Selected int/ASCII codec/source-adoption `TECH-V04` within `A04.5`, `A07.3`, `V05–V08` | Human exact source/adoption release required. Retain accepted raw transport/bootstrap controls. After release, preserve int64/leading-zero/`-0`, form-before-bound checks, ordered public errors and refusal domains. No full-Unicode or all-registry acceptance inferred. |
| Backend defaults, TS retirement, activation and publication | Existing explicit human/policy releases remain required. This plan selects none of them and schedules no workers or automation. |
| `W09` request/resume scheduler; conditional `V10` MCP/forms and preparation mixed assets | Retain original deferred/conditional disposition and activation conditions. MCP SDK provenance is still deferred. Do not turn optional work into a prerequisite for required accepted outcomes. |

### Evidence and accounting

The 230 port identities and original acceptance contracts are retained. Historical lane counts (including “166 remaining”) and October 7 aggregate counts include parents/gates and are not current coding-job counts or a completion percentage. The ledger now corrects source observations and marks eight started Work records partial; it closes no full port gate. Accepted selected recovery and TS repairs are credited once through their existing records.

Reuse the read-only audit's direct check of the current committed Values binding: all four inventory entries matched bytes/SHA-256, exact and structural ABI1 initialized on Node24.22.0, add/negate/subtract-int passed, and invalid-version/unknown-op requests refused. This is a binding smoke, not renewed full-source or host acceptance. Larger checks retain their original source/scope; no builds or product suite reruns are required for this documentation update. No merge or complete filetree checkpoint advance occurs.

Documentation checks passed: all 333 ledger identities (230 ports), original acceptance/dependencies/dispositions, held/deferred/completed records and lane allocations are preserved; fifteen observations are updated, eight Work statuses move only from not-started to partial, and no full gate closes. Ledger status counts match the records, all eighteen added local Markdown destinations resolve, and the scoped diff has no whitespace errors.

## Historical October 7 sequence — reference only

**Sequence and historical planning outputs, with finite implementation releases recorded separately. Future dispatch remains deferred.** This is the operator's checklist for the existing [execution plan](RUST-PORT-EXECUTION-PLAN.md) and [detailed adoption units](../research/package-library-audit-20261006/adoption-sequence.md). It changes dispatch clarity, not canonical task counts or source acceptance. Native preparation/native-release remains HUMAN HOLD.

The numbered steps give priority and prerequisite order. A later ready task may run alongside an earlier unfinished task on different owned files; there is no global wave-completion barrier. Four responsibility queues use the actual available worker slots, currently three subagents beside Codex. Codex handles Git and main integration for its package workers. An independent compiler agent also works and commits concurrently: preserve its files/staging, coordinate shared manifests/locks/docs/interfaces, and record exact tested source when its commits advance HEAD. The [concurrent compiler rules](RUST-PORT-EXECUTION-PLAN.md#concurrent-compiler-work) apply at every step.

The [sourced model allocation](../research/package-library-audit-20261006/model-allocation-20261007.md) supplies task-specific starting choices and cheaper subtask splits. These are researched judgments, not benchmarked optimums.

Step 1 now has a [completed planning scope/source checkpoint](rust-port-orchestration/preflight-20261007/SCOPE-CHECKPOINT.md) and a [single ready/blocked queue](rust-port-orchestration/preflight-20261007/scope-queue.json). Step 2 now has [separately frozen contracts and ownership](rust-port-orchestration/contracts-20261007/README.md). Step 3 now publishes the [reviewable first packet queue](rust-port-orchestration/first-packets-20261007/README.md) with exact inputs, future files, acceptance, private outputs and economical models. All three planning steps are complete. Later human releases are recorded in the source-current runtime; step8 D04 now has accepted [actual staged and installed diagnostic evidence](rust-port-orchestration/runs/codex-step8-20261007T005702Z/README.md). Original broad parent acceptance and future packets remain separate; native preparation remains held.

### Finish planning first (historical)

1. **Lock the selected scope and current source checkpoint.** Reconcile the existing remaining ledger against current source and narrow credited evidence. Keep original IDs and prerequisites. Select the Rust-port work plus its required library/delivery/consumer changes. Give identity, CSV and services explicit finite selected packets before dispatch; keep unrelated product backlog and held preparation separate. Output: one ready/blocked queue with the exact reason for each blocker. Related units: P01/P02. **Economical delegation reminder:** Use Luna low for inventory/crosswalk extraction and Sol medium for P01/P02 interpretation; use Sol high only for an actual source/evidence contradiction. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

2. **Freeze the first contracts and ownership.** Define exact numeric/error bytes, admitted string domains, import policy and raw source-map behavior. Select pinned candidate library entries/features/license and target-check recipes without treating upstream documentation as acceptance. Assign values common assembly to R1 and work/global delivery to R3; freeze finite file leases. Preserve the original validation/state/temporal unblockers. Output: separately released contract packets, not one combined all-library approval. Related units: N01/D01 and original A/V/W prerequisites. **Economical delegation reminder:** Use Sol high for the full N01/D01 oracle and compatibility contracts. Use Luna low/medium for specified extraction and seeded fixtures after the contract is defined. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

3. **Commit the planning checkpoint and publish the first packet queue.** Save the ready task IDs, source inputs, owned files, acceptance, economical model/effort and private output roots. Keep the supervisor paused and execution_authorized=false. The planning baseline is already committed; remaining contract/readiness decisions get their own scoped commit when finished. Stop here until the human releases implementation. Output: a reviewable queue and explicit residual decisions, no launched product work. **Economical delegation reminder:** Use Luna low for packet records. Codex retains Git; finite technical readiness decisions stay Sol medium or high according to their unresolved seam. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

### After implementation release (historical)

4. **Start three finite Codex packets, rather than four permanent coordinators.** Each worker acknowledges its exact inputs and files. The initial queue below is the intended allocation; step 1 resolves original readiness before any packet is sent. Borrowed R4 work can be included in worker B's explicit packet, avoiding an artificial fourth-worker wait. **Economical delegation reminder:** Select each finite packet separately: N02 and released N03 leaf work use Sol medium; N04 mechanics use Sol low; prepared fixtures use Luna medium. Unfrozen contracts or assembly reconciliation use Sol high. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

| Worker | First responsibility | Immediate next release |
| --- | --- | --- |
| A | Values numeric/string regression corpus and package-local adapter work; only ready N01/N02/N04 slices | Checked formatter/escape commit with complete caller/error witnesses |
| B | Validation contract/prepared-hook prerequisites and the explicitly borrowed V01.3 state-contract unblocker | Released validation/state inputs, then dependency-ready validation registration/profile work |
| C | Work numeric witnesses and corrective formatter, with original W04 leaf prerequisites reconciled | Checked N03 source release and exact missing inputs for actual W04.4 assembly |

Use the [task-specific allocation](../research/package-library-audit-20261006/model-allocation-20261007.md) for each finite packet; its stronger known-risk choices supersede the former blanket low/medium technical reminder. Prepared fixtures and bookkeeping remain separate cheap packets. Do not open broad whole-lane goals. If a named first slice is blocked, choose its ready prerequisite or a finite disjoint unblocker from the full queue, retaining the unfinished slice.

5. **Land the numeric corrections early.** Replace values number formatting, use existing serde_json for Rust-str escaping, and repair work's integral-number formatting. Values and work releases are independent. Keep A04.5 lossless UTF-16/truncation residuals explicit; a helper replacement cannot close the whole codec. Output: separate checked N02/N03/N04 candidates. Codex reviews and commits each released coherent slice without waiting for the others. **Economical delegation reminder:** Use Sol medium for N02 and frozen N03 leaf adapters, Sol low for N04 mechanics, and Sol medium for their isolated error/caller review. Full N03 harness/registration reconciliation uses Sol high. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

6. **Continue values bindings and validation while assembling work.** R1 completes dependency-ready common transport/binding/bootstrap/export work; R2 consumes its exact released inputs for validation registration/profiles. R3 actually registers the selected work decisions in the real Cargo root and runs the original differential/compile gates. Output: real registered modules and producer/consumer evidence, not Rust files or TS-only smoke. Related units: N05/N06, A07/V joins and W04.4. None waits for an unrelated adapter family. **Economical delegation reminder:** Use Sol high for full N05/N06 producer, ABI and assembly joins. A fixed individual consumer check can use Sol medium; routine receipt indexing uses Luna low. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

7. **Use released slots for import and map adapters in parallel.** After each worker finishes a finite packet, allocate ready D02 import/edit-map work or D03 source-map lookup work on distinct files. Existing values/validation/work prerequisite packets retain priority where they unblock more downstream work. R3 performs short shared bundle/modules/manifest joins; no competing global writer. Output: separately checked import and map releases with raw source identities and negative-input behavior preserved. **Economical delegation reminder:** Use Sol high for full D02/D03 compatibility and integration packets; a strictly frozen pure adapter can use Sol medium. Prepared corpus generation uses Luna medium. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

8. **Join rewrite maps with real staged diagnostics.** After both adapters release, compose their maps and qualify the actual staged bundle, including invoke's fallback diagnostic view. A changed-length import before a throw must still point to the original .can position. Obtain the existing invoke.ts writer transfer if needed. Output: D04 actual Node/workerd and outside-checkout installed diagnostic evidence. No partial composition-only acceptance. **Economical delegation reminder:** Use Sol high for D04 composition and host joins, with a short Astra medium independent critical diagnostic review. Astra high is reserved for an evidenced new major seam decision. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

9. **Qualify each Rust backend through its actual supported consumers.** Follow the original generated glue/Wasm/asset/installed package, native/host integrity, authority/error/order, whole-call measurement and rollback gates. Values/validation and work have separate dependency chains. Reuse unchanged accepted machinery only at its proved scope. Output: exact-source consumer receipts and explicit residual limits; no automatic native-default switch or TS backend deletion. **Economical delegation reminder:** Use Sol high for full backend/installed qualification and risk-matched independent review; use Luna low/medium for exact-source receipt bookkeeping. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

10. **Assign selected identity, CSV and services packets to released capacity.** Keep unfinished critical port prerequisites moving. Identity: encoding contract → codecs → host comparison, with cookies independently ready. CSV: grammar/ownership contract → shared grammar → authoritative review/commit consumers, with export evaluation separate. Services: signal fan-in → separately justified quota correction. Output: finite accepted I/C/H releases; unrelated research or held preparation does not block them. A free worker takes a ready finite packet, not an idle polling job. **Economical delegation reminder:** Follow the family allocation: I01 persisted-security policy uses Astra high; I02/I04 frozen adapters use Sol medium; I03 uses Sol high with Astra high timing-guarantee review; C01/C03 and H01/H02 full joins use Sol high. C02/C04 bounded work uses Sol medium and prepared fixtures use Luna medium. Conditional tasks remain conditional. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

11. **Remove replaced mechanics only after the real callers switch.** Delete obsolete scanners/formatters after their relevant consumer and negative controls pass. Retain Can semantics/authority and the explicit TS backend until its own original retirement gates pass. Evaluate uncertain libraries only for a concrete benefit/blocker; record retain-now when appropriate. Output: a small cleanup commit per accepted replacement, not a blanket TS deletion. Related units: E01/R02 and original backend adoption/rollback gates. **Economical delegation reminder:** Use Luna low/medium or Sol low for accepted mechanical cleanup; Sol high for substantive backend-retirement or one material E01 semantic decision. Codex performs Git; do not repeat completed work. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

12. **Close the selected release through independent joined review.** Codex verifies the critical combined invariants, repairs concrete defects, records conditional/deferred/held remainder and updates the living filetree after actual integrations. Original T08/T26, app journeys, durable and wider product reviews close only through their own evidence. Output: accepted selected scope and truthful remaining work, then released-resource cleanup. Related unit: R03. **Economical delegation reminder:** Use Sol high for selected joined qualification and a finite Astra high independent critical review; Luna medium handles residual receipts. Review only the actually selected released scope. Recheck the least expensive supported reliable choice for every finite dispatch and record its reason.

### The loop after every released packet (historical)

Recheck economical model and reasoning selection at each new implementation, review, repair or follow-up packet; a prior assignment does not justify carrying an unnecessarily expensive default forward. This applies to delegated work, while Codex retains orchestration, acceptance and Git authority.

**Worker releases exact files and check evidence → Codex independent review → bounded repair if needed → coherent early commit → accepted dependency-complete main integration → living-plan reconciliation → next ready packet.** This loop runs throughout steps 5–11; step 12 does not postpone earlier reviews or commits. If branches are used, review precedes main integration; a frozen candidate commit alone is not acceptance. In a shared checkout, the root serializes Git operations and stages released paths only.

Two provisional heavy-command slots constrain commands, not editing workers. Preserve live handles and private mutable outputs. Do not hold a slot while coding. Use actual completion messages during active work; the paused 15-minute supervisor remains only a later backstop, not a reason to postpone ready allocation or review. No Muse processes, local schedules, worktrees, builds or product edits are started by this checklist.


#### Actual step9 finite release (historical)

The human released actual Rust backend consumer qualification. [Current gate map](rust-port-orchestration/runs/codex-step9-20261007T012914Z/gate-map.json) separates source-current values/validation scaffolds, registered-only work decisions and held native preparation. Required unfinished registry/profile/producer/Wasm joins remain original prerequisites. This release permits concrete integrity repairs discovered by qualification; it does not switch defaults, remove TS or open step10/11 work.


The executable step9 scaffold checks and discovered repairs are now reviewed and locally committed (ee211cf,5a9c768). [Acceptance](rust-port-orchestration/runs/codex-step9-20261007T012914Z/acceptance.json) separates proved installed/Worker/native behavior from full registry, validation, work-consumer, measurement and rollback prerequisites. The existing supervisor is paused after finite writer/command release. No later packet is dispatched, default switched, TS removed or held native preparation released from this proof.
