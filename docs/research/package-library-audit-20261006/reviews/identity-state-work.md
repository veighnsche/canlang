# Identity, state and work library audit

Planning source review at `309644a6881909d8dba32560bc6711f67e00a7ab`. No runtime reproduction, source change, build or test. Source locations below are repository-relative.

## Identity codecs and comparison

`packages/identity/src/sessions/tokens.ts:16–69` hand-rolls base64url and hex. At line 65 `parseInt(pair, 16)` rejects only NaN; the static counterexample `'0g'` parses as zero, making `timingSafeEqualHex('0g', '00')` true by inspection. Search found this exported hex comparator in tests but no production caller; do not report a proven authentication bypass. `timingSafeEqualText` is used by CSRF and OAuth PKCE.

Propose [@scure/base](https://github.com/paulmillr/scure-base) hex/base64urlnopad under existing helpers. It rejects unknown characters and noncanonical padding bits. The current base64 decoder permits unused nonzero bits, so explicitly decide tightened malformed-input admission rather than claiming universal parity. Preserve valid stored hashes/password salts/tokens, uppercase/lowercase hex equivalence, no padding, empty/null/error policy and UTF-8 treatment. Compare every boundary length, full byte range, invalid-prefix/suffix pairs, noncanonical tail bits and actual stored password verification before retirement.

Lines 87–107 claim constant-time comparison from a JS XOR loop. Source shape is not a guarantee about JIT execution. Evaluate a host adapter around [Node timingSafeEqual](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b) and Workers' [nonstandard WebCrypto primitive](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/). Precheck buffer lengths and qualify the same sync/public host entry and deployed import closure. Do not import node:crypto into a portable entry without the owning host contract; surrounding validation remains outside the timing guarantee. Existing SHA-256, random bytes and PBKDF2 already use WebCrypto, so no new crypto algorithm library is proposed. Password-cost/host qualification remains independent; this audit makes no current production PBKDF2-cap claim.

## Cookie grammar

`packages/identity/src/sessions/cookies.ts:20,42,54` concatenate attributes and split the Cookie header. Optional Domain is inserted without validation at lines 34/46; current HTTP auth caller passes secure/maxAge, not attacker-derived Domain. This source finding is not a demonstrated live response injection.

Propose [jshttp/cookie](https://github.com/jshttp/cookie) mechanics behind the existing helpers. Current maintainer README uses `parseCookie` / `stringifySetCookie`; pin the chosen version rather than assuming historical API names. Default decode retains original input after decode failure, unlike Can's null result. A decoder returning undefined could let a later duplicate win; preserve the first matching cookie's malformed/empty failure. Keep exact Secure/HttpOnly/SameSite=Lax/Path/Max-Age semantics, clear-cookie behavior, multiple-header combination and local insecure opt-in. Reject invalid Domain/control characters before header creation and map errors into IdentityError. Byte-order changes need explicit acceptance, not an accidental snapshot update.

## Stable hashes are identity contracts

`packages/state/src/invocation/replay.ts:20–62` sorts keys and fails closed on undefined/functions/symbols/bigint/nonfinite numbers and symbol keys; array holes reject. `hashInputs:65` hashes these bytes with WebCrypto. The production admission caller is `state/src/invocation/admission.ts`; this is persisted replay identity, not an incidental pretty-printer.

Inspected [canonicalize source](https://github.com/erdtman/canonicalize/blob/master/lib/canonicalize.js) omits unsafe object members, maps certain array values to null, rejects lone surrogates and handles boxed primitives differently. It is not a drop-in, even where ordinary sorted JSON matches. Can presently delegates toJSON then recurses; no cycle/depth budget is visible in this helper, so future admission review should include cyclic/deep inputs and error mapping. Do not silently normalize inputs before hashing or change persisted identity. Consolidating copies in CSV/export/media also requires each owning domain's exact bytes/admission to be pinned.

`state/src/internal/json.ts` already uses native structuredClone plus JSON suitability checks. Projection's exotic-reference/depth policy differs; replacing it with structuredClone would change behavior. Keep transaction version checks, receipt expiry/revocation/fences, durable ownership and storage failure mapping custom; a generic ORM cannot supply their acceptance.

## Work and remaining library seams

Work dispatch/claim/observer/receipt ordering, revocation, call-local identity and finite fanout are Can semantics. Keep the pure decisions and small opaque-reference tables; do not introduce XState/BullMQ/Tokio to replace finite synchronous mechanics without a new requirement and evidence. UTC schedule slots already use standard Date/crypto primitives; optional scheduling remains outside the selected port programme.

Work's Rust number-text and URI-encoding mechanics are covered by the separate native/delivery review. Those decision sources are not compiled by the current version-only Cargo root; fix and qualify them before assembly rather than infer deployed Rust execution. The values core already uses maintained bigint arithmetic; retain its checking/rounding policy. These distinctions preserve one arithmetic-validation core and one global delivery owner.
