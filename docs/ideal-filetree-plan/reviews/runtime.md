# Runtime ownership review

Planning only, for `/Users/vince/Projects/canlang`. Reconciliation baseline: `8249342707d3280e88e39e8c911b7e457828f31f`; reviewed committed revision: `350163ad661e61b667809a5f78b608c23812a5f0`. The working copies of `packages/state/src/mutation/index.ts` and `packages/cloudflare/src/runtime/invoke.ts` were inspected as overlays, not incorporated into the committed checkpoint. [The coverage record](runtime-coverage.json) identifies read modes, exact paths, hashes and evidence limits.

The primary scope is S05 state and S06 work/services/files. The additional S09 scope is Cloudflare's actual canonical invocation, context, stdlib, executor and dispatch composition. Compiler review independently challenged the source-policy and clock joins; platform review independently covered Worker assembly and installed callers. This report challenges the platform identity, activation, bundle and error-mapping findings. It does not replace either owner's report.

## Requirements established before comparing implementation

[CONTRACTS](../../../implementation/CONTRACTS.md) assigns verified context, normalized input, frozen clock and atomic domain/history/receipt/work-intent commit to L3; stable delivery identity, current guards, claim/replay and honest unknown outcomes to L4. L6 must construct context and use one operation envelope for HTTP and MCP. L7 wires these producers into real bindings. A trusted port is an internal capability, not an alternative public admission engine. Owner reads cannot be obtained from caller JSON. Eventual reads are display-only, and a captured state or role snapshot cannot authorize a later spend.

[DESIGN](../../specification/DESIGN.md) defines boolean role predicates and subject-role checks (§4), no-policy denial except explicit exceptions, frozen operation time (§3), delivery outcome/reconciliation, safe transport errors (§10), and complete bounded migration iteration and activation (§11). [REQUIREMENTS](../../specification/REQUIREMENTS.md) retains record-bound root recurrence until authoritative fanout is specified. Complete workflows therefore include rejection, revoked membership, retries, cancellation/supersession, provider ambiguity, migration interruption, retained pending work and result disclosure, as well as a successful call.

## Completion dimensions

| Slice | Source inspection | Workflow tracing | Independent challenge | Exact target allocation |
| --- | --- | --- | --- | --- |
| S05 state | All 39 changed/additional committed text paths plus one dirty reexport inspected; new test files structurally decoded, with focused assertion/fixture reads; oversized production bodies reviewed by responsibility and delta. Unchanged duties reuse prior evidence only at their recorded scope. | Descriptor intake → admission → mutation/read → fences → atomic storage; activation/failure/retry/abort/retention traced. Full installed journeys remain outside performed evidence. | Compiler confirms policy/compound-gate/clock boundaries and same-revision transitive scope issue; platform challenges consumers. | Exact successors below; existing real public adapters and new migration leaves retained. No source retirement implied by earlier owner intent. |
| S06 work/services/files | All 17 changed/additional paths inspected; new tests structurally decoded. Services production bodies are unchanged from baseline and are reused, with portability/import seams reconfirmed. | Guard/commit marker → staged dispatch/outbox → claim → provider result → settlement/reconciliation; finalized-file receiving authority; migration carryover joins traced. | Compiler challenges state/work boundary. Fanout gate independently retained. Platform challenges installed command composition and B2 fixture authority. | Existing kernel split extended for staging/recovery. Files/services allocations retained with real caller and portable-test gates. |
| S09 shared runtime join | `invoke.ts` internally inspected across callable mapping, policies/descriptors, overlay, scenario, canonical mutation/read, system producer, dispatch and recovery. `context.ts`, `stdlib.ts`, `executors.ts` inspected; env assembly raw inspection shared with platform. | Actual producer imports and emitted handler context compared; installed assembly and route boundaries challenged against platform evidence. | Compiler confirms actual emitted-policy/clock mismatch. Platform confirms assembly duties and reserved-name hazard. | Replaces the old wholesale interim retirement verdict with exact adapter splits and explicit retirement gates. |

