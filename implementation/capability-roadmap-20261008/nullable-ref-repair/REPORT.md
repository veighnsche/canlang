# Narrow nullable singular-ref repair — candidate frozen for review

The four acknowledged State sources now carry explicit checked singular-ref nullability through the engine-local loader association and current/prepared admission, and accept null in the pipeline only for an own top-level explicitly nullable singular field. This repairs the two observed failures without changing Contracts, the Values stamp, `state-generated/v1`, the compiler/artifact, existing version checks, reference arrays, or generic default policy. The candidate is unmerged and awaits independent post-patch review.

Exact acknowledged paths and SHA-256 values are in `source-after-pins.json`; `candidate.diff` compares the frozen before sources with those six candidate paths. The five lease hashes and new-test absence were checked immediately before writes. Only four source files, the existing owning admission test, and the acknowledged new `src/mutation/nullable-ref.test.ts` changed. New proof records have null prototypes and are copied/frozen; own-key checks distinguish explicit `true` from inherited or absent values and from array metadata. Intake-direct malformed/dangling associations reject the complete set. Legacy/interim defs acquire no proof.

## Verification

The private after snapshot `/private/tmp/canlang-nullable-ref-after-db57c379` is a copy of the frozen db57 snapshot with only the acknowledged candidate State files overlaid. All own-package links target the after snapshot; installed external tooling retains the original pins. Only State was rebuilt. Both private final typecheck and the seven owning regression suites pass: **97 tests, 0 failures** (current/prepared admission, admission, descriptor join, generated CRUD, T18 defaults, secret metadata, and new nullable pipeline controls).

The first four-suite run was 55/56: a newly authored direct-pipeline fixture omitted its mandatory write ID. Its complete failure log is retained. Correcting that fixture produced the first 97/97 owning result. Final own-proof controls then added rejection of an explicitly undefined per-operation nullable map, direct inherited-field nullability, and null-to-current-ref restoration. Those unresolved boundary checks justify the final private State rebuild and 97/97 rerun; no old assertion or product check was weakened.

The unchanged original actual `Bounded` CLI artifact (SHA-256 `9f39ab8caf73621ab825eeb1db0507282d38932884d1316c9029a7be5060b343`) runs through actual `assembleModules`, `buildInvoker`, canonical State admission/storage, the existing Cloudflare runtime peer, and real local D1 via Miniflare. Identity resolution is actual, while the identity store remains a test memory store. The final fresh D1 run is **30/31 checks**; every nullable creation/clearing/replay control passes. Raw envelopes, outcomes, exact SQL snapshots, receipt hashes/defaults, versions, and history remain in `runtime-results.json`.

Positive bounded controls prove:

- Omitted nullable create fills/persists null; explicit-null create preserves null. Both commit version 1 and retain exact source-declared scalar/machine defaults. Receipt defaults record omitted null exactly once and do not count a supplied null as a resolved default.
- A supplied current versioned ref commits; update omission preserves it; explicit null clears it with exactly one version increment. Matching create/clear retries preserve exact results, input hashes, rows, history and revisions; changed payload under the same ID conflicts unchanged.
- Missing/wrong-model/noncanonical/missing-version refs, array/string ref shapes, required record null and fresh stale update still refuse before any persisted effects.
- Two actual ordered edges on the null-default-created Job retain its null ref and produce two ordered history entries at one net version. Void-scenario replay preserves state/history/hash, with the exact result representation limitation below.
- Disposing Miniflare and reopening the same private D1 persist directory with a fresh invoker preserves every SQL snapshot. Omitted/explicit-null create and clear replay exact results without additional effects after reopen.
- Public omitted-input read returns the exact three known Job IDs, numeric owning versions, and safe `StoredRow.data` projections (`title`, `count`, `enabled`, `account`, `status`), while SQL snapshots remain unchanged.

## Retained failures and limits

The final single failed check is **void scenario replay exact runtime result representation**: immediate committed result is `undefined`; replay returns `null`. No result-policy repair was made. `frozen-before-void-receipt-excerpt.json` records the same absent committed result / null replay in the immutable original before packet for independent comparison; the issue predates this candidate in the raw evidence. Persisted state/history/hash equality passes separately. We do not claim exact void-result replay qualification.

The initial after harness run was 28/30. Alongside that actual void-result issue, its read check incorrectly expected flattened fields and string versions. The complete initial harness/expectation/raw receipts remain in `initial-runtime-preserved/`. The final harness asserts the actual owning numeric-version/`data` shape and all known records, using deep structural equality; it does not accept empty/partial arrays.

The original frozen before packet remains unchanged: its verifier checks all **3,383 pins** with zero mismatches. Before nullable failures and all earlier unsupported/partial controls are retained. Runtime/persisted `count` remains string `"1"`; typed integer semantics and arithmetic remain unqualified. Public stdlib export linkage, duration metadata, source-selector/secrecy variants, full generated hooks/locks/invariants, installed identity, owner storage routing and general app scope remain open. A same-host fresh invoker plus real D1 dispose/reopen is the proved restart boundary; no external process restart or production-deployed database claim is made. This narrow repair does not close SEQ-008, SEQ-009 or parent F1.

## Release

The bounded source writer and build/runtime commands are released at this freeze. No Git, shared dist/dependency, DECISIONS, living-filetree, provenance-stamp, compiler, Values or other product edits occurred. Root/package coordinator retain integration and shared bookkeeping ownership. Independent post-patch review must evaluate the candidate paths, tests and raw before/after evidence before integration.
