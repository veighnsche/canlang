# Lane 02: Exact values, schemas and pure standard library

Status: active coordination. Coordinator session 01a10710-7482-7093-8e17-2382b074102b,
goal goal-01a10711-f621-7501-9494-d85e4f5f865d (native, no token budget).
Worktree (owned, cleanup: this coordinator after all writers/viewers release):
`/Users/vince/Projects/canlang-worktrees/lane-02-values`, branch prefix
`muse/lane-02-values/`, base origin/main c949174 (PR2 #17 merged; see
evidence). Current branch: `muse/lane-02-values/temporal` (PR3 slice). The
primary checkout is never touched.

Owner prompt: [lane 02](../prompts/02-values.md). Binding: PLAN, WORKFLOW,
CONTRACTS, DIAGNOSTICS, AGENTS.md (all read at b06d873).

## Lower-level plan

### 1. Current implementation evidence (b06d873)

Greenfield for this lane: no `packages/`, no root `package.json`, no
`.github/workflows`, compiler is a one-file Rust scaffold. Normative inputs
verified: REQUIREMENTS.md (full), DESIGN.md §2/§3/§10-wire/§11-pinning/§13
(read firsthand), GRAMMAR.md types/expressions (via inventory +
`tools/can_parser.py` behavior), DECISIONS.md money/time items 140-180 (MINE
rules confirmed), draft `.can`/`.mjs` witnesses (proposed contracts, not
semantics). Two read-only inventory subagents delivered full-provenance reports
(scalar/temporal; collections/schema/builtins); no other lane has pushed
branches or PRs (checked `git ls-remote`, `gh pr list`: empty).

### 2. Settled normative core (with sources)

- Types: int64-checked `int`; `decimal` ≤38 sig/≤18 frac; `money`
  `{minor:int,currency}` pinned scales; `date` 0001-9999 proleptic Gregorian;
  `datetime` ms-precision UTC; `duration` integer ms; IANA `timezone`; validated
  `email/url/locale/timezone/currency`; closed `enum`; `text`/`bool`;
  `user/member/record-ref/contract/union/action/delivery/file/secret/json`;
  `T[]` ([] default) vs `T[]!` (required input); `T?` (null default)
  (DESIGN §2; GRAMMAR types).
- No money/date/datetime literals: checked constructors
  `money(int|decimal,currency)`, `date(text)`, `datetime(text)`; duration/byte
  literal suffixes only (DESIGN L228; GRAMMAR tokens).
- Operator matrix: int/int `/`→decimal; money same-currency `+-`, ratio `/`;
  duration exact-ms division; datetime±duration; no date arithmetic; unary `-`
  checked incl. INT64_MIN; int↔decimal exact promotion inside operator only
  (DESIGN L182-211).
- Rounding: half-even everywhere; decimal = math result → ≤18 frac → 38-sig
  check; money = round once per op boundary to pinned scale; aggregates check
  once; no NaN/∞; zero divisor fails (DESIGN L211-213).
- Temporal builtins: half-open `overlaps`; original-anchor `add_months`;
  `dates` half-open with work-bound limit (fail, never truncate); explicit-fold
  `local_instant`, nonexistent fails; `local_date`/`add_days`/`date_year`/
  `weekday` (DESIGN L219-224).
- Text: Unicode-scalar counting; full default case conversion; pinned
  White_Space trim; no implicit normalization/locale tailoring; exact
  case-sensitive matching (DESIGN L265).
- Bounded ICU profile + RFC 4647 whole-message fallback + label/message shapes
  (DESIGN §9.1); plain `format` Display set excludes decimal/money/datetime.
- Structural equality via type id; refs by identity; `==` null==null, other
  null ops type errors; `??` sole fallback (DESIGN L159-165, L205-209).
- Schema: creation-only defaults, server initializers, inclusive bounds after
  normalization, `unique` (nulls excluded), field-type reuse carries
  representation/bounds only (DESIGN §2).
- Wire: int/decimal/minor/version = canonical decimal strings; money =
  minor-units/currency; datetime = RFC 3339 UTC; refs `{id}`/`{id,version}`;
  files opaque IDs; unions discriminated; closed JSON; `operation_id` on
  mutations (DESIGN L872). Never BigInt-as-JSON-number or Number-routed
  exactness (CONTRACTS).
