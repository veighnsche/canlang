# Work/state transition kernel implementation plan

October 6, 2026. Source checkpoint: `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5`. This is a proposed implementation plan, not an implemented port or benchmark result. It applies the shared-row boundary in [boundary-options.md](../boundary-options.md) and the behavioral limits in [full-evaluation.md](../full-evaluation.md). Compiler implementation, lowering, generated handler execution and `.can` composition remain unchanged. `.can` declarations and their existing owning producers continue to determine app identity, handlers, cohorts, dependencies and permissions.

The initial project consolidates matching TypeScript mechanisms, then ports closed row codecs, data-only lifecycle/retry/receipt/recovery decisions and batch-linkage calculations together. TypeScript remains responsible for observable object evaluation, host reads, membership, authorization, guards, providers, freshness, durable commits and caller retries. A separate project may later move request/resume orchestration into Rust; completing this initial project does **not** mean the scheduler migrated.

## Current sources, producers and consumers

Paths below are repository-relative. They describe actual code at the checkpoint, including test-only consumers; the proposed kernel APIs below do not exist yet.

| Current source and exports | Actual consumers and responsibility | Initial disposition |
| --- | --- | --- |
| `packages/contracts/src/work.ts`, `state.ts` | Work/state/runtime use the committed vocabulary, `StoredRow`, writes, `CommitBatch`, revision and retry policy types. | Retain contract ownership; derive/check ABI tags against these declarations, without copying an independent policy catalog. |
| `packages/work/src/kernel/tables.ts`: dispatch, occurrence, schedule, every-slot, supersession and fanout models; `read*Row`, `new*Row`, `withRowData`, row identity and checkpoint helpers | Work commands, dispatch and recovery import these directly. Producers stage flat queryable rows. Work fanout tests read/write the real F2 codec. | Work-owned common row mechanism; preserve compatibility exports and work error profile. |
| `packages/work/src/kernel/commands.ts`: `WORK_SYSTEM_COMMANDS`, `WORK_DISPATCH_STAGE_COMMANDS`, claim/record/requeue/release/recover/stage and schedule/every stages | `createSystemRegistry` consumes reader-only stages. Cloudflare receives composed commands through its producer seam. Stages load/query and return conditional writes; they are not commit owners. Retry/exhaustion rules partly mirror receipt helpers. | Keep host reads and stage shell; extract only matching decision/build functions. Preserve branch/refusal order and query re-filtering. |
| `packages/work/src/dispatch/index.ts`: `attemptDispatch`, `matchClaimIdentity`, child outcome/progress/turn helpers, `TestOnlyMemoryFanoutChildStore` | Work tests exercise F3 memory claims/records; Cloudflare's fence kernel is injected, while production F7 has its own durable claim/record. Intent and observation tests also consume dispatch types. | Port data-only helpers; keep guard/fence/mint/clock shells. The memory store remains a test fixture, never a production replacement. |
| `packages/work/src/receipt/index.ts`: classification, `recordOutcome`, `reconcileUncertain`, `computeBackoff`, completion consistency, terminal-status and observation projection | Work recovery and association/observation code consume receipt semantics. State's receipt test loader imports the real source; Cloudflare dispatch receives classification through injection and mirrors closed provider errors. | Common primitives plus wrapper-specific result/error policy; opaque result identity remains in the host. |
| `packages/work/src/recovery/index.ts`: inventory, stale claims, staging failures, `planRecoveryScan`, `planFanoutRecoveryScan`, `planRelatedProgressResume`; scan/drain helpers | Work tests include pure and D1/DO durable suites. Cloudflare `runRecoverySweep` injects the ordinary planner. State fanout test loader calls the F4 planner after real F5 staging/restart. | Port closed-batch planning. Keep suppliers, scan/drain loops, evidence demand and act-time re-attestation in TS. |
| `packages/work/src/schedule/every.ts`: slot/coalescing/identity | Every tests and work every-slot stages establish recurrence behavior; hashing currently uses Node crypto. | Include slot/coalescing facts. Keep exact identity-byte preparation/hash with the host until a byte-parity fixture proves the Rust counterpart; do not make hashing a prerequisite for the main pilot. |
| `packages/work/src/observation/{association,observation,ports}.ts` | Authorized stored-receipt projection and related-progress reads; grant/content callbacks have different demand rules for full versus selected observations. | Keep authorization and callback shells; share terminality/projection mechanics only after trace proof. No Rust lookup by delivery id. |
| `packages/state/src/receipt/{tables,join,grants}.ts`: `isStoredReceiptPayload`, `assertReceiptJoin`, `createReceiptJoinPort`, `observeSelectedReceiptJoin`; `invocation/registry.ts` delivery-field channel | T25 stores `work.receipt_association` and `work.receipt`, binds record/actor leaf grants and retention, injects the work selected observer and enrolls receipt fences. `receipt/work-loader.ts` is a test-only real-work bridge. Stored pending payload acceptance extends the work completion predicate. Delivery membership is now loader-derived from `kind: delivery` tags, not a separate hand-built policy catalog. | Share matching receipt consistency/terminality/linkage primitives with an explicit stored-pending profile; keep state row codecs, `ReceiptTableError`, loader-owned schema, grants, retention, loads and fence enrollment as wrappers/hosts. Include receipt-join byte/trace gates; do not count injected-observer tests as proof of deployed receipt wiring. |
| `packages/state/src/fanout/tables.ts`: state-owned F2 structural mirrors | State membership/outcome/progress and transaction assertions consume these. It currently explicitly forbids importing work sources, with byte-parity tested through `fanout/work-loader.ts`. | Replace matching implementation with work-owned **pure leaf** calls, retain state exports and `StateError('validation')` profile. Change the layering comment and prove the new graph deliberately. |
| `packages/state/src/fanout/outcome.ts`: `stageFanoutChildOutcomeWrite`, `stageFanoutCheckpointAdvanceWrite` | Cloudflare loads these F5 producers and stages child terminal outcomes plus checkpoint cover in the same child-unit commit. Pending pins differ from F3 record API; terminal replay belongs to its caller. | Use shared calculation, retain state staging policy and ordering; return conditional updates with observed versions. |
| `packages/state/src/fanout/{cohort,membership,lifecycle,progress}.ts`, `effects/staging.ts` | Cohort/membership freeze/admission, live deletion/movement/history classification, progress, closed outcome validation. F5 tests cross-check real work rows. | Keep enumeration, authority and I/O. Factor classification over already-read evidence and canonical set/progress operations when genuinely matching. |
| `packages/state/src/ports/transact.ts`: `assertDispatchJoin`, `assertFanoutChildJoin`, join port factories | Dispatch staging must co-stage outbox+dispatch; child units must co-stage terminal outcome+checkpoint coverage. Both ports assert before **one** store commit and map storage errors; caller decides retries. | Shared linkage mechanism on ordered facts; TS keeps pre-store assertion/error wrapper and live commit. Do not silently strengthen current assertion policy. |
| `packages/state/src/ports/system.ts`: `createSystemRegistry` | Commands get only `load`/`query`; registry reads revision, stages and validates, then single-shot commits. | Keep this structural reader-only seam and validation sequence. No commit capability crosses the Rust boundary. |
| `packages/state/src/invocation/{admission,replay,invoke}.ts`: canonical admission, receipt hash/replay, `invokeFanoutChild` | Each child invokes fresh admission and live membership; its wrapped store asserts join on the complete owner transaction, including successful or rejected receipt paths. | Leave admission/security authority and canonical raw input hashing in TS; preserve raw-input replay before age/auth/normalization. |
| `packages/cloudflare/src/runtime/invoke.ts`: `readDispatchExecutionRow`, worker registry/join loader, `driveDispatchIntent`, `runRecoverySweep`; F7 table/outcome mirrors, producer loader, trigger join, claim/record/release, scheduler turn/progress and provider cancellation | **Actual production orchestration owner.** F7 loads state-dist builders and commits through `StoragePort`; its D1/DO tests prove races and kill/restart. The ordinary recovery driver re-reads evidence and live rows when acting. | Consolidate matching decode/outcome/staleness mechanics; retain the existing producer seam, orchestration, fence gates, and authoritative host commit. Wire the real kernel here as well as in state. |
| `packages/state/src/storage/{d1,durable-object,port,schema}.ts` | D1 uses atomic `db.batch`; DO uses transaction-backed storage. Both enforce revision/version semantics and serialize persisted rows/receipts. | Unchanged commit/security owners; Rust output is a proposed batch, not a storage authority. |
| `packages/cloudflare/src/worker/assembly.ts`, `deploy/bundle.ts`, `dev/local-run.ts`; `packages/testkit/src/scopes/local.ts`; Cloudflare release manifest | Assembly exposes runtime serving joins. Bundling vendors fixed JS dist trees, excludes state test loaders, rewrites imports and currently delivers text modules. | Integrate through shared binary delivery C04; independent package build/export/vendor/release changes are real work. |

The work memory-store winner proof is synchronous single-process serialization. It is not a durability, multi-handle fence or restart proof. Required production evidence comes from `packages/cloudflare/src/runtime/t24b-dispatch-execution.test.ts` and `t24b-dispatch-durable.test.ts`, `t34-f7-fanout{,-durable}.test.ts`, `t32b-cloudflare{,-durable}.test.ts`, plus state F5 and work F4 durable suites.

