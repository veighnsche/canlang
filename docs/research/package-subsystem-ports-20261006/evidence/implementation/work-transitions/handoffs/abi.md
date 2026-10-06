# W03.1 — Frozen ordered facts + policy ABI handoff

Transport v0 per `evidence/implementation/shared/transport-contracts.json`
(C03.ready). Implemented in `packages/work-kernel/src/facts.ts` (pure:
no imports, no clock/RNG/evidence/host calls).

## Version / profile matrix

- Transport: `v0` only (`TRANSPORT_VERSION`). Unknown transport versions
  never fall through to a default; mismatch refuses before evaluation.
- Decision profiles (one selection per call/job, no mid-call switching):
  `wt.rows/v0`, `wt.policy/v0`, `wt.receipts/v0` (`DECISION_PROFILES`).
- Peers declare transport + profile up front (`VersionDeclaration`);
  `validateVersions` rejects unknown transport / unknown profile.
- Any incompatible change (ranges, text handling, strictness, digest
  bytes, hash inputs) is a versioned behavior decision with declared
  semantics + migration fixtures — never a silent parity change.

## Presence (explicit tags, profile-owned interpretation)

- Wire tags: `missing`, `own-null`, `own-undefined`, `inherited`,
  `accessor-backed` (`PRESENCE_TAGS`). Absent-vs-undefined conflation
  is forbidden at the transport layer.
- Interpretation is profile-owned per frozen rule:
  - `wt.rows/v0`: JSON-safety-traversal-then-clone inputs keep their
    traversal rule; clone-only-receiver inputs keep clone-only. The two
    input classes never share an interpretation.
  - `wt.policy/v0`, `wt.receipts/v0`: own-presence per each profile's
    frozen rule (fixed when W02.3/W02.4 land).

## UTF-16 text (lossless)

- Text/keys cross as lossless UTF-16 code units (`Utf16Text.units`).
- Lone surrogates (keys and text), controls, and own `__proto__` data
  preserved exactly; JS enumeration ordering preserved for keys
  (integer-like-key rules, own `__proto__` as data).
- Ordinary conversion to Rust String (can replace unpaired surrogates)
  is forbidden on the compat path — code-unit operations or an
  explicitly proved lossless route only.

## f64 (exact bits)

- IEEE-754 bits preserved exactly (`F64Bits` lo/hi): -0, nonfinite
  values, huge rounded JSON integers, 1e400-style overflow spellings.
- Host parser numeric outcomes remain representable and reach the
  profile's rejection stage; never pre-collapsed by transport.
- Numeric-looking strings/keys are text, never numbers; numeric-looking
  key order and duplicate JSON keys preserved exactly as data.

## Counts and ranges (validate before conversion)

- Declared lengths/counts ride as `RangedCount` (value + closed u32
  range); `validateCount` runs BEFORE any fixed-width conversion.
- Overflow rejects before coercion — never coerce-then-check.
- Non-integer and nonfinite counts reject: counts are exact.

## Conditional versions

- Stored revision/version pairs ride as `ConditionalVersion`
  (expectedRevision / observedRevision / version). Freshness is a host
  behavior; the fact carries the pair, never the verdict.

## Producer provenance

- Every ordered fact carries `FactProvenance`: producer
  (`ts-current` | `ts-prepared` | `wasm`) + source (fixture,
  observation, or corpus id). `ResultEnvelope` and `ErrorEnvelope`
  extend `OrderedFact` — provenance is structural, not advisory.

## Opaque payload refs (call-local, never capabilities)

- `PayloadRef` = (callToken, index); valid only within its originating
  call/session. `validatePayloadRef` rejects cross-call and stale
  indices against the call's live set.
- Opaque refs are not authority capabilities; number-free opaque blobs
  are never a substitute for scalar-carrying transport.

## Envelopes

- Result: profile id, request token, presence-explicit payload,
  completion stage (`preview` | `confirmed`). Preview/confirmed and
  prepared/failed states explicit; no per-leaf IPC or semantic TS
  retry inside one call.
- Error: profile, machine-readable code, ordered reasons/details,
  failure stage (`transport` | `semantic`). Transport errors
  (version/length/corruption/lifetime) distinguishable from semantic
  errors (validation/policy refusal); a started native failure never
  falls through to TS.

## Rejection order (transport before semantic)

1. Foreign/version/profile/corrupt facts reject before any semantic
   callback: `foreign-fact`, `unknown-transport-version`,
   `unknown-profile`, `profile-mismatch`.
2. Frame/length corruption rejects deterministically with a transport
   error, never a semantic result: `bad-declared-length`,
   `truncated-frame`, `oversized-frame`, `short-frame`,
   `count-overflow`. EOF/abort mid-request releases the call allocation.
3. Lifetime/token violations reject at the current stage:
   `stale-ref`, `foreign-ref`, `cross-call-ref`, `token-mismatch`,
   `token-replay`. Cancellation fails deterministically.
4. Serde/metadata renderers are never the compatibility authority:
   serde JSON errors do not substitute for host syntax diagnostics,
   and generic serializer output is not parity evidence.

## Exclusions (from C03)

- Can's opaque json codec rejects every number: unsuitable as a
  generic request transport, never used as one.
- Host JSON parsing stays initially to preserve syntax diagnostics
  and number parsing; malformed JSON remains a host parse error at
  the host stage.
