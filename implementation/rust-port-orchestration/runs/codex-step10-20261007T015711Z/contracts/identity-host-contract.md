# I01 host comparison profile — released for root acceptance / I03

Base 295908144f14a070ac5f62122d1d0d982ea47c89. Product read-only; this releases a concrete binding policy and private evidence, not installed implementation acceptance. Human preparation/native-release HOLD unchanged. I03 waits for I02 tokens.ts release. Cookie and encoding releases do not wait for I03 delivery.

## Selected policy

Keep Node >=22, synchronous token comparison exports and async password APIs. Bind one internal byte comparator via the package-private import `#identity-byte-compare` with node/default conditions. Node leaf statically imports node:crypto.timingSafeEqual; default Worker leaf calls crypto.subtle.timingSafeEqual with its original subtle receiver. The neutral comparison wrapper imports only the private specifier. No static Node builtin import occurs in the neutral or Worker closure; no async import, top-level await, mutable global provider, process monkeypatch or user initialization step is needed.

Reject mismatched byte lengths with false before calling either primitive. Equal zero-length bytes compare true. Preserve UTF-8 TextEncoder semantics, including lone-surrogate replacement; strict malformed/empty hex remains false from I02. All decoded length and parse branches remain outside any native primitive timing claim. Do not describe whole helpers, authentication or password verification as constant-time. Node documentation explicitly limits its guarantee to the primitive; no JS/JIT loop guarantee is asserted.

Node leaf exports nativeCompare(a: Uint8Array,b: Uint8Array): boolean using Node timingSafeEqual. Worker leaf feature-checks globalThis.crypto?.subtle.timingSafeEqual and throws Error with fixed message `Identity host does not provide a native timing-safe comparison.` when absent, then invokes it as a method on subtle. No fallback to XOR, ordinary string equality or HMAC inventions. Node unsupported import fails visibly. The common wrapper checks byteLength then delegates. Native exceptions propagate as operational faults; malformed public hex and length mismatch stay false. Password verifier continues returning false for malformed encoding and derivation errors, but invokes comparison outside its existing deriveKey catch so missing native host support does not silently become wrong-password false. This is an explicit operational-error distinction for an unsupported host.

## Finite implementation and root join

I03 writer files:
- packages/identity/src/sessions/comparison.ts (new shared length guard; exports internal timingSafeEqualBytes)
- packages/identity/src/sessions/comparison-node.ts (new nativeCompare Node leaf)
- packages/identity/src/sessions/comparison-worker.ts (new nativeCompare Worker leaf)
- packages/identity/src/sessions/tokens.ts (replace both byte loops; preserve I02 codecs)
- packages/identity/src/accounts/passwords.ts (replace derived-key loop; keep derivation catch boundary)
- packages/identity/test/sessions.test.ts and packages/identity/test/accounts.test.ts
- packages/identity/test/comparison.test.ts (new finite primitive boundary/unsupported-host controls)

Root manifest request, no new npm dependency for comparison: add imports `#identity-byte-compare: { node: ./dist/src/sessions/comparison-node.js, default: ./dist/src/sessions/comparison-worker.js }` in that order to packages/identity/package.json. TypeScript NodeNext/rootDir/outDir resolution must be verified against this exact import map, including direct emitted tests. Keep package engines >=22. Do not export these implementation leaf files as public API or globally switch conditions.

Root delivery files: packages/cloudflare/src/deploy/bundle.ts and packages/cloudflare/test/deploy-bundle.test.ts. Existing readVendorTree recursively vendors all identity dist/src JS; therefore explicitly exclude the exact production Node leaf `vendor/identity/sessions/comparison-node.js` (do not mislabel it a test-only exclusion). In owned identity vendor modules rewrite exactly #identity-byte-compare to module-relative `vendor/identity/sessions/comparison-worker.js`. Do not broadly resolve arbitrary private imports or weaken bare-import/Node-builtin refusal. Include Worker leaf and neutral wrapper in inventory. Browser bundle HTTP/MCP producers with default/Worker binding and independently prove selected leaf; raw module-tree staging and browser bundling are separate closures. Root may use producer-owned inventory metadata instead of a hardcoded exclusion only if it explicitly expands/reviews the finite delivery scope; this contract does not authorize broad refactoring.