- Errors: business codes `validation/forbidden/not_found/conflict/rule_failed/
  busy/limit/delivery_unknown` + safe details; `DeliveryError` closed
  `{code,message}`; setup/schema failures can NEVER satisfy `error(code)`
  (DESIGN L465/L646-650; CONTRACTS; prompt).
- Closed pure builtins: `count/sum/min/max/any/all/first/group/flatten/at/abs/
  round/lower/upper/trim/contains/starts_with/join/format/app_url/
  active_member/overlaps/local_date/local_instant/add_days/add_months/
  date_year/weekday/dates/money/date/datetime/action/random_secret`
  (DESIGN L215-259); `?.`/`??`/`in`/`is` are operators, not builtins.
- §13 lowering helpers (one import name each, proposed): `addMoney/
  subtractMoney/multiplyMoney/compareMoney/equalMoney/negateMoney/
  divideDecimal/durationBetween/compareInstant/compareDate/compareDecimal/
  addDuration/subtractDuration/int64/same/equalValue`, comparators −1/0/1.
- Language version pins builtin signatures, wire schemas, currency scales,
  timezone data (DESIGN L888). One authored contract per capability; TS types
  + emitted catalog checked against it; no duplicate Rust/TS/MCP/form tables
  (CONTRACTS).

### 3. Coordinator decisions (representation owner)

- R1 Runtime tags: `int`/`duration`/byte-qty/minor/version = `bigint`
  (schema type id disambiguates); `decimal` = `Decimal` class
  `{coef:bigint,scale:0..18}` (stored scale retained, equality by value);
  `money` = frozen `{kind:"money",minor:bigint,currency}`; `date` = frozen
  `{kind:"date",year,month,day}`; `datetime` = frozen `{kind:"datetime",
  ms:bigint}` UTC; text/bool/enum/validated-likes = primitives (validated at
  construction); `user/member/file/delivery/ref/action/secret` = frozen tagged
  objects; contract = plain object; union wire `{type,value}`.
- R2 JEV-backed (see evidence `jev/values-20261004/`, model jev-1.13.0):
  (a) decimal wire = unique normalized text (strip frac zeros, no point when
  integral, `0` for zero, no exponent); (b) currency = pinned ISO 4217 table
  membership, else validation failure at the checking boundary; (c) money
  `==`/`!=` decidable across currencies (unequal), ordering fails; `min/max`
  reject mixed, `group` groups (MINE-144). Dissent preserved: c-rewrite backed
  strict-everywhere money comparison (0.74); rule stays centralized in one
  function pending any normative clarification.
- R3 Direct rulings: decimal `1.0 == 1.00` (value equality; "normalization
  does not change its value"); `same()` = identity (record id+model, user id;
  version is concurrency, not identity); `count()`-style Can ints stay decimal
  strings on the wire ("protocol itself" = MCP/JSON-RPC-level counts only);
  date wire `YYYY-MM-DD`; duration wire = canonical decimal string of ms;
  user/member wire = `{id}` refs; delivery wire = `{id,operation}` locator
  (joint decision with L4/L6 flagged); `sum(money)` explicit currency allowed
  when matching; no `len`/substring builtin (length observable via validation
  only — confirm if L1 needs it); `random_secret` NOT pure: catalog entry with
  `implemented:false`, owner lane-03 (server defaults); `active_member` and
  `action()` signatures authored here, implementation external (L3/L1
  registry); query-domain aggregates dispatch to L3, supplied-array evaluation
  here.
