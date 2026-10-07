# Package library reuse audit

Planning review, 2026-10-06. Source checkpoint: `309644a6881909d8dba32560bc6711f67e00a7ab`. Recommendations below are proposals, not implementation or accepted dependency changes. Preparation/native-release remains human-held.

The later [production baseline](production-baseline/README.md) compares this
checkpoint with post-adoption package source. It accounts for all tracked files,
inline Rust tests, generated assets, scaffolds and implementation transfers;
the historical source-candidate counts below are not production LOC.

We should replace several standard parsing and encoding mechanisms with maintained libraries or platform APIs. Keep Can's authored semantics, authority, evaluation order, exact values, identity and error contracts in small owning adapters. A library whose adapter becomes another parser or semantic engine is not a simplification.

## Current simplification audit

The later planning audit records the [production baseline](production-baseline/README.md),
[actual responsibilities/callers](responsibility-callers/README.md),
[required-behavior authority](required-behavior/README.md),
[library fit](library-fit/README.md), [adapter branch dispositions](adapter-branches/README.md),
and [duplicated mechanisms/layers](duplication-layers/README.md).
The [TS/Rust/Wasm ownership audit](language-boundaries/README.md) then maps
the defining implementations, finite native surfaces and unfinished consumers.
It distinguishes actual exact Wasm functions, validation scaffolds, registered
Work candidates and held preparation prefixes; it also reconciles current values
asset receipts and narrows earlier preparation caller claims.
The branch audit covers 480 groups across the selected 27 integration seams, with exact
conditional change gates and independent source challenges. These later pinned records
supersede historical unwired/source/qualification premises below where explicitly reconciled;
they do not authorize new implementation or broaden finite acceptance.

The duplication/layer step records 31 conditional change candidates and 18 retained
boundaries with caller evidence. It distinguishes private shared mechanics from public
assembly, authority checks and retained donor/oracle paths; implementation remains deferred.

## Coverage and evidence

[Source inventory](source-inventory.json) records 684 TS/Rust files under all 13 package owners, excluding dependency/build-output directories. There are 341 source candidates and 343 test/example/fixture files. These are inventory categories, not a claim that every file is compiled or production code: values includes generated currency data, and work-kernel Rust decisions are currently outside its Cargo root. Review screened responsibilities/imports and inspected the relevant algorithm bodies and tests; it does not prove whole-package correctness.

| Package | Source candidates | Test/example/fixture files | Responsibility reviewed |
| --- | ---: | ---: | --- |
| cloudflare | 52 | 61 | Import rewriting, diagnostics/maps, preparation, host/CLI/bundle/publication |
| contracts | 16 | 8 | Types, domain vocabulary and standard interfaces |
| files | 11 | 11 | Upload signatures, byte policy, filesystem adapters |
| identity | 21 | 12 | Encoding/comparison, cookies, platform crypto and authorization ownership |
| interfaces | 40 | 36 | CSV, MCP/OAuth/HTTP, canonical bytes, projection/privacy |
| services | 17 | 9 | Fetch cancellation, providers, NDJSON/models, pagination |
| state | 51 | 71 | Replay hashing, cloning, storage/fences and authority |
| stdlib | 2 | 1 | Owning values facade |
| testkit | 8 | 20 | Native tooling, assertions/fixtures and tiny ABI fixture |
| ui | 30 | 30 | CSV, escaping, browser packaging and native rendering |
| values | 58 | 37 | Numeric/temporal/ICU, exact wire, schema, provenance and Rust bindings |
| work | 16 | 40 | Ordered dispatch, claims/receipts, revocation, schedules |
| work-kernel | 19 | 7 | Pure decision implementations and future Rust assembly |

The detailed [values](reviews/values.md), [native/delivery](reviews/native-delivery.md), [adapters](reviews/adapters.md) and [identity/state/work](reviews/identity-state-work.md) reviews give source locations, primary upstream sources, deliberate incompatibilities and acceptance witnesses. [Findings](findings.json) provide audit IDs and existing-task crosswalks. Audit IDs are not new canonical implementation obligations. No package source, dependency, lockfile, task acceptance or living-plan checkpoint was changed. No build, test, installation, runtime or CI dispatch was performed.

[Independent challenge](reviews/identity-state-challenge.md) narrowed the hex/cookie findings to their actual callers. [Consolidated review](reviews/consolidated-review.md) checked every finding and the original task/source inputs; root repaired ambiguous scope/readiness and unqualified-parser wording. [Planning verification](verification.json) confirms source hashes, locations, task references and local links; it is not product/runtime acceptance.

