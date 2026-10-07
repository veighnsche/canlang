# CanLang compiler

A Rust compiler with pinned, focused infrastructure libraries: library crate
`canlang_compiler` plus the `can` binary. Fifteen subcommands, one dispatch
(`src/cli.rs`), exit
0 clean / 10 errors reported / 2 tool failure:

- `compile`, `check`, `lint`, `fmt`, `explain`, `lsp`, `policy` — the
  compiler and authoring tools (full pipeline over the producer catalog;
  `can check` reports `complete=true`).
- `docs` — extract the checked reference model and pipe typed JSON to the
  installed `can-platform docs` renderer; rendering needs that runtime.
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
handshake. `can fmt` replaces each changed file atomically using a
destination-local owned temporary file and preserves the promised source mode.
Atomic entry replacement does not promise crash durability or owner/ACL retention.

Implemented modules:

- `src/source.rs`: `SourceDb`/`SourceId`, byte `Span`, `LineIndex`
  (LF/CRLF, LSP UTF-16 positions) and the stable `sha2` byte-hash adapter.
- `src/diagnostic.rs`: the one diagnostic engine — stable codes, severity,
  deterministic compact JSON envelope and human text rendering.
- `src/lib.rs`: shared version/exit-code constants.
- `src/cli.rs`: single dispatch for all `can` subcommands.
- `src/explain.rs`: diagnostic code catalog behind `can explain`.
- `src/lsp/`: bounded stdio framing and explicit request admission/lifecycle,
  typed `lsp-types` output, versioned edits/diagnostics and the production backend.
- `src/json.rs`: bounded Serde JSON input and typed output adapters; the
  compatibility view retains ordered duplicates and exact numeric lexemes for
  the catalog/LSP callers that require them.
- `src/analysis/`: producer-catalog consumer (`--catalog`, `CAN_CATALOG`),
  name resolution, type checking, and effects over the CST.
- `src/syntax/`: lossless recoverable CST parser for the full GRAMMAR.md
  (lexer, layout/descriptions, CST, parser, E1xxx diagnostics). Parses the
  whole `examples/` + `draft/` corpus cleanly; see `tests/syntax.rs`.
- `src/codegen/`: lexer-decoded IR strings, JS/BDD emitters and `sourcemap`
  codec behind `can compile`; original Can map columns retain byte units.
- `src/policy.rs`, `src/lint/`, `src/format.rs`, `src/ide/`: policy dumps,
  lint rules, the formatter, and editor services.

Run from this directory with `cargo run -- --help`. Check with
`cargo test --locked`, `cargo clippy --locked --all-targets -- -D warnings` and
`cargo fmt --check`. Ship with `cargo build --release --locked`
(`[profile.release]` strips and optimizes for size). Install from a
release binary with `docs/install.md` at the repo root. Local build
output in `target/` is ignored.

The [final compiler qualification](../docs/research/compiler-library-audit-20261006/pass10/README.md)
records the locked dependency/features, supported host/consumer scope, release
measurements and retired predecessor engines. URL admission uses `url` while
retaining authored values; JSON output uses `serde`/`serde_json`. Destination
policy, protocol IDs/bounds, grammar and value rules remain compiler-owned.

The [production-reduction follow-up](../docs/research/compiler-library-audit-20261006/production-reduction/README.md)
requires smaller owned implementations as well as faithful behavior. Its first
packet consolidates URI-bearing LSP output into one authored-identity projection
while retaining the library's ranges, diagnostics, edits and action fields.

Conditional locale, CLI framework, ICU, temporal, graph and position-library
mechanisms have explicit retain/defer results. The [locale candidate gate](../docs/research/compiler-library-audit-20261006/pass3/README.md)
and [remaining ICU/graph packets](../docs/research/compiler-library-audit-20261006/pass9/correctness/QUEUE.md) stay explicit;
compiler qualification does not complete original-app or installed-release
product gates. See the [pass sequence](../docs/research/compiler-library-audit-20261006/implementation-passes.md)
for task/acceptance links.
