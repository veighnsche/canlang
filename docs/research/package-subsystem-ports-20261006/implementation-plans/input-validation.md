# Prepared owned-input validation, normalization and codecs

Planning checkpoint: `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5`, October 6, 2026. This plan implements the changed boundary in [boundary-options.md](../boundary-options.md), using the compatibility findings in [full-evaluation.md](../full-evaluation.md). It is a plan only: no backend, measured gain, production consumer, binary delivery or new validation API has been implemented by this document. Compiler changes and language-specific directories are excluded.

## Outcome and scope

Build one private, ordered validation-plan interpreter in the shared `packages/values/semantics/` crate, with the exact-values plan supplying exact carriers and numeric scalar codecs. This plan owns type parsing, plan policy and traversal. Move complete checking/normalization/ref extraction/optional encoding calls over parser-owned data into that core. Start with the HTTP JSON framing and binding consumer, then integrate separately specified state and MCP profiles. Prepare the same operation in TypeScript first; compare current TS, prepared TS and Rust through the real adapter. Shared mechanisms do not imply shared policy.

Keep exported arbitrary-`unknown` entry points (`normalizeSchema`, `validateValue`, `validateOperationInput`, `decodeValue`, `encodeValue`, interfaces helpers and state admission entry points) compatible through their legacy TS paths when provenance is absent. A successful parser-owned port is **not completion of the full legacy validator port**. Accessors, proxies, cycles, sparse arrays, symbols, custom prototypes, `toJSON`, getters and accepted hand-built schemas remain outside this new domain. Do not snapshot arbitrary inputs and advertise compatibility. Legacy evaluation, exceptions, synchronous signatures and identity remain observable requirements.

Retain host JSON parsing initially. This preserves this repository's body-cap, syntax/error and JS number parsing behavior; using Serde to parse the request instead would be a different contract. Parsed transport numbers are represented losslessly relative to the host's resulting IEEE-754 value, including negative zero and exponent-overflow results. This does not recover precision already lost by `JSON.parse`. Can's opaque `json` codec rejects **every** number, including ordinary integers; it cannot serve as the generic request carrier. A number may travel through the transport, fail the exact integer/decimal codec, pass a state presence-only scalar rule, or fail raw receipt hashing if nonfinite, depending on the current profile and stage.

Public schemas and application declarations remain with their existing owners. `.can` remains the application source; this work consumes package-produced metadata without a compiler change or a second independently authored catalog.

## Verified source map

Line anchors below refer to the inspected checkpoint. The implementation must refresh them in its final report rather than copy stale line numbers.

| Owning source | Present responsibility | Planned disposition |
| --- | --- | --- |
| `packages/values/src/schema.ts:139–217`, `:339`, `:947`, `:1392` | Descriptors, structural normalized-schema guard, two-pass normalization, default validation and frozen output | Retain public unknown normalization; generate owned ordered plans only within genuine factory/producer paths |
| `packages/values/src/schema.ts:417`, `:545`, `:580`, `:618`, `:674`, `:741`, `:814` | Inclusive bounds, trim, model refs, omission/defaults, contract/union/array traversal | Prepared TS extraction, then matching values-profile interpreter |
| `packages/values/src/schema.ts:1813`, `:1852` | Public value/operation wrappers; accumulated violations; mutation refs and operation ID | Preserve public wrappers; private owned variants share prepared AST/leaf plans |
| `packages/values/src/wire.ts:217`, `:237`, `:324–1144`, `:1178`, `:1488`, `:1689`, `:1763` | Undefined-as-absent wire shape, exact/stringlike/structural codecs, number-free opaque JSON, encode/decode wrappers | Prepared AST codecs and lossless owned carrier; legacy wrappers remain for unknown values |
| `packages/values/src/types.ts:387`, `:439`, `:472`; `src/text.ts:31`, `:67`; `src/errors.ts` | Type grammar/printing, JS trim and scalar count, `ValueError`/`SchemaError` | Reuse shared exact-values/type implementation; match host text behavior and reconstruct owning errors |
| `packages/interfaces/src/http/limits.ts:38`, `:72`, `:94`; `http/operations.ts:145`, `:168`, `:429` | Capped host JSON/form parsing, form JSON-or-string coercion, authenticated/CSRF/ID/framing/binding dispatch, catalog derivation | Internal parser-provenance production, then whole HTTP JSON framing+binding; preserve form fallback |
| `packages/interfaces/src/envelope/validate.ts:46`, `:64`, `:98` | UUID extraction/age and first-unknown-then-first-missing framing | Keep clock/ID orchestration host-owned; separate interfaces framing profile |
| `packages/interfaces/src/mcp/schemas.ts:401`, `:423`, `:446`, `:783`, `:850`, `:978–1138` | Owning artifact checks, exact literal checks, datetime values-codec delegation, first binding failure | Derive prepared binding plans after owner checks; preserve distinct error projection and permissiveness |
| `packages/interfaces/src/envelope/refs.ts:38`, `:71`; `mcp/server.ts:282–376` | MCP read/mutation ref framing; ordinary mode ID, closedness, ref shape, bound checks | MCP profile preserves extra ref stage and null-deferral order; SDK provenance must be proved first |
| `packages/state/src/invocation/registry.ts:272`, `:554`, `:738`, `:1125` | Descriptor loading/derivation, deep freezing, generated registry ownership; loader-derived delivery-field membership | Add owned plan projection within loader for proven producer data; freezing alone is not evidence of inertness. Retain the delivery-field channel with its state owner; public ReadonlyMap types/copies do not establish immutable private provenance |
| `packages/state/src/invocation/admission.ts:83`, `:177`, `:282`, `:299` | Strict 1–15 digit nonzero state versions, accumulated field errors, array fills, interim identity, admission order | Separate generated-state profile; same private validator point after replay/age/auth |
| `packages/state/src/invocation/replay.ts:20`, `:65` | Sorted-key stable encoding, observable `toJSON`/getters, finite-number rules, host SHA-256 | Leave legacy encoding/hash in TS initially; do not alter persisted receipt digest or move normalization ahead of hashing |
| `packages/state/src/invocation/invoke.ts:203`, `:447–503` | Mutation admission and read authorization before validation | Thread proven input ownership without changing mutation/read ordering |
| `packages/cloudflare/src/runtime/invoke.ts`; `worker/assembly.ts:744`, `:1010`, `:1120`; `deploy/bundle.ts:586` | Canonical state bridge; real deployed MCP factory; interim HTTP operation route currently returns 501 | Required HTTP production join proof, not an assumed existing deployment; shared binary delivery remains C04-owned |

The last row is a material gap: `handleOperationRequest` is a real interfaces implementation and test consumer, but the inspected Cloudflare assembly explicitly retains an interim HTTP dispatcher. Completing unit tests against an injected invoker does not prove a deployed HTTP consumer. V08 proves the package port with the actual handler, Wasm and a workerd fixture; default deployed HTTP adoption remains gated on an owning route join. That gate permits only a bounded existing-handler join established by C01 source-owner contracts, not building a new HTTP feature. If that join is unavailable, report package completion and blocked default deployment separately. The real deployed MCP factory does not resolve the separate SDK argument-provenance question.

## Private contract and profile design

All names here are proposed private APIs, not current repository exports. C03 owns the versioned ABI and shared crate/glue; this plan supplies its validation-specific contracts.

1. A host parser adapter produces an `OwnedInputToken` whose constructor is module-private. It records a fresh parser result in an internal WeakMap, not an exported symbol property or a caller-supplied boolean. The token is usable only during its request scope and by the exact owner-produced root or a controlled derivative. `parseJsonBody` keeps its public signature; a new package-private owned parser path calls the same capped reader/TextDecoder/JSON.parse and records provenance **at creation**, before exposing data to arbitrary callbacks. No public `adopt(unknown)` API exists.
2. A controlled derivative, such as stripping `_csrf` or `operation_id`, transfers lineage only when created internally from the protected parser graph using own data-property definitions. Preserve `Object.keys` order (array-index keys numerically first, remaining keys in insertion order) and duplicate-key host JSON semantics. Copy own `__proto__` as data using `Object.defineProperty`/`Object.fromEntries`; do not silently fix current form assignment behavior under this lineage mechanism. Forms stay legacy until V10 supplies an independently declared faithful producer.
3. The owned root must never reach an untrusted callback before conversion. For state, retain a private protected raw snapshot while the public envelope has an ordinary detached materialization, or maintain an internal token through a fully audited bridge that never exposes the protected graph. Choose the former as the initial safe design; V09 records the extra copy and confirms it is economically acceptable. Caller mutation cannot modify the protected snapshot. An arbitrary injected `OperationInvoker` never receives a transferable token: once inputs go through an unverified callback, use legacy state validation. Only the audited canonical invoker bridge can associate the protected raw graph with admission. A public copy that has been modified cannot continue using the token; do not inspect it and assert that it remained inert/equivalent. No inference from TypeScript types, freezing, schema tags, property inspection or a structurally valid object grants provenance.
4. `registerValidationPlan(ownerPlan, profileVersion)` accepts only a private owner token, yielding a generation-tagged `PlanId`. Its ordered descriptor contains resolved type/union dispatch, field order, bounds, trim/default metadata, default tokens, allowed/required lists, ref rules and error projection. `normalizeSchema` may record provenance for newly constructed normalized outputs internally, but a structurally accepted hand-built `NormalizedSchema` remains legacy. For interfaces/state plans, owner loaders copy and validate data-only metadata internally; never merely cache a frozen object returned by a permissive unknown-input loader. Arbitrary schema accessors still run on the existing legacy path.
5. `beginOwnedInput(token, limits) -> RequestId` converts once into an ordered tagged tree. Text and keys use UTF-16 code units, including lone surrogates; Rust `String` is not the general text carrier. Numbers use f64 bits; exact Can wire scalars use their original UTF-16 string spelling until checked by the exact-values primitives. Missing/undefined/null, default references, update-omitted and engine-resolved drop markers have distinct tags. The parser domain has no undefined or holes; presence tags are still necessary for outputs, owned plan metadata and profile semantics. Raw counts/indexes are validated before any fixed-width Wasm conversion. No `serde_json::Value` or generic serializer is credited with parity.
6. `executeOwned(RequestId, PlanId, action) -> Outcome` performs a **whole** profile action: HTTP framing+binding, values check/normalize/optional encode, or state check+ordinary-array-fill+ref extraction. Outcomes carry ordered error records or a validated result; failures never publish partial values. Preserve class/kind/code/message/path/expected/actual/optional-property absence when materialized. Error records include a closed diagnostic template and ordered, lossless arguments; initial host formatting reuses JS string/number rendering and truncation rules rather than assuming Rust formatting matches `JSON.stringify`/`String(number)`. This formatting is over owned data only. Encode actions consume an interpreter-produced result in the same request scope, not arbitrary unknown values reclassified as owned.
7. `materialize(ResultId, mode)` returns once at the host boundary. For values, `DefaultRef` resolves through the plan owner's shared frozen default registry; repeated defaulted calls return the same object, and implicit empty arrays reuse `emptyArray`. `UPDATE_OMITTED` resolves to the existing symbol; engine-resolved markers drop keys. State ordinary-array fills remain fresh ordinary arrays and generated output remains the current unfrozen copy; interim calls keep input identity through the TS path. Rust wrapper objects are not substitutes for structural Can BigInts/Decimal/Money carriers. Exact-values C03 conversions are reused.
8. `disposeRequest` and `releasePlan` are idempotent host operations. Use `try/finally` around every request, including errors, cancellation and replay. Stale/foreign/generation-mismatched handles produce an adapter-construction failure before Rust executes. No semantic operation is retried automatically in TS after a Rust failure. When Rust is explicitly selected, missing/corrupt assets, ABI mismatch and initialization failure fail startup; selecting TS is a prior release/startup choice, not recovery after failed Rust loading.

### Separate policy profiles