Upstream documentation/source was opened on the audit date. A `main`/`latest` API is an evaluation input; select and lock an actual version, inspect its license/dependencies, and qualify its delivered closure before adoption. Candidate libraries have not been benchmarked or independently supply-chain audited here.

## Strong candidates for library-backed mechanics

| Audit IDs | Current custom mechanism | Recommended candidate | Contract retained by Can |
| --- | --- | --- | --- |
| LIB-01/02 | Rust approximations of ECMAScript number text in values and work decisions | [ryu-js](https://docs.rs/ryu-js/latest/ryu_js/) | Exact decimal arithmetic, diagnostic envelope, `String` versus JSON treatment of nonfinite numbers, negative-zero carrier bits |
| LIB-03 | Rust string escaping despite an existing JSON dependency | Existing [serde_json::to_string](https://docs.rs/serde_json/latest/serde_json/fn.to_string.html) for Rust `str` only | Truncation/error policy; lossless JavaScript UTF-16 transport remains separate |
| LIB-04 | Regex/character scanning of JS imports and text substitution | [es-module-lexer](https://github.com/guybedford/es-module-lexer) plus [MagicString](https://github.com/Rich-Harris/magic-string) | Allowed specifiers/paths, resolution, producer identity, rejection order and rewritten-map ownership |
| LIB-05 | Base64 VLQ/source-map decode and lookup | [sourcemap-codec](https://github.com/jridgewell/sourcemap-codec), [trace-mapping](https://github.com/jridgewell/trace-mapping), and [remapping](https://github.com/jridgewell/sourcemaps/tree/main/packages/remapping) | Strict malformed-input admission, lookup bias, exact location/redaction behavior and map composition |
| LIB-06 | Separate server and UI CSV scanners | Shared [csv-parse](https://csv.js.org/parse/distributions/browser_esm/) adapter; evaluate csv-stringify for export | Consent/replay bytes, headers/row caps, malformed-input policy, column handling and spreadsheet protection |
| LIB-07 | Identity's handwritten base64url and hex codecs | [@scure/base](https://github.com/paulmillr/scure-base) | Empty/error mapping, stored canonical token/password compatibility, explicit malformed-input tightening |
| LIB-08 | Secret comparison claimed constant-time in JS loops | Qualified host primitives: [Node crypto](https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b), [Workers timingSafeEqual](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/) | Equal-length buffers, portable host adapter, existing call contract; surrounding code is not automatically timing-safe |
| LIB-09 | Session Cookie/Set-Cookie grammar and attribute concatenation | [cookie](https://github.com/jshttp/cookie) under a thin wrapper | Secure/HttpOnly/SameSite/expiry, first duplicate, malformed-percent refusal and validated Domain |
| LIB-10 | Manual cancellation signal fan-in | Platform [AbortSignal.any](https://nodejs.org/api/globals.html#static-method-abortsignalanysignals) | Full-body deadline, caller/timeout classification, byte caps, per-hop origin checks and cleanup |

LIB-01–04 have related current Rust semantics/work/delivery task crosswalks; their original readiness and release gates still apply. CSV and identity changes need explicit finite ownership and task mapping before dispatch. Even an existing proposed task's exact file overlap does not establish a ready library-change packet. The signal change is a small platform simplification. No reason to replace the whole HTTP wrapper with Axios/Ky or create another library layer around existing native codecs.

Source inspection found two concrete warning signs. Work Rust converts integral finite numbers below `1e21` through `as i64`; values such as `1e20` saturate rather than reproduce JS text. This decision code is not yet included by `work-kernel/rust/lib.rs`, so this is a pre-assembly defect, not a demonstrated shipped runtime failure. Identity's hex decoder checks `parseInt` only for NaN; `'0g'` is accepted as zero. The exported hex comparison has tests but no production call was found in the package search, so this does not establish an authentication bypass. Both need actual negative controls during future repair.

## Evaluate before selecting a replacement

| Audit IDs | Candidate | Reason a blanket replacement is premature |
| --- | --- | --- |
| LIB-11 | Acorn/walker for CJS/loadability analysis | An import lexer cannot identify free `require`/`exports`, scopes or all invalid JS; retain bundler-helper provenance. Only add an AST stack if this responsibility actually needs it. |
| LIB-12 | percent-encoding for future work Rust | Requires ECMAScript encodeURIComponent's exact allowed set, UTF-16 lone-surrogate refusal and identity-byte compatibility. |
| LIB-13 | Temporal / @js-temporal/polyfill / jiff | Keep date range, strict grammar, gap refusal/fold selection, month-clamp/interval policy and one pinned zone-data owner; system/Intl data alone is not a release pin. |
| LIB-14 | BigDecimal for limited scale-rounding mechanics | Can owns 38-digit/scale-18 bounds, stored scale, final-only narrowing and operation-specific rounding. `rust_decimal`'s 96-bit coefficient is too narrow; decimal.js precision 38 is not equivalent. Already using num-bigint avoids homemade limb arithmetic. |
| LIB-15 | FormatJS ICU parser | Current upstream exact selectors accept safe integers; Can accepts fractional and large exact selectors. A maintained fork/second scanner could erase the intended maintenance benefit. |
| LIB-16 | Existing Intl exact number-formatting APIs | Qualify exact string inputs and separators/digits/bidi/grouping on actual hosts; preserve every stored decimal zero. This does not replace exact plural semantics. |
| LIB-17 | canonicalize / shared stable serializer | Persisted replay/consent digests are protocol bytes. Generic omission/null conversion, surrogate rejection, symbol handling and boxed primitives differ. First define admission and any migration. |
| LIB-18 | toml_edit, Node util.parseArgs | Grammar mechanics can be reused, but output bytes/order/review hashes and CLI precedence/errors remain gates. Preparation is held. |
| LIB-19 | file-type | Worthwhile for a broader signature catalog; binary-only best-effort detection is not structural validation or the current strict plain-text policy. |
| LIB-20 | Official Ollama SDK | Inspected upstream stream parser warns raw malformed lines and continues; Can refuses them and redacts provider content. No adoption unless strict verdict/privacy/cancellation survive with less total machinery. |

These evaluations are not reasons to delay all four lanes. Keep uncertain calendar/ICU/hash/SDK decisions outside ready implementation packets until a bounded equivalence/complexity result is available. A consequential semantic or ownership change requires the repository's balanced JEV consultation and explicit recorded decision; routine reuse of already-selected standard primitives does not require repeating the earlier coarse port-seam consultation.

## Keep the mechanisms already in the right place

- Native bigint / num-bigint, WebCrypto / sha2, JSON parser, URL, TextDecoder, filesystem/process primitives, Bun/esbuild, wasm-bindgen and official MCP SDK already supply reusable mechanics. Do not describe them as handwritten alternatives or add another dependency merely to wrap them.
- Keep Can decimal/money policy, schema/default/error order, type/provenance/owner authority, prepared-plan admission, state transactions/fences, work claims/receipts and finite dispatch/revocation. Generic validators, ORMs and workflow engines do not reproduce these contracts by default.
- Keep tagged lossless JavaScript transport: UTF-16 lone surrogates, negative-zero bits, original number text, own `__proto__` and JS key order cannot be replaced wholesale with serde_json `String`/`Value`.
- Keep small centralized HTML escaping, native-backed text/locale/URL policy, explicit privacy projection, signature allowlists and bounded process framing unless a demonstrated library adapter is simpler. Library use is a means to reduce maintenance, not a count to maximize.

## Proposed preparation of future packets

1. Freeze original prerequisites and current producer/caller evidence. Choose a dependency version and run the finding's negative controls before deleting the custom implementation.
2. R1 can incorporate LIB-01/03 into `A03.1`/`A04.5`; R3 can incorporate LIB-02 into `W04.1`/`W04.3` and LIB-04 into its owned delivery gates. LIB-05 has no exact current task-file crosswalk: assign an explicit finite diagnostic scope before touching it. Shared dependency/root changes remain with the existing sole assembly/delivery owners.
3. If one qualified TS host parser covers the actual preparation seam, avoid adding a competing Rust JS parser. The current import scanners are handwritten and the proposed library parser is not yet qualified. Decide the real preparation host/parser seam before `P05.1`; preparation/native-release remains held. Standard TOML/CLI reuse can be evaluated with that owner later.
4. Library adoption needs unchanged output/error/order/authority witnesses, actual TS/Rust/Wasm and installed consumers where applicable, bounded input/memory behavior, delivered license/dependency inventory and rollback. Remove replaced mechanics only after these pass; retain the explicit TS compatibility backend until its separate retirement gates pass.

The current execution plan links this audit as a planning input. Canonical task statuses/counts are unchanged; no new startup, runtime release or checkpoint advancement follows from this review.

The proposed [detailed adoption sequence](adoption-sequence.md) and [machine task/dependency map](adoption-sequence.json) turn the findings into finite source, consumer and review units within the existing four-lane architecture. Values and work qualification stay separate; import and map leaves join only at composition/delivery; identity/CSV/service additions require explicit finite scope. Conditional investigations and human-held native preparation do not become global waiting waves.

The [task-specific model allocation](model-allocation-20261007.md) applies current official guidance and independent task review to all 27 units and 12 macro steps. It separates cheap prepared work from compatibility, integration and security review. Choices remain proposals, with no model benchmark or implementation activation.