These are planning coverage statements. Structural test decoding, source tracing, reported earlier producer runs, audit-executed tests, builds and installed journeys are distinct evidence classes. This audit executed no tests/builds. Test bodies were not all independently reread line by line; focused cases and fixtures are named in the JSON. Existing source defects can remain after source review, and dependent corrective packets require fresh tests during implementation.

## Findings and changed closure verdicts

### R01 — Actual compiler output loses policy at canonical intake

The compiler emits policy into `appDefinition`, while `canApp()` returns callable maps. `runtime/invoke.ts:1473` imports `canApp()` as the policy registry; `readOperationPolicyEntry` returns undefined when metadata is absent, and `mapCrudPolicyToBy:620` treats undefined as public. Model-policy collection likewise skips missing metadata and creates public full-field read grants. Core CRUD execution then skips the emitted handler gate. Thus the actual producer-to-consumer join can erase authored authority even though the state kernel itself checks the supplied predicate.

Compiler review independently confirmed `compiler/src/codegen/js.rs:3421`, `:4997`, and the runtime consumers. The hand-built T16 fixture expressly declares `t16b-fixture/0 (hand-written T15a shape; NOT compiler output)` and puts policy on `canApp()`. It proves a handwritten join, not the emitted artifact's authority. This reopens the old canonical-policy closure verdict.

Retain callable-only `canApp()`; import policy from authoritative `appDefinition`, validate the supported manifest subset, and fail closed on missing required policy. Preserve explicit public exceptions without treating absent metadata as one. Verify compiled protected CRUD and read through both HTTP and MCP, including absent/corrupt metadata and explicit public scenarios. Compiler gated compound/expression support remains a separate packet; unsupported lowering that refuses is not an authorization bypass.

### R02 — Emitted `now` is absent, and the adapter helper is not frozen

`compiler/src/codegen/ir.rs` lowers ordinary source `now` to `c.now` and hook `now` to `$hookCtx.now`. `runtime/context.ts:90` defines only `clock()`; its constructor installs no `now`. `runScenarioSeam` installs `clock: opts.now` (`invoke.ts:2378`) rather than the admitted frozen operation instant. Generated source therefore first observes an absent property; custom handlers calling `clock()` can observe a moving host clock across evaluation or retries.

Compiler review independently confirmed both sides. The task must define the correct emitted datetime representation from the admitted context and freeze the helper callback to the same instant. Merely replacing the callback does not supply generated `c.now`. Verify a compiled scenario and hook plus a contention retry, including exact datetime encoding. Keep the current context adapter until this real generated ABI is settled; do not delete it on the basis of the state context's existence.

### R03 — Compound predicates can reject a valid membership-free branch at commit

`state/src/invocation/invoke.ts:108` records its own known edge: only public/authenticated predicates project away caller membership before revalidation. Admission's live check can reject a caller without active membership before evaluating a valid compound or subject predicate that does not require that membership. `or` with a membership-free branch, `not: members`, and subject-role authorization must retain their stated semantics.

Compiler review confirms DESIGN's boolean/subject authority. Current generated compound operations are gated by E6008 and runtime policy transcription refuses unsupported manifests; this narrows exposure but does not repair the supported state API. Move necessity into the mechanism that owns full predicate evaluation and the live membership reader. Verify revoked required membership rejects, while valid membership-free/subject branches succeed. Keep this correction separate from adding compiler language support.

### R04 — Revision equality is not a scope identity

`work/src/dispatch/index.ts:133` rejects a transitive attempt whenever the trigger and fresh checkpoint have equal numeric revisions. State can open a fresh transitive scope at the same database revision with empty read dependencies when no intervening write occurs. The current tests advance the revision before opening the scope; they do not establish that a quiet fresh scope must fail. Cloudflare's drive path commits a claim before later opening its scope, so that specific ordering often advances revision; the direct work API has a wider contract.

