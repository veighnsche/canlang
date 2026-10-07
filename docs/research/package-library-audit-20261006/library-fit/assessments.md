# Per-integration library fit

Semantic source checkpoint `f8e9e73b11f19a7d59ac62487033a5bc189c46a1`. Planning only. Every option is compared to the same listed contract outcomes. Status describes source use/evidence, not production adoption or whole-workflow acceptance.

## numeric-text

ECMAScript number String and JSON token text. **Assessment:** already-adopted; simplify redundant wrapper later.

**Contracts:** `vv.number-diagnostics`, `vv.transport-f64-roundtrip`, `SW-086`.

**Required outcomes:** Persisted Work JS-number text for identities; finite host f64 recovery before semantic diagnostic; selected diagnostic parity scope.

**Pinned candidates / primitives:**

- **ryu-js 1.0.3** — locked current package dependency. License: Apache-2.0 OR BSL-1.0. Entry/features: Buffer::format; current defaults disabled; no small/no-panic features. Dependencies: `{"no-panic": {"version": "0.1", "optional": true}}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current ryu plus branches | fits selected String/JSON split; current 19-line values formatter and 23-line Work channels | stack Buffer, synchronous native/Wasm; no init | existing dependency; redundant special cases |
| library_with_minimum_wrapper: ryu minimum wrapper | best same outcome simplification; String: Buffer::format(n).to_owned(); JSON: finite test then String else null | same targets need existing qualification | no extra numeric policy engine |
| platform_primitive: platform String/JSON.stringify | best TS route; unavailable Rust native as same primitive; keep TS direct host operations | JS host; cross-language bridge unnecessary | zero TS dependency; Rust would need host crossing |
| retain_now: retain-now | satisfies frozen baseline; leave branches until finite qualification packet | current assemblies only | safe immediate disposition; no claimed new reduction |

**Necessary owner wrapper:** String versus JSON channel choice; String allocation and error integration.

**Avoidable or conditional wrapper:** zero/NaN/infinity branches on String path; shortest-decimal or exponent rewriting.

- Prior LIB-02 unwired statement obsolete: package registers decisions. Actual workflow/backend joins remain absent. Buffer::format already covers nonfinite; pretty zero path normalizes -0.

**Maintenance conclusion:** Redundant String nonfinite/zero branches; retain distinct JSON null policy.

**Proposed next action:** Finite checked removal using existing library only.

**Source:** [packages/values/semantics/src/representations/numeric.rs:316](/Users/vince/Projects/canlang/packages/values/semantics/src/representations/numeric.rs:316); [packages/work-kernel/decisions/numeric_text.rs:1](/Users/vince/Projects/canlang/packages/work-kernel/decisions/numeric_text.rs:1).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

**Unresolved authority/domain:** vv.number-diagnostics: Numeric diagnostic interpolations use ECMAScript String(number): -0→0, NaN/±Infinity words and JS notation thresholds; JSON nonfinite→null is a different observation. This formatter does not admit Number as exact Can int/decimal.

## string-quoting

Rust valid UTF8 diagnostic quote bytes. **Assessment:** already-adopted; retain.

**Contracts:** `vv.string-diagnostics`, `vv.native-astral-truncation`, `vv.errors-prose`.

**Required outcomes:** Selected valid-str quote profile remains compatible; quoting does not establish general JS string admission.

**Pinned candidates / primitives:**

- **serde_json 1.0.151** — locked current package dependency. License: MIT OR Apache-2.0. Entry/features: to_string(str), typed Deserialize; current std default; values float_roundtrip; preparation std; work dev only. Dependencies: `{"indexmap": {"version": "2.2.3", "optional": true}, "itoa": {"version": "1.0"}, "memchr": {"version": "2", "default-features": false}, "serde_core": {"version": "1.0.220", "default-features": false}, "zmij": {"version": "1.0"}}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current serde quote | fits valid str scope; one direct call then existing truncate | sync memory; std current | no new dep |
| library_with_minimum_wrapper: serde minimum wrapper | same as current quote implementation; to_string concrete str; owner truncation remains separate | same | no additional escape loop |
| platform_primitive: platform JSON.stringify | fits JS UTF16 and surrogate-aware well-formed JSON; JS route; Rust requires carrier or bridge | JS host | keep JS route where already present |
| retain_now: retain-now | best immediate; retain serializer; resolve truncation in separate packet | current conditional native | no new library work needed |

**Necessary owner wrapper:** selected error mapping/truncation boundary.

**Avoidable or conditional wrapper:** manual escape table; extra serializer dependency.

- Current serde_json to_string already adopted; ESCAPE table only escapes controls/quote/backslash. Astral truncation mismatch is classified accident, not library failure.

**Maintenance conclusion:** Serializer already owns valid-str escaping.

**Proposed next action:** Retain; truncation/lossless UTF16 gates remain separate.

**Source:** [packages/values/semantics/src/codecs/numeric.rs:152](/Users/vince/Projects/canlang/packages/values/semantics/src/codecs/numeric.rs:152).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

**Unresolved authority/domain:** vv.string-diagnostics: Rust-valid-str diagnostic JSON quoting uses standard short C0 escapes/lowercase hex, no slash/U+2028 escaping, then existing truncation; lone JS surrogates are outside Rust str.; vv.errors-prose: Current error prose, punctuation, expected/actual truncation, optional field presence and Error name/own-field order are captured for public/native parity. Exact error text is not itself numeric semantics.

## uri-identity-encoding

encodeURIComponent bytes over UTF16 stored ID components. **Assessment:** recommend finite narrow candidate, not default adoption.

**Contracts:** `SW-056`, `SW-063`, `SW-077`, `SW-086`.

**Required outcomes:** Preserve persisted URI escape set A-Z a-z 0-9 -_.!~*'(), uppercase hex, UTF8, no plus, lone-surrogate URIError.

**Pinned candidates / primitives:**