There is no named `wait` API in the inspected work/state/Cloudflare/stdlib source trees. The initial pilot's wait coverage means the existing held child/unknown provider/awaiting evidence states, progress observation and later re-drive/recovery; it must not manufacture successful completion for them. Trace an emitted or services-level wait consumer if one is later selected, and add its real integration fixture before claiming await-body continuation compatibility. A Rust continuation scheduler is deferred below.

## Ownership and target file tree

Use a responsibility leaf, **`packages/work-kernel` owned by the work subsystem**, with a contracts-only type dependency. State and Cloudflare consume that leaf, not full `packages/work`. Full work is currently private, has no dist build, and its commands depend on state system definitions. A direct `state -> full work` dependency would create an avoidable layering/build cycle. An independently built `@canlang/work/transitions` subpath could enforce the same graph and adds fewer packages, but still needs new builds, vendors and releases plus careful policing of build roots and exclusion of commands. The root's three consultations favored the leaf; source review supports that choice because the explicit package DAG is easier to enforce. It adds no independent language or policy authority.

```text
packages/work-kernel/                   # proposed; work owns matching mechanisms
  package.json                         # @canlang/work-kernel 0.1.0, pure JS/backend exports
  tsconfig.json                        # independent contracts-only build graph
  Cargo.toml                           # lib path decisions/lib.rs; wasm binding feature
  Cargo.lock                           # pinned crate/toolchain policy from C03/C04
  decisions/
    lib.rs
    rows.rs                            # flattened row data, identity/set rules
    lifecycle.rs                       # classify already-read evidence, no lookup
    retry.rs                           # exhaustion/backoff with supplied sample
    receipt.rs                         # closed receipt decisions, payload indices
    recovery.rs                        # ordered batch classification, no supplier calls
    linkage.rs                         # dispatch/fanout/receipt assertion calculation
    every.rs                           # finite-number slot/coalescing rules
  bindings/
    wasm.rs                            # versioned entry/result ABI, no host I/O imports
    loader.ts                          # injection/initialization through C04 bootstrap
    host-values.ts                     # call-local opaque identity refs + disposal
  src/
    index.ts                           # pure prepared mechanisms; no state/full-work import
    facts.ts                           # private owner-produced ordered ABI carriers
    prepared.ts                        # integrator composition of lane modules
    rows.ts                            # rows lane
    retry.ts
    every.ts
    lifecycle.ts                       # policy lane
    receipt.ts
    recovery.ts
    linkage.ts                         # receipts/recovery/linkage lane
    profiles.ts                        # neutral fault descriptors; wrapper policy stays outside
    backend.ts                         # backend chosen before executing operations
  conformance/
    rows.test.ts
    retry.test.ts
    every.test.ts
    lifecycle.test.ts
    receipt.test.ts
    recovery.test.ts
    linkage.test.ts
    transitions.test.ts
    traces.test.ts
    persisted.test.ts
    fixtures/                          # current TS rows/receipt bytes and ordered traces
  measurement/
    complete-calls.ts                   # C05 harness consumer, explicit workload metadata
  dist/                                # generated TS/glue/binary, one release inventory
packages/work/src/{kernel,dispatch,receipt,recovery,schedule,observation}/
  ...                                  # current exports + host-compatible shells
packages/state/src/{fanout,receipt,ports,invocation}/
  ...                                  # StateError/policy wrappers, authoritative admission/commit
packages/cloudflare/src/runtime/
  invoke.ts                            # live durable consumer; orchestration stays TS
  work-kernel-pilot.test.ts             # proposed real consumer + trace tests
  work-kernel-pilot-durable.test.ts     # proposed D1/DO restart + actual binary path
```

No `rust/` or language-bucket source directory is added. Rust sources live within the owning mechanism's responsibility directory. Public work/state exports and `.can` authoring remain intact; contracts retain vocabulary. Do not duplicate contracts, cohorts, retry catalogs, grants or app composition in Cargo code.

Build graph changes are explicit deliverables: root builds contracts, then work-kernel, then state/stdlib/Cloudflare/testkit; add workspace dependencies/exports and type-resolution checks. The leaf build must not import state commands, Node test loaders or Node crypto into its Worker export. Pin `@canlang/work-kernel` to the owning release, currently `0.1.0`: `release/stamp.ts` exempts only full work/files/services at `0.0.0`, so the new emitted leaf is not exempt. It has an internal API but ships through the same release channel as state/values; do not make published consumers depend on an unpublished private workspace package. Test installation from the actual packaged release outside the checkout. W02/W05 verify `bun run release:stamp` against a correctly built isolated release tree as well as dist integrity. Add `vendor/work-kernel` to Cloudflare's producer inventory and rewrite the exact new bare imports; stage Wasm bytes through C04's typed inventory, not current UTF-8 JS writing. Manifest discovery currently sees existing package dist roots, so require the selected kernel root/binary to exist and verify its integrity rather than relying on optional discovery. Preserve exclusion of `vendor/state/fanout/work-loader.js` and `receipt/work-loader.js`. Reconcile package/install, vendor entry, manifest and living file-tree responsibilities before implementation; no merge/checkpoint advancement is performed by this plan.

## Private boundary and compatibility rules

The proposed private operation takes an ordered closed row batch, a versioned operation/profile tag, supplied time/policy facts and call-local opaque payload references. It returns ordered decisions or proposed conditional writes plus a neutral first-fault descriptor. These are design shapes, not existing exports:

```text
Operation(version, profile, ordered rows/write facts, time/retry facts, opaque refs)
  -> Decisions / ProposedWrites / FirstFault(code, location, profile arguments)
```

Rows retain source position, model/id, version and metadata; flattened fields retain missing/undefined/null/value distinctions where a wrapper observes them. Counts, versions and instants cross as validated JS-compatible numbers, not prematurely truncated `u32`/`i64` arguments. Finite fractional times are valid today. Preserve accepted Number integer ranges, rounding of increment/slot/backoff operations, nonfinite failures and first-error order; narrowing to safe integers is a separate versioned design decision. Text and sort order use lossless UTF-16 units and JS lexical ordering. `encodeURIComponent` identity encoding must preserve escaping and its lone-surrogate exception; recurrence digest preparation instead uses current JS number spelling and Node UTF-8 replacement behavior. They are different profiles.

Opaque refs are call-local indices, not persisted ids and not authority tokens. The host retains frozen requests, results, provider payloads, receipt values and untouched row metadata; Rust cannot inspect or synthesize them. Preserve result identity where existing functions pass results through; preserve cloning where row builders use `structuredClone`. Dispose refs on success, exception, cancellation and rejected load; stale/cross-call indices fail closed. No unbounded global row arena or retained authority snapshot is needed initially. Batch/payload limits must derive from real callers and documented resource policy; exhausting a new bound cannot silently truncate membership or completion.

**Trust and evaluation:** an arbitrary `StoragePort` return value or TS annotation does not prove inert data. Use the actual D1/DO `JSON.parse` ownership path or the kernel's own validated producer output to establish prepared provenance. Legacy APIs continue to evaluate arbitrary objects in TS. Do not perform eager spreads, serialize them wholesale, walk getters/proxies early or treat freeze as provenance. Preserve own-property enumeration, nullable defaults, repeated field reads, sparse arrays, alias/cycle handling and thrown values. Work JSON-safety traversal then clone differs from state clone-only row replacement; these remain profiles. Work's safety traversal currently treats repeated object identity as seen/cyclic without removing it on unwind; do not replace it with a recursion-stack policy under parity. Completion predicates say “never throws” in comments but actual getter/proxy operations can throw; preserve executable behavior and capture that gap rather than swallowing exceptions in the port.

**Demand stays in TS initially.** Callback APIs are not converted by eagerly collecting all verdicts. Retain their original evaluation loops/shells; prepare facts only at the stage where that callback was already demanded. For ordinary recovery, the host demand pass must validate/process each row in original order and read evidence only for uncertain rows, stopping on the same first exception; the pure Rust classifier receives the resulting closed facts after that pass. This preserves traces at the cost of retained TS demand logic and possible repeated checks, which the prepared-TS comparator must expose. For APIs where extracting such a pass cannot preserve behavior economically, keep that complete callback path in TS during initial rollout. A narrow data-only port can still cover its matching transition functions; do not claim the callback API itself fully migrated.

Required order profiles include:

- Ordinary `attemptDispatch`: commit marker, inherited-scope refusal, supersession, pending state, guard, live authority, claim id, clock. Command-stage claim and runtime preclaim/provider flow have their own order; do not force them into this sequence merely because results look similar.
- Durable fanout claim: validate inputs/fence shape, load row, terminal replay, running hold, stale version, fresh checkpoint/inherited refusal, current snapshot and guard only if predicate exists, live authority only if reached, proposed running write, fresh revision + conditional commit. A throw from snapshot/guard causes no terminal skip and no commit.
- State fanout outcome staging: result shape, retry/time validation, row read/live-state requirement, pending pin restrictions, transition/cause validation, row clone. Its terminal-row rejection differs from driver replay; pending pins accept skipped/failed without executed-attempt increment, while running completed/failed/transient count attempts and skips do not.
- `computeBackoff`: argument/policy validation and exhaustion precede randomness; exhausted/invalid calls consume zero samples, eligible calls one; nonfinite random becomes zero. No Rust RNG or eager sample.
- Ordinary recovery: input-order evidence calls, last duplicate claim wins, then JS-order sorted output lists. Fanout recovery validates each row/lifecycle before branches; settled and fresh running rows short-circuit, demonstrable deletion stays distinct from missing/inaccessible/infrastructure unknowns, moved rows use current body guards, then exhaustion/resume applies only as currently specified.
- Full receipt observation requests grants for unique requested result/error leaves only and content availability only when demanded; selected observation authorizes unique selected leaves (including id/status) before presence disclosure. Locator/shape/store agreement precede grants. Keep distinct traces, withholding/null and fence enrollment behavior.
- Stored receipt payload consistency shares non-pending completion rules but additionally accepts pending with null result/error. Preserve the profile difference. Receipt join ignores remove writes, checks duplicate model/row writes and row identity, and requires each staged association's same-delivery receipt with equal revision; it does not require every receipt update to include an association.
- Canonical admission reads revision and hashes **raw** inputs, checks receipt replay before age/auth/normalization, and revalidates successful and rejected commit paths. Keep `stableStringify`, getters/`toJSON`, defaults and input hash in their existing owner; this plan does not port that unknown-input canonicalizer.