Compiler review independently confirmed `admission.ts:488` opens a fresh empty scope from the live revision and adopted T32a requires freshness, not an intervening mutation. Do not implement a fabricated write solely to make the revisions differ. Carry distinct scope identity/provenance sufficient to reject actual inherited scopes. Final producer API remains an implementation design gate for this corrective packet and transitive-driver closure. Preserve live authority revalidation and eventual-read rejection independently.

### R05 — Durable joins have real producers, but runner and installed coverage differ

New staging writes dispatch rows and outbox entries in one state batch, records false guards without an outbox, and checks linkage. The durable tests instantiate real state/work producers and adapter fixtures; this is stronger than interface-only mocks. `TransactionPort` and invocation commits still require deliberate selection of the join wrapper; linkage is not guaranteed merely because the assertion helper exists.

State's default test command selects `dist/state/test/**/*.test.js`; new `src/**.test.ts` files compile outside that selection. Work's command selects `test/**/*.test.ts`, excluding its new colocated dispatch fence test. Prior evidence explicitly ran some colocated cases separately; retain those run identities without calling default-run discovery complete. Move colocated tests to the owning test tree, or explicitly fix canonical discovery, and verify the command sees them. T16 hand-built policy assumptions must be supplemented by compiled artifact tests under R01.

### R06 — Recovery/retention source replaces older missing-capability claims

Migration now has durable failure records and prior phase/cursors; unexpected failures preserve the original error while marking failed, deterministic `StateError` failures keep their phase. Retry restores the recorded nonterminal phase; abort discards unpublished staging rather than promising rollback after publication. Retained-work computation distinguishes accepted/uncertain work from invalidated undispatched work and rechecks pending IDs at activation. Keep `recover.ts` and `retain.ts` as real leaves, not proposed placeholders.

`handlerContract` is optional and stored additively. Older rows use the attested predecessor contract; new staging does not by itself prove every future producer persists that contract. Installed maintenance still needs exact old/new producer evidence and interruption/activation tests. The review does not convert trusted bare ID sets or a type-only description into unforgeable delivery evidence.

### R07 — Historical fanout finding; current qualification remains open

At the primary capture, T33's three JEV reports disagreed and had low confidence; alternate equivalent wording did not support taking a plurality as approval. The bounded-atomic option lacked an established whole-model production cohort bound. The durable-checkpoint option changed child identity, recovery and cancellation obligations. A development witness with at most two rows established neither cap nor production requirement.

That earlier workload-bound request is superseded by the committed corrected companion evidence and durable per-child decision described below. Preserve complete finite cohorts without introducing a new population estimate gate. Current qualification concerns the exact authoritative membership, child effect/checkpoint, cancellation/supersession and generated serving chain; F1–F5 mechanisms exist while F6/F7/T26 checkpoints and full T34 proof remain unfinished.

### R08 — File/service boundaries are retained, not declared installed

Files bridge/catalog/finalization now exposes finalized reads and additive catalog behavior through the file authority. Consumers must still carry receiving-app authority and verified provider provenance; a raw filename/blob handle is not a finalized file. Preserve read-path checks rather than consolidating them into a generic service utility.

Services runtime code is unchanged since baseline. Current `ports.ts` mixes runtime defaults with `node:http` and `node:crypto` harness imports; provider harnesses remain Node-only. Retain the prior runtime/testing split and shared scenario schema owner. Runtime request/response/cancellation/unknown behavior belongs to services; receipt and delivery identity belongs to work. Do not port provider logic into Cloudflare merely to hide unsupported imports. Work's README contains a temporary checkout install path; correct it with the package-authoring/docs packet.

## Independent challenge of platform findings

The identity challenge is confirmed by direct source inspection: presession mint stores token hash and expiry only; consume reads then deletes without a winner result. A URL-encoded POST accepts a token minted by the attacker in the attacker's browser with the attacker's credentials and plants that session in the victim browser. Same-origin protection against reading the victim's token does not prevent that attack. Platform owns browser/Origin binding and atomic consumption, including concurrent-use and cross-origin cases.

