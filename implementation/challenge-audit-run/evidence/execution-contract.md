# T04a execution contract — agreed slice

Slice T04a of T04 (Agree the generated execution contract). Accountable lead:
L3. Contributors consulted via read-only scan: L1 (codegen/artifact), L2
(values), L6 (identity/wire), L7 (testkit/e2e loaders). Base: c681d86,
branch codex/challenge-audit-implementation.

Status: agreed contract text + L3-owned `state.ts` intake. L1 (`artifact.ts`)
and L7 (`examples.ts`) changes are owned by later writers; their agreed
interface expectations are recorded below and those files are untouched.

## 1. Interface version

T04a freezes execution-contract version **1**
(`EXECUTION_CONTRACT_VERSION = 1` in `packages/contracts/src/state.ts`) with
these pinned producer versions (`T04A_PINNED_VERSIONS`):

| Contract | Constant | Pinned |
| --- | --- | --- |
| execution (this slice) | `EXECUTION_CONTRACT_VERSION` | 1 |
| artifact (L1) | `ARTIFACT_VERSION` | 1 |
| state (L3) | `STATE_CONTRACT_VERSION` | 1 |
| values (L2) | `VALUES_CONTRACT_VERSION` | 1 |
| identity (L6) | `IDENTITY_CONTRACT_VERSION` | 1 |
| wire (L6) | `WIRE_CONTRACT_VERSION` | 1 |
| examples (L7) | `EXAMPLES_CONTRACT_VERSION` | 1 |

Growth is additive-only. T04b extends without changing these rules.

## 2. Producer/consumer agreement inputs

- L1 codegen: emits `CompileArtifact` v1 (`artifact.ts`) with `operations[]`
  (`ArtifactOperation`, closed typed inputs) and separate `tests[]` example
  modules; callable registry linkage via `ArtifactCallable.member` paths.
- L2 values: exact-value semantics and wire encoding (`values.ts`:
  `CanValue`, `WireValue`, `InvocationWire`); independent expected-value
  conformance; never collapse exact scalars into JS Number.
- L3 state engine: existing admission (`admission.ts`), invocation
  (`invoke.ts`), interim registry/models (`registry.ts`, `mutation/models.ts`)
  behavior is preserved; T04a adds only the canonical intake shapes the T16
  join will consume in place of the interim descriptors.
- L6 identity/wire: verified identity (`ResolvedIdentity`), canonical
  envelopes (`MutationEnvelope`/`ReadEnvelope`, closed inputs, `MutationRef`
  version fencing), business error codes and HTTP mapping.
- L7 testkit/e2e: `exampleFixtures` loader shape (`loader.ts`), row/sequence
  specs with isolated setup, real invocation, independent expected
  values/observations (`table.ts`), `ExampleReport` envelopes
  (`examples.ts`); e2e compiled-artifact path (`artifact-loader.ts`) asserts
  compiled identity and runs emitted callables on real local storage.

## 3. Descriptor rules (model/operation/default inputs)

L3-owned intake in `state.ts` (new, additive; engine behavior unchanged):

- `ExecutionDescriptorSet`: versioned unit L1 emits and L3 loads at T16.
  `contractVersion` must equal 1; unknown operation/input kinds reject the
  whole set.
- `CanonicalOperationDescriptor`: name (`OperationName`), kind
  (`CanonicalOperationKind`, mirrors L1 `ArtifactOperationKind` exactly),
  closed `inputs[]`. Authorization predicates stay engine-local until T16
  maps generated policy.
- `CanonicalInputDef`: `ref` (model, `versioned` flag, required) or scalar
  (`CanonicalScalarKind`, mirrors the non-`ref` L1 `ArtifactOperationField`
  members). `enumValues` present exactly for `enum`, in declaration order.
  Admission stays closed: unknown members and missing required inputs
  reject with `validation`.
- `CanonicalModelDescriptor`: fields, `deleteMode`, optional unique keys.
  `CanonicalFieldDef`: required, serverOnly (caller-supplied values
  rejected), ordinary-vs-required array marker (T09: ordinary omits to
  empty, required rejects omission), and default vocabulary.
- `CanonicalFieldDefault`: `literal` | `parent` (dot path off the loaded
  parent row, create only) | `server` | `derived`. `server`/`derived`
  exclude the field from writable inputs; T18 owns their execution.

## 4. Invocation rules (verified identity)

- One canonical path: L6 `ResolvedIdentity` -> frozen `InvocationContext`
  (`invoke.ts` `buildContext`) -> `admit()` -> execute -> fenced commit.
  No second interpreter or alternate state engine.
- Admission order is frozen as implemented: read revision, hash inputs,
  receipt check (replay saved outcome; hash mismatch on the same identity
  is `conflict`), operation-id age for unseen identities, `by` authorization
  (trusted kind uses verified-source authority), closed-shape validation,
  record load with stale-version `conflict` and archived-target
  `validation`.
- Mutation refs carry identity plus expected version (`MutationRef`,
  canonical decimal string); stale versions conflict. Replay returns the
  saved outcome exactly; rejected receipts persist code/message only.