Fault descriptors allow TS wrappers to recreate exact class/name/code/message/path/precedence: `KernelTableError`, `StateError('validation')`, `RangeError`, plain errors and native callback exceptions are not one generic Rust error. Exceptions raised by host evaluation propagate as their original values. Do not retry a semantic failure in TS after Rust already ran.

**Linkage is calculation, not authorization.** Transfer ordered writes/outbox facts; inspect only fields the current assertion inspects. Dispatch inserts require unique outbox/row ids, row-id/data-id agreement, both halves except guard-false row-only skips; updates-only claim/recovery batches remain allowed. Fanout checks insert-only intent, row derivations, closed states/causes, no fabricated initial completion, no removals, duplicates and terminal-child same-fanout checkpoint coverage. Preserve existing assertion scope exactly: the current final checkpoint-without-outcome rejection tests whether there are any terminal outcomes globally, not a new per-checkpoint converse assertion. If stricter checks are wanted, propose/test them separately. Cursor-only maintenance stays on the plain store port. Unrelated batch effects remain host-owned and preserve their order.

Every proposed update carries its original `expectedVersion`; the host owns `expectedRevision` acquisition at the existing point. Kernel batch validity cannot prove freshness or grant authority. `runRecoverySweep` must reread not-found/delivered/failed evidence at action time, reload affected rows and retain defer/exhaustion checks. Fanout invocation must re-read live membership/authority and revalidate commit even after guard passes. D1/DO perform the authoritative atomic fenced commit. Each commit seam remains single-shot; existing driver race reloads and canonical invocation retry policies remain host behavior. Do not add a kernel retry loop or change caller-owned retry/exhaustion semantics.

## Shared work coordination

Use the root's common task contracts rather than inventing another binary platform:

| Shared task | Dependency consumed here | Work contribution |
| --- | --- | --- |
| C01 contracts | Compatibility profiles, ownership, provenance and completion definitions before translation | Pin work/state/runtime fault/order matrix and leaf dependency graph. |
| C02 prepared TS baseline | Equivalent optimization/consolidation comparator | Register W02 baseline and W03 host demand pass; measure these independently of Rust. |
| C03 ABI | Versioned carriers, lossless text/presence/numbers, host-ref lifecycle and faults | Work ordered batch facts and conditional write linkage; no grant capability in ABI. |
| C04 real Wasm delivery | Typed JS/Wasm assets, byte-safe bundle/digests, bootstrap, testkit/Miniflare/workerd path | Add work-kernel build/export/vendor/manifest entries and actual durable consumer module. |
| C05 parity + measurement harness | Native/adapter/runtime differential records, reproducibility and resource measurements | Supply transitions, traces, persisted-byte fixtures and complete durable workloads. |

Coordinate with proposed platform bootstrap: load/verify the pinned module once before publishing synchronous kernel façades; asynchronous platform setup may await initialization, while public synchronous functions stay synchronous. An explicit startup/build selection chooses TS or Rust before operations begin. Once Rust is selected, missing/corrupt/incompatible module and initialization failures fail loudly; rollback is a new release/startup choice selecting TS. This is the root's consultation-backed policy. Do not lazy-initialize in a semantic call, change function signatures to promises, silently recover a mid-call trap with TS, or load duplicate kernel instances through independently bundled/vendor paths. C04 owns common asset machinery; W05 owns this consumer's concrete wiring. Record this bootstrap/fallback contract in C01 before choosing default backend.

## Executable waves and parallel lanes

The checklist is executable task metadata mirrored in [work-transitions.tasks.json](work-transitions.tasks.json). Every box is intentionally unchecked. `C01.ready` through `C05.ready` are shared **readiness** milestones (assigned contracts/scaffolding/smoke transport/harness), not aggregate completion of subsystem outputs. W tasks contribute evidence to the shared completion ledger. `C04.graph` is the shared manifest/build/install milestone after `W02.foundation` and `C04.asset`; `C04.ready` is the independent tiny-Wasm smoke milestone and does not await the work graph. `C04.work-assets` fulfils W05.2 for the final generated kernel/vendor/release assets after C04.graph and C04.ready; W05.4 verifies them, then W05.3 exercises actual delivery. Waves show the earliest useful grouping, **not barriers**: start a task as soon as its explicit dependencies are met, including a native branch while another TS/trace branch remains active. Parent W01–W08 boxes are gates depending on all their children; no child depends on its own parent. W09 is a separately gated optional project.

Use at most four active workers: one integrator, two disjoint implementation lanes and one evidence/contracts worker. Native rows, policy and receipt/recovery lanes may have ready tasks at once, but schedule only two writers in those lanes concurrently and rotate the third. Reserve the integrator for shared manifests/module entry/profiles/transact/runtime changes; do not spend all slots waiting. A blocked worker returns its exact blocked dependency and works only from the lane's ready backlog. No spawning is performed in this documentation round.

The work integrator serializes package-local manifests, Cargo/module registrations, public wrapper joins, `packages/state/src/ports/transact.ts` and `packages/cloudflare/src/runtime/invoke.ts`. Shared C04 exclusively edits `packages/cloudflare/src/deploy/bundle.ts`, `src/dev/local-run.ts`, shared testkit propagation, root build/lock, state/Cloudflare/stdlib/testkit consumer manifests and shared binary inventory; W05 submits and verifies an integration request. The explicit `W06.runtimehandoff` gate releases runtime/invoke.ts to validation; validation's canonical runtime writer must depend on that gate in the root DAG. After handoff, work refreshes test expectations against final assembled source but never writes the runtime file again. Validation V09.1 is the last validation runtime writer and depends on W06.runtimehandoff; work W06.3 then depends on V09.1 so final runtime tests cannot race source edits. Other state's pure profile logic can proceed in parallel.

| Lane | Start and owned files | Exit/handoff | Ready backlog if blocked |
| --- | --- | --- | --- |
| **Contracts and caller inventory** (`work-contracts`) | C01.ready; inventory and budget inputs available. Owns `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/ownership/`. | W01 plus graph/profile handoff to W02/W03. | Audit existing producer/test-only sources and minimize baseline discrepancies; no production translation before the owning contract is settled. |
| **Rows and identity/set mechanisms** (`work-rows`) | W02.1 plus independent row baseline and W03.1 for native work. Owns `packages/work-kernel/src/rows.ts`, `packages/work-kernel/decisions/rows.rs`, `packages/work-kernel/conformance/rows.test.ts`, `packages/work-kernel/conformance/fixtures/rows/`. | W02.2/W04.1 oracle parity, then hand module to integrator. | Prepare row malformed/UTF-16/metadata vectors and baseline corpus; do not edit shared lib.rs or wrappers. |
| **Retry, recurrence and lifecycle policy** (`work-policy`) | W02.1 plus policy baseline and W03.1 for native work. Owns `packages/work-kernel/src/retry.ts`, `packages/work-kernel/src/every.ts`, `packages/work-kernel/src/lifecycle.ts`, `packages/work-kernel/decisions/retry.rs`, `packages/work-kernel/decisions/every.rs`, `packages/work-kernel/decisions/lifecycle.rs`, `packages/work-kernel/conformance/retry.test.ts`, `packages/work-kernel/conformance/every.test.ts`, `packages/work-kernel/conformance/lifecycle.test.ts`, `packages/work-kernel/conformance/fixtures/policy/`. | W02.3/W04.2 boundary and numeric parity. | Prepare horizon/fractional/count/sample/identity-byte cases; keep identity hash in host. |
| **Receipts, recovery and linkage decisions** (`work-receipts`) | W02.1 plus receipt baseline and W03.1 for native work. Owns `packages/work-kernel/src/receipt.ts`, `packages/work-kernel/src/recovery.ts`, `packages/work-kernel/src/linkage.ts`, `packages/work-kernel/decisions/receipt.rs`, `packages/work-kernel/decisions/recovery.rs`, `packages/work-kernel/decisions/linkage.rs`, `packages/work-kernel/conformance/receipt.test.ts`, `packages/work-kernel/conformance/recovery.test.ts`, `packages/work-kernel/conformance/linkage.test.ts`, `packages/work-kernel/conformance/fixtures/receipts/`. | W02.4/W04.3 ordered decision and linkage parity. | Prepare stored-pending/full-selected/refusal/linkage vectors with no grant/evidence calls. |
| **Host demand and observable trace shells** (`work-host`) | W03.1 for refs; W02.5 for callable-shell extraction. Owns `packages/work/src/dispatch/index.ts`, `packages/work/src/receipt/index.ts`, `packages/work/src/recovery/index.ts`, `packages/work/src/observation/association.ts`, `packages/work/src/observation/observation.ts`, `packages/work/src/observation/ports.ts`, `packages/work/src/schedule/every.ts`, `packages/work/src/kernel/commands.ts`, `packages/work-kernel/bindings/host-values.ts`, `packages/work-kernel/conformance/traces.test.ts`, `packages/work-kernel/conformance/fixtures/traces/`. | W03.3 traces and call-local cleanup handed to evidence. | Capture getter/proxy/RNG/evidence/grant/content traces on legacy TS; keep shell unchanged until corresponding pure mechanism is ready. |
| **Single package, ABI and production integration writer** (`work-integrator`) | W01.2 writer assignment, then exact per-task dependencies. Owns `packages/work-kernel/package.json`, `packages/work-kernel/tsconfig.json`, `packages/work-kernel/Cargo.toml`, `packages/work-kernel/Cargo.lock`, `packages/work-kernel/decisions/lib.rs`, `packages/work-kernel/bindings/wasm.rs`, `packages/work-kernel/bindings/loader.ts`, `packages/work-kernel/src/index.ts`, `packages/work-kernel/src/facts.ts`, `packages/work-kernel/src/profiles.ts`, `packages/work-kernel/src/prepared.ts`, `packages/work-kernel/src/backend.ts`, `packages/work-kernel/conformance/transitions.test.ts`, `packages/work/src/kernel/tables.ts`, `packages/state/src/fanout/tables.ts`, `packages/state/src/fanout/outcome.ts`, `packages/state/src/ports/transact.ts`, `packages/state/src/receipt/tables.ts`, `packages/cloudflare/src/runtime/invoke.ts`, `packages/cloudflare/src/runtime/work-kernel-pilot.test.ts`, `packages/cloudflare/src/runtime/work-kernel-pilot-durable.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/pilot.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/rollback.json`. | W06.runtimehandoff; W08.2 packaged rollback; no runtime writes after handoff. | Assemble package/ABI/build requests or review queued module patches; C04 platform blockers allow native/TS oracle work, never consumer enablement. |
| **Baselines, conformance evidence and release decision** (`work-evidence`) | C05.ready for baseline; final tasks wait explicit consumer deps. Owns `packages/work-kernel/conformance/persisted.test.ts`, `packages/work-kernel/measurement/complete-calls.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/measurements/`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/final/`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/bytes.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/error-order.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/delivery.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/loader-errors.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/adoption.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/coverage.json`. | W07 and W08 coverage/resources/release ledger. | Build deterministic fixture/minimizer/report/runner inputs; never execute a final benchmark against unproved or stale artifacts. |
| **Optional separate scheduler project** (`work-scheduler`) | W08 plus separate project authorization/contract. Owns `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/scheduler/`, `packages/work-kernel/continuations/`. | W09 separate go/no-go; does not block W08. | No initial-project implementation backlog; record missing real continuation consumer and maintain separate scope. |

