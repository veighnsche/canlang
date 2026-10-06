# Values library audit — proposals, read-only source review

Baseline supplied by coordinator: `309644a6881909d8dba32560bc6711f67e00a7ab`. No source changes, builds, tests, installation, Git changes, or runtime experiments were performed. All choices below are proposals. Links were opened against primary project documentation/source on 2026-10-06; compatibility is source-based, not demonstrated by execution.

## Coverage and present ownership

Inventory: 97 TS/Rust files under `packages/values`, excluding dist: 58 source files (29 TS, 29 Rust), 37 tests/examples (26 TS, 11 Rust), 2 generated TS declaration files. One of the 58 source files, `semantics/src/currency_facts.rs`, is generated data, leaving 57 custom source files. All source responsibilities were screened using declarations, imports, owner comments and targeted bodies; numeric, calendar/timezone, ICU, wire/schema, prepared/admission/bindings and test-oracle bodies received detailed attention. Test/example inventory and relevant test bodies/names were inspected; this is not an exhaustive bug audit or a claim to have proved every test helper correct.

Source responsibility ledger (all paths relative to `/Users/vince/Projects/canlang/packages/values/`):

- `src/{decimal,int,money}.ts`, `semantics/src/numeric/{decimal,integer,money,rounding}.rs`, `semantics/src/aggregates/{decimal,integer,money,numeric}.rs`: exact arithmetic + Can checking/rounding boundaries; findings V1/V4; otherwise retain adapters over existing bigint mechanisms.
- `src/{temporal,timezone}.ts`, `semantics/src/temporal/{civil,instant,duration}.rs`: manual civil calendar/parsing + Can interval/range semantics; V3.
- `src/{icu,locale,text}.ts`: bounded ICU parser/interpreter, exact display, fallback, native Unicode/Intl; V5/V6/V8.
- `src/{schema,wire,types,kinds,equality,array,stdlib-pure}.ts`: Can type grammar, provenance/value carriers, closed schema/wire, identity/equality, ordered supplied-domain evaluation and URL policy; V2/V7/V8/V9.
- `src/prepared/{plan,codec,validation}.ts`, `bindings/{backend,bootstrap,carriers,owned-input,plans,validation}.ts`, `semantics/src/{input,plans,profiles}.rs`, `semantics/src/{codecs,representations}/numeric.rs`, `semantics/src/transport/exact.rs`, `bindings/src/{exact,validation,lib}.rs`: registry/admission/parity mechanisms and transport scaffolds; V1/V2/V7/V9/V10.
- `src/{catalog,currency-data,errors,index,distribution}.ts`, `semantics/src/{currency_facts,failures,lib}.rs`, all six Rust `*/mod.rs` files: owner facts/catalog/error vocabulary/export assembly; retain. Currency facts are generated from the pinned TS table, not independently maintained algorithm logic.
- Tests/examples: Can vectors, interface/export/catalog conformance, independent decimal/digit-string oracles, prepared trace/genuineness checks, owned-input emulation and NDJSON harness; V4/V10. Generated TS declarations are excluded as generated interface output, not custom mechanics.

Present dependencies: TS production uses `@canlang/contracts`, native bigint, URL, TextDecoder/JSON and Intl; `decimal.js@10.6.0` is dev-only (independent oracle). Rust uses `num-bigint`, `num-traits`, `serde`, `serde_json`; binding uses `wasm-bindgen`. `README.md` requires JS without `node:` imports on Node/workerd. Rust currently uses std; no no_std requirement is asserted. Committed generated build metadata says wasm32-unknown-unknown/web/release, wasm 622216 bytes, but byte counts/digests were not independently verified here.

Shipping boundary: `/Users/vince/Projects/canlang/packages/values/src/index.ts:1` exports values through the stdlib facade; `/Users/vince/Projects/canlang/packages/stdlib/src/index.ts:58` re-exports the producer. `/Users/vince/Projects/canlang/packages/interfaces/src/mcp/schemas.ts:31` consumes actual `decodeValue`/`parseDecimal` for derived interfaces; `/Users/vince/Projects/canlang/packages/interfaces/src/docs/reference.ts:26` consumes locale resolution. `bindings/backend.ts:1` explicitly labels its six-entry TS operation table as a smoke scaffold; `bindings/validation.ts:1` and Rust profiles label structural calls as scaffolds. Assets are staged on normal builds, with explicit opt-in binding exports; this is not evidence that generated programs automatically execute the complete Rust backend.

## Prioritized findings

### V1 — P1 use-library-under-thin-adapter: ECMAScript f64 diagnostic formatting

