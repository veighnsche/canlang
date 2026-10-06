# V03.1 — Validation ABI extension decisions

Task: V03.1 "Define validation ABI extension and decision vectors"
(lane `V-input`, wave 2, after `V01` + `C03.ready` + `A03.foundation`).
Planning record only; no implementation authorized. Companion files:
`abi-vectors.json` (this leaf's decision-vector corpus, same directory)
and `packages/values/conformance/owned-input/v1/{cases.json,README.md}`
(the frozen runner-facing subset V03.2/V03.3 import).

- Planning base: main `1b6818d` (incl. B4 `a9476a4`).
- Base contract: `evidence/implementation/shared/transport-contracts.json`
  (C03.1, transport v0: ordered tagged nodes, explicit presence,
  profile ids, request tokens, result/error envelopes). This leaf
  EXTENDS v0 for the validation profiles; it redefines nothing the
  base contract owns (scalar meaning stays values-owned, catalogs
  producer-owned).
- Profile obligations: `evidence/input-validation/contracts.md`
  (`values/v1`, `http-input/v1`, `mcp-ordinary/v1`,
  `state-generated/v1`, `legacy-ts`) and `current-ts.json` (frozen
  surfaces + baseline obligations). Host JSON parsing is retained
  initially: body caps, syntax/error behavior, and JS number parsing
  are host stages; the arena never re-parses text.

## D1 — f64 crosses as exact bits, never as decimal text

Host `JSON.parse` numeric outcomes are the transport input: `-0`,
rounded huge integers, and `1e400`-style overflow `Infinity` cross as
their IEEE-754 bits (`8000000000000000`, `4340000000000000` for
`9007199254740993`, `7ff0000000000000`). Decimal rendering is FORBIDDEN
as a transport observation: `JSON.stringify(-0)` is `"0"` and
`JSON.stringify(Infinity)` is `"null"`, so any decimal round-trip
pre-collapses exactly the distinctions the profiles must reject on.
Nonfinite and `-0` remain representable and reach the profile's
rejection stage; the transport never pre-collapses them (base contract
`scalars.f64`). `NaN` is unrepresentable from JSON text (no spelling
parses to it); a `NaN`-bits node is a corrupt frame, never a value.

## D2 — Text and keys cross as lossless UTF-16 code units

Text and keys cross as UTF-16 code units with JS enumeration order
(base contract `text.lossless_utf16`, `text.enumeration`):
integer-like keys ascending, then string keys in insertion order, with
`own __proto__` as data (never as prototype). Lone surrogates in keys
and text are preserved exactly; ordinary conversion to Rust `String`
(which can replace unpaired surrogates) is forbidden on the compat
path — V03.2 uses code-unit operations or a proved lossless route.
Duplicate JSON keys are preserved as data (entries arrays); the host
last-wins outcome is NOT the transport (profiles consume the entries
per their frozen rule). Control characters are data.

## D3 — Presence is five tags; JSON can only produce three

The transport carries the base contract's presence tags (`presence.rule`):
`missing`, `own-null`, `own-undefined`, `inherited`, `accessor`.
Absent-vs-undefined conflation is forbidden at the transport layer.
From JSON text only three arise: `missing` (key absent),
`own-null` (explicit `null`), and every other own value; `undefined`
has no JSON spelling, and `JSON.parse` creates own data properties
only (no inherited, no accessors). The `own-undefined`, `inherited`,
and `accessor` tags exist for host-carrier lineage (V03.3 controlled
derivatives), never for arena-from-JSON nodes: a transport that
invents them from JSON text is corrupt. Each profile interprets tags
per its frozen rule (values accumulation vs interfaces own-presence
vs state ref-version domains); the transport does not decide.

## D4 — Default tags carry fill identity, not just fill values

`default-applied` marks a value the registry default filled, carrying
the default's identity (registry + plan revision) so the values/v1
shared-default host-registry identity rule stays observable;
`default-absent` marks positions with no fill. Fills apply only to
`missing` positions per the profile rule — never over explicit
`own-null` (state "preserve explicit null") and never over present
values. Manufactured defaults from missing metadata are excluded
(`http-input/v1` exclusion); model-pipeline/emitted-callable defaults
stay legacy (`state-generated/v1` exclusion).

## D5 — Sentinels are minted, never parsed

The sentinel family carries profile control markers, starting with
`update-omitted` (update-mode omission, cf. `UPDATE_OMITTED` in
`packages/values/src/schema.ts`). Sentinels are minted by the
profile stage that owns them; caller JSON shaped like a sentinel
(`{"$sentinel": ...}`, `{"$omitted": true}`) is DATA, never a tag —
forged sentinels fail closed (negative corpus, contracts.md workload
5). Frozen proxies, schema tags, and mutated/exposed public copies
cannot enter owned execution (V03.3 acceptance); the transport tags
only what the lineage proves.

## D6 — Drops are explicit with paths

`dropped-unknown` marks positions the profile dropped (unknown-field
ignore), carrying the dropped path so runners observe the decision
rather than inferring it from absence. Drops apply only to unknown
positions per the profile rule — known positions are never dropped,
and unknown-argument (call-shape) vs unknown-field (value-shape)
keep their distinct verdicts (values/v1 obligation). First-unknown
reporting follows JS enumeration order (`Object.keys` order in
`checkClosedInputs`, `packages/interfaces/src/envelope/validate.ts`).

## D7 — Length checks run before coercion at four points

Fixed-width counts are validated before conversion (base contract
`corruption_rules`: never coerce-then-check). The validation profile
checks, in arena-build order: declared node count, depth, text
code-unit length (UTF-16 units — a surrogate pair counts 2, matching
JS `.length` and the `MAX_ID_LENGTH = 256` check in
`packages/interfaces/src/envelope/refs.ts`), and entries count.
Breaches reject with transport errors (stage `transport`, never a
semantic result) before any profile stage runs. NUMERIC BUDGETS ARE
NOT DECIDED HERE: the current hypotheses (1 MiB body cap excluded —
that cap is frozen in `limits.ts`; node/allocation/depth numbers)
are measured at V03 and fixed at V07 per `current-ts.json`; V11.1
precommits the budgets. This leaf pins the check points, order,
units, and error taxonomy only.

## D8 — Exclusions (must-hold, no fixture)

- The opaque `json` codec rejects every number: it is unsuitable as a
  generic request transport and is never used as one (base contract
  `transport_exclusions`; `current-ts.json` baseline obligation).
- Malformed JSON remains a host parse error at the host stage
  (V03.3 acceptance: byte caps, BOM, syntax errors match the current
  host stage). The arena never sees unparsed text.
- Number-free opaque blobs are never a substitute for
  scalar-carrying transport.

## Open review requests (required, not assumed)

Following the V01-review pattern, each decision above needs its
owner's review before the V03.2/V03.3 extraction that consumes it:
values owner (D1 scalar/bit meaning, D4 default identity, D5
sentinel shape), interfaces owner (D2 key order, D6 drop/unknown
order, D7 ID-length units), state owner (D3 presence interpretation,
D4 explicit-null), C03/shared-values owners (tag-table ownership,
versioning). No owner approval is assumed by this record.

## Tradeoffs considered (none hard; no JEV call)

- Bits-vs-decimal for f64 (D1): forced by the base contract and the
  `-0`/`Infinity` acceptance rows — decimal cannot carry them.
- Explicit drop tags vs silent drops (D6): explicit chosen so
  negative-corpus runners observe decisions; cost is one tag per
  dropped path, bounded by the entries cap (D7).
- Numeric budgets (D7): explicitly deferred to V03-measure/V07-fix
  per `current-ts.json`; no number is pinned here, so no budget
  tradeoff is taken.
- Sentinel vocabulary beyond `update-omitted`: left extensible
  (versioned addition); no second sentinel is needed by any V01
  obligation today.