| Profile | Required behavior; mechanisms may be shared but these policies must not be unified |
| --- | --- |
| `values/v1` | Accumulate violations in current order. Undefined-valued unknown keys are ignored; undefined known values count as omission. Preserve required/nullability/create/update/explicit-default rules, nullable-array precedence, engine fields, trim **after** decode and **before** bounds, inclusive bounds, complete union/array elements, mutation refs recursively, secret refusal, unknown-field vs unknown-argument, canonical wire errors and frozen outputs. Shared defaults and empty identity are host registry references. |
| `http-input/v1` | First unknown in JS enumeration order, then first missing required in shape order using own presence, then first bound failure in derived input order. Explicit null/undefined own presence differs from values. No normalization/default fill; return the submitted raw business inputs. Keep catalog-without-derived framing-only behavior. Integer/decimal/money/datetime checks match current binding detail; string/boolean currently defer value checks to state. Money binding checks currency is a string, not values currency normalization. |
| `mcp-ordinary/v1` | Mutation ID remains host framing; closedness precedes descriptor ref-shape checks, which precede derived binding. Keep nullable ref deferral only for members present in derived declarations. Ref parsers reject extras and enforce ID UTF-16 `.length <= 256`; HTTP bound refs have different permissiveness. Query `operation_id` stays an unknown business member. Project framing/binding failures to `McpError(InvalidParams)` at the host. Handle-mode/sealed handles remain separate TS orchestration. |
| `state-generated/v1` | Aggregate unknown/required/array/ref/version errors in current order; generated scalars remain presence-only. Fill only absent optional ordinary arrays, preserve explicit null and present undefined behavior, ignore operation defaults, preserve extra ref-member permissiveness and strict state version domain `/^[1-9][0-9]{0,14}$/`. Return ordered refs with safe-number version conversion and a normal shallow copy. Defaults remain with model pipeline/emitted scenario callable. |
| `legacy-ts` | All unproven unknown inputs and structurally accepted schemas/descriptors, forms and SDK objects without producer evidence. Preserve read/ownKeys/get/exception traces, `toJSON`, sparse/cyclic behavior and existing identity. This retained path is an explicit scope boundary, not a temporary claim of complete Rust migration. |

Interfaces digits-only versions may contain zero, leading zeros and arbitrary magnitude; state versions do not. Values has its own wire model-ref rules. Preserve those domains until an independently versioned language/transport change is approved. Interface artifact input descriptors are not a complete values schema: do not invent contracts, defaults or scalar validation from missing metadata.

Host WHATWG URL and Intl/ICU validation/canonicalization stay host-mediated at first. V05 uses an explicit synchronous, demand-ordered predicate adapter for supported values plans, records calls/exceptions and benchmarks it; HTTP first-wave exact/datetime checks do not require those callbacks. Never precompute all predicates ahead of earlier violations. If an action cannot preserve this protocol, classify its plan as TS-only at **registration**, before the request begins. This is separate from retrying a failed Rust action. Ordinary text/keys still require UTF-16 handling even in a host-mediated leaf. Any later removal of a host predicate is a separately tested semantics change.

### Plan mutation, lifetime and limits

Plan IDs include ABI/profile version, backend instance, generation and owner revision. Bound plans to an artifact/normalized-schema owner scope. A new artifact is a new scope; do not reuse a hashless global cache by operation name or caller type string. Registration copies owner-produced ordered metadata; post-registration public object mutation cannot modify the plan. Tests must attempt schema/default/array/enum/bound mutation before/after registration, forged normalized tags and foreign/disposed handles. Legacy hand-built schemas continue observing their current reads rather than accidentally receiving stale cached plans.

Start with explicit proposed new-path budgets: 256 registered plans per owner, 16 MiB aggregate plan storage per isolate, 1 MiB input body (the current HTTP cap), 32 MiB owned request allocation, 128 traversal frames and 1,048,576 visited nodes. They are hypotheses, **not existing language limits**. V03 measures representative/deep/wide schemas and V07 fixes the numbers/profile-version and error mapping before consumer rollout. Registration over budget rejects the owner before serving; active plans are never evicted mid-request. Use owner-scoped LRU only for inactive scopes with generation invalidation. At most one request arena per active request; no global retained results or caller-controlled unbounded string cache.

Use iterative traversal and checked allocation. Budget errors return a documented new-path `limit` result; traps and stack overflow are adapter failures, never equivalent to the legacy cycle `RangeError`. The same budget policy must be applied to the owned prepared-TS comparator so backend selection does not change the owned contract. A limit that narrows previously successful HTTP inputs requires an explicit C01/JEV contract decision and profile version; until then do not enable that path for those inputs. Request scopes are released after final materialization, replay, denial, thrown host predicates, cancellation and client disconnect; plan defaults are retained only until owner release. V07 verifies plateauing allocations and no stale cross-request reuse.

Parser-token creation records ownership without semantic traversal, plan selection or Rust limits. Begin conversion/checking only at the existing profile validation point, after its preceding host stages. In state, an existing receipt must return before a new-plan lookup, traversal budget, conversion or normalization can fail; no eagerly allocated Rust validation session is required to replay. Raw hash validation remains exactly where it is today. HTTP framing/binding already precedes the state receipt check, so preserve that existing outer/inner difference rather than claiming all transport validation occurs after replay.

## Target file tree and ownership

The following additions/changes are proposed, not existing files. Cargo package name, shared ABI modules and exact types are coordinated with the exact-values plan through C03; this lane must not create a second crate, second loader or copied numeric/type/currency catalog.

```text
packages/values/
  Cargo.toml                       A03-owned workspace for semantics and bindings only
  Cargo.lock                       shared pinned dependency resolution
  semantics/                       shared crate with exact-values plan
    Cargo.toml                     shared manifest (exact-values/C03 owner)
    src/
      lib.rs                       A03 creates; validation extends coordinated exports
      input.rs                     ordered UTF-16 transport nodes/presence
      plans.rs                     registered validation plans/generations
      profiles.rs                  policy selection and error records
      validation.rs                ordered interpreter and bound/omission rules
      codecs/
        mod.rs                     shared module assembly (exact-values owner)
        numeric.rs                 exact-values-owned primitives
        owned.rs                   owned codec dispatch (validation owner)
    tests/
      input_validation.rs          native interpreter/limit/ordering conformance
  bindings/
    owned-input.ts                 request tokens and controlled lineage
    plans.ts                       owner plan registration/disposal
    validation.ts                  private whole-call adapter
    materialize.ts                 structural results/default registry/sentinels
    [shared ABI/loader files]       exact-values/C03, not duplicated here
  src/prepared/
    plan.ts                        TS prepared immutable owner plan
    codec.ts                       AST codec entry and pre-resolved union/leaf dispatch
    validation.ts                  comparable whole-profile TS execution
  src/{schema,wire,index}.ts        legacy wrappers; private owner provenance hooks
  test/
    owned-input.test.ts
    prepared-validation.test.ts
    validation-binding.test.ts
    validation-lifecycle.test.ts
    legacy-validation-traces.test.ts
  conformance/v1/                  existing vectors unchanged
  conformance/owned-input/v1/
    cases.json                     tagged UTF-16/profile/error vectors
    README.md                      owned contract/limits; no unknown compatibility claim
packages/interfaces/
  src/envelope/prepared.ts         owning HTTP/MCP plan projections
  src/http/{limits,operations}.ts  private JSON parser lineage + actual consumer
  src/mcp/{schemas,server}.ts      prepared binding/ref profile; SDK provenance seam
  test/{owned-http,owned-mcp}.test.ts
packages/state/
  src/invocation/prepared-inputs.ts  owning generated-state plan + provenance adapter
  src/invocation/{registry,admission,invoke}.ts
  test/invocation/owned-admission.test.ts
packages/cloudflare/
  src/worker/assembly.ts           conditional bounded existing-handler join gate
  src/deploy/bundle.ts             conditional HTTP module join; C04 reused
  src/runtime/invoke.ts           audited private provenance bridge (V09)
  test/{owned-http-route,owned-input-delivery}.test.ts
docs/research/package-subsystem-ports-20261006/
  evidence/input-validation/
    contracts.md
    caller-inventory.json
    current-ts.json
    prepared-ts.json
    abi-vectors.json
    profile-differential.json
    http-consumer.json
    http-adoption-gate.md
    state-replay-traces.json
    mcp-provenance.md
    resources.json
    measurements.json
    rollout-decision.md
    final-source-checks.md
    verify.log
  implementation-plans/input-validation.md
```

When wiring imports/builds, include `bindings/**/*.ts` in the relevant values TS build or keep all imports rooted so current package emission includes them; verify declarations and release inventory rather than assuming `tsconfig.json`'s existing `src/test` includes cover a new sibling. Package public exports and public contracts do not gain handle types. Native/Wasm tests and generated binding assets must be reachable through C04 release inventory and CI. Living file-tree reconciliation occurs after each actual merge, with coverage and decisions updated together; writing this plan does not advance its checkpoint.

## Executable waves and parallel lanes

The machine-readable companion is [input-validation.tasks.json](input-validation.tasks.json). Every checkbox is initially unchecked. `V01`–`V12` remain parent **completion** gates over their children; use the smaller child readiness gates to start independent work. `C01.ready`–`C05.ready` are the shared README's readiness milestones, not aggregate completion. External arithmetic milestones are `A03.foundation` (workspace, representations, failures and shared contracts), `A04.5`, `A05.3`, `A04.2`, `A07.foundation` and `A07`; they are evidence gates, not scaffolding. A03.foundation permits schema preparation, provenance and structural ABI work before the whole arithmetic tranche. Exact scalar codec execution waits for A04.5/A05.3; general values bounds additionally require A04.2 decimal comparison; initial binding assembly consumes A07.foundation and publishes V03.5 back to final exact A07 assembly. Full profile bindings/consumers then consume A07. W06.runtimehandoff is a source-writer handoff only for canonical runtime/invoke.ts; pure state work has no work-kernel semantic dependency.

Dispatch at most one active task per lane and one dependency-sized patch at a time; a wave is an earliest-ready grouping, not an all-lanes barrier. Prefer 0.5–2 working-day allocations. Each task closes with evidence or a bounded blocked/adoption decision; do not silently weaken acceptance. The C01 inventory takes at most the first two working days; ABI/pin decisions take one working day; consumer/SDK/predicate/copy-cost spikes take at most two. Preserve the architecture, source map, profiles, matrix, commands and rollout below. All source/API/test additions remain proposed.

Shared-file coordination is mandatory. Exact-values creates manifests, lockfile, failures and lib.rs at A03.foundation. V-integrator is the only validation editor of shared manifests, lib.rs, profiles.rs module registration, codecs/mod.rs, ABI entry/glue, public hooks and build/export/release glue after explicit arithmetic/C03 handoff. Generated binding output is reproducible and never hand-edited. A04/A05 numeric/temporal and A07 loader work retain their owners; V-integrator queues patches until those owners release shared files. C04 alone owns typed inventory/bundle.ts/local-run/testkit and shared manifest graph. C04.values-assets (after A07.foundation/C04.graph/C04.ready) supplies the actual values generated-binding/vendor/release inventory; tiny C04.ready smoke alone is not that final asset proof. Its C04.validation-join consumes V08.3 decision after C04.graph/C04.ready, requiring V08.4 assembly evidence only for an accepted branch and recording a no-op when declined; V08.5 verifies that delivered join and does not edit delivery source. No lane edits another lane's module.

HTTP and state consumer work cooperate through a narrow early V09.1 canonical bridge handoff (after W06.runtimehandoff releases runtime/invoke.ts): V-state alone edits runtime/invoke.ts and admission modules; V-http consumes that API in operations.ts/assembly.ts and its workerd fixture. V09.1 performs snapshot protection/identity association only, so it does not move conversion/plan lookup/budgets ahead of receipt replay. V09.2 normalization and V08.1 handler integration can then run concurrently; V09.3 joins real traces afterward. V-http never edits the state bridge, and V-state never edits owning HTTP assembly or deployment modules. MCP uses a separate prepared.ts projection; forms use a new forms-owned.ts producer handed to the sole HTTP owner for hookup.

HTTP native/profile/resources/package consumer do not depend on the full values interpreter/predicate milestone or optional MCP/forms implementation. V10 source assessment starts in wave 1; the required V10 gate reviews the chosen/deferred scope. Conditional adoption tasks remain unchecked when deferred, and no report may mark their full port complete. Default deployed HTTP join is also conditional: V08 package proof remains distinct from real deployed adoption, with the existing 501 retained if no bounded C01 join is available. Required acceptance ledgers consume decisions rather than making deferred work a prerequisite.

