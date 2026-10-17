# Independent Pass5 released-family review

Review date: 2026-10-07. Read-only repository review against HEAD; only this receipt was written. Scope: current output changes in compiler/src/codegen/{js,artifact,bdd}.rs, docs.rs, policy.rs, explain.rs and lint/driver.rs. Read Pass0 README and serialization-maps witnesses, and C05D released contract. No package, manifest, Git, input-parser or dependency-policy edits.

## Finding

No blocking behavioral mismatch found in the reviewed output seams. This is a scoped review, not a claim of complete downstream release qualification.

## Evidence

- Compared every changed descriptor serialization branch with its previous renderer. Explicit tags, delivery/nominal order, required false flags, meaningful-only nullable, present array.required=false, Some(empty) metadata, unique-key omission, parent and app scope preserve their previous shape/order. Operation/member and model arrays remain slice-ordered.
- WireLiteral retains integer and duration decimal strings, exact authored decimal spelling/scale, money minor strings, actual Boolean/null values, recursive ordered object entries (including duplicate keys), and previous constructor/nonliteral/checked-negation restrictions. It introduces no floating-point intermediary. Pass0 runtime decimal re-encoding normalization remains a consumer fact, distinct from compiler authored spelling.
- Artifact root/nested DTO order matches removed writer order; directives omit only None in the same order. Empty arrays remain required. Raw fragments are produced only by the compiler-owned operations/models/source-map writers, qualified through RawValue before embedding, and preserve exact tokens/order. Default Literal raw strings are grammar-qualified and report serialization errors; RawValue does not establish Unicode-scalar validity or replace input admission. Public closed String adapters expect successful serialization rather than substituting null/empty output.
- Reference serialization preserves camelCase names, omitted absent defaults/descriptions/expected, explicit catalogVersion null and absent translation null, authored empty translations, availability tags, source/extracted ordering and integer spans. Compatibility Json views serialize then use the unchanged parser; production to_json_string serializes directly.
- Policy formatter matches the previous mixed layout, including six-space nested closing indentation, inline requires/params, omitted options, source facts and one serializer LF. The current CLI intentionally adds its second LF; the permanent real CLI witness pins this.
- Explain preserves all six fields and severity spelling, no serializer LF and one CLI LF. Lint fixes preserve file independently from span.file, numeric span bounds, field order, slice order and all three rejection variants.
- Exact source comparisons through git show HEAD confirmed: js.rs executable suffix beginning at `Production modules plus link metadata` unchanged; bdd.rs prefix before js_string unchanged; policy extraction suffix beginning at current module context unchanged; docs extraction region unchanged. BDD only replaces its string helper plus adds tests; generated executable functions/imports remain authored JavaScript.
- Focused command: cargo test --manifest-path compiler/Cargo.toml --target-dir /private/tmp/canlang-compiler-pass5 --test typed_descriptors --test typed_artifact --test typed_references --test typed_policy --test typed_explain --test typed_fixes --test typed_bdd. All 24 tests passed (6/2/3/4/3/4/2 respectively). Independently authored fixed expectations cover empty/populated branches and omissions rather than relying solely on old/new encoder comparisons.

## Remaining scope and coverage limits

- CLI lint --fix still manually spliced the final fixes member in the reviewed snapshot; root was already converting this released seam. Review of its final replacement and real consuming CLI tests is required separately.
- Focused family tests do not by themselves execute emitted JavaScript or qualify downstream artifact/docs/exact-value consumers. Root/another writer owns actual consuming integration tests. BDD snapshots preserve function recipes but do not prove execution.
- Full ASCII-control coverage resides in the shared formatter/diagnostic and BDD unit tests; individual family snapshots sample representative controls. Some nested array/metadata combinations are established by branch review rather than exhaustive combinatorial tests.
- Shared input parser, raw lexeme/depth/accessor/LSP numeric behavior remains outside this output migration. RawValue qualification applies to compiler-owned encoded fragments only.
- JsServerInit retains its previous static-token compatibility method while production typed enum serialization is added; both spellings are explicitly compared in the descriptor test.
- No new input format, decimal arithmetic/canonicalization policy, source-map coordinate policy, runtime installation claim or universal closure minimum was assessed.
