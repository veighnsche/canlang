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
- `src/cli.rs`: single dispatch for all 10 `can` subcommands (exit 0/10/2);
  `run|test|build|deploy` are thin `can-platform` passthrough entries.
- `src/explain.rs`: diagnostic code catalog behind `can explain` (E1xxx
  matches the parser exactly; E2–E6 reserved placeholders).
- `src/lsp/`: dependency-free stdio LSP server (framing, lifecycle,
  versioned diagnostics) behind stub analysis hooks.
- `src/json.rs`: shared JSON value model (LSP transport + catalog loader).
- `src/analysis/`: producer-catalog consumer (`--catalog`, `CAN_CATALOG`),
  name resolution (E2xxx) and type checking (E3xxx) over the CST;
  `can check` runs the real pipeline with `complete=false` until the
  effects/examples slice lands. New grammar: judgment/corpus Given
  declarations, `invocation(...)` types, gallery/slot/preference-panel/edit
  UI, generic catalog-item shape (membership validates in analysis).
- `src/syntax/`: lossless recoverable CST parser for the full GRAMMAR.md
  (lexer, layout/descriptions, CST, parser, E1xxx diagnostics). Parses the
  whole `examples/` + `draft/` corpus cleanly; see `tests/syntax.rs`.

Run from this directory with `cargo run -- --help`. Check with
`cargo test`, `cargo clippy --all-targets -- -D warnings` and
`cargo fmt --check`. Local build output in `target/` is ignored.