### Lane ownership, ready backlog and exit gates

The JSON records exact source/evidence writes. These responsibility extensions split the originally proposed single profiles.rs and test file into file-disjoint leaf modules, preserving one policy selector/root harness with V-integrator.

- **V-integrator — Shared values and ABI integration owner**
  - Owns: `packages/values/Cargo.toml`, `packages/values/Cargo.lock`, `packages/values/semantics/Cargo.toml`, `packages/values/bindings/Cargo.toml`, `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/codecs/mod.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/bindings/src/lib.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/bindings/backend.ts`, `packages/values/bindings/bootstrap.ts`, `packages/values/src/schema.ts`, `packages/values/src/wire.ts`, `packages/values/src/index.ts`, `packages/values/tsconfig.json`, `packages/values/package.json`, `packages/values/semantics/tests/input_validation.rs`, `packages/values/test/validation-binding.test.ts`, `packages/cloudflare/test/owned-input-delivery.test.ts`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Prepare V02.6 hook patch and V03.5 ABI/module handoff while arithmetic owns shared files; later review declarations/inventory for V11.2.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V02.6, V03.5, V11.2 and V12.1; optional accepted V08.5, with reviewed evidence and handoff.
- **V-plan — Owner plans and schema preparation**
  - Owns: `packages/values/semantics/src/plans.rs`, `packages/values/src/prepared/plan.ts`, `packages/values/bindings/plans.ts`, `packages/values/test/prepared-validation.test.ts`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V01.4 contracts, V02.1 immutable plans and adversarial schema fixtures before exact codecs land.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V02.1 and V03.4, with reviewed evidence and handoff.
- **V-input — Parser provenance, arenas and lifetimes**
  - Owns: `packages/values/semantics/src/input.rs`, `packages/values/bindings/owned-input.ts`, `packages/interfaces/src/http/limits.ts`, `packages/values/test/owned-input.test.ts`, `packages/values/test/validation-lifecycle.test.ts`, `packages/values/semantics/tests/input_validation/input.rs`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V03.3 parser provenance and transport mutation fixtures while binding delivery is blocked; prepare deep/wide lifecycle cases.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V03.2/V03.3 and V07.1, with reviewed evidence and handoff.
- **V-values — Values interpreter, codecs and materialization**
  - Owns: `packages/values/semantics/src/validation.rs`, `packages/values/semantics/src/codecs/owned.rs`, `packages/values/semantics/src/profiles/values.rs`, `packages/values/src/prepared/codec.ts`, `packages/values/src/prepared/validation.ts`, `packages/values/bindings/materialize.ts`, `packages/values/bindings/predicates.ts`, `packages/values/test/legacy-validation-traces.test.ts`, `packages/values/semantics/tests/input_validation/values.rs`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V02.2 current/prepared AST/legacy traces while A04/A05 codecs are blocked; prepare ordered traversal fixtures.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V04 and V05 with V07.3, with reviewed evidence and handoff.
- **V-http — HTTP profile and owning handler/module join**
  - Owns: `packages/values/semantics/src/profiles/http.rs`, `packages/interfaces/src/envelope/prepared.ts`, `packages/interfaces/src/http/operations.ts`, `packages/interfaces/test/owned-http.test.ts`, `packages/cloudflare/src/worker/assembly.ts`, `packages/cloudflare/test/owned-http-route.test.ts`, `packages/values/semantics/tests/input_validation/http.rs`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V01.2 bounded-join contract, V02.3 framing plan and profile disagreement vectors while exact/binding gates are blocked.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V06.4 and V08 package gate; default deployment separately V08.4/V08.5, with reviewed evidence and handoff.
- **V-state — Generated-state profile and canonical bridge**
  - Owns: `packages/values/semantics/src/profiles/state.rs`, `packages/state/src/invocation/prepared-inputs.ts`, `packages/state/src/invocation/registry.ts`, `packages/state/src/invocation/admission.ts`, `packages/state/src/invocation/invoke.ts`, `packages/cloudflare/src/runtime/invoke.ts`, `packages/state/test/invocation/owned-admission.test.ts`, `packages/values/semantics/tests/input_validation/state.rs`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V01.3 replay contract, V02.4 loader projection and V09.1 bridge before consumer/resource gates; preserve raw hash golden vectors.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V06.5 and V09 durable gate, with reviewed evidence and handoff.
- **V-mcp — MCP provenance decision and ordinary profile**
  - Owns: `packages/values/semantics/src/profiles/mcp.rs`, `packages/interfaces/src/mcp/prepared.ts`, `packages/interfaces/src/mcp/schemas.ts`, `packages/interfaces/src/mcp/server.ts`, `packages/interfaces/test/owned-mcp.test.ts`, `packages/values/semantics/tests/input_validation/mcp.rs`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V10.1 installed SDK source inspection and V02.5/V06.3 pure profiles despite a deferred SDK branch.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V06.6 and V10.3 decision; V10.4 only if accepted, with reviewed evidence and handoff.
- **V-forms — Independent forms source assessment and optional producer**
  - Owns: `packages/interfaces/src/http/forms-owned.ts`, `packages/interfaces/test/owned-forms.test.ts`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V10.2 coercion/duplicate/proto source assessment while HTTP is blocked; prepare faithful producer fixtures only if accepted.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on V10.2 decision; V10.5/V10.6 only if accepted, with reviewed evidence and handoff.
- **V-evidence — Fixtures, resource harness and acceptance ledger**
  - Owns: `packages/values/conformance/owned-input/v1/`, `docs/ideal-filetree-plan.md`. Evidence outputs are owned by the task that writes them.
  - Ready backlog: Work V01.1 inventory, V03.1 tagged fixtures and V11.1 precommitted budgets; assemble harness cases before backend gates land.
  - Allocation/exit: one 0.5–2 day patch at a time; exit on All V parent review gates and V12 ledger; deferred optional work remains open, with reviewed evidence and handoff.

### Dispatch checklist

Each leaf lists start dependencies, exact files/outputs, actions and acceptance. Command labels A1–A4/B1–B5 below are verification recipes, not scheduling IDs. Within a named lane, execute any ready leaf; the parent gates at the end of each wave review evidence without gating unrelated ready children.

#### Wave 1 — Source contracts and early optional-path assessment

- **Parallel lane V-plan — Owner plans and schema preparation**
  - [ ] **V01.4 — Agree owner-plan and shared-file handoffs.**
    - Start: `C01.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/plan-contract.md`.
    - Actions:
      - Resolve factory provenance, copied owner metadata, schema/artifact revisions, default references and plan handles with exact-values/C03 owners.
      - Assign shared lib.rs/manifests/codecs/mod.rs/ABI glue to V-integrator after explicit arithmetic/C03 handoff; record responsibility layout against living filetree without implementing it.
    - Acceptance:
      - No second currency, Decimal, wire authority, catalog or compiler work; immutable data copies and private owner tokens establish provenance, never freeze/shape alone.
      - Each lane has exclusive module files and exact-values publishes A03.foundation before arithmetic completion.

- **Parallel lane V-http — HTTP profile and owning handler/module join**
  - [ ] **V01.2 — Assess bounded HTTP adoption join.**
    - Start: `C01.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md`.
    - Actions:
      - Trace existing handleOperationRequest through interfaces, assembly and deploy; specify bounded handler injection and canonical bridge/module handoffs.
      - Capture auth/CSRF/ID/catalog order, current interim 501, JSON versus forms and sealed action_handle carve-out.
      - Within two working days record owner-approved bounded join or blocked default deployment; send cost versus prepared-TS tradeoff to coordinator/JEV if hard.
    - Acceptance:
      - C01 source-owner contract names exact existing-handler join and owning files, or states absence without inventing a new HTTP feature.
      - Package/workerd fixture proof and default deployed adoption are separately testable gates; blocked join retains default 501.

- **Parallel lane V-state — Generated-state profile and canonical bridge**
  - [ ] **V01.3 — Freeze state sequencing and bridge contract.**
    - Start: `C01.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-contract.md`.
    - Actions:
      - Trace generated/interim/internal inputs and loader-derived delivery-field channel; assign canonical invoker input association and detached raw snapshot handoff.
      - Specify receipt replay, raw hash, auth, normalization and ordered-load trace plus protected/public graph separation and copy-cost observer.
    - Acceptance:
      - Contract preserves readRevision → hash(raw) → readReceipt → replay OR age → membership/by → normalize/ref-extract → ordered loads and read auth-first.
      - Protected graph never crosses arbitrary OperationInvoker callbacks; unproven/generated-handler/internal calls retain legacy TS.

- **Parallel lane V-mcp — MCP provenance decision and ordinary profile**
  - [ ] **V10.1 — Inspect installed MCP SDK producer seam early.**
    - Start: `C01.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-provenance.md`.
    - Actions:
      - Inspect installed exact SDK version/source, transport JSON parser, validators, mutation/callback paths and ordinary versus sealed mode; save references.
      - Within two working days choose parser-created internal seam without reparsing or arbitrary-object adoption, or deferred/legacy outcome; raise hard SDK tradeoff with verified facts to coordinator/JEV.
    - Acceptance:
      - Decision includes source/version and evidence that a protected graph can stay inaccessible until conversion; types, freeze or SDK object inspection do not certify it.
      - Deferred MCP is explicitly unported and does not block HTTP preparation or deployment package proof.

- **Parallel lane V-forms — Independent forms source assessment and optional producer**
  - [ ] **V10.2 — Assess forms producer separately.**
    - Start: `C01.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/forms-provenance.md`.
    - Actions:
      - Trace current JSON-or-string coercion, duplicate fields, assignment and own __proto__ behavior; identify faithful owner-built graph or retained TS.
      - Timebox source assessment to two working days and record chosen/deferred coverage independently of SDK outcome.
    - Acceptance:
      - No JSON lineage is inferred for form objects; coercion, duplicate and current __proto__ semantics are explicit.
      - Decision permits independent HTTP JSON progress and states that deferred forms are not ported.

