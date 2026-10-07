# I03 independent critical review — source accepted; delivery gate open

2026-10-07. Scope: Astra high review of actual identity implementation against frozen I01 native-comparison/encoding policy. Product read-only. No implementation or JEV conclusion is treated as evidence by itself. No whole-port, preparation/native-release or installed Worker acceptance is asserted.

## Findings

No actionable defect found in the reviewed identity source. This is bounded source/API acceptance only. Root's actual installed/deployed Worker closure remains an explicit gate, to be reviewed against its exact released diff and execution records.

## Independently inspected behavior

- `comparison.ts` is a synchronous shared byteLength guard followed by the selected native primitive. It never traverses secret bytes or falls back to JavaScript comparison. False-on-length-mismatch is explicit and outside the primitive guarantee; equal empty inputs delegate.
- `comparison-node.ts` imports only Node's timingSafeEqual in the Node leaf. The package-private map chooses node before default while retaining engines >=22. The neutral wrapper and token/password modules contain no static Node builtin import, top-level await, mutable provider or setup requirement.
- `comparison-worker.ts` checks the nonstandard native extension, rejects absent/nonfunction primitives with exactly Error / `Identity host does not provide a native timing-safe comparison.`, preserves the subtle receiver and delegates the supplied typed-array views. It contains no fallback and does not catch operational failures.
- `tokens.ts` retains boolean sync helpers, UTF-8 TextEncoder behavior, case-insensitive strict hex with explicit empty rejection and null-to-false parse handling. Invalid hex or unequal decoded lengths return false before native invocation. Issuance and hash helpers still hash the exact token text. Tail-bit compatibility masking is confined to the byte decoder, under complete URL-alphabet and length guards.
- `passwords.ts` preserves the existing parser and WebCrypto derivation catch. Native comparison occurs after that catch, so a native/host operational fault rejects verification rather than masquerading as wrong password. Wrong passwords still derive and compare; malformed records remain false before derivation; derivation failure remains false. Equal key lengths are guarded by the common comparator.
- Changed comments limit the timing guarantee to the native primitive and explicitly exclude parsing/length/derivation. No empirical whole-helper, login or JIT timing guarantee is claimed by this change.

## Evidence checked and independently executed

All current source files in the implementation worker's source-pins.json matched their saved SHA-256 values at review. The source map and emitted comparison/password bodies were inspected. Raw Node22-focused.log contains 35 passing tests; public-check.mjs exercises the emitted public package, synthetic passwords, CSRF, fixed token/hash, RFC PKCE verifier, real memory-store OAuth exchange/grant resolution and replay refusal. The actual evidence file is node22-public.json (the handoff's public-node22.json filename was reversed). Worker-control/check.mjs explicitly describes its simulated Worker-leaf selection under Node, and its result is not counted as actual workerd delivery.

The reviewer additionally authored and executed `identity-critical-review/check.mjs` with the pinned Node22.0.0 executable, importing the emitted public entry and internal byte wrapper from the hash-matched private build. `node22-independent.json` records success. This independent probe:

- checks mixed-case hex, malformed signs/prefixes/whitespace, sync return type and preserved surrogate replacement;
- checks equal nonzero-offset typed views and unequal byte lengths;
- verifies frozen canonical and noncanonical synthetic stored passwords;
- replaces the actual Node native primitive with a sentinel and synchronizes the builtin ESM binding, proving malformed/length branches make zero calls while same-length text (including empty and equal UTF-8 lengths) delegates;
- proves a wrong-password verification propagates the native sentinel fault, while a derivation sentinel returns false without another comparison call;
- invokes the actual Worker leaf against missing/nonfunction native capabilities and a receiver-sensitive synthetic primitive, restoring globals afterward.

Four expected native sentinel calls occurred. This is functional routing/error-boundary evidence, not a timing measurement. No product files or shared build outputs were changed. Own source hashes and independent execution output are saved under `/private/tmp/canlang-rust-port-codex-step10-20261007T015711Z/identity-critical-review/`.