All implementation commands run from repository root unless stated. Preserve logs/runtime versions and baseline failures in the exact evidence paths below. Native/generated-package commands are proposed deliverables until their owning task lands; existing package commands remain in the unchanged verification block. Every parent gate also retains its original detailed acceptance below.

### Wave 1 — Contracts and independent current-TS evidence

#### Parallel lane: Contracts and caller inventory

- [ ] **W01.1 — Pin production/test-only caller, wait and delivery-schema coverage**
  - Start after: `C01.ready`. Parent: `W01`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/callers.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/profiles.md`.
  - Action/done: Inventory every source table and public shell listed above; distinguish memory fixtures from real Cloudflare F7/durable consumers and the absent named wait API.
  - Action/done: Record loader-owned deliveryFields from registry, empty per-model membership sets, finite delivery tag version and presence-only result leaves; include b3-delivery-schema and receipt memory/durable baseline fixtures.
- [ ] **W01.2 — Choose the pure leaf graph and assign single writers**
  - Start after: `C01.ready`. Parent: `W01`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/ownership/graph.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/ownership/files.json`.
  - Action/done: Compare contracts-only work-kernel versus isolated work subpath fairly; preserve root JEV advice as advice and record source graph evidence.
  - Action/done: Assign one work integrator for shared manifests, module entry, profiles, state transact and runtime invoke; submit root build/lock and binary delivery requests to C04 owner.
#### Parallel lane: Baselines, conformance evidence and release decision

- [ ] **W01.3 — Capture unchanged behavior, clone and persisted-byte baseline**
  - Start after: `C05.ready`. Parent: `W01`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/current-ts.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/verify.log`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/original-fixtures/`.
  - Action/done: Run existing command block against inspected sources, retain logs and failures; failed noEmitOnError builds cannot supply stale dist evidence.
  - Action/done: Save original row/result identity, state clone-only versus work safety-then-clone, error/trace ordering and actual D1/DO persisted bytes in immutable evidence as an independent oracle; pure owner lanes copy/hash their golden fixture subsets later.

### Wave 2 — Package skeleton and parallel TS/ABI mechanisms

#### Parallel lane: Contracts and caller inventory

- [ ] **W01.4 — Ratify workload, budget and supported-profile ledger**
  - Start after: `W01.1`, `W01.2`, `W01.3`, `C05.ready`. Parent: `W01`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/workloads.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/budgets.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/contracts/coverage.md`.
  - Action/done: Nominate tiny/page/501-member/error/restart/recovery workloads and numeric latency/memory/binary budgets before seeing Rust comparisons.
  - Action/done: Identify retained unknown-object/callback/host hashing/recurrence hash paths and new operation resource limits without silently narrowing legacy inputs.
- [ ] **W01 — Capture consumer contracts and behavioral traces — completion gate**
  - Gate after: `W01.1`, `W01.2`, `W01.3`, `W01.4`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: complete symbol/caller inventory based on the table above; traced host call/error/refusal order; row/receipt byte fixtures from current D1/DO writers; graph comparison for leaf versus independent work subpath, reviewed alongside root JEV advice. Establish workloads and numeric resource/latency budgets **before** measuring/adoption; do not fabricate thresholds from feasibility estimates.
  - Preserved gate contract: Acceptance: identify each production caller and each test-only seam; current/proposed profiles and deviations are explicit; no permission or evaluation-order behavior omitted. Run work tests and typechecks below, state/Cloudflare baseline builds and selected runtime tests, preserving failures. Existing full-evaluation evidence reports Cloudflare typecheck errors at `invoke.ts:5911`, `t34-f7-fanout-durable.test.ts:660`, `t34-f7-fanout.test.ts:1879,1897`; re-evaluate at the current checkpoint and assign fixes before treating build-dependent gates as passing. Do not claim a usable dist from a failed `noEmitOnError` build.
#### Parallel lane: Rows and identity/set mechanisms

- [ ] **W02.2 — Extract ordered row, identity and set TS mechanisms**
  - Start after: `W01.1`, `W01.3`, `W02.1`. Parent: `W02`.
  - Files: `packages/work-kernel/src/rows.ts`, `packages/work-kernel/conformance/rows.test.ts`, `packages/work-kernel/conformance/fixtures/rows/`.
  - Action/done: Preserve all eight table shapes, metadata, default presence, JSON-safety versus clone-only profiles, JS counts and UTF-16 identity/set order.
  - Action/done: Compare both producer directions against frozen originals; do not use both wrappers calling the same helper as the sole oracle.

#### Parallel lane: Retry, recurrence and lifecycle policy

- [ ] **W02.3 — Extract retry, recurrence and lifecycle TS decisions**
  - Start after: `W01.1`, `W01.3`, `W02.1`. Parent: `W02`.
  - Files: `packages/work-kernel/src/retry.ts`, `packages/work-kernel/src/every.ts`, `packages/work-kernel/src/lifecycle.ts`, `packages/work-kernel/conformance/retry.test.ts`, `packages/work-kernel/conformance/every.test.ts`, `packages/work-kernel/conformance/lifecycle.test.ts`, `packages/work-kernel/conformance/fixtures/policy/`.
  - Action/done: Retain finite fractional times, Number count arithmetic, horizon/stale boundaries and explicit supplied random sample; no clock/RNG/evidence side effects in pure module.
  - Action/done: Keep hashing and exact recurrence bytes host-owned; encodeURIComponent lone-surrogate exceptions remain separate from digest UTF-8 replacement behavior.

#### Parallel lane: Receipts, recovery and linkage decisions

- [ ] **W02.4 — Extract receipt, recovery and linkage TS decisions**
  - Start after: `W01.1`, `W01.3`, `W02.1`. Parent: `W02`.
  - Files: `packages/work-kernel/src/receipt.ts`, `packages/work-kernel/src/recovery.ts`, `packages/work-kernel/src/linkage.ts`, `packages/work-kernel/conformance/receipt.test.ts`, `packages/work-kernel/conformance/recovery.test.ts`, `packages/work-kernel/conformance/linkage.test.ts`, `packages/work-kernel/conformance/fixtures/receipts/`.
  - Action/done: Keep stored-pending receipt profile distinct, wrapper-specific faults, result host references, last duplicate claim wins and JS-sorted output.
  - Action/done: Preserve dispatch/fanout/receipt assertion scope, including global checkpoint-without-outcome check, receipt-only allowed updates, guard-false row-only inserts and cursor-only plain-store path.

#### Parallel lane: Single package, ABI and production integration writer

- [ ] **W02.1 — Create publishable package-local manifests and build roots**
  - Start after: `W01.2`, `C02.ready`. Parent: `W02`.
  - Files: `packages/work-kernel/package.json`, `packages/work-kernel/tsconfig.json`, `packages/work-kernel/Cargo.toml`, `packages/work-kernel/Cargo.lock`, `packages/work-kernel/src/index.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/build-request.md`.
  - Action/done: Pin @canlang/work-kernel to release 0.1.0; define pure JS/backend exports, files/dist shipping and contracts-only type graph; no unpublished private workspace runtime dependency.
  - Action/done: Declare build/typecheck/build:wasm scripts and conformance include/output roots plus minimal neutral TS entry/interfaces; submit root build/bun.lock and shared consumer dependency request to C04.graph without editing shared manifests or platform globals.

- [ ] **W03.1 — Freeze ordered facts and policy-specific ABI types**
  - Start after: `W01.1`, `W01.2`, `W02.1`, `C03.ready`. Parent: `W03`.
  - Files: `packages/work-kernel/src/facts.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/abi.md`.
  - Action/done: Define version/profile/error/UTF-16/presence/f64/conditional version transport and producer provenance, validating number ranges before fixed-width conversion.
  - Action/done: Reject foreign/version/profile/corrupt facts before semantic callbacks; opaque payload refs are not authority capabilities.

#### Parallel lane: Single package, ABI and production integration writer — foundation handoff

- [ ] **W02.foundation — Release minimal pure package foundation to shared graph owner**
  - Start after: `W02.1`. Parent: `W02`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/foundation.json`.
  - Action/done: Verify standalone minimal work-kernel entry/interfaces, local build roots, exports, 0.1.0 shipping and contracts-only DAG; semantic modules and consumer joins are not required to publish this foundation.
  - Action/done: C04.graph depends on W02.foundation and C04.asset; foundation never waits for C04.graph. Shared graph owner alone changes root package.json/bun.lock and state/Cloudflare/stdlib/testkit consumer manifests/build order.

