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
