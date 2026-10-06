# V01.4 — Owner-plan and shared-file handoffs

Task: V01.4 (lane `V-plan`, wave 1, after `C01.ready`). Produced
2026-10-06T08:42:35Z by lane F session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9.
Planning record only; no implementation authorized.

- Head verified: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06`
- Companion: `contracts.md` (profiles), `caller-inventory.json`,
  `current-ts.json`, `http-adoption-gate.md`, `state-contract.md`.

## Owner-plan agreements (with exact-values / C03 owners)

- **Factory provenance**: `normalizeSchema` may record provenance for
  newly constructed normalized outputs internally, but only within
  genuine factory/producer paths. A structurally accepted hand-built
  `NormalizedSchema` remains legacy; unknown string wrappers and
  structural acceptance stay outside any plan cache. The private
  factory hook patch specification goes to V-integrator (V02.6).
- **Copied owner metadata**: owner loaders (interfaces/state plans)
  copy and validate data-only metadata internally at registration;
  never merely cache a frozen object returned by a permissive
  unknown-input loader. Post-registration public-object mutation
  cannot modify the plan. **Freeze/shape alone never establishes
  provenance** — only immutable data copies plus private owner tokens.
- **Schema/artifact revisions**: plan IDs carry ABI/profile version,
  backend instance, generation, and owner revision, bound to an
  artifact/normalized-schema owner scope (`ARTIFACT_VERSION = 1`,
  `contracts/src/artifact.ts:14`). A new artifact is a new scope; no
  hashless global cache by operation name or caller type string.
  Registration copies ordered metadata (resolved dispatch, field
  order, bounds, trim/default metadata, default tokens,
  allowed/required lists, ref rules, error projection).
- **Default references**: `DefaultRef` resolves through the plan
  owner's shared frozen default registry (repeated defaulted calls
  return the same object); implicit empty arrays reuse the canonical
  frozen `EMPTY_ARRAY` (`values/src/array.ts:72-76`); `UPDATE_OMITTED`
  resolves to the existing symbol; engine-resolved markers drop keys.
- **Plan handles**: `registerValidationPlan(ownerPlan, profileVersion)`
  accepts only a private owner token, yielding a generation-tagged
  `PlanId`. Foreign/stale/disposed handles fail construction before
  execution; release is idempotent; no caller-controlled unbounded
  type-string cache. `beginOwnedInput`/`executeOwned`/`materialize`/
  `disposeRequest` follow the C03 transport contract (UTF-16,
  f64 bits, explicit presence, envelopes, budgets).

## No-second-authority rule

Validation creates no second currency table, Decimal implementation,
wire authority, catalog, or compiler work. It imports numeric
representations/codecs from exact-values (A03–A06 mechanisms) and must
not redefine them; currency/catalog facts come from the owning
TS sources; the compiler is untouched. Shared mechanisms, never shared
policy: each profile keeps its own error projection and permissiveness.

## Shared-file handoffs (V-integrator)

Exact-values creates manifests, lockfile, failures, and `lib.rs` at
**A03.foundation** (gate: workspace, representations, failures,
transport contract, and shared module ownership usable; validation may
begin without awaiting full A03 integer/rounding work). After the
explicit arithmetic/C03 handoff, **V-integrator is the only validation
editor** of: shared manifests (`values/Cargo.toml`, lockfile,
`semantics/Cargo.toml`, `bindings/Cargo.toml`), `semantics/src/lib.rs`,
`profiles.rs` module registration, `codecs/mod.rs`, ABI entry/glue,
`bindings/src/{lib,validation}.rs`, TS `bindings/{validation,backend,
bootstrap}.ts`, public hooks (`src/{schema,wire,index}.ts`,
`package.json`, `tsconfig.json`), and build/export/release glue.
Generated binding output is reproducible, never hand-edited.
V-integrator queues patches until A04/A05 numeric/temporal and A07
loader owners release shared files; **no lane edits another lane's
module**. V-plan owns `semantics/src/plans.rs`, `src/prepared/plan.ts`,
`bindings/plans.ts`, `test/prepared-validation.test.ts` exclusively.

Related handoffs: C04 alone owns typed inventory/`bundle.ts`/
`local-run`/testkit and the shared manifest graph; C04.validation-join
consumes the V08.3 decision; V09.1 is the narrow canonical-bridge
handoff (V-state edits `runtime/invoke.ts` + admission; V-http
consumes in `operations.ts`/assembly + fixture, never editing the
bridge).

## Responsibility layout vs living filetree (recorded, not implemented)

- Values ownership row (exact values, omission/default order, pure
  operations, one locale catalog) is consistent: plans/codecs live in
  the values-owned crate; TS façades keep public behavior.
- `packages/values/conformance/v1/` is already allocated; new
  `conformance/owned-input/v1/` needs a target-tree allocation entry.
- Proposed `semantics/` leaves (`input.rs`, `plans.rs`, `profiles.rs`,
  `validation.rs`, `codecs/owned.rs`, `profiles/{values,http,state,
  mcp}.rs`) and `src/prepared/*.ts` are unallocated new leaf families:
  per `scope.json`, they need an explicit ownership/filetree decision
  (ownership.md selects no new language boundary today) before any
  implementation lane writes them. This record advances no checkpoint
  and modifies no plan file.

## Owner review status

Required (recorded, not assumed): exact-values core integrator (A03
foundation contents + handoff order), C03 ABI owner (transport/version
envelope), validation owner (plan/traversal/profile split), V08/C04
delivery owners (join consumption). Each handoff above needs its
owner's review before V02 extraction begins.
