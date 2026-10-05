# CanLang compiler

A dependency-free Rust workspace: library crate `canlang_compiler` plus the
`can` binary. Fourteen subcommands, one dispatch (`src/cli.rs`), exit
0 clean / 10 errors reported / 2 tool failure:

- `compile`, `check`, `lint`, `fmt`, `explain`, `lsp`, `policy` — the
  compiler and authoring tools (full pipeline over the producer catalog;
  `can check` reports `complete=true`).
- `run`, `test`, `build`, `deploy`, `activate` — thin lane-7 entries that
  exec `can-platform` with argument passthrough (override with
  `CAN_PLATFORM_BIN`); never a second engine.
- `completions bash|zsh|fish` — print the shell completion script
  (also shipped as `can-completions.<shell>` in this directory).
- `help [COMMAND]` — alias for `--help`.

`can --version` prints the tool, commit, language, and schema versions
(commit via `build.rs`, no VERGEN). Any internal fault prints one
`error[E7005]` line and exits 2 — never a Rust trace or exit 101.
`can lsp` shuts down gracefully on stdin EOF or the `shutdown`/`exit`
handshake. `can fmt` writes files atomically (temp file + rename).

Implemented modules:

- `src/source.rs`: `SourceDb`/`SourceId`, byte `Span`, `LineIndex`
  (LF/CRLF, LSP UTF-16 positions) and stable SHA-256 content hashes.
- `src/diagnostic.rs`: the one diagnostic engine — stable codes, severity,
  deterministic compact JSON envelope and human text rendering.
- `src/lib.rs`: shared version/exit-code constants.
- `src/cli.rs`: single dispatch for all `can` subcommands.
- `src/explain.rs`: diagnostic code catalog behind `can explain`.
- `src/lsp/`: dependency-free stdio LSP server (framing, lifecycle,
  versioned diagnostics) with the production analysis backend.
- `src/json.rs`: shared JSON value model (LSP transport + catalog loader).
- `src/analysis/`: producer-catalog consumer (`--catalog`, `CAN_CATALOG`),
  name resolution, type checking, and effects over the CST.
- `src/syntax/`: lossless recoverable CST parser for the full GRAMMAR.md
  (lexer, layout/descriptions, CST, parser, E1xxx diagnostics). Parses the
  whole `examples/` + `draft/` corpus cleanly; see `tests/syntax.rs`.
- `src/codegen/`: IR build and JS/BDD emitters behind `can compile`.
- `src/policy.rs`, `src/lint/`, `src/format.rs`, `src/ide/`: policy dumps,
  lint rules, the formatter, and editor services.

Run from this directory with `cargo run -- --help`. Check with
`cargo test`, `cargo clippy --all-targets -- -D warnings` and
`cargo fmt --check`. Ship with `cargo build --release --locked`
(`[profile.release]` strips and optimizes for size). Install from a
release binary with `docs/install.md` at the repo root. Local build
output in `target/` is ignored.