- **Parallel lane V-evidence — Fixtures, resource harness and acceptance ledger**
  - [ ] **V01.1 — Freeze caller contracts and workload registry.**
    - Start: `C01.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/contracts.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/caller-inventory.json`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/current-ts.json`.
    - Actions:
      - Inventory schema/wire/framing/binding/state calls, public exports, producer ownership, generated versus interim paths, metadata channels and mutation opportunities.
      - Lock values/v1, http-input/v1, mcp-ordinary/v1, state-generated/v1 and legacy-ts coverage; nominate complete HTTP, malformed, state normalization/replay workloads.
      - Record checkpoint/source hashes and fresh A1–A3 baselines, including failure ownership; never use stale emitted output after a failed build.
    - Acceptance:
      - Owners review each admitted domain, error/order/identity obligation and consumer; public arbitrary-unknown and hand-built schemas remain fully legacy TS.
      - contracts.md and caller-inventory.json distinguish deployed MCP, HTTP 501, forms and handle mode; no full-port claim.

- **Integration review lane V-evidence — parent completion gates**
  - [ ] **V01 — Caller and ownership contracts reviewed.**
    - Start: `V01.1`, `V01.2`, `V01.3`, `V01.4`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: Five profile/input domains, workloads, baseline and HTTP/source ownership gap agreed.

#### Wave 2 — Prepared TS, structural ABI and parser provenance

- **Parallel lane V-integrator — Shared values and ABI integration owner**
  - [ ] **V02.6 — Wire private prepared hooks without public API drift.**
    - Start: `V02.1`, `V02.2`.
    - Files/output: `packages/values/src/schema.ts`, `packages/values/src/wire.ts`, `packages/values/src/index.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-hook-review.md`.
    - Actions:
      - Apply values/plan lane hook specifications under single ownership; keep public exports/synchronous signatures and legacy string paths.
      - Audit genuine factory-producer registration and fallback selection before evaluation; add no public handle/adopt API.
    - Acceptance:
      - A1/B2 current/facade legacy traces match; unknown/default/schema accessors observe the old evaluation order.
      - Private prepared calls reach extracted modules while unknown callers remain TS; no semantic exception retry.

- **Parallel lane V-plan — Owner plans and schema preparation**
  - [ ] **V02.1 — Prepare immutable owner plans in TS.**
    - Start: `V01`, `C02.ready`.
    - Files/output: `packages/values/src/prepared/plan.ts`, `packages/values/test/prepared-validation.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-plan-handoff.md`.
    - Actions:
      - Extract resolved ordered type/union/leaf plans from genuine factory owners, including bounds/default metadata and default registry keys.
      - Keep unknown string wrappers and structural normalized-schema acceptance outside cache; hand private factory hook patch specification to integrator.
    - Acceptance:
      - Descriptor/default/bounds mutation, forged schema tags and freeze-without-provenance do not mutate registered plans or promote legacy schemas.
      - Owner-plan TS fixtures preserve current descriptor normalization/default validation semantics and synchronous behavior.
  - [ ] **V03.4 — Implement owner registration and generation handles.**
    - Start: `V02.1`, `V03.1`.
    - Files/output: `packages/values/semantics/src/plans.rs`, `packages/values/bindings/plans.ts`, `packages/values/test/prepared-validation.test.ts`.
    - Actions:
      - Copy private owner-produced ordered plans and defaults; resolve union/type dispatch once and scope to owner/artifact revision.
      - Add instance/version/generation ownership, bounded registration and inactive-scope invalidation without active plan eviction.
    - Acceptance:
      - Accessor/proxy schemas remain legacy; pre/post-registration mutation, schema identity reuse, forged defaults and duplicate/invalid descriptors cannot corrupt plans.
      - Foreign/stale/disposed handles fail construction before execution, release is idempotent and no caller-controlled unbounded type-string cache.

- **Parallel lane V-input — Parser provenance, arenas and lifetimes**
  - [ ] **V03.2 — Build ordered input transport arena.**
    - Start: `V03.1`.
    - Files/output: `packages/values/semantics/src/input.rs`, `packages/values/semantics/tests/input_validation/input.rs`.
    - Actions:
      - Implement tagged ordered transport tree with UTF-16 code units/f64 bits/presence and checked counts/allocation.
      - Separate raw transport representation from semantic codecs; use iterative conversion and no serde_json loss/canonicalization.
    - Acceptance:
      - Host parser numeric outcomes including nonfinite and -0 remain representable and reach appropriate profile/hash rejection stage.
      - Numeric-looking key order, duplicate JSON keys, own __proto__, controls and lone surrogates retain exact data.
  - [ ] **V03.3 — Create private parser token and controlled lineage.**
    - Start: `V01`, `C03.ready`, `A03.foundation`.
    - Files/output: `packages/values/bindings/owned-input.ts`, `packages/interfaces/src/http/limits.ts`, `packages/values/test/owned-input.test.ts`.
    - Actions:
      - Add private owned parser path calling unchanged capped reader/TextDecoder/JSON.parse; record provenance in WeakMap at parser creation before exposure.
      - Preserve public parseJsonBody signature; controlled derivatives strip host fields with own data definitions and original enumeration/duplicate semantics.
      - Token creation performs no semantic traversal, plan selection, conversion or Rust budget check; expose private canonical bridge handoff only.
    - Acceptance:
      - Forged tokens, frozen proxies, schema tags and mutated/exposed public copies cannot enter owned execution; no adopt(unknown).
      - Malformed/empty/scalar-root JSON, byte caps/chunk cancellation, BOM and syntax errors match current host stage; forms retain their path.

- **Parallel lane V-values — Values interpreter, codecs and materialization**
  - [ ] **V02.2 — Prepare values AST codec and whole-call comparator.**
    - Start: `V02.1`, `C02.ready`.
    - Files/output: `packages/values/src/prepared/codec.ts`, `packages/values/src/prepared/validation.ts`, `packages/values/test/legacy-validation-traces.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-values.json`.
    - Actions:
      - Extract package-private AST codec/ordered values execution with default identity; produce hook specification rather than editing public schema/wire modules.
      - Compare current/prepared whole results, errors, freezing/identity and allocation/timing; preserve legacy reads and exceptions including getter second value, proxy traps, sparse/cycles/toJSON.
    - Acceptance:
      - Current/prepared TS agree over values matrix and legacy traces; getters are never eagerly snapshotted or shadow-executed.
      - Prepared TS is independently adoptable; hand-built schemas and unknown encode/decode inputs retain full legacy scope.

- **Parallel lane V-http — HTTP profile and owning handler/module join**
  - [ ] **V02.3 — Prepare interfaces HTTP framing/binding plan.**
    - Start: `V01`, `C02.ready`.
    - Files/output: `packages/interfaces/src/envelope/prepared.ts`, `packages/interfaces/test/owned-http.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-http.json`.
    - Actions:
      - Project ordered allowed/required/binding inputs after owner catalog checks; preserve shape-only framing with no derived metadata.
      - Compare current/prepared HTTP complete framing+binding, raw business result, bound literal messages and top-level leniency.
      - Publish read-only projection interface for MCP lane, whose separate module owns its ref profile.
    - Acceptance:
      - First unknown JS-enumeration key, first missing shape field, first bound derived-input error remain in order; explicit own null/undefined differs from values.
      - HTTP currency-string/string-boolean deferral rules remain distinct; no defaults or manufactured values schema.

- **Parallel lane V-state — Generated-state profile and canonical bridge**
  - [ ] **V02.4 — Prepare generated-state owner plan.**
    - Start: `V01`, `C02.ready`.
    - Files/output: `packages/state/src/invocation/prepared-inputs.ts`, `packages/state/src/invocation/registry.ts`, `packages/state/test/invocation/owned-admission.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-state.json`.
    - Actions:
      - Project copied data-only generated metadata within loader with private provenance; preserve delivery-field membership owner channel.
      - Prepare state presence/ref/ordinary-array behavior and compare current TS at existing admission point without changing invocation/hash order.
    - Acceptance:
      - Generated scalars stay presence-only, strict positive ≤15-digit versions and extra-ref permissiveness persist; operation defaults stay host-owned.
      - Generated fills are fresh arrays/shallow copy, interim input identity unchanged; permissive unknown loader results never enter owned cache.

- **Parallel lane V-mcp — MCP provenance decision and ordinary profile**
  - [ ] **V02.5 — Prepare ordinary MCP plan independently of adoption.**
    - Start: `V01`, `C02.ready`, `V02.3`.
    - Files/output: `packages/interfaces/src/mcp/prepared.ts`, `packages/interfaces/src/mcp/schemas.ts`, `packages/interfaces/test/owned-mcp.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-mcp.json`.
    - Actions:
      - Derive binding/ref projection after artifact checks, consuming HTTP projection through its read-only API.
      - Compare closedness → descriptor refs → derived binding and null deferral in pure inert fixtures without claiming SDK provenance.
    - Acceptance:
      - Exact ref keys/ID ≤256 UTF-16 units and arbitrary digits versions remain MCP-specific; query operation_id remains unknown business member.
      - InvalidParams projection and sealed host path preserved; pure profile work proceeds even when SDK adoption is deferred.

- **Parallel lane V-evidence — Fixtures, resource harness and acceptance ledger**
  - [ ] **V03.1 — Define validation ABI extension and decision vectors.**
    - Start: `V01`, `C03.ready`, `A03.foundation`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-vectors.json`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-decisions.md`, `packages/values/conformance/owned-input/v1/cases.json`, `packages/values/conformance/owned-input/v1/README.md`.
    - Actions:
      - Resolve ordered UTF-16 text/keys, f64 bits, presence/default/sentinel/drop tags and length checks with shared values/C03 owners.
      - Verify selected pinned dependency/binding APIs against primary docs before coding; record versions, native/Wasm license/support/build constraints and synchronous route.
      - Measure representative/deep/wide schemas and propose versioned ownership/limit decisions within one working day; send hard ABI/limits tradeoffs to coordinator/JEV.
    - Acceptance:
      - Vectors distinguish -0, huge rounded JSON integers, 1e400, numeric strings, null/bool/array/object, lone surrogate keys/text and own __proto__.
      - Host JSON semantics preserved; number-free opaque json is never used as transport, fixed-width counts reject before coercion.
  - [ ] **V11.1 — Precommit workloads and numeric adoption budgets.**
    - Start: `V01`, `C05.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/measurement-contract.md`.
    - Actions:
      - Freeze current-ts/prepared-ts/owned-rust workload registry, exact C05 executable command/output schema and resource/startup/CPU/size budgets before Rust comparisons.
      - Ratify or replace shared provisional 20% median complete-call improvement/10% typical-error p95 regression budgets with real callers/native reuse target.
    - Acceptance:
      - Precommitment precedes final comparisons and contains representative malformed/error-heavy HTTP/state/replay workloads plus supported MCP only.
      - Worker CPU timing follows shared harness policy; leaf/native timings or removed type parsing cannot justify adoption.

#### Wave 3 — Independent semantic profiles and minimal actual binding

- **Parallel lane V-integrator — Shared values and ABI integration owner**
  - [ ] **V03.5 — Land coordinated minimal binding and shared module registrations.**
    - Start: `V03.2`, `V03.4`, `C04.ready`, `A07.foundation`.
    - Files/output: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/semantics/src/codecs/mod.rs`, `packages/values/bindings/src/lib.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`, `packages/values/test/validation-binding.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-binding-smoke.json`.
    - Actions:
      - Accept explicit A07.foundation/C03 owner handoff of shared registrations; add thin versioned structural transport/plan scaffold entry and error envelope without duplicating numeric transport.
      - Compile/import pinned generated glue via shared binding owner; run same-call structural scalar/text/presence vectors in Node/Bun and actual C04 workerd route.
      - Keep native tests in file-disjoint child modules; only integrator edits root test/module files and generated glue is reproducible, never hand-edited.
    - Acceptance:
      - Actual binding, not serializer-only simulation, preserves bits/UTF-16/keys and checks malformed version/length/fixed-width overflow before coercion.
      - C04 smoke inventory and bootstrap checks prove real bytes; fake bindings and native-only JSON cannot complete V03.

- **Parallel lane V-values — Values interpreter, codecs and materialization**
  - [ ] **V04.1 — Implement ordered values traversal and policy.**
    - Start: `V02.2`, `V03.2`, `V03.4`, `A04.5`, `A05.3`, `A04.2`.
    - Files/output: `packages/values/semantics/src/validation.rs`, `packages/values/semantics/src/profiles/values.rs`, `packages/values/semantics/tests/input_validation/values.rs`.
    - Actions:
      - Implement contracts/enums/unions/arrays, complete union/array elements, omissions/update sentinels, explicit-complete defaults and engine field drops.
      - Accumulate ordered violations, inclusive bounds/trim-after-decode-before-bounds, recursive mutation refs, secret refusal and unknown-field/argument distinctions.
    - Acceptance:
      - B1 native fixed/seeded fixtures match all ordered errors, paths and values; failure never publishes partial result.
      - No JSON Schema/Serde default policy; create/update/nullability/nullable-array precedence and legacy presence remain unchanged.
  - [ ] **V04.2 — Implement owned codec dispatch and materialization.**
    - Start: `V04.1`.
    - Files/output: `packages/values/semantics/src/codecs/owned.rs`, `packages/values/bindings/materialize.ts`, `packages/values/semantics/tests/input_validation/values.rs`.
    - Actions:
      - Reuse A04/A05 exact scalar codecs/carrier conversions for decode/encode, refs and number-free opaque JSON.
      - Resolve DefaultRef through owner shared frozen registry, implicit emptyArray identity, UPDATE_OMITTED symbol and engine drop markers.
    - Acceptance:
      - Exact spelling/leading zeros/-0/scale/canonical text, numeric JSON refusal, money currency/keys and temporal edges match shared oracle.
      - Repeated defaults/empty arrays keep identity and frozen structure; returned structural BigInt/Decimal/Money match TS, generated-state arrays stay fresh.

- **Parallel lane V-http — HTTP profile and owning handler/module join**
  - [ ] **V06.1 — Implement HTTP-only native profile.**
    - Start: `V02.3`, `V03.2`, `V03.4`, `A04.5`, `A05.3`.
    - Files/output: `packages/values/semantics/src/profiles/http.rs`, `packages/values/semantics/tests/input_validation/http.rs`, `packages/interfaces/test/owned-http.test.ts`.
    - Actions:
      - Implement one framing+binding operation with own-presence and submitted raw business result; reuse only appropriate exact/datetime primitives.
      - Preserve catalog-without-derived and first error detail; prove deliberate HTTP disagreement with values/state/MCP fixtures.
    - Acceptance:
      - No values interpreter or URL/Intl predicate prerequisite; HTTP first unknown → first missing → first bound order and path spelling match.
      - HTTP ref extras/currency-string and deferred string/boolean semantics remain permissive as baseline; top-level/action_handle rules unchanged.