- Unknown operations are `validation` failures; exhausted fence contention
  is retryable `busy` (3 attempts, frozen clock).

## 5. Emitted-example rules (calls, expected values, observations)

- Examples execute through production admission against compiled artifacts
  only; `ExampleReport.artifact` pins digest + source revision.
- Each row/sequence step runs in an isolated fixture scope with its own
  caller (`ResolvedCaller`); setup failures report `setup-failed` and can
  never satisfy an expected business rejection.
- Expected values are independently authored (not derived from
  implementation output) and compare with L2 exact-value semantics via wire
  encoding; non-JSON-representable exact values without a landed encoding
  report `unsupported`, never coerce.
- State observations (`ExampleStateObservation`) read committed state only,
  through authorized viewer-projection queries at the committed fence
  revision. Owner/authority reads never serve an example observation.
- Rejection rows expect an exact error code plus a no-change proof
  (domain state, attachments, events, intents unchanged); later sequence
  steps keep earlier commits and add no new effects on rejection.
- Falsifiability: altering an expected value, removing a call, or
  suppressing a write must fail the relevant test.

## 6. Supported types (T04a)

Scalar inputs: string, integer, decimal, money, datetime, boolean, file,
enum. References: record refs with optional version fencing. Arrays:
ordinary vs required marker. Excluded to T04b: date, duration, unions,
nested contracts, rich structural literals beyond the T10 slice, provider
schemas, hooks/invariants/locks in descriptors.

## 7. Incompatibility / compatibility rules

- Exact version match required on all seven pinned contracts; mismatch is
  an incompatible artifact with a precise error, never a silent fallback.
- Unknown `kind` values, unmet `requires[]` entries, and missing
  implementations reject; nothing masquerades as callable.
- Additive-only growth: new optional members and new kinds are allowed only
  when old consumers can ignore or precisely reject them.
- Business error codes stay the closed DESIGN §10 set; no other machine
  codes. Wire values stay exact (canonical decimal strings, never locale
  JSON numbers).

## 8. Agreed interface expectations for excluded owners

- L1 `packages/contracts/src/artifact.ts`: add source-derived recursive
  model/operation/callable descriptor structures carrying the §3
  vocabulary (kinds, closed inputs, defaults, array markers) plus separate
  example artifacts; keep `ArtifactOperationKind` /
  `ArtifactOperationField` spellings identical to the mirrored L3 intake.
- L7 `packages/contracts/src/examples.ts`: add provisioning-input types for
  the L1 test-artifact shape and any runner-needed invocation bindings;
  keep `setup-failed`/`unsupported` semantics and the exact-value report
  rule.

## 9. Remaining T04b work

Recursive/nested descriptors, provider/bound schemas and recipes, hook /
invariant / lock descriptor joins, generated-policy mapping for
authorization predicates, richer scalar/struct kinds, file/progress/receipt
observation extensions, and full compatibility matrix beyond the §1 pins.
T16/T17 runtime joins are explicitly out of scope for T04a.

## 10. T04b-p provider-descriptor ratification (L3-led contract join)

Ratifies T15b's emitted provider shapes (committed 65a1ffd) into the
execution contract. Ratification defines; loader/emitter consumption
joins later (never this slice). `EXECUTION_CONTRACT_VERSION` stays 1;
all §1-§8 rules unchanged.

### 10.1 Decision 1 — `delivery` kind member set in the Canonical intake

Ratified: `CanonicalInputDef` gains a `delivery` member carrying
`CanonicalDeliveryDescriptor { kind, capability, operation, version,
result }` (`state.ts`), nested as one shared shape with
`CanonicalFieldDef.delivery?` (present exactly for T14c typed `std`
receipt fields). The ratified input-kind set is `ref`, the eight T04a
scalars, and `delivery`.

- Rationale: nesting preserves T15b's one-shape-no-drift design
  (`artifact.ts` `ArtifactDeliveryDescriptor` doc: "shared by
  operation inputs and model field tags"; `js.rs` renders one
  `JsDeliveryDescriptor` for both `JsMcpField::Delivery` and
  `JsModelFieldType::Delivery`). Flattening would be ungrounded
  reshaping.
- Version fencing (T04a §7): the descriptor `version` is the frozen
  capability contract version (`STD_*_VERSION` from `std_capability`,
  `js.rs` `delivery_descriptor`), exact-match fenced per capability,
  never negotiated at runtime; mismatch is an incompatible artifact
  with a precise error, never a silent fallback.
- Unknown provider kinds reject the whole descriptor set (T04a §3/§7
  rule, unchanged — stated here, implemented by the later loader
  join). Current posture: T16a `KNOWN_INPUT_KINDS`
  (`registry.ts`) has no `delivery` entry, so delivery inputs are
  refused today; this slice defines the intake rule they will join
  under.
- T15b-shape cites: `JsDeliveryDescriptor` + `delivery_descriptor`
  (`js.rs`); `ArtifactDeliveryDescriptor` / `ArtifactNominalResult` /
  `ArtifactNominalLeaf` (`artifact.ts`); emission tests `t15b_*`
  (`codegen.rs`); DESIGN §8 `std.EmailV1`/`std.PaymentsV1`/
  `std.ErrorsV1` rows ground the capability/operation/result
  vocabulary.