## Remaining acceptance boundaries

Root must still deliver the actual identity dependency closure and review its exact Cloudflare bundle join: owned #identity-byte-compare rewrite, exact Node-leaf exclusion from whole-tree staging, Worker default selection in browser-bundled HTTP/MCP closures, unchanged bare-import/builtin refusal, and actual installed producer/module inventory. Then run real workerd whole-call password/CSRF/PKCE/session behavior plus frozen cookie/encoding/error contracts. Prior contract-time private Miniflare probes and the implementation's Node Worker-control are insufficient for that production closure gate.

Earliest supported Node22.0.0 source/public-entry functional coverage is now observed; it is no longer the earlier contract-stage missing-executable blocker. Full D1 tests are not implied (Node22.0.0 lacks the test-only node:sqlite dependency). Native primitive docs do not guarantee timing of surrounding code. JEV's low host-policy confidence remains recorded historical design uncertainty; this source review does not erase the concrete delivery risk.

## Reviewed source hashes

```json
{
  "packages/identity/src/sessions/comparison.ts": "663079590c9147f2cb6f3de72187afcf84ea185ac3288c946fe05901738901db",
  "packages/identity/src/sessions/comparison-node.ts": "4ab6f9af09469c5e9c876943867f05e47070519b8bfe820793efe7a637515e37",
  "packages/identity/src/sessions/comparison-worker.ts": "d07b396186f6f28dccfe5809b9ee21342d3e51e0e969fe8d028320aa2351ff68",
  "packages/identity/src/sessions/tokens.ts": "d7867041c5c893cabdece58607af646c3468aa9e24a895b8608e8112cc7365fa",
  "packages/identity/src/accounts/passwords.ts": "12e9f48e47452ce8af1c6b767bcca69843014290b85472071fea5251e738a969",
  "packages/identity/package.json": "50dfe25888fc7787c8cf4ede09abcb79c7fce8a4b5db496de0eeb86f375dcdd0",
  "packages/identity/test/comparison.test.ts": "384a94a493c83baabbd2b588dda973e8bb075b102e30bf8a670c9aad90add572",
  "packages/identity/test/accounts.test.ts": "f781848aec4423040a429cf5df26a9cf43c40e1aa6ab7669b7bbbd52a9de4fe4",
  "packages/identity/test/sessions.test.ts": "2e8b9808c058a14a023e35cdd1bb6048dca3b0c4edaf8f190aac11aef9817b9c"
}
```

## Follow-up: bounded delivery-source review

Root handed off the newly authored bundle.ts source hunks for read-only critical review. No actionable defect found at this source stage. Exact reviewed SHA-256: `431b5fe24e151a90efe963420f03c74b6988a3211709b4494f966b64c8b76f3c`.

The production Node leaf exclusion is exactly vendor/identity/sessions/comparison-node.js and is not mislabeled as a test-only bridge. The owned private alias and cookie/scure rewrites apply only to vendor/identity/ importers; the CSV browser-entry rewrite applies only to vendor/ui/. Artifact import authority is not expanded. Owner-relative createRequire resolution loads each declared producer's dependency, checks manifest name/version and exact relative entry, and stages only the frozen entry. Additional transitive imports cannot silently pass: assertWorkerdLoadable and assertLinksResolve still run after vendor/dependency staging and HTTP/MCP browser bundling, retaining refusal of bare or missing imports. The actual pinned dependency entries are expected standalone modules; a future changed entry/version fails the explicit pin or final closure checks.

The HTTP/MCP build commands remain target=browser; this makes default host-leaf selection plausible, but only actual emitted bundle inspection/execution establishes that the Worker leaf wins. No newly authored delivery tests or installed/workerd execution output was provided at this handoff, so this source review does not close that gate. This report may be extended with an explicitly identified exact evidence set after root supplies it.
