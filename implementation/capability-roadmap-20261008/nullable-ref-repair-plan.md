# Nullable singular-reference repair proposal

**Proposed only; await root's exact lease/pins ACK before product writes or repair commands.** The independent source-contract review supports this State-only repair. No product source/dist/dependency, Git, DECISIONS or file-tree changes were made while preparing it.

DESIGN.md:124–133 already makes `T?` omission default to null and permits explicit null; partial update omission stays unchanged. `ArtifactOperationInput.nullable` owns the explicit input association. `CanonicalInputDef` has no nullable slot. The frozen runtime receipt exposes two separate losses: input admission discards that association, and pipeline reference validation rejects the model table's existing known-nullable null fill. All five existing proposed write paths currently match their frozen db57 baseline bytes.

## Exact write boundary

| Path | Proposed change |
| --- | --- |
| `packages/state/src/invocation/registry.ts` | Carry checked artifact nullable singular-ref input names through an optional engine-local `inputNullableRefs: Readonly<Record<string,true>>` channel; validate/copy/freeze that channel during loading and prepare the attached plan from the same association. |
| `packages/state/src/invocation/admission.ts` | At the existing generated ref-shape check, accept explicit null only for that own checked marker, preserve normalized null, and append no pending ref. |
| `packages/state/src/invocation/prepared-inputs.ts` | Optional third marker argument for descriptor preparation; copy an optional true primitive into ref rules and make the exact same null-only exception. |
| `packages/state/src/mutation/pipeline.ts` | At the existing ref-null rejection point, accept null only when the path names an own top-level field whose checked definition has `nullable:true` and no array marker. |
| `packages/state/test/invocation/owned-admission.test.ts` | Add loader-produced marker/provenance and exact current/prepared differential cases; preserve every existing pin. |
| `packages/state/src/mutation/nullable-ref.test.ts` | New focused owning loader → canonical invoke → pipeline and direct-boundary tests. File is absent in main and frozen snapshot. |

Exact SHA-256 pins and new-file absence are in the companion JSON. The write boundary contains no Contracts, Values, compiler, Cloudflare, model-table builder, package manifests, dependencies or generated dist edits.

## Minimal implementation

1. Extract a marker only when the already checked artifact input has its **own explicit `nullable:true`**, a checked singular `ref` tag/model/version requirement, and no array marker. Absent, false, non-true and inherited additive nullable values retain existing no-proof behavior. Do not infer from `required:false`, model/field name, target model or caller inputs. This does not introduce a general malformed-additive policy.
2. Follow the existing `inputArrays` engine-local channel. Artifact loader caller options omit both channels; the artifact owns their values. Intake-direct marker options must name existing operations and singular ref inputs and contain only true markers; reject dangling/non-ref/array/non-true engine-local associations as whole-set errors. Construct and inspect records with own-key-safe operations, copy their values, and freeze the per-def record. Preserve legacy synthetic and hand-built defs through an optional member and empty/absent marker behavior.
3. Build attached prepared plans with the same checked record. Keep existing two-argument `prepareDescriptorInputs` callers valid with an optional third argument. Copy an optional true primitive into a prepared ref rule; retain no live map/set/descriptor link. `prepareOperationInputs` forwards the generated def's association. Both validators preserve presence handling, unknown-member/error order, array rules, non-null id/version validation, extra-ref-member permissiveness and shallow-copy behavior. Null is retained; omitted optional values are not filled at admission; `undefined` is not null. The `state-generated/v1` tag and public descriptor/version/Values stamps remain unchanged.
4. Leave model-nullability propagation alone: it already reaches `InterimFieldDef.nullable` through `nullableFields`. In `checkRefs`, retain the current missing/unchanged-reference checks first. Before rejecting a changed/present null, require an own, non-dotted top-level field with `nullable === true` and `array === undefined`. Otherwise keep the current error. Non-null values retain exact id, target existence and archived-target checks. Keep required/server-only/unknown-field checks, hooks, locks, invariants, unique handling, disposal scans, history, attribution and receipt/fence order untouched.