The production D1 owner lifecycle is also confirmed: two owners can each read an owner count of two and then unconditionally demote/remove the other, leaving no active owner. Concurrent disjoint role grants overwrite one another's arrays. OAuth code exchange reads unused status, ignores the winner result of conditional consumption, and can mint two grants. Recovery changes a password before establishing the token-consumption winner. Platform owns conditional winner/authority checks and dependent writes/revocations in one identity storage command, with concurrent cases; this is separate from state admission freshness and requires no second identity database.

The activation challenge is confirmed: `worker/main.ts` routes POST `/mcp/grants` before the worker staging/assembly activation gate. An outer binding check does not prove the required artifact activation closed every path. Platform owns the common gate and route matrix.

The bundle challenge is confirmed: safe-relative checks normalize only for escape detection, keep the original key, and do not reject duplicate or reserved paths. `stageArtifactModules` uses a Set for reference membership but overwrites duplicate staged keys; `buildDeployBundle` spreads artifact keys after system Worker/runtime modules. Canonicalize or reject noncanonical paths, reject duplicate canonical keys and reserved system namespaces before staging. Rejecting collisions must be identical for Node staging and deploy maps.

Assembly derives `appId` from a source filename (`interimAppInfo`) although `.can` owns identity; renaming a file must not rename receipt/app authority. Its error wrapper exposes raw `Error.message`, drops structured fields and sets retryable false instead of using the interface owner's safe mapping. These are actual joins, independently confirmed, not general hypothetical hardening requests. Platform owns them. Its proposed `worker/registry.ts` is preferable to the stale `worker/artifact.ts` allocation because deployment already generates `worker/artifact.js`.

## Package/language ownership and exact successors

The supported TypeScript/workerd stack and existing Rust compiler are retained. This is a policy- and toolchain-constrained allocation, not evidence that TypeScript won an unrestricted language comparison. State owns transaction/admission/query/migration semantics; work owns durable delivery/scheduling; files owns finalized file authority; services owns provider behavior. Cloudflare owns producer loading, emitted ABI adaptation and injected host composition. Its real adapters stay until their production imports have a named replacement. New stacks would add bindings, exact-value and deployment obligations without evidence of a needed benefit.

The following allocations revise the prior ledger. Root retains every other current leaf. Facades listed as retained remain target leaves; extracting duties must move behavior and its callers/tests, not copy a second engine.

