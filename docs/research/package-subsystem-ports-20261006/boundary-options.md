# Better boundaries for package subsystem ports

October 6, 2026. Inspected checkpoint: `30e211dae891cfdca3f6322ce45c46c426138830`. This extends the [four-candidate evaluation](full-evaluation.md). Existing functionality under `packages/` remains the source-port scope; compiler changes remain excluded. No implementation, deployment or new runtime benchmark was performed.

Larger coherent operations can improve a migration when they retain data, remove duplicated policy or move several stages behind one host call. Merely moving more files does not remove compatibility requirements. Current helpers already call each other inside JavaScript without an FFI boundary; the proposed Rust boundary would introduce that cost. The purpose of redesign is to avoid unnecessary new crossings while giving Rust a useful responsibility.

The strongest changes are: an owned-input values pipeline; shared work/state row and transition semantics; and one local artifact/release/plan preparation operation. Common binary delivery is useful enabling work for all Worker-facing ports and can remain TypeScript.

## What changes the feasibility estimate

| Previous candidate | Better declared boundary | Conditional estimate | What actually improves |
| --- | --- | --- | --- |
| Arithmetic, 7/10 | Exact representations, math, structured types, numeric bounds, aggregates and wire encoding within complete calls | 7–8/10 | Shared representations and fewer internal leaf/conversion crossings; scalar JS expression calls still need conversion |
| Full unknown-input validation, 5/10 | Prepared whole-input checking/normalization/encoding over parser-owned inert data, with legacy JS APIs retained separately | 7–8/10 for this new path | Getters/proxies/cycles are outside its proven input domain; ordinary transport still needs exact text, numbers, keys and errors |
| Work helper decisions, 7/10 | Shared work/state row codecs, lifecycle transitions, receipt/recovery policy and conditional-batch linkage assertions | 7–8/10 after consolidation and host-interface proof | Removes real mirrors and repeats less row conversion while retaining live host checks and atomic commit |
| Artifact helper calculations, 7/10 | One native local preparation operation covering artifacts, release facts, module graph, compatibility, plan/review and staged output | 7–8/10 after native adapter/distribution proof | Keeps artifact/graph/buffers owned through the job and returns compact review/result data |

These are design estimates for changed scopes after the named preparation, not new measured scores. A preserved complete legacy validator remains approximately 4–6/10 even inside a larger core. The new owned-input path does not complete that legacy port. The work/native-preparation expansions also contain more implementation work than their original helpers. Reduced interop can justify it, but their estimates depend on demonstrating those interfaces.

## Values: combine stages and own the input

Put exact arithmetic and carriers, structured type IDs, ordered schema plans and codecs together under `packages/values/semantics/`; use `bindings/` for loading and host conversions. [Normalized fields already have type ASTs](../../../packages/values/src/schema.ts), while leaf/union traversal reparses strings. Prepare leaf/union dispatch once in either language.

A useful new operation is conceptually:

```text
parser-owned input + registered operation plan
  -> complete check / normalization / ref extraction
  -> requested aggregates or encoding
  -> wire result or one TS materialization
```

This is a proposed private boundary, not a currently implemented function. Its caller must already own the data. [HTTP operations](../../../packages/interfaces/src/http/operations.ts) parses JSON/form input before framing and bounds checks. [Interfaces bound checking](../../../packages/interfaces/src/mcp/schemas.ts) has real HTTP/MCP consumers and now delegates datetime checking to the values codec. These are stronger migration consumers than isolated leaf exports.

A token produced by the actual parser can identify fresh owned data. A public function accepting arbitrary `unknown`, a TypeScript type annotation, `Object.freeze`, or an object inspection cannot establish that it contains no accessors/proxies. Existing unknown-input APIs keep their current TS evaluation path. Do not snapshot them early and call the result compatible.

Parser-owned data still needs lossless UTF-16 text/keys, JS enumeration ordering, own `__proto__` data, numbers and profile-specific presence. Can's opaque `json` codec rejects every number and is unsuitable as a generic request transport. Host JSON parsing can remain initially to preserve syntax diagnostics and number parsing. [js-sys exposes UTF-16 code-unit operations](https://docs.rs/js-sys/latest/js_sys/struct.JsString.html); ordinary conversion to Rust strings can replace unpaired surrogates.

