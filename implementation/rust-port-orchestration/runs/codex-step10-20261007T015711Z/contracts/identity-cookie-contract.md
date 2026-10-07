# I01 cookie profile — released for root acceptance / I04

Base: 295908144f14a070ac5f62122d1d0d982ea47c89. Read-only product investigation; no implementation acceptance. Human preparation/native-release HOLD unchanged. Source SHA-256 values and frozen synthetic observations: identity-cookie-witnesses.json. Candidate metadata, tarball integrity verification and file hashes: identity-dependencies.json. Private extraction only; no installation.

## Dependency and finite files

Root request: add exact runtime dependency `cookie: 2.0.1` to packages/identity/package.json and resolve central lock/delivery closure. ESM public entry `cookie` -> dist/index.js, MIT, Node >=22, zero runtime dependencies; shipped declarations dist/index.d.ts. APIs are parseCookie and stringifySetCookie (not assumed historical parse/serialize names).

I04 writer files: packages/identity/src/sessions/cookies.ts and packages/identity/test/sessions.test.ts only. Root owns manifests/lock/delivery; record accepted decision in docs/specification/DECISIONS.md through its owner. No token/password/host dependency is required.

## Parsing — preserve all existing target behavior

Join readonly header arrays with `; ` in caller order; undefined returns null. Call parseCookie exactly once with identity decode (`s => s`), which retains each raw name's first occurrence, including empty/malformed values. Iterate Object.entries of that parsed result in insertion order, selecting the first key whose JS trim() equals can_session. Trim that raw value with JS trim(), then decodeURIComponent exactly once. Empty raw/decoded text or decoding failure returns null immediately. Never fall through to a later duplicate. Do not decode unrelated cookies.

This is library grammar plus target selection, not a second input scanner. It preserves wide JS whitespace around name/value without normalizing the header or token interior. Normalized matching names cannot be array-index keys, so JS integer-key enumeration does not disturb their relative order. Raw-name deduplication retains the earliest member of each name group; selecting the first normalized matching group therefore preserves the first target occurrence. Existing quotes are literal, not unwrapped; semicolons still delimit even inside quotes. Percent-encoded whitespace is not trimmed after decoding. Null-prototype library output avoids prototype names interfering. Never use the library's default tolerant decode or return undefined for malformed/empty targets.

Twenty executed old-source/candidate synthetic vectors agree, including malformed/empty first duplicates, arrays, unrelated malformed cookies, once-only percent decode, encoded delimiters, quote behavior, wide trim and prototype key. Test the full JS trim whitespace set and mixed raw-name duplicates in implementation qualification.

## Serialization — exact existing order and defaults

Preserve public signatures and set validation precedence: empty token => IdentityError(validation, Cannot set an empty session cookie.); noninteger/nonpositive Max-Age => IdentityError(validation, Session cookie needs a positive Max-Age.). Preserve encodeURIComponent explicitly, including existing URIError on lone surrogate token; encode before Domain validation so error precedence stays stable. Secure defaults true for both set and clear, explicit false omits it. Clear emits empty value and Max-Age=0; set preserves every accepted positive integer including values above MAX_SAFE_INTEGER. No Expires, Priority, Partitioned or new policy.

Use stringifySetCookie for encoding/attribute grammar/Domain validation. Preserve old exact order: `can_session=<encoded>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<n>[; Secure][; Domain=<domain>]`. Because pinned library emits value, Max-Age, optional Domain, Path, HttpOnly, optional Secure, SameSite, a bounded reorder of its generated `; `-separated segments is permitted. Reorder only this library-produced string with these fixed options; do not parse request headers or duplicate cookie grammar. All token semicolons are percent encoded and validated Domain excludes separators, so generated segment boundaries are unambiguous. One serialization call suffices.

## Deliberate correction: Domain

Omitted Domain remains omitted; valid domain case and optional leading dot remain byte-identical. Explicit empty Domain now throws IdentityError(validation, Session cookie Domain is invalid.) instead of emitting Domain=. Invalid nonempty domain is rejected by the library and mapped to that same fixed IdentityError, without reflecting raw input. Reject controls (including CR/LF/NUL/DEL), semicolon and other separators, whitespace, underscore, colon, trailing dot, non-ASCII and overlong labels; accept library-approved localhost, ordinary domains, punycode, leading dot and case. Do not lowercase, trim or reinterpret Domain. The empty guard closes library falsy omission; all other Domain grammar belongs to the library. Preserve token/maxAge/encoding errors before Domain errors. This fixes an unsafe public helper contract; inspected HTTP auth callers supply secure/maxAge but no Domain, so no live header injection is alleged.

## Independent acceptance recipe

Run frozen witness inputs against actual changed helpers; compare preserved outputs with frozen values, not a newly recomputed implementation oracle. Add exact set/clear string tests for secure omitted/true/false, URI token characters, Domain absent/leading dot/case/empty and invalid controls/separators. Check complete IdentityError name/code/message/field, old token/maxAge faults and URIError precedence. Verify login/logout consumers packages/interfaces/src/http/auth.ts and package unit suite, package typecheck/build, then root's installed producer/Worker delivery closure. Candidate probe ran on Node v24.21.0; it is evidence of mechanics only, not Node22 or installed/workerd acceptance. Root must qualify actual Node22 and workerd delivery before claiming that scope.

Primary sources fetched 2026-10-07: https://registry.npmjs.org/cookie/latest ; https://registry.npmjs.org/cookie/-/cookie-2.0.1.tgz ; https://github.com/jshttp/cookie ; https://raw.githubusercontent.com/jshttp/cookie/master/src/index.ts . Released decisions are tied to extracted 2.0.1 hashes rather than mutable master.
