# Compiler library replacement audit

The compiler should use focused libraries for standardized infrastructure: JSON, URL and locale parsing, SHA-256, temporary-file ownership, LSP wire types and source-map encoding. Can should continue to own its grammar, semantic rules, authorization analysis and lowering. Several handwritten utilities already cause observable errors; replacing them is more valuable than a broad compiler-framework migration.

The detailed audit below preserves the **original proposals and observations** from October 6, 2026. It is historical baseline evidence; its source line numbers and reproduced old failures do not describe the final compiler. Baseline: `309644a6881909d8dba32560bc6711f67e00a7ab`. The [inventory](evidence/baseline.json) pins all 81 tracked compiler files, including 39 source files and 71,473 source lines. Line counts describe scope, not removable code. At that frozen baseline Cargo declared no dependencies and the compiler README described it as dependency-free; no inspected governing requirement prohibited libraries. Current manifests and compiler documentation describe the selected pinned library adapters.

## Implementation and qualification status

The [Pass10 final receipt](pass10/README.md) integrates selected core substitutions and their actual consumer/release scope. Each accepted change has its own contracts, permanent outcome regressions and independent review; remaining conditional work does not become an implied framework migration.

The user's clarified production-reduction goal remains open beyond that frozen correctness qualification. The [bounded reduction ledger](production-reduction/README.md) requires smaller complete implementation closures at equivalent outcomes and records the first checked 51-line LSP projection reduction. Tests/metadata growth and binary footprint do not substitute for that measure.

The proposed [compiler correctness, ownership and simplicity audit](compiler-correctness-simplicity-audit.md) broadens the next review beyond utility callers: complete responsibility/workflow coverage, compatibility obligations, semantic authority, generated execution, editor lifecycle, resource limits and test-oracle quality. It specifies sixteen ordered steps and economical allocations, with a planning exit before implementation. Its preparation corrects the aggregate line-count method; it is not a completed whole-compiler audit or a second living plan.

[Audit Step 1 is executed](baseline-verification/README.md): current inputs and category counts are pinned, historical receipts are classified, and a fresh native debug build plus six-test consumer replay qualifies its bounded scope. The evidence ledger preserves current/full-suite/product/host and temporal-provenance limits.

[Audit Step 2 is executed](responsibility-map/README.md): one coverage ledger accounts for every tracked compiler path, large-file responsibility bands, named API declarations, test/fixture roles and tool/editor/runtime interfaces. Fresh independent review accepts structural inventory; semantic/test-adequacy audit remains open.

[Audit Step 3 is executed](responsibility-map/workflows.md): the same ledger traces checking, emission, transforms/reports, generated tests, editor behavior, all five platform forwarding paths and public library families through actual consumers. Economical independent cross-review accepts bounded source/control-flow scope. Fresh native replay reports 209/15 harness passes with one permission-body skip, plus real-compiler capability and freshly compiled/mocked extension checks. Staging, test execution, active/applied verdicts and original/installed application acceptance remain distinct; no implementation or policy changes land here.

[Audit Step 4 is executed](responsibility-map/compatibility.md): 83 bounded requirements challenge all 26 prior compatibility claim groups across the core packets, conditional families and 18 workflows. Independent review distinguishes actual owning requirements, current public byte promises, migration guards and incidental mechanisms; 82 supporting inputs are pinned. Existing public/accepted support remains binding pending explicit revision. No new execution or implementation/policy change; adapter simplification and whole semantic correctness remain later work.

[Audit Step 5 is executed](responsibility-map/representations.md): the same ledger traces 35 stage/owner/conversion duties through source, checked facts, IR and actual output consumers, with eight selected carrier groups and all 18 workflow joins. Independent review qualifies repeated work and semantic-rule differences without declaring every parallel type redundant. Fresh library/public-API probes demonstrate unsealed mixed source/catalog inputs, with coherent/immutable controls; the normal CLI cohort stays distinct. No implementation or API/policy/cache choice; full semantics, measured integration reduction and product acceptance remain open.