Exact site: `/Users/vince/Projects/canlang/packages/values/semantics/src/representations/numeric.rs:319`. `format_js_number` manually combines Rust shortest display/scientific output, magnitude thresholds, special cases and exponent signs to approximate JS `String(number)`. Used by scalar violation `actual_wire` (`codecs/numeric.rs:128`) and scale/range error text (`numeric/decimal.rs:199`). This is standard float-to-string behavior, not exact decimal arithmetic or Can authority.

Candidate: `ryu-js::Buffer::format` behind the existing function; library explicitly targets ECMAScript and handles NaN/±Infinity. Source is no_std and has no host time/IO dependency; native/Wasm build compatibility remains an unexecuted gate. Keep the Can diagnostic function name and any documented supported-profile exclusions. Adapter estimate: a few lines instead of the current 27-line formatter, one dependency. Do not replace this with generic `ryu`, ordinary Rust Display or float transport.

Gate: byte-for-byte against actual JS `String` for +0/-0, NaN/±Infinity, subnormals, max finite, adjacent f64 bit patterns around 1e-6/1e21, safe-integer transitions and at least 10000 seeded bit patterns; same full error envelopes and no Wasm regressions. No reproduced bug is claimed.

Evidence: https://docs.rs/ryu-js/latest/ryu_js/ ; https://docs.rs/ryu-js/latest/ryu_js/struct.Buffer.html ; https://raw.githubusercontent.com/boa-dev/ryu-js/main/src/lib.rs

### V2 — P2 replace with existing library: valid-UTF-8 JSON string escaping

Exact site: `/Users/vince/Projects/canlang/packages/values/semantics/src/codecs/numeric.rs:155`. `json_stringify(&str)` hand-escapes quote/backslash/C0 using 26 lines, despite `serde_json` already being a dependency and used by surrounding transport. Use `serde_json::to_string(text)` through this narrow existing helper after parity verification. Serializer source has the same short control escapes and lowercase hex. No new dependency. This proposal concerns escaping a Rust string only, not whole ordered owned-input values.

