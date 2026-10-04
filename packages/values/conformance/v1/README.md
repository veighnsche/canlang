# Values conformance fixtures v1

Versioned consumer fixtures for the lane-02 exact-values producer
(`@canlang/values`, revision `742c618` PR5). B1/B2 join legs (L3/L6, L1
codegen) import `values.json` and decode it through the producer — never by
re-implementing the codecs.

## Sections

- `meta` — `{ version: 1, valuesRevision, contractVersion }`.
  `contractVersion` equals `VALUES_CONTRACT_VERSION` from
  `packages/contracts/src/values.ts`.
- `wireSamples` — per-type-id wire round-trips. A valid row is
  `{ typeId, wire, expected }`: `decodeValue(typeId, wire)` must succeed and
  `encodeValue` of the result must deep-equal `expected` (the canonical
  wire). An invalid row replaces `expected` with `expectedViolations`, an
  ordered `[{ path, code }]` list the thrown `SchemaError` must carry
  exactly; `secret` rows additionally set `encodeRefused: true` plus
  `encodeError: { class, code }`, meaning `encodeValue` of any secret
  value must throw that exact error. New kinds: `invocation` (valid
  round-trip plus bad-target/bad-arg-type/allowlist rejections), `json`
  (object/array/scalar rows plus number rejections), and `email`/`url`
  accept/reject rows for the validated string rules.
- `builtinCalls` — executable rows for every catalog builtin (34) and helper
  (23) with `availability: "implemented"`, keyed by catalog `id`. Each row is
  `{ id, args, expected }` or `{ id, args, expectedError }`, where `args` is
  the exact positional argument list the JS function takes. See "Argument
  specs" below for the encodings. `expectedError` is
  `{ class: "ValueError", code }` with a `ValueFailureCode`, or
  `{ class: "SchemaError", codes? }` with an ordered violation-code list.
  New kinds: `choose` (true/false selection plus a non-boolean error row),
  `invocation` (packaging plus a bad-target error row), `divideDurationMs`
  (duration/duration ratio plus division-by-zero), and an M1 `sum` order
  pair (reversed money domains pinning order-independent totals).
- `operationSamples` — one realistic descriptor pair plus cases:
  - `schema`: contracts (`TodoForm` with bounds, defaults, a `trim`med
    title and a `text[]!` required-array field; `BoundedList` with a
    `min: 1` array for omitted-bound cases), enums (`TodoStatus`),
    operations (query `listTodos`, mutation `completeTodo`). Nominals
    outside contracts/enums are model references (here `Todo`);
    `operation_id` is required for mutations and rejected for queries.
  - `valueCases`: `{ typeId, mode, wire, expected | expectedViolations }`
    for `validateValue`. New kinds: a padded-title case pinning `trim`
    normalization, and `BoundedList` cases pinning fail-closed omitted
    bounds (omitted `min: 1` array fails; explicit `["a"]` passes).
  - `inputCases`: `{ op, args, expected | expectedViolations }` for
    `validateOperationInput`.
  - Schema failures are violation-code lists only. BDD rule: a `SchemaError`
    NEVER satisfies an `error(code)` business rejection — `SchemaError`
    carries `violations` and has no business `code` field.

## Argument and expectation specs

Exact scalars are JSON-hostile (bigint, decimal, money, instants), so rows
use a small spec language decoded with the producer:

- `{ "$t": typeId, "$w": wire }` — `decodeValue(typeId, wire)`.
- `{ "$bigint": "123" }` — an unchecked `BigInt` (for out-of-range inputs
  that no decoder can produce, e.g. `int64` overflow).
- `{ "$fn": name, "arg"? }` — a predicate/key function for `any`/`all`/
  `group`: `gt`/`lt`/`eq` against the decoded `arg` (bigint or string
  operands), or `identity`.
- `{ "$message": { source, variants, params? } }` — `makeMessageDescriptor`;
  param values are `{"type", "value"}` pairs with `value` a spec.
- `{ "$omitted": true }` — the `UPDATE_OMITTED` sentinel (update-mode
  expectations only).
- Arrays recurse elementwise; plain objects recurse per key (covers `format`
  value objects, `action` bindings, nested domains like `flatten` inputs);
  every other JSON scalar passes through untouched (covers `text`/`bool`
  arguments, `round` scales, `sum` element tags, `equalValue` type ids,
  `formatMessage` option objects).

Expectations reuse the same language:

- `{ "$t": typeId, "$w": wire }` — `encodeValue(typeId, actual)` must
  deep-equal `wire` (the ReportValue wire-observation form).
- `{ "$value": spec }` — the decoded spec must deep-equal the actual value
  (for results with no wire type, e.g. `group` rows, validated arguments).
- `{ "$raw": json }` — direct deep equality (plain-JS results: `compare*`
  numbers, `formatMessage` `{ text, locale }`).

## Versioning

- Additive changes (new rows, new sections, new optional keys) bump
  `meta.version` by one (minor). Runners ignore unknown sections/keys.
- Breaking changes (row renames, removed sections, changed semantics) are a
  new major: copy this directory to `v2/`, bump `meta.version`, and note the
  migration in the new README. Never edit a published version in place.

## Wire-form reference

The pinned encodings live in `packages/values/src/wire.ts` (header comment
is normative for this package; `CanValue`/`WireValue` shapes in
`packages/contracts/src/values.ts`). This README does not copy them.

## How B1/B2 legs consume this

1. Import `values.json` (committed file; no build step).
2. Decode arguments with `decodeValue` from `@canlang/values` (dist), never
   with local copies of the codec.
3. Compare observations as wire forms (see below), or decode `$value`
   expectations and compare structurally.

## ReportValue rule

`ReportValue` observations of exact values MUST use this wire encoding now
that it has landed (`packages/contracts/src/examples.ts`): bigints as
canonical decimal strings, money as `{ minor, currency }`, datetimes as
pinned RFC 3339 millis, and so on. Until a leg can produce that form, its
row reports `unsupported` rather than coercing through `Number`.