| Current defining file | Reviewed target leaves and responsibility |
| --- | --- |
| `packages/cloudflare/src/runtime/invoke.ts` | Retain facade `runtime/invoke.ts`; `runtime/callable.ts` registry call/error mapping; `runtime/state-producers.ts` single validated producer loader; `runtime/canonical/policy.ts` authoritative policy; `runtime/canonical/descriptors.ts` descriptor/cache join; `runtime/canonical/overlay.ts` staged read/write/unique overlay; `runtime/canonical/scenario.ts` one staged scenario execution; `runtime/canonical/mutation.ts`; `runtime/canonical/read.ts`; `runtime/dispatch/producer.ts` injected system/fence producer adapters; `runtime/dispatch/rows.ts`; `runtime/dispatch/stage.ts`; `runtime/dispatch/drive.ts`; `runtime/dispatch/recovery.ts`. All prefixes in this cell are `packages/cloudflare/src/`. |
| `packages/cloudflare/src/runtime/context.ts` | Retain exact current leaf as emitted-handler ABI adapter; formalize frozen `now` and canonical scope here. Retire only after emitted handlers and every installed/test caller use a demonstrated successor ABI. |
| `packages/cloudflare/src/runtime/stdlib.ts` | Retain exact current leaf as emitted builtin adapter; pure helpers remain `packages/stdlib/src/index.ts`, canonical mutation/read behavior remains state. Prior replace-interim verdict is not accepted as deletion now. |
| `packages/cloudflare/src/runtime/executors.ts` | Retain exact current leaf until canonical row parity and its real callers are migrated; no deletion based on name. |
| `packages/state/src/invocation/registry.ts` | Retain facade; `packages/state/src/invocation/descriptors.ts` canonical descriptor intake, whole-set rejection/freeze; `packages/state/src/invocation/artifact-descriptors.ts` wire folding/defaults/unique descriptors. |
| `packages/state/src/invocation/admission.ts` | Retain orchestration; `packages/state/src/invocation/inputs.ts` normalized input/schema validation; `packages/state/src/invocation/fence.ts` scope, eventual restrictions and live predicate revalidation. |
| `packages/state/src/invocation/invoke.ts` | Retain mutation retry/receipt engine; `packages/state/src/invocation/invoke-read.ts` admitted read/projection dispatch. |
| `packages/state/src/mutation/pipeline.ts` | Retain orchestration; existing reviewed `mutation/{provisional,candidate,constraints,history}.ts` successors plus `packages/state/src/mutation/hooks.ts` flat queue/staging/transitive hooks. One queue/provisional state, no parallel collector. |
| `packages/state/src/migration/activate.ts` | Retain orchestration and prior exact `migration/{evidence,publish,disposition,flip}.ts`; keep new current `migration/recover.ts` and `migration/retain.ts`. |
| `packages/state/src/storage/d1.ts`, `durable-object.ts` | Retain their exact execution adapters; shared exact `packages/state/src/storage/sql/{query,row-codecs,commit-plan,migration-plan}.ts`, current `storage/schema.ts`. New failure/discard SQL belongs in migration-plan with adapter-specific execution preserved. |
| `packages/state/src/storage/memory.ts` | Prior successors `packages/state/src/testing/{memory-storage,memory-query,memory-probe}.ts` retained; move all real state/testkit/Cloudflare imports and export an explicit testing subpath before source retirement. |
| `packages/work/src/kernel/commands.ts` | Retain assembler; prior exact `kernel/commands/{dispatch,occurrence,schedule,every,arguments}.ts`, plus `packages/work/src/kernel/commands/staging.ts` and `packages/work/src/kernel/commands/recovery.ts`. Eleven installed commands, including the new two, remain one command registry. |
| `packages/work/src/kernel/tables.ts` | Retain assembler and prior exact `packages/work/src/kernel/tables/{dispatch,occurrence,schedule,every,supersession,row}.ts`; committed F2 fanout rows now exist. Preserve canonical contract/migration and producer/consumer proofs before structural cutover. |

The remaining runtime-owned prior allocations are retained exactly, recorded individually in the JSON: files `ports.ts`, upload/fs adapter and upload decomposition; services HTTP/provider request-response/run splits and testing harness/scenario extraction; state migration transition/validation, grants and query decomposition; work observation/testing and ports/testing. Their unchanged evidence is reused at structural responsibility scope, not advanced to installed success. Platform owns the accepted build artifact/modules moves and Worker assembly split in its ledger.

For new colocated tests, preserve the basename and use the corresponding owning `packages/state/test/{invocation,mutation,ports,query,storage}/` or `packages/work/test/dispatch/` successor. State's source test moves are exact entries in the JSON. Cloudflare canonical/durable tests remain its adapter tests; compiled authoritative fixtures supplement them, with compiler-produced artifacts, rather than claiming those fixtures are compiler output.

## Dependency-ordered implementation packets

