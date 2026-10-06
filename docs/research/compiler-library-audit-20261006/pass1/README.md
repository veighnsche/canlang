# Pass 1: lexer-owned source strings

**C01IR and C01A completed within the released source/string contract, 2026-10-07.** IR and analysis consume `Token.string_value` retained by `SyntaxNode::token()`. The two secondary JSON-body decoders, IR's `decode_string` wrapper and analysis's decoder-only `hex4` helper are removed. No dependency, grammar, JS AST, serializer or package change is needed. The source-aware lexer and its diagnostic spans are unchanged.

The first checked IR repair was committed as `9bb5bbd`. The completion commit includes analysis consolidation, recovery witnesses, production CLI/testkit execution, this receipt and removal of incidental formatting changes from the first commit. [Verification](verification.json) pins the final working compiler inputs, host, catalog and checks; [input manifest](input-manifest.json) pins 665 compiler, package manifest/lock and built runtime files. The baseline compiler binary is the fresh Pass 0 build at `38c0370087909dc89386849fec48e6f937aa0d13`, whose compiler code matches `309644a6881909d8dba32560bc6711f67e00a7ab`.

## Caller closure and ownership

| Former decoder entry | Live caller closure | Final behavior / evidence |
| --- | --- | --- |
| IR `decode_string` → `decode_literal` | All lowered string expressions, including field defaults and emitted BDD input/cell/expected/observation closures | Read the direct String token payload; no payload becomes `IrExpr::Unsupported`, never reconstructed text. Six fixed decoded/JS witnesses and real generated closure execution. |
| IR `decode_string` → `literal_string_opt` / `literal_string` | Message source and variant values, explicit format locale, page title/captions, `opens=` and static text; field descriptions/labels through the same lowering routes | Read the direct token payload; authored empty text, explicit `null` and missing payload remain distinct. Synthetic recovery witness plus default/description/label IR and emitted-value checks. |
| Analysis `unescape_json` → `string_literal_value` | Captions/labels, description slots and legacy annotations, message source/variants/slots, require messages, module `source=`, context locale defaults, page static text, fixture MIME and delivery status | Read direct CST leaf payload; all helper callers were traced and updated. Non-string values still follow existing type/shape checks. Missing payloads are handled locally at affected checks. |
| Analysis `unescape_json` → `string_leaf_value` | Quoted message locale keys | Read the bare String token payload; escaped tag admission and source-span regressions. |
| Analysis direct `unescape_json` calls | Schedule key identity, string literal typing, `local_instant` time checks, `format` template/value checks, date/datetime constructors, validated-string argument inhabitation | Reuse the same payload helper. Valid escaped values and invalid semantic shapes retain their independent outcomes and authored token spans. Invalid source cannot supply a made-up empty value. |

This accounts for **both IR decoder callers and all eight analysis decoder uses**, including the indirect helper closure. `hex4` had no caller outside the deleted analysis decoder. `literal_leaf` remains for numeric/name/source-sensitive work. Lexer `decode_json_string`, JSON-input parsing and JS-output encoding remain their separate owners. Existing effects/examples raw-body recovery fallbacks contain no secondary escape parser and are unchanged.

## Compatibility classification

| Boundary | Classification |
| --- | --- |
| Valid IR `\b`, `\f` and surrogate pairs | **Correctness repair:** old emission corrupted these accepted strings. Values now retain code points 8, 12 and 128512. Preserving the old corrupted bytes is not intended compatibility. |
| Quotes, slash/backslash, BMP and raw supplementary Unicode, line controls, empty strings | **Preserved values:** independent code points and fixed JS spellings are permanent witnesses. This pass keeps output layouts/field ordering and the existing encoder. |
| Valid analysis values and semantic rejection | **Preserved contract:** date/time/template/locale/slot/key rules are unchanged; diagnostics continue to use source byte spans. Analysis's former decoder was correct for valid input; this is consolidation rather than a new valid-input analysis repair. |
| Missing payload versus empty and explicit-null values | **Distinct:** an invalid token contributes no decoded value; authored `""` remains present and duplicate empty schedule keys still diagnose; explicit `null` message variants remain absent translations. |
| Malformed source and secondary analysis diagnostics | **Source errors preserved; false value-based recovery corrected:** every baseline `E1006` message/span in the seven CLI comparisons is unchanged. Checks no longer invent an empty schedule key/status or a value/type complaint for the already invalid token. Valid sibling declarations, variants and payloads retain independent diagnostics. [Before/intermediate/final comparison](invalid-recovery-comparison.json) makes these differences explicit. |
| Expression evaluation and source-aware lexing | **Preserved:** no statement/argument evaluation, AST/CST grammar, lexer algorithm, effect, permission or runtime implementation changed. Existing compiler suites cover surrounding routes. |

