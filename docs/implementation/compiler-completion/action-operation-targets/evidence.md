# Checked action and invocation operation targets

Implemented only the existing checked constructor target conversion. The builtin winner must be `action` or `invocation`, the actual catalog formal must be `ActionTarget`, its checked slot must identify this supplied argument, and the argument's published type must be `Operation(SymbolId)`. The existing symbol's canonical identity becomes a typed text literal for the existing runtime constructor. Other arguments and missing facts retain ordinary lowering. No public IR API, first-class operation policy, runtime package, analysis gate, or authority grant changed.

The installed owner boundaries were verified in `packages/values/src/catalog.ts`, `packages/values/src/stdlib-pure.ts`, `packages/values/src/kinds.ts`, and `packages/stdlib/src/index.ts`. Catalog and owner pins are saved before and after. `action` is a verbatim stdlib reexport; its bindings require native versioned RecordRefs. Invocation exists in values but is absent from the stdlib export assembly.

## Evidence

- `before.can` + `before.json`: legal checked source including imported CRUD alias and reordered named target; compile fails E6008 for local scenario operation targets before the patch.
- `alias-after.json`: that same source compiles after the patch. Canonical CRUD target strings preserve `stock.Widget.*`, matching CompileArtifact operations.
- `after.json`: final local runtime fixture artifact.
- `tests-first.log`: preserved first failures, including actual missing stdlib `create` import for generated CRUD modules and explicit invocation result schema E6008. These failures were not suppressed or asserted as passing.
- `tests-second.log`: 3 focused cases pass after restricting the runtime claim to executable installed-owner action paths and making invocation construction a local binding.
- `tests-final.log`: 4 action-reference tests and all 117 existing codegen tests pass.
- `tests-action-final.log`: final 5 action-reference tests pass, including bare operation values staying E6008 outside constructor targets.
- `checker-action.log` and `checker-invocation.log`: existing focused checker controls, 2 and 3 tests respectively, pass.
- `runtime-version.txt`: actual Node version used.

Runtime action assertions exercise actual emitted JS through installed public owners: local scenario canonical identities, reordered named target/bindings, empty bindings, immutable descriptors, preserved record identity and bigint expected version, input read once, and rejected versionless/non-RecordRef bindings. No target operation is invoked. CRUD aliases are qualified for checked canonical emission and operation metadata identity; importing their generated modules fails at existing unavailable CRUD helpers. Invocation canonical target construction compiles as a local binding; actual values-owner invocation preserves versionless RecordRefs and native Decimal values. No generated invocation execution is claimed.

Invalid read, trusted handler, arbitrary text target, missing binding, non-record binding, business scalar binding and incomplete invocation retain E3005. Non-record business parameters remain inputs; action does not bind scalar defaults. Existing slot mapping and source evaluation order are reused without duplicating a binder or adding default/null substitutions.

## Remaining boundaries

Stored-record values are not demonstrated to hydrate into the versioned native RecordRefs required by `action`; direct native RecordRef constructor controls qualify only that precondition. The minimal native callable context used by the runtime fixture is not a canonicalState/worker admission replay. No action descriptor confers authority, and construction tests do not qualify authorization/admission/replay. Explicit invocation result/type-schema lowering remains E6008, generated invocation imports lack the stdlib export, and actual CRUD module imports lack create/deleteRecord/set. Those owners require separate changes. Broader S9/SYN references remain open.

No JEV, network, pricing estimate, or broad package suite was used. CLI artifact evidence and test logs are saved as returned in full; no raw body truncation or oracle-body limits were introduced. Baseline executable pin records only the pre-edit profile and is not a claim about the new compiler. No merge or checkpoint advancement occurred.

## Independent review correction: computed targets

The independent effect/order review found the original substitution was too broad: an `Operation` result type does not establish that evaluating the source expression is inert. `action(choose(1 / 0 == 0.0,mutate,mutate),{})` compiled and returned data while skipping a predicate that independently threw Division by zero. Invocation `choose(...)` and `({x=mutate}).x` were likewise erased. The reviewer's original raw sources, artifacts, runtime failure controls and pins remain intact under `independent-review/`.

Corrected the substitution to require an anchored static identifier reference path: NameRef, or Member with exactly one expression receiver recursively satisfying that same restriction. Calls, arbitrary Object receivers, and groups retain ordinary lowering and E6008. Grouped static references remain an explicit unsupported boundary; this correction does not claim computed operation workflows are implemented.

A general recursive target decoder would need to preserve each owning composite's evaluation rules, source order and once semantics while changing operation leaves into text; merely walking an Operation-typed result is insufficient. No such policy was introduced. The existing constructor contract is now applied only where syntax has no discarded value computation.

The parent invocation worker subsequently added the public stdlib invocation reexport. `pins-reviewed-correction.txt` records that current facade source/build profile separately from initial pins. The original missing-export observation above is historical evidence, not a current missing-export claim. This action fixture still qualifies only native values-owner invocation construction and canonical emission; generated invocation runtime/schema qualification is assigned to the parent's invocation owner.

Correction verification: `tests-reviewed-correction.log` passes six action-reference tests and all 117 existing codegen tests. `tests-reviewed-action-current.log` records the final six-case run with accurate current-profile runtime output. `choose-throw-after.json` recompiles the original independent-review throwing source and now returns E6008. The three `correction-*.can` / `.json` pairs save full checked composite refusal bodies; `pins-correction-repros.txt` pins those bodies and the actual compiler binary used. No originally captured review failure was overwritten.
