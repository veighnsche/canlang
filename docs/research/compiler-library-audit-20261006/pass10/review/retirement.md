# Pass 10 independent retirement and dependency review

**Verdict:** the selected core mechanisms have no remaining obsolete private engine or unused direct dependency demonstrated by this review. No source deletion is recommended. The remaining handwritten paths described below are active compatibility, source-language, policy, or test adapters. This is a static retirement verdict, not fresh test, release, installed-package, or cross-host qualification.

Reviewed current production source and raw working-tree production diffs before predecessor receipts/verdicts. Read `AGENTS.md`, the implementation programme, Pass 0 protocol contracts and file/hash/serialization/map witnesses, then the Pass 9 promoted correctness queue for outstanding scope. At inventory capture HEAD was `ed82712c30acb39ebf73cd31a84a03e13356d3cd`. Concurrent formatting edits change line numbers; exact source hashes and reproducible `rg` caller output are in [retirement-callers.json](retirement-callers.json). No builds, source/package edits, Git operations, decisions, or plan maintenance were performed by this reviewer. Sol medium sufficed; no escalation.

## Selected mechanism closure

| Boundary | Current implementation and live consumers | Retirement assessment |
| --- | --- | --- |
| Source strings | `syntax/lexer.rs::decode_json_string` decodes once with source-byte diagnostics. `codegen/ir.rs::decode_literal`, `literal_string_opt`, and `analysis/types.rs::string_leaf_value` read `Token.string_value`; `docs.rs` extracts checked descriptions. Literal/default/metadata routes remain represented. | The source decoder is active language ownership, not an orphan JSON document parser. Keep lexer scanning, malformed escape diagnostics, null/empty/missing payload distinctions, and public syntax adapter. No second IR/analysis string decoding engine found. |
| JSON input | `json.rs::parse` uses `serde_json::Deserializer` and `DeserializeSeed`/`Visitor`; `analysis/catalog.rs::parse_catalog` and `lsp/server.rs::run_stdio` through transport use it. The server checks UTF-8 before parsing. | No handwritten JSON grammar/string parser remains in shared input. `InputReader`, `ValueOrigin`, cursor/error coupling, bounded seeds and ordered `Json` are necessary compatibility adapters. Their coupling is explicitly pinned to serde_json 1.0.151 and needs requalification on upgrades. |
| JSON output and JS string values | `json::to_compact_string` serializes through serde_json; typed diagnostics, artifact/descriptor, docs, fix, explain, policy and LSP output call it. Both JS emitters' `js_string` and `diagnostic::push_json_str` delegate to it. | No standalone JSON/JS character-scanning escape engine remains. Two formatter cases retain `\\u0008`/`\\u000c` spelling while the crate owns scanning. Keep policy layout overrides, which own whitespace and delegate escaping. |
| SHA-256 | `source.rs::sha256_hex` is a thin `sha2::Sha256::digest` plus lowercase hex adapter. SourceDb, docs revisions, migration bodies, IDE/stale-fix and LSP fixes use it. | No compression, constants, block-padding, or alternate production hash engine found. Keep the public adapter and exact byte semantics. |
| File staging | `cli.rs::write_file_atomic` routes fmt and docs output through `replace_file_with`; `tempfile::Builder::tempfile_in` owns an open destination-local staged file, followed by persist/persist_noclobber. | No predictable temp counter/path allocation engine found. Keep destination, metadata, expected-input checks and error mapping: these own replacement semantics, not temp allocation. The code explicitly limits owner/ACL/durability and final-check race claims. |
| URL/URI | `analysis/types.rs::valid_url` uses `url::Url::parse` for HTTP(S) policy; `lsp/uri.rs::native_file_path` uses the same crate for supported file projection. LSP output uses lsp-types Uri with authored-string compatibility branches. | No compiler handwritten HTTP authority or percent-decoding engine remains. Prefix/scheme/UTF-8/NUL checks are admission/projection policy. Domain/email and trusted app_url ownership must not be erased as if equivalent to ordinary URL parsing. |
| Source-map production encoding | `codegen/sourcemap.rs::build` uses `sourcemap::SourceMapBuilder::add_raw` and the library writer, projecting encoded mappings with serde_json. Artifact assembly uses it for entry, package and example modules. | No production handwritten VLQ encoder remains. Keep collision-free source registration, source/name identity, byte-coordinate and typed wire projections. These preserve repeated authored paths and Can's original byte-column consumer profile. |