| Packet | Dependencies/gates | Exclusive writers and concrete result | Progressive verification |
| --- | --- | --- | --- |
| R-P01 actual policy intake | Compiler owner confirms emitted metadata ABI; supported policy subset remains fail-closed. | Runtime lane owns `runtime/invoke.ts` initially, later canonical/policy + descriptors; T16 canonical adapter fixture plus compiled protected CRUD/read fixture. Compiler lane owns any emitted metadata changes. No concurrent runtime split writer. | Manifest intake rejection/public cases → real compiled operation → both transports → installed protected workflow. |
| R-P02 frozen emitted context | R02 datetime representation agreed with values/compiler owners. | Same serialized runtime writer owns context + scenario seam + adapter tests; no compiler lowering patch unless agreed ABI requires it. | Exact `c.now` value/hook → moving host clock → contention retry → installed scenario. |
| R-P03 predicate-aware fence | R03 full ByPredicate semantics; compound compiler feature task separate. | State lane owns admission/invoke then fence successor and its invocation tests. | Membership-required revoke → compound/subject free branch → D1/DO contention and projection. |
| R-P04 transitive scope identity | R04 independent challenge/contract decision; only its dependent work gated. | One state/work boundary lane owns admission scope/fence, work dispatch and corresponding tests; runtime drive adapter follows chosen producer API. | Quiet fresh equal-revision scope → inherited actual scope refusal → revoke/eventual bar → durable trigger/driver. |
| R-P05 test discovery and actual joins | R01 fixture correction; preserve prior reported evidence separately. | Verification lane owns only the named test moves and package test scripts; state/work semantic writers serialize conflicting tests. | Inspect selected paths → focused suites → package runner → producer build/stage → installed dual-transport path. |
| R-P06 state decomposition | R-P03 precedes fence extraction; R-P04 precedes scope API extraction. | State lane exclusively owns the state source/successor/import sets listed above. Storage shared SQL has one writer; D1/DO execute their own transaction semantics. | Existing focused fixtures → adapter atomic/recovery cases → package runner → installed migration interruption and retained-work activation. |
| R-P07 runtime decomposition/cutover | R-P01/02 stabilize actual producer ABI. Platform worker invoker follows runtime facade API; no competing engine. | Runtime lane exclusively owns invoke and its exact successors; platform owns Worker assembly/main/build separately. Retire executors/context/stdlib only after every real import is allocated. | Canonical same-operation identity → scenario net effects/projection → dispatch claim/settlement/reconcile → staging links → installed callers. |
| R-P08 work/files/services decomposition | Existing authority/lifecycle behavior preserved; fanout R07 gated independently. | Separate work, files and services lanes own their prior allocations; work lane serializes staging/recovery/kernel source and tests. Shared scenario schema owner is services, testkit consumes it. | Frozen input/false guard/one claim → unknown/reconcile/cancel → file finalize/read receiving authority → Worker-safe provider imports → durable end-to-end dispatch. |

These are implementation instructions for a later authorized round, not work performed here. No source edit, test/build, service, database or Git mutation was made by this review.

## Evidence limits and unresolved work

The installed skill contains no `references/` directory or `scripts/check_artifacts.py`, despite linking both; those prescribed references/checker could not be read/run. Root's inventory/link/tree reconciliation is distinct from that unavailable checker. Source hashes and structural catalogs do not replace compilation or runtime verification.

Same-revision scope identity (R04) is independently confirmed; its exact producer API remains a design gate. Fanout (R07/T33/T34) remains a requirement/decision gate. Full installed maintenance, provider ambiguity, dual-transport compiled authority and retry/frozen-time evidence belong to the named tasks. Their absence does not block unrelated planning allocations, but must not be relabeled completed delivery.

## Scoped pin drift reconciliation

The shared checkout advanced externally while this audit finished. This appendix reviews only the fixed committed interval `350163ad661e61b667809a5f78b608c23812a5f0..9830ba93951ded193b13bcbfb9eaea04e6252d24`, plus the specifically requested T33 resolution overlay below. It preserves the original primary pin, source hashes and findings above. It advances no global reconciliation checkpoint and follows no subsequent moving HEAD.

The owned interval contains seven work paths: `observation/association.ts`, `observation/observation.ts`, `observation/ports.ts`, `receipt/index.ts`, and three colocated T25 tests. All four production deltas were read from the fixed Git objects. All three tests were structurally decoded; locator, same-revision replay and fence/dispatch-shape fixtures were read directly. No test/build ran.

T25's isolated mechanism now exists. `resolveAssociationLocator` checks `{record,field}` shape and rejects text IDs/traversal/extra keys; selected observation authorizes every unique requested leaf before branching on null association, returns only selected keys, withholds unavailable result content and returns a revision for mutable status/result/error. Receipt progress checks delivery/source/revision correlation and status/payload consistency, advances the supplied association/receipt pair purely, and rejects stale/foreign progress. The closed completion error is exactly the `{code,message}` string pair. These additions supersede any prior assertion that those helper mechanisms are missing.

