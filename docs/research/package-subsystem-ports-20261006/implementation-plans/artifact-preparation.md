# Artifact preparation implementation plan

Prepare a complete local artifact, compatibility, bundle and review job in Rust while preserving the existing CLI and producer-owned build, activation and application stages. This is the fourth port plan, at source checkpoint `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5` on October 6, 2026. It implements the larger boundary described in [boundary options](../boundary-options.md); it is not a rewrite of the compiler or the full platform CLI.

The proposed native process owns the semantic artifact tree, indexes, module inventory, compatibility results, plan and rendered output throughout one job. It asks the JavaScript host for external stages only when the current operation requires them. This preserves failure order while avoiding a subprocess for every helper. All APIs and files proposed below are new implementation work. Read the [shared preparation and execution order](README.md) first.

## Scope and completion contract

Migrate parsed-artifact semantic checks and compiled identity assertions, ordered compatibility/release comparisons, pure release-manifest calculations, module path/graph/loadability checks and rewrites, deploy-plan calculation, rendering, review projection/diffs and byte preparation. Keep artifact additions, generated JavaScript and source-map data intact wherever today's loader accepts them. Read compiler-produced artifacts; do not change their producer or format to make this port easier.

The host retains filesystem discovery and syntax-error attribution, companion-file loading, owning catalog derivation, Bun execution, activation producers, CLI confirmation/envelopes, publication to deployment paths and Wrangler application. Release version facts continue to come from the owning stamp/package inputs. A native job must not invent a successful activation verdict or supply missing producer capabilities. Current incomplete activation gates and unmapped schedules remain visible.

The first migrated consumer is `can-platform build` and `deploy --preview`; confirmed deploy later consumes the same prepared bytes through the existing host writer/apply boundary. Existing synchronous library helpers remain compatible TS entry points until their complete-call native adapters and broad caller domains have evidence. The port's completion ledger names those retained helpers; a native CLI path does not establish that every arbitrary JavaScript library invocation has been replaced.

Native preparation is independent of C04's Wasm loader proof. Its typed asset/manifest format must align with C04 when binary modules are included. No Rust implementation, native distribution test or comparative timing has yet been performed.

## Existing source and callers

| Source in the current tree | Behavior and destination |
| --- | --- |
| [runtime/artifact.ts](../../../../packages/cloudflare/src/runtime/artifact.ts) | `loadArtifactFile`/`parseArtifactText`, ordered semantic validation and `assertCompiledIdentity`. Split host parsing from Rust checks without changing file/source errors or optional/additive metadata. |
| [deploy/compat.ts](../../../../packages/cloudflare/src/deploy/compat.ts) | Ordered compatibility reasons, tree target facts and compiler/runtime comparison. Keep version/capability policy and missing-secret names exactly. |
| [release/stamp.ts](../../../../packages/cloudflare/src/release/stamp.ts), [release/manifest.ts](../../../../packages/cloudflare/src/release/manifest.ts) | Current release authority and pre-release exceptions; sorted roots/files, raw-file SHA-256 and mismatch order. Host reads facts/files; core calculates/checks. `.tsbuildinfo` exclusion remains. |
| [deploy/bundle.ts](../../../../packages/cloudflare/src/deploy/bundle.ts) | Fixed vendor/runtime inventories, import rewriting, module graph, loadability checks, generated modules, legacy module serialization/hash and writing. Rust owns matching data/graph mechanisms; JS owns Bun and `catalogFromArtifactOperations`. |
| [deploy/plan.ts](../../../../packages/cloudflare/src/deploy/plan.ts), [render.ts](../../../../packages/cloudflare/src/deploy/render.ts), [review.ts](../../../../packages/cloudflare/src/deploy/review.ts) | Resource resolution/order, schedules, fixed JSON/TOML text, keyed diff order and previous-plan validation/error attribution. Preserve existing permissive previous-plan admission; do not silently make it a stricter schema. |
| [cli/platform.ts](../../../../packages/cloudflare/src/cli/platform.ts) | Actual `build`/`deploy` callers, refusal/error order, stdout JSON envelope and stderr review, preview/confirmed paths. Remains the host orchestrator. |
| [deploy/activate.ts](../../../../packages/cloudflare/src/deploy/activate.ts), [upgrade/apply.ts](../../../../packages/cloudflare/src/upgrade/apply.ts) | Activation and external application owners. Neither stage is reimplemented in this core. |
| [interfaces operation catalog](../../../../packages/interfaces/src/http/operations.ts) | Owning `catalogFromArtifactOperations` derivation, exported through interfaces; use the existing producer rather than copying its rules. |
| Cloudflare `test/{artifact,artifact-operations,artifact-field-descriptions,compat,plan,review,release,deploy-bundle,deploy-plan,deploy-cli,deploy-apply}.test.ts` | Existing TS semantic, byte, CLI and mocked-apply fixtures. P01 records baseline and compiles dists before CLI checks; stale dists cannot prove parity. |

The two build operations in `bundle.ts` are substantive: Bun bundles the real MCP handler, and interfaces derives the operation input catalog. One host build-adapter module owns both, with separate coarse phases at their existing positions in the job. Native preparation may retain one semantic parse while that adapter parses or materializes another artifact view; globally parsing once is not a completion criterion.

## Proposed package layout and ownership

```text
packages/cloudflare/
  preparation/
    Cargo.toml
    Cargo.lock
    src/
      main.rs
      job.rs
      protocol.rs
      input.rs
      artifact.rs
      compatibility.rs
      release.rs
      modules.rs
      plan.rs
      render.rs
      review.rs
      failures.rs
    tests/{vectors,protocol,outputs}.rs
  src/preparation/
    host.ts
    protocol.ts
    inputs.ts
    build-adapter.ts
    publication.ts
    executable.ts
  scripts/
    build-preparation.mjs
    package-preparation.mjs
  conformance/preparation/
    cases.json
    differential.mjs
    workloads.mjs
  test/{preparation-protocol,preparation-native,preparation-cli}.test.ts
  dist/preparation/
    manifest.json
    <supported-platform>/can-preparation[.exe]
```