[Audit Step 6 is executed](responsibility-map/integrations.md): all seven direct dependencies are traced through 22 engine/consumer-family closures, with 15 retain, six defer and one bounded simplify result. Exact source ranges, shared/recursive callers, public orphan helpers, typed versus compatibility models, roundtrips, fallback policies and private implementation assumptions are independently reviewed. Conditional retirement targets include all replacement/support code; no source reduction is credited. Published count replay confirms current production 69,255 versus original 69,119 (+136); full semantic, upgrade/cost and product qualification remain open.

[Audit Step 7 is executed](responsibility-map/syntax.md): 186 full grammar productions, 119 CST kinds and 27 stage families are mapped in the same ledger. Fresh native evidence has 345 selected harness passes, 50 public stage probes, 54 corpus replays and 16 CLI calls. Independent review confirms residual effects/source-metadata recovery bugs, silent tab/order/corpus loss and separate delimiter/support gates. Six actual emitted-string/testkit witnesses pass; whole syntax branch execution, application/product/other-host acceptance and the eight proposed repair packets remain open. No production or policy change occurs.

[Audit Step 8 is executed](responsibility-map/semantics.md): 44 finite semantic duties and eight repair/qualification records join the same ledger. Fresh evidence includes 440 selected passes, 73 public API fixtures, 12 current-build graph repeats, 70 public owner calls, eight CLI calls and two emitted pure-format executions. Array nullability, derive scope and format binding/runtime failures are independently corroborated; owner policy/data/presentation disagreements and broader authority/overload gaps remain classified. No production/package/policy implementation or full semantic/installed-release acceptance occurs.

[Audit Step 10 is executed](responsibility-map/outputs.md): 35 finite output/transform/coordinate duties and five proposed packets distinguish emitted binding defects, diagnostic ordering, downstream docs and comment/consumer gates. Exact fixtures and independent reviews retain native/GUI/runtime limits; no production implementation occurs.

[Audit Step 11 is executed](responsibility-map/editor.md): 31 finite server/client duties and nine proposed packets join the same 537-row ledger. Actual compiled client/providers and real-server sessions expose old/closed diagnostics, lost edit versions, wrong completion kinds and ignored options. Seventeen processes, two CLI controls, long-session observations and independent reviews retain selective-host/GUI/resource limits. Static catalog and single-document editor scope remain explicit; no compiler/editor/package implementation, framework selection, merge or checkpoint change.

[Audit Step 12 is executed](responsibility-map/failure.md): 44 finite failure/resource/host duties, 84 retained commands and independent receipt reviews establish five native-debug valid-source stack aborts, retain C04F file guarantees with the4750 host gate, and falsify stale build metadata while observing unnecessary rebuilds. Seven bounded repair/qualification packets remain proposed; structural redesign and resource limits are unselected. No new production/dependency/policy implementation or full release/host/application acceptance occurs.

| Pass | Declared outcome / reference |
| --- | --- |
|0 |[Released contracts and witnesses](pass0/README.md) |
|1 |[Lexer-owned decoded strings](pass1/README.md); secondary IR/analysis decoders retired |
|2 |[Strict LSP bytes/envelopes](pass2/README.md); IDs/lifecycle explicitly admitted |
|3 |[Qualified URL adapter](pass3/README.md); locale candidate failed, known locale/identity replacement remains gated |
|4 |[sha2 and owned tempfile adapters](pass4/README.md); handwritten hash/temp allocation retired |
|5 |[Typed JSON output families](pass5/README.md); exact Can scalar/ordering/layout policy remains |
|6 |[Bounded library JSON grammar](pass6/README.md); ordered/raw caller view remains |
|7 |[Typed LSP output and URI projection](pass7/README.md); current transport retained |
|8 |[Library source-map codec](pass8/README.md); actual original byte-column consumers qualified |
|9 |[Separate candidate retain/defer results](pass9/README.md); finite correctness/policy queue, no blanket adoption |
|10 |[Final checks, retired-path review and release closure](pass10/README.md); product-parent gaps stay explicit |

These pass labels remain local programme references. T15/T37, FP.QUALIFY and FP.INSTALLED-RELEASE keep their original owner/acceptance contracts; utility qualification is not complete product or installed-host acceptance. No merge/living-plan checkpoint advancement follows from this receipt.

## Original recommended replacements