- **Parallel lane V-state — Generated-state profile and canonical bridge**
  - [ ] **V06.2 — Implement generated-state native profile.**
    - Start: `V02.4`, `V03.2`, `V03.4`.
    - Files/output: `packages/values/semantics/src/profiles/state.rs`, `packages/values/semantics/tests/input_validation/state.rs`, `packages/state/test/invocation/owned-admission.test.ts`.
    - Actions:
      - Implement aggregate unknown/required/array/ref errors, absence-only optional array fills and ordered ref extraction with strict state versions.
      - Preserve generated scalar presence-only behavior, null/present undefined and normal shallow copy; no operation-default application.
    - Acceptance:
      - Native vectors preserve safe-number conversion, extra ref-member permissiveness, unescaped legacy paths and state-specific error accumulation.
      - No external store/auth/ref loads are performed by pure profile; model/defaulted scenario callable remains host-owned.

- **Parallel lane V-mcp — MCP provenance decision and ordinary profile**
  - [ ] **V06.3 — Implement ordinary MCP native policy.**
    - Start: `V02.5`, `V03.2`, `V03.4`, `A04.5`, `A05.3`.
    - Files/output: `packages/values/semantics/src/profiles/mcp.rs`, `packages/values/semantics/tests/input_validation/mcp.rs`, `packages/interfaces/test/owned-mcp.test.ts`.
    - Actions:
      - Implement closedness then descriptor ref shape then derived binding; mutation ID orchestration stays host and null deferral uses only present derived members.
      - Preserve MCP arbitrary digits versions, exact refs and UTF-16 ID length; map errors through own host InvalidParams projection.
    - Acceptance:
      - Native pure fixtures agree with current/prepared including multi-error disagreement cases; sealed mode untouched.
      - Implementation of profile alone never certifies SDK producer seam or claims deployed migration.

- **Parallel lane V-evidence — Fixtures, resource harness and acceptance ledger**
  - [ ] **V02.7 — Publish complete current and prepared-TS comparator ledger.**
    - Start: `V02.1`, `V02.2`, `V02.3`, `V02.4`, `V02.5`, `V02.6`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/prepared-ts.json`.
    - Actions:
      - Assemble per-owner complete result/error/order/identity and timing/allocation evidence against unchanged current-ts.json.
      - Publish prepared-ts.json with profiles, baseline commands, failures and retained unknown-domain coverage.
    - Acceptance:
      - Current/prepared baselines are separate auditable measured outcomes, not inferred from extraction or removed string parsing.
      - A1–A3/B2 traces and default/empty/sentinel identity agree; prepared TS remains independently adoptable.

- **Integration review lane V-evidence — parent completion gates**
  - [ ] **V02 — Prepared TS complete-call baseline reviewed.**
    - Start: `V02.1`, `V02.2`, `V02.3`, `V02.4`, `V02.5`, `V02.6`, `V02.7`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: A1–A3/B2 current/prepared semantics, identity, order, timings and retained legacy traces agree.
  - [ ] **V03 — Versioned ownership ABI proved through actual binding.**
    - Start: `V03.1`, `V03.2`, `V03.3`, `V03.4`, `V03.5`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: Same-call scalar/UTF-16/provenance/handle vectors pass native, Node/Bun and C04 workerd; references/version/limit decisions recorded.

#### Wave 4 — Binding parity, lifetime proof and early canonical bridge

- **Parallel lane V-integrator — Shared values and ABI integration owner**
  - [ ] **V06.8 — Register HTTP action after exact binding handoff.**
    - Start: `V06.1`, `V03.5`, `A07`.
    - Files/output: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/bindings/src/lib.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`.
    - Actions:
      - Accept final A07 arithmetic shared-file handoff and register HTTP leaf/action alone; do not declare absent values/state/MCP modules.
      - Build real action export and owning HTTP error projection; deliver action API to V-http.
    - Acceptance:
      - Actual HTTP whole-profile binding compiles and runs without waiting for values/predicates/SDK/forms; no duplicate numeric transport or shared-file race.
  - [ ] **V06.9 — Register generated-state action in serial integration queue.**
    - Start: `V06.2`, `V06.8`.
    - Files/output: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`.
    - Actions:
      - Register landed state leaf/action and error projection after HTTP shared-module edit; hand action API to state owner.
    - Acceptance:
      - State actual binding compiles against presence/ref policy without full values traversal; integrator alone edits shared roots.
  - [ ] **V06.10 — Register ordinary MCP action in serial integration queue.**
    - Start: `V06.3`, `V06.9`.
    - Files/output: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`.
    - Actions:
      - Register landed MCP leaf/action and InvalidParams host projection after preceding integrator task; producer adoption remains independent.
    - Acceptance:
      - Pure MCP actual binding compiles and owns separate profile policy; no implication of verified SDK lineage.
  - [ ] **V04.4 — Register values interpreter and materialization in serial queue.**
    - Start: `V04.2`, `V06.10`.
    - Files/output: `packages/values/semantics/src/lib.rs`, `packages/values/semantics/src/profiles.rs`, `packages/values/semantics/src/codecs/mod.rs`, `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/semantics/tests/input_validation.rs`.
    - Actions:
      - Register landed values traversal/owned codec and host materialization after preceding shared edits; consume values lane handoff without editing leaf files.
    - Acceptance:
      - Actual whole values calls reconstruct structural/default/sentinel results and ordered failures; shared module edits remain serialized.
  - [ ] **V05.3 — Wire proved predicate and retained-encode glue.**
    - Start: `V05.2`, `V04.4`.
    - Files/output: `packages/values/bindings/src/validation.rs`, `packages/values/bindings/validation.ts`, `packages/values/test/validation-binding.test.ts`.
    - Actions:
      - Consume values predicate/retained encode handoff and wire synchronous demand-ordered callback/result protocol in shared adapter.
      - Run B1/B2 actual-binding callback-count/throws/formatting and same-session encoding cases.
    - Acceptance:
      - Host invocation order, unsupported-plan selection and lossless text/error formatting agree through actual binding; same-session results never escape disposal.

- **Parallel lane V-plan — Owner plans and schema preparation**
  - [ ] **V07.5 — Apply finalized owner-plan budget and release policy.**
    - Start: `V07.1`, `V03.4`.
    - Files/output: `packages/values/semantics/src/plans.rs`, `packages/values/bindings/plans.ts`, `packages/values/src/prepared/plan.ts`, `packages/values/test/prepared-validation.test.ts`.
    - Actions:
      - Apply input-owner finalized profile/version/plan-memory/count budgets to registration and prepared owner plan comparator.
      - Prove inactive-only eviction/generation invalidation, active request retention, owner reload and default registry release handoff.
    - Acceptance:
      - Registration over budget rejects owner before serving; no active plan eviction, stale handle execution or retained defaults after owner disposal.
      - Same prepared/Rust owner contract applies without caching arbitrary schemas or narrowing legacy exports.

- **Parallel lane V-input — Parser provenance, arenas and lifetimes**
  - [ ] **V07.1 — Finalize request/plan limits and cleanup implementation.**
    - Start: `V03.2`, `V03.3`, `V03.4`, `V03.5`, `C05.ready`.
    - Files/output: `packages/values/semantics/src/input.rs`, `packages/values/bindings/owned-input.ts`, `packages/values/test/validation-lifecycle.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/resource-policy.md`.
    - Actions:
      - Measure proposed 256 plans/16 MiB plans/1 MiB body/32 MiB request/128 frames/1048576 nodes and fix budget/version/error contract before rollout.
      - Implement iterative checked arena policy, one arena per active request, idempotent disposal and cancellation/client-disconnect/throw/replay cleanup; coordinate plan release changes through plan owner.
      - Resolve any narrowing of successful legacy HTTP input with explicit C01/JEV profile decision; new limits never silently affect legacy.
    - Acceptance:
      - Stale/foreign/generation handles reject before Rust; traps/stack overflow are adapter failures, not legacy cycle RangeError.
      - No active eviction, global result retention or unchecked counts; public legacy domain unchanged.

- **Parallel lane V-values — Values interpreter, codecs and materialization**
  - [ ] **V05.1 — Prove demand-ordered host predicate protocol.**
    - Start: `V04.2`, `V04.4`.
    - Files/output: `packages/values/bindings/predicates.ts`, `packages/values/semantics/src/codecs/owned.rs`, `packages/values/semantics/tests/input_validation/values.rs`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/host-predicates.json`.
    - Actions:
      - Implement synchronous demand-ordered URL/Intl/ICU predicates and closed diagnostic templates with lossless ordered arguments.
      - Reuse JS number/string rendering/truncation and owning error reconstruction; record predicate calls/throws; unsupported actions choose TS at registration.
      - Resolve protocol/callback-cost tradeoff with runtime spike within two working days; record coordinator/JEV advice when difficult.
    - Acceptance:
      - No lossy String conversion or eager precomputation before earlier violations; runtime URL/locale/timezone/currency behavior matches.
      - Unsupported plan fallback precedes input evaluation, never retries semantic exceptions; HTTP can progress without these callbacks.
  - [ ] **V05.2 — Encode retained interpreter results inside request.**
    - Start: `V05.1`.
    - Files/output: `packages/values/semantics/src/codecs/owned.rs`, `packages/values/bindings/materialize.ts`, `packages/values/semantics/tests/input_validation/values.rs`.
    - Actions:
      - Add optional same-session encoding over interpreter-produced result handles with exact numeric primitives.
      - Preserve encode ValueError versus decode violations; public arbitrary unknown encode remains legacy TS.
    - Acceptance:
      - Same-call normalize+encode parity preserves scale/canonical text, shape/error paths and structural/default identity.
      - Request-scoped result cannot be forged, reused after disposal or adopted from arbitrary unknown.
  - [ ] **V07.3 — Apply owned budgets to prepared values comparator.**
    - Start: `V07.1`, `V05.2`.
    - Files/output: `packages/values/src/prepared/validation.ts`, `packages/values/src/prepared/codec.ts`.
    - Actions:
      - Apply fixed owned traversal/allocation/limit policy to prepared values action using input owner policy contract.
      - Preserve legacy unknown comparator and predicate error/disposal behavior.
    - Acceptance:
      - Selected backend does not change owned limits; unsupported legacy plans keep old success/exception domain.
      - Earlier semantic failures retain precedence over later predicates/allocation work.

- **Parallel lane V-http — HTTP profile and owning handler/module join**
  - [ ] **V06.4 — Run independent HTTP actual-binding profile parity.**
    - Start: `V06.1`, `V06.8`.
    - Files/output: `packages/interfaces/test/owned-http.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-profile-differential.json`.
    - Actions:
      - Run current/prepared/native/actual binding HTTP full framing+binding with profile/version and ordered errors.
      - Cover missing catalog/skew, shape-only catalog, exact/date edge scalars, top-level extras, action_handle and profile differences.
    - Acceptance:
      - A2/B2 errors and raw business inputs agree including optional-property absence and baseline pointer spelling.
      - Binding does not allocate/validate before host auth/CSRF/ID stages when installed at consumer.

- **Parallel lane V-state — Generated-state profile and canonical bridge**
  - [ ] **V06.5 — Run state actual-binding profile parity.**
    - Start: `V06.2`, `V06.9`.
    - Files/output: `packages/state/test/invocation/owned-admission.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-profile-differential.json`.
    - Actions:
      - Run pure state current/prepared/native/actual binding matrix including delivery metadata, strict refs and fresh fills.
      - Assert values/state/interface differences deliberately rather than unifying their error/presence policy.
    - Acceptance:
      - A3/B2 pure state matches current aggregate paths/errors and ordered refs without store side effects.
      - Generated defaults/scalars/interim identity remain in owning scope.
  - [ ] **V09.1 — Implement canonical private provenance bridge handoff.**
    - Start: `V01.3`, `V03.3`, `V02.4`, `W06.runtimehandoff`.
    - Files/output: `packages/cloudflare/src/runtime/invoke.ts`, `packages/state/src/invocation/prepared-inputs.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/bridge-handoff.md`.
    - Actions:
      - Associate protected raw snapshot privately with canonical invoker envelope identity; ordinary detached materialization crosses public boundary.
      - Publish narrow bridge API for HTTP handler fixture and module owner; never pass a transferable token to arbitrary injected invoker.
      - Snapshot creation protects raw graph only and performs no plan lookup, semantic traversal/conversion/defaulting or new Rust budget ahead of replay.
    - Acceptance:
      - HTTP lane consumes bridge API without editing runtime/invoke.ts; state lane alone owns bridge modules.
      - Public copy mutation loses token use; unknown/custom callbacks retain legacy validation; copy cost is separately observable.

- **Parallel lane V-mcp — MCP provenance decision and ordinary profile**
  - [ ] **V06.6 — Run MCP actual-binding profile parity.**
    - Start: `V06.3`, `V06.10`.
    - Files/output: `packages/interfaces/test/owned-mcp.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-profile-differential.json`.
    - Actions:
      - Run pure MCP current/prepared/native/actual binding matrix with null/ref/bound stages and HTTP agreement where contracts coincide.
      - Keep installed SDK provenance outcome separate from inert profile tests.
    - Acceptance:
      - A2/B2 preserve exact refs, ID UTF-16 limits, InvalidParams and sealed-path selection.
      - Passing vectors do not mark MCP production port complete when SDK branch is deferred.

- **Parallel lane V-evidence — Fixtures, resource harness and acceptance ledger**
  - [ ] **V04.3 — Run actual-binding values parity and identity.**
    - Start: `V04.2`, `V04.4`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/values-differential.json`, `packages/values/conformance/owned-input/v1/cases.json`.
    - Actions:
      - Run current/prepared/native/actual-binding values matrix with seeded independent cases and minimized failing seeds.
      - Persist profile/version, code/message/class/kind/path/expected/actual/optional-absence, ordered violations, result identity/freeze and core-entry traces.
    - Acceptance:
      - B1/B2/A1 have zero unexplained differences for supported values profile; no partial output on failure.
      - Tagged UTF-16/f64 fixtures do not collapse -0/nonfinite/identity and retained legacy traces prove Rust is not invoked.
  - [ ] **V07.2 — Prove HTTP resource readiness independently.**
    - Start: `V07.1`, `V07.5`, `V06.4`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-resources.json`, `packages/values/conformance/owned-input/v1/resources.mjs`.
    - Actions:
      - Build dedicated resource harness against deep/wide/malformed HTTP prepared TS and actual binding; persist allocations/high-water/live memory and defined limit errors.
      - Exercise success/failure/cancel, concurrent host-admitted requests, release/reload/default lifetime; hand off HTTP resource readiness immediately.
    - Acceptance:
      - Owned prepared TS and Rust enforce same fixed policy; memory plateaus and no result/default survives its owner scope.
      - HTTP rollout is unblocked by completed HTTP resource evidence, without waiting for optional MCP/forms or values predicates.
  - [ ] **V07.4 — Complete cross-profile resource proof.**
    - Start: `V07.2`, `V07.3`, `V06.5`, `V06.6`, `V05.3`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/resources.json`, `packages/values/conformance/owned-input/v1/resources.mjs`.
    - Actions:
      - Extend serialized harness ownership to values/state/MCP pure profiles, repeated register/release, default/result disposal, replay and predicate throws.
      - Publish resources.json with fixed numeric budgets, owner reload tests, prepared parity and unresolved contract decisions.
    - Acceptance:
      - B3 measured memory plateaus under representative and adversarial workloads; defined limits have no Rust traps and no stale cross-request reuse.
      - No defaults survive owner release or results request disposal; state successful replay incurs no new-plan budget before replay.

