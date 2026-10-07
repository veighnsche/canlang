# Released P09 position/path repair receipt

Applied only P09-1 and P09-2 from `../position-CONTRACT.md` (release b7051b9), after reading AGENTS.md and the medium assessment, extracted fixed proposal, fixed results and supplementary lexical vectors.

- `compiler/src/ide/queries.rs`: strip a trailing CR only when the line end points to LF. Bare EOF/internal CR remains an ordinary scalar.
- `compiler/src/docs.rs`: a ParentDir never cancels a previously retained ParentDir. Ordinary cancellation, empty-dot output and literal parents above an absolute root remain unchanged.
- `compiler/tests/ide.rs`: independently fixed EOF/internal CR, CRLF, UTF16/nonBMP surrogate interior, overlong columns, trailing LF, empty input and missing-line expectations; roundtrips against the unchanged source LineIndex at addressable scalar boundaries (excluding the LF of CRLF, whose position aliases the preceding CR).
- Private docs tests: 10 fixed relative lexical cases and 3 Unix absolute-root cases. Public docs test: two missing-relative-root parent-preservation witnesses with unique missing directory names.

## Verification

All Cargo invocations used `CARGO_INCREMENTAL=0`, `--jobs 1`, the existing `compiler/target` and no dependency changes.

- `cargo test --manifest-path compiler/Cargo.toml --jobs 1 --test ide offset_at_position`: 2 passed.
- `cargo test --manifest-path compiler/Cargo.toml --jobs 1 --lib lexical_normalize`: 2 passed (13 fixed lexical assertions).
- Seven individually filtered docs tests passed; commands and raw outputs are saved in `docs-test-results.txt`. They cover the new missing-relative-root case, relative/absolute identity, all spellings, real/missing external paths, existing symlinks, external stability and moved-checkout spellings.
- `git diff --check` on the four owned source/test files passed. rustfmt applied only to those files.

No source.rs, dependency, whole-text index, Git, shared documentation or unrelated identity policy edits. Broader relative-root external:absolute wording and missing-suffix symlink behavior remain separate. No unresolved issue arose; root owns independent review and integration. No merge occurred in this work.
