# A01.1 — Exact-values owner, caller and observable-contract inventory

Task: A01.1 (lane `core`, wave 1, after `C01.ready`). Produced 2026-10-06T08:31:53Z
by lane F session 01a10fab-d28b-7563-9d14-ebd2ddf4e8c9. Planning record only;
no implementation authorized.

- Planning checkpoint: `3d1f8f062f9650c061f6cb87c8af9afb2c01b0e5`
- Inventory head: `bb479c2fd9a1e0a3604f946aff0205c7bdf45e06` (current main)
- Source hash (`packages/values` tree at head): `a4e33155a32dd654c0133c43ce617a3521d84743`
- Basis: `scope.json` (C01.1, accepted) — `packages/values` is byte-identical
  between checkpoint and head, so this inventory holds for both pins.
- Method: `prepared-baseline-contract.json` (C02.1), `transport-contracts.json`
  (C03.1), `implementation-plans/exact-values.md` source/consumer map.

## Coverage assignment

Every mapped export is assigned to exactly one of: **core** (migrated
mechanism in `semantics/`), **façade** (retained public TS surface, makers,
guards, dispatch, orchestration), or **deferred** (out of exact-values scope;
stays TS unless a separately proved tranche adopts it).

| Module (`packages/values/src/`) | Exports | Assignment | Admitted-input / error / order contract |
| --- | --- | --- | --- |
| `int.ts` (10) | `INT64_MIN/MAX`, `int64`, `add/sub/mul/mod/neg/abs/compareInt` | core mechanisms + façade narrowing | Unrestricted BigInt inputs; result-only int64 narrowing; unrestricted compare; truncating remainder. Errors: `ValueError(overflow/division-by-zero/out-of-range)` with current messages. |
| `decimal.ts` (18) | construction, parsing, math, text, `divideDurationMs` | core algorithms + façade `Decimal` class | Scale 0..18, 38 coefficient digits, half-even rational math, division terminating scale, raw BigInt promotion, money/money ratio branch, grammar/text order. |
| `money.ts` (12) | makers, guards, arithmetic, ratios | core arithmetic + façade makers/guards | Scale/table checks; shape-only guard; maker-vs-arithmetic narrowing; single rounding; currency precedence. `makeMoney` shape/table without minor narrowing; `isMoney` shape-only. `currency-mismatch`/`unknown-currency` preserved. |
| `kinds.ts` (23) | date/instant makers, guards, structural kinds | core numeric parts + façade makers/guards | Maker overloads, guard order, structural `.kind` carriers, freezing obligations. |
| `temporal.ts` (31) | civil/instant/duration ops | core civil/instant/duration + façade overloads | Civil day/month clamping; years 0001..9999; parsing-vs-wire grammar; duration exactness; limit/error order; `nonexistent-time`/`fold-required`. Timezone conversion stays host-owned (deferred). |
| `array.ts` (17) | numeric sums + general access | core numeric sums; general access deferred | Final-only narrowing/cancellation; decimal-only domains; explicit/inferred/empty money-currency rules; pass order (`sumDecimal` validates domain, selects scale, second summing pass). Arbitrary-array access stays TS unless separately proved. |
| `equality.ts` (2) | numeric comparison branches + dispatch | core numeric mechanisms; dispatch + nonnumeric deferred | Int/decimal promotion; currency equality-vs-ordering; original object identities retained. |
| `stdlib-pure.ts` (15) | pure dispatchers incl. min/max | core comparison helpers; dispatch deferred | Dispatch/error arity preserved; public `min/max` stay TS orchestration returning the original winning object. |
| `wire.ts` (2 + re-exports) | canonical exact strings, bounds, date formatting | core scalar codecs; traversal deferred to validation | Numeric wire bounds; encode `ValueError` vs decode violations; canonical exact strings. Full traversal / type-plan policy owned by validation plan. |
| `schema.ts` (21), `types.ts` (8) | AST/type parsing, bounds/defaults/presence | deferred to validation plan | Validation owns type IDs, registered plans, traversal, presence/default/ref behavior, accumulated paths. Imports numeric representations/codecs from this plan; must not redefine them. |
| `errors.ts` (3) | `ValueFailureCode`, `ValueError`, `SchemaError` | façade (frozen) | Closed code set (`overflow`, `division-by-zero`, `inexact`, `currency-mismatch`, `unknown-currency`, `invalid-construction`, `nonexistent-time`, `fold-required`, `out-of-range`, `limit-exceeded`); classes/messages frozen; neither class satisfies a business error. |
| `catalog.ts` (2), `currency-data.ts` (1) | 165-currency table, provenance, emit script | façade/owner inputs (never ported) | Pinned admissible currencies + provenance/language version; core generates/verifies build inputs from these owning TS sources; no second table. |
| `locale.ts` (7), `icu.ts` (14), `timezone.ts` (5), `text.ts` (11) | locale/ICU/TZ/text helpers | deferred | Locale/ICU/timezone databases and text helpers stay TS; excluded from exact-values scope. |
| `index.ts` | barrel re-exports + contracts values types | façade (frozen) | Same synchronous exports; no new mandatory public init; generated programs keep importing via `@canlang/stdlib`. |

