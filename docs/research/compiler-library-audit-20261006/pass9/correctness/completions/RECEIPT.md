# C09C completion repair receipt

Implemented the released completion contract (b7051b9). The only compiler source changes are the three embedded completion scripts, plus the new permanent integration test and its isolated Python Zsh fixture.

- Bash and Zsh declare `--fix` only in lint's option branch. Fish adds the existing-style lint-only declaration.
- Bash and Zsh scan completed tokens for a true `--`, skipping tokens consumed by split format/catalog/out/locale flags. After a real separator they complete files and bypass compiler options and option-value domains.
- Zsh shifts `words` and `CURRENT` to the selected subcommand before `_arguments`; its shell operand now uses the proper first-operand index.
- Emitted scripts retain exact source embedding. Existing value, locale, help and thin file-completion paths pass the focused regression checks.

## Verification

Host profile: macOS arm64, GNU Bash 3.2.57, Zsh 5.9, Python 3.14. Fish is absent; only its declaration and exact embedding were checked, with no Fish runtime or terminator repair claim.

Passed:

```
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CAN_COMPLETION_REQUIRE_ENGINES=1 cargo test --manifest-path compiler/Cargo.toml --test completion_contract -- --nocapture
```

Two permanent tests passed (8.52s engine test run). They obtain scripts from fresh `CARGO_BIN_EXE_can`. Bash executes the actual registered function; Zsh uses actual `compinit`, ZLE and tab completion in a PTY with sentinel synchronization and a buffer-report widget. There are no `_arguments` stubs. Positive controls include all three shell names, lint `--fi`/`--fix`, split/equal format values, catalog/out files, locale, help and thin commands. Negative controls include nonlint `--fix`, suppressed equal-format expansion after a separator, filenames beginning `--f`, and a `--` consumed as catalog value both with and without a later real separator.

`bash -n compiler/can-completions.bash` and `zsh -n compiler/can-completions.zsh` passed. The new Rust test file was rustfmt-formatted. Existing compiler/target was used with one job and incremental disabled. No dependencies, additional target directories, full-suite run or Git mutations were introduced.

Portable convention: missing Bash/Zsh/Python engines print an explicit SKIP; qualification runs set `CAN_COMPLETION_REQUIRE_ENGINES=1` to fail on missing engines. Fish execution is intentionally outside this host-qualified contract.

An initial test fixture `--fixture.can` collided with the intended `--fix` prefix. It was replaced by `--f-file.can`; final checks retain both real file completion and lint-only option evidence.

## Root review correction and final engine replay

Independent review found an existing uncovered thin-command gap: Bash's generic format-value handling ran before thin dispatch and offered compiler values for `run --format=j`. Root moved all five thin commands' file-only dispatch ahead of every compiler option/value rule and removed the later duplicate branch. Permanent Bash and actual Zsh cases now exercise all five commands with equal/split option-shaped tokens, catalog/locale-looking tail arguments and flag-like filenames. No platform flag domain is interpreted.

The fresh offline locked qualification command with required engines passes both tests; the final actual-engine run is20.50s. Zsh already preserves these thin cases and needs no additional production change. Fish remains declaration/embedding only. This narrow root correction does not change the CLI parser or platform passthrough.