- **Integration review lane V-evidence — parent completion gates**
  - [ ] **V04 — Values ordered interpreter and identity proved.**
    - Start: `V04.1`, `V04.2`, `V04.3`, `V04.4`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: Complete values semantics match shared A04/A05 exact codecs through native and binding; identity/no partial results proved.
  - [ ] **V05 — Host predicate and optional encode contract proved.**
    - Start: `V05.1`, `V05.2`, `V05.3`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: Demand-ordered host text/predicates/errors and same-session encoding match; unsupported plans selected TS before execution.

#### Wave 5 — HTTP/state consumers and decision-gated optional branches

- **Parallel lane V-integrator — Shared values and ABI integration owner**
  - [ ] **V08.5 — Verify shared delivery module join when accepted.** **Optional decision-gated branch.**
    - Start: `V08.4`, `C04.validation-join`, `A07`.
    - Files/output: `packages/cloudflare/test/owned-input-delivery.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-default-deployment.json`.
    - Actions:
      - Start only accepted join branch after shared C04.validation-join consumes V08.4 assembly/module requirements; C04 alone edits bundle.ts.
      - Inspect shared typed asset inventory and existing deployed module map/digest contract without editing delivery source; prove real default deployment loading.
    - Acceptance:
      - A4/B4 owning joined entry/map serves actual handler using shipped binary, not fixture-only module inventory.
      - Missing/corrupt/wrong-version binaries fail visibly; release inventory/source maps never decode Wasm as text.

- **Parallel lane V-http — HTTP profile and owning handler/module join**
  - [ ] **V08.1 — Install whole HTTP action at existing validation point.**
    - Start: `V06.4`, `V07.2`, `V03.3`, `V09.1`, `C04.ready`, `A07`.
    - Files/output: `packages/interfaces/src/http/operations.ts`, `packages/interfaces/test/owned-http.test.ts`.
    - Actions:
      - Connect protected parse → current auth/CSRF/ID/catalog → whole framing+binding → unchanged invoker envelope/error/form draft.
      - Use protected lineage for canonical bridge only; arbitrary invoker callback invalidates state ownership.
      - Integrate Node/Bun and workerd-supported backend selection without moving host stages or changing synchronous package APIs.
    - Acceptance:
      - A2/B4 order/status/body, body-cap/malformed JSON, top-level/action_handle, missing/unknown/bounds and HTML redisplay match.
      - No Rust work before current validation point; one selected backend per request and no semantic-error retry.
  - [ ] **V08.2 — Prove actual handler package consumer in workerd.**
    - Start: `V08.1`, `V09.1`, `C04.values-assets`.
    - Files/output: `packages/cloudflare/test/owned-http-route.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-consumer.json`.
    - Actions:
      - Use real identity/catalog/canonical invoker fixtures and shipped Wasm assets to reach existing handleOperationRequest under actual workerd.
      - Record request trace, binding calls, deployment module inventory, errors/status/redaction/form redisplay and bootstrap failure cases.
    - Acceptance:
      - B4/A2 real workerd request reaches existing owning handler and canonical state invocation; mock or fixture-only JS binding is insufficient.
      - Report package consumer proof separately from default deployed traffic; unit injected invoker does not certify deployment.
  - [ ] **V08.3 — Decide bounded default deployment adoption.**
    - Start: `V01.2`, `V08.2`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-adoption-gate.md`.
    - Actions:
      - Re-review C01 bounded join, assembly/deploy map inventory and measured join cost with shared delivery owner.
      - Record accepted existing-handler join or blocked adoption/retained 501 with exact unmet evidence; consult coordinator/JEV if tradeoff is hard.
    - Acceptance:
      - Decision cannot create a new HTTP feature or treat fixture-only workerd as real default production use.
      - Default join acceptance explicitly dispatches V08.4/V08.5; absence leaves package completion possible with deployed adoption blocked.
  - [ ] **V08.4 — Land owning assembly join when accepted.** **Optional decision-gated branch.**
    - Start: `V08.3`, `V09.1`.
    - Files/output: `packages/cloudflare/src/worker/assembly.ts`, `packages/cloudflare/test/owned-http-route.test.ts`.
    - Actions:
      - Start only when V08.3 accepts C01 bounded existing-handler join; assemble existing identity/catalog/canonical handler using V-state bridge API.
      - Hand exact module/import/assets requirements to integrator without editing bundle.ts or runtime/invoke.ts.
    - Acceptance:
      - Owning default route serves existing handler rather than interim 501; no new server/feature scope.
      - A4/B4 assembly and workerd trace preserves host stages and sealed/other routes.
  - [ ] **V10.6 — Hook accepted form producer through HTTP owner.** **Optional decision-gated branch.**
    - Start: `V10.5`, `V08.1`.
    - Files/output: `packages/interfaces/src/http/operations.ts`, `packages/interfaces/test/owned-http.test.ts`.
    - Actions:
      - Start only accepted forms branch after HTTP handler task releases module; consume forms producer handoff under exclusive HTTP ownership.
      - Run complete forms handler redisplay/status/coercion differential.
    - Acceptance:
      - Optional forms acceptance proves complete consumer and faithful protected lineage; HTTP JSON semantics preserved.

- **Parallel lane V-state — Generated-state profile and canonical bridge**
  - [ ] **V09.2 — Install owned state execution after replay/auth only.**
    - Start: `V06.5`, `V07.2`, `V09.1`, `A07`.
    - Files/output: `packages/state/src/invocation/admission.ts`, `packages/state/src/invocation/invoke.ts`, `packages/state/src/invocation/prepared-inputs.ts`.
    - Actions:
      - Begin owned conversion/plan lookup/check+fill/ref extraction solely at existing validateCallInputs point after receipt/age/auth for mutation and after authorization for reads.
      - Preserve host raw sorted-key encoding/SHA-256 and detached snapshot matching; no edits to replay.ts/hash semantics.
      - Keep unproven/interim/internal/system/generated-handler input on legacy TS; host owns ordered loads/fences/permissions.
    - Acceptance:
      - Matching receipt replays even when input is now expired/forbidden/malformed or current plan/budget fails; conflicting raw reuse fails before normalizing.
      - Array fills/defaults never change persisted hash; admission/load/stale/archive/conflict-current/fence/read order unchanged.
  - [ ] **V09.3 — Prove durable state consumer traces and copy cost.**
    - Start: `V09.2`, `V08.2`, `V07.4`.
    - Files/output: `packages/state/test/invocation/owned-admission.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-replay-traces.json`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/state-copy-cost.json`.
    - Actions:
      - Run A3/B4 plus existing A4 durable suites through canonical bridge; persist raw-hash golden bytes and detailed receipt/auth/load traces.
      - Include -0/exponent/UTF-16 JSON escaping/TextEncoder policy, omission/null, trusted/live auth, stale/archive/conflict currents, fresh reads/fences and public input mutation.
      - Measure conversion/materialization/protected snapshot copy cost; timebox benefit question to two working days and raise coordinator/JEV if unresolved.
    - Acceptance:
      - Exact mutation trace and read auth-first match baseline; no eager ref loads on earlier failure, toJSON legacy ordering unchanged.
      - Raw digest/receipt compatibility and replay survive backend change; copies included in economic evidence.

- **Parallel lane V-mcp — MCP provenance decision and ordinary profile**
  - [ ] **V10.3 — Decide MCP adoption from complete seam and profile proof.**
    - Start: `V10.1`, `V06.6`, `V07.4`, `C04.ready`, `A07`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-provenance.md`.
    - Actions:
      - Revalidate installed SDK source/version and mutation/proxy/callback seam against actual binding/profile/resource evidence.
      - Choose accepted owned ordinary branch or explicit deferred legacy outcome; sealed handles stay host-owned.
    - Acceptance:
      - Only parser-created internal lineage before exposure, without second parse or object adoption, enables branch.
      - HTTP package/default gate remains independent; deferred result cannot be labelled full MCP port.
  - [ ] **V10.4 — Implement SDK-owned ordinary path only when accepted.** **Optional decision-gated branch.**
    - Start: `V10.3`, `V08.2`.
    - Files/output: `packages/interfaces/src/mcp/server.ts`, `packages/interfaces/src/mcp/schemas.ts`, `packages/interfaces/test/owned-mcp.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/mcp-consumer.json`.
    - Actions:
      - Start only accepted V10.3 branch; integrate private SDK producer seam and whole ordinary action at current host stage.
      - Prove SDK mutation/proxy/callback rejection, null/ref stages, HTTP agreement and deployed MCP factory with shipped assets.
    - Acceptance:
      - A2/B4 SDK JSON-RPC framing/error/results and InvalidParams agree; sealed mode keeps current orchestration.
      - Actual consumer proof, not profile fixtures alone, is required before MCP adoption enabled.

- **Parallel lane V-forms — Independent forms source assessment and optional producer**
  - [ ] **V10.5 — Implement faithful form producer only when accepted.** **Optional decision-gated branch.**
    - Start: `V10.2`, `V07.2`, `V08.2`.
    - Files/output: `packages/interfaces/src/http/forms-owned.ts`, `packages/interfaces/test/owned-forms.test.ts`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/forms-consumer.json`.
    - Actions:
      - Start only when V10.2 explicitly accepts faithful producer; build protected owner graph with same coercion/duplicates/current __proto__ behavior.
      - Publish narrow forms producer API and evidence for HTTP lane hookup without editing its operations/limits modules.
    - Acceptance:
      - Forms current/prepared/binding semantics and error/form draft match; no silent __proto__ fix or arbitrary-object adoption.
      - Unproved producer remains TS and branch incomplete.