- R4 Errors: validator returns structured `Violation[]` (pure data); callers
  map to envelopes. `SchemaError` (shape/setup) vs `ValueError`
  (overflow/rounding/constructor/evaluation failure) are distinct classes so a
  schema error can never satisfy a BDD business error; business-code mapping
  stays with L3/L7. `DeliveryError` is L4-owned (`services.ts`, landed first
  in their S2 #5): this lane removes its duplicate in PR2 and keeps a doc
  pointer (handshake proposed in PR2 description; L4 ack requested). Caution
  to L7: wire `values.ts` into the contracts index only after PR2 merges.
- R5 Catalog: `catalog.ts` is the single authored definition (Can builtins +
  §13 runtime helpers + features + per-entry implementation owner/status);
  build script emits versioned JSON envelope + fails if runtime exports
  diverge. Envelope implements the L1 IR-01 sketch
  `{catalog_version,language_version,entries:[{id,owner,kind,signature,
  effects,availability}]}` plus `js`/`notes`/`features` additions and
  `language_version:"1.0"` (L1 provisional); version
  `0.1.0-lane02-draft`; L1 acknowledgment pending. Business codes are NOT
  repeated here (`StateErrorCode` in L3's `state.ts` is the single
  definition); zero export-name clashes verified against all landed
  contracts modules.

### 4. Exact desired tree (owned)

```text
packages/values/                  # owned: package + manifest + lock
  package.json, package-lock.json, tsconfig.json, README.md
  src/kinds.ts                    # A: tags, guards, frozen ctors
  src/int.ts                      # A: int64 checked ops
  src/decimal.ts                  # A: BigInt decimal, half-even
  src/money.ts src/currency-data.ts  # A: money ops, pinned ISO table (provenance header)
  src/temporal.ts src/timezone.ts # B: date/datetime/duration + Intl zone resolution
  src/text.ts src/icu.ts src/locale.ts  # B: unicode ops, bounded ICU, RFC4647 fallback
  src/array.ts                    # B: concat/flatten/at/aggregates/group/any/all/first (arrays)
  src/equality.ts                 # B: equalValue/same/comparators (R2 central rule)
  src/schema.ts src/types.ts      # C: descriptors, normalize+validate → Violation[]
  src/wire.ts                     # C: JSON encode/decode per type id (R2/R3 forms)
  src/errors.ts                   # A: SchemaError/ValueError/DeliveryError shapes
  src/catalog.ts                  # C: single authored definitions
  src/stdlib-pure.ts              # C: the 40 builtins assembly (external-marked excluded)
  src/index.ts                    # C: internal assembly (NOT public façade)
  scripts/emit-catalog.mjs        # C: emit + export-conformance check
  test/vectors/*.test.mjs + cross-checks  # A/B/C: conformance vectors per area
packages/contracts/src/values.ts  # owned: type-only boundary (tags/wire/catalog/violation)
.github/workflows/lane-02.yml     # owned: install → tsc → node:test → catalog check
implementation/status/lane-02.md  # owned: this file
implementation/evidence/jev/values-20261004/  # JEV round (done)
```

### 5. Interfaces and dependencies

- L7 (requested with PR1, mirroring the L3 follow-up): add the
  `contracts/src/index.ts` re-export of `values.ts` (L7-owned assembly; this
  lane does not touch it), integrate `@canlang/values` into the root lock,
  then switch this package to `@canlang/contracts` imports + root workspace
  install and retire the nested lock. Package builds/tests standalone until
  then (TS 5.9.3 + @types/node 26.6.4 pinned, matching L3; ESNext/Bundler
  interim tsconfig mirroring L3 S1). L7 pins workerd/ICU runtime for TZ
  determinism (risk §8).
- L1 (PR1 implements their IR-01 sketch; ack requested): envelope
  `{catalog_version,language_version,entries,features}` with
  `language_version:"1.0"` provisional; checker uses catalog signatures;
  codegen emits §13 helper imports; literal emission honors canonical
  forms. Test-only consumer fixture simulates Rust-side catalog consumption
  at B0; B1 needs one real signature end to end (L1 plan).
- L3 (requested): façade `@canlang/stdlib` re-exports with exact canonical names
  (list in §7 request); implements `random_secret`/`active_member`/query-domain
  aggregates/`action()` registry side; maps `Violation[]` to admission envelopes.
  Inbound acknowledged: L3's B1 need "exact value equality + canonical JSON
  codec" is PR4/PR5 scope here.
- L4/L6 (joint): delivery/file wire mapping + observation; file-shaped values stay
  unfinalized/unauthorized here.
- L2 provides all lanes: exact semantics, wire codecs, schema validation, catalog.

### 6. Reuse and qualification

- Decimal: OWN BigInt implementation (library precision-models mismatch Can
  scale semantics); `decimal.js` 10.6.0 cross-check oracle DEFERRED to PR5
  (workspace-era nested installs need the L7 root-lock follow-up; PR2 uses
  normative vectors + algebraic property checks instead).
- Calendar/zones: OWN Hinnant proleptic algorithms + `Intl.DateTimeFormat`
  round-trip zone resolution with explicit fold/gap handling; cross-check vs
  `Date`/TZ-stable vectors. No Temporal/date-lib dependency (host variance).
- Case/whitespace/scalars: native `toLowerCase/toUpperCase`, `\p{White_Space}`,
  string iteration; native `TextEncoder`/URL (app_url origin is injected trusted
  context, never request Host).
- ICU: reuse `@formatjs/icu-messageformat-parser` (pinned; pure JS, workerd-safe)
  for parsing + OWN validator/renderer enforcing the bounded profile. Qualify:
  banned constructs rejected, bound constructs render per vectors.
- Runner/build: `node:test` built-in + `tsc` build to dist; `typescript` pinned
  devDep. No framework added. src uses no `node:` imports (workerd-safe).
- ISO 4217 scale table: generated at author time from an authoritative public
  source with URL+date provenance header committed in-repo; test pins
  EUR/USD=2, JPY=0, KWD/BHD=3, etc.

### 7. Subtasks, worker reservations, PR order

Max two active implementation subagents; disjoint exact files; workers never run
git/commit/branch commands. Coordinator does scaffold review, git, PRs, merges.

- [x] P0 inventory (done): two read-only researchers; JEV round done.
- [ ] PR1 `muse/lane-02-values/scaffold` (coordinator): package scaffold,
  `contracts/src/values.ts`, `kinds.ts`, `errors.ts`, catalog envelope draft,
  `lane-02.yml`, status+evidence. Green build + shape tests.
- [ ] PR2 `.../scalars` (worker A): `int/decimal/money/currency-data` + scalar
  vectors + scalar wire + decimal.js cross-checks.
- [ ] PR3 `.../temporal` (worker B): `temporal/timezone` + vectors. Parallel w/ A.
- [ ] PR4 `.../collections-text` (worker B or C): `text/icu/locale/array/
  equality` + vectors.
- [ ] PR5 `.../schema-catalog` (worker C): `schema/types/wire/catalog/
  stdlib-pure/index/emit-catalog` + full suite + export-conformance gate.
- [ ] PR6 `.../integration`: B1/B2 joins (real calls when producers land;
  until then BDD-shaped pure-call tables + consumer fixtures), coverage of all
  accepted pure builtins, façade export request to L3.
- Reviews: one bounded independent read-only subagent review per semantic PR
  (PR2-PR6); coordinator inspects every diff.

### 8. Test cases (conformance vectors; each with invalid inputs)

Scalars: int64 bounds/negation/division-sign; decimal 38/18 bounds, half-even
(`2.5→2`, `3.5→4`, money `0.005→0.00/0.01` per scale), int/int→decimal,
money same-currency only, ratio→decimal, mixed-currency error/grouping,
unknown-currency rejection, wire strings incl. >2^53 and `money.minor`.
Temporal: UTC store/display zone; half-open reservations; DST gap (fail) and
fold (earlier/later both constructible, default required-ness); month-end
anchor (Jan31+1=Feb28/29, +2=Mar31); `dates` bounds/limit-fail; sub-ms
rejection; duration exact-ms division.
Text/collections: scalar counting (astral=1); `İ` case; White_Space trim incl.
U+00A0; no-normalization inequality (é vs e+́); ICU profile accept/reject
matrix; fallback chains incl. null-skip + selected-locale plural rules;
`T[]`→[], `T[]!` required, `T?` null, omitted-vs-null on update; `??`/`?.`
semantics; flatten/at/concat; aggregates incl. empty forms + nonempty-literal
rule; group null-key + encounter order; structural equality incl. decimal
scale, refs, unions.
Schema/codec/errors: creation defaults/server/authority; bounds inclusive;
unique+nulls; reuse-drops-defaults; suffix grammar accept/reject; wire
round-trips per type id; `Violation[]` mapping; SchemaError≠business error
(BDD-shaped: invalid fixture never satisfies `error(code)`); catalog
emission + export-conformance; `operation_id`/unknown-arg rejection shapes.
Cross-checks: decimal vs decimal.js (randomized), calendar vs Date/Intl,
catalog JSON consumed by a test-only fixture.

### 9. Integration joins

- B0 now: envelope + vectors + fixtures; consumer fixtures are test-only and
  advertise nothing.
- B1 (needs L1/L3/L6/L7): same real signature through Rust check → runtime
  validation → consumer discovery; literal→wire→input round-trips; denied/
  stale/replay cases stay L3's with our equality/codecs underneath.
- B2 (needs L3/L4/L7): finalized-file/attachment values, delivery receipts,
  money snapshots; provider fixtures are L4's.
- Façade request to L3 (exact canonical names): all §3 pure builtins +
  all §13 helpers + `Decimal`/`Money` value ctors + `equalValue`/`same` +
  `validateSchema`/wire `encode`/`decode` + error classes (final list rides
  with PR5).

### 10. Risks

TZ/ICU host variance (vectors use long-stable transitions; L7 runtime pin
requested); strict-everywhere money reading (centralized, flagged); decimal
`datetime` range bounds unnamed ("supported calendar range" — propose
0001-9999 civil + ms range test); byte-qty mixed-unit ordering (compare by
bytes); CanCheck `"provider"` code drift (draft-owner question, low priority).

## Progress and file reservations

- P0 done 2026-10-04: worktree/goal/inventories/JEV round complete.
- PR1 built 2026-10-04 on 14fa6a0: scaffold + `values.ts` contract v1 +
  kinds/errors + 50-entry catalog + CI; typecheck clean, 16/16 tests green,
  catalog emits; TS 5.9.3 aligned with L3; zero contracts export clashes.
- PR1 merged 2026-10-04 as 48dbb77 (PR #8, squash, head 2f7f21a): independent
  review returned merge-after-fix (10 minor/nit, no blockers), all fixed,
  19/19 green, both CI runs green, mergeState CLEAN. L4 S2 #5 merged just
  before (0dbfb2e).
- PR2 branch `muse/lane-02-values/scalars` cut from 48dbb77. New clash found:
  `DeliveryError` now in L4 `services.ts` and lane-02 `values.ts` — removal
  + handshake decided (R4). Coordinator-owned shared files this slice:
  `package.json`, `catalog.ts`, `index.ts`, `errors.ts`, `contracts/src/values.ts`
  (removal), this file. Workers touch ONLY their listed files.
- L7 PR2 #9 joined `values.ts` into the contracts index (interim
  `DeliveryError` pick: services) and integrated `@canlang/values` into the
  root lock — both PR1 follow-ups done. Handoff to L2+L4 to deduplicate
  `DeliveryError`: this lane removes its duplicate in PR2 (R4). Nested-lock
  retirement + root-ci switch: acked, scheduled as a small follow-up PR
  after PR2 (PR2 keeps the proven member flow).
- 2026-10-04: instance restart killed both PR2/PR3 implementation workers
  with zero files written (both runs `failed`, no cause recorded). No
  worktree damage; toolchain re-verified green (19/19) on 540a281.
  Respawning both with identical briefs.
- Scalars worker done: int/decimal/money/currency-data + 69 tests, all green.
  Currency table fetched from SIX list-one.xml (Pblshd 2026-09-17): 165 pinned
  codes (17×0/139×2/7×3/2×4), 13 N.A. codes excluded with rationale; counts
  and 20 spot values re-verified by coordinator.
- Temporal worker done: temporal/timezone + 55 tests, all green; coordinator
  reviewed (Hinnant bounds, ctor strictness, fold/gap probing all correct).
  One fix applied: `remainderDuration` now int64-checks its result. Files
  HELD UNCOMMITTED for the PR3 branch (PR2 stages scalar files only).
- PR2 assembly (coordinator): `DeliveryError` removed (contracts + errors +
  tests, doc pointers to L4 `services.ts` — L7 handoff resolved); catalog
  50→55 entries (5 gap helpers: add/subtract/multiply/negateDecimal,
  divideMoney — operator-matrix-required but absent from the L992 draft
  list, L1 join to confirm) + 11 availability flips + 5 feature flips;
  index exports scalar modules. Verified: PR2-only tree 87/87 green from
  clean dist; full tree 142/142 green; catalog emits.
- L992 lowering gaps discovered (need L1 confirmation): decimal +,-,*,unary-
  and money/int|decimal `/` have no §13 helper; duration/int exact division
  (`divideDurationByInt`) likewise (rides PR3). Int ops lower via the
  `int64()` wrapper (draft-witnessed); int/duration/text comparisons lower
  to native operators. Carried in the PR2 description.
- PR2 merged 2026-10-04 as c949174 (PR #17, squash, head ee3897e):
  independent review verdict merge with zero findings; 87/87 on the PR tree,
  both `values` CI runs green. The red `workspace` job is pre-existing
  breakage (L3 S2 #15 added state deps without the L7-owned root-lock
  update; fails identically on unmodified main@5a271a6, run 37208106425) —
  documented on the PR; L3/L7 own the fix. No rebase past 53f6f29 was needed
  (L3 S2 touches disjoint paths; merge commit already includes it).
- PR3 branch `muse/lane-02-values/temporal` cut from c949174: 4 temporal
  files + catalog (16 flips + `divideDurationByInt` gap entry + 2 feature
  flips) + index exports. Catalog now 56 entries: 32 implemented, 22
  planned, 2 external (audited by exact script, not grep).
- Active workers: none (coordinator assembling PR3; next delegation is the
  PR4 text/collections slice).

## Interface requests and handoffs

- To L7: PR1 follow-up — `contracts/src/index.ts` re-export of `values.ts`,
  root-lock integration of `@canlang/values`, then `@canlang/contracts`
  import switch + nested-lock retirement (mirrors L3 follow-up); pin
  workerd/ICU for TZ determinism. (PR1 description carries it.)
- To L1: PR1 implements IR-01 envelope sketch — ack requested on
  `catalog_version`/`entries` shape + `js`/`notes`/`features` additions;
  checker/codegen joins at B1. (PR1/PR5 descriptions.)
- To L1 (with PR2): confirm 5 gap-helper names (add/subtract/multiply/
  negateDecimal, divideMoney) + PR3 `divideDurationByInt` — required by the
  operator matrix, absent from the L992 draft list. Counter-propose names
  before B1 codegen if preferred.
- To L3: façade export list (final with PR5); `random_secret`/`active_member`/
  query-aggregate/`action()` implementation ownership; `Violation[]` mapping.
- To L4/L6: delivery/file wire mapping joint confirmation (proposed R3).
- To L4 (HANDSHAKE with PR2): `DeliveryError` defined in both `services.ts`
  (landed first, #5) and lane-02 `values.ts` (PR1 #8) — identical DESIGN §8
  shape. Proposal: L4 owns it; lane-02 PR2 removes its duplicate
  (interface + maker/guard + tests) and doc-points to `services.ts`.
  Optional: adopt `readonly` fields (our strict guard required exact keys +
  non-empty strings). L4 ack or counter requested before L7 wires either
  file into the contracts index.
- From L1 (IR-01): catalog envelope sketch + `language_version "1.0"`
  provisional — adopted in PR1.
- From L3: B1 need "exact value equality + canonical JSON codec" — acknowledged,
  PR4/PR5 scope.
- From L7 (PR #4): root workspace + contracts assembly + vitest config;
  producer `node:test` runners explicitly allowed — adopted as-is.

## PR and verification evidence

- PR #8 (scaffold) MERGED 2026-10-04 as 48dbb77: 24 files, reviewed head
  2f7f21a (fixup over reviewed 0e7fd2f implementing all 10 review asks),
  typecheck clean, 19/19 node:test green, catalog 50 entries/15 features,
  both `values` CI runs green, mergeStateStatus CLEAN, branch unprotected.
  Limits: all entries planned/external; export-conformance in PR5.
  URL: https://github.com/veighnsche/canlang/pull/8
- PR #17 (scalars) MERGED 2026-10-04 as c949174: 14 files, reviewed head
  ee3897e, independent review verdict merge with zero findings, 87/87 on
  the PR tree, both `values` CI runs green. `workspace` red pre-existing
  (L3 S2 lock breakage, documented on PR). Limits: `abs` dispatcher in PR5;
  decimal.js oracle deferred to PR5; temporal held for PR3.
  URL: https://github.com/veighnsche/canlang/pull/17

## Remaining work and cleanup

Full scope §7 PR1-PR6 + B1/B2 producer joins. Owned resources: the worktree,
branch set `muse/lane-02-values/*`, `node_modules` under `packages/values`
only. Cleanup after final merge + writer/viewer release; never kill unrelated
processes or shared caches.
