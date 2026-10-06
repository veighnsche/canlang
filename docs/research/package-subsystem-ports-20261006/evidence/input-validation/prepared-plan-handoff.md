# V02.1 — Prepared owner-plan handoff (TS)

Task: V02.1 (lane `V-plan`, wave 2, after `V01` + `C02.ready`).
Implementation record; the V02.6 hook patch below is a specification for
V-integrator, not an applied edit.

- Head verified: `6388bb414c2f789ccd28ec621b7f359fb1eeda64` (lane F, merged
  main tip `46a5ece`)
- Files (V-plan owned, V02.1 scope only):
  - `packages/values/src/prepared/plan.ts` (new)
  - `packages/values/test/prepared-validation.test.ts` (new)
  - this handoff (new)
- Untouched as required: `lib.rs`, `schema.ts`, `wire.ts`, bindings,
  manifests, hooks, index/exports.

## What plan.ts provides

Immutable owner validation plans. A genuine factory owner mints an
unforgeable token (`createPlanOwner`, module-private `WeakSet` brand —
never shape-checked) and registers ordered plans extracted from
factory-produced normalized schemas. Registration deep-copies every
metadata value and freezes the plan, so post-registration mutation of
the descriptor, the normalized schema, or any caller-held object
cannot modify the plan.

Copied per registration (ordered): field/contract/enum/operation
order, allowed/required lists, canonical type copies
(`type`/`typeId`), bounds (`lengthMin/Max`, `valueMin/Max`),
trim/default metadata, `serverOnly`, `defaultOrigin`, reference
targets (nominal path / union arms / enum cases / action-delivery
targets), and the error-projection profile tag. Union dispatch stays
a copied ordered arms list; runtime dispatch resolution is V03.4's,
not this module's.

Plan IDs are issuer-assigned (`plan:<abi>:<profile>:<backend>:
<ownerRev>:g<generation>:<seq>`); no caller-controlled string sizes
any cache. Release is idempotent. Everything is synchronous.

## Provenance model (the core guarantee)

Provenance, not shape, admits a schema. `normalizeSchema` outputs
carry no marker today, so plan.ts keeps a module-private
`WeakMap<object, {factory, ownerRevision}>` populated only through
`recordFactoryProvenance` — the integrator-private seam the V02.6
factory hook calls from inside `normalizeSchema` (specification
below). Registration requires:

1. an issued owner token (hand-built `{scope}` objects fail),
2. a non-empty profile tag (recorded as the error-projection tag),
3. a schema object with recorded factory provenance,
4. provenance revision equal to the owner scope revision
   (cross-scope schemas fail as stale).

Consequences pinned by tests: forged `kind` tags, frozen hand-builts
(freeze establishes nothing), unfrozen genuine outputs without a
hook record, unknown string wrappers, foreign owners, and stale
scopes all fail with precise `PlanError` codes and stay on the
legacy `validateValue` path, which this module never touches.
`__proto__` contract/enum/operation/field names are refused again at
registration (defense in depth behind the factory's own refusal), and
value copies define `__proto__` keys rather than assigning them.

## Default registry

Each owner holds a shared frozen default registry. Registration
stores a frozen copy per defaulted field under a plan-sequence-scoped
key; `resolvePlanDefault` returns the identical object on every call
(identity pinned by test). Registry keys are issuer-assigned; unknown
or forged references fail. `EMPTY_ARRAY` canonicalization,
`UPDATE_OMITTED` preservation, and engine-resolved key-dropping stay
in `schema.ts` omission semantics — the registry stores literal
plan defaults only and asserts nothing about omission behavior.

## Preserved current semantics (fixtures)

`prepared-validation.test.ts` builds descriptors through the real
`normalizeSchema` and asserts the plan preserves, field by field:
`required` (`!nullable && !hasDefault && !engineResolved &&
!(array && !requiredArray)`), `hasDefault`, length/value bounds,
`trim`, `serverOnly`, `defaultOrigin`, canonical type copies, field
and section order, allowed/required lists, union arms, enum cases,
operation `mutation` flags, plus synchronous (never `Promise`)
behavior of every entry point.

## V02.6 factory-hook patch specification (for V-integrator)

Apply inside `packages/values/src/schema.ts` (`normalizeSchema`,
single success return at the frozen `Object.freeze({kind:
"normalized-schema", ...})`, currently the tail of the function):

1. Add a runtime import of `recordFactoryProvenance` from
   `./prepared/plan.js` and of `ARTIFACT_VERSION` from
   `../../contracts/src/artifact.js`. (No runtime cycle: plan.ts
   imports schema.ts types only.)
2. Bind the frozen output to a local, then call
   `recordFactoryProvenance(normalized,
   \`artifact-${ARTIFACT_VERSION}\`)` immediately before returning it.
   Record ONLY on the success path — every `throw new
   SchemaError(...)` path stays untouched so failed normalizations
   never gain provenance.
3. Owners bind scopes with the identical revision string
   (`artifact-1` today); anything else fails registration as
   stale-scope. No signature, export, or evaluation-order change.

Until V02.6 lands, tests call `recordFactoryProvenance` directly to
stand in for the genuine factory path; that seam is documented
integrator-private in plan.ts.

## Numerical budgets (explicitly not fixed)

Per `current-ts.json`, plan-count and plan-storage numbers are
hypotheses for V03 to measure and V07 to fix. plan.ts enforces no
numeric cap; boundedness here is structural only (issuer-assigned
sequence IDs, no caller-controlled keys). V07.5 owns the finalized
owner-plan budget and release policy; generation invalidation beyond
the `g0` tag is V03.4's.

## Adversarial controls delivered (test file)

Descriptor/default/bounds post-registration mutation (descriptor,
normalized, and mutable-seam objects); forged tags; frozen
hand-builts; unrecorded genuine outputs; string wrappers; foreign
owners; stale scopes; `__proto__` name smuggling; default-registry
identity and unknown refs; handle isolation, unknown-handle failure,
and idempotent release — 18 tests, all synchronous, repo-standard
`node:test` + `node:assert/strict` layout.