## Remaining compatibility paths are accounted for

`Json::Obj(Vec<(String, Json)>)` preserves order and duplicates; `get` keeps first-match behavior. `Json::Num(String)` preserves arbitrary authored lexemes, and `as_i64` retains lexical integer rules. Seed depth checks happen before visiting/materializing the value, including the specified empty-container boundary. `IgnoredAny` is used only for numeric grammar validation, rather than ignoring subtrees and bypassing depth or surrogate checks. The narrow numeric span projection is not a second number grammar engine.

`lsp/transport.rs::integer_value` interprets already parsed JSON numbers as exact bounded LSP integers, including supported fractional/exponent spellings, without binary floats or exponent-sized allocation. This is active protocol admission policy, distinct from JSON grammar. `response_ok` still serves shutdown/null method results, and `response_err` serves admission/method/process failures. Consequently `json::render`/`render_into` remain live. They emit the ordered compatibility representation with raw numbers and shared string serialization; converting them to serde_json::Value would silently change duplicate/order/numeric semantics. Typed LSP result output additionally renders admitted IDs into `RawValue` to preserve spellings. No permanent fallback parser is involved.

`diagnostic::push_json_str` has two production sites in `json.rs` and multiple real-process `compiler/tests/common/lsp_driver.rs` callers. `reference_json` and public docs `to_json` methods are compatibility views over typed serializers; production `can docs` uses `to_json_string`. Public `models_json`, `fix_to_json`, `fixes_to_json`, and `rejected_to_json` have integration-test callers (`typed_descriptors`, `typed_fixes`, `b3_s4`). Their lack of current production call sites does not make them obsolete private helpers. Transport `notification` also preserves the public compatibility API and its unit witness while production diagnostics use typed output.

`decode_mappings`, `DecodedSegment`, `validate_vlq_envelope`, and `add_delta` form a test-facing public source-map compatibility adapter. Unit tests and `compiler/tests/codegen.rs` use it for mapping assertions. Numeric VLQ decoding is delegated to `sourcemap::vlq::parse_vlq_segment`; the envelope checks alphabet/representable width and checked delta accumulation prevents malformed input panic/overflow. Retain it: deleting the guard or reordering decoded rows would discard tested compatibility and defensive behavior. It is not the production encoding engine and is not represented here as a complete source-map reader.

JS identifier sanitization/object-key choice, BDD identifier projection, Can quoted-source scans, message/ICU scanners, and package HTML/attribute/URL percent escaping are different domains. The package tree still has actual HTML and percent-encoding callers (for example interface print rendering and identity cookies); this compiler retirement review authorizes no package change.

## Direct dependency verdict

All seven manifest pins agree with `compiler/Cargo.lock`, and each has production use:

| Pin | Explicit profile | Production evidence |
| --- | --- | --- |
| url 2.5.8 | defaults off; std | ordinary URL admission and file-URI projection |
| sha2 0.10.9 | defaults off | sha256_hex |
| tempfile 3.27.0 | defaults off; getrandom | replace_file_with destination-local staging |
| serde 1.0.229 | defaults off; std, derive | typed serializers, custom Serialize and input seeds/visitors |
| serde_json 1.0.151 | defaults off; std, raw_value | shared parser/serializer, raw IDs/default fragments, encoded map projection |
| lsp-types 0.97.0 | defaults off | typed LSP positions/ranges/capabilities/payloads |
| sourcemap 9.3.2 | defaults off | production builder and map writer |

No unused direct dependency is identified. This table verifies declarations and call sites, not a fresh feature-resolution/build-footprint measurement; root's final locked build and dependency closure checks own that qualification.

## Limits and recommendation

The Pass 9 queue records completed numeric ICU, completion, and position/path repairs, deferred Fish terminator qualification, promoted graph witness stability policy, and additional ICU syntax/depth packets. Conditional locale, CLI framework/completion tooling, ICU, temporal, graph, and position mechanisms are retain/defer/adoption decisions at their own scope. Their surviving code is not a failure to retire the selected core substitutions and is not a target for speculative removal.

Root should retain the listed adapters and complete final consumer/check/release evidence. No obsolete private helper was demonstrated, so there is no minimal removal patch to recommend. The machine inventory contains the full `rg` matches for each candidate, including definitions/comments/imports to make caller classification auditable. Broader product prerequisites, complete original-app release, non-native host behavior and future UTF-16 source-map navigation remain outside this static verdict.