- **Parallel lane V-evidence — Fixtures, resource harness and acceptance ledger**
  - [ ] **V08.6 — Close HTTP package and deployment ledger separately.**
    - Conditional order: V08.3 accepts bounded HTTP join additionally requires `V08.4`, `V08.5`. Declined branches remain unchecked and are recorded as deferred.
    - Start: `V08.2`, `V08.3`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/http-completion.md`.
    - Actions:
      - Review package consumer evidence and adoption decision; if accepted, require V08.4/V08.5 implementation proofs before recording default adoption enabled.
      - If join unavailable, state retained 501 and bounded follow-up; package proof cannot mark deployed path migrated.
    - Acceptance:
      - Package gate is complete only with actual handler/binding/workerd proof.
      - Default deployment is enabled only on accepted implemented join or explicitly blocked; optional branch boxes remain open when deferred.
  - [ ] **V10.7 — Close optional adoption decisions without false completion.**
    - Conditional order: V10.3 accepts MCP producer additionally requires `V10.4`; V10.2 accepts form producer additionally requires `V10.5`, `V10.6`. Declined branches remain unchecked and are recorded as deferred.
    - Start: `V10.3`, `V10.2`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/optional-coverage.md`.
    - Actions:
      - Record chosen/deferred MCP and forms outcomes independently; accepted outcomes require V10.4 or V10.5/V10.6 evidence before enablement.
      - Leave deferred branch tasks unchecked; keep unsupported-domain ledger and exact SDK source links.
    - Acceptance:
      - MCP/forms deferred/legacy status never marks their full port done; required scope-review gate may close while optional work remains open.
      - HTTP progress/measurement only consumes decision ledger, not deferred implementation.

- **Integration review lane V-evidence — parent completion gates**
  - [ ] **V07 — All owned resource/lifetime gates reviewed.**
    - Start: `V07.1`, `V07.2`, `V07.3`, `V07.4`, `V07.5`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: B3 same prepared/Rust versioned budget and cleanup plateau evidence reviewed; no legacy narrowing or pre-replay Rust work.
  - [ ] **V08 — Actual HTTP package consumer and adoption ledger reviewed.**
    - Start: `V08.1`, `V08.2`, `V08.3`, `V08.6`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: B4 actual handler/canonical invocation/Wasm/workerd proved; accepted join requires V08.4/V08.5 or default 501 remains explicitly blocked.
  - [ ] **V09 — Canonical owned-state sequencing and durable proof reviewed.**
    - Start: `V09.1`, `V09.2`, `V09.3`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: A3/A4/B4 raw hash/receipt replay/auth/ref loads/fences/reads and protected copy cost match; unproven paths retained TS.
  - [ ] **V10 — Optional MCP/forms outcome ledger reviewed.**
    - Start: `V10.1`, `V10.2`, `V10.3`, `V10.7`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: Decision review only: accepted MCP/forms require conditional consumer task proofs; deferred optional task boxes stay open and their full ports are not complete.

#### Wave 6 — Profile aggregation, release selection and complete-call measurement

- **Parallel lane V-integrator — Shared values and ABI integration owner**
  - [ ] **V11.2 — Prepare private release selection and rollback join.**
    - Start: `V02`, `V07`, `V08`, `V09`, `V10`, `C04.ready`, `C04.values-assets`, `A07`.
    - Files/output: `packages/values/bindings/backend.ts`, `packages/values/bindings/bootstrap.ts`, `packages/values/bindings/validation.ts`, `packages/values/tsconfig.json`, `packages/values/package.json`, `packages/values/Cargo.toml`, `packages/values/Cargo.lock`, `packages/values/semantics/Cargo.toml`, `packages/values/bindings/Cargo.toml`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/selection-rollback.json`.
    - Actions:
      - Accept A07/shared owner handoff and include binding TS emission/declarations/package/runtime/generated outputs in C04 inventory under single integrator.
      - Select prepared TS or supported Rust profile once per release/owner startup; unsupported legacy chooses TS before evaluating, never semantic-error retry.
      - Exercise prepared-TS restoration on committed receipt and in-flight drainage with immutable plan/profile, disposed-instance handle rejection and redacted shadow trace IDs.
    - Acceptance:
      - Missing/corrupt/version/ABI/init failures in selected Rust fail startup; ordinary package API remains synchronous/importable.
      - No receipt/raw-hash/default/schema migration and no duplicate auth/store/provider execution or shadowing legacy getters.

- **Parallel lane V-evidence — Fixtures, resource harness and acceptance ledger**
  - [ ] **V06.7 — Assemble profile differential ledger.**
    - Start: `V06.4`, `V06.5`, `V06.6`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/profile-differential.json`.
    - Actions:
      - Merge separate lane results and intentional disagreement fixtures with canonical error descriptors and no partial values.
      - Record supported versus legacy/unsupported plan selection and profile versions.
    - Acceptance:
      - All owned rows agree across current/prepared/native/actual binding; native-only JSON not credited.
      - Separate HTTP first errors, state aggregates, values accumulations and MCP stages remain visible.
  - [ ] **V11.3 — Measure complete selected calls and retained resources.**
    - Start: `V11.1`, `V11.2`, `V05`, `V06`, `V07`, `V08`, `V09`, `V10`, `C05.ready`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/measurements.json`.
    - Actions:
      - Run exact C05 B5 command for three named backends, actual existing-handler/Wasm/workerd plus state replay/normalization and only supported MCP.
      - Record cold/warm CPU/startup/allocation/retention/peak/high-water, raw/compressed Wasm/bundle size, malformed/error-heavy and full HTTP/state times.
      - Profile conversion/materialization/arena/protected-copy/predicate costs separately and include all in totals; default-deployment traffic only if join enabled.
    - Acceptance:
      - Zero unexplained parity differences and complete-call budgets assessed at precommitted thresholds; core-entry counts show real routing.
      - Results distinguish package fixture, default deployment and deferred consumers; no Rust-only interpreter or parser-removal inference.
  - [ ] **V11.4 — Review Rust versus prepared-TS adoption decision.**
    - Start: `V11.3`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/rollout-decision.md`.
    - Actions:
      - Review concrete native reuse or material whole-workload improvement and startup/resource regression against frozen budgets with owners.
      - Choose staged owner/profile adoption or prepared TS retained/Rust disabled; include coordinator/JEV advice, confidence/disagreement/investigation references.
      - Record HTTP default blocked/accepted, state separate adoption and MCP/forms conditional outcomes rather than widening into parser/compiler/orchestrator rewrite.
    - Acceptance:
      - No benefit retains prepared TS and experiment evidence; supported selected Rust requires C04, HTTP package/resource/parity and rollback proof.
      - State normalization stays after replay/auth even if HTTP enabled; deferred production paths never claimed migrated.

- **Integration review lane V-evidence — parent completion gates**
  - [ ] **V06 — Independent policy profiles reviewed.**
    - Start: `V06.1`, `V06.2`, `V06.3`, `V06.4`, `V06.5`, `V06.6`, `V06.7`, `V06.8`, `V06.9`, `V06.10`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: HTTP/MCP/state pure profile parity includes intentional version/ref/error/presence disagreements; no invented values schemas.
  - [ ] **V11 — Measured backend/adoption and rollback decision reviewed.**
    - Start: `V11.1`, `V11.2`, `V11.3`, `V11.4`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: B5 actual complete-call evidence and precommitted budgets/native reuse justify selected outcome; unsupported/default deployment scope explicit.

#### Wave 7 — Final source, release and merged coverage review