### Wave 3 — Native branches and host trace extraction

#### Parallel lane: Rows and identity/set mechanisms

- [ ] **W04.1 — Port native ordered rows and identity sets**
  - Start after: `W02.2`, `W03.1`, `C03.ready`. Parent: `W04`.
  - Files: `packages/work-kernel/decisions/rows.rs`.
  - Action/done: Native row/identity/set vectors agree with independent TS oracle for shape, first fault, metadata/presence, count rounding and lossless UTF-16; no host I/O.
  - Action/done: Done for this branch: implementation plus native test vectors/source review are ready for integrator registration; assembled native compile and differential execution are certified by W04.4 before W04 closes.

#### Parallel lane: Retry, recurrence and lifecycle policy

- [ ] **W04.2 — Port native retry, recurrence and lifecycle decisions**
  - Start after: `W02.3`, `W03.1`, `C03.ready`. Parent: `W04`.
  - Files: `packages/work-kernel/decisions/retry.rs`, `packages/work-kernel/decisions/every.rs`, `packages/work-kernel/decisions/lifecycle.rs`.
  - Action/done: Native supplied-sample backoff/slot/coalescing/classification matches fractional/wide-number/error cases; clock/RNG/hash/provider/security operations stay host-owned.
  - Action/done: Done for this branch: implementation plus native test vectors/source review are ready for integrator registration; assembled native compile and differential execution are certified by W04.4 before W04 closes.

#### Parallel lane: Receipts, recovery and linkage decisions

- [ ] **W04.3 — Port native receipt, recovery and linkage decisions**
  - Start after: `W02.4`, `W03.1`, `C03.ready`. Parent: `W04`.
  - Files: `packages/work-kernel/decisions/receipt.rs`, `packages/work-kernel/decisions/recovery.rs`, `packages/work-kernel/decisions/linkage.rs`.
  - Action/done: Native ordered batch decisions/faults/ref indices and proposed conditional writes agree with separate stored-pending and wrapper profiles; no stronger converse linkage policy.
  - Action/done: Done for this branch: implementation plus native test vectors/source review are ready for integrator registration; assembled native compile and differential execution are certified by W04.4 before W04 closes.

#### Parallel lane: Host demand and observable trace shells

- [ ] **W03.2 — Implement call-local opaque reference lifecycle**
  - Start after: `W03.1`. Parent: `W03`.
  - Files: `packages/work-kernel/bindings/host-values.ts`, `packages/work-kernel/conformance/fixtures/traces/refs.json`.
  - Action/done: Retain result identity or required structuredClone at the existing profile point; Rust cannot inspect untouched payloads/metadata.
  - Action/done: Dispose on success, exception, cancel and rejected load; reject stale/cross-call indices, bound allocation and preserve clone failures.
- [ ] **W03.3 — Extract demand-ordered legacy host shells and trace tests**
  - Start after: `W02.5`, `W03.1`, `W03.2`. Parent: `W03`.
  - Files: `packages/work/src/dispatch/index.ts`, `packages/work/src/receipt/index.ts`, `packages/work/src/recovery/index.ts`, `packages/work/src/observation/association.ts`, `packages/work/src/observation/observation.ts`, `packages/work/src/observation/ports.ts`, `packages/work/src/schedule/every.ts`, `packages/work/src/kernel/commands.ts`, `packages/work-kernel/conformance/traces.test.ts`, `packages/work-kernel/conformance/fixtures/traces/`.
  - Action/done: Keep commit/inherited/supersession/pending/guard/authority/mint/clock orders distinct by shell; exhaustion/validation demand zero RNG samples, eligible backoff exactly one.
  - Action/done: Recovery validates/processes rows in order and demands uncertain-only evidence before later rows, stopping at original exception; retain TS callback paths where extraction is uneconomical.
  - Action/done: Full/selected grant/content/fence traces differ; preserve getter/proxy reads, sparse arrays, aliases/cycles and original thrown values, including throwing never-throws predicates.
#### Parallel lane: Single package, ABI and production integration writer

- [ ] **W02.5 — Compose package TS façade and legacy row wrappers**
  - Start after: `W02.2`, `W02.3`, `W02.4`, `C04.graph`. Parent: `W02`.
  - Files: `packages/work-kernel/src/index.ts`, `packages/work-kernel/src/prepared.ts`, `packages/work-kernel/src/profiles.ts`, `packages/work-kernel/src/backend.ts`, `packages/work-kernel/conformance/transitions.test.ts`, `packages/work/src/kernel/tables.ts`, `packages/state/src/fanout/tables.ts`, `packages/state/src/fanout/outcome.ts`, `packages/state/src/receipt/tables.ts`.
  - Action/done: Single integrator assembles entries and profiles; preserve work/state/runtime classes/messages, pending pin policy, row clone/metadata and same exported synchronous shapes.
  - Action/done: Build/typecheck leaf and consumers; installed exports resolve without full work/state/test-loader/Node-crypto runtime imports. Run proposed conformance glob and baseline suites.

- [ ] **W02 — Consolidate matching TypeScript mechanics first — completion gate**
  - Gate after: `W02.1`, `W02.foundation`, `W02.2`, `W02.3`, `W02.4`, `W02.5`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: `packages/work-kernel` pure TS package; contracts-only graph; shared row identities/sets, data transitions, error descriptors and linkage mechanisms; unchanged work/state façades and current callback shells. Preserve state pin/replay rules, work JSON-safety profile, runtime decode/error wording and first-validation order. Retain original implementation fixtures as a frozen oracle so making both wrappers call one new helper is not circular proof.
  - Preserved gate contract: Acceptance: current-versus-consolidated outputs, errors, callbacks, clone/result identity and bytes match in both producer directions; memory store and actual F5/runtime use the consolidated TS mechanism. The installed leaf export resolves under Node and staged Worker vendor imports without importing full work/state/test loaders. Commands: existing baseline suites below, plus proposed `bun run --cwd packages/work-kernel build`, `bun run --cwd packages/work-kernel typecheck`, and `node --test packages/work-kernel/dist/conformance/*.test.js`. Add those scripts/build roots as part of W02, with explicit include/output paths.

### Wave 4 — Native composition and prepared trace/harness gates

#### Parallel lane: Single package, ABI and production integration writer

- [ ] **W04.4 — Register native modules and run shared conformance**
  - Start after: `W04.1`, `W04.2`, `W04.3`, `W03.4`. Parent: `W04`.
  - Files: `packages/work-kernel/decisions/lib.rs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/native-conformance.json`, `packages/work-kernel/Cargo.toml`, `packages/work-kernel/Cargo.lock`.
  - Action/done: Only integrator edits lib.rs/module registrations; matching immutable vectors drive native and prepared TS outputs.
  - Action/done: Run cargo test --locked, cargo fmt --check and cargo clippy --locked --all-targets -- -D warnings; inspect imports/features for forbidden host authority, preserve exact faults and materialization demand.
- [ ] **W04 — Implement data-only Rust kernel and native conformance — completion gate**
  - Gate after: `W04.1`, `W04.2`, `W04.3`, `W04.4`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: the `decisions/*.rs` modules in the target tree; Rust row/transition/retry/recovery/receipt/linkage operations; supplied-sample backoff; slot/coalescing semantics; exact fault tags and lossless carriers. Keep Rust free of storage/network/time/RNG/provider/security I/O. Native harness consumes the same immutable fixtures as prepared TS. Include wide JS-compatible counts and finite fractional instants without fixed-width FFI truncation. Identity hashing stays host-owned unless its additional proof succeeds.
  - Preserved gate contract: Acceptance: native differential agreement for every accepted profile and specified invalid case; row version metadata, output order, opaque refs and payload materialization demand agree. Commands (proposed): `cargo test --locked --manifest-path packages/work-kernel/Cargo.toml`, `cargo fmt --manifest-path packages/work-kernel/Cargo.toml --check`, `cargo clippy --locked --manifest-path packages/work-kernel/Cargo.toml --all-targets -- -D warnings`; W02/W03 TS conformance. Inspect imports/features to prove no host authority capability entered the kernel. Native success alone is not Worker adoption.
