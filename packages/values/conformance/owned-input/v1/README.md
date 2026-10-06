# Owned-input conformance fixtures v1

Versioned consumer fixtures for the V03.2 ordered input transport arena
and the V03.3 private parser token (validation ABI extension v1 over
transport v0). V03.2/V03.3 import `cases.json` and execute it through
the host parser plus the arena — never by re-implementing JSON parsing
or the tag decisions. Full decision record (42 vectors with rationale):
`docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-vectors.json`;
normative extension prose:
`docs/research/package-subsystem-ports-20261006/evidence/input-validation/abi-decisions.md`
(D1–D8).

## Sections

- `meta` — `{ version: 1, transportVersion: "v0", extensionVersion: 1,
  abiVectors, decisions }`. `version` is this fixture's own version
  (see Versioning); the transport/extension pair names the ABI it pins.
- `transportCases` — 23 accept rows (f64/text/keys/kinds/order areas). Each
  row is `{ id, area, harness: "future-arena", rule, input, expect }`.
  `input` is either `{ source }` (JSON text: the runner parses it with
  the host `JSON.parse`, checks `expect.host`, then feeds the parsed
  value to the arena) or `{ entries, shape? }` (pre-parsed entries for
  order/closedness decisions, no host stage). `expect.host` carries
  host truth (`$f64` bits, `$text` units, `entries` order) and is
  OMITTED on rows whose decision is order/profile-level rather than
  host-observation-level: `order/*` rows expect `consumedOrder`,
  `firstUnknown`/`order`, or `profiles` + `transport` instead (see
  note). Otherwise the runner checks `expect.host`, then the arena
  decision in `expect.transport` (the tag decision).
- `tagCases` — 8 presence/tag rows (missing vs null, defaults,
  sentinels, drops). `expect.transport` carries `$tag` nodes; rows
  with `ok: false` are transport rejections, never semantic results.
- `lengthCases` — 5 check-point rows (ID code-unit bound, node/depth
  checks, empty-text accept). Breaches reject at stage `transport`
  with `length/*` codes before any profile stage runs. Numeric budgets
  are hypotheses, not pins (see abi-decisions.md#D7); only the frozen
  `MAX_ID_LENGTH = 256` units check carries a number.
- `exclusionCases` — 6 `must-hold` declarations (no executable
  fixture): opaque-json exclusion, host-parse-errors-stay-host,
  no-coerce-then-check, and the three never-from-JSON presence
  invariants. Cited as negative-evidence requirements by V03.2+ gates.

## Row specs

- `{ "$f64": "<16 hex>" }` — exact IEEE-754 bits. Decimal rendering is
  forbidden as an observation (`-0` renders `"0"`, `Infinity` renders
  `"null"`).
- `{ "$text": s, "units": n }` — a JS string of `n` UTF-16 code units
  (lone surrogates as `\u` escapes; a surrogate pair counts 2).
- `entries: [[key, value], ...]` — ordered object entries; carries key
  order and duplicate keys, which JSON objects cannot.
- `{ "$tag": name, ... }` — a transport tag node (`f64`, `text`,
  `bool`, `array`, `entries`, `object`, presence tags,
  `default-applied/absent`, `update-omitted`, `dropped-unknown`).
- `{ "ok": false, "stage": "transport", "code", "check"? }` — a
  transport rejection. `ok: true` rows may carry observation extras
  (`units`, `renders`, `consumedOrder`, `profiles`).

Note — the 3 `order/*` rows: `order/http-first-unknown-enumeration`
takes `{ entries, shape }` input (first-unknown decision over
pre-parsed entries, no host stage);
`order/integer-key-order-consumed` takes `{ source }` but expects
`consumedOrder` only (the arena order the profile consumes);
`order/version-domain-split` takes `{ source }` and expects
`profiles` + `transport` (the split verdict; host truth is the plain
text `"007"`, pinned implicitly by the transport text node).

## Versioning

- Additive changes (new rows, new sections, new optional keys) bump
  `meta.version` by one (minor). Runners ignore unknown sections/keys.
- Breaking changes (row renames, removed sections, changed semantics)
  are a new major: copy this directory to `v2/`, bump `meta.version`,
  and note the migration in the new README. Never edit a published
  version in place.

## How V03.2/V03.3 consume this

1. Import `cases.json` (committed file; no build step).
2. Parse every `input.source` with the host `JSON.parse` (caps,
   diagnostics, and number parsing stay host stages) — never with a
   re-implemented parser.
3. Check `expect.host` first (pins the host truth the arena receives),
   then build the arena node and check `expect.transport`.
4. Report tag decisions as tags. Until a runner can produce a tag, its
   row reports `unsupported` rather than coercing through a guessed
   shape.

## Transport-observation rule

`expect.transport` observations MUST use the tag vocabulary now that
it has landed: f64 as bits, text with unit counts, objects as
`entries`, presence/defaults/sentinels/drops as `$tag` nodes. Decimal
numbers, coerced strings, and key-ordered plain objects are never
valid observations — they pre-collapse exactly the distinctions the
vectors exist to pin.