Gate: identical bytes for every C0 byte, quote/backslash/slash, U+2028/U+2029, BMP and astral combinations, escaping before the existing diagnostic truncation, and all scalar violations. Keep truncation separate: `codecs/numeric.rs:182` already documents a surrogate-split mismatch (Rust keeps 63 rather than JS's 64 units); library adoption does not fix it. Rust `str` cannot carry lone surrogates, so no claim of general JS string serialization parity.

Evidence: https://docs.rs/serde_json/latest/serde_json/fn.to_string.html ; https://docs.rs/serde_json/latest/src/serde_json/ser.rs.html

### V3 — P1 evaluate temporal engines under a Can adapter

Exact sites: `/Users/vince/Projects/canlang/packages/values/src/timezone.ts:203` (`local_instant`; five round-trip offset probes around target ±1/2 days at line 220); `src/temporal.ts:85`/`:96` (Hinnant civil conversion), `:218` (manual RFC3339 parser), `:309` (month clamp); `/Users/vince/Projects/canlang/packages/values/semantics/src/temporal/civil.rs:20`, `instant.rs:46`. Leap/month logic is also replicated in TS kinds and Rust representations/codecs.

Present library use: Intl supplies timezone data/rendering, while custom code inverts the mapping; native bigint supplies safe duration math. Propose evaluating Temporal/native or `@js-temporal/polyfill` for JS timezone/civil mechanics; `jiff` for Rust civil mechanics and, only with matching pinned zone-data ownership, timezone mechanics. Temporal polyfill source itself uses Intl timezone data, so it does not solve the existing release pin requirement. Jiff supports Date -9999..9999, no-std/alloc options and Wasm, but system/default tzdb features cannot be accepted as the pinned Can database.

Can adapter must retain 0001..9999 input/result range; strict YYYY-MM-DD and HH:MM[:SS]; public datetime accepts lowercase t/z and arbitrarily long fractional zeros but rejects nonzero sub-ms and leap seconds; offset grammar up to 23:59; int64 duration with exact duration/int and final-only aggregate narrowing; original-anchor stateless month clamp; half-open range limit failure, not truncation; validation order date→time→zone→fold. `fold` currently required even for unambiguous calls. Temporal earlier/later can adjust gaps, so adapter must round-trip civil fields and reject gaps for both selectors; `reject` alone wrongly rejects folds. Retain Can control rules and error envelopes regardless of engine.

Gate: compare existing vectors plus years 0001/9999, crossings into BCE/out-of-range, historic second offsets, non-hour folds/gaps (e.g. Lord Howe), skipped whole days (Apia), aliases/case, transition boundaries and far-future values with one identified tzdb pin. Benchmark import size, Wasm size, calls and allocation; prove calendar engine removal is a net maintenance reduction. Tests currently emphasize NY/Auckland/Kathmandu modern stable dates (`test/timezone.test.ts:13`); no comprehensive historical/boundary proof was found.

Evidence: https://tc39.es/proposal-temporal/docs/timezone.html ; https://github.com/js-temporal/temporal-polyfill ; https://raw.githubusercontent.com/js-temporal/temporal-polyfill/main/lib/ecmascript.ts ; https://docs.rs/jiff/latest/jiff/ ; https://docs.rs/jiff/latest/jiff/civil/struct.Date.html ; https://docs.rs/jiff/latest/jiff/tz/enum.Disambiguation.html

### V4 — P2 evaluate limited BigDecimal mechanics; retain Can decimal/money policy

Exact sites: `/Users/vince/Projects/canlang/packages/values/src/decimal.ts:140`/`:207`; `/Users/vince/Projects/canlang/packages/values/semantics/src/numeric/rounding.rs:23`, `decimal.rs:56`; `src/money.ts:56`; `src/array.ts:170`; Rust numeric money and aggregates. Custom code aligns scales, performs bounded long division/guard+sticky half-even, checks ranges and formats canonical coefficient text. Core arbitrary-precision multiplication/division is already native bigint/num-bigint, not rolled limb arithmetic.

Verified constraints: ≤38 coefficient digits, scale 0..18 with stored scale retained; no exponent/+ syntax; malformed vs construction-out-of-range vs result-overflow distinct; exact add/sub and full scratch product before final boundary; multiplication rounds only past18; terminating division minimal scale, other division one direct half-even; money rounds exactly once to the owner table then int64; aggregates check only final total (intermediate cancellation must survive). Some operator bigint operands are arbitrary precision, and `rounding_vectors.rs:56` tests 10^100 scratch.

`rust_decimal` is disqualified for general Can decimals: 96-bit coefficient/roughly28–29 digits cannot cover38 or arbitrary scratch, despite trailing-scale/no_std/Wasm support. Decimal.js is an actual dev-only value oracle; docs and `test/decimal-oracle.test.ts:12` confirm every operation rounds to configured significant precision and trailing zeros are not retained. Making it production requires extra scale metadata, per-operation scratch precision and explicit Infinity/error policy; setting precision38 is not equivalent.

BigDecimal is the better Rust evaluation candidate for exact coefficient/scale arithmetic and explicit `with_scale_round(..., HalfEven)`, not unchecked parsing/division or Context defaults. It uses BigInt+i64 scale; defaults are build-environment controlled (100 digits/HalfEven), `Context::invert(0)` returns zero, and Context precision is significant digits. Existing no_std feature is documented/source-verified; target build remains unexecuted. Can prechecks, minimal terminating scale, operation order and final bound/error mapping remain required. `num-rational` offers arbitrary BigRational, but default `round()` ties away from zero and zero-denominator construction panics, so it does not replace the tiny Can half-even adapter by default.

Gate: first prototype only the scale-rounding/product slice; reduce hand-maintained mechanisms without adding a second competing semantic model. Require matching coefficient+scale (not just numeric equality), all constructor/error precedence, cancellation,100-digit scratch, ties/signs/negative denominator, near-tie direct division, stored zeros and canonical wire; report allocation/Wasm-size impact. Current 200-seeded Decimal.js oracle compares numeric value only and documents double-rounding limits; it is evidence of tests, not a proof a production library adapter matches.

Evidence: https://docs.rs/bigdecimal/latest/bigdecimal/ ; https://docs.rs/bigdecimal/latest/bigdecimal/struct.BigDecimal.html ; https://docs.rs/bigdecimal/latest/bigdecimal/struct.Context.html ; https://docs.rs/crate/bigdecimal/latest/features ; https://raw.githubusercontent.com/akubera/bigdecimal-rs/master/src/lib.rs ; https://docs.rs/rust_decimal/latest/rust_decimal/ ; https://mikemcl.github.io/decimal.js/ ; https://docs.rs/num-rational/latest/num_rational/struct.Ratio.html

### V5 — P1 evaluate ICU parser adoption; known FormatJS incompatibility

Exact site: `/Users/vince/Projects/canlang/packages/values/src/icu.ts:267` through `:535`: custom recursive parser with apostrophes, nested plural/select, mandatory other, frozen AST and depth32; validation at `:642`, interpreter at `:822`. This overlaps standard ICU mechanics and is a worthwhile library-evaluation target, but the inspected FormatJS parser is not a thin drop-in.

Official parser source `tryParsePluralOrSelectOptions`/`tryParseDecimalInteger` accepts exact selectors as safe integers, while Can test `test/icu.test.ts:88` accepts `=1.5` and `:315` accepts int64-max `=9223372036854775807`. Can normalizes decimal exact selectors for duplicate detection. Library must also reproduce identifier profile, rich-tag rejection (including attributes/self closing), apostrophe rejection/EOF behavior, offset/skeleton/style exclusion and depth32 before expensive recursive parse, error messages/precedence, and typed argument checks. Full `intl-messageformat` also has broader syntax and default formatter behavior; existing exact typed interpreter must not be silently discarded.

Gate: parser-only spike with one explicit extension strategy that does not itself recreate the parser; full valid/invalid matrix, large/fractional exact selectors, normalized duplicate selectors, nested #, apostrophes and malformed deep patterns. Compare total adapter/upstream patch burden; retain current bounded parser if replacement requires a maintained fork or comparable custom scanning. No new production recommendation until this gate passes.

Evidence: https://formatjs.github.io/docs/icu-messageformat-parser/ ; https://formatjs.github.io/docs/intl-messageformat/ ; https://raw.githubusercontent.com/formatjs/formatjs/main/packages/icu-messageformat-parser/parser.ts

### V6 — P2 evaluate existing Intl for exact number digit/grouping output

Exact site: `/Users/vince/Projects/canlang/packages/values/src/icu.ts:1047`–`:1133`: probes NumberFormat symbols/group run sizes, manually groups arbitrary bigint/decimal digits and includes another half-even rounder (`:1096`). ECMA402's exact string mathematical-value route means the blanket assumption that NumberFormat needs lossy Number is unnecessary for digit formatting (separate from PluralRules). Use existing Intl behind an exact profile adapter rather than adding an arbitrary-precision formatter package first.

Can output is Latin digits with locale-derived separators/minus, every stored fractional zero, exact int64/38-digit decimals, and int-only integer style. Native output may differ in locale digits, bidi literals and minimum grouping; `numberingSystem:latn` alone can change current separators. Therefore this is evaluate, not direct replacement. The integer formatter rounder is currently defensive no-op after int typing; removal/shared helper is simpler than a new library solely for that branch.

Gate: exact string formatToParts supported on pinned workerd/Node; byte equality at scales0..18 and extreme magnitudes across en/de/hi/ar/fa/es and no/boundary grouping, minus/bidi, scale-retained zeros; explicitly measured adapter simpler than90 current lines. If pin-level engines do not support exact string inputs, retain manual rendering. Do not broaden plural admissibility in this mechanical migration.

Evidence: https://tc39.es/ecma402/#sec-intl-numberformat-prototype-formattoparts ; https://tc39.es/ecma402/#sec-tointlmathematicalvalue

### V7 — retain Can schema, wire and plan authority; generic validator not substitute

Exact sites: `/Users/vince/Projects/canlang/packages/values/src/schema.ts:618`/`:674`/`:814`; `wire.ts:1178`/`:1763`; `types.ts:1`; `src/prepared/plan.ts:400`, `prepared/codec.ts:111`, `prepared/validation.ts:1`; `bindings/plans.ts:77`; `semantics/src/plans.rs:298`. These implement authored type/field/operation meaning and ordered error/default/admission contracts, not simply generic shape checks.

Constraints: unknown own fields collected in wire enumeration order, then declared fields in owner order; own vs inherited/undefined semantics and getters; wire decode before trim before bounds; create/update/explicit default modes, shared frozen default identity, engine-owned drop markers, nested update partials but complete array/union elements; required expected versions in mutation refs, invocation/action specific semantics; schema factory provenance, owner/generation handles and precise abstention codes. Existing prepared codec/validator delegates to legacy after plan admission; it is not a second validation engine. No proven library opportunity for closed language type parser/equality and identity semantics was found.

Ajv official docs show data-changing defaults/coercion/removal and unspecified keyword evaluation order, so generic swap would need substantial semantic orchestration; do not nominate it as a simplification without a leaf-only proof. Retain Can coordinator, perhaps use mature standard leaf codecs where outcomes match. Gate any future shape leaf extraction against complete outcomes: returned values/carriers/default identity, all violation paths/messages/order, getter traces, mutation-version checks and no change in owner authority.

Evidence: https://ajv.js.org/guide/modifying-data.html ; local `test/schema.test.ts:695`,`:833`,`:935`; `test/legacy-validation-traces.test.ts:355`,`:431`,`:547`.

### V8 — retain native-backed Unicode, URL, currency and fallback semantics

Exact sites: `/Users/vince/Projects/canlang/packages/values/src/text.ts:20`–`:105` uses built-in Unicode case conversion/property regex and scalar iteration; `wire.ts:463` is an intentionally conservative email floor, `:479` already uses WHATWG URL; `stdlib-pure.ts:244` uses URL under mount-prefix/percent-escape policy; `locale.ts:28`/`:69` uses Intl canonicalization under Can whole-message fallback; `currency-data.ts:1` pins165 ISO codes with numeric minor units.

Do not replace scalar ordering/counting with grapheme segmentation/locale collation, use restrictive email RFC validation for a deliberately minimal floor, allow URL joining to erase forbidden dot/separator input before checks, replace pinned money membership with Intl's broad currency syntax, or replace owning-source/app-default deterministic fallback with generic best-fit. These are already library/native mechanisms with small Can policy adapters. Timezone/Unicode/locale data pin remains host-release responsibility; no independent pin verification was done here. Currency table is versioned policy/data and Rust copy is generated; do not silently upgrade to a live currency library.

Gate any proposed refactor: same non-normalized/lone-surrogate/scalar behavior, exact validated string membership, percent-escape/control/prefix policy and fallback locale/text/ordering. No new dependency recommended.

### V9 — evaluate bulk Wasm bridge only, retain transport provenance

Exact sites: `/Users/vince/Projects/canlang/packages/values/bindings/backend.ts:98`, `carriers.ts:47`, `semantics/src/transport/exact.rs:72`/`:843`; `bindings/owned-input.ts:77`; `semantics/src/input.rs:141`; `semantics/src/profiles.rs:1`. Current scalar smoke path tags/stringifies/parses every call; mature `wasm-bindgen` is already used. This is an opt-in scaffold, not an ideal automatic future hot-path design.

`serde-wasm-bindgen` can reduce JSON overhead, but default i64/u64 serialize as safe-range numbers and Rust String cannot preserve lone UTF16; configuration has bigints, and JS values may be preserved, but automatic conversion does not preserve Can issuance/default/owner authority or duplicate ordered frames by itself. `serde_json::Value` uses sorted BTreeMap unless preserve_order; preserve_order still cannot represent duplicate entries. Retain explicit ordered arrays, f64 bits, raw UTF16, minted markers and host-token lineage; do not adopt arbitrary values just because shape matches. Proposal: evaluate a bulk operation interface carrying owner-approved frame arrays with library support for generic crossing. Gate whole-call bits/unit/key-order/duplicates/genuineness/errors, type/carrier/provenance, plus end-to-end throughput/binary size; do not optimize individual scalar crossings as the long-term architecture without measurement.

Evidence: https://docs.rs/serde-wasm-bindgen/latest/serde_wasm_bindgen/ ; https://docs.rs/serde_json/latest/serde_json/enum.Value.html ; local `test/validation-binding.test.ts:78`, `test/owned-input.test.ts:43`.

### V10 — retain bounded independent test oracles; evaluate actual host observation for JSON harness

Exact site: `/Users/vince/Projects/canlang/packages/values/semantics/tests/input_validation/conformance_v1.rs:115` (manual JSON parser),`:304` (number grammar),`:352` (integer-index classification),`:372` (JS ordering). Test-only JVal preserves lone UTF16, overflow-to-Infinity and duplicate pair lists; production owned token parser already uses host JSON.parse. Ordinary serde_json would invalidate what this harness is checking. Do not count this test emulator as a shipped parser replacement opportunity. A future real-host-produced bits/units/entry observation fixture could reduce emulator maintenance, but must retain independent JS behavior verification and make v1/v2 duplicate-frame rules explicit. Simple seeded PRNGs/digit-string half-even test oracles are useful independently written bounded evidence, not new production dependencies.

Gate: actual host-derived observations for every existing case, strict invalid JSON and raw/escaped Unicode, number overflow/negative zero, integer keys/duplicate behavior, no fixture expectation computed from the same production function being tested. Source review only; harness was not run.

## Evidence limits

No executable compatibility, benchmark, package rebuild or current CI status is claimed. Public docs/source demonstrate mechanisms and exclusions, not that adapters have been implemented. Language semantics were checked against `docs/specification/DESIGN.md:107`,`:215`,`:219`,`:227`,`:230`,`:893`,`:895` and inline/tests; comments sometimes cite older line numbers. The design explicitly labels larger localization workflow portions unimplemented, while values parser/display helpers are implemented—do not conflate those stages. All replacement/evaluation choices remain proposals pending owner approval and measured gates.
