# Exact values: package-owned Rust implementation plan

Planning date: 2026-10-06. Source checkpoint: `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5`. This is a plan, not an implemented backend, benchmark, or adoption decision. It follows [boundary options](../boundary-options.md) and [the full evaluation](../full-evaluation.md). Only existing `packages/` responsibilities are source-port scope. Compiler sources were read to identify consumers; compiler implementation remains unchanged.

## Chosen scope and boundary

Build one shared crate at `packages/values/semantics/`, with exact representations and algorithms reusable by the validation plan. Start with arbitrary-precision signed integers for raw operands and scratch computation. Implement Can's existing algorithms rather than substituting a decimal library's rounding/range policy. The first backend is native Rust for conformance, followed by actual Wasm integration behind package-owned synchronous façades. A native test runner is not a shipped Node addon.

This plan owns integer math, decimal coefficient/scale construction/parsing/math/canonical text, money arithmetic, UTC civil-date and millisecond-duration operations, numeric sums and numeric equality/comparison mechanisms. It also owns numeric scalar codec primitives reused by validation. It does not own full `wire.ts` traversal or schema/type-plan policy. The validation plan owns type IDs, registered plans, structured traversal, presence/default/ref behavior and profile-specific error projection, in this same crate. Avoid separate money/decimal implementations in the two plans.

Public signatures, BigInt values, `Decimal` instances with `.kind/.coef/.scale`, structural money with `.kind/.minor/.currency`, freezing, error classes/codes/messages and evaluation order stay with the existing TS surface. `.can` remains the authority for app identity/composition; Rust consumes owner-produced descriptors/catalog facts. `packages/contracts/src/values.ts`, the values catalog/currency table and stdlib assembly keep their present owners.

Defer fixed-width fast paths, generic expression execution, compiler lowering, opaque public value handles, Node native addons, locale/ICU/timezone databases, text helpers, callback-based `any/all/group`, arbitrary structural equality and query-engine aggregation. Public `min/max` remain TS orchestration returning the original winning object; their numeric comparison helpers can use the core. Date/instant numeric operations are included; timezone conversion stays host-owned. State query money/Number folds are not silently replaced by Can sums.

No arena is necessary for a single scalar call. Returning a Rust wrapper would break structural carriers. Existing JS expression chains still materialize each intermediate and cross at each helper call; keeping them in Rust requires an excluded execution/lowering project. Whole numeric domains or owned validation pipelines can cross once and retain scratch values internally, but only when an actual caller supplies that complete operation.

## Current source and consumer map

Paths below are relative to the repository root; all were inspected, including the named test sources where cited.

| Current source | Responsibility to preserve | Destination/owner |
| --- | --- | --- |
| `packages/contracts/src/values.ts` | Public shapes/version; BigInt int/duration/bytes/version and structural decimal/money/date/instant | Existing contract owner; no Rust-authored replacement contract |
| `packages/values/src/int.ts`; `test/int.test.ts` | Runtime type checks, unrestricted BigInt inputs, result-only int64 narrowing, unrestricted compare, truncating remainder | `semantics/src/numeric/integer.rs`; original façade |
| `src/decimal.ts`; `test/decimal.test.ts`, `decimal-oracle.test.ts` | Stored scale 0..18, 38 coefficient digits, half-even rational math, division's terminating scale, raw BigInt promotion, money/money ratio branch, grammar/text | `semantics/src/numeric/{decimal,rounding}.rs`, `codecs/numeric.rs`; original `Decimal` class |
| `src/money.ts`, numeric `src/kinds.ts`; `test/money.test.ts`, `kinds.test.ts` | Scale/table checks, shape-only guard, maker versus arithmetic narrowing, one rounding, currency precedence | `semantics/src/numeric/money.rs`, `representations/numeric.rs`; TS makers/guards |
| `src/currency-data.ts`, `src/catalog.ts`, `scripts/emit-catalog.mjs`; `test/exports-conformance.test.ts` | Pinned 165 admissible currencies, provenance/language version, export availability | Generate/verify build inputs from these owning TS sources; never maintain a second independent table/catalog |
| `src/temporal.ts`, date/instant makers in `kinds.ts`; `test/temporal.test.ts` | Civil days/month clamping, supported years 0001..9999, parsing versus wire grammar, overloads, duration exactness, limit/error order | `semantics/src/temporal/{civil,instant,duration}.rs`; TS guards/makers |
| Numeric sums in `src/array.ts`; `test/array.test.ts` | Final-only narrowing/cancellation, decimal-only domains, explicit/inferred/empty money currency rules | `semantics/src/aggregates/numeric.rs`; public arbitrary-array access remains TS unless separately proved |
| Numeric branches of `src/equality.ts`, dispatchers `src/stdlib-pure.ts`; `test/equality.test.ts`, `stdlib-pure.test.ts` | Int/decimal promotion, currency equality versus ordering, dispatch/error arity; original object identities | Numeric core mechanisms; keep dispatch and nonnumeric branches TS |
| Numeric/date scalar portions of `src/wire.ts`; `test/wire.test.ts` | Canonical exact strings, numeric wire bounds and date formatting; encode ValueError versus decode violations | Pure codecs here; traversal/error profiles under validation plan |
| `src/types.ts`, `src/schema.ts`; `test/types.test.ts`, `schema.test.ts` | AST/type parsing, bounds/defaults/presence, accumulated paths | Validation-plan owner; imports numeric representations/codecs from this plan |
| `conformance/v1/{README.md,values.json}`, `test/conformance.test.ts` | Versioned wire/builtin/operation cases, unchecked `$bigint` input fixtures | Retain published v1 unchanged; add migration-private fixtures alongside it |
| `packages/values/src/index.ts`, `packages/stdlib/src/index.ts`, stdlib `test/assembly.test.ts` | Current reexports and generated-program boundary | Same synchronous exports; no new mandatory public init function |
| `packages/interfaces/src/mcp/schemas.ts` (`checkDecimalLiteral`, `checkBoundArguments`), `src/http/operations.ts` | Actual integer/decimal/money binding checks after framing, parser and identity/CSRF steps | Whole-operation pilot jointly owned with validation; interfaces keeps its first-error messages/order |
| `packages/cloudflare/src/deploy/bundle.ts`, `src/dev/local-run.ts`, `packages/testkit/src/scopes/local.ts` | Existing values vendor resolution and text-only Worker delivery | Shared C04 delivery owner, prerequisite for a Worker backend |
| `compiler/src/codegen/js.rs`, `compiler/src/analysis/effects.rs`, `compiler/tests/codegen.rs` (read-only) | Helpers imported through stdlib and direct `coef/minor` field consumers | Compatibility evidence only; no compiler edits or crate dependency |