Whole-input interfaces checks should use prepared plans, with explicit behavior profiles. Interfaces framing reports the first unknown/missing field and uses own presence; values accumulates violations and has different undefined behavior; state ref versions have their own accepted domain. Share matching mechanisms, not an invented universal validation policy. Artifact-derived field descriptors are not automatically a complete values schema.

Rust-owned handles can retain values through a real multi-stage pipeline. Explicit request lifetime/disposal, bounded plan caches and materialization rules are prerequisites. [wasm-bindgen exports Rust types through JS wrappers](https://wasm-bindgen.github.io/wasm-bindgen/reference/types/exported-rust-types.html), but a wrapper is not the existing structural BigInt/Decimal API. Generated or handwritten JS still needs `.coef`, `.minor`, BigInts and objects. Keeping those expression chains entirely in Rust would require an execution/lowering redesign beyond the package-only scope. Introduce handles only when a measured consumer can actually keep work inside the core.

## Work: include shared rows and transitions

The useful expansion spans package ownership: [work row codecs](../../../packages/work/src/kernel/tables.ts), [state fanout rows](../../../packages/state/src/fanout/tables.ts), [state outcome/checkpoint staging](../../../packages/state/src/fanout/outcome.ts), receipt observation/recovery and [commit linkage assertions](../../../packages/state/src/ports/transact.ts). State explicitly restates work shapes, and production [Cloudflare durable claim/record](../../../packages/cloudflare/src/runtime/invoke.ts) behavior is outside work's test-only memory store.

First extract matching row/transition mechanisms with existing producer ownership and wrapper error profiles. Port those together, using ordered typed rows and opaque host payload handles where needed. TS obtains live rows, membership, guards and provider evidence; Rust computes transitions and conditional batches; the host performs the authoritative fenced commit. This preserves concrete policy while avoiding separate ports of each mirror.

A later Rust request/resume session could request `load`, `query`, `checkpoint`, `snapshot`, `guard`, `authority` and `invoke`, retaining intermediate state until it returns a conditional commit batch. This is a larger control-flow project, currently closer to 6–7/10 until the protocol is extracted and proved. It must preserve refusals, demand-driven callbacks, exceptions, fresh reads, expected versions/revisions, single-shot commit and caller-controlled retries. Keep [the existing reader-only staging seam](../../../packages/state/src/ports/system.ts).

Moving DB, memberships, generated handlers and providers wholesale adds platform and permission complexity. It does not remove the need for live checks or atomicity. Some outer orchestration orders are intentionally different; consolidation must preserve them rather than eagerly precompute all verdicts.

## Artifacts: own one local preparation job

Expand to [artifact loading/checks](../../../packages/cloudflare/src/runtime/artifact.ts), [release manifests/version facts](../../../packages/cloudflare/src/release/manifest.ts), module inventory/graph/output, [compatibility/planning](../../../packages/cloudflare/src/deploy/compat.ts), [rendering](../../../packages/cloudflare/src/deploy/render.ts) and [review/diffs](../../../packages/cloudflare/src/deploy/review.ts). A responsibility-based directory is `packages/cloudflare/preparation/`.

The native operation can retain artifact indexes and module buffers, then return manifest/plan/review data. Preserve additive metadata, first-error ordering, arbitrary source-map/JS text, deterministic bytes and current digest contracts. A new typed binary bundle hash is a versioned contract change, not byte parity with today's JS-source serialization. [Serde RawValue](https://docs.rs/serde_json/latest/serde_json/value/struct.RawValue.html) can retain uninspected JSON spans verbatim; it is an implementation option, not proof of complete JS parsing/canonicalization parity.

Two build boundaries remain real: [bundle.ts](../../../packages/cloudflare/src/deploy/bundle.ts) invokes Bun for the MCP bundle and calls the owning interfaces catalog derivation for `derived-inputs.js`. Consume prebuilt outputs or use one coarse JS build adapter. That adapter may parse the artifact separately; do not promise globally single parsing. Replacing Bun or duplicating interfaces derivation merely to remove the last adapter increases scope.

Keep activation producer checks and Wrangler application with their current owners. Preparation/preview must preserve the current absence of deployment-file writes; later output/apply must use the exact reviewed bytes. Native artifact preparation needs platform distribution but avoids the Worker binding problem for that operation. It is not a prerequisite for the shared Wasm asset pipeline.

## Practical levers across all candidates

| Lever | Concrete change | Evidence needed before raising confidence |
| --- | --- | --- |
| Define the compatibility target | Separate unchanged public JS APIs from a new private parser/row-owned contract; document accepted inputs and observable outputs | Tests for both paths, including legacy fallback and real production callers |
| Batch complete operations | Check a whole input, process a page of rows, compute an aggregate or prepare a bundle in one call; avoid per-leaf exports | Complete-call measurements against existing and prepared TS |
| Retain intermediate data | Keep decoded rows/values/module buffers through actual native stages; materialize at entry/exit | Memory, disposal/cancellation, aliasing and shared-default identity tests |
| Register prepared plans | Resolve ASTs, leaf codecs, union arms, bounds/default metadata once under immutable owner-produced plans | Schema mutation/provenance and cache-bound tests; no unbounded caller-string cache |
| Consolidate real mirrors | Share matching row/transition/canonicalization primitives before porting; keep differing error and policy profiles explicit | Existing cross-producer parity plus negative/malformed-input cases |
| Use an explicit ABI | Version ordered tagged input/result/error shapes; preserve UTF-16, presence, raw BigInt operands and opaque host values where applicable | Differential carrier/error/key/number/identity tests through the actual adapter |
| Make callbacks explicit | Supply pure decision facts only where the current order allows it; otherwise use demand-driven host requests | Recorded call/exception/refusal traces, fresh-read and retry behavior |
| Build shared binary delivery once | Typed JS/Wasm inventory, byte-safe writing/digests, pinned initialization, manifest coverage and testkit propagation | Actual workerd loading; missing/corrupt module failures; reproducible outputs |
| Match backend to host | Wasm for shared Worker/runtime kernels; native local preparation where it owns a whole job; keep simple JS glue | Supported-host release/loader tests and startup/conversion cost |
| Reuse owning catalogs/contracts | Derive or verify Rust metadata against current package producers; keep responsibilities and public types with their owners | Drift/version tests, no independent copied currency/type/operation catalogs |
| Resolve true contract gaps | Specify new-path resource/lifetime limits and binary/digest formats; treat changed ranges/text/strictness as versioned behavior | Declared semantics and migration fixtures rather than silent parity changes |
| Prove the repository path | Prototype native semantics, the real binding and delivery, then useful end-to-end workloads | Differential tests, startup/warm/error-path CPU, memory and binary-size evidence |

One ordering rule survives every expansion: [state admission](../../../packages/state/src/invocation/admission.ts) reads the revision, hashes raw inputs and checks receipt replay before age, authorization and normalization. Keep raw and normalized representations distinct. A successful replay must not begin failing a new validator, and inserting defaults must not change receipt identity. A broader core may expose staged operations or a resumable session; it cannot fuse these stages before the host receipt/auth checks.

[Canonical receipt serialization](../../../packages/state/src/invocation/replay.ts) observes `toJSON` and getters and uses JS key/number rendering. A strict parser-owned encoding path can remove those objects from its domain; the old API still needs its behavior. More generally, narrowing integer operands, changing lone-surrogate support, switching synchronous signatures or changing persisted digests is a behavior/version decision alongside migration, not evidence of complete old-API parity.

## Other existing package code worth considering

These are adjacent opportunities, not instructions to add every one to the first port. The most useful additions reuse data already owned by a native operation.

| Existing responsibility | Useful boundary and relationship | Limitation |
| --- | --- | --- |
| Interfaces input descriptors and binding checks | Prepared operation plans and whole-input checks alongside values; [schemas](../../../packages/interfaces/src/mcp/schemas.ts), [framing](../../../packages/interfaces/src/envelope/validate.ts) | Keep framing/bounds/values/state error profiles distinct; HTTP/MCP servers and SDK remain host-owned |
| State canonical encoding and receipt hashes | One owned raw-input encoding/hash operation alongside values; [replay.ts](../../../packages/state/src/invocation/replay.ts) | Exact JS number/string/key rendering and replay compatibility; existing crypto already executes natively |
| State batched read processing | Row-path/predicate evaluation, projection, sorting and aggregate folds over owned row batches; [grants](../../../packages/state/src/policy/grants.ts), [query engine](../../../packages/state/src/query/engine.ts) | Viewer projection precedes user predicates; host authority/fence reads remain. Existing Number/money aggregation is not automatically Can exact arithmetic |
| Staged-set uniqueness/reference checks | A snapshot checker with indexes alongside owned state rows; [migration validation](../../../packages/state/src/migration/validate.ts) | Full migration also runs JS invariant callbacks and scans/activation. Extract data-only checks first; retain scalar canonicalization policies |
| File byte/content-policy checks | Batched magic detection, UTF-8/size/type policy and metadata alongside native byte ownership; [upload checks](../../../packages/files/src/upload/index.ts) | Small current algorithm, no demonstrated bottleneck; full upload/finalization/storage/authority flow adds different responsibilities |
| Pinned media graph mapping | Validate and substitute a graph in one operation with retained metadata/buffers; [mapping.ts](../../../packages/services/src/media/mapping.ts) | Adapter-owned known configuration, not a general graph compiler. Its canonicalization differs from receipt hashing; network/provider work stays separate |

The query candidate could offer more substantial batch work than scalar helpers, but permission-aware projection makes it a separate evaluation, approximately 6–7/10 for the bounded extracted path until parity is demonstrated. Owned staged-set checks are also credible, but the whole migration engine is not a data-only validator. File byte checks are easy bounded code with weak demonstrated payoff. Adding them merely to increase migrated line count would not improve the core migration.

Keep UI composition, live identity/session/membership handling, HTTP/MCP routing, generated-handler execution and service network orchestration out of the first tranches. Their current host dependencies do not disappear by moving neighboring math or validation. Compiler lowering/execution and full native platform replacement would be separately scoped projects.

## Recommended preparation order

1. Map real callers and declare old versus new input/output profiles, including receipt/error/callback ordering. Extract matching TS rules so cross-package ownership is reviewable before translation.
2. Add binary-safe delivery and one real Wasm smoke test in the existing Cloudflare/testkit path. This enables multiple kernels even if the preparation tool remains TS.
3. Prepare shared value/type/operation plans and a parser-owned input path. Compare the prepared TS implementation before moving complete operations into Rust.
4. Prototype the combined values core with native conformance and an actual HTTP/input-binding or aggregate consumer. Materialize once; add arenas only when a multi-step consumer warrants them.
5. Port shared work/state row and transition mechanisms; add resumable orchestration only after pure policy, batch linkage and durable fence parity hold.
6. Evaluate the native local preparation job with explicit Bun/interfaces build inputs and byte/preview/distribution parity. It can proceed independently of runtime policy after contracts are ready.
7. Consider query/migration/file/media additions only when they reuse established owned data or have a measured independent need.

These steps can improve architectural feasibility and confidence. Higher confidence should come from the explicit contracts, removed duplication and verified integration, rather than relabeling a smaller contract as the original full port.

## Independent advice and evidence

Three focused source reviews covered values/ingress, work/state lifecycle and local preparation. Three independently worded equivalent JEV `choice` consultations compared the same bounded alternatives against compatibility, workflow preservation, ownership, interop and maintenance. All chose the owned values pipeline, shared transition core and local preparation job. [Request/response 1](evidence/boundary-options/result-1.json), [2](evidence/boundary-options/result-2.json), [3](evidence/boundary-options/result-3.json).

| Selected strategy: probability / confidence | Consultation 1 | Consultation 2 | Consultation 3 |
| --- | --- | --- | --- |
| Owned-input values pipeline | .97 / .94 | .99 / .99 | .89 / .84 |
| Shared transition core | 1.00 / .99 | .92 / .89 | .98 / .98 |
| Local preparation operation | 1.00 / 1.00 | .99 / .98 | .98 / .98 |

There was no selected-option disagreement. The third values consultation assigned .11 to TS preparation; the second work consultation assigned .08 to resumable commands. These alternatives remain substantive: prepared TS can solve much repeated dispatch work, and sessions can reduce later orchestration copies at extra complexity. Near-unanimous model advice does not establish measured cost or implementation parity. Choices compare conditional designs; they are not adoption approval or calibrated feasibility scores. Raw uncertainty is retained without averaging. The model was `jev-1.13.0`; reported usage was 5,871 input and 456 output tokens.

Compared with the earlier evaluation, current artifact/bundle code also derives operation metadata through interfaces; the earlier helper boundary cannot be assumed unchanged. This round traced current source and consulted primary API documentation; it did not rerun the previous 431 baseline tests or claim they validate these proposals. [Source snapshot and evidence checks](evidence/boundary-options/verification.json) identify the inspected files and retained requests. No production source or living file-tree checkpoint was changed.
