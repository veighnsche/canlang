# Syntax inventory notes

This is an evidence index, not a correctness judgment. `inventory.json` records the exact grammar productions, concrete syntax variants, parser function declaration anchors, syntax test identities, corpus file hashes, and SHA256 pins for the inventoried sources. All line ranges are one-based and inclusive; test/function anchors intentionally identify the exact declaration line rather than claiming the complete Rust block range.

## Counts and inputs

- Normative grammar: 186 EBNF productions across `docs/specification/GRAMMAR.md` code blocks; the full grammar headings/production text and line anchors are in the JSON.
- CST: 119 `SyntaxKind` variants and 4 `NodeDetail` variants. These are enumerated at variant declaration lines in `compiler/src/syntax/cst.rs`.
- Parser: 151 Rust function declarations indexed in `compiler/src/syntax/parser.rs`; anchors distinguish parsing responsibilities but do not assert complete branch behavior.
- Test witnesses: 77 named tests across `compiler/tests/syntax.rs`, inline lexer/layout/CST tests, and focused parser/consumer witnesses in `compiler/tests/b4_parse.rs` and `compiler/tests/authoring.rs`. Each JSON entry includes its test declaration anchor, stage, oracle class, and input class.
- Golden corpus: 54 `.can` files under `examples/` and `draft/`; every file's SHA256 plus the sorted path/hash manifest digest is pinned in JSON. `golden_corpus_parses_clean` parses source and verifies CST byte coverage; it does not invoke analysis, code generation, IDE, CLI, runtime, or other downstream stages.

## Witness scope

Lexer inline tests in `compiler/src/syntax/lexer.rs` cover longest-match punctuation, numeric/unit adjacency, JSON escape decoding, CRLF/bare CR, prose/code tabs, and inline hash/backslash continuation. Layout inline tests in `compiler/src/syntax/layout.rs` cover delimiter joining, indentation/dedentation, blank/comment handling, same-column description attachment, references/suffixes, ineligible heads, and delimiter errors. CST inline tests in `compiler/src/syntax/cst.rs` cover gap/overlap detection and preorder traversal. Integration tests in `compiler/tests/syntax.rs` exercise parser declarations, expressions, queries, syntax diagnostics/spans, malformed input, recovery, and full corpus parsing; all are parser-owned expected-output tests except that the corpus inputs are repository-authored source files.

Descriptions/labels and typed field defaults are exercised by `compiler/tests/b4_parse.rs::desc_delimits_default_bounds_label` (declaration anchor in JSON). EOF spans are asserted by `compiler/tests/syntax.rs::parser_error_codes_and_spans` (two cases expect zero-width EOF positions). Malformed Unicode escapes are exercised by `malformed_unicode_escapes_are_diagnostics`; JSON escapes by lexer `strings_decode_json_escapes`; parser recovery by `multiple_errors_recover_per_declaration` and `invalid_app_header_layout_wraps_identity_and_preserves_body`. An indexed source path or grammar rule is not by itself a witness. General Unicode identifier behavior, end-to-end consumer acceptance, and downstream stage outcomes remain gaps unless a separately indexed workflow witness establishes them. In particular, valid UTF-8 source parsing does not establish malformed byte handling by downstream consumers; syntax tests that call `parse_source` are not downstream tests.

## Corpus exceptions

The test documents two known draft-owner exceptions in `compiler/tests/syntax.rs` at `KNOWN_CORPUS_DEFECTS` (lines 61–75): `draft/CanShift.can` and `draft/CanVolunteer.can`, each pinned to exactly two `E1203` diagnostics with full CST byte coverage. The adjacent comment records the current explanation: trusted-scenario `each=` fan-out has no normative production in `GRAMMAR.md` or `DESIGN.md`, and is handed off as `HO-DRAFT-01`. This is a fixture defect record, not acceptance of the syntax. The corpus test fails on changed diagnostics or coverage, or on any new failing file. The corpus count is deliberately not fixed by that test; the count and hashes here are an as-observed snapshot.

## Recovery history

Commit `4ecd991a80ca025b6d5899ffdcea96075c60c25e` (`fix(analysis): preserve independent diagnostics for malformed declarations and invalid headers`, 2026-10-07) changed `compiler/src/syntax/parser.rs` in the invalid app-header layout recovery branch: after attaching child recovery it wraps the invalid header attempt in `SyntaxKind::Error`, preserving the app body as a sibling. It added `invalid_app_header_layout_wraps_identity_and_preserves_body` at `compiler/tests/syntax.rs:945` (current source line may move), which asserts `E1200`, span `(0,3)`, no direct `Name` identity under `App`, an `Error` subtree containing `Name`, and preserved `Derive`. The same commit changed analysis diagnostic preservation and added analysis/LSP tests; those are outside this syntax inventory. The JSON SHA pins bind this snapshot to the current working-tree revisions.

## Reading boundary

Step 2 `coverage.jsonl` and Step 3 `workflows.md` were consulted only to navigate existing responsibility and workflow records, as instructed. This inventory preserves their open semantic and consumer gaps. The two marked downstream witnesses are `b4_parse.rs::each_package_body_still_checked` (parse, resolve, types, unresolved-name emission) and `authoring.rs::explain_round_trips_every_emitted_code` (parser diagnostic production consumed by explanation lookup and JSON/text rendering). They use self-authored fixtures/catalog inputs. A test name, parser declaration, or source corpus file is a locator; it does not certify the language contract, test adequacy, or broader consumer behavior.
