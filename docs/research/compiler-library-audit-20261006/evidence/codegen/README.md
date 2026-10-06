# Codegen utility audit evidence

Baseline: `309644a` (2026-10-06). No compiler source edits. The probe uses the existing `compiler/target/debug/libcanlang_compiler.rlib` (mtime 2026-10-06 21:21 local) with Rust 1.99.0. The working compiler source files were clean when inspected; existing decisions and Rust-port implementation work were left untouched. The full suite was not rerun for this investigative probe.

Files:

- `string-and-columns-probe.rs`: standalone public-API probe, including a valid app/package source and a scratch catalog under `/private/tmp`.
- `probe-output.txt`: exact stdout from the final probe run.

Run from the repository root:

```sh
rustc --edition=2024 docs/research/compiler-library-audit-20261006/evidence/codegen/string-and-columns-probe.rs --extern canlang_compiler=compiler/target/debug/libcanlang_compiler.rlib -L dependency=compiler/target/debug/deps -o /private/tmp/canlang-codegen-string-probe
/private/tmp/canlang-codegen-string-probe
```

String decoding observation: a scenario returning the source token `"\b\f\uD83D\uDE00"` analyzes and emits without diagnostics, with production `EmitOptions::new()`. The lexer decodes code points `[8, 12, 128512]`; generated JavaScript contains `return "bf��";`. The probe constructs a complete diagnostic result after clean `check_program`; it tests the public emission seam, not the CLI driver or execution of generated code. The catalog is versioned and empty because the source uses no catalog builtin.

Live lowering chain: `codegen/ir.rs:2363` (`decode_literal`) → `decode_string:667` → `unescape_json:676`. `literal_string_opt:2610` also calls `decode_string`. The IR helper lacks `b`/`f` cases and converts each UTF-16 surrogate independently to U+FFFD, while `syntax/lexer.rs:691` already implements control escapes and surrogate-pair decoding.

Source-map coordinate observation: direct public `sourcemap::build` for original text `é😀x`, attributed to `x` at UTF-8 byte offset 6, emits `originalColumn=6`; the UTF-16 column is 3. `sourcemap.rs:56` calls byte-based `LineIndex::line_col` (`source.rs:137`). `compiler/tests/codegen.rs:119` validates maps by decoding with the same in-tree decoder, and line 146 discards `src_col`; the exact round-trip fixture at line 3180 uses ASCII. This is a demonstrated difference of coordinate units, not a demonstrated browser misnavigation. ECMA-426 defines columns in UTF-16 for JavaScript/CSS maps and allows other content types to diverge; Can's original-source consumer contract must be verified before declaring a blanket normative defect. Replacing the VLQ codec does not perform this coordinate conversion automatically.

Primary documentation checked on 2026-10-06:

- [Serde JSON](https://docs.rs/serde_json/latest/serde_json/) and [to_string](https://docs.rs/serde_json/latest/serde_json/fn.to_string.html): typed `Serialize` data and JSON parsing/rendering.
- [Serde field attributes](https://serde.rs/field-attrs.html): explicit renames, omitted optionals, and custom serialization.
- [RawValue](https://docs.rs/serde_json/latest/serde_json/value/struct.RawValue.html): validated embedding of already encoded JSON values, preserving their original representation.
- [SourceMapBuilder](https://docs.rs/sourcemap/latest/sourcemap/struct.SourceMapBuilder.html): source/name registration, contents, raw tokens, final source map.
- [SourceMap](https://docs.rs/sourcemap/latest/sourcemap/struct.SourceMap.html): independent decode/encode and documented possibility of equivalent but byte-different serialization.
- [ECMA-426](https://tc39.es/ecma426/#sec-terms-and-definitions): column units; [mappings structure](https://tc39.es/ecma426/#sec-mappings-structure): original column references.
- [Oxc Codegen](https://docs.rs/oxc_codegen/latest/oxc_codegen/struct.Codegen.html): JS AST printer and expression/string output.
- [path-clean](https://docs.rs/path-clean): lexical normalization only, including defined leading-parent behavior; it does not resolve symlinks.
- [Git rev-parse](https://git-scm.com/docs/git-rev-parse): use Git's repository path resolution instead of assuming a directory at `../.git`.
