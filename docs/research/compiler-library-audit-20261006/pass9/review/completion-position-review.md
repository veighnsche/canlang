# Independent completion and position/path review

Reviewed 2026-10-07 against raw diffs and accepted completion-CONTRACT.md/position-CONTRACT.md before implementer receipts. No production, Cargo, Git or shared-document edits by this reviewer.

## Initial completion finding

The released three corrections are sound on inspection: lint alone gains fix metadata; completed-token separator scans consume split option values before recognizing a real separator; Zsh shifts words/CURRENT so `_arguments` counts the shell operand relative to the selected subcommand. A real separator returns filename completion early, before option-value/domain completion. A separator consumed by catalog remains data, permitting later flags or a later real terminator.

Two permanent tests passed with engines required:

`CAN_COMPLETION_REQUIRE_ENGINES=1 CARGO_INCREMENTAL=0 cargo test --offline -j1 --manifest-path compiler/Cargo.toml --test completion_contract -- --nocapture`

The emitted scripts come from fresh CARGO_BIN_EXE_can and match source bytes. Bash function probes fix positive/negative outcomes for lint, equals/split format, option values, consumed versus true separator, dash-leading filename, command/help and thin filename. Zsh uses an actual interactive compinit/ZLE engine with a report widget and result sentinel; each result asserts the final edited buffer rather than inferring success from timing or emitted control characters. Its cases cover b/z/f shell expansion, format, filename/value boundaries and thin filename. Temporary working directories isolate filesystem suggestions. Missing engines print explicit skips; CAN_COMPLETION_REQUIRE_ENGINES turns missing engines into failures. Fish is checked for embedded identity and lint-only declaration; its engine is not executed.

One uncovered accepted-contract gap was reported promptly to root: Bash completed `can run --format=j` to `--format=json`, and likewise for test/build/deploy/activate. The global equals-format and previous-option logic preceded thin dispatch. This existed before the initial diff, but contradicted the accepted file-only passthrough obligation and could not be hidden by a `run --f` positive filename test.

Follow-up raw diff independently reviewed: root moved thin file-only dispatch ahead of every compiler scan/domain and removed the redundant late branch. Both permanent Bash and actual Zsh fixtures now loop over all five thin commands with equals-format, split option-shaped format/locale/catalog tokens and dash-leading filenames. The reviewer reran the exact five equals-format controls against current source; all now produce no compiler suggestion. Root reports the expanded engine-required two-test run passed; the reviewer did not repeat that rebuild while root began the full suite. Accept the corrected completion packet; the initial finding is resolved. No reviewer production edits were made.

Bash tests execute the real shipped function with explicit COMP_WORDS; they do not establish every interactive Readline word-break configuration. Zsh tests do exercise interactive tokenization. No cross-platform shell engine behavior is inferred.

## Position/path result

Accept P09-1/P09-2. The inverse LSP edit checks for actual LF before stripping one preceding CR, matching unchanged Source.LineIndex::to_lsp. Bare EOF/internal CR therefore counts as one scalar, while CRLF excludes only its terminal CR. Line existence, trailing-LF empty line, EOF, inside-surrogate backoff and line-end clamping retain their prior mechanisms. Fixed tests cover these outcomes, plus addressable scalar roundtrips including multibyte and supplementary Unicode, CRLF and repeated CR. Skipping the LF byte of CRLF is necessary because it shares the CR boundary's LSP position; it is not masking an addressable failure.

The lexical edit refuses to pop a retained ParentDir while still canceling an ordinary component. Unix absolute-root parents remain literal; this deliberately preserves the released policy rather than adopting root clamping. Private fixed tests cover consecutive leading parents, ordinary cancellation and empty/dot identities. Public missing-relative-root tests force lexical fallback and verify truthful parent retention without claiming normal absolute-root CLI reachability. No new canonicalization, missing-suffix symlink, nonUTF8 or dependency policy is added.

Focused existing-target checks, all with CARGO_INCREMENTAL=0, offline and one job:

| Cargo selection | Passed tests |
| --- | --- |
| --test ide offset_at_position | 2: fixed cases and scalar-boundary roundtrips |
| --lib lexical_path_tests | 2: relative leading parents and literal parents above Unix root |
| --test docs spellings | 3: relative/absolute identity, redundant spellings, real relative symlink target |
| --test docs same_external_file | 1: real and missing external paths agree through relative/absolute spellings |
| --test docs missing_relative_roots | 1: new public leading-parent fallback witnesses |
| --test docs moved_checkout_identity | 1: unchanged portable identity across checkouts |

No failures or skips occurred in these selected tests. Local profile: Darwin arm64, Bash3.2.57, Zsh5.9, Python3.14.7; Fish unavailable. Unix symlink and absolute-root tests executed; Windows prefixes/UNC and other host shells were not qualified. Root owns the full suite and final follow-up completion integration.