They do not establish an installed receipt-observation workflow. A non-null object is a shape test, not provenance that it is an admitted live record. Declared field membership, association-to-record/field binding, actor grants, real storage reads/writes and actual fence enrollment remain the L1/L3 join. Fixed-pin caller search found these entrypoints only in their definitions and tests, with no production consumer. Tests explicitly label their isolated mechanism, memory-only lifecycle and shape pins; returning a number matching `DispatchFence` is not executing a fence. Terminal immutability remains T26. Equal-revision progress accepts replacement business content under the stated adapter guarantee that one revision has identical content; the eventual producer must establish that guarantee or reject conflicting replay, rather than treating the two-identical-input test as its proof.

Retain exact defining leaves `packages/work/src/observation/{association,observation,ports}.ts` and `packages/work/src/receipt/index.ts`. The existing ports/testing split still applies to the newly extended test grant classes. Add exact moves `packages/work/src/observation/t25a-{selected,progress}.test.ts` → `packages/work/test/observation/t25a-{selected,progress}.test.ts`, and `packages/work/src/receipt/t25a-consistency.test.ts` → `packages/work/test/receipt/t25a-consistency.test.ts`; the current Work runner otherwise excludes them. Their implementation packet follows T18's authoritative association/receipt producer contract, with one Work writer for pure mechanics, one State writer for persistence/read/fence joins, compiler ownership of declaration/selected-field checks, and the interface owner consuming the admitted projected result. The new interval changes neither the runtime policy/clock findings nor fanout substrate availability.

### Bounded T33 overlay caveat

The separately read, untracked [T33 resolution](../../../implementation/challenge-audit-run/t33-resolution.md) supplies material companion requirements omitted from the earlier mixed consultation: complete finite admitted cohorts, per-child current evaluation and failure isolation, parent-trigger durability, and remaining/failed progress. Its corrected triple advice is reported as high-confidence direction A, and the resolution records durable per-child execution with authoritative membership cutoff, stable identities, atomic child effect/checkpoint, bounded execution units, honest resource admission and no automatic coverage-losing supersession.

R07 above is historical evidence for the original fixed pin and its incomplete consultation context. Production population estimates are not a prerequisite for preserving the stated complete-cohort contract, and the old request for such estimates must not become a new gate. The corrected resolution and consultation records are committed; F1–F5 mechanism source now provides a fanout substrate. G01/C09 concerns actual membership/identity/checkpoint/recovery and generated-serving qualification. F6/F7/T26 remain unfinished checkpoints. Mechanism source and reported unit proofs do not certify complete original-app delivery.

## Main merge reconciliation, 2026-10-06

All 118 branch commits were fast-forwarded onto `main` through `1126544`, preserving
their hashes and the exact source tree. The [merge record](../main-merge-20261006.json)
accounts for all 487 changed paths since the complete checkpoint and registers
44 newer source inputs with exact defining owners/targets. Current structural
coverage is updated; primary audit evidence remains pinned to its historical source.
The complete checkpoint stays at `8249342`: deep joined-path review and product
qualification remain unfinished. This bookkeeping is not implementation acceptance.

F1–F5 fanout mechanisms, T25 receipt persistence/fences, T18 engine initialization,
T19 derivation and T20 form factories now exist in committed source. F6/F7/T26 are
explicitly unfinished checkpoints. Historical blanket absence claims are superseded
at that mechanism scope; generated serving, production receipt/default/form joins,
C05 discovery/import cutover, C08/C09 and original R01 remain open. New test drivers
and colocated witnesses have testing successors gated on actual caller/discovery
cutover. Existing retirement decisions remain unchanged.

The old implementation run is user-stopped, its heartbeat paused, and only the main
checkout remains. No Muse instances, timers, worktrees or implementation are launched
by this merge. The separate [remaining implementation plan](../../../implementation/REMAINING-IMPLEMENTATION-LANES.md)
defines that finite authorized backlog; this file-tree plan does not expand it.