Important source asymmetries must become executable fixtures. `makeMoney` checks shape/table but does not narrow minor units. `isMoney` accepts uppercase three-letter currency shape without proving table membership. `divideDecimal`'s structural money ratio branch is weaker than `moneyRatio`'s guard. `compareInt` accepts arbitrary magnitudes. `sumInt/sumDuration` check only the final total; `sumDecimal` validates the complete domain before scale selection and a further summing pass. Some duration operations check results, whereas `divideDurationMs` narrows both inputs before division. Do not impose one universal admitted-value constructor at every entry.

Compiler `lower_expr` currently rejects decimal literal lowering, despite supporting decimal helper expressions. A new decimal-literal `.can` compilation pilot cannot be promised without compiler work. Use an existing supported generated-code path or package/runtime fixtures; flag an unsupported authoring example rather than hand-authoring Rust app semantics to hide the gap.

## Proposed private design and filetree

All new names below are proposed private interfaces/files. None exist at the checkpoint.

```text
packages/values/
  Cargo.toml                  # private workspace: semantics and bindings only
  Cargo.lock                  # one shared resolution; compiler is not a member
  semantics/
    Cargo.toml
    src/
      lib.rs
      failures.rs
      representations/{mod,numeric}.rs
      numeric/{mod,integer,decimal,rounding,money}.rs
      temporal/{mod,civil,instant,duration}.rs
      aggregates/{mod,numeric,integer,decimal,money}.rs
      codecs/{mod,numeric}.rs
      input.rs               # validation-plan ownership, common C03 contract
      plans.rs               # validation-plan ownership
      profiles.rs            # validation-plan ownership
      validation.rs          # validation-plan ownership
      transport/{mod,exact}.rs # C03 ABI owner; exact numeric implementation
    tests/{integer_vectors,rounding_vectors,decimal_vectors,money_vectors,temporal_vectors,aggregate_vectors}.rs
    examples/conformance.rs
  bindings/
    Cargo.toml
    src/{lib,exact}.rs
    backend.ts
    bootstrap.ts
    carriers.ts
    generated/               # reproducible binding output, no hand edits
  scripts/
    emit-semantics-inputs.mjs
    build-semantics.mjs
  conformance/ports/exact/
    cases.json
    differential.mjs
    workloads.mjs
  test/{exact-backends,exact-bootstrap}.test.ts
  src/
    prepared/{plan,codec,validation}.ts # validation-owned prepared TS baseline
    ...                      # existing public source/façades retained
```

Use feature/responsibility folders only; no `rust/` or other language-named folder. The shared semantics crate is host-independent; `bindings/` contains a thin Wasm crate and TS host adapter. A03.1, completed by A03.foundation, owns the initial package-local workspace, both crate manifests, shared lockfile, `lib.rs` and failure definitions; validation extends its module registrations through coordinated edits. A01 resolves these manifests/build output locations with validation and the living file-tree plan before source implementation; one package-local resolution covers native and binding builds. The compiler is not a workspace member. C03 owns the common wire version and ordered UTF-16/presence/error envelope; this plan implements its exact numeric payloads.

Proposed core entries take operation-specific typed operands and return exact parts or `Failure { code, message }`. Distinguish raw integer, checked decimal representation and structural money inputs so guards stay operation-specific. Export a private ABI-version query and an operation request/result transport, with batch variants only for existing sums and validation's complete owned operations. Do not expose new user-language builtins. The prototype transport uses signed decimal ASCII for BigInt values and tagged coefficient/scale/minor tuples: it is easy to inspect and lossless, but its conversion cost must be counted. Replacing it with limbs is a later C03 revision if measurement warrants it. Validate raw JS number scale/date parts before any fixed-width conversion; preserve `-0` where stored TS number parts expose it. UTF-16 error input strings need code-unit transport or host-rendered dynamic messages, not lossy conversion to Rust `String`.