Cloudflare owns this standalone crate and its host adapter. It has no dependency on the compiler crate or the values/work crates merely for packaging convenience. Package-local scripts participate in the existing package build/release commands; output under `dist` participates in package publication and the current dist manifest. C01 decides supported hosts from actual CLI consumers and existing support claims. Pin a tested Rust toolchain, dependencies and lockfile in P03. Do not silently promise every platform supported by Node before native build/launch tests exist.

`serde_json` can parse closed protocol metadata and retain raw spans with [RawValue](https://docs.rs/serde_json/latest/serde_json/value/struct.RawValue.html). It is not the compatibility parser for arbitrary JS strings/objects. Host JSON parsing initially preserves syntax diagnostics and JS numeric behavior; lossless transfer uses ordered tagged nodes, UTF-16 code units, number bits and explicit null/presence. Optional artifact/source-map metadata is preserved as the admitted tree, not discarded by a closed Rust struct. The initial legacy renderer uses a dedicated UTF-16-aware JS-compatible string/key writer and host-produced canonical JSON spellings for original numeric nodes, carried with their f64 bits. It preserves JS object enumeration and the original admitted tree; newly calculated bounded counts have explicit decimal rendering. P03/P06 test complete serializations against host `JSON.stringify`, including nonfinite-number-to-null behavior and negative zero. Do not substitute generic serde formatting or perform per-leaf IPC to format the tree.

## Native job protocol and sequencing

Use one executable invocation per preparation job, with an ordered, length-delimited, versioned stream on stdin/stdout. Closed metadata may be JSON; byte payloads use separate length-delimited frames rather than base64-encoding the complete module map. All counts, lengths, stage IDs and paths are checked. Stdout is protocol-only inside this private process; the outer CLI retains its one-envelope contract. Stderr is diagnostics, bounded and captured by the host. No shell command strings are used: launch an explicitly resolved executable and Bun through argument arrays.

Proposed stages are `Begin`, `NeedHost`, `ResumeHost`, `Prepared` and `Failed`. `NeedHost` carries one expected stage token and its minimal request; `ResumeHost` must match that token once. Reject replayed/out-of-order responses, an ABI/release mismatch and unexpected EOF. `Abort`/process termination cleans private staging and invalidates the job. None of these names is a currently implemented API.

Native checks produce structured host errors with original CLI classification, source path and legacy message. Host stage failures retain their original exceptions/classification and terminate the job; never retry preparation in TS after a started Rust failure. Explicit TS versus native selection occurs before the job. A missing selected native executable fails initialization clearly; rollback is a release switch.

The protocol must replay today's stages, including negative paths:

1. The host discovers/reads the artifact and preserves parse/read error mapping. Rust runs artifact semantic checks before companion reads or other stages. `build` then requests current lockstep facts and returns the existing build result; it does not bundle or activate.
2. For `deploy`, artifact acceptance precedes the missing-environment check and descriptor/environment/target reads. Host companion parsing/shape checks remain at their current positions initially. Rust performs compatibility checks with the same ordered reasons.
3. Bare deploy refuses at the confirmation stage before activation or Bun. Compatibility failures still precede confirmation failure. Preview or confirmed jobs continue; compiler match is recorded, but a preview may report the mismatch warning.
4. Request activation from the existing owner, then preserve the bundle's internal stages: stage/check artifact modules and page/callable references before probing the worker entry; collect worker, runtime and vendor outputs before requesting Bun; render the staged artifact/verdict module after MCP bundling, then request owning interfaces catalog derivation; scan loadability before validating links. The host build adapter has MCP and catalog phases so neither runs too early. Preserve the existing `worker-main-missing` warning and legacy-main branch; this branch performs no Bun or catalog calls. All other bundle failures retain their classification. Native indexes/module buffers survive across these requests.
5. Compute the deploy plan before requesting the previous plan. A missing prior plan remains first deployment; malformed/unreadable prior data fails at the same point. Perform diffs/rendering and return preview results with no deployment files published. When both `--preview` and `--yes` are supplied, preview still wins and no apply occurs.
6. On confirmed deploy, a compiler mismatch refuses before publication. Publish the prepared bundle, plan JSON and TOML through the existing host policy; only then invoke existing Wrangler apply. The port does not create a new approval step. During implementation tests, use the existing mocked apply seam and do not deploy live infrastructure.

Host snapshots are not eagerly read merely to fill a DTO: that would reorder file failures, permission checks and side effects. P02 records an exact trace for every stage/error branch and the protocol is tested against it.

Temporary staging is permitted where current Bun already uses temporary files. Preview means no deployment artifacts are written into the user's deployment paths. The native process uses only a host-created private temporary root; publication validates relative paths, exact lengths/hashes and containment. Reject traversal, absolute paths, invalid separator variants and unsupported symlink behavior. Clean temporary files on success, error, timeout and cancellation. The reviewed text and output-file digests identify the exact staged content later published; do not re-render after review. New partial-publication recovery must be documented separately from parity with the current writer, rather than implied to be transactional today.

## Ordered implementation tasks

This is an executable checklist: nested lanes contain work items and completion gates. Start an item only after its named dependencies are complete; wave numbers group useful readiness, not global barriers. Every box is initially unchecked. The original P01–P11 remain completion gates, with smaller handoffs that release parallel work early. The [machine-readable tasks](artifact-preparation.tasks.json) carry the same IDs, writes, dependencies and acceptance.

### Lane ownership and dispatch

One worker owns each lane while active. Logical lanes can exceed available workers: assign ready tasks to three implementation workers plus one shared coordinator by default, releasing workers when their current lane is blocked. Never launch two writers for the same lane or shared source file. C04 owns root/consumer manifests and shared `bundle.ts` changes; this plan submits contracts to `C04.preparation-join` and `C04.native-release`. Native JS-only delivery does not await the Wasm smoke; mixed-asset outcome review is a separate final join, requiring proof only when mixed support is enabled.

| Lane | Single-writer scope | Ready backlog and exit |
| --- | --- | --- |
| `P-contract` — Source contracts and coverage | `packages/cloudflare/README.md` | Ready items P01.1, P02.1, P11.1; release the worker when blocked, after recording evidence. |
| `P-evidence` — Baselines, conformance and measurements | `packages/cloudflare/conformance/preparation/cases.json`; `packages/cloudflare/conformance/preparation/differential.mjs`; `packages/cloudflare/conformance/preparation/workloads.mjs`; `packages/cloudflare/test/preparation-cli.test.ts`; `packages/cloudflare/test/preparation-mixed-assets.test.ts`; `packages/cloudflare/test/preparation-native.test.ts` | Ready items P01.2, P02.3, P05.5, P05.6, P07.2, P08.2, P10.1; release the worker when blocked, after recording evidence. |
| `P-coordination` — Completion review and dispatch |  | Ready items parent gates; release the worker when blocked, after recording evidence. |
| `P-session` — Native protocol and single job integrator | `packages/cloudflare/preparation/Cargo.lock`; `packages/cloudflare/preparation/Cargo.toml`; `packages/cloudflare/preparation/rust-toolchain.toml`; `packages/cloudflare/preparation/src/job.rs`; `packages/cloudflare/preparation/src/main.rs`; `packages/cloudflare/preparation/src/protocol.rs`; `packages/cloudflare/preparation/tests/protocol.rs`; `packages/cloudflare/preparation/tests/vectors.rs`; `packages/cloudflare/src/preparation/protocol.ts` | Ready items P03.1, P03.3, P04.4, P05.4, P06.3; release the worker when blocked, after recording evidence. |
| `P-input` — Lossless admitted-tree transport | `packages/cloudflare/preparation/src/failures.rs`; `packages/cloudflare/preparation/src/input.rs`; `packages/cloudflare/src/preparation/inputs.ts` | Ready items P03.2; release the worker when blocked, after recording evidence. |
| `P-host` — Host launcher, build stages and CLI writer | `packages/cloudflare/src/cli/platform.ts`; `packages/cloudflare/src/preparation/build-adapter.ts`; `packages/cloudflare/src/preparation/executable.ts`; `packages/cloudflare/src/preparation/host.ts`; `packages/cloudflare/src/preparation/publication.ts`; `packages/cloudflare/test/preparation-protocol.test.ts`; `packages/cloudflare/test/preparation-publication.test.ts` | Ready items P02.2, P03.4, P05.2, P05.3, P07.1, P08.1, P10.2; release the worker when blocked, after recording evidence. |
| `P-artifact` — Artifact indexes and semantic checks | `packages/cloudflare/preparation/src/artifact.rs`; `packages/cloudflare/preparation/tests/artifact.rs` | Ready items P04.1; release the worker when blocked, after recording evidence. |
| `P-compatibility` — Compatibility policy calculations | `packages/cloudflare/preparation/src/compatibility.rs`; `packages/cloudflare/preparation/tests/compatibility.rs` | Ready items P04.2; release the worker when blocked, after recording evidence. |
| `P-release` — Release calculations and native packaging | `packages/cloudflare/preparation/src/release.rs`; `packages/cloudflare/preparation/tests/release.rs`; `packages/cloudflare/scripts/build-preparation.mjs`; `packages/cloudflare/scripts/package-preparation.mjs`; `packages/cloudflare/src/preparation/executable-manifest.ts`; `packages/cloudflare/test/preparation-packaged.test.ts` | Ready items P04.3, P09.1, P09.2; release the worker when blocked, after recording evidence. |
| `P-modules` — Module paths, rewriting and graph | `packages/cloudflare/preparation/src/modules.rs`; `packages/cloudflare/preparation/tests/modules.rs` | Ready items P05.1; release the worker when blocked, after recording evidence. |
| `P-review` — Plans, rendering and review | `packages/cloudflare/preparation/src/plan.rs`; `packages/cloudflare/preparation/src/render.rs`; `packages/cloudflare/preparation/src/review.rs`; `packages/cloudflare/preparation/tests/outputs.rs`; `packages/cloudflare/preparation/tests/plan.rs` | Ready items P06.1, P06.2; release the worker when blocked, after recording evidence. |

P03.foundation releases lossless transport and independent artifact/compatibility/release work; P05 module logic and P06 plan/render/review use P02.1 contracts in parallel. Native packaging scaffolds start early. One P-session writer performs the P04/P05/P06 joins into `job.rs` in dependency order. P07 joins publication evidence, then P08 proves the real CLI and P09 proves installed hosts before P10 adoption. P11 additionally requires the mixed-asset outcome review; JS-only scope never certifies mixed support.

Every task records inspected source hash/checkpoint, changed files, commands/results, raw output and unresolved differences under `evidence/implementation/artifact-preparation/`. Subtasks inherit all semantic/resource contracts below; acceptance bullets are evidence requirements, not additional untracked implementation tasks.

### Wave 1

- **Lane `P-contract` — Source contracts and coverage**
  - [ ] **P01.1 — Freeze source, stage, caller and platform contracts** (implementation; after `C01.ready`).
    - Do: Within two working days, inventory migrated exports, retained synchronous helpers, actual CLI consumers, host claims and producer-owned facts. Assign exact source files; preserve the compiler boundary and additive artifact domain.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/inventory.json`.
    - Done when: Every responsibility has a real caller and owner; stage/error/confirmation order is mapped; no compiler change is required.

- **Lane `P-evidence` — Baselines, conformance and measurements**
  - [ ] **P01.2 — Capture current source and installed CLI baselines** (implementation; after `P01.1`, `C05.ready`).
    - Do: Build current dists before CLI evidence; record source-only and built CLI results separately. Capture fixture bytes, traces, baseline failures, supported hosts and precommitted workload/resource budgets.
    - Writes: `packages/cloudflare/conformance/preparation/cases.json`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/baseline.json`.
    - Done when: No stale dist is treated as current parity; unrelated failures have owners; all P01 source suites and CLI modes are classified.

### Wave 2

- **Lane `P-contract` — Source contracts and coverage**
  - [ ] **P02.1 — Freeze prepared-job and coarse host-stage contracts** (implementation; after `P01`, `C02.ready`, `C03.ready`, `C05.ready`).
    - Do: Specify exact demand-driven steps, lossless tree fields, MCP/catalog requests, staged bytes and refusal/error traces. Specify a stable bundle/reference interface for parallel module and plan work.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/stage-contract.json`.
    - Done when: Bare, preview, confirmed, preview+yes, compiler mismatch, missing worker and competing failures have exact stage expectations; no eager previous-plan reads or live apply.

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P01 — Source, baseline and release ownership complete** (completion gate; after `P01.1`, `P01.2`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P01.json`.
    - Done when: Every migrated responsibility has an owner; zero required compiler changes; existing source-only tests and correctly built CLI tests classified. Record unrelated baseline failures without fixing them as part of planning.

### Wave 3

- **Lane `P-session` — Native protocol and single job integrator**
  - [ ] **P03.1 — Create package-local crate and executable scaffold** (implementation; after `P02.1`, `C03.ready`).
    - Do: Pin tested toolchain, crates, locks and protocol version. Create a standalone crate, explicit binary entry and retained-session scaffold; keep compiler and runtime kernels out of its dependency graph.
    - Writes: `packages/cloudflare/preparation/Cargo.toml`, `packages/cloudflare/preparation/Cargo.lock`, `packages/cloudflare/preparation/rust-toolchain.toml`, `packages/cloudflare/preparation/src/main.rs`, `packages/cloudflare/preparation/src/job.rs`, `packages/cloudflare/preparation/src/protocol.rs`.
    - Done when: Native launch/framing proof is recorded within the declared spike; protocol stdout is clean and package-local builds reproduce.

- **Lane `P-host` — Host launcher, build stages and CLI writer**
  - [ ] **P02.2 — Extract matching TS job and host wrappers** (implementation; after `P02.1`).
    - Do: Extract a prepared TS orchestration route around current helpers without reordering activation, Bun, catalog, render, review or publication. Initially delegate the existing bundle helper through its public boundary. Submit later bundle-internal changes to C04.preparation-join.
    - Writes: `packages/cloudflare/src/preparation/host.ts`, `packages/cloudflare/src/preparation/build-adapter.ts`, `packages/cloudflare/src/cli/platform.ts`.
    - Done when: Current and prepared TS behavior, stdout/stderr, side-effect counts and bytes match; existing library helpers retain their route.

### Wave 4

- **Lane `P-evidence` — Baselines, conformance and measurements**
  - [ ] **P02.3 — Build full-job differential and trace observers** (implementation; after `P02.2`).
    - Do: Implement repeatable current/prepared TS observers and complete-job workload records. Preserve seeds, source/environment, output bytes and stage traces.
    - Writes: `packages/cloudflare/conformance/preparation/differential.mjs`, `packages/cloudflare/conformance/preparation/workloads.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/prepared-ts.json`.
    - Done when: A reproducible comparator includes external stages and subprocess-ready timing boundaries; no duplicate host execution on effectful inputs.

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P03.foundation — Native crate and retained-session interface ready** (completion gate; after `P03.1`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P03.foundation.json`.
    - Done when: The explicit foundation contract and its evidence are complete.
    - Done when: Algorithm lanes may start from the frozen interface without waiting for the complete host launcher or prepared TS measurement.

- **Lane `P-session` — Native protocol and single job integrator**
  - [ ] **P03.3 — Implement ordered framed request/resume states** (implementation; after `P03.foundation`, `P03.2`).
    - Do: Implement Begin/NeedHost/ResumeHost/Prepared/Failed, byte frames, token-once validation, limits, EOF/abort and structured failure mapping. Keep state and module buffers in one process.
    - Writes: `packages/cloudflare/preparation/src/protocol.rs`, `packages/cloudflare/preparation/src/job.rs`, `packages/cloudflare/src/preparation/protocol.ts`, `packages/cloudflare/preparation/tests/protocol.rs`.
    - Done when: Truncated/oversized frames, stage replay/skew/unknown versions, mismatched tokens and cancellation fail deterministically; no per-leaf IPC or semantic TS retry.

- **Lane `P-input` — Lossless admitted-tree transport**
  - [ ] **P03.2 — Implement lossless admitted-tree transfer** (implementation; after `P03.foundation`).
    - Do: Transfer ordered tagged nodes, explicit presence/null, UTF-16 strings/keys, f64 bits and host canonical numeric spellings. Retain optional/admitted metadata and host JSON syntax diagnostics.
    - Writes: `packages/cloudflare/preparation/src/input.rs`, `packages/cloudflare/preparation/src/failures.rs`, `packages/cloudflare/src/preparation/inputs.ts`.
    - Done when: Surrogates, own __proto__, enumeration, exponent/negative-zero/nonfinite numbers, depth/size limits and malformed input vectors pass; serde metadata is not the compatibility renderer.

### Wave 5

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P02 — Prepared TS comparator and stage traces complete** (completion gate; after `P02.2`, `P02.3`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P02.json`.
    - Done when: Prepared TS preserves all existing behavior. Its whole-job cost is the primary comparator; fixtures cover bare/preview/confirmed paths, missing worker fallback and multiple competing failures. No new live apply calls.

- **Lane `P-host` — Host launcher, build stages and CLI writer**
  - [ ] **P03.4 — Build resolved native launcher and host lifecycle** (implementation; after `P02.2`, `P03.3`).
    - Do: Resolve the selected executable explicitly; launch by argument arrays, bound stderr and resource handling, and release private sessions on success/error/timeout/cancel. Select TS/native before evaluation.
    - Writes: `packages/cloudflare/src/preparation/executable.ts`, `packages/cloudflare/src/preparation/host.ts`, `packages/cloudflare/test/preparation-protocol.test.ts`.
    - Done when: Real native launch, missing executable and version mismatch work as specified; one retained process per job; started native failure never falls through to TS.

- **Lane `P-artifact` — Artifact indexes and semantic checks**
  - [ ] **P04.1 — Port artifact semantic indexes and identity checks** (implementation; after `P03.2`).
    - Do: Port required-field, module/page/callable/test/operation cross-references and compiled identity in source order; preserve unknown/additive trees and source maps.
    - Writes: `packages/cloudflare/preparation/src/artifact.rs`, `packages/cloudflare/preparation/tests/artifact.rs`.
    - Done when: Source fixtures and multiple-error first-failure order match; malformed JSON remains a host parse error.

- **Lane `P-compatibility` — Compatibility policy calculations**
  - [ ] **P04.2 — Port ordered compatibility calculations** (implementation; after `P03.2`).
    - Do: Consume current owner-produced target/runtime/compiler/version/capability/secret facts and calculate exact ordered compatibility reasons.
    - Writes: `packages/cloudflare/preparation/src/compatibility.rs`, `packages/cloudflare/preparation/tests/compatibility.rs`.
    - Done when: Accepted pre-release cases, missing secret names and reason ordering match; no new capability/version authority.

- **Lane `P-release` — Release calculations and native packaging**
  - [ ] **P04.3 — Port release manifest and stamp calculations** (implementation; after `P03.2`).
    - Do: Consume raw files and owning package/stamp inputs; calculate sorted roots/files, SHA-256 and mismatch lines with current .tsbuildinfo exclusions.
    - Writes: `packages/cloudflare/preparation/src/release.rs`, `packages/cloudflare/preparation/tests/release.rs`.
    - Done when: Byte hashes, counts, sorting and mismatch order match; host remains the filesystem/release-fact authority.

### Wave 6

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P03 — Native protocol and complete retained-session proof complete** (completion gate; after `P02`, `P03.2`, `P03.3`, `P03.4`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P03.json`.
    - Done when: One working day for toolchain/framing pins after native launch proof; two working days for the complete retained-session interface proof. Malformed/truncated/oversized frames, stage replay, unknown versions, surrogate keys and numeric bits are tested; stdout remains protocol-only. Future command: `cargo test --locked --manifest-path packages/cloudflare/preparation/Cargo.toml`.

- **Lane `P-session` — Native protocol and single job integrator**
  - [ ] **P04.4 — Join acceptance and compatibility into native job** (implementation; after `P03`, `P04.1`, `P04.2`, `P04.3`).
    - Do: Wire ordered artifact acceptance before companions/environment, build lockstep results, deploy compatibility and confirmation/activation requests.
    - Writes: `packages/cloudflare/preparation/src/job.rs`, `packages/cloudflare/preparation/tests/vectors.rs`.
    - Done when: Full stage traces retain early refusal points and the distinction between preview compiler warning and confirmed refusal before publication.

- **Lane `P-host` — Host launcher, build stages and CLI writer**
  - [ ] **P05.2 — Produce two-phase real build-adapter contract** (implementation; after `P02.2`, `P03.4`, `P02.1`).
    - Do: Implement distinct real Bun-MCP and interfaces-catalog host phases; submit exact bundle/helper/export changes to C04.preparation-join. Keep activation and catalog producers unchanged.
    - Writes: `packages/cloudflare/src/preparation/build-adapter.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/bundle-join-request.json`.
    - Done when: Requests preserve module/page checks before worker probe, vendor outputs before Bun, verdict render before catalog and loadability before links; legacy worker-missing path invokes neither phase.

- **Lane `P-release` — Release calculations and native packaging**
  - [ ] **P09.1 — Build native packaging scripts and host inventory early** (implementation; after `P03.foundation`, `P01.1`).
    - Do: Create package-local reproducible builds, per-supported-host executable inventory, integrity/protocol/release metadata and licenses. Submit package command/export/stamp changes to C04.native-release.
    - Writes: `packages/cloudflare/scripts/build-preparation.mjs`, `packages/cloudflare/scripts/package-preparation.mjs`, `packages/cloudflare/src/preparation/executable-manifest.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/native-release-request.json`.
    - Done when: Supported hosts derive from claims/consumers; normal installation will use prebuilt executables; scripts do not vendor native binaries into Workers.

- **Lane `P-modules` — Module paths, rewriting and graph**
  - [ ] **P05.1 — Port module inventory, rewriting and graph checks** (implementation; after `P04.1`, `P02.1`).
    - Do: Implement ordered paths, duplicate-last-wins merging, current import rewrites/markers, link/loadability order, JS text inventory and legacy serialization/digest. Read the typed C04 asset contract for future mixed modules.
    - Writes: `packages/cloudflare/preparation/src/modules.rs`, `packages/cloudflare/preparation/tests/modules.rs`.
    - Done when: JS-only keys/text/markers/v1 hashes and current string.length counts match; unresolved/bare imports retain refusal; no binary decoding as JS.

- **Lane `P-review` — Plans, rendering and review**
  - [ ] **P06.1 — Port resource and deploy-plan calculations** (implementation; after `P04.1`, `P04.2`, `P02.1`).
    - Do: Use the stable bundle-reference contract to calculate resource resolution/order, schedules and deploy plans. Keep unmapped schedules and incomplete activation visible.
    - Writes: `packages/cloudflare/preparation/src/plan.rs`, `packages/cloudflare/preparation/tests/plan.rs`.
    - Done when: Plan objects, resource order and all source refusal cases match; this branch does not await full module implementation.

### Wave 7

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P04 — Artifact, identity, compatibility and release core complete** (completion gate; after `P04.4`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P04.json`.
    - Done when: Native vectors match source fixtures and first-error order; malformed host JSON still follows host diagnostics. Dist file hashes/counts and all mismatch lines match existing raw-byte behavior. No new release/capability authority.

- **Lane `P-host` — Host launcher, build stages and CLI writer**
  - [ ] **P05.3 — Integrate real host build phases** (implementation; after `P05.1`, `P05.2`, `C04.preparation-join`).
    - Do: Join actual Bun and owning catalog results through the stable preparation inputs; preserve host errors and module bytes.
    - Writes: `packages/cloudflare/src/preparation/build-adapter.ts`.
    - Done when: No mocked host outputs count as Bun/catalog integration evidence; each external stage occurs once at its current position.

- **Lane `P-review` — Plans, rendering and review**
  - [ ] **P06.2 — Port exact JSON/TOML rendering and review** (implementation; after `P06.1`, `P03.2`).
    - Do: Implement UTF-16/JS enumeration-compatible serialization, exact TOML and keyed review diff order. Keep permissive admitted previous-plan fields and validation.
    - Writes: `packages/cloudflare/preparation/src/render.rs`, `packages/cloudflare/preparation/src/review.rs`, `packages/cloudflare/preparation/tests/outputs.rs`.
    - Done when: Complete bytes match host JSON.stringify/current TOML; nonfinite→null/negative-zero and unknown previous-plan cases pass; no generic serializer parity assumption.

### Wave 8

- **Lane `P-session` — Native protocol and single job integrator**
  - [ ] **P05.4 — Join module buffers and host resumes in native job** (implementation; after `P04.4`, `P05.3`).
    - Do: Wire inventory→MCP resume→artifact/verdict render→catalog resume→loadability/links, retaining buffers across requests.
    - Writes: `packages/cloudflare/preparation/src/job.rs`.
    - Done when: Matching legacy-main fallback, cross-stage identities, ordered failures and full module output pass differential tests.

- **Lane `P-host` — Host launcher, build stages and CLI writer**
  - [ ] **P07.1 — Implement contained staging and publication adapter** (implementation; after `P03.4`, `P06.2`, `C03.ready`).
    - Do: Validate private temp roots, relative paths, separator/traversal/symlink handling, exact lengths/hashes and reviewed bytes. Keep current confirmed writer/apply and failed-apply/manual-command policy.
    - Writes: `packages/cloudflare/src/preparation/publication.ts`, `packages/cloudflare/test/preparation-publication.test.ts`.
    - Done when: Cleanup on every exit is tested; private preview staging is allowed but no deployment file publication; current partial-write behavior is classified honestly.

### Wave 9

- **Lane `P-evidence` — Baselines, conformance and measurements**
  - [ ] **P05.5 — Prove JS-only bundle and real MCP output** (implementation; after `P05.4`).
    - Do: Run actual native process, source fixture differential and real MCP local-workerd loadability checks.
    - Writes: `packages/cloudflare/test/preparation-native.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/module-parity.json`.
    - Done when: Real MCP output runs; marker-only checks are insufficient; JS-only bundle bytes/digests match without requiring a Wasm-loader proof.

- **Lane `P-session` — Native protocol and single job integrator**
  - [ ] **P06.3 — Join plan, prior-plan request and rendered review** (implementation; after `P05.4`, `P06.2`).
    - Do: Compute current plan before requesting prior plan; render/diff once and retain exact reviewed buffers/digests for later publication.
    - Writes: `packages/cloudflare/preparation/src/job.rs`.
    - Done when: Repeated jobs are deterministic; missing/bad prior plans fail at existing stages; preview+yes still previews; confirmed mismatch refuses after preparation and before writes.

### Wave 10

- **Lane `P-evidence` — Baselines, conformance and measurements**
  - [ ] **P05.6 — Verify mixed text/Wasm preparation after loader proof** (implementation; after `P05.5`, `C04.ready`, `C04.graph`).
    - Do: Exercise typed byte inventory, generated glue/imports and versioned manifest/digest with actual compiled Wasm; align publication paths with C04 delivery.
    - Writes: `packages/cloudflare/test/preparation-mixed-assets.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/mixed-assets.json`.
    - Done when: Exact lengths/hashes, unchanged JS-only v1 output and no Wasm-as-text rewriting are demonstrated in generated installed output.

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P05 — Native module graph and ordered host build complete** (completion gate; after `P05.5`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P05.json`.
    - Done when: Same JS text, imports, markers, key order and v1 digest for existing fixtures. Negative unresolved/bare imports preserve refusals. Real MCP output works in local workerd, not only text-marker tests. C04 is required only for mixed Wasm inventory acceptance.
    - Done when: The mixed-asset acceptance remains an explicit P05.mixed outcome gate joined at P11: enabled mixed support requires P05.6 proof; JS-only completion records mixed support as deferred and does not certify it.
  - [ ] **P06 — Plan, rendering and review integration complete** (completion gate; after `P06.3`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P06.json`.
    - Done when: Byte-identical JS-only outputs and reason/diff ordering; preserve unknown fields where today's previous-plan/render path admits them. Repeated jobs deterministically yield the same result. A generic TOML/JSON library's output is insufficient evidence.

### Wave 11

- **Lane `P-evidence` — Baselines, conformance and measurements**
  - [ ] **P07.2 — Verify actual job publication and mocked apply** (implementation; after `P05`, `P06`, `P07.1`).
    - Do: Run bare/preview/confirmed/compiler-mismatch/cancel/error jobs against private directories and existing mocked apply seam.
    - Writes: `packages/cloudflare/test/preparation-cli.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/publication.json`.
    - Done when: Zero deployment files for bare/preview/mismatch; mocked apply consumes exactly reviewed bundle/config; no live deploy.

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P05.mixed — Review enabled mixed-asset proof or declared JS-only limit** (completion gate; after `P05.5`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P05.mixed.json`.
    - Conditional order: enabled mixed support additionally requires `P05.6`; a declared JS-only release records mixed support as deferred and rejects that profile before evaluation.
    - Done when: Enabled mixed support requires P05.6 real-byte/loader/installed-output evidence; JS-only completion records deferred mixed support, rejects unsupported mixed input before native evaluation, and never claims Wasm adoption.

### Wave 12

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P07 — Staging, reviewed-write identity and apply handoff complete** (completion gate; after `P03`, `P05`, `P06`, `P07.1`, `P07.2`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P07.json`.
    - Done when: Preview and bare deploy publish zero deployment files; compiler mismatch writes none; successful mocked apply sees the exact reviewed config/bundle. Existing failed-apply envelope/manual command and partial-write behavior remain honestly classified. No live deploy.

- **Lane `P-host` — Host launcher, build stages and CLI writer**
  - [ ] **P08.1 — Join native build/preview/confirmed CLI selection** (implementation; after `P07`, `P02.2`, `C05.ready`).
    - Do: Integrate explicit release modes into current CLI using the complete preparation call; retain public synchronous helpers and original activation/apply boundaries.
    - Writes: `packages/cloudflare/src/cli/platform.ts`, `packages/cloudflare/src/preparation/host.ts`.
    - Done when: Exactly one stdout envelope, matching exits/code/detail/stderr and no repeated external stages; selected-native startup failure is visible.

### Wave 13

- **Lane `P-evidence` — Baselines, conformance and measurements**
  - [ ] **P08.2 — Run full CLI and installed-dist differential** (implementation; after `P08.1`, `P02.3`, `C04.native-release`).
    - Do: Compare current/prepared TS/native using real executable and freshly built installed dist; cover all negative, preview and confirmed mocked-apply modes.
    - Writes: `packages/cloudflare/conformance/preparation/differential.mjs`, `packages/cloudflare/test/preparation-cli.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/cli-parity.json`.
    - Done when: No unexplained traces/bytes/errors; library helper routes remain declared and passing.

### Wave 14

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P08 — Actual native CLI consumer complete** (completion gate; after `P08.2`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P08.json`.
    - Done when: One stdout envelope, matching exits/code/detail/stderr review and no repeated external stages. Run real native executable and generated installed `dist`, not mocked native replies. Public synchronous library helper tests still pass on their declared routes.

- **Lane `P-release` — Release calculations and native packaging**
  - [ ] **P09.2 — Prove supported packaged executable launch** (implementation; after `P08`, `P09.1`, `C04.native-release`).
    - Do: Build/package and launch outside the checkout on every claimed host; test corrupt/missing/wrong-architecture/protocol/release-skew cases.
    - Writes: `packages/cloudflare/test/preparation-packaged.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/packaged-hosts.json`.
    - Done when: Each supported host has actual build+launch evidence; unsupported hosts remain explicit; package includes executable/license/dist metadata and needs no user compiler.

### Wave 15

- **Lane `P-evidence` — Baselines, conformance and measurements**
  - [ ] **P10.1 — Measure full-job adoption and resource budgets** (implementation; after `P08`, `P09`, `C05.ready`).
    - Do: Run precommitted current/prepared TS/native workloads including small preview startup, IPC, Bun/catalog, error and memory/temp-disk costs.
    - Writes: `packages/cloudflare/conformance/preparation/workloads.mjs`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/measurement.json`.
    - Done when: Recorded complete-call budgets pass or a concrete native consumer/reuse reason with explicit costs justifies adoption; no isolated-core speed claim.

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P09 — Native build, publication and supported-host proof complete** (completion gate; after `P09.2`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P09.json`.
    - Done when: Supported hosts actually build and launch packaged artifacts; wrong architecture, missing executable, corruption, release/protocol skew fail before jobs. Normal users do not require a compiler to install the built package. Native binary is not vendored into Workers.

### Wave 16

- **Lane `P-host` — Host launcher, build stages and CLI writer**
  - [ ] **P10.2 — Rehearse fixed release mode and rollback** (implementation; after `P10.1`).
    - Do: Test native/TS releases against the same artifacts/manifests/persisted plans and selected backend bootstrap; avoid semantic fallback.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/rollback.json`.
    - Done when: Rollback requires no persisted-data conversion; integrity failures never start a second implementation; evidence identifies rollout/default choice.

### Wave 17

- **Lane `P-contract` — Source contracts and coverage**
  - [ ] **P11.1 — Close package coverage and final release ledger** (implementation; after `P10`, `P05.mixed`).
    - Do: List migrated mechanisms, actual native CLI scope, retained TS library helpers/host stages and any mixed-asset contract version. Recheck source/release evidence and hand final ownership to merge handler.
    - Writes: `packages/cloudflare/README.md`, `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/coverage.json`.
    - Done when: All planned mechanisms and gaps are classified; duplicate TS retirement is separate; eventual merge reconciles living filetree without advancing its checkpoint during planning.

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P10 — Measured adoption and rollback decision complete** (completion gate; after `P10.1`, `P10.2`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P10.json`.
    - Done when: Meets the precommitted workload/release budget or records the concrete native consumer/reuse reason. Small previews include subprocess startup. TS rollback does not require artifact, manifest or persisted plan conversion.

### Wave 18

- **Lane `P-coordination` — Completion review and dispatch**
  - [ ] **P11 — Artifact preparation declared scope complete** (completion gate; after `P11.1`).
    - Do: Review the linked leaf evidence and original scope ledger.
    - Writes: `docs/research/package-subsystem-ports-20261006/evidence/implementation/artifact-preparation/P11.json`.
    - Done when: Native selected scope, retained host/library paths and any mixed-asset contract change are explicit. Retirement of TS compatibility is separate. Eventual merge handler reconciles the living filetree; this plan does not advance its checkpoint.

### Deferred work

Public arbitrary JavaScript library helper replacement, stricter artifacts/previous plans, format/hash migration, transactional publication, compiler changes and activation/Bun/catalog/Wrangler replacement are outside this checklist. Any later boundary revision requires explicit compatibility evidence; it is not hidden in P11 completion.

## Compatibility and resource evidence

Require zero unexplained differences for artifact versions, required field/first failure order, modules/pages/callables/tests/operation cross-references, compiled identity, additive descriptions/unknown metadata, generated source text and source maps. Include escaped lone UTF-16 surrogates, astral/surrogate sort keys, own `__proto__`, JS numeric exponent/negative-zero/nonfinite parsed-number behavior, embedded NULs/newlines and source paths. Host parsing remains the reference for malformed syntax. Do not harden legacy validation silently while porting. Today's admitted duplicate module paths use last-write-wins when staged; later worker/runtime/artifact/vendor/generated map assignments have an ordered overwrite precedence. Preserve both with fixtures rather than adding unrequested uniqueness checks.

For compatibility/plans, cover every capability/resource/secret/release failure order, duplicate/admitted resource cases, environment vars, schedules, descriptor order, unresolved bindings, legacy/bundled main, prior plan absence/corruption/permissively admitted extras, deterministic diffs and exact trailing newlines. Preserve `Object.keys(...).sort()` UTF-16 order and current JSON/TOML escaping. Preserve the present source-only `mcpBundleBytes`/manifest string-length behavior in v1 even where it is named bytes; correcting it belongs to the explicitly versioned mixed-asset format, not an unnoticed parity change.

Legacy bundle hashes cover sorted JS source serialization. Keep v1 identical for text-only output. C04 specifies a mixed JS/Wasm inventory/hash version with exact byte lengths, module kinds and version markers; an old reader must reject that new format rather than interpret bytes as JS. P05 consumes that contract when enabled. A binary hash version change is not a claim of old byte parity. The existing dist manifest already hashes raw bytes and should cover binaries through its present mechanism.

Protocol tests include payload size/length mismatch, unexpected stage, duplicate response, process crash, timeout/cancellation, broken stdout, release/ABI drift, cleanup, adversarial paths and modified staged files. Allocation/staging is bounded per job; validate counts before allocation. C01/P03 specify private job limits from maximum real artifacts and supported-host resources, then freeze them before comparison. Do not add a new artifact language limit to an unchanged public API under cover of process safety; classify new private process limits as explicit tool configuration.

Measure tiny, typical and caller-derived maximum artifacts; generated text/source maps; no-op and change-heavy review; valid/error-heavy graphs; cold binary launch and warm session stages; real Bun/catalog time separately and inside the complete job. Use repeated independent runs and retained outputs to avoid dead work. Report elapsed time, CPU, peak RSS/native allocation, IPC bytes, temporary disk peak, executable size and release build time. Hashing already executes natively in Node; porting its wrapper supplies no speedup evidence.

Before P04, C05 freezes nominated workloads and acceptable regression/startup/resource budgets. A provisional speed-led default gate is at least 20% complete-job median improvement against prepared TS with an interval excluding no improvement and at most 10% p95 regression on typical small/error jobs; a concrete native tooling consumer may justify the core with a different explicitly recorded budget. Both routes require full parity/distribution/cleanup proof. Preserve absolute host/platform limits and derive disk/RSS caps from actual fixtures rather than universal invented values.

## Commands and completion

Current commands to establish P01/P02 baselines from repository root are:

```sh
./node_modules/.bin/vitest run packages/cloudflare/test/artifact.test.ts packages/cloudflare/test/artifact-operations.test.ts packages/cloudflare/test/artifact-field-descriptions.test.ts packages/cloudflare/test/compat.test.ts packages/cloudflare/test/plan.test.ts packages/cloudflare/test/review.test.ts packages/cloudflare/test/release.test.ts
bun run --cwd packages/cloudflare typecheck
bun run build
./node_modules/.bin/vitest run packages/cloudflare/test/deploy-bundle.test.ts packages/cloudflare/test/deploy-plan.test.ts packages/cloudflare/test/deploy-cli.test.ts packages/cloudflare/test/deploy-apply.test.ts
```

The source/test names and scripts have been inspected; these commands are execution requirements, not newly reported results. `bun run build` must pass or baseline failures must be resolved by their owner before built CLI evidence counts; do not test stale dist and call it current parity. The previous evaluation's selected TS tests and typecheck failures are historical evidence only.

Future deliverables add these commands; they do not exist yet:

```sh
cargo fmt --manifest-path packages/cloudflare/preparation/Cargo.toml -- --check
cargo test --locked --manifest-path packages/cloudflare/preparation/Cargo.toml
bun packages/cloudflare/scripts/build-preparation.mjs
node packages/cloudflare/conformance/preparation/differential.mjs --backend native
node packages/cloudflare/conformance/preparation/workloads.mjs
```

Completion requires P01–P11, all named semantic mechanisms translated, actual executable/host differential CLI evidence, exact reviewed/published bytes, packaged supported-host launch and rollback, explicit remaining TS coverage and a recorded adoption rationale. It does not mean activation, Bun, catalog derivation, Wrangler, compiler or every public unknown-object helper moved to Rust. If the native process interface cannot preserve ordered stages within P03's two-day spike, keep the prepared TS job and record the failed proof; change the boundary with evidence rather than silently accepting reordered behavior.
