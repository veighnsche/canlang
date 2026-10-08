# Independent Invocation producer join review

Verdict: **ACCEPT the bounded existing producer join**, conditional on the separately reviewed checked static operation-target IR precondition. No substantive defect found in the Invocation changes to `compiler/src/codegen/js.rs`, the verbatim public facade export, or the focused integration fixture. This does not accept the draft §13.4 API as implemented or qualify invocation execution/admission.

## Source and owner facts

The direct check imports the actual generated artifact through public package exports. `execute.mjs`, `artifact.json`, generated modules, focused raw logs, and illegal-shape fixtures remain the bounded behavior evidence. Static target IR correctness is separately owned by `review_checked_action_targets` and remains a precondition here.

`packages/values/src/stdlib-pure.ts:364` implements `invocation(target, args)` as a pure packaging constructor. It validates constructor shape, preserves argument property order, and returns the existing `makeInvocation` value. `kinds.ts:281` preserves nested versions as-present and shallowly freezes copied carrier objects. It does not consult an operation schema, authorize, hydrate records, dispatch targets, supply missing business arguments or enforce mutation expected versions. The facade exports that exact binding; there is no wrapper, rename, context parameter, coercion or test-only import remap.

`packages/values/src/types.ts` owns `invocation(targets)` with ordered, distinct target paths and suffixes `?`, `[]`, `[]?`, `[]!`. `internal/schema-core.ts:940` rejects unknown FieldDescriptor keys; shape is part of `type`, not descriptor keys `nullable`, `array`, `requiredArray` or draft `operations`. `internal/wire-core.ts` restricts invocation targets and accepts typed argument wire envelopes. Its argument encoder infers scalar/native-carrier tags; nominal contract/union arguments need schema-aware owner admission, which this join does not implement.

`canonical_type_id` now emits the checked target symbol identities in authored list order. `invocation_base` selects only Invocation or its nullable/array wrappers, so the existing Action schema branch stays unchanged. Invocation `field_schema_object` emits exactly a canonical `type` property; the outer non-null field-array marker alone appends `!`. Nullable arrays use `[]?`; the illegal combined marker never reaches this emitter from legal source.

Actual source checking forbids empty target sets (`analysis/types.rs:9720` returns Error), and constructor substitution creates a singleton Invocation or an Opaque failure. Existing-binary controls under this directory independently reject bare `invocation` (E2001), `invocation()` (E1213), and combined nullable-required-array syntax (E1213). A manually forged public IR value with an empty target vector could produce `invocation()`; that is outside this checked-source acceptance. No generated-source failure was found.

## Verification and interpretation

Reused unchanged focused raw receipts: `tests-final.log` reports 2 runtime/compiler integration tests; `checker-invocation.log` reports 3 existing checker tests; `stdlib-assembly-final.log` reports 4 public-facade assembly tests; `stdlib-build-final.log` is the completed build output. No additional compiler rebuild or broad suite was run.

Independently replayed the copied emitted artifact against actual `@canlang/stdlib` and `@canlang/values`, with the unmodified integration fixture; see `fixture-replay.log`. Alias canonical owner identity is covered by the focused Rust test. The emitted contract contains and directly normalizes/validates/codecs all six authored shapes: singleton, nullable singleton, ordered multi-target choice, ordinary array, required array, and nullable array. The fixture imports the real facade, checks exact public binding identity, native versionless record/Decimal/text construction, ordered arguments, freezing, wrong-target rejection and codec round-trip. It performs no schema-key filtering.

Independently added `owner-controls.mjs` against those same actual emitted fields. `owner-controls.log` proves canonical parsing/printing, authored target order, ordinary-array omission to empty, nullable omissions to null, required-array omission rejection, required scalar null rejection, array/null codecs and allowlist rejection. Negative descriptors using legacy `nullable` or draft `operations` fail with the real closed schema normalizer.

The getter trace proves generated handler destructuring reads supplied inputs exactly once in parameter order. The named constructor source has static target identity plus pure local argument expressions; inspected emitted IIFE/array scheduling preserves source argument order before formal-slot reordering, and the result preserves authored object property order. This fixture does not claim a general effectful-call or platform evaluation-order proof.

The default witness explicitly passes `appDefinition.operations[...].inputs.*.default` to the direct handler. Omitting scalar inputs yields undefined and packaging rejects them. It proves emitted default **data** and construction with admitted values, not direct-handler default application or State/Cloudflare admission. No mutation target executes in this fixture.

`owner-controls-first-prototype-mismatch.log` retains an initial incorrect review assertion: Node deepStrictEqual rejected a cloned Decimal because its class prototype changes. The corrected proof uses the actual `isDecimal` and `equalValue('decimal', ...)` owner APIs plus exact coef/scale and distinct pointer/prototype assertions. Native scalar value semantics survive; pointer and class identity are not preserved. This is expected current Values behavior, not a join regression.

## Remaining boundary

No missing test blocks this bounded schema/facade join. Existing CRUD helper exports/emission, row hydration, checked owner-schema completeness/version admission at the platform boundary, State/Cloudflare execution, authorization, rollback/replay and generic contract/union argument wire encoding remain open. The draft DESIGN §13.4 `{type:"invocation",operations:[...]}` and proposed `invocation(c,...)` differ from the implemented Values owner. The existing owner vocabulary is accepted on its own current contracts; no authority/backend or execution capability is inferred from the draft or this join.

The review wrote only under `implementation/compiler-completion/invocation-join/independent-review/`. It did not change production source, root decisions/coverage/status, Git history or broad-suite state.