Use `num-bigint` for the first complete raw/scratch path. Its documented [BigInt API](https://docs.rs/num-bigint/latest/num_bigint/struct.BigInt.html) provides parsing and exact integer operators; that supplies a representation option, not Can semantic parity or speed evidence. Pin the crate/binding/toolchain versions in A03 after a native and Wasm build proof. Keep operand/output digit checks and Can half-even logic explicit. A bounded backend cannot replace arbitrary raw operand behavior; optimize only after the compatibility route passes.

Host observability is a separate concern from exact math. Public structural values can be getters/proxies; public arrays can have custom iteration, holes, side effects and mutations. Guard/property reads in the existing TS code repeat and have a defined order. Preserve these old paths until equivalent traces are implemented and tested. Never inspect or freeze an arbitrary object to declare it inert. Private constructor registration or parser provenance may establish safe owned data without property reads; registrations must not exclude valid structural public values, which continue on the TS compatibility path. Identity-returning operations retain host identity. Numeric equality stays in TS dispatch while safe numeric facts may enter the core.

## Shared preparation dependencies and ownership

These IDs are common to all four plans, not duplicated work packages.

| ID | Shared deliverable | Exact-values obligation/owner |
| --- | --- | --- |
| C01 | Caller/contracts inventory, observable behavior and old/new input profiles | Values owns numeric/raw/carrier contracts; validation owns owned-input provenance and error profiles; interfaces verifies pilot order |
| C02 | Current and prepared TS baselines, consolidation without translation | Values removes no public path; validation prepares type/operation dispatch; share one numeric fixture inventory |
| C03 | Versioned ABI, error/text/number/BigInt/presence transport | Exact-values owns numeric transport and JS carrier reconstruction; validation extends structural/profile transport; common bindings lead freezes version |
| C04 | Binary-safe asset/digest/manifest delivery plus actual workerd initialization proof | Cloudflare/testkit owners implement JS/Wasm inventory, local module registration and release propagation; values supplies minimal binding smoke module |
| C05 | Differential and complete-call measurement harness | Common harness owner records environment/seeds/raw evidence; values supplies wide arithmetic, scalar/aggregate workloads and exact observers |

A03.foundation exposes workspace/representations/failures before independent algorithm work; A03–A06 native tasks consume C01–C03 readiness through their explicit leaf dependencies. C04.ready must pass before A07 actual Worker binding integration. Arithmetic need not wait for full legacy unknown-input validation. Validation may import A03–A06 mechanisms; it must not redefine them. The whole-input pilot requires the validation plan's prepared interfaces profile. Native local artifact preparation can proceed without this Wasm delivery, while work's Worker backend reuses C04.

## Executable waves and parallel lanes

Commands labeled future describe files/build targets this plan will create. Current verified commands appear separately below. Every box is unchecked: the earlier TS baseline does not complete future implementation tasks. [Machine-readable task graph](exact-values.tasks.json) carries the same canonical IDs, dependencies, ownership and acceptance. Evidence goes under `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/`, using the named lane subfolders.

Waves mark earliest useful starts, not global barriers. Start a task as soon as its explicit dependencies pass; one blocked lane never stalls unrelated ready work. `A01`–`A11` are parent completion gates, not implementation leaves. `Cxx.ready` consumes shared readiness, and `V06`–`V08`/`V10` consume validation parent evidence; `V03.5` is the explicit shared-file handoff before final exact assembly, and `V02.6` hands off prepared index hooks before A08.1 routing. `A03.foundation` intentionally exposes the smaller shared-core handoff; `A07.foundation` exposes actual smoke binding/bootstrap before full algorithm parity.

Use at most four active workers: one shared core/module/binding integrator and up to three branch owners. Lanes are ownership queues, not ten simultaneous workers; run at most one task in a lane at a time. Reassign completed workers to ready branches; preserve ownership until handoff is reviewed. Only the core integrator edits manifests/lockfile, `lib.rs`, common `mod.rs`, numeric codecs, bindings module assembly, generated glue and package build inventory. Initial common module placeholders are installed before handoff without importing absent algorithm files; branch owners modify only their assigned implementations/tests, and native branch vectors compile their modules before final entry assembly. Validation proposes its common-module changes to this same integrator: A07.foundation → V03.5 initial shared assembly → A07.3 final exact assembly → validation final backend/build selection. No concurrent lib/binding assembly edits are permitted. C04 continues to own Cloudflare bundle/local-run/testkit production asset files; validation owns production parser/interface joins. Exact-values consumer work below owns dedicated fixtures, avoiding simultaneous edits to those production files.

The narrower dependencies are source-derived: `temporal.ts` imports kinds/errors and implements its own `checkInt64`, so A05 starts at `A03.foundation`; `divideDurationMs` is in `decimal.ts` and belongs to A04.2. `money.ts` imports integer mechanisms, half-even rounding and `divideDecimal`: basic currency/money work starts after integer/catalog facts, while factors and guarded ratios join decimal math and rounding. Decimal construction/text does not await rounding. Owned aggregate branches await their corresponding algorithms, then join shared comparisons. A07 smoke/carrier preparation and A09 fixture preparation overlap native work; full binding, consumer parity and release gates still wait for complete prerequisites.

### Lane ownership and useful ready backlog

| Lane | Exclusive implementation ownership | Start and exit gates / useful work while blocked |
| --- | --- | --- |
| `core` — Shared core and module integrator | `packages/values/Cargo.toml`, `packages/values/Cargo.lock`, `packages/values/semantics/Cargo.toml`, `packages/values/semantics/src/lib.rs`, `packages/values/semantics/examples/conformance.rs`, `packages/values/semantics/src/failures.rs`, `packages/values/semantics/src/representations/`, `packages/values/semantics/src/transport/`, `packages/values/semantics/src/numeric/mod.rs`, `packages/values/semantics/src/temporal/mod.rs`, `packages/values/semantics/src/aggregates/mod.rs`, `packages/values/semantics/src/codecs/`, `packages/values/bindings/Cargo.toml`, `packages/values/bindings/src/`, `packages/values/bindings/generated/`, `packages/values/scripts/emit-semantics-inputs.mjs`, `packages/values/scripts/build-semantics.mjs`, `packages/values/package.json`, `packages/values/tsconfig.json`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/core/` | Start C01.ready for contracts, A03.foundation for build/catalog/binding slots; exit A07. Keep pin/license/drift and release-inventory evidence ready; serialize shared assembly. Never edit a branch-owned implementation after handoff. |
| `fixtures` — Observable fixtures and measurement | `packages/values/conformance/ports/exact/`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/fixtures/` | Start C05.ready plus A01.1; exit A02 and A10.1. While Rust is blocked, extend deterministic observers, independent oracles and precommitted workload/resource records. |
| `integer` — Raw integer algorithms | `packages/values/semantics/src/numeric/integer.rs`, `packages/values/semantics/tests/integer_vectors.rs`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/integer/` | Start A03.foundation; exit A03.2. While waiting, review wide/raw/type/error vectors and final-only narrowing evidence. |
| `rounding` — Independent rational rounding | `packages/values/semantics/src/numeric/rounding.rs`, `packages/values/semantics/tests/rounding_vectors.rs`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/rounding/` | Start A03.foundation; exit A03.3. While waiting, prepare independent signed rational/tie/sticky vectors without duplicating fixtures ownership. |
| `decimal` — Decimal algorithms | `packages/values/semantics/src/numeric/decimal.rs`, `packages/values/semantics/tests/decimal_vectors.rs`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/decimal/` | Start A03.foundation; arithmetic joins A03.2/A03.3; exit A04.2. While rounding is blocked, finish stored-parts/grammar/text and scale/error source coverage. |
| `money` — Money algorithms | `packages/values/semantics/src/numeric/money.rs`, `packages/values/semantics/tests/money_vectors.rs`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/money/` | Start A03.foundation plus A03.2/A03.4; factors join A04.2/A03.3; exit A04.4. While blocked, map maker/builtin/coercion/currency precedence and ratio guard asymmetry. |
| `temporal` — UTC civil, instant and duration | `packages/values/semantics/src/temporal/civil.rs`, `packages/values/semantics/src/temporal/instant.rs`, `packages/values/semantics/src/temporal/duration.rs`, `packages/values/semantics/tests/temporal_vectors.rs`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/temporal/` | Start A03.foundation, no decimal/money wait; instant joins civil/duration; exit A05. While foundation is blocked, map leap/epoch/overload/limit grammar vectors. |
| `aggregates` — Owned aggregates and comparison | `packages/values/semantics/src/aggregates/integer.rs`, `packages/values/semantics/src/aggregates/decimal.rs`, `packages/values/semantics/src/aggregates/money.rs`, `packages/values/semantics/src/aggregates/numeric.rs`, `packages/values/semantics/tests/aggregate_vectors.rs`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/aggregates/` | Start relevant integer/duration or decimal/money leaf gates; exit A06. While algorithms are blocked, prepare final-only narrowing, pass-order and empty/currency cases. |
| `host` — Synchronous host adapters and public routing | `packages/values/bindings/backend.ts`, `packages/values/bindings/bootstrap.ts`, `packages/values/bindings/carriers.ts`, `packages/values/src/int.ts`, `packages/values/src/decimal.ts`, `packages/values/src/money.ts`, `packages/values/src/kinds.ts`, `packages/values/src/temporal.ts`, `packages/values/src/array.ts`, `packages/values/src/equality.ts`, `packages/values/src/stdlib-pure.ts`, `packages/values/src/index.ts`, `packages/values/test/exact-bootstrap.test.ts`, `packages/values/test/exact-backends.test.ts`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/host/` | Start A03.foundation plus C03.ready; full routing awaits A07; exit A08. While binding is blocked, prepare carrier/provenance/legacy-read/identity and startup-failure tests. |
| `consumer` — Real consumer and release review | `packages/interfaces/test/exact-input-profile.test.ts`, `packages/testkit/test/exact-operation-consumer.test.ts`, `packages/stdlib/test/exact-helper-chain.test.ts`, `packages/values/test/exact-release.test.ts`, `packages/values/README.md`; evidence `docs/research/package-subsystem-ports-20261006/evidence/implementation/exact-values/consumer/` | Start A01/A02/shared profile readiness for fixtures; actual request awaits A08/V06–V08; exit A11. While joins are blocked, prepare baseline stage traces, stdlib chains, packaged inventory and route-provenance review. |

### Wave 1 — Scope, ownership and budgets

- **Lane `core` — Shared core and module integrator**
  - [ ] **A01.1 — Freeze owner, caller and observable-contract inventory** (implementation; start after `C01.ready`).
    - Implement: Assign every mapped export to core, façade or deferred coverage; inspect changed sources and living filetree without advancing its checkpoint. Confirm package-only workspace and interface pilot owner within two working days.
    - Check: Record source hash, public reads/errors/identity obligations, wide raw domains, direct .coef/.minor consumers and owner approvals.
    - Accept: All mapped sources have an owner and admitted-input/error/order contract; compiler changes are unnecessary.
  - [ ] **A01 — Scope and adoption contract complete** (completion gate; start after `A01.1`, `A01.2`).
    - Accept: Every original A01 obligation is reviewed; no broad rollout is required when the nominated benefit disappears.
- **Lane `fixtures` — Observable fixtures and measurement**
  - [ ] **A01.2 — Nominate complete-call workloads and ratify budgets** (implementation; start after `A01.1`, `C05.ready`).
    - Implement: Choose real caller-typical/maximal scalar, sum and whole-input workloads; record native reuse requirement and precommit or replace the resource/adoption budgets below.
    - Check: Save nominations and thresholds before viewing Rust comparisons; identify unsupported authoring examples and the current HTTP 501 gap.
    - Accept: A useful consumer/reuse requirement and fixed budgets exist, or a measured disabled prototype is the explicitly scoped outcome.

### Wave 2 — Observable TS baseline

- **Lane `fixtures` — Observable fixtures and measurement**
  - [ ] **A02.1 — Capture deterministic raw and observable TS vectors** (implementation; start after `A01`, `C02.ready`, `C05.ready`).
    - Implement: Add migration-private cases beside unchanged v1 fixtures for wide BigInts, stored parts, maker/builtin differences and all compatibility cases below.
    - Check: Observe exact coef/scale and minor/currency, classes/freeze/error fields, ordered property/callback/iterator traces; keep dynamic UTF-16 errors lossless.
    - Accept: Fixtures include outputs erased by canonical wire text; deterministic regeneration preserves published conformance/v1 unchanged.
  - [ ] **A02.2 — Build current/prepared TS observers and differential shell** (implementation; start after `A02.1`).
    - Implement: Implement current/prepared TS modes and independent rational/digit-string oracles; reserve native/Wasm backends and workload metadata.
    - Check: Run the verified focused TS build/test command below; record any baseline failures separately, observer seeds and raw results.
    - Accept: Complete raw outputs and traces match the baseline; Decimal.js is secondary value evidence, not a scale/error oracle.
  - [ ] **A02 — Observable numeric baseline ready** (completion gate; start after `A02.1`, `A02.2`).
    - Accept: Current/prepared TS comparators and deterministic fixtures satisfy the original A02 acceptance.

### Wave 3 — Shared core foundation

- **Lane `core` — Shared core and module integrator**
  - [ ] **A03.1 — Build shared representations, failures and workspace foundation** (implementation; start after `A02`, `C03.ready`).
    - Implement: Create package-local workspace for semantics/bindings only, checked versus raw/structural carriers, Failure envelope and versioned exact payload primitives. Reserve agreed module registrations centrally and create a minimal binding lib for pin/build proof; hand branch file assignments to their owners before foundation exit. Foundation does not import absent algorithm files.
    - Check: Within one working day, pin num-bigint/toolchain/binding/glue and lock resolution with native/Wasm build and license/support evidence. Verify unrestricted BigInt round trips, raw JS numeric validation before conversion, -0 and UTF-16 dynamic text policy.
    - Accept: Foundation compiles and supplies stable representations/errors/transport with no integer or rational algorithm dependency; compiler is excluded.
  - [ ] **A03.foundation — Shared core foundation ready for independent algorithms and validation** (completion gate; start after `A03.1`).
    - Accept: Workspace, representations, failures, transport contract and shared module ownership are usable; validation may begin without awaiting full A03 integer/rounding work.

### Wave 4 — Independent algorithms, smoke delivery and pilot preparation

- **Lane `core` — Shared core and module integrator**
  - [ ] **A03.4 — Generate owner-derived currency and catalog build inputs** (implementation; start after `A03.foundation`).
    - Implement: Read currency-data.ts/catalog.ts and existing emit-catalog owner outputs; generate reproducible numeric facts under the build output, with language/catalog provenance.
    - Check: Check 165 admitted currencies, excluded codes, scale 0/2/3/4, export availability and drift detection against owning sources.
    - Accept: No second independent table/catalog is maintained; validation and money share the same pinned facts.
  - [ ] **A03 — Native integer and rounding foundation complete** (completion gate; start after `A03.foundation`, `A03.2`, `A03.3`, `A03.4`).
    - Accept: Run future cargo test --locked --manifest-path packages/values/semantics/Cargo.toml and cargo fmt --manifest-path packages/values/semantics/Cargo.toml -- --check; save pin/build/license evidence and all original A03 raw-arithmetic contracts.
  - [ ] **A07.1 — Prepare real binding build and initialization smoke** (implementation; start after `A03.foundation`, `C03.ready`, `C04.ready`).
    - Implement: Implement the real thin binding crate, reproducible generated glue/build script and ABI/version/init smoke using reserved foundation entries. Coordinate manifests only through this integrator.
    - Check: Build/import actual glue in Node/Bun and C04 local workerd/module map; verify emitted JS declarations, dist asset inventory and pinned versions. Resolve loader/package proof within two working days.
    - Accept: Tiny actual binding works before full algorithms; no mocked loader or native runner counts as Worker success.
  - [ ] **A07.foundation — Real binding and host bootstrap scaffold ready for validation** (completion gate; start after `A07.1`, `A07.2`).
    - Accept: Actual tiny glue/module imports and synchronous bootstrap/carrier contract are usable in Node/Bun/local workerd; validation can integrate independently of exact algorithm completion.
- **Lane `integer` — Raw integer algorithms**
  - [ ] **A03.2 — Port unrestricted integer mechanisms** (implementation; start after `A03.foundation`).
    - Implement: Port operation-specific checks, result-only int64 narrowing, unrestricted comparison and truncating remainder.
    - Check: Run native integer vectors for 10^1000 cancellation, zero multiplication, wide division/remainder/compare, past-2^53 values, non-BigInt refusal and int64 minimum % -1.
    - Accept: No i64/i128 input truncation or global digit limit; all integer outputs and failures match TS.
- **Lane `rounding` — Independent rational rounding**
  - [ ] **A03.3 — Port half-even rational and scale rounding** (implementation; start after `A03.foundation`).
    - Implement: Implement arbitrary-precision signed rational rounding and powers/scale helpers with Can half-even policy.
    - Check: Compare independent rational/digit-string oracle, negative/positive ties, sticky digits, near ties, zero denominator and dynamic error vectors.
    - Accept: Native rounding preserves exact scratch operands, error order and half-even results without decimal-library policy substitution.
- **Lane `decimal` — Decimal algorithms**
  - [ ] **A04.1 — Port decimal construction, parsing and stored parts** (implementation; start after `A03.foundation`).
    - Implement: Implement construction, raw BigInt promotion, grammar, canonical text and checked coefficient/scale primitives; preserve stored scale separately from text.
    - Check: Test zero scales 0/18, leading zeros/-0 text, 38/39 digits, invalid exponent/plus/separators and scale -0/fractional/NaN/infinite/range cases.
    - Accept: Construction/text preserve full coefficient and stored scale; public Decimal makers remain TS authoritative carriers.
- **Lane `money` — Money algorithms**
  - [ ] **A04.3 — Port currency and basic money operations** (implementation; start after `A03.foundation`, `A03.2`, `A03.4`).
    - Implement: Implement owner-derived currency checks, basic add/sub/negate/abs/comparison/equality and operation-specific maker/arithmetic boundaries.
    - Check: Test wide maker minor versus narrowed builtin/wire, unknown shape currency, admitted/excluded scales/codes, mismatch ordering and cross-currency equality; coercing currencies stay TS with original traces.
    - Accept: No universal constructor erases distinct maker/builtin/binary-operation domains or messages.
- **Lane `temporal` — UTC civil, instant and duration**
  - [ ] **A05.1 — Port UTC civil dates and range operations** (implementation; start after `A03.foundation`).
    - Implement: Port civil epoch days, date parsing/year/weekday, add_days/add_months, date comparison, dates and half-open overlaps.
    - Check: Test leap/century/year 0001..9999 bounds, month clamping, negative epochs, limit exhaustion and dates(from == until, 0n) frozen-empty behavior before positive-limit refusal.
    - Accept: All civil pure algorithms and source-specific limit/error order match; Intl/timezone remains host-owned.
  - [ ] **A05.2 — Port exact duration checks and operations** (implementation; start after `A03.foundation`).
    - Implement: Port duration arithmetic/remainder/comparison/unary operations with existing local result/input checks; preserve duration/int division exactness.
    - Check: Test raw operands, result-only versus input narrowing, signed extrema, inexact and zero-divisor precedence; coordinate divideDurationMs coverage in A04.2.
    - Accept: Duration semantics do not wait for decimal/money and do not acquire stronger uniform input checks.
- **Lane `aggregates` — Owned aggregates and comparison**
  - [ ] **A06.1 — Port owned integer and duration sums** (implementation; start after `A03.2`, `A05.2`, `C02.ready`).
    - Implement: Implement complete owned-domain sums with final-only narrowing and typed empty zeros.
    - Check: Test intermediate-overflow cancellation, zero/one/wide domains and duration/int final bounds.
    - Accept: Sum semantics narrow once; arbitrary public array iteration remains the existing TS path.
- **Lane `host` — Synchronous host adapters and public routing**
  - [ ] **A07.2 — Prepare host carriers, backend registry and bootstrap checks** (implementation; start after `A03.foundation`, `C03.ready`).
    - Implement: Implement TS carrier reconstruction/constructor provenance and explicit ts/wasm-required selection before requests, against frozen operation contracts.
    - Check: Test import-without-bootstrap TS use, sync calls, double init/import cycles/isolate restart, missing/corrupt/ABI-mismatched assets and no semantic-error retry.
    - Accept: Public classes/freezing/BigInt parts and synchronous exports stay intact; failed selected Rust bootstrap is visible.
- **Lane `consumer` — Real consumer and release review**
  - [ ] **A09.1 — Prepare joint owned HTTP/interface pilot fixtures** (implementation; start after `A01`, `A02`, `C02.ready`, `C03.ready`, `C05.ready`).
    - Implement: Prepare current/prepared full-request observers, real identity/catalog/canonical invoker fixtures and framing/binding profile cases jointly with validation. Validation retains production handleOperationRequest/checkBoundArguments ownership.
    - Check: Capture identity/CSRF/framing/bounds/error/dispatch order, forms compatibility, parser provenance requirements and 501 production-route gap before switching the fixture.
    - Accept: Useful fixture preparation overlaps algorithms without claiming a whole-input port or production adoption.

### Wave 5 — Decimal/money joins and scalar handoffs

- **Lane `core` — Shared core and module integrator**
  - [ ] **A04.5 — Expose pure numeric scalar codecs for validation reuse** (implementation; start after `A04.1`, `A04.3`, `C03.ready`).
    - Implement: Implement pure exact int/decimal/money wire scalar primitives, canonical strings and wire-specific narrowing; leave traversal and SchemaError projection validation-owned.
    - Check: Run shared encode/decode scalar vectors for exact key/grammar/range rules and stored-versus-wire distinctions; expose a precise codec handoff to validation.
    - Accept: Validation can reuse proven numeric codecs without awaiting unrelated money factor math or aggregate work.
  - [ ] **A04 — Decimal, money and numeric codecs complete** (completion gate; start after `A04.1`, `A04.2`, `A04.3`, `A04.4`, `A04.5`).
    - Accept: All original A04 branches, full stored parts, one-round rules and independent oracle limits are covered.
- **Lane `decimal` — Decimal algorithms**
  - [ ] **A04.2 — Port decimal math and both ratio branches** (implementation; start after `A04.1`, `A03.2`, `A03.3`).
    - Implement: Implement align/add/sub/multiply/round/divide/comparison/equality, permissive structural money ratio and divideDurationMs with its input-narrowing order.
    - Check: Test terminating minimal/repeating division, scale-up and post-round overflow, unbounded raw/structural ratios, mismatch-before-zero and duration input checks; compare exact parts plus secondary Decimal.js values.
    - Accept: Every decimal source branch matches value, stored parts and failure precedence.
- **Lane `money` — Money algorithms**
  - [ ] **A04.4 — Join money factors, one-round conversion and moneyRatio** (implementation; start after `A04.3`, `A04.2`, `A03.3`).
    - Implement: Implement decimal/int money conversion, multiplication/division and guarded moneyRatio, sharing rounding and decimal division.
    - Check: Verify one rounding only, full scale/minor, zero-factor precedence and guarded moneyRatio versus weaker divideDecimal structural branch.
    - Accept: Complete money semantics match native vectors without duplicated decimal/rounding authority.
- **Lane `temporal` — UTC civil, instant and duration**
  - [ ] **A05.3 — Port instant algorithms and temporal scalar codecs** (implementation; start after `A05.1`, `A05.2`).
    - Implement: Implement permissive public datetime parser separately from pinned wire grammar, instant boundaries, datetime-duration overloads, durationBetween and comparisons; expose pure temporal scalar codec functions.
    - Check: Test negative timestamps, supported boundaries, overload detection/order, millisecond/case/leap wire rules and parser divergence.
    - Accept: Every temporal.ts exported pure algorithm is covered; decimal-valued divideDurationMs remains correctly covered in A04.2.
  - [ ] **A05 — Temporal algorithms and scalar handoff complete** (completion gate; start after `A05.1`, `A05.2`, `A05.3`).
    - Accept: Native temporal vector runner matches all original A05 acceptance without an unnecessary A04 dependency.
- **Lane `aggregates` — Owned aggregates and comparison**
  - [ ] **A06.2 — Port owned decimal sums** (implementation; start after `A04.2`, `C02.ready`).
    - Implement: Implement checked decimal-only domain, complete validation then scale selection/summing, one final coefficient check and empty decimal zero.
    - Check: Use stored-scale/cancellation/malformed-domain fixtures; keep public pass/read ordering in host compatibility tests.
    - Accept: Owned decimal sums match numeric results without claiming arbitrary public-array Wasm adoption.
  - [ ] **A06.3 — Port owned money sums** (implementation; start after `A04.4`, `C02.ready`).
    - Implement: Implement explicit/inferred currency domains, empty rules and whole-total narrowing.
    - Check: Test explicit currency validation before elements, empty inferred rejection, mixed currency/error order and intermediate cancellation.
    - Accept: Owned money sums preserve empty/currency/final-only rules.

### Wave 6 — Aggregate and full binding integration

- **Lane `core` — Shared core and module integrator**
  - [ ] **A07.3 — Join full semantic entries and actual-adapter differential** (implementation; start after `A03`, `A04`, `A05`, `A06`, `A07.foundation`, `V03.5`).
    - Implement: Serially register all complete numeric/temporal/aggregate operations and native conformance entry; validation initial shared assembly first exits V03.5 after A07.foundation, then this same integrator lands final exact assembly. Later validation build-time selection waits full A07.
    - Check: Run future bun packages/values/scripts/build-semantics.mjs then node packages/values/conformance/ports/exact/differential.mjs --backend native and --backend wasm with actual generated binding across Node/Bun/local workerd.
    - Accept: Full semantic vectors and asset/version/error checks pass through real binding and actual host delivery.
  - [ ] **A07 — Actual binding and full native/Wasm parity complete** (completion gate; start after `A07.foundation`, `A07.3`).
    - Accept: Every original A07 bootstrap/build/carrier/delivery requirement is proved; no full-consumer adoption inferred.
- **Lane `aggregates` — Owned aggregates and comparison**
  - [ ] **A06.4 — Integrate numeric comparisons and aggregate runner** (implementation; start after `A06.1`, `A06.2`, `A06.3`, `A05.3`).
    - Implement: Provide safe numeric equality/comparison mechanisms and aggregate entry assembly; leave min/max/equality/nonnumeric/callback dispatch TS.
    - Check: Run native aggregate vectors; prove ties/wins return original instances through façade fixtures and sparse/proxy/custom iterator paths retain old passes.
    - Accept: All original A06 aggregate/comparison obligations match; no arbitrary host iterable is adopted by inspection.
  - [ ] **A06 — Native aggregates and comparisons complete** (completion gate; start after `A06.1`, `A06.2`, `A06.3`, `A06.4`).
    - Accept: Native aggregate fixture vectors pass through cargo test --locked --manifest-path packages/values/semantics/Cargo.toml; A07.3 later runs node packages/values/conformance/ports/exact/differential.mjs --backend native against the fully assembled runner.

### Wave 7 — Public façades and helper-chain assembly

- **Lane `host` — Synchronous host adapters and public routing**
  - [ ] **A08.1 — Route proven public profiles behind unchanged façades** (implementation; start after `A07`, `V02.6`, `C05.ready`).
    - Implement: Select proven primitive/constructor-registered profiles, preserve operation-specific TS type checks and legacy structural/getter/proxy/array routes; instrument selected core entries. V02.6 prepared index hooks land first; this host owner then edits the same index serially.
    - Check: Test new Decimal, structural money, raw BigInts, class/freeze/errors/identity, ordered reads, rollback and no second-backend semantic retry.
    - Accept: One selected backend per request; all unproved unknown profiles execute TS by declared pre-evaluation routing.
  - [ ] **A08 — Selective public routing verified** (completion gate; start after `A08.1`, `A08.2`).
    - Accept: Synchronous exports, legacy traces and backend-entry instrumentation meet the original A08 contract.
- **Lane `consumer` — Real consumer and release review**
  - [ ] **A08.2 — Verify synchronous package and stdlib consumer assembly** (implementation; start after `A08.1`, `C04.values-assets`).
    - Implement: Add supported generated helper-chain/package fixture demonstrating .coef/.minor observations with ordinary materialized intermediates.
    - Check: Run values typecheck/test and stdlib test; inspect package exports/declarations, the actual values-generated binding/module/vendor/release map proved by C04.values-assets, and import-without-bootstrap behavior. Do not promise decimal-literal lowering or retained handles.
    - Accept: All original A08 public/export/assembly checks pass, with baseline failures separately attributed.

### Wave 8 — Whole-input consumer join

- **Lane `consumer` — Real consumer and release review**
  - [ ] **A09.2 — Run whole-input pilot through actual Wasm consumer** (implementation; start after `A08`, `A09.1`, `V06`, `V07`, `V08`, `C02.ready`, `C03.ready`, `C04.ready`, `C05.ready`).
    - Implement: Join validation prepared interfaces profile and actual parser-owned JSON input; replay one complete request through Node/Bun/local workerd using existing owning handler.
    - Check: Compare current TS, prepared TS and actual Wasm complete calls for numeric verdicts, response and single dispatch, identity/CSRF/framing/bounds/error order; run interfaces/testkit and C04 delivery checks.
    - Accept: Exact A09 join waits for completed V06–V08 evidence; forms and unproved transports retain TS with compatibility checks.
  - [ ] **A09 — Whole-input pilot and secondary helper-chain evidence complete** (completion gate; start after `A08`, `A09.1`, `A09.2`, `V06`, `V07`, `V08`, `C02.ready`, `C03.ready`, `C04.ready`, `C05.ready`).
    - Accept: All original A09 complete-call and secondary .coef/.minor fixture obligations pass; no retained-handle claim or fixture-only deployed-use claim.

### Wave 9 — Measurement, packaged release and provenance decision

- **Lane `fixtures` — Observable fixtures and measurement**
  - [ ] **A10.1 — Measure complete-call performance and resources** (implementation; start after `A09`, `C05.ready`).
    - Implement: Measure cold/warm/error scalar chains, 0/1/16/256/4096 sums and nominated typical/maximal complete HTTP calls against current and prepared TS, with precommitted budgets.
    - Check: Record seeds/process repetitions/variance/output consumption, entries/routing, conversion/allocation/disposal, raw/compressed Wasm/glue, peak/live/high-water/committed memory and all thresholds below.
    - Accept: Zero unexplained differences; speed-led default meets fixed budgets or concrete native reuse justifies a compatible explicitly selected core without slower silent default.
- **Lane `consumer` — Real consumer and release review**
  - [ ] **A10.2 — Verify packaged opt-in release and rollback** (implementation; start after `A10.1`, `A07`).
    - Implement: Exercise bounded opt-in release selection using shipped dist binary/glue/catalog versions and current package files inventory; keep TS rollback supported.
    - Check: Test actual packaged imports/assets, missing/corrupt/version errors, local workerd built map, backend swap before traffic and identical persisted/wire values; run required values/stdlib/interfaces/C04 checks.
    - Accept: No unsupported scalar switches; rollback restores TS without .can recompile or migration and never retries failed semantic work.
  - [ ] **A10.3 — Review deployment provenance and default-adoption decision** (implementation; start after `A10.2`, `V08`, `V10`).
    - Implement: Review V08 owning HTTP assembly/deploy join and V10 exact deployed MCP parser provenance decision as separate routes; approve a default only for a proved route and measured nominated benefit.
    - Check: Accept HTTP default only with V08 bounded owning-route proof beyond custom handler fixture, or separately proved deployed MCP provenance under V10. A retained/deferred V10 outcome cannot prove MCP adoption.
    - Accept: The HTTP 501 gap is never closed by arithmetic fixture evidence; unsupported routes stay TS. If neither production route is proved, default adoption is blocked and the completed feasibility outcome records that fact.
  - [ ] **A10 — Measured release outcome and adoption gate recorded** (completion gate; start after `A10.1`, `A10.2`, `A10.3`).
    - Accept: All original A10 performance/resource/release/rollback obligations are complete; enabled defaults require V08/V10 route-specific provenance, while a justified disabled result remains explicit.

### Wave 10 — Completion coverage

- **Lane `consumer` — Real consumer and release review**
  - [ ] **A11.1 — Reconcile completion coverage and package documentation** (implementation; start after `A10`).
    - Implement: Record chosen core profiles, native/actual-adapter/consumer proofs, retained TS compatibility, unsupported/deferred responsibilities and rollout window. Assess duplicate TS retirement separately.
    - Check: Review every source-map row and route in the ledger below; after each eventual merge, handler reconciles all changes since living-filetree checkpoint and advances only after completed coverage/decision review.
    - Accept: Every original A11 completion/documentation obligation is accounted for; bookkeeping authorizes no further implementation.
  - [ ] **A11 — Selected exact-values implementation outcome complete** (completion gate; start after `A11.1`).
    - Accept: A01–A10 required evidence exists, real binding/consumer/release/rollback are proved and adoption enabled or explicitly blocked; retirement and broader legacy migration remain separate decisions.

### Optional and deferred work

No optional task is a prerequisite for A01–A11: fixed-width optimizations, alternative limb transport, a native Node addon, generic execution/lowering, retained public handles, locale/timezone databases, callback helpers, arbitrary structural equality and query-engine aggregation remain separate follow-ups. Extending arbitrary host-object/array routes requires an explicit compatibility proof and release decision. TS retirement is assessed after the rollback window and complete legacy-domain coverage; it is not hidden inside A11. Timebox failures create recorded blocked-adoption or disabled-prototype outcomes and a scoped follow-up, never weaker acceptance or a manufactured production feature.

## Bootstrapping, selection and rollback

Keep synchronous public functions callable after ordinary package import. Default remains TS. A proposed private host bootstrap creates/validates a backend once, before installing it or accepting requests. Node/Bun can load bytes during host startup; Worker builds use the C04 precompiled module path. [wasm-bindgen synchronous instantiation](https://wasm-bindgen.github.io/wasm-bindgen/examples/synchronous-instantiation.html) demonstrates an `initSync` route, but does not prove this repo's Worker module path; A07 must prove that path directly. Avoid a public function returning a Promise or import-time network fetch.

Backend modes are proposed private configuration: `ts` and `wasm-required`, selected explicitly at build/release/startup before any operation. `wasm-required` treats missing binary, version mismatch or init failure as a startup failure. It never silently selects TS after failed Rust bootstrap. Once an operation starts, never catch a semantic error and rerun it through TS. Existing unproved legacy input profiles stay on the compatibility path by declared routing policy, not opportunistic error retry. Do not change backend halfway through a request. Test successful sync use, no-bootstrap TS use, double-init behavior, import cycles, isolate restart, corrupt module and ABI mismatch.

Release/build configuration restores TS without changing persisted/wire values or recompiling `.can`. Ship glue, binary and owning contract/catalog versions together; test the package `files: ["dist/"]` output rather than assuming new source directories publish automatically. C04 owns byte hashes/manifests/import rewriting. Shadow comparison is safe only for inert provenance-proved input; never dual-run getters/proxies/callbacks. TS retirement needs a separate coverage/release decision after the rollback window and proof that the entire supported legacy contract is served.

## Compatibility and measurement gates

Required exact cases include:

- Raw `10^1000` cancellation, multiplication by zero and division/comparison/remainder with wide operands; non-BigInt rejection before conversion; int64 minimum `% -1 == 0`; exact values past `2^53`.
- Decimal zero at stored scales 0 and 18; leading zeros and `-0` text; 38/39 coefficient digits; invalid exponent/plus/separators; scale `-0`, fractional/NaN/infinite/out-of-range; exact max-scale alignment; negative and positive half-even ties/sticky digits; terminating minimal scale and repeating/near-tie division; result overflow after rounding and after scale-up. Compare stored parts as well as canonical text.
- `makeMoney` with wide minor versus `money`/wire narrowing; shape-only unknown currency guard; currencies of scales 0/2/3/4; excluded codes; different errors for maker/builtin/binary operation; money-ratio structural path; mismatch versus zero-divisor precedence; cross-currency equality false versus ordering failure. Maker currency regex/table lookups perform coercion without `currencyScale`'s explicit string check: boxed/stringifying objects, Symbols and throwing coercions stay on the original TS route with their traces.
- Sum cancellation with intermediate overflow, decimal pass ordering, empty typed zeros, empty inferred money rejection, explicit currency validation before elements, mixed currencies, sparse/proxy/custom-iterator arrays and getter exceptions on the public path.
- Duration result-only versus input checks, inexact division and zero-divisor precedence; date leap/century/day/month/year edges, limit exhaustion and half-open `dates/overlaps`; `dates(from == until, 0n)` returns a frozen empty array before the positive-limit check; negative timestamps and supported instant boundaries; public datetime grammar distinct from wire.
- `ValueError instanceof`, name/kind/code/message; SchemaError projection stays validation-owned; freeze flags, original object identity where returned, raw JS exceptions from getters, ordered accesses to `kind/coef/scale/minor/currency`, malformed structural objects and UTF-16 dynamic error text.

Correctness permits zero unexplained differences. Seeded fuzzing complements hand-authored boundaries; an independent rational/digit-string oracle checks rounding, and the existing Decimal.js oracle checks numeric agreement in its stated safe domain. Existing tests do not fully cover arbitrary proxy traces, adapter behavior, initialization or limits; A02/A07–A09 add those proofs.

C05 measures complete API calls including conversion, carrier creation, freezing, validation and disposal. Run scalar chains and existing numeric sums with domains of 0/1/16/256/4096 elements plus caller-derived typical/maximal sizes; ordinary, 38-digit, wide-cancellation and error-heavy inputs; full HTTP input-binding requests; cold startup and warm steady-state. Record actual selected core entries and TS compatibility routing. Public arbitrary arrays remain TS; native sum timings or private owned-domain prototypes must not be labeled public Wasm sum gains. A private owned sum can consume parser/interpreter-produced domains retained inside the core; no inspection of a public array establishes that provenance. Record native core time separately from actual host time. Use a local CPU harness with output consumption, independent process repetitions and recorded variance; production Worker performance timers are not the CPU benchmark. No timings in this plan are invented measurements.

Provisional adoption budgets are chosen to reject changes too small to justify added release/conversion cost: at least 20% median complete-call CPU improvement versus prepared TS on the nominated substantial workload, with a confidence interval excluding no improvement; no more than 10% p95 regression on caller-typical tiny/error paths routed to Wasm. Require warm retained memory growth below 1 MiB after 10,000 repeated requests following warmup/GC where supported; report Wasm committed pages separately from live allocation since linear memory may retain its high-water mark. Initial incremental compressed assets budget is 512 KiB, cold initialization 20 ms in the supported local runtime, and peak memory at most 2x prepared TS on nominated maximum batch. These are provisional engineering budgets, not platform limits or observed results. A01/C05 replaces or ratifies them using real caller payload/host budgets before benchmarking; document any change before viewing comparative results.

Always report raw/compressed Wasm and glue bytes, init cost, conversion/allocation cost, throughput/latency distributions, allocation/high-water/live memory, and error costs. No new global operand-digit limit may narrow public BigInt APIs; OOM is a runtime/resource concern, not permission to invent Can overflow. New private owned-operation limits belong to validation's declared profile and must not leak into old APIs. If the substantial workload or reuse requirement disappears, keep the compatible prototype disabled and retain TS; that is a completed feasibility result rather than a forced rollout.

## Verified commands, completion and bounded remaining decisions

For this planning pass, the following existing commands ran successfully from the repository root. Build passed; the selected test command passed **424 tests in 78 suites**, with no failures or skips. This is current TS evidence, not native/Wasm evidence. No production source was changed.

```sh
bun run --cwd packages/values build
node --test packages/values/dist/values/test/int.test.js packages/values/dist/values/test/decimal.test.js packages/values/dist/values/test/decimal-oracle.test.js packages/values/dist/values/test/money.test.js packages/values/dist/values/test/array.test.js packages/values/dist/values/test/temporal.test.js packages/values/dist/values/test/kinds.test.js packages/values/dist/values/test/equality.test.js packages/values/dist/values/test/types.test.js packages/values/dist/values/test/wire.test.js packages/values/dist/values/test/conformance.test.js packages/values/dist/values/test/exports-conformance.test.js
```

Verified package scripts also define `bun run --cwd packages/values typecheck`, `bun run --cwd packages/values test`, `bun run --cwd packages/stdlib test`, and `bun run --cwd packages/interfaces test`; these broader commands were inspected but not run in this planning pass. A08–A10 must run them and the C04 actual workerd/delivery tests. Native/Wasm scripts listed in the checklist are future deliverables, not runnable existing commands. Capture baseline failures separately rather than treating unrelated errors as port regressions or silently fixing outside scope.

Complete implementation means A01–A11 deliver their evidence, every chosen numeric responsibility has native and real-adapter parity, package/stdlib exports stay synchronous, actual Worker loading and packaged release/rollback pass, the whole consumer pilot satisfies its profile, and adoption has recorded performance or concrete native reuse justification. A native-only crate or a Wasm stub is not completion. Retained TS host/legacy paths and deferred responsibilities must be listed honestly; full legacy validation is a separate project, not implied by this plan.

The completion ledger must distinguish these routes rather than report all public code as ported:

| Input/operation profile | Planned final route | Required evidence |
| --- | --- | --- |
| Raw primitive BigInt arithmetic | Selected backend core after operation-specific TS type checks | Unrestricted operand/result/error differential tests |
| Provenance-registered genuine decimal/date/instant carriers and factory money with primitive currency/BigInt minor | Selected core with TS materialization | Register within the successful owning constructors without observable reads; stored parts/class/freeze parity. Coercing maker arguments and unproven structural money stay TS |
| Arbitrary structural decimal/money/date/instant, getters/proxies | Existing TS compatibility path until trace parity is proved | Original access/exception/order tests; explicitly retained coverage |
| Arbitrary public arrays, custom iterators/proxies | Existing TS iteration/aggregate path until trace parity is proved | Pass order, sparse elements, mutation/throw traces; explicitly retained coverage |
| Parser-owned whole input or private owned numeric domain | Core complete-call path with validation profile | Real parser provenance, all stages/outputs, actual Wasm consumer differential |
| Identity-returning min/max and nonnumeric equality/callback helpers | TS orchestration, numeric mechanisms shared only where safe | Original reference identity and callback/order tests |

This completes the selected numeric kernel and proven profiles while preserving public behavior; it does not certify that every legacy host-object path executes in Rust. Extending those routes is separately gated work, not a reason to discard compatible TS code.

Remaining decisions are timeboxed rather than architectural placeholders: A01 has two working days to nominate workloads/reuse, ratify budgets, shared ownership and layout; A03 one day to verify crate/toolchain/binding pins and license/build constraints; A07 two days to resolve actual initialization/package delivery with C04; A09 two days to resolve owned-input pilot provenance and profile parity with validation. If a timebox expires, record the failed evidence, retain TS, and produce a scoped follow-up or a stop decision. Hard tradeoffs about ABI transport changes, workload budgets or widening legacy input compatibility go to the coordinator's preauthorized three equivalent JEV consultations with source facts and balanced TS/prepared-TS/Rust alternatives. Advice does not substitute for differential or runtime evidence, and this plan promises no numerical feasibility score.
