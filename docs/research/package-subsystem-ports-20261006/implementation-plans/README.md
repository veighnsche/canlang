# Four package port implementation plans

These four plans turn the package migration evaluation into tasks an implementer can execute and verify. They use source checkpoint `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5`, inspected on October 6, 2026. Scope remains existing functionality under `packages/`; the compiler stays unchanged and folders describe responsibilities. This planning round creates documentation and evidence, not production Rust code.

| Plan | Migrated responsibility | Main boundary and completion limit |
| --- | --- | --- |
| [Exact values](exact-values.md) | Exact representations, arithmetic, temporal math, numeric aggregates and scalar codecs | Shared values semantics core plus host façades. Arbitrary host-object/iterator paths remain TS until their observable behavior is proved. |
| [Input validation](input-validation.md) | Prepared type plans, whole-input checks, normalization, refs and encoding for parser-owned input | Same values crate, separate traversal/profile owner. Does not certify replacement of the full arbitrary-`unknown` legacy API. |
| [Work transitions](work-transitions.md) | Shared rows, schedule/retry/recovery decisions, receipt projection and conditional-batch linkage | A work-owned `work-kernel` leaf package, with live host evidence and fenced commits retained. Full scheduler orchestration is separately gated. |
| [Artifact preparation](artifact-preparation.md) | Artifact/release/compatibility/module graph/plan/render/review preparation | One retained native job and coarse ordered host stages. Bun, catalog producers, activation, publication and Wrangler remain with existing owners. |

The four checklists contain 205 work items and gates, plus 25 shared items: 220 required and 10 conditional/deferred items in total. All boxes remain unchecked. Each has explicit dependencies, file ownership and acceptance; the [combined execution manifest](execution-manifest.json) also checks the required-scope and accepted-branch dispatch profiles.

Arithmetic and validation are separate task lanes in one shared core. They must not create separate decimal, money, type or wire authorities. Four plans do not imply four new general-purpose engines. The previous [ratings and scope comparison](../boundary-options.md) remain estimates; these plans do not raise scores without implementation evidence.

The initial inspection and architectural consultations used checkpoint `30e211dae891cfdca3f6322ce45c46c426138830`. A concurrent commit added loader-derived delivery-field membership in state and updated receipt tests. The five changed files were reviewed before delivery; the plans now include that owning metadata channel and its tests at the checkpoint above. This source refresh leaves the selected boundaries unchanged. The agent writing these plans performed no source merge or production edit. During checklist conversion, HEAD advanced to `3571077c2397ec37071536f0f41b8fe0473a4716`; the intervening changes affect only two compiler test files. Package sources remain unchanged from the stated package checkpoint.

## Decisions that make the plans executable

Use arbitrary-precision raw/scratch arithmetic first, preserving accepted BigInt operands. Preserve existing structural carriers and synchronous JS exports. Register immutable owner-produced plans once; keep legacy unknown objects on their observable TS evaluation path. An owned parser token is established by the actual parser seam, not a caller's annotation, freeze or object inspection.

Create a responsibility-based `packages/work-kernel/` leaf for matching work/state mechanisms. It depends only on contracts; work/state/Cloudflare use that explicit entry. The current full work package has no emitted build and contains state-dependent commands, while state intentionally mirrors its tables today. The new leaf adds build/vendor/release work but avoids a hidden state-to-full-work cycle. Separate error and cloning policies remain explicit.

Select a backend before evaluating operations. TS mode is an explicit supported rollout/rollback configuration. Selected Rust mode must pass bootstrap, asset integrity and ABI checks; it fails visibly if those fail. Do not retry failed semantic work in TS. Route declared unsupported legacy input profiles to TS before evaluation, preserving existing reads and errors. Keep a single selection throughout a request/job.

