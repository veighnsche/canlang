# Four package port implementation plans

This is the original technical scope and action contract. Current status/order is owned only by [REMAINING-WORK.md](../../../implementation/REMAINING-WORK.md#native-port-unit-contracts); dated observations and proposed symbols below are not a current absence inventory.

These four plans turn the package migration evaluation into tasks an implementer can execute and verify. They use source checkpoint `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5`, inspected on October 6, 2026. Scope remains existing functionality under `packages/`; the compiler stays unchanged and folders describe responsibilities. This planning round creates documentation and evidence, not production Rust code.

| Plan | Migrated responsibility | Main boundary and completion limit |
| --- | --- | --- |
| [Exact values](exact-values.md) | Exact representations, arithmetic, temporal math, numeric aggregates and scalar codecs | Shared values semantics core plus host façades. Arbitrary host-object/iterator paths remain TS until their observable behavior is proved. |
| [Input validation](input-validation.md) | Prepared type plans, whole-input checks, normalization, refs and encoding for parser-owned input | Same values crate, separate traversal/profile owner. Does not certify replacement of the full arbitrary-`unknown` legacy API. |
| [Work transitions](work-transitions.md) | Shared rows, schedule/retry/recovery decisions, receipt projection and conditional-batch linkage | A work-owned `work-kernel` leaf package, with live host evidence and fenced commits retained. Full scheduler orchestration is separately gated. |
| [Artifact preparation](artifact-preparation.md) | Artifact/release/compatibility/module graph/plan/render/review preparation | One retained native job and coarse ordered host stages. Bun, catalog producers, activation, publication and Wrangler remain with existing owners. |

The four checklists contain 205 work items and gates, plus 25 shared items: 220 required and 10 conditional/deferred items in total. All boxes remain unchecked. Each has explicit dependencies, file ownership and acceptance; the combined execution manifest also checks the required-scope and accepted-branch dispatch profiles.

Arithmetic and validation are separate task lanes in one shared core. They must not create separate decimal, money, type or wire authorities. Four plans do not imply four new general-purpose engines. The previous [ratings and scope comparison](../boundary-options.md) remain estimates; these plans do not raise scores without implementation evidence.

The initial inspection and architectural consultations used checkpoint `30e211dae891cfdca3f6322ce45c46c426138830`. A concurrent commit added loader-derived delivery-field membership in state and updated receipt tests. The five changed files were reviewed before delivery; the plans now include that owning metadata channel and its tests at the checkpoint above. This source refresh leaves the selected boundaries unchanged. The agent writing these plans performed no source merge or production edit. During checklist conversion, HEAD advanced to `3571077c2397ec37071536f0f41b8fe0473a4716`; the intervening changes affect only two compiler test files. Package sources remain unchanged from the stated package checkpoint.

## Decisions that make the plans executable

Use arbitrary-precision raw/scratch arithmetic first, preserving accepted BigInt operands. Preserve existing structural carriers and synchronous JS exports. Register immutable owner-produced plans once; keep legacy unknown objects on their observable TS evaluation path. An owned parser token is established by the actual parser seam, not a caller's annotation, freeze or object inspection.

Create a responsibility-based `packages/work-kernel/` leaf for matching work/state mechanisms. It depends only on contracts; work/state/Cloudflare use that explicit entry. The current full work package has no emitted build and contains state-dependent commands, while state intentionally mirrors its tables today. The new leaf adds build/vendor/release work but avoids a hidden state-to-full-work cycle. Separate error and cloning policies remain explicit.

Select a backend before evaluating operations. TS mode is an explicit supported rollout/rollback configuration. Selected Rust mode must pass bootstrap, asset integrity and ABI checks; it fails visibly if those fail. Do not retry failed semantic work in TS. Route declared unsupported legacy input profiles to TS before evaluation, preserving existing reads and errors. Keep a single selection throughout a request/job.

Worker kernels use precompiled Wasm with initialization at module/host startup, followed by synchronous calls. [Cloudflare's Wasm integration](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/) supplies the precompiled-module route; [wasm-bindgen's synchronous initialization example](https://wasm-bindgen.github.io/wasm-bindgen/examples/synchronous-instantiation.html) supplies an adapter option. Neither proves this repository's actual glue/import path. Node, Bun, package imports, local workerd and packaged outputs must be tested before switching callers. Native conformance runners do not require a second Node addon release.

HTTP JSON supplies an existing source handler for owned input, but the current deployed operation route returns 501. A custom Worker fixture proves that handler/binding, not default deployed adoption. Validation's adoption gate requires a bounded owning route join or verified MCP parser provenance. Do not finish a new unrelated HTTP server or declare the gap solved by a fixture. State admission retains raw hash and receipt replay before age, authorization and normalization; no prepared-plan allocation/error may invalidate a successful replay.

Artifact preparation uses one native process session with demand-driven coarse host stages. Eagerly reading the prior plan or building before the current refusal point changes behavior. Native state persists across build/activation/review requests; the host publishes exact prepared bytes and invokes existing apply policy. Preview may use private temporary files but publishes no deployment files. This is independent of the Wasm delivery task.

## Shared requirement identities

shared.tasks.json preserves the original actions, write ownership and acceptance. The canonical remaining-work units select the unmet output; historical wave numbers do not impose new barriers.

## Common acceptance and rollout

Correctness requires zero unexplained differences in admitted inputs, output parts/bytes, errors, identity/freeze behavior where exposed, callback/access order, durable rows and stage traces. Getter/proxy/callback inputs are never shadow-run in two engines. Shadow comparison is confined to proven inert snapshots and cannot perform duplicate commits or external calls.

Measure against both current and prepared TS. Include conversion/materialization, startup, allocation/disposal, repeated errors, raw/compressed assets, peak/live/high-water memory and real consumer cost. Record actual core-entry counts and routing profiles: a public sum retained on TS cannot be reported as a Wasm sum measurement just because the selected release also contains Wasm. For work include storage/commit traces and retained payload identity; for native preparation include subprocess startup, IPC, Bun/catalog and temporary disk. Existing Node crypto is already native, and JS helpers already call each other without FFI; do not attribute savings to crossings that did not previously exist.

The plans include provisional 20% median complete-call improvement and 10% typical/error p95 regression budgets for a speed-led default. These are proposed engineering cutoffs, not observed speedups or platform guarantees. C01/C05 ratifies or replaces them from real host/caller constraints before benchmarking. A concrete native consumer or consolidation requirement may justify a compatible core without that speed threshold, with its own recorded budget; that does not excuse a slower silent default for existing JS callers. Resource limits for a new private operation/profile are explicit contracts and cannot narrow legacy Can values unnoticed.

Roll out only after compatibility, initialization, packaged release, actual-consumer and rollback evidence exists. Keep TS compatibility/rollback paths during the declared release window. Rehearse backend swaps with the same persisted rows/artifacts and assert no migration is required unless separately versioned. Error/integrity failures never trigger a second implementation. Remove duplicate TS semantic code only when its complete supported domain is covered; otherwise list retained paths in the completion ledger.

Source inspection and tests make the plan concrete, but no plan can promise perfect runtime behavior without these proofs. A decision timebox closes with a reproducible artifact: chosen design and evidence, a narrowly scoped follow-up, or a blocked adoption gate. It is not a reason to ask for redundant user permission or silently weaken acceptance.

## Architectural consultation and evidence

Full requests, exact responses, confidence and probability distributions are saved in planning evidence.

| Decision | Request 1 probability and confidence | Request 2 | Request 3 |
| --- | --- | --- | --- |
| Work-owned kernel leaf | .99 / .99 | .82 / .74 | .96 / .94 |
| Explicit backend bootstrap/selection | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |
| Bounded validation consumer/adoption join | .97 / .95 | 1.00 / 1.00 | 1.00 / 1.00 |
| Retained staged native preparation job | 1.00 / 1.00 | 1.00 / 1.00 | 1.00 / 1.00 |

All selected the same alternatives. The second work response assigns .17 to an isolated work subpath; it remains credible because it avoids another package. Source inspection found that both alternatives need a new emit/export/vendor/release route, while the subpath additionally needs strong isolation from work's state-dependent commands. The leaf makes that DAG explicit. Its package overhead is documented; if implementation proves a smaller isolated route equally clean, C01 may revise ownership with the same conformance outcomes. No probability proves correctness, performance or production readiness. Total reported consultation usage was 5,309 input and 537 output tokens.

The exact-values planning lane also ran the current values build and 424 selected TS tests across 78 suites successfully. That verifies the existing numeric baseline only. Other plan acceptance commands are inspected/current commands or explicitly future deliverables; they are not claimed as completed Rust checks. Planning verification records source hashes, document links, task references and evidence integrity; the implementation acceptance ledger remains empty until work is performed.
