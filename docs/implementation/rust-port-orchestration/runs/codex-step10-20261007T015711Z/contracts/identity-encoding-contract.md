# I01 encoding profile — released for root acceptance / I02

Base 295908144f14a070ac5f62122d1d0d982ea47c89. Product read-only. Human preparation/native-release HOLD unchanged. Source hashes: identity-cookie-witnesses.json; candidate metadata/hashes: identity-dependencies.json; independently generated/frozen synthetic expected values: identity-encoding-witnesses.json. No real credential was inspected.

## Exact dependency and finite files

Root request: exact runtime dependency `@scure/base: 2.4.0` in packages/identity/package.json, central lock and portable delivered closure. ESM main/module index.js, types index.d.ts, no exports restriction, MIT, no runtime dependencies or declared engines. Use named `base64urlnopad` and `hex`; do not use padded base64url or uppercase-only base16.

I02 writer files: packages/identity/src/sessions/tokens.ts, packages/identity/test/sessions.test.ts and packages/identity/test/accounts.test.ts. No password source change needed for this compatibility policy. Root handles manifests/lock/delivery and accepted decision recording. I03 must wait for I02 same-file release; cookie may proceed independently.

## Frozen encoding choices

Replace bytes-to-unpadded-base64url and bytes-to-lowercase-hex mechanics with the library. Preserve empty bytes encoding to empty text, every issued token text, SHA-256 bytes and lowercase digest text. Hash bearer UTF-8 text exactly as presented; never decode/re-encode or tail-mask bearer input before lookup, CSRF or PKCE hashing. Source lookup path is context.ts session/grant find-by-hash and oauth.ts auth-code lookup. Alias texts Zg and Zh have different frozen SHA-256 digests even though stored-field byte decoding aliases them.

Public base64UrlToBytes keeps its existing acceptance set, including nonzero unused tail bits. Empty input, length mod4=1, padding '=', non-URL alphabet, all whitespace and non-ASCII remain null. Before strict library decoding, validate the complete nonempty URL alphabet; for length mod4=2 replace only the final sextet with its alphabet index masked by 0x30; for mod4=3 mask by 0x3c; mod4=0 is unchanged. Delegate all byte conversion to base64urlnopad.decode and map exceptions to null. The sole final-character compatibility mask is deliberate; retain no handwritten multi-byte codec, loop, or secondary decoder. The mask applies only to this byte-decoder contract, never bearer text processing.

Rationale: existing password verifier accepts these aliases, D1 stores password_hash verbatim and its public store interface accepts encoded strings, while built-in registration/recovery issue canonical strings. There is no evidence of an actual persisted noncanonical row, and none is presumed. Preserving the current admitted decode domain avoids an unmeasured stored/API break without retaining the bulk codec. The alternative of strict-everywhere can reject formerly verifiable stored strings; password-only compatibility adds separate public/private policies. All three JEV calls prefer preserve_public_tails with confidence .95/.96/.96; advice agrees but is not implementation acceptance (full requests/responses saved).

Hex is a deliberate malformed-input correction. hex.decode must accept upper/lower mixed case but reject partial prefixes, signs, whitespace, empty, odd length, unknown characters, and 0x prefix. Keep empty explicit guard and map codec exceptions to null/false. timingSafeEqualHex malformed or unequal decoded byte lengths returns false. Existing parseInt accepts examples such as 0g and signed/whitespace pairs; fixing this is the documented helper contract, not evidence of a login bypass. Repository non-test callers use text comparisons for CSRF/PKCE; no internal timingSafeEqualHex caller was found.

Preserve synchronous codec/comparison signatures, async digest/issuance, TextEncoder behavior including replacement of lone JS surrogates, WebCrypto digest/random authority, OPAQUE_TOKEN_BYTES=32. I02 retains comparison mechanics until I03's separately accepted host contract, but remove inaccurate blanket source-loop constant-time claims when touched.

## Persisted password and consumer evidence

hashPassword emits `pbkdf2-sha256$600000$<16-byte salt>$<32-byte key>` using canonical unpadded strings. parseEncoding requires four fields, exact algorithm, positive integer numeric iterations <=10,000,000, decoded salt/key lengths 16/32; preserve iteration Number() acceptance, its existing fault order and verifier derivation-error false behavior. Do not add unrelated password policy, iteration normalization or storage migration.

Frozen synthetic PBKDF2 uses password `synthetic-contract-password` and salt bytes 0..15, computed independently through node:crypto.pbkdf2Sync. Canonical and maximal ignored-tail salt/key aliases both verify in old source; wrong password fails. These are synthetic fixtures, not credentials. Frozen issuance uses bytes 0..31 and a Node crypto SHA-256 text oracle. 16,448 old decoder/candidate alias cases (length1..257, all64 final characters) agree. This qualifies the narrow adapter on Node24, not product implementation or all deployed hosts.

## Independent acceptance recipe

Use frozen exact issued token and digest, canonical and noncanonical stored password strings, empty/invalid vectors and hex correction rows. Implement tests with fixed expected bytes, not only roundtrips. Exhaustive one-byte inputs, finite seeded multibyte vectors and all final sextets must agree; test aliases in salt only/key only/both, wrong password, malformed alphabet/length/padding and wrong decoded sizes. Keep current session/account/CSRF/PKCE suites and hash exact bearer aliases separately. Build/typecheck actual package and verify actual generated Node22/workerd entry/consumer closure through root delivery before claiming host/installed acceptance. Library docs and this private probe do not close I02 implementation.

Primary sources fetched 2026-10-07: https://registry.npmjs.org/@scure/base/latest ; https://registry.npmjs.org/@scure/base/-/base-2.4.0.tgz ; https://github.com/paulmillr/scure-base ; https://raw.githubusercontent.com/paulmillr/scure-base/main/index.ts . Decisions use extracted2.4.0 hashes rather than mutable main.
