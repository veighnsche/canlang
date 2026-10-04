# CanLang compiler (lane 01)

A dependency-free Rust workspace: library crate `canlang_compiler` plus the
`can` binary. Help and version output work; `compile`, `lint` and `fmt` are
still reserved and exit with a nonzero error until their slices land.

Implemented so far (slice 0 foundation):

- `src/source.rs`: `SourceDb`/`SourceId`, byte `Span`, `LineIndex`
  (LF/CRLF, LSP UTF-16 positions) and stable SHA-256 content hashes.
- `src/diagnostic.rs`: the one diagnostic engine — stable codes, severity,
  deterministic compact JSON envelope and human text rendering.
- `src/lib.rs`: shared version/exit-code constants.
- `src/syntax/`: lossless recoverable CST parser for the full GRAMMAR.md
  (lexer, layout/descriptions, CST, parser, E1xxx diagnostics). Parses the
  whole `examples/` + `draft/` corpus cleanly; see `tests/syntax.rs`.

Run from this directory with `cargo run -- --help`. Check with
`cargo test`, `cargo clippy --all-targets -- -D warnings` and
`cargo fmt --check`. Local build output in `target/` is ignored.