Contracts-owned `packages/contracts/src/values.ts` (public shapes/version) is
read-only input: no Rust-authored replacement contract. `conformance/v1/`
stays published-unchanged; new fixtures go alongside it.

## Caller inventory (verified at head)

- **Generated programs / stdlib**: `packages/stdlib/src/index.ts` re-exports the
  producer surface (`test/assembly.test.ts` guards the boundary). Values must
  never import stdlib back (verified barrel comment + one-way dependency).
- **Interfaces pilot** (jointly owned with validation; interfaces keeps
  first-error messages/order): `packages/interfaces/src/mcp/schemas.ts`
  (`checkDecimalLiteral`, `checkBoundArguments`) and
  `src/http/operations.ts`; also referenced by `mcp/server.ts`, `ports.ts`,
  `cloudflare/src/runtime/mcp-registry.ts`, `t19b-depth.test.ts`.
- **Direct `.coef`/`.minor` consumers** (structural carriers the core must not
  break): `packages/interfaces/src/mcp/schemas.ts`,
  `packages/state/src/query/engine.ts`, `packages/ui/src/forms.ts`,
  `packages/ui/src/messages.ts`, `packages/ui/test/policyPage.test.ts`,
  `compiler/src/policy.rs`, `compiler/tests/codegen.rs`,
  `compiler/tests/effects.rs`.
- **Cloudflare/testkit delivery**: `deploy/bundle.ts`, `dev/local-run.ts`,
  `testkit/src/scopes/local.ts` (values vendor resolution, text-only Worker
  delivery) — owned by shared C04 delivery; prerequisite for a Worker backend.
- **Compiler (read-only)**: `compiler/src/codegen/js.rs`,
  `compiler/src/analysis/effects.rs` import helpers through stdlib and read
  `coef/minor` fields. Compatibility evidence only.

## Wide raw domains (must survive the port)

- Unrestricted-magnitude BigInt operands into `compareInt` and all int
  arithmetic; result-only narrowing.
- Raw BigInt promotion paths in decimal construction and money ratios.
- Full 38-digit coefficient / scale 0..18 decimal domain; half-even ties.
- Complete civil/instant/duration domains incl. leap/epoch edges and
  fractional times where accepted.

## Public reads / errors / identity obligations

- Guard/property reads repeat in a defined order on possibly-getter/proxy
  public values; never inspect or freeze an arbitrary object to declare it
  inert.
- `ValueError`/`SchemaError` classes, codes, and messages are frozen;
  error-vs-violation and encode-vs-decode distinctions are per-entry.
- Identity-returning operations (public `min/max`, numeric equality winners)
  retain host object identity; freezing obligations stay with the façade.

## Outcomes

- **Package-only workspace confirmed**: all migrated mechanisms live under
  `packages/values/` (`semantics/`, `bindings/`, existing `src/` façades);
  the compiler is not a workspace member; no compiler edits or crate
  dependency.
- **Interface pilot owner confirmed**: `packages/interfaces` owns pilot order
  and first-error messages; exact-values owns numeric mechanisms; validation
  owns traversal/profiles. Whole-operation pilot is joint, sequenced by plan
  dependencies.
- **Compiler changes unnecessary**: compiler consumes only through the stable
  stdlib surface and structural `coef/minor` reads, both frozen by this
  inventory; no lowered-syntax, codegen, or analysis change is required for
  any mapped source. (Consistent with C01.1: the sole compiler delta since
  checkpoint touched two test files only.)
- **Owner approvals**: pending explicit sign-off by values owner (numeric/raw/
  carrier contracts), validation owner (traversal/profile split + codec
  reuse), interfaces owner (pilot order/messages), and C04 delivery owner
  (Worker backend prerequisite). Recorded here as required, not assumed.