Root owns package manifest/lock/distribution closure and accepted DECISIONS.md entry. I02 @scure/base and I04 cookie closure requests remain separate. No host-floor change or nodejs_compat flag is introduced.

## Verified private recipe and limits

identity-host-witnesses.json: native wrapper in Node v24.21.0 and actual installed Miniflare4.20260730.0/workerd, compatibilityDate2026-07-15, no compatibility flags. Equal/different/length/empty/nonzero-offset typed-array slices agree. Neutral private import resolves Node leaf under Node; Worker recipe rewrites the private specifier to Worker leaf and excludes Node leaf, matching the required root delivery action.

identity-host-callers-witnesses.json: private copies of current tokens/passwords/CSRF modules with only three XOR loops replaced exercise text/hex APIs, UTF-8 length and surrogate behavior, canonical and noncanonical synthetic stored PBKDF2 at600000 iterations, wrong passwords, CSRF valid/invalid, issued token/digest and distinct bearer alias hashes. Node24/workerd results agree. These caller probes deliberately retain old byte codec source, so strict-hex correction is qualified separately by I02; they do not claim combined product acceptance or actual OAuth exchange coverage.

Probe scripts are saved as identity-*-probe.mjs; private extracted candidates and generated JS remain under the authorized scratch identity root. Recreate extraction from exact tarballs and verify identity-dependencies.json before rerunning. Probes use read-only existing TS and Miniflare dependencies; no shared install. Initial Miniflare attempt was blocked by sandbox loopback permissions; approved run succeeded. First full-caller harness put the Worker entry last and failed routing; corrected to first entry and reran successfully. Neither failure is a product failure. Node22 executable was not found locally during this investigation; private Node24 proof must not be reported as Node22 qualification.

## Independent acceptance gates

1. Build/typecheck exact identity package with the private imports map and no fallback. Import actual emitted public package under Node22 (including earliest supported22.0 if full >=22 support is claimed), run public sync text/hex comparisons and async password/CSRF/OAuth paths. Verify true/false/errors plus Promise-vs-boolean shape.
2. Check missing Worker primitive throws the fixed operational Error for equal-length operands; unequal lengths and malformed public hex retain false. Check primitive method receiver, byte-offset views, exact byte lengths and empty operands. Test wrong passwords, malformed records and simulated derivation failure remain false; comparator failure must reject password verification rather than return false.
3. Run root's actual installed identity + HTTP/MCP deployed bundle with Node leaf absent, no surviving #identity-byte-compare or bare builtin import, all codec/cookie producer entries present. Execute real workerd whole-call session/password/CSRF/PKCE/OAuth behavior, not just the synthetic primitive. Compare exact issued/stored digests and frozen error/serialization contracts.
4. Record delivered source/inventory hashes, Node/workerd versions/date/flags and any remaining scope gate. Missing Node22 or installed closure leaves I03 qualification open even after source implementation passes.

## JEV advice and uncertainty

Three independently worded equivalent verified-context requests used tools/jev.py; no credentials or actual stored secrets entered payloads. Full requests/responses are identity-jev-request-{1,2,3}.json and identity-jev-response-{1,2,3}.json. Model jev-1.13.0 unanimously selects conditional_native over an explicit22.3 floor or retaining loops/holding I03. Host confidence is only .32/.34/.29, with selection probabilities .55/.56/.52 and hold probabilities .32/.31/.33. No disagreement was hidden; low confidence reflects actual integration cost. Inspected delivery source confirms both required actions (whole-tree exclusion and owned private-import rewrite), and private whole-caller workerd proof reduces primitive feasibility uncertainty. Actual installed/Node22 correctness remains a gate. Advice does not substitute for the root's acceptance or critical review.

Alternative assessment: process.getBuiltinModule is simpler and avoids a static import but starts22.3, contradicting unchanged >=22 support. Static node:crypto in neutral source violates Worker closure. Mutable injected providers create initialization/copy-order hazards. Conditional private leaf binding preserves existing caller APIs and Node range at the cost of finite manifest/delivery changes. If those changes cannot be qualified, hold I03 visibly rather than silently fall back to JS loops.

Primary sources fetched2026-10-07: https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b ; https://nodejs.org/api/process.html#processgetbuiltinmoduleid ; https://nodejs.org/api/packages.html#subpath-imports ; https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#timingsafeequal . Miniflare package4.20260730.0 and actual recipes are locally observed; documentation alone is not target proof.