| Priority | Handwritten mechanism and defining code | Proposed replacement | Scope that remains Can-owned |
| --- | --- | --- | --- |
| First | Full JSON parser, escape processing and repeated serializers: [json.rs](../../../compiler/src/json.rs), [diagnostic.rs](../../../compiler/src/diagnostic.rs), [IR string decoder](../../../compiler/src/codegen/ir.rs) | `serde` and `serde_json` for wire parsing/serialization; consume existing decoded token strings in analysis/lowering | Diagnostic/schema contracts, source error spans, exact scalar wire representations, ordering and admission limits |
| First | HTTP URL syntax and unsafe scheme slicing: [types.rs](../../../compiler/src/analysis/types.rs), `valid_url:15433`, `strip_scheme:15485` | [`url`](https://docs.rs/url/latest/url/), under separate ordinary-value and trusted-origin policies | HTTP(S) restriction, authored-value retention, stable diagnostics, domain-specific origin restrictions |
| First | Locale subtag heuristic: [types.rs](../../../compiler/src/analysis/types.rs), `valid_locale:15495` | Evaluate [`icu_locale_core::Locale`](https://docs.rs/icu_locale_core/latest/icu_locale_core/) against the runtime's full locale contract | ECMA-402-compatible admission/canonicalization, language-version data and source/variant ownership |
| Small independent change | SHA-256 padding, schedule and compression rounds: [source.rs](../../../compiler/src/source.rs), `sha256_hex:187` | [`sha2::Sha256`](https://docs.rs/sha2/latest/sha2/) behind the existing helper | Lowercase hex, byte-exact input, source identity and stale-fix guards |
| Small independent change | PID/sequence temp-file naming, cleanup and rename: [cli.rs](../../../compiler/src/cli.rs), `write_file_atomic:1344` | [`tempfile::NamedTempFile`](https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html) in the destination directory | File metadata, replacement/symlink policy, error mapping and durability expectations |
| After JSON adapters | Manually assembled LSP ranges, enums, capabilities and edits: [server.rs](../../../compiler/src/lsp/server.rs), `capabilities:944`, serializers `1049–1123` | [`lsp-types`](https://docs.rs/lsp-types/latest/lsp_types/) | Analysis results, version tracking, cancellation, initialization/shutdown and transport limits |
| After coordinate contract | Base64 VLQ encoding/decoding and map JSON: [sourcemap.rs](../../../compiler/src/codegen/sourcemap.rs), `encode_vlq:193`, `decode_segment:211` | [`sourcemap`](https://docs.rs/sourcemap/latest/sourcemap/struct.SourceMapBuilder.html) with a span adapter | Which spans/names map to each line, coordinate conversion, source order and artifact shape |
| Later | Manual option grammar, help and completion metadata: [cli.rs](../../../compiler/src/cli.rs), `parse_args:450`, help `597`; completion scripts | [`clap`](https://docs.rs/clap/latest/clap/) and `clap_complete` if duplicate command metadata warrants migration | Platform argument passthrough, diagnostic/exit contract and command orchestration |

The first three have demonstrated semantic or admission defects. Hashing is the clearest small library substitution, with no observed hash error. Source maps and CLI parsing have real standardized machinery but larger compatibility obligations.

## JSON and decoded strings

The full [JSON module](../../../compiler/src/json.rs) implements token grammar, depth checks, Unicode escapes, surrogate pairs, numbers, containers and rendering. Separate string decoding exists in the lexer (`decode_json_string:691`), type checking (`unescape_json:8416`) and IR lowering (`unescape_json:676`). Separate string escapers exist in diagnostic output (`push_json_str:280`), JS emission (`js_string:988`) and BDD emission (`js_string:431`).

**Reproduced:** a legal source token `"\b\f\uD83D\uDE00"` decodes in the lexer to code points `[8, 12, 128512]`, while generated JavaScript contains `return "bf��";`. Both analysis and emission diagnostics are empty. The public-API probe uses `EmitOptions::new()`, a synthetic empty versioned catalog and an explicitly complete result; it exercises the live lowering path, rather than CLI readiness or execution of the generated program. [Source, invocation and exact output](evidence/codegen/README.md).

The immediate repair is to consume `Token::string_value` from the CST. [examples.rs:2890](../../../compiler/src/analysis/examples.rs) already does this. Replacing redundant decoding with the owning decoded value avoids adding another decoder. The correct type-checker decoder has no demonstrated valid-input discrepancy, but should likewise consume that value when available.

The larger library substitution is JSON transport and typed serialization. [`serde_json`](https://docs.rs/serde_json/latest/serde_json/) supports strict parsing and typed output. Apply it separately to diagnostics (`diagnostic.rs:167`), artifacts (`artifact.rs:492`), descriptor serializers (`js.rs:176–813`), reference output (`docs.rs:1093–1392`) and policy output (`policy.rs:137`). Preserve explicit names, omitted versus null fields and required formatting through [Serde field attributes](https://serde.rs/field-attrs.html) and narrow adapters.

A blanket `Json` → `serde_json::Value` conversion would change behavior. Current objects are ordered pairs, retain duplicate members and return the first matching member. Numbers retain their original lexemes; `as_i64` rejects fraction/exponent spellings. [`RawValue`](https://docs.rs/serde_json/latest/serde_json/value/struct.RawValue.html) can preserve request IDs or pre-rendered literal values; [`preserve_order`](https://docs.rs/serde_json/latest/serde_json/map/index.html) retains map insertion order but does not retain duplicate members. Decide malformed/duplicate admission explicitly, preserve obligated numeric fidelity and keep depth 64 before removing the parser.

Keep `literal_json`'s Can scalar policy (`js.rs:428`): integers, decimals, durations and money minor units use decimal strings; authored decimal scale matters. A generic serializer must not change them to floating-point numbers or double-quote existing JSON fragments. Policy output also has a specific hybrid pretty layout and trailing newline. JSON string escaping fits present `.mjs` literals; HTML script embedding would need its own escaping contract.

## URLs and locales

**Reproduced through `check_program`:** a model default `link:url="💥💥💥"` panics at `types.rs:15486` because `value[..7]` splits a Unicode scalar. `https://[garbage]` and `https://host:999999` produce no diagnostics. The equivalent runtime host URL parser rejects all three. [Probe sources and outputs](evidence/syntax-analysis/README.md).

There is a policy mismatch as well. The compiler rejects ordinary `https://user:pass@example.com` values, citing trusted `app_url` rules. The [wire owner](../../../packages/values/src/wire.ts), `isHttpUrl:479`, explicitly allows userinfo for ordinary HTTP(S) values. The [trusted origin owner](../../../packages/values/src/stdlib-pure.ts), `parseTrustedOrigin:210`, separately forbids userinfo. `url` supplies standard parsing; the adapter must preserve the distinction and avoid silently canonicalizing stored authored strings. WHATWG-compatible Rust and JS implementations still need shared admission vectors.

**Reproduced locale divergence:** the compiler rejects `en-u-ca-gregory` and `en-x-private`, and accepts `en-US-US`. The runtime's `Intl.getCanonicalLocales` primitive accepts the first two and rejects the third. [locale.ts:16](../../../packages/values/src/locale.ts) owns that host admission/canonicalization. The saved probe executes the same host primitive, not the package exports.

`icu_locale_core::Locale` handles locale identifiers and extensions; `LanguageIdentifier` is a narrower subset. Its Unicode locale grammar alone does not prove parity with ECMA-402 canonicalization or data aliases. Qualify one focused locale parser against owner-derived vectors before adoption; do not import an entire localization runtime just to replace this heuristic.

The LSP's [URI display adapter](../../../compiler/src/lsp/server.rs), `uri_to_path:1176`, also hand-decodes `%XX`. It decodes non-file URIs despite its comment and conflates file authority with path. Once `url` is present, evaluate its [file-path conversion](https://docs.rs/url/latest/url/struct.Url.html#method.to_file_path), preserving non-file document identities and display behavior. This helper currently produces display paths, not filesystem authority, so it is lower priority than literal admission.

## LSP and file writes

**Reproduced on the CLI:** invalid UTF-8 in an LSP request ID becomes U+FFFD and receives a successful initialization response. `server.rs:1256` uses lossy UTF-8 before JSON parsing. A request with `"jsonrpc":"1.0","id":true` also initializes, while an explicit null-ID initialization receives no response. [Exact request bytes and replies](evidence/protocol-cli/probe-results.json), [reproducer](evidence/protocol-cli/probe.py).

`transport.rs:106` checks only the method, ignores the protocol version, accepts unrelated ID types and merges explicit null IDs with absent IDs. [JSON-RPC](https://www.jsonrpc.org/specification) defines the version, parameter and identifier constraints. Strict byte decoding and an explicit envelope validator are required even after adopting library wire types.

`lsp-types` would remove hand-maintained protocol shapes and numeric enums. Code inspection found URI-only `textDocument` objects in rename edits (`server.rs:744`) and code actions (`server.rs:1108`). The standard [optional versioned document identifier](https://docs.rs/lsp-types/latest/lsp_types/struct.OptionalVersionedTextDocumentIdentifier.html) carries a `version` member, including null where appropriate. Typed construction exposes such omissions; Can still chooses the correct current document version.

**Transport migration is conditional.** [`lsp-server`](https://docs.rs/lsp-server/latest/lsp_server/) is relevant synchronous scaffolding, but its [inspected implementation](https://docs.rs/lsp-server/latest/src/lsp_server/msg.rs.html) uses `i32|string` IDs, requires CRLF and `": "` headers and allocates the advertised body without Can's 64 MiB cap. It does not itself require a validated JSON-RPC version. Adopt protocol DTOs first; replace transport only after resolving exact ID obligations, framing tolerance, bounds, EOF/torn-frame behavior and lifecycle/exit compatibility. An async framework would require a separate need.

**Reproduced on macOS:** formatting a mode `0600` source replaces it with mode `0644` under the observed umask. `write_file_atomic` invents a predictable temp name, writes by path and renames; it does not preserve metadata. `NamedTempFile::new_in` and `persist` can own allocation/cleanup and atomic replacement, but metadata copying and symlink/hardlink policy remain explicit. Its [persistence API](https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html#method.persist) does not synchronize file contents or the directory; atomic replacement and crash durability are separate guarantees. Retain destination-local staging and E7002/E7007 mappings for the respective callers.

## Source maps

The standard VLQ codec is a library candidate. Can's mapping decisions are not: generated line attribution, source/name order, original spans, source contents and artifact fields remain in a small adapter. `SourceMapBuilder` can register and deduplicate sources/names, so remap IDs explicitly rather than equating them with `SourceDb` indices.

**Reproduced coordinate difference:** for `é😀x`, a span at UTF-8 byte 6 produces original column 6; UTF-16 column is 3. `sourcemap.rs:56` uses byte-based `LineIndex::line_col`. [ECMA-426](https://tc39.es/ecma426/#sec-terms-and-definitions) specifies UTF-16 columns for JavaScript/CSS maps and permits other content types to diverge. Establish what the original `.can` consumer expects before declaring a browser-navigation defect. Changing the codec does not change the coordinates supplied to it.

Current tests decode with the same handwritten decoder, and `assert_sourcemap_valid` discards `src_col` (`tests/codegen.rs:146`); its explicit round trip uses ASCII. Add an independent decoder and non-ASCII consumer fixtures. Preserve source-map artifact shape if library output is semantically equivalent but byte-different. [Probe and scope](evidence/codegen/README.md).

## Candidates requiring a narrower design

| Mechanism | Library or reuse option | Why adoption needs further evidence |
| --- | --- | --- |
| ICU pattern scanner, `examples.rs:3034–3306` | [FormatJS Rust ICU MessageFormat parser](https://formatjs.github.io/docs/tooling/rust-icu-messageformat-parser/) for syntax/AST | Retain Can's bounded profile, exact selector semantics, duplicate checks, depth 32, typed disclosure rules and diagnostics. More syntax support is not permission to widen Can. |
| Civil-date/RFC3339 parsing and epoch arithmetic, `types.rs:15595–15731` | Owner-derived temporal conformance, then a bounded shared core or [`time`](https://docs.rs/time/latest/time/format_description/well_known/struct.Rfc3339.html) adapter | Years 0001–9999, fixed spelling, explicit zone, no leap seconds, nonzero sub-millisecond rejection and post-offset range are Can rules. No temporal failure was demonstrated. |
| Repeated cycle walks, `resolve.rs:2126,5179,5252`, `types.rs:4954` | Shared graph routine or [`petgraph` SCCs](https://docs.rs/petgraph/latest/petgraph/algo/scc/kosaraju_scc/fn.kosaraju_scc.html) | Per-origin walks can repeat work up to O(V(V+E)); iterative SCCs offer O(V+E). Preserve edges/scopes, deterministic witnesses, diagnostic multiplicity and owners whose chains reach a cycle. No measured workload selects a crate over a shared routine. |
| Duplicated position conversion, `source.rs:137,160`, `ide/queries.rs:100` | Shared `LineIndex` adapter; optionally [`line-index`](https://docs.rs/line-index/latest/line_index/) | Existing code is small and tested. Preserve byte spans, CRLF and clamping; third-party adoption is optional, consolidation is the clearer immediate benefit. |
| Lexical path normalization, `docs.rs:1061` | `path-clean` if path work is consolidated | Root identity and symlink/external-source policy still belong to Can. A small standalone helper is weak justification for another dependency. |

ICU inspection also identified type-rule divergence: compiler `number` accepts only Int (`examples.rs:3137`), whereas runtime ordinary number accepts int or decimal (`icu.ts:605`); compiler treats cardinal and ordinal identically, whereas runtime ordinal requires int. These are code-level observations requiring focused parity cases and reconciliation with DESIGN §9.1, not executed ICU defects or evidence that a parser library solves the policy.

The native [values core](../../../packages/values/semantics/src/lib.rs) now contains temporal/value implementations, but is a private package API. The [living language review](../../ideal-filetree-plan/finished-product/reviews/language.md), L-F03, explicitly defers direct compiler linkage until the semantic boundary, build cost and versioning are qualified. Begin with conformance/owner-derived data; this audit does not reverse that decision or authorize a package port.

## What should stay custom

- Can lexing/layout/description attachment, recoverable parsing, source-specific diagnostics and conservative formatting. [`rowan`](https://docs.rs/rowan/latest/rowan/) supplies lossless storage, not the language grammar or recovery contract. The 456-line CST already carries decoded token/description payloads; storage migration is architectural work.
- Resolution, type/effect/authority checking, fixture/scenario semantics, policy derivation and IR lowering. File size does not make these library implementations.
- The diagnostic model, stable codes, sorting, completeness and simple human rendering. Rich renderers are optional presentation changes.
- Evaluation order, runtime imports, exact numeric wire policy and span attribution. [`Oxc codegen`](https://docs.rs/oxc_codegen/latest/oxc_codegen/struct.Codegen.html) can print a JS AST, but a broad AST migration needs its own maintenance or correctness justification.
- Source/revision/snapshot ownership. [`Salsa`](https://docs.rs/salsa/latest/salsa/) offers incremental computations; it still requires correct query boundaries, catalog invalidation and memory lifecycle. Measure current editor rebuilding and a simple snapshot cache before choosing it.
- Exact textual decimal admission (38 significant/18 fractional digits), checked unit conversions, pinned currency data and runtime-owned timezone membership. These are language policy or existing standard-library operations; a differently bounded numeric/data crate is not a drop-in improvement.
- The short build commit lookup. `build.rs` assumes `.git` is a directory when setting watchers; Git's own path resolution is a focused option for linked-worktree/packed-ref handling. This is an inspection concern, not a reproduced stale-version failure or a reason to add a large metadata crate.

## Proposed follow-through

The [detailed sequence of implementation passes](implementation-passes.md) expands these packets into contracts, exact scope, deliverables, acceptance checks, dependency joins and parallel writer ownership. Its original planning text is preserved alongside the completion receipts above; pass labels are not canonical task IDs or releases to package workers.

[Pass 0 contracts and outcome witnesses](pass0/README.md), prepared 2026-10-07, pin fresh compiler and owning package inputs, exact packet writers, byte/semantic compatibility and scoped unresolved gates. This preparation implements no compiler repair or candidate dependency.

| Packet | Changes and defining owners | Dependency and acceptance |
| --- | --- | --- |
| Decode ownership | Consume lexer-decoded strings in IR and applicable analysis paths; remove secondary decoders | Independent small fix; assert control escapes and supplementary Unicode survive source → IR → JS |
| Hash adapter | `source.rs` plus manifest/lock owner adopts `sha2` | Independent; preserve hash vectors, stale-fix/source/reference digests; measure release footprint |
| File replacement | `cli.rs` uses owned destination-local temp files and explicit metadata policy | Independent; retain refusal/error behavior, verify modes and specified symlink/platform semantics |
| JSON boundary | One shared writer coordinates `json.rs`, serializer users and manifest/lock edits | Establish field/ordering/duplicate/raw-number/limit fixtures first; migrate output separately from input admission |
| URL and locale admission | `analysis/types.rs` with value-owner conformance | Separate validator packets share one defining-file writer; qualify HTTP(S), userinfo, malformed input, locale extensions and canonical duplicates |
| LSP wire | `lsp/server.rs` and `transport.rs` | Strict bytes/envelope can release immediately; typed output follows the relevant serialization seam. Preserve edit versions, lifecycle, bounds and exact obligated IDs; framework transport remains gated |
| Source maps | `codegen/sourcemap.rs` and consumers/tests | Decide original column contract, qualify independently decoded maps and real consumers, preserve artifact fields/order |
| Optional infrastructure | CLI metadata, ICU parse-core, temporal reuse, graph and position consolidation | Separate bounded comparison; preserve policy and owner boundaries before selecting dependencies |

Parallel implementation would need one shared manifest/lock writer and exclusive writers for `types.rs`, `cli.rs` and serializer families. Those original packets were planning output; their implemented/admitted scope is now recorded in the completion table and receipts above.

## Original audit review and verification

Three focused Rust reviews covered protocol/CLI/foundation, codegen/output utilities and syntax/analysis/IDE. An independent challenge rechecked codegen coordinates/string ownership, runtime URL/locale policy, ICU/temporal limits and framework substitutions. It changed the string recommendation to consume the existing token payload first, qualified the source-map claim and rejected a blind `lsp-server` swap. This is targeted responsibility review, not proof that every semantic branch in 71,473 lines was audited or a complete repository/file-tree refresh.

At the original audit stage, executed baseline checks passed: **89 library tests**, and **45 integration tests** across `foundation`, `authoring` and `exe`. The additional 17 LSP unit tests reported by the protocol reviewer overlap the 89 and are not counted again. Saved probes establish the uncovered string, URL, locale, LSP and file-mode behavior. Candidate crates were researched through primary documentation/source; none was integrated, benchmarked or cross-platform qualified. At that audit stage compiler/build/test sources and manifests were unchanged. The living plan checkpoint is unchanged; no merge occurred.

The detailed pass sequence received a separate independent scheduling review. Its [planning-only verification](evidence/pass-sequence-verification.json) checks preserved compiler hashes, local links and documentation whitespace; it reruns no product tests and qualifies no candidate dependency.

As required by AGENTS.md, three independently worded equivalent JEV choice requests compared focused libraries, retaining custom utilities with repairs, and broad framework migration. [Requests and responses](evidence/jev/) returned:

| Variant | Choice | Confidence | Focused libraries | Custom repairs | Broad framework |
| --- | --- | --- | --- | --- | --- |
| 1 | TARGETED | 0.83 | 0.89 | 0.11 | 0.00 |
| 2 | CUSTOM | 0.40 | 0.40 | 0.59 | 0.01 |
| 3 | TARGETED | 0.93 | 0.96 | 0.04 | 0.00 |

All responses identify `jev-1.13.0`; usage totals are 2,775 input and 141 output tokens. The initial sandboxed request failed to connect and received no answer; the saved successful requests used the standing authorization.

Disagreement investigation found no material reversal in the supplied alternatives or compatibility requirements. Wording and option order vary, and the question aggregates mechanisms with different adoption costs. JEV supplies no rationale, so neither the cause of the swing nor a crate-specific verdict can be inferred. Preserve each answer rather than averaging into an endorsement. The recommendation remains an engineering proposal based on the concrete utility boundaries and probes; urgent defect repair and use of already-owned decoded values do not depend on adopting a blanket dependency policy.
