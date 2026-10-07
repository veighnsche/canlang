# Native verification

All commands execute from the repository root with Rust1.99.0, Node24.21.0. Fresh actual `compiler/target/debug/can` is used by the unchanged editor consumer; Cargo integration tests use fresh CARGO_BIN_EXE_can. Exact final compiler/package inputs are in the host profile.

- `cargo test --offline --manifest-path compiler/Cargo.toml`:1,034 tests,0 failures/ignored,48 harnesses. This includes prior input/admission/current real consumer qualification.
- `cargo test --offline --manifest-path compiler/Cargo.toml --test lsp_typed_output`:3 final tests after equivalent lint polish,61 independent checked frames,0 skips.
- `CAN_BIN=/Users/vince/Projects/canlang/compiler/target/debug/can node editors/vscode/test/lsp-capabilities.cjs`:39 unchanged actual editor checks pass, all advertised providers/legend and existing Location/Range order expectations.
- `cargo clippy --offline --manifest-path compiler/Cargo.toml --all-targets -- -D warnings`: final pass. Initial failure was solely the new test decoding helper; equivalent fixed-width iteration replaces chunks_exact after its explicit remainder assertion. No runtime implementation change.
- `rustfmt --check --edition 2024 compiler/src/lsp/output.rs compiler/src/lsp/uri.rs compiler/tests/lsp_typed_output.rs`:pass. Whole-tree cargo fmt fails exactly83 existing hunks versus83 baseline,0 added/removed (normalized complete hunk content comparison). No broad formatting change.
- `git diff --check -- compiler`:pass.

The independent [review](../review.md) tested the production source and pre-polish test. Final test hash/results here distinguish the equivalent polish; all reviewed production file hashes remain identical. Native tests and actual editor pass separately from compiler-only Linux package-profile limitations. No universal host/performance claim.