#### Parallel lane: Baselines, conformance evidence and release decision

- [ ] **W03.4 — Verify closed-fact provenance and prepared-vs-legacy traces**
  - Start after: `W03.3`, `W03.2`, `W02.5`. Parent: `W03`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/prepared-ts.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/baselines/trace-parity.json`.
  - Action/done: Use actual D1/DO parser/controlled producer ownership; annotation, freezing, arbitrary StoragePort output or inspection never certify inertness.
  - Action/done: Prepared/unprepared outputs/errors/identity/clone and stop-on-error traces match across invalid fields/lifecycle/presence/proxies/sparse/aliased data; no load/query/invoke/commit capability enters facts.
- [ ] **W07.2 — Implement reproducible complete-call measurement runner**
  - Start after: `W01.4`, `W03.4`, `C05.ready`. Parent: `W07`.
  - Files: `packages/work-kernel/measurement/complete-calls.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/measurements/environment.json`.
  - Action/done: Define --backend ts|prepared-ts|wasm with identical payloads, evidence/RNG sequences and host storage workloads; record versions/hash/inventory/repetitions and machine-readable output.
  - Action/done: Integrate C05 local CPU harness, not Worker performance clock; later execution includes conversion/host demand/wall durable time, cold/warm/error distributions and memory/asset metrics.
- [ ] **W03 — Prepare closed batch facts and host references — completion gate**
  - Gate after: `W03.1`, `W03.2`, `W03.3`, `W03.4`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: ABI version/profile declarations, producer provenance, ordered row/write facts, conditional version metadata, call-local refs and disposal, TS demand extraction for eligible paths. Keep arbitrary-object public APIs on legacy evaluation shells; no ambient authority passed into Rust. Host trace fixtures include stop-on-error and repeated getter access. Supply finalized evidence facts only after the existing demand pass; document retained TS loops and conversion cost.
  - Preserved gate contract: Acceptance: prepared TS matches unprepared TS with multiple invalid fields, malformed lifecycle, null/missing/undefined, accessors/proxies, sparse arrays, repeated references, stale row versions and callback throws. Fact-only operations cannot load/query/invoke/commit; refs cannot outlive/cross calls. Commands: W02 conformance plus proposed `node --test packages/work-kernel/dist/conformance/traces.test.js`; work/state profile suites below. C03 signature tests reject ABI/version/profile mismatch before any semantic callback runs.

### Wave 5 — Package adapter and shared delivery verification

#### Parallel lane: Single package, ABI and production integration writer

- [ ] **W05.1 — Build pinned package-specific Wasm adapter and bootstrap**
  - Start after: `W04.4`, `W03.2`, `C04.ready`, `C04.graph`. Parent: `W05`.
  - Files: `packages/work-kernel/bindings/wasm.rs`, `packages/work-kernel/bindings/loader.ts`, `packages/work-kernel/src/backend.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/assets.json`, `packages/work-kernel/package.json`, `packages/work-kernel/Cargo.toml`, `packages/work-kernel/Cargo.lock`.
  - Action/done: Implement pinned build:wasm/glue toolchain against Cargo binding version; compile wasm32 target and use one synchronously callable initialized instance.
  - Action/done: Select TS/Rust before evaluating operations; selected Rust missing/corrupt/ABI/init errors fail visibly, no lazy call bootstrap or fallback rerun.

- [ ] **W05.2 — Submit package-specific vendor/build/release integration request**
  - Start after: `W05.1`. Parent: `W05`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/delivery-request.md`.
  - Action/done: Provide exact vendor/work-kernel entry, bare-import rewriting, binary asset/integrity and required dist-root manifest facts to C04 owner; do not edit bundle.ts, local-run.ts, testkit globals, root build or root lock.
  - Action/done: Done when exact generated asset hashes/import keys/shipping requirements and loader contract are accepted by the C04 owner; request publication is not final generated-binary delivery proof.

- [ ] **W05.4 — Verify fulfilled assets in outside-checkout install and release**
  - Start after: `W05.2`, `C04.work-assets`. Parent: `W05`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/installed-package.json`.
  - Action/done: Verify actual packaged installation outside checkout, 0.1.0 release:stamp and required dist/binary manifest coverage; test-loader exclusions remain intact.
  - Action/done: C04.work-assets fulfils W05.2 after shared graph and independent smoke readiness; verify the final generated kernel/glue, exact vendor/import map, required binary hashes and packaged release outside checkout. The tiny C04.ready smoke alone cannot certify these outputs.

- [ ] **W05 — Deliver and initialize the actual Wasm consumer — completion gate**
  - Gate after: `W05.1`, `W05.2`, `W05.3`, `W05.4`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: binding generation/pinning, typed binary manifest and vendor entry, independent package/root build order, platform bootstrap registration, testkit propagation, missing/corrupt/ABI mismatch reporting and explicit TS/Rust backend selection. Add a package `build:wasm` script that builds the pinned wasm32 target and generates glue with version matching Cargo; document tool installation separately. No raw JS text writer handles `.wasm` bytes.
  - Preserved gate contract: Acceptance: the **staged deployment module map** initializes the real kernel in local workerd and the state/runtime façades select it synchronously; compare bytes/hash before/after writing; no duplicate instance; loader failures follow the selected startup policy without executing an operation. Commands (proposed): `bun run --cwd packages/work-kernel build:wasm`, `cargo test --locked --manifest-path packages/work-kernel/Cargo.toml --features wasm-bindings`, and existing Cloudflare bundle/dev/testkit suites below. Exercise a binary with non-UTF-8 bytes, a missing module, corrupt bytes, wrong ABI and cold/warm bootstrap. C04 and W05 share evidence rather than each inventing a loader.
#### Parallel lane: Baselines, conformance evidence and release decision

- [ ] **W05.3 — Verify actual staged workerd binary and loader failures**
  - Start after: `W05.4`, `C04.ready`. Parent: `W05`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/delivery.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/loader-errors.json`.
  - Action/done: Run package build:wasm and cargo --features wasm-bindings plus owning C04 actual module-map workerd checks; use non-UTF8 bytes, compare written hashes, missing/corrupt/wrong ABI and cold/warm bootstrap.
  - Action/done: Prove one instance across bundled/vendor consumer paths and text-only legacy byte parity; installed package acceptance does not rely on source checkout imports.

### Wave 6 — Single-writer state/runtime join and validation handoff

#### Parallel lane: Single package, ABI and production integration writer

- [ ] **W06.1 — Join state staging and assertions to the selected pure kernel**
  - Start after: `W05.3`, `W02.5`, `W03.4`. Parent: `W06`.
  - Files: `packages/state/src/fanout/tables.ts`, `packages/state/src/fanout/outcome.ts`, `packages/state/src/ports/transact.ts`, `packages/state/src/receipt/tables.ts`.
  - Action/done: Retain original expectedVersion and host expectedRevision timing, reader-only stages, pending-versus-running outcome rules, loader-owned delivery membership and wrapper fault order.
  - Action/done: Linkage assertion stays before one store commit; raw admission hashing/replay/age/auth/normalization and current rejection-receipt behavior stay in owning host.
- [ ] **W06.2 — Join canonical Cloudflare runtime through existing producer seams**
  - Start after: `W06.1`. Parent: `W06`.
  - Files: `packages/cloudflare/src/runtime/invoke.ts`, `packages/cloudflare/src/runtime/work-kernel-pilot.test.ts`.
  - Action/done: Single integrator replaces only matching decode/outcome/staleness/decision mechanisms in real F7/recovery consumer; fresh guard/authority/evidence/reloads/claim and child-unit commits remain TS.
  - Action/done: Exercise actual bound binary with canonical source+intent/claim/record/progress/recovery/replay flow; membership cutoff does not grant authority and no terminal child is reinvoked.