Recovery is deliberately local to string-consuming checks. A shared recursive `has_error` change was rejected in review because it could suppress an entire module or declaration and hide valid siblings. The permanent full-analysis witnesses cover raw controls, unknown escapes and lone surrogates, false schedule collisions, independent default/name errors, a valid variant error and an independent delivery payload error. This applies the existing lexer-owner/error-recovery contract; it selects no new admission or library policy requiring JEV consultation.

## Regression transfer and execution

All eight ready cases in Pass 0 `witnesses/strings.json` are promoted into owning tests. Permanent coverage is in `compiler/tests/codegen.rs`, `compiler/tests/analysis.rs`, `compiler/tests/syntax.rs`, `compiler/tests/string_payload_runtime.rs` and the IR recovery unit test. Expected values use fixed decoded strings/JS literals and explicit Unicode scalar arrays; neither decoder nor a replacement library supplies the oracle.

The runtime witness uses the **actual `can compile` CLI**, actual `packages/values/dist/catalog.json`, Node 24.21.0 and built workspace packages. No synthetic catalog, manually asserted `complete=true` or runtime stub is used. For each of six authored tokens it:

1. Compiles and imports an unmodified metadata-only entry against the public UI message factory, checking the field default, label source/translation and explicit-null variant; checks the literal descriptor default as well.
2. Compiles a separate supported scenario/example fixture, loads the unmodified BDD module through public `@canlang/testkit` `loadExampleSuite`, and executes `row.setup`, `stashedRowOf` and `row.observe`. Input, row cell, expected value and direct literal observation must match the independent code points.

All six witness success lines were observed in the focused run. The full suite also executes this test successfully. The test skips loudly when built packages or Node are absent and has no fixture fallback. Its Unix profile is appropriate for the existing Linux/macOS compiler targets; execution here qualifies **macOS arm64 only**.

A first combined member-gated entry failed to link because the existing built stdlib does not export the emitted `require` binding. Splitting the minimal metadata and BDD artifacts qualifies the relevant emitted values without changing packages or using a stub. **Application operations, admission and full installed-runtime execution are not claimed.** The pre-existing IR Name-only locale-key handling also drops quoted keys from direct inline descriptors; quoted-key *analysis* is covered here, while that separate emission eligibility gap remains for C03L.

## Checks, delegation and replay

- Full locked compiler suite: **915 passed, 0 failed** before the final delivery-status guard/test and IR test-module relocation; [raw log](full-suite.log).
- After the final recovery correction: complete analysis and B4 suites **32 + 279 passed**; [raw log](final-analysis.log). Final C01 IR unit/codegen/syntax checks: **3 passed**; [raw log](final-focused.log).
- Final `cargo clippy --all-targets -- -D warnings`: **passed**; [raw log](clippy.log).
- `git diff --check`: **passed**. Full `cargo fmt --check` still reports **88 pre-existing hunks**. A fresh baseline tree at `d855e0a` reports exactly the same normalized differences; [comparison](fmt-comparison.json). Formatting was applied to changed regions and unrelated churn was removed.

IR implementation used **GPT-6.1 Sol low** as planned. A second worker dispatch was rejected by the session's thread limit, so analysis/integration stayed with the coordinator and independent review reused an existing inherited worker. That worker's model/effort is not exposed; it is not represented as Sol medium. No stronger IR worker was requested, and no task token savings are claimed. Review found and resolved the missing-payload diagnostic/identity recovery issues and verified the final delivery-status correction.

Replay from the repository root with already built runtime packages:

```sh
cargo test --locked --manifest-path compiler/Cargo.toml --test analysis --test codegen --test syntax c01_
cargo test --locked --manifest-path compiler/Cargo.toml --test string_payload_runtime -- --nocapture
cargo clippy --locked --manifest-path compiler/Cargo.toml --all-targets -- -D warnings
```

The frozen Pass 0 receipt is unchanged. No merge was performed and the living file-tree checkpoint is not advanced. Passes 2 onward keep their existing contracts, gates and task-specific economical-model reminders.