### 10.2 Decision 2 — verbatim result leaves (no structured tags)

Ratified: KEEP T15b's verbatim `type: string` leaves. No structured
tag vocabulary is grounded in any owner contract: L2 `values.ts`
owns exact-value semantics but no nominal-leaf tag vocabulary, T14d
consumed nominals with verbatim leaves (no tags), and DESIGN §8
gives per-nominal closed schemas but no machine tag enum. Inventing
tags here would be ungrounded reshaping.

- Consequence: `artifact.ts` EXAMINED-UNCHANGED — the emitter-side
  shape needs no change, so none was made. Verbatim leaves derive
  any future structured vocabulary without loss (`js.rs`
  `JsNominalLeaf` doc; `artifact.ts` `ArtifactNominalLeaf` doc).
- Cites: T13c transcription (`catalog.rs` `nominal_schema`,
  producer order); `js.rs` fail-closed `None` joins
  (`delivery_descriptor`, `mcp_field_for_resolved` /
  `model_field_tag` StdDelivery arms); bound-local `Delivery`
  stays `other`/omit (no T13 contract identity to join).

### 10.3 Decision 3 — recipe key + module-named-`std` collision rule

Ratified recipe key: `delivery:<qualified-send-target>` (e.g.
`delivery:std.EmailV1.send`), typed as `DeliveryRecipeKey`
(`state.ts`). The target is the T13 send-target vocabulary
(`work.ts` `T13A/B_DELIVERY_OBSERVABLES`, `catalog.rs`
`delivery_observable`); the `delivery:` head is the T14c/T15b
recipe tag (`js.rs` `delivery:{capability}.{op}` fallback;
`ir.rs` `decode_delivery_recipe` shared ctor joining the
`Operation` and recovered-`std` `Unknown` arms under the
qualified target; `t15b_recipe_join_std` /
`t15b_recipe_join_negatives_stay_shelled`).

Ratified collision rule (exact precedence, grounded in
`resolve.rs`): a declared module (app/package) named `std`
SHADOWS the compiler-known `std` provider. Module registration
rejects only duplicate identities (E2002) — no rule reserves
`std` — and `resolve_import` consults `module_by_name` FIRST,
reaching the T14b/B1 compiler-known-`std` arm only when no
module matches. So `use std {M}` binds against the declared
module's scope when one exists (ordinary E2003/E2004 member
rules); the `External{provider:"std"}` binding fires only
otherwise. With a module named `std` in the program, no
`StdDelivery` arises from that import spelling and no
`delivery:std.*` keys reference the standard capabilities —
fail-closed, no silent provider switch. Bound
`from=deployment.*` imports of unknown providers stay opaque
externals regardless (unchanged).

### 10.4 Decision 4 — L3 mirrors land; L6 McpSchemaField is remainder

Landed (this slice): `CanonicalInputDef` delivery member +
`CanonicalFieldDef.delivery?` + `CanonicalDeliveryDescriptor` /
`CanonicalNominalResult` / `CanonicalNominalLeaf` /
`DeliveryRecipeKey` (`state.ts`).

Recorded remainder (NOT decided): the L6 `McpSchemaField` mirror
(`ports.ts` has no `delivery` member; `fieldSchema`'s switch is
exhaustive over the nine existing kinds). Delivery inputs are
MCP-unsuppliable until T16/T19 decide admit vs precise-reject.
The `artifact.ts` JSON-identical doc invariant therefore holds
for the non-delivery members only until L6 decides. No MCP
admission decision was made here.

### 10.5 Additive-only argument (T04a §6-7)

- `EXECUTION_CONTRACT_VERSION` = 1 and all §1 pins unchanged.
- `CanonicalInputDef` gains one union member: old consumers either
  ignore it (non-exhaustive handling) or precisely reject the
  unknown `delivery` kind per §3/§7 (the T16a loader's
  `unknown_input_kind` whole-set rejection is exactly that
  posture). No existing member changed shape.
- `CanonicalFieldDef.delivery?` is optional: T04a-era literals
  still satisfy the type; loaders ignoring extra members are
  unaffected.
- New interfaces/type are purely additive exports; no name
  collisions with existing contract modules.
- `artifact.ts` untouched; no loader/emitter runtime behavior
  changed.

### 10.6 Exact T04b remainder

- T16 loader consumption join: admit `delivery` inputs/fields
  (extend `KNOWN_INPUT_KINDS`, per-capability version fencing,
  closed-shape validation) — defined here, implemented there.
- L6/T19 McpSchemaField mirror: admit vs precise-reject for
  delivery inputs (§10.4).
- Hooks/invariants/locks in descriptors (need T31a/L2 facts).
- Date/duration/unions/nested-contracts/rich structural literals
  (need T31a/L2 facts).
- Generated-policy mapping for authorization predicates;
  file/progress/receipt observation extensions; full
  compatibility matrix beyond the §1 pins.