Worker kernels use precompiled Wasm with initialization at module/host startup, followed by synchronous calls. [Cloudflare's Wasm integration](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/) supplies the precompiled-module route; [wasm-bindgen's synchronous initialization example](https://wasm-bindgen.github.io/wasm-bindgen/examples/synchronous-instantiation.html) supplies an adapter option. Neither proves this repository's actual glue/import path. Node, Bun, package imports, local workerd and packaged outputs must be tested before switching callers. Native conformance runners do not require a second Node addon release.

HTTP JSON supplies an existing source handler for owned input, but the current deployed operation route returns 501. A custom Worker fixture proves that handler/binding, not default deployed adoption. Validation's adoption gate requires a bounded owning route join or verified MCP parser provenance. Do not finish a new unrelated HTTP server or declare the gap solved by a fixture. State admission retains raw hash and receipt replay before age, authorization and normalization; no prepared-plan allocation/error may invalidate a successful replay.

Artifact preparation uses one native process session with demand-driven coarse host stages. Eagerly reading the prior plan or building before the current refusal point changes behavior. Native state persists across build/activation/review requests; the host publishes exact prepared bytes and invokes existing apply policy. Preview may use private temporary files but publishes no deployment files. This is independent of the Wasm delivery task.

## Shared preparation tasks

The five common responsibilities are decomposed below into nested lane checklists. `C01.ready`–`C05.ready` release useful prerequisites; `Cxx.complete` aggregate subsystem outcomes afterward. A task never waits for its own final result. Every checkbox is initially unchecked and has the same canonical ID in [shared.tasks.json](shared.tasks.json). Current planning evidence stays separate from the proposed execution evidence under `evidence/implementation/<plan>/`.

| Shared lane | Exclusive responsibility |
| --- | --- |
| `C-contract` | Source and prepared-boundary contracts |
| `C-abi` | Protocol vectors and binding spike |
| `C-delivery` | Exclusive global manifests, bundle and release integrator |
| `C-evidence` | Conformance, loader and workload evidence |
| `C-coordination` | Dispatch, ownership and completion review |

The delivery owner alone edits root/consumer manifests, `bundle.ts`, local-run/testkit propagation and Cloudflare release stamp/manifest assembly. Actual values/work generated assets get separate fulfilment gates after the early smoke; they cannot claim distribution proof from a tiny fixture. Package-local core/binding/native manifests remain with their named subsystem integrators. A/V shared binding writes and W/V runtime writes use directed handoffs in the plans. The delivery lane serializes its ready tasks, even when the DAG permits independent readiness.

### Shared readiness group 0

- **Lane `C-contract` — Source and prepared-boundary contracts**
  - [ ] **C01.1 — Recheck source checkpoint, scope and live owners** (implementation; after none).
    - Do: Compare current sources with the planning checkpoint; record caller/export/platform inventory template and untouched compiler/producer boundaries. Reconcile proposed responsibility layout with the living filetree before implementation, without implementing or advancing a checkpoint during planning.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/scope.json`.
    - Done when: Existing packages-only functionality, source changes, baseline failures and coverage limits have owners; scope remains revisable with evidence.

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C01.2 — Assign exclusive resources and dispatch capacity** (implementation; after `C01.1`).
    - Do: Assign a single writer per logical lane and shared integration file; publish A/V binding and W/V runtime handoffs. Choose three implementation workers plus one coordinator by default; maintain ready and blocked queues.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/ownership.json`.
    - Done when: No two active tasks write one shared file/lane; workers consume ready backlog and blockers name an owner and exit condition.

### Shared readiness group 1

- **Lane `C-contract` — Source and prepared-boundary contracts**
  - [ ] **C02.1 — Publish prepared-boundary and observable-trace method** (implementation; after `C01.ready`).
    - Do: Agree current versus prepared TS comparisons, fixture attribution and extraction review rules. Preserve different error/presence/clone/auth/evaluation policies; do not rewrite exact arithmetic merely for a baseline.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/prepared-baseline-contract.json`.
    - Done when: Each plan can extract independently; matching source traces and full consumer evidence are explicit acceptance, not assumed from common scaffolding.

- **Lane `C-abi` — Protocol vectors and binding spike**
  - [ ] **C03.1 — Freeze minimal versioned transport and profile handoffs** (implementation; after `C01.ready`).
    - Do: Freeze explicit presence, f64/raw BigInt, UTF-16 key/string order, result/error envelopes, corruption and lifetime rules. Keep values/work/native payloads separately owned; no generic universal serializer/validator.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/transport-contracts.json`.
    - Done when: Minimal smoke contracts and pinning/toolchain choices are executable; scalar semantics remain values-owned, catalogs/declarations producer-owned.

- **Lane `C-evidence` — Conformance, loader and workload evidence**
  - [ ] **C05.1 — Publish observer schema, workloads and budget procedure** (implementation; after `C01.ready`).
    - Do: Create deterministic current-TS observers, raw-output/environment/resource schema and oracle/seed rules. Freeze selection and budget procedure before viewing Rust comparisons; measure current/prepared TS and complete consumers.
    - Writes: `packages/testkit/conformance/ports/observations.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/workloads.json`.
    - Done when: Early actual TS observations are executable; getters/callbacks and side-effectful calls are never shadow-run twice; provisional speed cutoffs remain explicitly ratified/replaced before comparisons.

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C01.ready — Common scope and ownership ready** (gate; after `C01.1`, `C01.2`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C01.ready.json`.
    - Done when: Package inventories can proceed; this is the common readiness gate, not completion of A01/V01/W01/P01.

### Shared readiness group 2

- **Lane `C-abi` — Protocol vectors and binding spike**
  - [ ] **C03.2 — Build encoder/decoder vectors and pinning spike** (implementation; after `C03.1`).
    - Do: Test scalar/text/presence/version/length vectors and native/binding build choices against actual installed APIs and licenses/support. Timebox the minimal proof, recording a reproducible chosen route or bounded alternative.
    - Writes: `packages/testkit/conformance/ports/transport-vectors.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/pins.json`.
    - Done when: Bad versions/lengths are rejected; no latest-version example is accepted without actual build evidence; common proof does not require full semantic modules.

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C02.ready — Prepared-boundary method ready** (gate; after `C02.1`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C02.ready.json`.
    - Done when: A02/V02/W02/P02 contribute their own prepared evidence later.
  - [ ] **C05.ready — Common conformance and measurement harness ready** (gate; after `C05.1`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C05.ready.json`.
    - Done when: Subsystem observers add real adapter/distribution cases later; unit/native timings do not certify adoption.

### Shared readiness group 3

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C03.ready — Minimal ABI and pinning contracts ready** (gate; after `C03.2`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C03.ready.json`.
    - Done when: Subsystem native foundations may begin; full binding/protocol conformance joins C03.complete.

### Shared readiness group 4

- **Lane `C-abi` — Protocol vectors and binding spike**
  - [ ] **C04.1 — Build tiny actual binding and smoke fixture** (implementation; after `C03.ready`).
    - Do: Build one pinned precompiled binding, synchronous startup/call and failure vector. Keep this fixture independent of work package graph and all arithmetic/validation implementations.
    - Writes: `packages/testkit/conformance/ports/loader-smoke/Cargo.toml`, `packages/testkit/conformance/ports/loader-smoke/Cargo.lock`, `packages/testkit/conformance/ports/loader-smoke/src/lib.rs`, `packages/testkit/conformance/ports/loader-smoke/host.mjs`.
    - Done when: Native/Node/Bun glue startup and synchronous entry actually execute; missing/corrupt/wrong-ABI module fails, no semantic fallback.

- **Lane `C-delivery` — Exclusive global manifests, bundle and release integrator**
  - [ ] **C04.asset — Land typed text/binary asset contract and host plumbing** (implementation; after `C03.ready`).
    - Do: Implement the agreed typed inventory, safe byte writing/propagation and pinned installed module type mapping; leave source rewriting/maps on text. Keep v1 text-only output byte-identical and version mixed digests/manifests.
    - Writes: `packages/contracts/src/deployment-assets.ts`, `packages/contracts/src/index.ts`, `packages/cloudflare/src/deploy/bundle.ts`, `packages/cloudflare/src/dev/local-run.ts`, `packages/testkit/src/scopes/local.ts`.
    - Done when: Binary lengths/hashes are exact; CompiledWasm is verified against the installed API; text-only hash/order/serialization fixtures pass.

### Shared readiness group 5

- **Lane `C-delivery` — Exclusive global manifests, bundle and release integrator**
  - [ ] **C04.graph — Land root and consumer dependency/build graph** (implementation; after `W02.foundation`, `C04.asset`).
    - Do: Use the minimal emitted work-kernel contract to install acyclic runtime dependencies, explicit build order, exports and release commands. Apply other agreed common build hooks; package-local values/work/native manifests retain their designated owners.
    - Writes: `package.json`, `bun.lock`, `packages/cloudflare/package.json`, `packages/state/package.json`, `packages/stdlib/package.json`, `packages/testkit/package.json`.
    - Done when: Root/consumer build and lockfile graph is executable, no state→full-work cycle, and no compiler Cargo workspace is introduced. This gate does not certify final work assets.

- **Lane `C-evidence` — Conformance, loader and workload evidence**
  - [ ] **C04.2 — Prove actual local workerd and deployment-map loader** (implementation; after `C04.asset`, `C04.1`).
    - Do: Run the real generated tiny binding through this repository built deployment map and local workerd/testkit propagation; record exact asset/import/bootstrap path.
    - Writes: `packages/testkit/conformance/ports/loader-smoke/workerd.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/loader-smoke.json`.
    - Done when: No fake Wasm replies/text markers; one initialized instance, malformed bytes/startup failures and text-only legacy parity pass.

### Shared readiness group 6

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C04.ready — Tiny actual loader and typed asset proof ready** (gate; after `C04.2`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C04.ready.json`.
    - Done when: Runtime plans may verify their own generated bindings next. This gate does not certify actual values/work assets, final vendor maps or installed consumers. Native JS-only preparation is independent of this Wasm proof.

### Shared readiness group 7

- **Lane `C-delivery` — Exclusive global manifests, bundle and release integrator**
  - [ ] **C04.values-assets — Fulfil actual values binding and vendor inventory** (implementation; after `A07.foundation`, `C04.graph`, `C04.ready`).
    - Do: Integrate actual generated values glue/binary imports, vendor entry, shipped dist roots and release inventory using the frozen asset paths. Full arithmetic/validation rebuilds must continue to use those paths and validate final bytes in their own gates.
    - Writes: `packages/cloudflare/src/deploy/bundle.ts`, `packages/cloudflare/src/release/stamp.ts`, `packages/cloudflare/src/release/manifest.ts`.
    - Done when: Values consumers use actual shipped assets, not the smoke fixture; native binary is excluded from Worker maps; missing/corrupt/version errors fail visibly.
  - [ ] **C04.work-assets — Fulfil work generated asset and package request** (implementation; after `W05.2`, `C04.graph`, `C04.ready`).
    - Do: Apply W05.2 exact vendor/bare-import/binary/integrity/dist-root request, using real W05.1 outputs and the owning release stamp. Return reviewed source/asset hashes and completed integration evidence to work verification.
    - Writes: `packages/cloudflare/src/deploy/bundle.ts`, `packages/cloudflare/src/dev/local-run.ts`, `packages/testkit/src/scopes/local.ts`, `packages/cloudflare/src/release/stamp.ts`, `packages/cloudflare/src/release/manifest.ts`.
    - Done when: Actual work binary and package are in built runtime/deploy/testkit inventory; W05.4/W05.3 certify installed package and workerd afterward.
  - [ ] **C04.preparation-join — Land native bundle-helper integration** (implementation; after `P05.2`, `C04.asset`).
    - Do: Apply the exact P05.2 coarse stage/export request around the typed asset contract. Keep Bun and catalog derivation with their existing producer; preserve worker-missing fallback and all failure order.
    - Writes: `packages/cloudflare/src/deploy/bundle.ts`.
    - Done when: P05 host/native lanes receive reviewed exports/source hash; no duplicated catalog or arbitrary asset format; initial JS-only native consumer does not wait for C04.ready.
  - [ ] **C04.native-release — Land native command, stamp and dist inventory** (implementation; after `P09.1`, `C04.graph`).
    - Do: Integrate native package-local build/package scripts and executable manifest into current Cloudflare build/release/publication. Keep platform binaries outside Worker vendor maps.
    - Writes: `packages/cloudflare/package.json`, `packages/cloudflare/src/release/stamp.ts`, `packages/cloudflare/src/release/manifest.ts`.
    - Done when: Native supported-host binaries/notices/dist metadata ship through owning manifest; P09.2 must prove actual installed launch, no user compiler.

### Shared readiness group 8

- **Lane `C-delivery` — Exclusive global manifests, bundle and release integrator**
  - [ ] **C04.validation-join — Fulfil accepted validation route or record declined join** (implementation; after `V08.3`, `C04.values-assets`).
    - Do: Read the owning HTTP adoption decision. If accepted, wait for V08.4 and integrate its actual assembled entry/module propagation; if declined, record an evidenced no-op and the default 501 gap.
    - Conditional order: accepted HTTP join additionally requires `V08.4`; a recorded decline completes the no-op branch.
    - Writes: `packages/cloudflare/src/deploy/bundle.ts`, `packages/cloudflare/src/dev/local-run.ts`, `packages/testkit/src/scopes/local.ts`.
    - Done when: Accepted delivery integration completes after V08.4 and its own module checks; subsequent V08.5 proves deployment, required by V08.6 before accepted outcome completion. A declined branch changes no route and never certifies deployed adoption.

### Shared readiness group 9

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C01.complete — All caller inventories and scope records reviewed** (gate; after `C01.ready`, `A01`, `V01`, `W01`, `P01`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C01.complete.json`.
    - Done when: Every migrated path has an owner, admitted-input contract, real consumer and explicit retained/deferred scope.

### Shared readiness group 10

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C02.complete — All matching prepared TS boundaries reviewed** (gate; after `C02.ready`, `A02`, `V02`, `W02`, `P02`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C02.complete.json`.
    - Done when: Zero unexplained prepared/current TS observable differences; extraction never collapses differing policies.

### Shared readiness group 11

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C03.complete — All actual binding and protocol contracts reviewed** (gate; after `C03.ready`, `A07`, `V03`, `W03`, `P03`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C03.complete.json`.
    - Done when: Version, presence, lifetime, corruption and binding/native negative evidence is complete for each selected profile.

### Shared readiness group 16

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C04.complete — All declared distribution and consumer assets reviewed** (gate; after `C04.ready`, `C04.graph`, `C04.values-assets`, `C04.work-assets`, `C04.preparation-join`, `C04.native-release`, `C04.validation-join`, `A08`, `V11`, `W05`, `P09`, `P05.mixed`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C04.complete.json`.
    - Done when: Generated package-specific glue, actual consumers and supported installed hosts pass; declined validation route retains its visible adoption gap.

### Shared readiness group 18

- **Lane `C-coordination` — Dispatch, ownership and completion review**
  - [ ] **C05.complete — All parity, budget and rollout evidence reviewed** (gate; after `C05.ready`, `A10`, `V11`, `W07`, `P10`).
    - Do: Review cited raw evidence before releasing the gate.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/shared/C05.complete.json`.
    - Done when: No unexplained observable differences; actual complete-call/native-reuse adoption and resource decisions retain raw evidence.

Pin toolchain/crate/binding versions and compatible generated glue; use lockfiles and reproducible package-local scripts. No root Cargo workspace pulls the compiler into these ports. Source folders do not establish package publication. Versions are accepted after actual builds and license/support checks.

## Execution order and parallel dispatch

Use the [combined execution manifest](execution-manifest.json) with the four linked task lists. The dependency graph is the implementation order. Wave/readiness group headings are navigation aids, never a requirement to finish every task in a numbered group before starting another. Each box is a work item or evidence-backed gate; nested Do/Writes/Done bullets define that item, not additional dispatchable boxes.

Default capacity is three implementation workers plus one coordinator. The logical lanes describe exclusive ownership; they are not a promise to keep dozens of agents active. At every completion or unblock:

1. Refresh source/evidence and mark only the completed item; identify any chosen conditional HTTP/MCP/forms branch. Dispatch only tasks whose named dependencies and decision prerequisites are complete.
2. Reserve each active lane and every file/resource it writes. One delivery owner handles all C04 global edits. Give workers independent ready tasks; when a lane is blocked, release its worker to ready backlog rather than assigning speculative implementation.
3. Prefer tasks that unlock the longest dependency chains and multiple consumers: common contracts, A03.foundation/A07.foundation, W02.foundation and actual delivery. Once contracts are stable, numeric/temporal, validation traversal/policy, work rows/retry/receipts and native modules/plan/render/release branches can overlap.
4. Land dependency-sized, reviewable patches and run their acceptance before releasing an integration gate. Hand a reviewed source hash and interface to the next owner. Require final joined tests after source handoffs; stale branch evidence is insufficient.
5. If no implementation item is ready, use owned fixture/oracle/resource/release backlog from that plan. Record unresolved blockers and the owner/exit condition; do not invent production work to fill capacity. The coordinator maintains evidence, reviews ready patches and fulfils shared requests.
6. Join actual consumers, installed outputs and complete-call measurements before each declared rollout/default decision. Release selection and rollback remain independent per subsystem; optional/deferred boxes stay unchecked and do not become hidden requirements.

The early graph is C01.ready → concurrent C02/C03/C05 readiness, then ABI/asset/loader proof and independent source inventories/prepared boundaries. A03.foundation releases exact/validation branches; A07.foundation → V03.5 → A07.3 → profile registration orders shared binding writes. W02.foundation → C04.graph unblocks the leaf consumers; W06.2 → W06.runtimehandoff → V09.1 → W06.3 orders runtime edits and final durable tests. Native P03.foundation releases data algorithms, P05/P06 branch work and early P09 packaging; C04.preparation-join applies its bundle request, with enabled mixed-asset proof or a declared JS-only limit reviewed separately at P05.mixed.

C04.values-assets and C04.work-assets fulfil final generated asset maps, while C04.validation-join conditionally fulfils the bounded default route. C04.native-release connects supported native outputs to the existing release owner. Multiple ready C04 tasks run serially within their one writer; this avoids arbitrary cross-subsystem barriers. Conditional outcomes are enforced by decision-review gates: accepted routes must finish their optional work and evidence before outcome completion; declined routes retain documented adoption gaps.

The scheduling policy reduces avoidable waits and shared-file conflicts. True minimum wall-clock time cannot be promised without measured task durations and worker constraints. The manifest supplies a deterministic dependency/resource-valid dispatch order, not invented performance estimates.

Keep semantic changes such as stricter domains, new legacy limits or persisted hashes separate and versioned. Each eventual merge handler reconciles all changes since the living file-tree checkpoint; this planning conversion performs no merge and does not advance it.

## Common acceptance and rollout

Correctness requires zero unexplained differences in admitted inputs, output parts/bytes, errors, identity/freeze behavior where exposed, callback/access order, durable rows and stage traces. Getter/proxy/callback inputs are never shadow-run in two engines. Shadow comparison is confined to proven inert snapshots and cannot perform duplicate commits or external calls.

Measure against both current and prepared TS. Include conversion/materialization, startup, allocation/disposal, repeated errors, raw/compressed assets, peak/live/high-water memory and real consumer cost. Record actual core-entry counts and routing profiles: a public sum retained on TS cannot be reported as a Wasm sum measurement just because the selected release also contains Wasm. For work include storage/commit traces and retained payload identity; for native preparation include subprocess startup, IPC, Bun/catalog and temporary disk. Existing Node crypto is already native, and JS helpers already call each other without FFI; do not attribute savings to crossings that did not previously exist.

The plans include provisional 20% median complete-call improvement and 10% typical/error p95 regression budgets for a speed-led default. These are proposed engineering cutoffs, not observed speedups or platform guarantees. C01/C05 ratifies or replaces them from real host/caller constraints before benchmarking. A concrete native consumer or consolidation requirement may justify a compatible core without that speed threshold, with its own recorded budget; that does not excuse a slower silent default for existing JS callers. Resource limits for a new private operation/profile are explicit contracts and cannot narrow legacy Can values unnoticed.

Roll out only after compatibility, initialization, packaged release, actual-consumer and rollback evidence exists. Keep TS compatibility/rollback paths during the declared release window. Rehearse backend swaps with the same persisted rows/artifacts and assert no migration is required unless separately versioned. Error/integrity failures never trigger a second implementation. Remove duplicate TS semantic code only when its complete supported domain is covered; otherwise list retained paths in the completion ledger.

Source inspection and tests make the plan concrete, but no plan can promise perfect runtime behavior without these proofs. A decision timebox closes with a reproducible artifact: chosen design and evidence, a narrowly scoped follow-up, or a blocked adoption gate. It is not a reason to ask for redundant user permission or silently weaken acceptance.

## Architectural consultation and evidence

Following repository instructions, three independently worded equivalent JEV `choice` requests used verified package/build/consumer constraints and compared alternatives at the same outcomes. Full requests, exact responses, confidence and probability distributions are saved in [planning evidence](../evidence/implementation-plans/).

| Decision | Request 1 probability and confidence | Request 2 | Request 3 |
| --- | --- | --- | --- |
| Work-owned kernel leaf | .99 / .99 | .82 / .74 | .96 / .94 |
| Explicit backend bootstrap/selection | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| Bounded validation consumer/adoption join | .97 / .95 | 1.00 / 1.00 | 1.00 / 1.00 |
| Retained staged native preparation job | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |

All selected the same alternatives. The second work response assigns .17 to an isolated work subpath; it remains credible because it avoids another package. Source inspection found that both alternatives need a new emit/export/vendor/release route, while the subpath additionally needs strong isolation from work's state-dependent commands. The leaf makes that DAG explicit. Its package overhead is documented; if implementation proves a smaller isolated route equally clean, C01 may revise ownership with the same conformance outcomes. No probability proves correctness, performance or production readiness. Total reported consultation usage was 5,309 input and 537 output tokens.

The exact-values planning lane also ran the current values build and 424 selected TS tests across 78 suites successfully. That verifies the existing numeric baseline only. Other plan acceptance commands are inspected/current commands or explicitly future deliverables; they are not claimed as completed Rust checks. Planning verification records source hashes, document links, task references and evidence integrity; the implementation acceptance ledger remains empty until work is performed.
