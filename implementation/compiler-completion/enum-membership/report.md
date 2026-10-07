# Enum and membership joins: frozen implementation

Focused SEM-R08/S9-Q02 follow-up to the two independently retained failures in `../flat-stack/review.md`; this report does not claim either responsibility row is fully closed. Source/test pins and completed check counts are in `freeze.json`. No commit or shared decision/plan update was made by this worker.

## Owning facts and fixes

`decode_bare_name` searched same-module symbols by spelling before its enum fallback, so an unrelated contract field `a` produced a dangling identifier. Fixed spelling `b` also bypassed that fallback. The accepted source was already claimed correctly by analysis. `decode_name_ref` now consumes `TypeTable.resolved_cases` before those fallbacks. To distinguish enum-valued bindings from case spellings, `TypeTable.bound_names` retains only the relevant resolver-owned classification keyed by exact node identity (derived directly from `ResolveTables.node_binding`, excluding builtin/predicate/error bindings). CheckedProgram did not retain the resolver map. Explicit query/sequence/example rewrites still run before the lexical value lowering. No type or resolution inference is rerun by IR.

Membership uses `(($member,$collection)=>$collection.includes($member))(LEFT,RIGHT)`. JavaScript evaluates its arguments once in authored source order, including awaited operands, before the collection operation. Parameters are scoped inside the arrow and cannot capture either authored argument. The arrow is synchronous and adds no Promise continuation. The existing flat traversal and conditional frames are retained; long emission uses the same operation with already evaluated temps.

## Qualification

`compiler/tests/flat_expression_runtime.rs` adds actual admitted-source, check/compile/Node controls using the real built stdlib facade. Short and long `enum(a,b)` reversed equality/membership execute true and false, ordinary `draft/approved` controls execute both outcomes, enum expected argument context executes both outcomes, and colliding enum-valued parameters `a,b` stay bindings in short/long expressions. Compact, long, grouped, awaited compact and awaited grouped long membership all execute true/false with exactly `left,right` getter reads; exact left exceptions skip the right getter, and exact right exceptions follow the left read. Compact/long false lazy branches skip both awaited membership operands. The emitted scenario local-shadow control checks that `do` locals `a,b` keep their resolved slots in equality and array membership.

All 117 codegen tests passed; the two membership-shape expectations were updated to the ordered form. The final serial runtime run passed all six tests, including the unchanged exact native flat ladder at 64/512/1024/2048/3000, arithmetic overflow/grouping/lazy controls, logical recovery and unsupported-family diagnostic control. `final-runtime.stdout` and `.stderr` retain the final raw results; `final-focused.*` retain the final expanded focused runtime controls.

A concurrent runtime run had five passes and one harness failure reading an absent temporary stdout file (`Os { code: 2, kind: NotFound }`, test harness line59). Its `runtime-tests.*` receipt is retained. The root cause of that temporary-file loss was not established. The other overlapping run and the final serial run passed the ladder. No concurrency-harness fix is claimed.

Scenario locals are qualified through actual check/compile and emitted resolved slots, not through Node execution: the real stdlib still lacks the scenario gate exports described by the prior independent review. `local-shadow.can` and its actual compile artifact are retained. No universal structural-depth, microtask-interleaving, all-operator, scenario-facade, or whole-row closure claim is made.

## Proposed decision text

Accepted implementation choice, pending independent review: preserve checked enum-case claims and resolver-owned lexical name classification through the checked-program-to-IR join; do not reconstruct enum meaning from global same-spelling declarations. Emit collection membership with left and right operands as ordered synchronous call arguments, retaining existing flat traversal and lazy grouping. Remaining uncertainty: complete scenario-local runtime qualification depends on the separate real-stdlib gate export join; unrelated whole-row semantic outcomes remain outside this bounded evidence.