- [ ] **W06.runtimehandoff — Release canonical runtime file to validation owner**
  - Start after: `W06.2`. Parent: `W06`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/runtime-source-map.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/handoffs/runtime-owner.json`.
  - Action/done: Record exact reviewed invoke.ts source hash, exports/producer seams and work consumer traces; no work lane writes runtime/invoke.ts after this handoff.
  - Action/done: Validation canonical runtime writer depends on W06.runtimehandoff in root global DAG; state pure validation can proceed earlier. Integrator resolves queued patches serially and refreshes downstream fixtures against final runtime source.

### Wave 7 — Actual D1/DO pilot and persisted/mixed-failure evidence

#### Parallel lane: Single package, ABI and production integration writer

- [ ] **W06.3 — Prove D1/DO race, crash and restart pilot with actual binary**
  - Start after: `W06.runtimehandoff`, `W05.3`, `V09.1`. Parent: `W06`.
  - Files: `packages/cloudflare/src/runtime/work-kernel-pilot-durable.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/pilot.json`.
  - Action/done: Run real staged Wasm inside workerd, retain file-backed persist dirs, dispose/kill and fresh boot; Node Wasm plus RPC store proxy alone is insufficient.
  - Action/done: Exactly one winner per existing claim/child commit unit, atomic terminal outcome/checkpoint with domain/history/replay/outbox/schedule, fresh siblings/revocation and refusal/error/caller retry behavior.
  - Action/done: Uncertainty/not-found-to-delivered action-time evidence races and held/awaiting progress remain unresolved until real evidence; exceptions commit nothing except explicitly owned canonical rejected receipt path.
  - Action/done: Run against final canonical runtime source after validation V09.1 completes its last runtime/invoke.ts write; this coordinated source-stability dependency is not a requirement for work pure modules or the early package foundation.
- [ ] **W06 — Pilot state staging through actual Cloudflare durable paths — completion gate**
  - Gate after: `W06.1`, `W06.2`, `W06.runtimehandoff`, `W06.3`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: feature-selectable kernel backend in F5 producers and runtime matching mechanisms; proposed `work-kernel-pilot{,-durable}.test.ts`. Pilot complete flow: emitted cohort trigger/source+intent freeze; pending child claim; terminal replay/running hold/stale refusal; current guard and authority; record transient and terminal outcomes; checkpoint staging with the child's domain/history/replay/outbox/schedule effects; held/awaiting progress; stale-claim release/recovery; restart and resumed drive. Include ordinary `runRecoverySweep` evidence-change races through its real planner/join seams.
  - Preserved gate contract: Acceptance: exactly one winner across D1/DO handles; one atomic commit **per existing commit unit** (claim and child execution are separate existing units); no outcome/checkpoint split; no extra commit or authority reorder; expected version/revision failure produces existing results/errors and caller retries; membership frozen at cutoff conveys no authorization; post-restart revocation denies only the affected child. Body or callback exceptions commit nothing unless the existing canonical rejected-receipt path explicitly handles that error. Test provider uncertainty/not-found-to-delivered evidence change and wait/progress without completing or reinvoking a terminal child. Run the actual staged Wasm inside the workerd consumer; host-native Wasm plus an RPC-only store proxy is a useful additional test, not enough by itself.
  - Preserved gate contract: Commands: baseline work/state/Cloudflare durable suites below; proposed `node --test packages/cloudflare/dist/runtime/work-kernel-pilot.test.js packages/cloudflare/dist/runtime/work-kernel-pilot-durable.test.js` after a successful build. Existing F7 durable harness uses file-backed persist dirs, dispose/kill and fresh boot, which must be retained. Add a binary consumer in the Worker harness rather than only injecting a Rust result into the Node-side driver.
#### Parallel lane: Baselines, conformance evidence and release decision

- [ ] **W07.1 — Verify persisted bytes, backend swaps and mixed-failure precedence**
  - Start after: `W06.3`, `W03.4`, `C05.ready`. Parent: `W07`.
  - Files: `packages/work-kernel/conformance/persisted.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/bytes.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/durable/error-order.json`.
  - Action/done: Three backends match records.data/metadata/receipt raw hash/default/outcome/outbox/schedule/checkpoint bytes; restart TS persistence under Rust and Rust persistence under TS.
  - Action/done: Test malformed linkage+stale version, valid linkage+stale version+cyclic clone-only state data, then current versions+cyclic data; join→revision/version→serialization error precedence and zero writes match.

### Wave 8 — Final complete-call and resource gates

#### Parallel lane: Baselines, conformance evidence and release decision

- [ ] **W07.3 — Run final parity, resource and complete-flow measurements**
  - Start after: `W07.1`, `W07.2`, `W06.3`, `C05.ready`. Parent: `W07`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/measurements/results.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/measurements/resources.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/final/verify.log`.
  - Action/done: Run existing suites plus W04–W06/proposed conformance and measurement commands against successfully built final sources; no stale-dist passing claims.
  - Action/done: Report cold/warm/conversion/host demand/full turn/child/recovery, variability, peak/live/linear memory, disposal and bounded batch/cache limits, raw/compressed assets and precommitted budget pass/fail; zero unexplained parity differences.
- [ ] **W07 — Differential, persisted-byte and resource gates — completion gate**
  - Gate after: `W07.1`, `W07.2`, `W07.3`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: three-backend comparison (current TS snapshot, consolidated/prepared TS, actual Wasm); persisted-byte corpus; ordered host traces; complete-call/resource measurements. Inputs come from real trace distributions, with tiny, bounded page, 501-member/chunked, duplicate/error-heavy and restart/recovery cases. Capture Node/Bun/Rust/workerd versions, target/profile, binary hash, module inventory, iteration/repetition method and environment.
  - Preserved gate contract: Acceptance: no behavior/byte/trace mismatch at the declared scope; resource and latency budgets set in W01 pass; report binding conversion/allocation, initialization, warm compute, host demand work, complete turn/child-unit/recovery latency, heap/linear memory peak, ref disposal, bounded batch/plan caches, binary/compressed bundle size and platform startup separately. Worker's performance clock does not measure synchronous CPU progress reliably; use the C05 local CPU harness and separate wall-time durable runs. Report distributions and variability, not invented scores or a timing from a single helper. Commands: W04–W06 gates and proposed `bun packages/work-kernel/measurement/complete-calls.ts --backend ts`, `--backend prepared-ts`, `--backend wasm`; define these options and machine-readable output in W07. Maintain identical payloads/evidence/random sequences and host storage workloads across comparisons.

### Wave 9 — Adoption, packaged rollback and source ledger

#### Parallel lane: Single package, ABI and production integration writer

- [ ] **W08.2 — Rehearse release selection, disposal and rollback**
  - Start after: `W08.1`, `W05.3`. Parent: `W08`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/rollback.json`.
  - Action/done: Begin disabled/TS default, then reproducible pinned opt-in; no source runtime edit after handoff and no semantic retry after trap/integrity/error.
  - Action/done: Exercise backend swap on same persisted rows/receipts, clean instance reload/disposed refs, real packaged binary and release verification without deployment/activation; no schema/digest migration.
#### Parallel lane: Baselines, conformance evidence and release decision

- [ ] **W08.1 — Make explicit native-reuse or prepared-TS benefit decision**
  - Start after: `W07`. Parent: `W08`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/adoption.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/release/coverage.json`.
  - Action/done: Use reviewed root JEV disagreement advice plus source/runtime evidence; enable Rust only for concrete reuse or material complete-call improvement over prepared TS that justifies release cost.
  - Action/done: Record supported/retained unknown-object/callback/demand loops/host hashing/deferred scheduler coverage and ownership; retain TS is a completed evaluation outcome.
- [ ] **W08.3 — Close source checks and implementation completion ledger**
  - Start after: `W08.2`, `W08.1`. Parent: `W08`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/final/source-checks.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/final/completion.md`.
  - Action/done: Report refreshed source map, exact commands/results/baseline failures, real installed/durable scope and retained paths; no isolated-native or memory-only completion claim.
  - Action/done: Each eventual merge handler reconciles living file-tree coverage/decisions against all changes since checkpoint; planning itself performs no merge/checkpoint update.
- [ ] **W08 — Decide adoption, rollout and rollback — completion gate**
  - Gate after: `W08.1`, `W08.2`, `W08.3`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved deliverables: explicit decision record with remaining legacy paths, achieved parity scope, retained TS demand loops, budgets/evidence and benefit. Choose Rust only for a demonstrated real reuse need or useful complete-call improvement over **prepared TS** that justifies the new release/toolchain surface. Retain prepared TS if it meets the same outcomes better; that is a completed evaluation, not a failed task.
  - Preserved gate contract: Acceptance: deploy/release selection is reproducible and version pinned; begin disabled/TS default, then controlled opt-in, with semantic differences blocking promotion. Shadow comparison must consume frozen closed facts and never duplicate getters, RNG, guards, grants, evidence or providers. Rollback selects TS at build/startup and reloads cleanly; it never reruns an already executed semantic call or reverses committed storage. Read existing persisted rows/receipts before and after backend swaps; no persisted schema/digest migration is part of this tranche. If byte format changes become necessary, stop parity adoption and create a separately versioned migration/rollback contract. Record whether transitional Rust/TS dual maintenance remains, who owns it and when it can end. After an eventual merge, the merger reconciles `docs/ideal-filetree-plan.md` across all changes since its checkpoint; this planning document does not advance that checkpoint.

### Wave 10 — Optional scheduler contract and prototype

#### Parallel lane: Optional separate scheduler project

- [ ] **W09.1 — Specify separate request/resume scheduler contract and consultation** (optional separate project)
  - Start after: `W08`. Parent: `W09`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/scheduler/contract.md`.
  - Action/done: Separately authorized project only: load/query/checkpoint/snapshot/guard/authority/invoke/final batch requests, exact demand/order, cancellation/disposal, host exceptions/refusals, versions/revisions and caller-owned retries.
  - Action/done: Get own verified-context three-equivalent JEV review; Rust may request I/O but host owns authority and one final commit submission.