- **Parallel lane V-integrator — Shared values and ABI integration owner**
  - [ ] **V12.1 — Audit changed source, exports and release inventory.**
    - Start: `V11`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/final-source-checks.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/verify.log`.
    - Actions:
      - Refresh source line map, public exports/package declarations/runtime dependencies and shipped binary/module/JS/source-map inventory.
      - Run required focused A1–A4/B1–B4 for actual changed files and append exact C05 B5 command; capture raw logs and attribute preexisting Cloudflare typecheck failures.
      - Never report proposed commands as passed, test stale dist after build failure or opportunistically replace runners.
    - Acceptance:
      - No unexplained new diagnostic, public handle/export drift or hidden retained TS; complete source/output/lifetime ledger is reviewable.
      - Rollback/release bytes and raw receipt digest/schema remain unchanged; missing gate reported explicitly.

- **Parallel lane V-evidence — Fixtures, resource harness and acceptance ledger**
  - [ ] **V12.2 — Reconcile living filetree after actual merges.**
    - Start: `V12.1`.
    - Files/output: `docs/ideal-filetree-plan.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/filetree-review.md`.
    - Actions:
      - Review all changes since living plan checkpoint after each actual implementation merge, updating coverage and decisions together.
      - Advance checkpoint only after complete review; bookkeeping requires no recursive self-update and authorizes no new implementation.
    - Acceptance:
      - Merged implementation coverage/checkpoint reflects complete reviewed changes; this planning conversion itself does not advance it.
      - Final source list distinguishes implemented, proposed, unsupported and retained TS with ownership.
  - [ ] **V12.3 — Review declared-port completion and gaps.**
    - Start: `V12.1`, `V12.2`.
    - Files/output: `docs/research/package-subsystem-ports-20261006/evidence/input-validation/rollout-decision.md`, `docs/research/package-subsystem-ports-20261006/evidence/input-validation/completion-ledger.md`.
    - Actions:
      - Review C01–C05 contributions and all V01–V12 evidence against definition of done, fixture/binding/resource/durable/default identity/lossless UTF-16 proofs.
      - Explicitly record package completion, HTTP default join status, state enabled proof, SDK/forms deferred branches and full legacy TS scope.
    - Acceptance:
      - Declared owned port is complete only with supported real binding and actual handler workerd proof plus rollback/resources/source review.
      - Blocked adoption or deferred optional branches stay labelled; never claim complete legacy validator/MCP/forms migration.

- **Integration review lane V-evidence — parent completion gates**
  - [ ] **V12 — Final declared owned-port completion review.**
    - Start: `V12.1`, `V12.2`, `V12.3`.
    - Output: reviewed child evidence and completion ledger; no production writes.
    - Acceptance: Final-source-checks, verify.log, rollout decision and merged filetree review complete; definition of done satisfied or adoption blocked explicitly.

The Rust dependency choice is one ordered interpreter over the shared exact-values crate, using C03's pinned binding toolchain. It is not a new general schema engine. V03 must verify actual selected dependency/version APIs against primary documentation before coding and save those references; existing research establishes possible UTF-16/synchronous Wasm routes, not a current integrated API. Hard decisions sent to the parent/JEV gate are HTTP join cost vs prepared-TS value, UTF-16 ABI/callback cost, new-path limits, SDK provenance and whether state snapshot copies remove the migration benefit. Resolve each in the named task with evidence; do not leave a generic TODO or add host parser/hash rewrites to hide a weak result.

## Verification matrix

Run each owned-domain row against current TS, prepared TS, native interpreter and **actual binding**; native-only JSON tests do not prove adapters. Legacy rows run current/facade TS trace parity and assert Rust was not invoked. Persist input, profile/version, output/error descriptor, ordered paths, identity assertions and call trace. Seeded generative cases supplement fixed fixtures; failing seeds become minimized vectors. Use tagged code units and IEEE-754 bit strings in fixture files so JSON fixture serialization does not collapse `-0`, nonfinite transport results or identity.

| Area | Required cases and observable assertions |
| --- | --- |
| Parser/transport | Empty/malformed JSON, byte cap/chunk cancellation, valid scalar JSON roots, duplicate keys, numeric-looking keys, BOM/TextDecoder behavior, nested own `__proto__`, constructor/prototype keys, lone high/low surrogate text/keys, valid pairs, escaped controls. Preserve host parsing and top-level rejection messages. |
| Actual binding scalar edges | In the **same call** run parser-produced `0`, `-0`, fractional/exponential values, `9007199254740993`, `1e400`, strings spelling these numbers, bool/null/array/object through transport + chosen profile; verify f64 bits and error stage. Test fixed-width ABI overflow before coercion. Parsed nonfinite values are representable transport nodes and rejected by appropriate policy, never silently converted to null. |
| Exact codecs | Int64 min/max/adjacent, signed/leading-zero spellings, plus/exponents, JS numbers/BigInt refusal, decimal significant/fraction limits and retained scale, money exact keys/minor range/currency mismatch, duration/date/datetime extremes and millis/case/leap rules; shared exact-values oracle vectors. Same-call normalize+encode, not isolated leaf timings. |
| Presence/defaults | Absent vs own undefined vs null vs inherited key; nullable arrays, required arrays, implicit arrays + min bounds, update nested omission sentinels, complete union/array elements, explicit-complete default validation, server/derived keys, trim/default trim before inclusive bounds. Shared default identity and implicit values empty-array identity across calls; generated-state fresh arrays and interim original input identity. |
| Ordering/errors | Multiple unknown and required keys + failing leaves/array elements/bounds/union arms; JS enumeration vs declared order; code/message/class/kind/path/expected/actual and absence of optional props; values accumulated errors vs interfaces first error vs state aggregate. Pointer `~`/`/` escaping follows **each** existing profile (state/binding legacy unescaped paths must not silently change). No returned partial values. |
| Profile differences | Interfaces arbitrary digits version vs state strict positive ≤15 digits vs values ref codec; MCP exact ref keys/256-code-unit IDs vs HTTP/state extra-member policy; HTTP binding money currency string vs values currency catalog; string/boolean defer rules; nullable/ref deferral and present array element null; shape-only catalog with no derived channel. |
| Plan provenance/mutation | Factory vs structurally valid forged schema, freeze without provenance, accessor/proxy schema/default/bounds, descriptor changes before/after registration, owner/artifact revision reload, duplicate/invalid descriptors, registration budget failure, stale/foreign/disposed handles and schema identity reuse. Public legacy schemas never incorrectly hit owned cache. |
| Legacy unknown traces | Known contract getter's two reads and second value (existing probe), ownKeys/get/has traps, throwing accessors, arrays with holes/getters, undefined-valued unknown keys, prototype-bearing objects, Date opaque JSON empty object, numeric opaque JSON rejection, own `__proto__` preservation, cycles/current `RangeError`, `toJSON` ordering in replay. No narrowing or eager snapshot. |
| State sequencing/replay | Raw sorted-key bytes/hash golden vectors (including -0, exponent spelling, UTF-16 JSON escaping and TextEncoder byte policy), omission/null distinction, successful replay even if now expired/forbidden/malformed for current plan, conflicting hash, trusted vs live auth, normalization after checks, row not-found/stale/archive precedence, fresh reads/fences, reads auth-first, no eager ref loads on earlier failure. |
| HTTP/MCP production | Auth/CSRF/operation ID before migration point, top-level extras/action_handle carve-out, body caps, errors/status/redaction/form drafts, ordinary read/mutation tools, MCP null/ref order/InvalidParams, missing catalog/skew, sealed-handle fallback, binary loader initialization/reload/missing/corrupt/version errors under real workerd and deployed module inventory. |
| Resources/performance | Deep/wide trees, huge digit strings/key counts/errors, repeated plan register/release, success/failure/cancel/replay disposal, simultaneous requests bounded by host admission, no leaked handles/defaults, deterministic over-budget result, cold init/startup/warm/error CPU, conversion/copies/materialization, retained/peak memory and compressed bundle/Wasm size. |

## Acceptance commands and evidence

Run commands from the repository root. A commands exist at the inspected checkpoint; B commands target the **proposed** files above and become runnable when their task lands. Do not report proposed commands as passed. Package node:test output lives in package-specific `dist/<package>/...`; root Vitest intentionally does not discover values/interfaces/state node:test suites.

```sh
# A1: values baseline and package checks
bun run --cwd packages/values build
bun run --cwd packages/values typecheck
node --test packages/values/dist/values/test/schema.test.js packages/values/dist/values/test/wire.test.js packages/values/dist/values/test/conformance.test.js packages/values/dist/values/test/text.test.js packages/values/dist/values/test/types.test.js
bun docs/research/package-subsystem-ports-20261006/evidence/full-evaluation/values-boundary-probe.mjs

# A2: existing real interfaces dispatch/ref/binding suites
bun run --cwd packages/interfaces build
bun run --cwd packages/interfaces typecheck
node --test packages/interfaces/dist/interfaces/test/envelope.test.js packages/interfaces/dist/interfaces/test/wire.test.js packages/interfaces/dist/interfaces/test/http-operations.test.js packages/interfaces/dist/interfaces/test/mcp-server.test.js packages/interfaces/dist/interfaces/test/e1-bound-dispatch.test.js packages/interfaces/dist/interfaces/test/e2b-transport-seams.test.js packages/interfaces/dist/interfaces/test/e2-dispatch-agreement.test.js packages/interfaces/dist/interfaces/test/integration-parity.test.js

# A3: state raw hash/admission/invocation/default checks
bun run --cwd packages/state build
bun run --cwd packages/state typecheck
node --test packages/state/dist/state/test/invocation/replay.test.js packages/state/dist/state/test/invocation/admission.test.js packages/state/dist/state/test/invocation/invoke.test.js packages/state/dist/state/src/invocation/invoke-read.test.js packages/state/dist/state/src/invocation/descriptor-join.test.js packages/state/dist/state/src/mutation/t18-defaults.test.js packages/state/dist/state/src/receipt/b3-delivery-schema.test.js

# A4: existing production and durable consumer gates
./node_modules/.bin/vitest run packages/cloudflare/test/assembly.test.ts packages/cloudflare/test/mcp-route.test.ts packages/cloudflare/test/mcp-derived.test.ts packages/cloudflare/test/deploy-bundle.test.ts packages/cloudflare/test/release.test.ts
node --test packages/state/dist/state/src/invocation/t32b-wire.test.js packages/state/dist/state/src/invocation/t32b-fence.test.js packages/state/dist/state/src/mutation/t32b-wire-durable.test.js packages/state/dist/state/src/mutation/t18-defaults-durable.test.js
bun run --cwd packages/cloudflare build
node --test packages/cloudflare/dist/runtime/t16b-canonical.test.js packages/cloudflare/dist/runtime/t17b-durable.test.js packages/cloudflare/dist/runtime/t32b-cloudflare-durable.test.js
bun run --cwd packages/cloudflare typecheck

# B1: new native suite; common crate builds only once
cargo test --manifest-path packages/values/semantics/Cargo.toml --test input_validation
cargo fmt --manifest-path packages/values/semantics/Cargo.toml --check
cargo clippy --manifest-path packages/values/semantics/Cargo.toml --all-targets -- -D warnings

# B2/B3: new real-adapter, prepared and retained-legacy gates after build
node --test packages/values/dist/values/test/owned-input.test.js packages/values/dist/values/test/prepared-validation.test.js packages/values/dist/values/test/validation-binding.test.js packages/values/dist/values/test/validation-lifecycle.test.js packages/values/dist/values/test/legacy-validation-traces.test.js

# B4: new consumer suites; workerd path is in Cloudflare node/Vitest ownership
node --test packages/interfaces/dist/interfaces/test/owned-http.test.js packages/interfaces/dist/interfaces/test/owned-mcp.test.js packages/state/dist/state/test/invocation/owned-admission.test.js
./node_modules/.bin/vitest run packages/cloudflare/test/owned-http-route.test.ts packages/cloudflare/test/owned-input-delivery.test.ts
```

**B5** is C05's shared measurement harness, invoked with the validation workload registry produced in V01/V02 and three named backends (`current-ts`, `prepared-ts`, `owned-rust`), including requests through the actual HTTP handler/Wasm/workerd fixture, state replay/normalization and supported MCP calls; include default-deployment HTTP traffic only when its adoption gate is closed. C05 must publish its exact executable path/command before V11; this lane must add that command to `final-source-checks.md`. No invented current benchmark API is assumed here. Local CPU measurement uses appropriate process/harness timing; production Worker timers do not advance during CPU work, as documented in the existing research.

The evaluation's existing 284 selected values tests and probe are baseline evidence only; they do not cover this full matrix. At the checkpoint Cloudflare typecheck already had four documented failures outside the selected calculations (see full-evaluation.md); capture a fresh baseline and attribute each diagnostic, not claim green typechecking or suppress new errors. Cloudflare colocated runtime node:test suites explicitly run from `dist/runtime`; rebuild their owning package before those commands. If a baseline build fails, record that blocker rather than testing stale emitted output or silently changing the runner. Do not replace all runners opportunistically.

## Adoption, rollout and rollback

Keep backend selection private and fixed per release/owner startup. First ship prepared TS with legacy unknown fallback and evidence; then run differential shadow checks only on protected parser data/pure fact snapshots in tests or a bounded diagnostic mode. Never run auth/store/provider actions twice, never shadow legacy getters and never execute a second backend after a semantic exception. Shadow mismatches record profile, plan revision and redacted fixture identifiers, not raw secrets.

Enable Rust only for supported registered profiles after C04 actual workerd loading, V07 resources, V08 package consumer and parity gates. Default deployed HTTP enablement additionally requires V08’s owning bounded route join; package fixture proof alone does not meet that gate. Stage by owner/profile so unsupported plans remain explicitly TS. V09 state adoption is a separate gate; normalization must never move ahead of receipt/auth because the HTTP path has been enabled. V10 MCP/forms may remain TS with their scope and unmet provenance evidence stated. A build/release switch restores the prepared-TS owned backend while retaining the legacy API path. Rollback uses the same immutable artifact/profile plan semantics; it neither rewrites receipts nor changes raw hashing or defaults. Exercise rollback on a previously committed receipt and in-flight request drainage, and prove disposed instances reject old handles.

C05 sets numeric startup/CPU/memory/size budgets from representative callers before final measurement. Adoption requires either a named concrete native reuse consumer or material complete-call improvement over prepared TS at those agreed thresholds, with no unacceptable startup/resource regression. A faster leaf benchmark, fewer type parses or migrated line count is insufficient. If protected snapshots, host predicates or deployment join outweigh the gain, adopt prepared TS and leave Rust disabled; retain the experiment evidence rather than silently expand into parser/compiler/orchestrator rewrites.

Definition of done for the **declared owned package port**: C01–C05 and V01–V12 evidence are reviewed; all supported profile matrix cases agree through the real binding; the existing real HTTP handler consumer is proved through actual binding/workerd; default-deployment join status is explicitly recorded; state sequencing/durable behavior is verified if its profile is enabled; unsupported MCP/forms/unknown domains are explicitly documented; default/sentinel/carrier identity and lossless UTF-16 survive materialization; request/plan budgets and cleanup are proved; release selection/rollback and binary inventory pass; final source/export checks have no unexplained new failures; and merged file-tree coverage/checkpoint reconciliation is complete. Default deployed HTTP adoption additionally requires the owning route join; deployed MCP additionally requires verified SDK parser provenance. A package port can be complete while those adoption gates remain blocked, but its report must not claim those production paths migrated. No full legacy validation-port claim is made.

Final implementation report files: `evidence/input-validation/final-source-checks.md` (refreshed source map, changed files, exact commands/results, retained TS scope and gaps), `verify.log` (raw check output) and `rollout-decision.md` (prepared-TS/Rust measurements, JEV advice/disagreement references from parent, adoption or rejection and rollback evidence). This planning round inspected source only; all additions, tests, runtime limits and API names above remain proposed.