- **percent-encoding 2.3.2** — UNADOPTED evaluation version; cached registry source only. License: MIT OR Apache-2.0. Entry/features: utf8_percent_encode; NON_ALPHANUMERIC.remove(-_.!~*'()); evaluate default-features=false, alloc. Dependencies: `{}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current copied encoder | fits static profile; roughly 50-line loop per copied owner plus errors | sync registered Rust candidate; production joins not proven | manual UTF8/percent mechanics duplicated |
| library_with_minimum_wrapper: percent-encoding minimum wrapper | good narrow candidate; strict UTF16 conversion; one constant escape set; encode then ASCII units; owning URIError | alloc feature only possible; no init, no std requirement | adds small crate, removes byte formatting loop; surrogate and identity policy remain |
| platform_primitive: platform encodeURIComponent | best current TS route; direct JS operation | JS hosts; native Rust no direct primitive | no dep on JS side |
| retain_now: retain-now | reasonable until next rows packet; keep current native candidate | current package assembly only | no dependency closure work now |

**Necessary owner wrapper:** strict UTF16 conversion/error translation; exact ASCII set; carrier output.

**Avoidable or conditional wrapper:** hand-written codepoint-to-UTF8 and percent-hex loop; cross-package generic transport.

- Use NON_ALPHANUMERIC.remove for nine allowed punctuation bytes, not generic URL/form encoder. UTF8 function accepts str so use strict String::from_utf16 before encoding; do not use from_utf16_lossy. URIError prose engine variable at current source.

**Maintenance conclusion:** Remove codepoint/percent loop with exact ASCII set and strict UTF16 admission.

**Proposed next action:** Small named identity/URI packet, no broad URL normalizer.

**Source:** [packages/work-kernel/decisions/rows.rs:283](/Users/vince/Projects/canlang/packages/work-kernel/decisions/rows.rs:283); [packages/work-kernel/decisions/receipt.rs:303](/Users/vince/Projects/canlang/packages/work-kernel/decisions/receipt.rs:303); [packages/work-kernel/decisions/linkage.rs:299](/Users/vince/Projects/canlang/packages/work-kernel/decisions/linkage.rs:299).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

## calendar-zone

civil math and fold/gap inversion. **Assessment:** evaluate targeted zone inversion; retain civil-now.

**Contracts:** `vv.temporal-civil`, `vv.date-range`, `vv.instant-duration`, `vv.datetime-constructor-domain`, `vv.local-conversion`, `vv.zone-data`, `vv.fold-unambiguous-order`.

**Required outcomes:** 0001..9999 ISO Gregorian; original anchor month clamp; half-open interval limits; exact ms; explicit fold ambiguity; gap rejection; release-pinned data.

**Pinned candidates / primitives:**

- **@js-temporal/polyfill 0.5.1** — UNADOPTED selected evaluation tag v0.5.1; absent bun.lock. License: ISC. Entry/features: import {Temporal}; package ESM/CJS, no global patch required. Dependencies: `{"jsbi": "^4.3.0"}`.

- **jiff 0.2.37** — UNADOPTED evaluation version; cached registry source only. License: Unlicense OR MIT. Entry/features: civil::Date/DateTime; TimeZone::to_ambiguous_zoned; evaluate defaults=false std,tzdb-bundle-always plus explicit bundled database source, not global system fallback. Dependencies: `{"arbitrary": {"version": "1.4.2", "features": ["derive"], "optional": true}, "defmt": {"version": "1.0.0", "optional": true}, "jcore": {"version": "0.1.0", "default-features": false, "package": "jiff-core"}, "jiff-static": {"version": "0.2", "optional": true}, "jiff-tzdb": {"version": "0.1.8", "optional": true}, "log": {"version": "0.4.21", "optional": true, "default-features": false}, "serde_core": {"version": "1.0.221", "optional": true, "default-features": false}}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current civil and Intl probes | baseline outcome, incomplete data determinism; range/grammar/own carriers plus current inversion | JS Intl host, native civil only | small civil algorithms; custom transition probe maintenance |
| library_with_minimum_wrapper: Temporal minimum wrapper | credible JS calendar/inversion replacement; Can grammar/range/carriers; roundtrip gap guard; original-anchor arithmetic; interval bounds | polyfill explicit import, JSBI; host Intl remains; native Temporal availability unproved | adds broad library/bundle; removes custom inverse/calendar mechanics, not data pin burden |
| library_with_minimum_wrapper: jiff minimum wrapper | credible native owner slice; explicit bundled database; reject Gap via ambiguity enum; range/grammar/error/carrier adapters | Rust alloc/std selection; no system fallback; optional Wasm js not automatically needed | timezone database delivery/pin and update maintenance; removes inversion mechanics |
| platform_primitive: platform Date/Intl/Temporal | Date/Intl current available; Temporal unqualified; Date alone needs strict range/calendar adapters; Temporal same gap guard | host ICU/availability must be pinned | zero library but host version/data maintenance |
| retain_now: retain-now | best until data/host packet selected; keep existing owner semantics and fail-closed route | existing hosts only | avoid adding two date stacks before adoption |

**Necessary owner wrapper:** Can grammar/range, exact carriers, anchor/interval budget, gap refusal and explicit fold, pinned database/host selection.

**Avoidable or conditional wrapper:** manual transition probe algorithm if qualified candidate owns inversion; permanent exact error prose emulation.

- Temporal compatible/earlier/later normalize gaps: roundtrip selected result to reject; explicit ISO and reject overflow on admission. PlainDate supports broader years so range checks remain. Jiff AmbiguousOffset distinguishes Gap/Fold/Unambiguous; reject Gap then earlier/later. Jiff default system tzdb conflicts with release pin; evaluate explicit bundled source without system discovery. Temporal polyfill uses host Intl timezone data; package version does not pin tzdb.

**Maintenance conclusion:** Qualified zone inversion may remove transition probe loop.

**Proposed next action:** Resolve exact database/host release and gap/fold policy first; retain civil mechanics now.

**Source:** [packages/values/src/temporal.ts:85](/Users/vince/Projects/canlang/packages/values/src/temporal.ts:85); [packages/values/src/timezone.ts:203](/Users/vince/Projects/canlang/packages/values/src/timezone.ts:203); [packages/values/semantics/src/temporal/civil.rs:1](/Users/vince/Projects/canlang/packages/values/semantics/src/temporal/civil.rs:1).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof. Evaluate jiff-tzdb0.1.8 explicit data delivery (primary docs below); exact IANA VERSION/data digest and closure unresolved, no default system database permitted by proposed release-pin outcome.

**Unresolved authority/domain:** vv.fold-unambiguous-order: local_instant currently requires earlier/later even when unambiguous and validates date→time→zone→fold before offset probes.

## decimal-rounding

exact coefficient/scale arithmetic. **Assessment:** retain BigInt/num-bigint; optional BigDecimal slice low priority.

**Contracts:** `vv.decimal-representation`, `vv.decimal-math`, `vv.round-operation`, `vv.aggregate-final`, `vv.decimal-print`, `vv.money-policy`.

**Required outcomes:** Exact arbitrary scratch; one half-even final rounding; 38 result digits and0..18 author scale; final-only aggregate cancellation; money int64 checks; canonical string wire.

**Pinned candidates / primitives:**

- **num-bigint 0.4.8** — locked current package dependency. License: MIT OR Apache-2.0. Entry/features: BigInt exact arithmetic; current std default; no serde/rand extras. Dependencies: `{"arbitrary": {"version": "1", "optional": true, "default-features": false}, "num-integer": {"version": "0.1.46", "features": ["i128"], "default-features": false}, "num-traits": {"version": "0.2.18", "features": ["i128"], "default-features": false}, "quickcheck": {"version": "1", "optional": true, "default-features": false}, "rand": {"version": "0.8", "optional": true, "default-features": false}, "serde": {"version": "1.0", "optional": true, "default-features": false}}`.

- **bigdecimal 0.4.9** — UNADOPTED selected evaluation tag v0.4.9. License: MIT OR Apache-2.0. Entry/features: BigDecimal::new/with_scale_round(HalfEven); default std; no serde-json. Dependencies: `{"num-bigint": "0.4", "num-integer": "0.1", "num-traits": "0.2", "libm": "0.2.6", "build:autocfg": "1"}`.

- **rust_decimal 1.39.0** — UNADOPTED selected evaluation tag 1.39.0. License: MIT. Entry/features: evaluate defaults=false std; optional serde cannot fix precision. Dependencies: `{"arrayvec": "0.7", "num-traits": "0.2"}`.

- **decimal.js 10.6.0** — values dev dependency only; exact 10.6.0 installed manifest verified by originating Codex; no production arithmetic adoption. License: MIT. Entry/features: Decimal.clone with isolated precision/rounding; ESM decimal.mjs or CJS decimal.js. Dependencies: `{}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current BigInt/num-bigint | fits exact scratch and small rounding; Rust rational core41 lines; DecimalParts guards, retained stored scale | JS BigInt native/Rust current std | existing mechanism; concise Can numeric policy |
| library_with_minimum_wrapper: BigDecimal narrow wrapper | plausible scaled rounding helper, no demonstrated net reduction; new(coef,scale), with_scale_round(HalfEven), extract parts; Can bounds/lexeme/scale and direct rational division remain | Rust synchronous; no global init; adds libm/autocfg | second abstraction on existing num-bigint, can remove scaled rounding only |
| library_with_minimum_wrapper: rust_decimal wrapper | fails same full domain; would need fallback/widened arithmetic and final checks | Rust std optional serde disabled | extra dual engine outweighs narrow fast slice |
| library_with_minimum_wrapper: decimal.js clone wrapper | not drop-in; selected test dev pin only; isolated precision policy, sized scratch, author-scale metadata, final bounds, zero failures; no global config | ESM/CJS; no runtime dep; exact installed manifest verified; runtime/host behavior unqualified | larger arithmetic surface plus wrapper; no warranted whole replacement |
| platform_primitive: platform BigInt | best JS primitive; Rust num-bigint is counterpart; current coefficient/scale/rational rules | no init; arbitrary-width scratch | small numeric semantics remain owned |
| retain_now: retain-now | preferred maintenance outcome; keep one integer substrate and Can rounding | current targets | no evidence second decimal abstraction simplifies full responsibility |

**Necessary owner wrapper:** result-only limits; scale carriage; money/currency/lexeme policies; exact rational final rounding.

**Avoidable or conditional wrapper:** generic decimal framework or elaborate fixed-precision guard engine merely for library use; exact -0-scale emulation pending owner decision.

- rust_decimal 96-bit coefficient cannot represent 38 digits; widening wrappers recreate arithmetic. BigDecimal new and with_scale_round(HalfEven) fit scale alignment/rounding; default division context precision must not silently decide final Can result. decimal.js can use clone with high/sized precision, not merely precision38; Can accepts raw wide BigInt inputs and aggregate cancellation, so fixed guard precision cannot satisfy every public baseline without domain resolution. Author scale must remain separate from decimal.js normalized value.

**Maintenance conclusion:** A large decimal framework is not a necessary simplification.

**Proposed next action:** Keep exact BigInt/num-bigint; evaluate a finite rounding primitive only for demonstrated benefit.

**Source:** [packages/values/src/decimal.ts:71](/Users/vince/Projects/canlang/packages/values/src/decimal.ts:71); [packages/values/semantics/src/numeric/rounding.rs:21](/Users/vince/Projects/canlang/packages/values/semantics/src/numeric/rounding.rs:21); [packages/values/semantics/src/numeric/decimal.rs:19](/Users/vince/Projects/canlang/packages/values/semantics/src/numeric/decimal.rs:19).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

**Unresolved authority/domain:** vv.raw-bigint-domain: Public arithmetic/compare entries accept raw arbitrary-width BigInts, narrow only their operation result; compareInt has no int64 operand narrowing.; vv.decimal-scale-negative-zero: TS Decimal stores scale -0 distinguishably by Object.is; scalar Wasm carrier explicitly refuses it instead of normalizing to u8/JSON0.; vv.decimal-structural-admission: isDecimal admits structural {kind:decimal,coef:bigint,scale:integer} through range/digit checks without requiring Decimal class identity.

## icu-parser

bounded ICU syntax and typed interpreter. **Assessment:** retain parser now; no parser fork for library count.

**Contracts:** `vv.icu-profile`, `vv.icu-descriptor`, `vv.icu-exact-display`, `vv.prototype-policy`.

**Required outcomes:** Bounded named profile; exact branches first; mandatory other; typed nonnullable signature/disclosure for all arguments; no rich tags/offsets/skeleton/executable syntax.

**Pinned candidates / primitives:**

- **@formatjs/icu-messageformat-parser 2.11.4** — UNADOPTED selected evaluation tag @formatjs/icu-messageformat-parser@2.11.4; absent bun.lock. License: MIT. Entry/features: parse options requiresOtherClause=true, shouldParseSkeletons=false; retain tag AST to reject tags, ignoreTag=true makes them literal rather than refusing. Dependencies: `{"@formatjs/ecma402-abstract": "workspace:* in upstream tag; published resolution unqualified", "@formatjs/icu-skeleton-parser": "workspace:* in upstream tag; published resolution unqualified", "tslib": "^2.8.0"}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current owner parser | fits current public syntax and required typed profile; ~287-line parser core plus owning validation/interpreter | sync JS, no init | custom parser maintenance; no external deps |
| library_with_minimum_wrapper: FormatJS parser minimum wrapper | partial fit; major exact-selector domain blocker; AST restrict profile/styles/tags/offset; bounded admission before parse; canonical duplicates; retain typed interpreter | JS ESM/CJS; upstream workspace transitive pin unresolved | would require exact-selector parser fork or lexer rewrite; likely recreates core |
| platform_primitive: platform Intl | not parser replacement; requires existing parser and typed interpreter | Intl host | plural/format primitive only |
| retain_now: retain-now | preferred pending exact domain/syntax owner packet; current parser, adjudicate exact32 and residual prose separately | current JS owner | avoid maintained fork and double parser |

**Necessary owner wrapper:** typed descriptor/disclosure/interpreter; profile refusal and finite resource bound.

**Avoidable or conditional wrapper:** exact error prose recreation; rich message evaluator; automatic exact32 permanence; second lexer solely to encode unsupported selectors.

- requiresOtherClause handles mandatory other. shouldParseSkeletons=false alone does not reject skeleton-looking styles; AST profile checks needed. ignoreTag=true treats tag syntax as literal rather than failing; retain tags and refuse AST tags if adopting. Pinned exact parser admits safe integers only; fractional and large exact selector baseline need redesign/fork/token rewrite, not resolved by options. Lexical duplicate set differs from Can numeric normalization. Parser depth option absent in inspected ParserOptions; post-AST depth alone not allocation bound.

**Maintenance conclusion:** Unsupported exact selector domain would force a lexer/fork around the parser.

**Proposed next action:** Retain current bounded parser; reconsider if owning supported grammar changes.

**Source:** [packages/values/src/icu.ts:267](/Users/vince/Projects/canlang/packages/values/src/icu.ts:267); [packages/values/src/icu.ts:642](/Users/vince/Projects/canlang/packages/values/src/icu.ts:642); [packages/values/src/icu.ts:822](/Users/vince/Projects/canlang/packages/values/src/icu.ts:822).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

**Unresolved authority/domain:** vv.icu-nesting-cap: Owner ICU parser caps nesting at32 before building unbounded nested trees.; vv.icu-syntax-residual: Outside-plural # and ten other compiler-vs-owner syntax observations remain separately queued proposals, not automatic permission to retain compiler drift or rewrite owner parser.; vv.errors-prose: Current error prose, punctuation, expected/actual truncation, optional field presence and Error name/own-field order are captured for public/native parity. Exact error text is not itself numeric semantics.

## intl-exact-display

locale exact digits/grouping. **Assessment:** recommend platform exact string route qualification.

**Contracts:** `vv.icu-exact-display`, `vv.zone-data`, `vv.icu-safe-plural-subdomain`.

**Required outcomes:** Required: exact typed numeric/currency and locale display (vv.icu-exact-display), data release pin (vv.zone-data). Current public baseline: author-scale fractional zeros; retain or explicitly adjudicate consumer-facing change, not independently asserted original product mandate.

**Pinned candidates / primitives:**

- No new dependency candidate: compare the recorded platform API / small owner mechanism.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current symbol/group assembler | exact numeric magnitude, locale fidelity incomplete; numberSymbols~32 lines/groupIntegerDigits16 lines plus digit assembly | current Intl host; no init | manual locale mechanics |
| platform_primitive: Intl exact string minimum wrapper | strong candidate at qualified hosts; exact signed decimal string from coef/scale; min=maxFractionDigits=scale; format/formatToParts; type/disclosure checks remain | synchronous Intl, host feature/data qualification; no dependency | removes grouping/digit/bidi reconstruction; host locale pin still owed |
| library_with_minimum_wrapper: library Intl polyfill | unselected; unnecessary until host gap established; same exact scalar wrapper plus installed polyfill/data selection | extra JS payload/init | adds data burden without evidenced unsupported target |
| retain_now: retain-now | fallback while host qualification pending; keep current display in current profile | existing host | avoid host-incompatible switch; no claimed output parity |

**Necessary owner wrapper:** exact decimal-string construction; scale fraction options; typed disclosure; actual host and data pin.

**Avoidable or conditional wrapper:** manual grouping, localized-digit and bidi reconstruction once platform qualifies; plural rewrite.

- ECMA402 edition12 exact string conversion exists; actual supported JS host must qualify. Set min/max fraction digits to owning retained scale (0..18) to prevent default max3 rounding. Do not route through Number. Native BigInt works for integer channel. Current manual grouping emits ASCII digits and misses host bidi literal/min-grouping behavior; exact current output not automatically normative. Intl.PluralRules still separate unsafe numeric subdomain.
- ASCII digits/manual omission of bidi/minimum grouping are observed mechanism outputs, not proven required permanent locale behavior. Retained fractional zeros are current baseline, not extra product authority.

**Maintenance conclusion:** Potentially remove manual locale grouping/digits/bidi reconstruction.

**Proposed next action:** Qualify exact string route on each supported host/data version and current output consumers.

**Source:** [packages/values/src/icu.ts:1035](/Users/vince/Projects/canlang/packages/values/src/icu.ts:1035).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

**Unresolved authority/domain:** vv.icu-safe-plural-subdomain: Current Intl plural selection rejects operands beyond safe conversion rather than silently losing precision, while exact-selector comparison and exact display have different paths.

## semantic-owner-core

numeric substrate, schemas and plan provenance. **Assessment:** retain owner semantics and existing primitives.

**Contracts:** `vv.int-result`, `vv.aggregate-final`, `vv.schema-defaults`, `vv.schema-initializer-order`, `vv.schema-operations`, `vv.plan-owner-lifetime`, `vv.prepared-gate`.

**Required outcomes:** One canonical declared validation authority; defaults omission versus update sentinel; initializer context/order; typed exact outcomes; live owner/backend/revision/lifetime handles.

**Pinned candidates / primitives:**

- **num-bigint 0.4.8** — locked current package dependency. License: MIT OR Apache-2.0. Entry/features: BigInt exact arithmetic; current std default; no serde/rand extras. Dependencies: `{"arbitrary": {"version": "1", "optional": true, "default-features": false}, "num-integer": {"version": "0.1.46", "features": ["i128"], "default-features": false}, "num-traits": {"version": "0.2.18", "features": ["i128"], "default-features": false}, "quickcheck": {"version": "1", "optional": true, "default-features": false}, "rand": {"version": "0.8", "optional": true, "default-features": false}, "serde": {"version": "1.0", "optional": true, "default-features": false}}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current canonical core | fits declared semantics and authority; Can recursive defaults/typed errors/owner plans | current JS/Rust conditional profiles | policy code substantial but inherently owner-specific |
| library_with_minimum_wrapper: num-bigint minimum wrapper | already appropriate numeric primitive; result guards and typed Can parts | native std, no init | removes integer implementation while retaining meaningful semantics |
| platform_primitive: platform BigInt/data traversal | good JS substrate; same owner validation policy | JS host | no second schema runtime |
| retain_now: retain-now | best current plan; retain canonical engine; narrow legacy domain separately | no default changes | avoid generic library plus duplicate Can engine |

**Necessary owner wrapper:** typed semantic rules; omission/context; provenance/lifetime/default attribution.

**Avoidable or conditional wrapper:** second validator; universal emulation of arbitrary host objects beyond actual supported callers.

- Generic schema engine not evaluated/pinned here; no evidence to add one. Required defaults/context/provenance survive any mechanics substitution; arbitrary getters/proxies exact trace profile remains selected baseline rather than eternal semantic obligation.

**Maintenance conclusion:** Library validation engines do not own context/default order/provenance.

**Proposed next action:** Keep one Can semantic core; outsource exact primitive mechanics.

**Source:** [packages/values/src/schema.ts:1](/Users/vince/Projects/canlang/packages/values/src/schema.ts:1); [packages/values/src/internal/schema-core.ts:600](/Users/vince/Projects/canlang/packages/values/src/internal/schema-core.ts:600); [packages/values/src/prepared/plan.ts:400](/Users/vince/Projects/canlang/packages/values/src/prepared/plan.ts:400); [packages/values/semantics/src/plans.rs:298](/Users/vince/Projects/canlang/packages/values/semantics/src/plans.rs:298).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

**Unresolved authority/domain:** vv.legacy-traces: Retained arbitrary unknown paths preserve getters/proxies/ownKeys/toJSON/cycles/sparse arrays/custom prototypes/throws and object identity; trace comparator observes descriptors without adding getter reads and excludes stacks.; vv.schema-undefined-order: Values validator ignores undefined unknown keys, treats known undefined as omission, accumulates unknown violations before declared-field traversal in JS enumeration/declaration order, with nullable-array precedence.; vv.default-identity: Prepared owner defaults resolve from frozen shared registry to same object; update omission and engine-resolved markers materialize existing symbols/drop rules.; vv.raw-bigint-domain: Public arithmetic/compare entries accept raw arbitrary-width BigInts, narrow only their operation result; compareInt has no int64 operand narrowing.

## lossless-transport

typed JSON envelope and admitted JS tagged tree. **Assessment:** retain tagged transport over existing serde.

**Contracts:** `CF-C31`, `vv.structural-carrier`, `vv.structural-mint-budget`, `vv.transport-f64-roundtrip`.

**Required outcomes:** Preserve admitted UTF16/lone surrogates, ordered own keys including __proto__, exact f64 bits/text; transport budget before narrowing and semantics.

**Pinned candidates / primitives:**

- **serde_json 1.0.151** — locked current package dependency. License: MIT OR Apache-2.0. Entry/features: to_string(str), typed Deserialize; current std default; values float_roundtrip; preparation std; work dev only. Dependencies: `{"indexmap": {"version": "2.2.3", "optional": true}, "itoa": {"version": "1.0"}, "memchr": {"version": "2", "default-features": false}, "serde_core": {"version": "1.0.220", "default-features": false}, "zmij": {"version": "1.0"}}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: current serde plus tagged nodes | fits finite admitted tree; WireNode/Node enums, limits and checked decoding | synchronous process; native preparation HOLD | standard grammar delegated, Can carrier owned |
| library_with_minimum_wrapper: serde minimum wrapper | already nearly selected architecture; typed envelope, UTF16 unit arrays, bit/spelling fields, ordered entry arrays and budgets | std current; alloc possible not selected; no async runtime | no extra serialization framework; preserve_order not needed |
| platform_primitive: platform JSON.parse/stringify | fits outer host envelope and producer; tags still needed across Rust Unicode/number representation | JS host primitive plus paired native reader | cannot remove semantic tags by JSON alone |
| retain_now: retain-now | preferred; keep tagged carrier and framing owner | prototype native job callers only | no MSGPACK/JSONRPC/init burden |

**Necessary owner wrapper:** UTF16 arrays; bits/spelling; ordered entries; finite node/depth/text/frame bounds; owner stage/lifetime.

**Avoidable or conditional wrapper:** general JSONRPC/async runtime; preserve_order/indexmap solely for array-carried keys; arbitrary_precision or unbounded_depth without need; arbitrary host object emulation.

- serde preserve_order preserves Rust String key insertion only; arbitrary_precision preserves numeric text but not signed-zero bits/nonfinite/lone UTF16. raw_value delays parse not semantic admission. unbounded_depth removes protection and unnecessary here. Existing default map ordering not relevant to entry arrays. Values float_roundtrip is for f64 request roundtrip; preparation numbers already bit/text tags; Work serde only dev.

**Maintenance conclusion:** Tags carry semantics unavailable in JSON serializer feature switches.

**Proposed next action:** Keep one bounded carrier and serde machinery; do not add another generic bridge.

**Source:** [packages/cloudflare/preparation/src/input.rs:1](/Users/vince/Projects/canlang/packages/cloudflare/preparation/src/input.rs:1); [packages/cloudflare/src/preparation/inputs.ts:120](/Users/vince/Projects/canlang/packages/cloudflare/src/preparation/inputs.ts:120); [packages/cloudflare/preparation/src/render.rs:103](/Users/vince/Projects/canlang/packages/cloudflare/preparation/src/render.rs:103).

**Qualification gaps:** No new runtime equivalence, builds, tests, install, target-size measurements, whole-host/default adoption or deployed-state proof.

**Unresolved authority/domain:** vv.structural-nan-exclusion: Owned arena rejects every NaN bit pattern as corrupt/nan-bits before materialization, despite broader base transport preservation prose.

## csv-parse

ui-csv-grammar; ui-csv-client; interfaces-csv. **Assessment:** retain adopted library; separately resolve incomplete required joins.

**Contracts:** `AD-ui-csv-grammar`, `AD-csv-exact-grammar`, `AD-csv-product-map`, `AD-csv-current-map`, `AD-csv-current-review`, `AD-csv-size-gap`, `AD-csv-digest-wire`, `AD-csv-row-transactions`, `cv.csv-limits`.

**Required outcomes:** Raw strings/BOM/lone CR/blank and mismatched records preserved; LF/CRLF/comma/doubled multiline quotes; no cast/trim/skip; malformed quotes and unpaired UTF16 deliberately reject. Full parse precedes1000-row limit. Typed nullable/text/exact/ref/closed-JSON mapping and configured private business review remain mandatory distinct outcomes; server canonical row invocation and stable replay identity.

**Pinned candidates / primitives:**

- **csv-parse 7.0.3** — already adopted at pin; local root installation absent; exact published source inspected. License: MIT. Entry/features: csv-parse/browser/esm/sync; synchronous pure parse. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing at pin | Good grammar fit; product joins incomplete; Existing scalar-string/error/shape/row-limit wrapper | No async init; browser ESM source; installed Worker handler receipt narrow | Zero runtime transitive deps; parser ownership outsourced |
| library_with_minimum_wrapper: library plus minimum owner wrapper | Same as existing; retain; Encoding scalar admission, fixed safe error mapping, row counts; caller retains typed mapping | No init; qualify browser/Worker delivery separately | Avoid second parser |
| platform_primitive: platform primitive | TextEncoder/Decoder only handles scalar string; no CSV grammar; Would require hand parser | Portable encoders; no built-in CSV | Recreates grammar maintenance |
| retain_now: retain-now | Retain adopted library seam and refuse claims of full workflow; Existing minimal wrapper | Same host gates | No reimplementation |

**Necessary owner wrapper:** scalar admission; safe parse fault mapping; header/row shape and limit; owning typed/business review.

**Avoidable or conditional wrapper:** second CSV scanner; reproducing obsolete quote stripping; business invocation engine in parser.

- Explicit record_delimiter=[CRLF,LF] prevents autodetected CR normalization; relax_column_count=true retains mismatch evidence. max_record_size/to/skip options would change current full-count/error-order behavior.
- Do not claim parser supplies schema mapping/review/consent.

**Maintenance conclusion:** Shared strict parser owns grammar; business/private-context gaps are elsewhere.

**Proposed next action:** Retain grammar seam; resolve typed mapping/review/receipt joins separately.

**Source:** [packages/ui/src/csv/grammar.ts:28](/Users/vince/Projects/canlang/packages/ui/src/csv/grammar.ts:28); [packages/interfaces/src/http/csv.ts:156](/Users/vince/Projects/canlang/packages/interfaces/src/http/csv.ts:156); [packages/ui/src/csv/parse.ts:119](/Users/vince/Projects/canlang/packages/ui/src/csv/parse.ts:119).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. No exact root installed csv-parse package found; historical private installed-workerd receipt27 checks is controlled handler/memory+scripted invoker, no durable mount/browser workflow.

**Unresolved authority/domain:** Flat empty-cell omission conflicts full typed mapping; consent private app/team/user24h and owning per-row review join missing (SEC14/F03).; 10MiB source versus generic1MiB JSON transport unresolved; CSV early age gate versus receipt-first replay (F04).

## csv-export-stringify

interfaces-export; ui-escaping. **Assessment:** retain now; csv-stringify conditional viable for quoting only.

**Contracts:** `AD-export-csv-bytes`, `AD-interfaces-export`, `AD-export-download-gap`.

**Required outcomes:** id/version/requested-column ordering; LF trailing terminator; null empty,file opaque ID,secret refusal; quote comma/quote/LF/CR and double quotes; armor whitespace-leading=+-@ before quoting. Current-authority bounded projection and honest pending/truncated status remain independent.

**Pinned candidates / primitives:**

- **csv-stringify 6.6.0** — evaluation only; not installed/adopted. License: MIT declared in package/official metadata; LICENSE file absent from published tarball. Entry/features: browser/esm/sync; record_delimiter,eof,quoted_match; preproject string rows. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Exact tiny quoting/armor fits; Projection,armor,small quoting | sync no init | No dependency; tiny fixed mechanism |
| library_with_minimum_wrapper: library plus minimum wrapper | Plausible quoting fit conditional on exact byte qualification; Preproject and armor string row copies; fixed stringify options only | browser sync export no init; Worker closure unqualified | Extra zero-dep package and browser bundle; no parser duplicate |
| platform_primitive: platform primitive | No built-in CSV encoder; Existing small escape | all hosts | Small stable maintenance |
| retain_now: retain-now | Best current tradeoff until export complexity grows; Existing | same | No speculative dependency |

**Necessary owner wrapper:** projection and secret/file authority; selected formula armor; column ordering and explicit LF/eof options.

**Avoidable or conditional wrapper:** second quoting scanner alongside stringify; per-cell custom stringify casts recreating library internals.

- escape_formulas=true differs: first-character tab/CR/fullwidth operators included, whitespace preceding ASCII operators omitted; disable and retain selected owner rule.
- Use quoted_match regex for bare CR/LF independent of delimiter selection; eof=true; avoid object auto columns/type casts and caller row splice via columns.
- Pinned export.ts:260 joins LF and appends LF. Evaluate record_delimiter="\n", eof=true, quoted_match=/[,"\r\n]/, escape_formulas=false plus owning armor. CRLF would change the current bytes; no such adoption was selected.

**Maintenance conclusion:** Quoting can move to library, but owner armor and projection remain.

**Proposed next action:** Require a net code/burden reduction over the small LF serializer; preserve exact output corpus.

**Source:** [packages/interfaces/src/http/export.ts:159](/Users/vince/Projects/canlang/packages/interfaces/src/http/export.ts:159).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Exact bytes including empty/header-only/bare-CR/LF and quote/armor cases unexecuted; official package tarball integrity inspected,delivered closure unqualified. Published csv-stringify6.6.0 has MIT package declaration but lacks LICENSE file; versioned repository MIT license inspected; ensure attribution notice in delivered/vendored artifact.

**Unresolved authority/domain:** Large private export job/status/download authorization join incomplete.

## identity-codecs

identity-credentials; identity-password; identity-resolution. **Assessment:** retain adopted scure seam.

**Contracts:** `AD-identity-credentials`, `AD-identity-password`, `AD-identity-public-surface`.

**Required outcomes:** 32-byte unpredictable canonical unpadded token issuance; lowercase SHA256 over exact bearer UTF8 text. Persisted PBKDF2 salt/key decoder supports established nonzero unused tail aliases; malformed/empty hex false deliberately corrected; password iteration/derivation fault contract preserved.

**Pinned candidates / primitives:**

- **@scure/base 2.4.0** — already adopted; root installation absent; exact published source inspected. License: MIT. Entry/features: ESM index.js hex/base64urlnopad. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Good narrow wrapper; Guard+tail mask+catch-to-null | pure ESM no init; WebCrypto hashing separate | Zero runtime deps |
| library_with_minimum_wrapper: library plus minimum owner wrapper | Same existing good fit; Exactly final-sextet mask, malformed return shape; no codec fork | Node/Worker ESM delivery | One codec library |
| platform_primitive: platform primitive | Node Buffer codecs permissive and Node closure; btoa/atob need alphabet/byte transforms; Would require admission/canonicalization guards | Node-only Buffer or browser globals | Additional host divergence |
| retain_now: retain-now | Retain adopted library/wrapper; Same | qualify actual emitted Node22/Worker | No additional packages |

**Necessary owner wrapper:** established alphabet/length/empty guard; tail-bit alias mask for decoder only; public malformed return shape.

**Avoidable or conditional wrapper:** hand hex/base64 loops; masking raw bearer; retaining unsafe0g hex parse.

- Strict library decoder rejects nonzero unused tail bits; final sextet mask only after established alphabet/length guard preserves released password decoder domain.
- Never decode/mask bearer before hashing; text aliases remain different lookup hashes.

**Maintenance conclusion:** One codec plus finite old-password alias normalization; bearer hashing is text-specific.

**Proposed next action:** Retain; any historic decoder-domain tightening requires a separate transition.

**Source:** [packages/identity/src/sessions/tokens.ts:21](/Users/vince/Projects/canlang/packages/identity/src/sessions/tokens.ts:21); [packages/identity/src/accounts/passwords.ts:1](/Users/vince/Projects/canlang/packages/identity/src/accounts/passwords.ts:1).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Root exact installation absent; saved extracted metadata/file hashes and witness receipt support prior investigation only; no deployed noncanonical record proven.

**Unresolved authority/domain:** No actual deployed historic password-row inventory; strict new read profile would require transition, not silently discard aliases.

## identity-native-comparison

identity-comparison; identity-credentials; identity-password; identity-csrf. **Assessment:** retain adopted platform primitives.

**Contracts:** `AD-identity-comparison`, `AD-identity-password`, `AD-identity-csrf`.

**Required outcomes:** Sync unequal byte lengths false then native equal-length primitive; empty equal true; unsupported equal-length host fixed operational error; no JS fallback. Password malformed/derive errors false but comparator operational errors propagate; UTF8 surrogate replacement preserved.

**Pinned candidates / primitives:**

- **Node crypto / workerd WebCrypto Node>=22; saved Node24.21.0, Miniflare4.20260730.0,compatibilityDate2026-07-15 flags[]** — already adopted platform binding. License: host distribution licenses; no new npm dependency. Entry/features: private node/default condition leaves; sync native comparison; standard digest/PBKDF2 separate. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Good fit; length guard+private host leaf | No caller init; native static Node or receiver-preserving Worker method | Finite packaging/delivery burden |
| library_with_minimum_wrapper: library plus minimum wrapper | No npm library needed; use host native; same | conditional leaf; unsupported visibly fails | No transitive deps |
| platform_primitive: platform primitive | Best fitting mechanism; Length guard and host binding required | Node22 crypto; selected workerd extension | Hosts own primitive maintenance |
| retain_now: retain-now | Retain current native seam; same | Keep support floor and closure gates | Do not return to loops |

**Necessary owner wrapper:** length check; private conditional leaf; fixed missing-host error.

**Avoidable or conditional wrapper:** JS timing fallback; mutable injected global comparator; HMAC equality invention.

- Worker native equality is nonstandard; standard WebCrypto HMAC/verify is async and different protocol, not sync API replacement.
- Package node/default map and Cloudflare owned rewrite/exclusion avoid Node builtins in Worker.

**Maintenance conclusion:** Native host primitive replaces unsafe JS byte-loop comparison.

**Proposed next action:** Retain host refusal/no-fallback seam; no whole timing/authenticity claim.

**Source:** [packages/identity/src/sessions/comparison.ts:1](/Users/vince/Projects/canlang/packages/identity/src/sessions/comparison.ts:1); [packages/identity/src/sessions/comparison-node.ts:1](/Users/vince/Projects/canlang/packages/identity/src/sessions/comparison-node.ts:1); [packages/identity/src/sessions/comparison-worker.ts:1](/Users/vince/Projects/canlang/packages/identity/src/sessions/comparison-worker.ts:1); [packages/identity/package.json:1](/Users/vince/Projects/canlang/packages/identity/package.json:1).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Saved controlled workerd identity27 checks/primitive15 checks not full OAuth/atomicity; earliest Node22 missing per host contract.

**Unresolved authority/domain:** Earliest Node22 installed qualification not proven by Node24 receipt; no full auth workflow/atomicity proof.

## session-cookie

identity-cookie. **Assessment:** retain adopted cookie seam.

**Contracts:** `AD-identity-cookie`, `AD-identity-public-surface`.

**Required outcomes:** First matching JS-trim name group; first empty/malformed refuses; decode once,quotes literal; header arrays order. Finite attribute order,positive MaxAge,Secure default,clear0,URI encode precedence; invalid/empty Domain deliberate rejection.

**Pinned candidates / primitives:**

- **cookie 2.0.1** — already adopted; root installation absent; exact published source inspected. License: MIT. Entry/features: parseCookie/stringifySetCookie ESM dist/index.js. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Good fit; Target selection,decode refusal,Domain empty guard,safe errors,generated output reorder | No init; Node>=22 ESM; Worker emitted closure | Zero runtime deps |
| library_with_minimum_wrapper: library plus minimum wrapper | Same good fit; Existing bounded wrapper | same | No grammar duplication |
| platform_primitive: platform primitive | No server Cookie grammar primitive preserving signature; Manual parser/serializer required | Browser cookie APIs have different authority/lifecycle | Recreates grammar/security burden |
| retain_now: retain-now | Retain library; keep deliberate corrections; same | same qualification gates | No new mechanism |

**Necessary owner wrapper:** selected cookie target; once-only decode refusal; session defaults/public errors; bounded fixed generated-output order.

**Avoidable or conditional wrapper:** request-header scanner; second Domain regex; tolerant decode fallback; legacy invalid Domain emission.

- Default tolerant decode and undefined-skipping would let malformed first duplicate fall through; identity decoder then explicit selected decode avoids it.
- Library order differs finite accepted order; bounded generated-segment reorder is existing selected seam; no request-header rescan.

**Maintenance conclusion:** Library owns grammar; first-duplicate refusal/order remains finite selected policy.

**Proposed next action:** Retain now; reevaluate ordering only with actual external consumers.

**Source:** [packages/identity/src/sessions/cookies.ts:48](/Users/vince/Projects/canlang/packages/identity/src/sessions/cookies.ts:48); [packages/interfaces/src/http/auth.ts:1](/Users/vince/Projects/canlang/packages/interfaces/src/http/auth.ts:1).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Exact root package absent; saved hashed tarball/license source and prior controlled receipts; not new runtime proof.

**Unresolved authority/domain:** External attribute-order consumers not inventoried; finite accepted contract gives present authority; no need infer broad permanent order policy.

## abort-fan-in

services-http. **Assessment:** retain adopted primitive.

**Contracts:** `AD-services-http`.

**Required outcomes:** Caller cancellation distinguished from timeout/network; deadline spans full body/stream and redirects; bounded manual same-origin hops; quotas/no retries; timer cleanup.

**Pinned candidates / primitives:**

- **AbortSignal.any Node22.0.0 API; saved workerd4.20260730.0 receipt date2026-07-15 flags[]** — already adopted platform primitive. License: host licenses; no new dependency. Entry/features: Compose request/private timeout signals; winning reason. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Good fit; startDeadline+winning private reason+finally timer cleanup | No init; Node>=22 documented, saved selected workerd receipt | No own listeners or npm |
| library_with_minimum_wrapper: library plus minimum wrapper | No library better than primitive; same | same | Avoid polyfill dependency |
| platform_primitive: platform primitive | Best existing fit; Timer/error classification still owner | actual host support gate | Host maintained |
| retain_now: retain-now | Retain any implementation; same | No host policy change | No custom fan-in listeners |

**Necessary owner wrapper:** deadline timer and cleanup; winner error mapping; bounded body/origin/status rules.

**Avoidable or conditional wrapper:** custom signal listener fan-in; signal polyfill without unsupported host evidence.

- any composes only signals; does not create/release deadline timer,drain bounded bodies,enforce origin/status/privacy.
- Current redirect readBoundedBytes removes original audit unbounded drain observation.

**Maintenance conclusion:** Fan-in is delegated; deadlines, body budgets, redirects and cleanup are owner rules.

**Proposed next action:** Retain; no custom signal registry.

**Source:** [packages/services/src/http/client.ts:264](/Users/vince/Projects/canlang/packages/services/src/http/client.ts:264).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Existing saved H01/H02 narrow workerd cases do not cover all races/browser/production provider construction.

**Unresolved authority/domain:** Source reason identity could be ambiguous if caller deliberately uses identical private timeout reason, but private default DOMException reason inaccessible externally; no demonstrated gap.

## stable-json-identities

S-invoke; interfaces-csv; interfaces-export; services-media. **Assessment:** retain now; resolve finite admission/profile then reassess.

**Contracts:** `SW-009`, `SW-013`, `SW-014`, `AD-csv-digest-wire`, `AD-media-graph-digest`, `AD-export-csv-bytes`.

**Required outcomes:** Preserve historical receipt namespace/raw hash preimage and consent/media reviewed digest; sorted JSON bytes/SHA256 prefixes remain owner-specific. Failclosed raw replay admission distinct from export projection and media plain JSON assumptions.

**Pinned candidates / primitives:**

- **canonicalize 2.1.0** — evaluation only; not installed/adopted. License: Apache-2.0. Entry/features: CJS canonical serializer lib/canonicalize.js. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Preserves current identity but duplicated serializers differ; Owner profile and errors | WebCrypto state/CSV vs Node crypto media; no init | Known small logic; duplication potential |
| library_with_minimum_wrapper: library plus minimum owner wrapper | Conditional good on explicitly admitted JSON-only domain; poor universal fit; Admission before serializer and owner-specific hash/error/profile; no recursive clone emulating all legacy quirks | CJS bundling Worker must qualify | Zero transitive deps but duplicate traversal needed until domain resolved |
| platform_primitive: platform primitive | JSON.stringify alone preserves syntax not key sort or unsafe-admission policy; Sort/admit owner data then standard stringify | Node/Worker | No dependency; same finite admission work |
| retain_now: retain-now | Best until domain/profile joins resolved; evaluate shared admitted serializer per owner; Keep historic boundary; dedupe only demonstrated identical safe profile | Existing hosts | Avoid premature one-size-fits-all utility |

**Necessary owner wrapper:** chosen admitted-domain check; stable old byte identity/read profile; owning safe errors/digest prefix.

**Avoidable or conditional wrapper:** recursive wrapper mirroring canonicalize to claim adoption; new universal normalization; bulk rehash historical receipts.

- Canonicalize skips unsupported object fields,normalizes undefined/symbol array entries,reduce skips holes; current replay refuses; symbol keys not checked.
- toJSON and boxed/exotic objects must be evaluated per actual domain; plain JSON values can match sorted bytes but no verified universal adapter.

**Maintenance conclusion:** Library does not choose replay admission or historical digest preimage.

**Proposed next action:** Resolve persisted profiles per caller before a small shared JSON-only serializer packet.

**Source:** [packages/state/src/invocation/replay.ts:20](/Users/vince/Projects/canlang/packages/state/src/invocation/replay.ts:20); [packages/state/src/invocation/admission.ts:321](/Users/vince/Projects/canlang/packages/state/src/invocation/admission.ts:321); [packages/interfaces/src/http/csv.ts:237](/Users/vince/Projects/canlang/packages/interfaces/src/http/csv.ts:237); [packages/interfaces/src/http/export.ts:120](/Users/vince/Projects/canlang/packages/interfaces/src/http/export.ts:120); [packages/services/src/media/mapping.ts:53](/Users/vince/Projects/canlang/packages/services/src/media/mapping.ts:53).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Historic receipts/consents/media mapping inventory absent; CJS browser/Worker closure unqualified; no runtime bytes comparison.

**Unresolved authority/domain:** Accepted DESIGN normalized explicit inputs differs raw prevalidation hash (F07); historic input domain/getter/toJSON/host object traces unresolved, not permanent requirements.; Lossless effect staging domain F10 separate from replay; cannot invent historical inputs or use current objects to rehash receipts.

## file-signature-catalog

files-upload. **Assessment:** retain now; evaluate library upon supported catalog expansion.

**Contracts:** `AD-files-upload`, `AD-file-magic-scope`, `AD-file-digest-encoding`, `AD-files-provenance`.

**Required outcomes:** Actual bytes admission/default PDF PNG JPEG text max10MiB,selected app limits/quotas/current receiver; binary precedence; strict nonempty NUL-free UTF8 text. Digest/retry/provenance/finalization/attachment authority remains owner, not detector.

**Pinned candidates / primitives:**

- **file-type 21.0.0** — evaluation only; not installed/adopted. License: MIT. Entry/features: async fileTypeFromBuffer; ESM core/default,node condition. Dependencies: `{"@tokenizer/inflate": "^0.2.7", "strtok3": "^10.2.2", "token-types": "^6.0.0", "uint8array-extras": "^1.4.0"}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Simple sufficient declared detector mechanism; adequacy open; Three signatures+strict text+owner limits | sync TextDecoder portable | No deps; tiny catalog |
| library_with_minimum_wrapper: library plus minimum owner wrapper | Useful if binary catalog grows; currently disproportionate; Catalog allowlist+text fallback+safe unknown/error handling+async owner join | ESM core; initialize no global state; Node>=20,Worker qualify | 4 direct ranged deps and transitive closure; larger catalog maintenance outsourced |
| platform_primitive: platform primitive | TextDecoder handles UTF8 only; binary signatures owner; Existing tiny checks | portable | No complete file primitive |
| retain_now: retain-now | Best current catalog; keep adequacy obligation open; Existing | same | No new async burden |

**Necessary owner wrapper:** allowlist; strict text fallback; byte/quota/provenance/receiver; safe detector fault mapping if adopted.

**Avoidable or conditional wrapper:** forking catalog; claiming full format validation; preserving truncated magic fixtures as permanent authority.

- Library catalog excludes plain-text detection; async API changes public sync detectContentType if swapped directly; wrappers cannot turn heuristic into structural validation.
- core explicitly avoids Node path; transitive Worker closure not qualified; short/truncated buffers may throw or yield different classification.

**Maintenance conclusion:** A dependency/async bridge may exceed the small supported signature catalog.

**Proposed next action:** Evaluate on real format expansion or proved validity defect; do not equate sniffing with structural validation.

**Source:** [packages/files/src/upload/index.ts:92](/Users/vince/Projects/canlang/packages/files/src/upload/index.ts:92).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. No exact tarball/transitive resolved closure or Worker run; content adequacy not selected; no public sync migration authorized.

**Unresolved authority/domain:** Prefix-only magic adequacy unresolved; not normative requirement to admit truncated malformed structure. Do not silently narrow public supported inputs or expand catalog.

## ollama-protocol

services-model; services-http. **Assessment:** retain current strict transport/protocol; reject current SDK adoption.

**Contracts:** `AD-services-model`, `AD-model-final-and-cancel`, `AD-services-http`.

**Required outcomes:** Allowlisted model/token validation,frozen authorized history; bounded full deadlines/same-origin/auth/privacy; malformed NDJSON fails closed safe message. Partial evidence not success; validated done:true only; first terminal,racing valid final,per-run cancel request/confirmation,immutable snapshots,incomplete EOF,no fabricated resume.

**Pinned candidates / primitives:**

- **ollama-js/ollama 0.6.3** — evaluation only; exact official published package inspected,not installed/adopted. License: MIT. Entry/features: Ollama chat; browser ESM/custom fetch; abortable iterator. Dependencies: `{"whatwg-fetch": "^3.6.20"}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Good required protocol fit; transport/lifecycle joins still owning; Current strict small line parser+typed classifier+terminal snapshot adapter | Fetch/TextDecoder portable; selected source host closure qualification | No SDK deps |
| library_with_minimum_wrapper: library plus minimum owner wrapper | Fails strict privacy/parse contract without duplicate parser/fork; Typed final/error/cancel wrapper possible but cannot recover dropped malformed evidence | Per-instance config/custom fetch; per-iterator abort; browser polyfill burden | Adds package and polyfill; strict reparsing duplicates current core |
| platform_primitive: platform primitive | Fetch/TextDecoder/JSON.parse appropriate current building blocks; Bounded NDJSON line accumulation and typed verdict owner | No SDK init; real provider bindings required | Small protocol maintenance, service HTTP reused |
| retain_now: retain-now | Best while SDK lacks strict configurable parser; Existing | same | Avoid maintained fork |

**Necessary owner wrapper:** model authority; safe classified errors/final validation; per-run terminal/cancel evidence; strict bounded NDJSON parser with current platform approach.

**Avoidable or conditional wrapper:** duplicate parser around permissive SDK; global console monkeypatch; SDK fork solely for strict parse; removing public streaming lifecycle due no product constructor.

- No strict parsing/warning redaction option; malformed bytes discarded and leaked console warning before public iterator observes them.
- Custom fetch can bound/auth/redirect transport, but guaranteeing failclosed malformed NDJSON needs reparsing/interception or maintained SDK fork.
- Per-iterator abort exists; client.abort aborts all streams; cancellation lifecycle wrapper still required.

**Maintenance conclusion:** SDK warns/skips malformed lines; reparsing/fork would recreate required strict mechanism.

**Proposed next action:** Retain bounded fail-closed protocol for this pinned SDK version.

**Source:** [packages/services/src/models/ollama.ts:490](/Users/vince/Projects/canlang/packages/services/src/models/ollama.ts:490); [packages/services/src/models/ollama.ts:564](/Users/vince/Projects/canlang/packages/services/src/models/ollama.ts:564).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Official package0.6.3 version/integrity and built parser source inspected; direct dependency transitive closure/Worker unknown; no provider/runtime qualification.

**Unresolved authority/domain:** Broader durable progress/revision/work receipt joins separate; no production constructor observed does not retire public streaming lifecycle.

## state-work-retention

K-native; K-ts-lifecycle; K-ts-receipt; K-ts-recovery; K-ts-retry; K-ts-rows; S-DO; S-authority; S-child-join; S-d1-core; S-dispatch-join; S-fanout-freeze; S-fanout-lifecycle; S-fanout-shape; S-fence; S-invoke; S-memory; S-pipeline; S-query-other; S-read-invoke; S-receipt-read; S-receipt-write; S-storage-contract; S-storage-migration; S-system; S-transact-wrappers; W-dispatch; W-dispatch-commands; W-intent; W-observe; W-port-types; W-progress; W-recovery; W-retry-lifecycle; W-rows; W-schedule-commands. **Assessment:** retain owning decisions over native storage; no generic engine adoption.

**Contracts:** `SW-001`, `SW-002`, `SW-003`, `SW-004`, `SW-005`, `SW-006`, `SW-008`, `SW-051`, `SW-057`, `SW-058`, `SW-059`, `SW-063`, `SW-067`, `SW-069`, `SW-071`, `SW-072`, `SW-075`, `SW-079`.

**Required outcomes:** Owning revision read-before-dependent reads and all writer monotonic fence; atomic domain/history/uniqueness/replay/outbox/schedule/terminal commit; capped canonical retries. Persisted receipt/outbox/occurrence/claim identity and unknown-provider distinctions; finite fanout authority; current disclosure/expiry/notification,call-local principal/source.

**Pinned candidates / primitives:**

- **ajv 8.17.1** — evaluation only. License: MIT. Entry/features: JSONSchema code generation; optional defaults/coercion/removal. Dependencies: `{"fast-deep-equal": "^3.1.3", "fast-uri": "^3.0.1", "json-schema-traverse": "^1.0.0", "require-from-string": "^2.0.2"}`.

- **knex 3.1.0** — evaluation only; SQL builder representative for ORM class. License: MIT. Entry/features: query/schema builder and connection transactions. Dependencies: `"14 direct deps + selected DB driver; ranges unresolved"`.

- **@temporalio/client+worker 1.13.2** — evaluation only. License: MIT. Entry/features: gRPC client initialized connection; native worker/workflow stack. Dependencies: `"client gRPC/common/proto/abort-controller/long/uuid; worker core-bridge,SWC,webpack,rxjs etc; full closure unresolved"`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | Correct responsibility ownership; incomplete durable joins not certified; Can pure decisions+storage ports+native transaction mechanisms | Existing selected TS/default; Rust candidates registered,join gates retained | Owner semantics substantial but irreducible |
| library_with_minimum_wrapper: library plus minimum wrapper | Only narrow SQL/validation mechanics potentially useful; whole replacement poor fit; Can canonical exact validation and all authority/fence/identity state machine remain | Ajv initialization compile;Knex driver/pool init;Temporal gRPC+worker/service | Additional semantic engines/driver deps/service burden; no demonstrated net deletion |
| platform_primitive: platform primitive | Best for transaction/CAS,crypto,timers within owner; All business authority and transition rules remain | Actual D1/DO supported storage atomicity must qualify | Avoid second orchestration engine |
| retain_now: retain-now | Best; qualify missing owner/durable joins separately; Can decisions remain | No default/backend retirement change | Existing abstraction burden; no speculative ORM/workflow |

**Necessary owner wrapper:** canonical owner predicates; monotonic fence and atomic batch; retained identities/claims/receipts; finite fanout and current disclosure/lifetimes.

**Avoidable or conditional wrapper:** second validation/default engine; workflow mirror of Can state; ORM authority inference; retirement of TS/backend from registered Rust candidates.

- Generic validator defaults/coercion order differs canonical descriptor outcomes/exact carriers; generic schema adapter still needs owner exact semantics.
- SQL transaction API handles DB mechanism only; D1 owner fence/liveness writes and affected-row result consumption remain. Knex manifest does not provide D1 adapter.
- Temporal requires separate service/native Node worker and cannot atomically commit Can D1 domain+receipt+work; default retry/history/cancel semantics not Can contract.

**Maintenance conclusion:** Generic schema/SQL/workflow stack does not supply current Can atomic authority.

**Proposed next action:** Keep predicates/fences on actual storage; no duplicate state/default engine.

**Source:** [packages/state/src/invocation/admission.ts:321](/Users/vince/Projects/canlang/packages/state/src/invocation/admission.ts:321); [packages/work-kernel/rust/lib.rs:1](/Users/vince/Projects/canlang/packages/work-kernel/rust/lib.rs:1).

**Qualification gaps:** Read-only source analysis; no builds/tests/install/probes run. Primary upstream APIs do not establish installed runtime equivalence or whole security/atomicity. Candidate exact source pins inspected,not installed. Full resolved supply-chain closure,actual D1/DO atomicity,provider/service/runtime and retained historic state inventory absent.

**Unresolved authority/domain:** T32 already-fenced authority loss ordering needs reconciliation; selected Rust decision candidates do not imply installed production driver/transport join.; Historic handler/outbox identity inventory missing; generic workflow retained state not proof of Can old identity or permission.

## delivery-imports

Lexical imports and original-coordinate rewrites. **Assessment:** retain selected integration; qualify exact target.

**Contracts:** `CF-C11`, `CF-C12`, `CF-C13`, `CF-C14`, `CF-C35`.

**Required outcomes:** Decoded literal identity, lexical rather than regex discovery, UTF16 original spans, artifact vs trusted dynamic admission, deterministic errors/order, safe path membership, unchanged no-edit passthrough, changed-length D04 diagnostics

**Pinned candidates / primitives:**

- **es-module-lexer 3.0.3** — selected and imported; installed absent. License: MIT. Entry/features: minimal/js synchronous asm. Dependencies: `{}`.

- **magic-string 1.4.3** — selected and imported; installed absent. License: MIT. Entry/features: overwrite/appendLeft/generateMap hires:true includeContent:false. Dependencies: `{"@jridgewell/sourcemap-codec": "^1.6.0"}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | already library-backed, source-fit; current Unicode view/normalization/policy adapter | sync Node host | bounded but Unicode retries deserve finite domain qualification |
| library_with_minimum_wrapper: library + minimum wrapper | good; normalize records; retain admission/order/escaping/line terminator adaptation | asm sync no init/await; MagicString ESM | much smaller than own JS lexer |
| platform_primitive: platform primitive | insufficient; Node import/eval executes effects, neither exposes import spans nor edit maps | host execution risks and async | cannot replace lexical preflight |
| retain_now: retention | recommended selected source pending exact target qualification; same owning policy | native preparation HUMAN HOLD | no new parser stack |

**Necessary owner wrapper:** producer set, membership/containment, profile separation, specifier escape, coordinate/order/error adapter.

**Avoidable or conditional wrapper:** handwritten JS token/string decoder, regex import scanner, second Rust lexer; Unicode view only removable if exact library covers required domain.

- Minimal entry avoids full build TS/glob shape migration and Wasm init; lexer does not prove syntax or free bindings; LF-only map coordinate convention needs equal-length line view
- Published minimal asm banner3.0.3 line1 and synchronous parse/init=Promise.resolve line2 verified. Type declaration init docs generic async; actual asm no compilation await. No declared package engines; source memory allocation/grammar limits still finite.

**Maintenance conclusion:** Lexical imports and edits already delegated; coordinate/admission policy remains.

**Proposed next action:** Qualify exact selected installation/hosts and bounded Unicode domain.

**Source:** [packages/cloudflare/src/deploy/module-imports.ts:3](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/module-imports.ts:3); [packages/cloudflare/src/deploy/module-imports.ts:69](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/module-imports.ts:69); [packages/cloudflare/src/deploy/module-imports.ts:151](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/module-imports.ts:151); [packages/cloudflare/src/deploy/module-imports.ts:215](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/module-imports.ts:215); [packages/cloudflare/src/runtime/modules.ts:120](/Users/vince/Projects/canlang/packages/cloudflare/src/runtime/modules.ts:120).

**Qualification gaps:** Selected versions absent from local installed dependency tree; exact published3.0.3/1.4.3 artifacts inspected, no installation performed. No fresh changed-length installed Node/workerd execution; docs and tarball source inspection are not acceptance.

## delivery-maps

Point-map decode lookup and edit-stage composition. **Assessment:** retain raw profile pending separately owned domain decision; library composition already used.

**Contracts:** `CF-C14`, `CF-C15`, `CF-C16`, `CF-C17`, `CF-C35`.

**Required outcomes:** raw original sources/names/content including duplicates preserved, 1/0-based boundaries, map absent/no-edit/invalid handling, original handler failure preserved, composed changed-length stack diagnostics

**Pinned candidates / primitives:**

- **@jridgewell/sourcemap-codec 1.6.0** — selected used; exact installed source read. License: MIT. Entry/features: decode isolated fragments; encode. Dependencies: `{}`.

- **@jridgewell/remapping 2.3.5** — selected imported; installed absent. License: MIT. Entry/features: newest-first arrays, null loader, excludeContent:true decodedMappings:true. Dependencies: `{"@jridgewell/gen-mapping": "^0.3.5", "@jridgewell/trace-mapping": "^0.3.24"}`.

- **@jridgewell/trace-mapping 0.3.31** — locked transitive remapping dependency; no direct runtime lookup import; installed only0.3.9. License: MIT. Entry/features: TraceMap/originalPositionFor/traceSegment. Dependencies: `{"@jridgewell/resolve-uri": "^3.1.0", "@jridgewell/sourcemap-codec": "^1.4.14"}`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | profile preservation source-fit; per-segment validation/decode, local accumulation/lookup, endpoint/prefix-max/carrier composition | sync codec Worker; remapping host | substantial compatibility burden |
| library_with_minimum_wrapper: library + minimum wrapper | Conditional for required duplicate behavior even on ordinary sorted maps; not an unmodified drop-in.; Whole-map trace/composition plus exact units/raw indexes and a finite duplicate-column coalescing/tie policy; failure/admission and cross-call mutation domain qualified separately. | sync no init; host/Worker closure separately | can remove fragment/step/carrier wrapper after owner selects profile; no selection here |
| platform_primitive: platform primitive | partial Node --enable-source-maps only; must preserve raw identity/public lookup/Worker diagnostic API | Node host only; no equivalent workerd builtin claimed | not whole replacement |
| retain_now: retention | required pending domain decision; existing finite raw profile | native HUMAN HOLD | no rebuilding codec solely for parity |

**Necessary owner wrapper:** raw source/name index insulation, original metadata copy, diagnostic fallback, exact coordinate units, current profile validator pending owner decision.

**Avoidable or conditional wrapper:** per-segment decoding/accumulation/lookup, prefix-max endpoint transform and large-delta carriers if legitimate consumer domain permits full library composition.

- Whole-map codec sorting, signed arithmetic differences and eager first-error profile obstruct drop-in parity. TraceMap derives resolvedSources and caches decoded mappings; caller-supplied unsorted decoded lines are copied for sorting, while sorted lines/table references may be shared. Raw identity and mutable-map lifetime still require qualification. Current rawEncode carriers and effectiveLine prefix maxima preserve odd raw oracle, not permanent desirable policy. Range/index maps not certified.
- Published MagicString also supports hires experimental-range/rangeMappings; current hires:true point map intentionally does not adopt range extension. Published remapping adds ignore loader context; not needed for present point-stage composition. Intermediate array source count guard rejects >1, not a general index/range profile certification.
- FIT-C01: current lookup selects last equal-column mapping; trace-mapping GLB exact match selects first, including ordinary sorted nonnegative maps. remapping traces child maps through the same choice. A finite tie/coalescing bridge or an explicitly selected profile change is required; raw-index/unit projection alone is insufficient.

**Maintenance conclusion:** Raw profile wrappers hide an API/algorithm seam; full library is not universally equivalent.

**Proposed next action:** Inventory required producer/public duplicate/order/range domain before reducing wrapper.

**Source:** [packages/cloudflare/src/runtime/sourcemap.ts:55](/Users/vince/Projects/canlang/packages/cloudflare/src/runtime/sourcemap.ts:55); [packages/cloudflare/src/runtime/sourcemap.ts:134](/Users/vince/Projects/canlang/packages/cloudflare/src/runtime/sourcemap.ts:134); [packages/cloudflare/src/deploy/module-maps.ts:24](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/module-maps.ts:24); [packages/cloudflare/src/deploy/module-maps.ts:74](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/module-maps.ts:74); [packages/cloudflare/src/deploy/module-maps.ts:87](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/module-maps.ts:87); [packages/cloudflare/src/runtime/invoke.ts:257](/Users/vince/Projects/canlang/packages/cloudflare/src/runtime/invoke.ts:257).

**Qualification gaps:** installed remapping2.3.5/trace0.3.31 absent; real generated/stored malformed maps/error-text consumers not inventoried here; no installed D04 qualification; codec1.6 source available only installation evidence

**Unresolved authority/domain:** CF-C15; CF-C17

## delivery-loadability

CJS/free-binding and staged link checks. **Assessment:** evaluate only, no parser adoption selected.

**Contracts:** `CF-C08`, `CF-C11`, `CF-C12`, `CF-C13`, `CF-C35`.

**Required outcomes:** Reject real unwrapped CJS and file URL imports; allow genuine approved bundled interop/stdlib require guard; lexical scope and provenance, exact staged membership; error order

**Pinned candidates / primitives:**

- **acorn 8.15.0** — explicit evaluation candidate not installed/adopted. License: MIT. Entry/features: parse ecmaVersion:2025/sourceType:module proposed evaluation. Dependencies: `[]`.

- **acorn-walk 8.3.4** — explicit evaluation candidate at upstream8.15.0 ref. License: MIT. Entry/features: recursive/ancestor walkers. Dependencies: `["acorn^8.11.0"]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | heuristic partial; blank strings/comments/template spans + wrapper + regex | sync host | false positives/negatives possible; no new behavior proof |
| library_with_minimum_wrapper: library + minimum wrapper | potential better syntax/scope mechanics; parse+binding scope walk; owner-authorized helper provenance; deterministic issue policy | sync Node ESM/CJS browser capable | scope policy unavoidable; avoid authoring second parser |
| platform_primitive: platform primitive | load test catches host failures but incomplete preflight; nonexecuting host parse if available must not substitute actual workerd controls | Node/workerd differ; native held | effects/host mismatch and missing free-binding report |
| retain_now: retention | bounded until finite accepted replacement; existing checks | HUMAN HOLD Rust preparation | retain refusal not assert perfect static proof |

**Necessary owner wrapper:** scope binding and trusted bundler-helper provenance; staged links/policy.

**Avoidable or conditional wrapper:** blanking scanners if AST selected; whole custom JS parser.

- AST walking is not scope resolution; supported modern import phase syntax needs parser domain check; sourceType module cannot automatically match all trusted producer syntax; spelling __commonJS alone is not provenance.

**Maintenance conclusion:** AST parser can replace heuristic blanking, but scope and helper provenance still needed.

**Proposed next action:** Finite full grammar/scope/producer qualification; no mere AST smoke.

**Source:** [packages/cloudflare/src/deploy/bundle.ts:724](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/bundle.ts:724); [packages/cloudflare/src/deploy/bundle.ts:843](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/bundle.ts:843); [packages/cloudflare/src/deploy/bundle.ts:878](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/bundle.ts:878); [packages/cloudflare/preparation/src/modules.rs:565](/Users/vince/Projects/canlang/packages/cloudflare/preparation/src/modules.rs:565).

**Qualification gaps:** no corpus/parser witness execution; no helper provenance receipt; Acorn version/grammar pin proposed not accepted

## delivery-toml

Reviewable TOML serialization. **Assessment:** evaluate later finite packet.

**Contracts:** `CF-C18`, `CF-C19`, `CF-C20`, `CF-C31`.

**Required outcomes:** semantic resources/secret names only; deterministic reviewed bytes and published digest coherence; prior JSON reader maintained; no invented schedule mapping

**Pinned candidates / primitives:**

- **toml_edit 0.22.27** — explicit evaluation candidate not installed/adopted. License: MIT OR Apache-2.0. Entry/features: DocumentMut value/table; default-features:false features:[display] proposed. Dependencies: `["indexmap2.3/std", "toml_datetime0.6.11", "toml_write0.1.2; parse adds winnow0.7.10"]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | small fixed serializer; TOML validity limits; fixed table/order/escaping | TS/held Rust | low cost but format quirks |
| library_with_minimum_wrapper: library + minimum wrapper | good standard TOML domain conditional; ordered plan-to-document projection, policy comments, chosen UTF16 boundary; not hand quote | Rust1.66+, synchronous | dependency more than tiny serializer; removes quoting liability |
| platform_primitive: platform primitive | JSON.stringify owns JSON only; TOML still needs grammar | TS native | no standard TS/Rust TOML builtin |
| retain_now: retention | recommended while native held/profile unselected; current render | HUMAN HOLD | avoid port-only library change |

**Necessary owner wrapper:** plan projection/order when required, secret omission, schedule refusal/comment, review/publish pairing.

**Avoidable or conditional wrapper:** custom TOML quote emitter if selected library/domain matches.

- Format-preserving library can own TOML quoting/key emission but not exact current comments/order unless explicitly set. Rust string cannot represent lone JS surrogate; native current renderer replaces it, lossless tree/profile decision cannot be hidden by library. Arbitrary current control/key output domain needs inventory.

**Maintenance conclusion:** Quoting liability can move to library; tiny renderer versus dependencies/UTF16 matters.

**Proposed next action:** Native preparation remains HUMAN HOLD; decide finite domain before replacement.

**Source:** [packages/cloudflare/src/deploy/render.ts:23](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/render.ts:23); [packages/cloudflare/preparation/src/render.rs:68](/Users/vince/Projects/canlang/packages/cloudflare/preparation/src/render.rs:68).

**Qualification gaps:** no produced TOML corpus/control-key validation; no actual stored plans; native HOLD; no target acceptance

**Unresolved authority/domain:** CF-C19

## delivery-cli

CLI option grammar. **Assessment:** retain manual grammar unless deliberate CLI profile change.

**Contracts:** `CF-C03`, `CF-C05`, `CF-C35`.

**Required outcomes:** help/version and first refusal order; duplicates rejected; only locale allows equals; artifact/env consume next token including flag-looking strings; command-specific flags; preview wins yes; envelope/exit semantics

**Pinned candidates / primitives:**

- **Node util.parseArgs 22.16.0** — explicit platform evaluation version, no dependency change. License: Node license/platform builtin. Entry/features: tokens:true strict:false proposed token inspection; final validation owner. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | exact observed grammar small; manual one-pass flags and command policy | sync Node | small readable owner code |
| library_with_minimum_wrapper: library + minimum wrapper | partial mechanical fit; ordered raw-token grammar constraints, duplicate/error/help behavior; may largely duplicate existing pass | Node22.16 builtin; Bun compatibility unverified | little saving if exact supported grammar retained |
| platform_primitive: platform primitive | same parseArgs candidate; same required compatibility adapter | no install | no default drop-in |
| retain_now: retention | best current cost/benefit; existing finite grammar | sync host | no extra dependency |

**Necessary owner wrapper:** command admission, duplicate/help/refusal precedence, deploy preview/yes policy, output envelope.

**Avoidable or conditional wrapper:** none demonstrated without a CLI contract change.

- Default strict parser rejects ambiguous values and groups/equals/-- grammar differs; default repeated values last-win unlike current duplicate refusal. Full parse before help may alter earlier/later failure precedence. tokens returned only after parser itself succeeds.

**Maintenance conclusion:** parseArgs compatibility pass can duplicate the present small grammar.

**Proposed next action:** Retain current CLI grammar; revisit only with deliberate interface simplification.

**Source:** [packages/cloudflare/src/cli/platform.ts:118](/Users/vince/Projects/canlang/packages/cloudflare/src/cli/platform.ts:118).

**Qualification gaps:** Bun actual parseArgs semantics not qualified; no grammar execution; no CLI profile change authorized

## delivery-protocol-build

SDK protocol and build mechanics. **Assessment:** retain.

**Contracts:** `AD-interfaces-mcp`, `AD-interfaces-prepared-mcp`, `AD-interfaces-errors`, `CF-C08`, `CF-C20`, `CF-C22`, `CF-C35`.

**Required outcomes:** same canonical current identity/authority/validation and safe projections; protocol framing; exact staged closure; synchronous public bundle/build preserved; reproducible host claims; review/publish integrity

**Pinned candidates / primitives:**

- **@modelcontextprotocol/sdk 1.32.0** — selected source imports; exact local installed 1.32.0 manifest, license and server declaration APIs independently inspected. License: MIT. Entry/features: Server and WebStandardStreamableHTTPServerTransport stateless per request. Dependencies: `{"@hono/node-server": "^1.19.9 || ^2.0.5", "ajv": "^8.17.1", "ajv-formats": "^3.0.1", "content-type": "^1.0.5", "cors": "^2.8.5", "cross-spawn": "^7.0.5", "eventsource": "^3.0.2", "eventsource-parser": "^3.0.0", "express": "^5.2.1", "express-rate-limit": "^8.2.1", "hono": "^4.11.4", "jose": "^6.1.3", "json-schema-typed": "^8.0.2", "pkce-challenge": "^5.0.0", "raw-body": "^3.0.0", "zod": "^3.25 || ^4.0", "zod-to-json-schema": "^3.25.1"}`.

- **Bun 1.4.2** — packageManager selected; CLI build delegated. License: platform licenses not reaudited. Entry/features: build --format=esm --target=browser outfile. Dependencies: `[]`.

- **esbuild 0.28.2** — locked build tool; not alternate canonical invocation. License: MIT. Entry/features: BuildOptions build mechanics. Dependencies: `["platform optional native binary packages"]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | already delegated; auth/envelope/lifetime/build phase and import/publication policy | Node/Bun build; Web HTTP deployed | appropriate owner wrappers |
| library_with_minimum_wrapper: library + minimum wrapper | same selected SDK/build tools; own authority/envelope/closure/review joins | SDK host/export qualification required | remove duplicate protocol/build engine, not owning policies |
| platform_primitive: platform primitive | Fetch/Request insufficient for MCP; would rebuild JSONRPC negotiation/schema/transport | Web standards | higher protocol burden |
| retain_now: retention | recommended; same owner seams | native preparation HUMAN HOLD | SDK upgrade separate packet |

**Necessary owner wrapper:** permission/liveness/canonical invoker, safe error projection, per-request cleanup; exact closure/publish checks.

**Avoidable or conditional wrapper:** independent JSONRPC/MCP server or homegrown build engine.

- SDK handles protocol not business permission; new per-request stateless transport owns lifetime. Bun target browser does not prove workerd closure. esbuild APIs do not certify invocation/published byte equality.

**Maintenance conclusion:** SDK/build tool already own mechanics; authority/closure/publication are caller rules.

**Proposed next action:** Retain selected entry points; review actual shipped closure rather than whole SDK manifest count.

**Source:** [packages/interfaces/src/mcp/server.ts:26](/Users/vince/Projects/canlang/packages/interfaces/src/mcp/server.ts:26); [packages/interfaces/package.json:55](/Users/vince/Projects/canlang/packages/interfaces/package.json:55); [packages/cloudflare/src/preparation/build-adapter.ts:60](/Users/vince/Projects/canlang/packages/cloudflare/src/preparation/build-adapter.ts:60); [packages/cloudflare/src/preparation/build-adapter.ts:85](/Users/vince/Projects/canlang/packages/cloudflare/src/preparation/build-adapter.ts:85); [bun.lock:153](/Users/vince/Projects/canlang/bun.lock:153); [package.json:8](/Users/vince/Projects/canlang/package.json:8).

**Qualification gaps:** Exact installed SDK 1.32.0 manifest/license/server declarations inspected; upstream tag retrieval unavailable; actual installed/deployed consumer execution not performed. Bun docs are unversioned; actual pinned Bun1.4.2 source/host/target qualification not newly performed; SDK root dependency count is not the selected Worker bundle closure.

## delivery-crypto-files

Digest and filesystem/path/URL primitives. **Assessment:** retain.

**Contracts:** `CF-C09`, `CF-C13`, `CF-C20`, `AD-interfaces-uploads`, `AD-interfaces-file-kernel-binding`.

**Required outcomes:** exact serialization/framing/UTF8 digest bytes; minted rooted file keys; IO missing distinct other failures; authorized lifetime/provenance; no claim FS adapter is R2 production

**Pinned candidates / primitives:**

- **sha2 0.10.9** — locked held native. License: MIT OR Apache-2.0. Entry/features: Sha256/Digest byte update/finalize. Dependencies: `["digest/cfg-if/cpufeatures per Cargo.lock"]`.

- **WebCrypto/node crypto, fs/path/URL Node22.16 evaluation docs; host primitives no package pin** — retained primitives already used. License: host platform. Entry/features: digest async versus createHash sync, safe byte IO/path URL conversion. Dependencies: `[]`.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | good delegation; byte framing/UTF8/key admission/root/error policy | host primitive and held Rust | small required policy |
| library_with_minimum_wrapper: library + minimum wrapper | same primitives already sufficient; retain canonical byte profile/identity | sync SHA2/node or explicit async crypto owner | do not add crypto implementation |
| platform_primitive: platform primitive | best; own bytes+keys+errors | actual host support qualification | minimal burden |
| retain_now: retention | recommended; current profile | HUMAN HOLD native | preserve exact bytes |

**Necessary owner wrapper:** canonical serialization/framing, minted key/root/symlink boundary, authority and lifetime.

**Avoidable or conditional wrapper:** custom SHA or filesystem implementation.

- WebCrypto async cannot silently break synchronous bundle API; fs/path join is not symlink fence or authority; URL normalization not logical raw identity

**Maintenance conclusion:** Existing hash/IO primitives are appropriate; bytes, authority and rooted keys remain.

**Proposed next action:** Retain primitives; review real publishing/atomicity separately.

**Source:** [packages/cloudflare/src/deploy/bundle.ts:925](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/bundle.ts:925); [packages/cloudflare/src/deploy/bundle.ts:1130](/Users/vince/Projects/canlang/packages/cloudflare/src/deploy/bundle.ts:1130); [packages/cloudflare/preparation/Cargo.lock:148](/Users/vince/Projects/canlang/packages/cloudflare/preparation/Cargo.lock:148); [packages/files/src/upload/fs-blob-store.ts:13](/Users/vince/Projects/canlang/packages/files/src/upload/fs-blob-store.ts:13).

**Qualification gaps:** not full supply-chain/security audit; no durable R2/provenance execution; publication F06 remains

## delivery-small

Escaping projection clone/probe assertions. **Assessment:** retain.

**Contracts:** `AD-ui-escaping`, `AD-interfaces-projection`, `AD-testkit-runner`, `AD-testkit-public-surface`, `SW-033`, `SW-052`, `SW-064`.

**Required outcomes:** five character HTML escaping, sink-specific URL/formula/bidi rules; grants project authorized present leaf values and omit denied; JSON-ish clone no alias; every sorted path mismatch using Object.is including NaN/-0 and key presence; caller error containment

**Pinned candidates / primitives:**

- No new dependency candidate: compare the recorded platform API / small owner mechanism.

| Alternative | Fit and necessary wrapper | Initialization / hosts | Maintenance burden |
| --- | --- | --- | --- |
| existing: existing | small responsibility-specific code good fit; escape policy/projection/assertion own semantics | pure JS + existing structuredClone | no new dependency |
| library_with_minimum_wrapper: library + minimum wrapper | no benefit established; generic escape/clone/deepEqual would still need every required policy and path collector | candidate deliberately not selected | adapter could exceed original |
| platform_primitive: platform primitive | use where contract matches already; structuredClone + Object.is + JSON.stringify; sink policies still owner | Worker/Node support needs separate check | small |
| retain_now: retention | recommended; current mechanisms with F10 domain qualification | no init | avoid gratuitous dependency |

**Necessary owner wrapper:** sink escaping and allowed schemes; grant leaf/presence semantics; mismatch collector; safe error mapping.

**Avoidable or conditional wrapper:** duplicate clone engine where structuredClone matches; no requirement to emulate exotic identities indefinitely.

- structuredClone handles clone not permission/projection; changes exotic passthrough/depth/prototypes domain. JSON.stringify no-throw probe allows undefined/nonfinite normalization (security F10) and is not lossless admission. Node deep equality yields boolean/throw, not every path mismatch. DOM escaping unavailable in Worker and does not own URLs/formulas.

**Maintenance conclusion:** Many small mechanisms express owning policy rather than a missing library.

**Proposed next action:** Use builtins where domain matches; do not add universal adapters or deep-equivalence engines.

**Source:** [packages/ui/src/escape.ts:22](/Users/vince/Projects/canlang/packages/ui/src/escape.ts:22); [packages/interfaces/src/projection/project.ts:60](/Users/vince/Projects/canlang/packages/interfaces/src/projection/project.ts:60); [packages/testkit/src/assertions/equal.ts:13](/Users/vince/Projects/canlang/packages/testkit/src/assertions/equal.ts:13); [packages/state/src/internal/json.ts:16](/Users/vince/Projects/canlang/packages/state/src/internal/json.ts:16).

**Qualification gaps:** F10 no-throw probe not lossless proof; exotic/depth alias public domain unresolved; no new behavior execution

**Unresolved authority/domain:** SW-064

Every verdict is an assessment proposal. Retention is scoped to the named outcomes; it neither legitimizes defects nor freezes every historical quirk. See the [focused review](review.md), [upstream evidence](upstream-evidence.json), and [dependency receipts](dependency-evidence.json).