- [ ] **W09.2 — Prototype scheduler only against a real continuation consumer** (optional separate project)
  - Start after: `W09.1`. Parent: `W09`.
  - Files: `packages/work-kernel/continuations/`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/scheduler/prototype.json`.
  - Action/done: Require a real generated fanout/wait continuation consumer, complete runtime traces/restart proof and bounded retained-state/reuse benefit beyond W08; memory-only proof is insufficient.
  - Action/done: No-go for reordered/eager auth/callbacks, stale checkpoints, hidden commit/retry loops, broken sync API, unbounded memory or unjustified protocol cost.

### Wave 11 — Optional scheduler project decision

#### Parallel lane: Optional separate scheduler project

- [ ] **W09.3 — Record separate scheduler go/no-go and rollout requirements** (optional separate project)
  - Start after: `W09.2`. Parent: `W09`.
  - Files: `docs/research/package-subsystem-ports-20261006/evidence/implementation/work-transitions/scheduler/decision.md`.
  - Action/done: Own tests/budgets/rollout decision required; do not promote data-only ABI into scheduler silently. W01–W08 completion excludes this optional project.
- [ ] **W09 — Deferred request/resume scheduler contract, separate go/no-go — completion gate** (optional separate project)
  - Gate after: `W09.1`, `W09.2`, `W09.3`; all children must pass.
  - Files: no shared source writes; close the owning evidence ledger.
  - Action/done: All child tasks completed with their exact source, commands/results and pass/retain-TS evidence.
  - Action/done: Parent gate retains the detailed deliverable/acceptance contract below; no incomplete supported-domain migration or test-only consumer claim.
  - Preserved gate contract: Preserved optional-project contract: Before implementation, specify request types (`load`, `query`, `checkpoint`, `snapshot`, `guard`, `authority`, `invoke`, final conditional batch), exact order/demand, resumable state, cancellation/disposal, host exceptions/refusals, version/revision freshness, no stale authority reuse, one final commit submission, trap behavior and caller-controlled retries. Rust may request I/O but cannot perform it or decide security authority; the host owns authorization and commits.
  - Preserved gate contract: Go only if a prototype preserves complete runtime traces and restart boundaries and demonstrates a meaningful retained-state/reuse/resource benefit beyond W08's staged data-only calls. No-go if requests reorder authorization, eagerly demand callbacks, retain stale checkpoints, add hidden commit/retry loops, break synchronous APIs, enlarge memory without bounded disposal or fail to justify protocol complexity. Require a real generated fanout/wait continuation consumer, not memory-store-only proof. Contract and prototype have their own JEV review, tests, budgets and rollout decision; do not silently promote the initial ABI into a whole scheduler migration.

## Required behavior and trace vectors

| Vector family | Minimum differential/recovery evidence |
| --- | --- |
| Row shape/error order | All eight work tables; multiple malformed fields; closed state/cause rules; id derivations/escaped components/lone surrogates; memberCount; duplicate set entries; empty nullable strings; absent result default; row metadata preservation; current clone/safety profile errors and getter traces. |
| Retry/time | Fractional accepted times; exact stale/horizon/availability boundaries and values just before/after; attempt zero/cap/large Number integer; transient vs terminal/unclassified; pending pins vs executed outcomes; first-attempt created/claimed anchors across restart; random zero/one demand, negative/above-one/nonfinite samples and throw. |
| Recovery/order | Input `z,a` evidence access with sorted `a,z` output; duplicate claims last wins; uncertain-only calls; exception stops later evidence; evidence changes between plan/act; fresh running hold; stale resume/dead; deletion vs unknown/moved; phantoms, missing admits/checkpoint gaps; honest cursors/no truncation/starvation. |
| Receipt/observation | Succeeded nullable/opaque result identity; failed closed error, unknown diagnostic/null, skipped nulls; omitted vs null; malformed/additive error keys/getters/proxy throws; terminal receipts immutable through later progress/cancel/re-drive; related id/revision/relation mismatch; full/selected grant traces, withholding, content expiry demand and no unauthorized presence disclosure. |
| Linkage/commit | Duplicate/missing halves, guard-false row-only insert, updates-only pass; forged initial terminal child/checkpoint; wrong row derivation; forbidden removal/update of intent; terminal coverage; cursor-only plain path; unrelated writes; observed versions/revisions; fence conflicts and error profiles; no partial domain/history/receipt/outbox/schedule/outcome/checkpoint commit. Combined failures: malformed linkage plus stale version; valid linkage plus stale versions and cyclic state-cloned data; valid current versions plus cyclic data. Join assertions precede storage, then D1/DO revision/version checks precede host serialization; preserve first error and zero writes. State clone-only admits cycles/aliases that work safety checks reject, so do not eagerly serialize all facts. |
| Host permission/order | Uncommitted/superseded/settled refuses without later callbacks; inherited checkpoint refuses before guard; false guard avoids authority; live revocation after guard; fresh membership between siblings and successful/rejected commit paths; getter/callback exception retains original error; no Rust authority decision. |
| Durable bytes/restart | Save actual `records.data`, row identity/version/metadata, receipts' raw-input hash/resolved-default/outcome bytes, outbox arguments/schedules and checkpoint cursor/set bytes. Restart from current TS persistence under Rust and Rust persistence under TS, including 501-member freeze, mid-claim crash, terminal replay, incomplete admission and exhaustion anchors. Host persistence remains byte-authoritative. |
| Loader/resources | Actual staged Wasm through workerd; missing/corrupt/wrong version; one instance and sync façade; cold/warm/conversion; failed calls and disposed refs; bounded memory under repeated recovery; no per-leaf FFI loop assumed faster. |

Use existing inline examples and preserved probe observations as seed vectors, not comprehensive proof. [The work/artifact probe](../evidence/full-evaluation/work-artifact-probe.result.json) observed fractional clocks, random demand, evidence order, duplicate-claim replacement, result identity and surrogate/exponent recurrence bytes. Extend it with the absent traces and durable binary consumer above.

## Concrete existing verification commands

```sh
bun run --cwd packages/work typecheck
node --test packages/work/test/every.test.ts packages/work/test/receipt.test.ts packages/work/test/recovery.test.ts packages/work/test/kernel-tables.test.ts packages/work/test/kernel-commands.test.ts
node --test packages/work/src/kernel/t34-f2-tables.test.ts packages/work/src/dispatch/t34-f3-claim.test.ts packages/work/src/dispatch/t34-f3-record.test.ts packages/work/src/dispatch/t34-f3-progress.test.ts packages/work/src/recovery/t34-f4-scan.test.ts packages/work/src/recovery/t26-resume.test.ts
node --test packages/work/test/observation.test.ts packages/work/test/observation-association.test.ts packages/work/src/receipt/t25a-consistency.test.ts packages/work/src/observation/t25a-selected.test.ts packages/work/src/observation/t26-progress.test.ts
bun run --cwd packages/state build
bun run --cwd packages/state typecheck
node --test packages/state/dist/state/src/fanout/t34-f5-membership.test.js packages/state/dist/state/src/fanout/t34-f5-child-join.test.js packages/state/dist/state/src/fanout/t34-f5-lifecycle.test.js packages/state/dist/state/src/fanout/t34-f5-admission.test.js packages/state/dist/state/src/fanout/t34-f5-progress.test.js packages/state/dist/state/src/fanout/t34-f5-durable.test.js
node --test packages/state/dist/state/test/ports/system.test.js packages/state/dist/state/test/ports/transact.test.js packages/state/dist/state/test/ports/t24a-dispatch-join.test.js packages/state/dist/state/test/ports/t24a-dispatch-join-durable.test.js packages/state/dist/state/src/receipt/t25-receipt-join.test.js packages/state/dist/state/src/receipt/t25-receipt-durable.test.js packages/state/dist/state/src/receipt/b3-delivery-schema.test.js
bun run build
bun run --cwd packages/cloudflare typecheck
node --test packages/cloudflare/dist/runtime/t24b-dispatch-execution.test.js packages/cloudflare/dist/runtime/t24b-dispatch-durable.test.js packages/cloudflare/dist/runtime/t34-f7-fanout.test.js packages/cloudflare/dist/runtime/t34-f7-fanout-durable.test.js packages/cloudflare/dist/runtime/t34-f7-emitted-cohorts.test.js packages/cloudflare/dist/runtime/t32b-cloudflare.test.js packages/cloudflare/dist/runtime/t32b-cloudflare-durable.test.js
node --test packages/work/src/kernel/t34-f2-durable.test.ts packages/work/src/recovery/t34-f4-durable.test.ts packages/work/src/recovery/t26-durable.test.ts
./node_modules/.bin/vitest run packages/cloudflare/test/deploy-bundle.test.ts packages/cloudflare/test/dev-smoke.test.ts packages/cloudflare/test/worker-boundary.test.ts packages/cloudflare/test/release.test.ts
bun docs/research/package-subsystem-ports-20261006/evidence/full-evaluation/work-artifact-probe.mjs
```

Add exact C04 testkit binary test paths after that shared tranche declares them; the existing root Vitest include list does not execute Cloudflare `src/runtime` node:test suites. Do not count a default `vitest run` as the durable gate. W05 must verify the selected package's dist/binary manifest via the existing release tooling in an isolated build output, with no deployment/activation required for this plan or conformance work.

## Decisions and completion limits

The root saved three independently worded JEV consultations under [implementation-plan evidence](../evidence/implementation-plans/), with [request 1](../evidence/implementation-plans/request-1.json), [result 1](../evidence/implementation-plans/result-1.json), [result 2](../evidence/implementation-plans/result-2.json) and [result 3](../evidence/implementation-plans/result-3.json). Each favored the responsibility leaf and explicit backend selection before execution. The credible subpath alternative mainly reduces package count; it does not avoid new builds/vendors/releases and needs stricter graph proof. That comparison explains the choice; advisory probabilities do not establish byte parity, authorization correctness or speed. The root's shared README retains advice/uncertainty. A later request/resume scheduler still needs its own verified-context consultation, protocol proof and adoption decision.

The planning pass inspected the listed source, package scripts, loader/build/vendor paths and tests; it changed no production code, ran no port/durable suite or benchmark and made no adoption claim. Initial implementation is complete only when W01–W08 have a recorded pass/retain-TS decision, real installed consumer evidence, exact parity scope and operational rollback. Legacy arbitrary-object shells, host orchestration, receipt canonical hashing, optional recurrence hash translation and request/resume scheduling remain explicitly owned/gated wherever they were not migrated. Successful isolated Rust unit tests or test-only memory claims cannot close those gaps.