This is an implementation of an existing source contract, not a new generic nullable/default policy. No language-design disagreement requiring JEV was identified by the independent review. If implementation requires array elements/nested paths, source ownership inference, new descriptor/profile versions, Values semantics, secrecy or replay-authorization decisions, stop that extension and hand it back to the defining owner.

## Meaningful focused tests

Extend `owned-admission.test.ts` using **loader-produced defs and their attached plans**, with exact current/prepared result or field-error equality:

- Explicit nullable null survives normalization and creates no pending ref; omission stays omitted; required presence and unknown-member aggregation retain exact order.
- Valid, missing and noncanonical versions on non-null values; malformed object/string/array/undefined values; optional nonnullable/unknown null refusals; extra members remain tolerated.
- Absent/false/non-true/inherited artifact nullable markers and array-of-ref inputs preserve the previous behavior.
- Own-key names (`constructor`, `toString`, `__proto__`), copied immutable markers, independent fresh plans per load, mutation of source input/option records, and dangling/non-ref/array/non-true engine-local associations.
- Existing scalar/ordinary-array/interim/default tests and the v1 profile tag remain intact.

The new `nullable-ref.test.ts` uses labeled unit artifact slices (not compiler-output qualification) and actual generated CRUD/canonical pipeline owners:

- Omitted and explicit null creates persist null at version 1; creation resolves null once; matching replay adds no row/history/version/default evaluation.
- Valid ref → null clearing, update omission preserving the previous value, null → valid current-ref update, and successful duplicate replay.
- Optional nonnullable and unknown-nullability null refusals; unchanged refs to subsequently archived targets preserve their existing allowance; malformed/missing/archived refs and stale/missing versions preserve exact denials and no domain effects.
- Required/server-only/unknown inputs still reject at their existing checks. Direct pipeline dotted/nested and array-associated ref paths cannot borrow top-level/container nullability. No secrecy semantics are inferred or widened.

Build/typecheck State once in the isolated after-repair output context after ACK, then run the focused new/owning suites plus existing admission, descriptor-join, generated-CRUD, T18-defaults and secret-metadata regression suites. Run broader tests only if those results or the actual change justify them. No checks were run during this proposal.

## After-repair real qualification

Keep `f1-invocation/` and its frozen source/dist/private outputs unchanged. After ACK, create a separate private snapshot/output root from the frozen db57 baseline, overlay **only the four acknowledged State source candidate changes** (the current pre-write files match that baseline), and pin the exact patch/source/output/import links. Remap all private `@canlang` links to that after snapshot so no before dist or main workspace output is consumed accidentally. Use the existing compiler binary and the **unchanged actual Bounded CLI artifact**; do not edit emitted modules/descriptors or provide handbuilt replacements.

In a separate after-evidence directory, use production assembler, canonical invoker and D1 adapter with the existing compatibility runtime peer, actual identity resolver/live membership reader, and persisted Miniflare D1. Verify omitted nullable create, explicit null create, clearing a ref to null, update omission, valid current refs, wrong model/missing/stale/version negatives, successful/error duplicate receipts and fresh-invoker dispose/reopen persistence. Capture exact runtime/persisted defaults and versions, SQL row/history/receipt/fence snapshots and raw input hashes. Recheck ordered machine behavior and rollback on the unchanged source/control contracts if the focused change or results affect them.

After nullable creation succeeds, the public read model legitimately contains more known records than the before packet. The after harness must assert the exact expected rows and safe field projections for all successful source-declared creations, rather than reusing the before run's one-record expectation or weakening it to an array/empty check. Preserve the before harness and failures unchanged.

Public stdlib import union, numeric default hydration/arithmetic, source-declared selector/secrecy variants, full generated hooks/locks/invariants, installed identity and owner storage routing remain separate gates. A nullable repair and its bounded after receipt do not close SEQ-008/SEQ-009/F1 or qualify general typed/default semantics. Independent post-patch review is required.
