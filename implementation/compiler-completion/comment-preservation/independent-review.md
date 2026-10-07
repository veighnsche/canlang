# Independent OUT-R04 source review

Verdict: scoped PASS for explanatory-comment preservation on valid source, exact source-edit boundaries, metadata refusal, and existing atomic application guards. No blocking defect in the frozen change. One pre-existing malformed-input qualification must stay explicit; this is not blanket malformed-source safety or every lint/editor workflow acceptance.

Reviewed working source hashes (unchanged before and after checks):

- `compiler/src/lint/rules.rs`: `13bdc3be2861417f84cca820bdbfe844beaac95541e3b63397af2ed4f54a50da`
- `compiler/tests/lint.rs`: `3afc4728750746ff37817011140d438b368f303253af673c40043a79bc7c879e`

The packet originally pins HEAD `17dd3bbdc7d3aec6fcb1b1cd7ea7c831d4a2fe0c`; concurrent unrelated work advanced observed HEAD to `faf99bf5ed0f77d29015ffa34da9b86c2e792b6f`. The two frozen file contents still match, so this review is content-pinned, not a claim about the whole moving checkout.

## Source reasoning

`rules.rs:701–735` selects CST Comment nodes, not marker-looking text. The lexer only creates those leaves for physical lines whose body begins with `##`; inline `##` after code is malformed, and quoted `##`/`#` are ordinary string tokens. CST preorder traversal visits leaves in authored order. Each retained slice starts at its preceding LF, or preceding CRLF's CR, and ends at the original comment token end: original indentation, Unicode, trailing spaces and marker bytes survive. The removed span and source hash are unchanged. Retained comments are reinserted without choosing an author-intent owner; unrelated bytes outside the edit remain exact.

`kids` excludes trivia/comments but retains Description siblings, making the previous-significant-sibling check meaningful even when explanatory comments intervene. Nested Description nodes also refuse removal. These metadata guards supplement syntax-error and whole-line/semicolon refusal; they do not treat `#` metadata as explanatory prose. The new fixture's surviving scenario description is valid and remains byte-exact.

`apply_fixes` remains the existing public atomic engine. New tests exercise stale source, invalid end and duplicate overlapping edits; existing tests separately cover UTF-8 boundary rejection. Overlapping nested unreachable fixes remain atomic refusals, not automatically selected batches. No new application engine or formatter behavior is introduced.

## Independent checks

`cargo test --manifest-path compiler/Cargo.toml --test lint --test authoring`: 32 lint and 30 authoring tests passed. `git diff --check -- compiler/src/lint/rules.rs compiler/tests/lint.rs` passed.

Independent retained probe source and output are `independent-probes.rs` and `independent-probes.txt`. Compiled with Rust 2024 against the freshly built compiler rlib, it uses literal expected output sources rather than the implementation's preservation algorithm. Six cases (three source shapes times LF/CRLF) pass exact full-output equality, valid recheck, empty re-lint and no second fix:

- Removed if/else retains parent, both branches and suite-trailing comments, including Unicode and trailing spaces; string marker text is removed with dead code.
- A comment inside a joined record expression remains, despite removal of its surrounding expression.
- Empty `##` markers, trailing prose spaces and intervening whitespace-only gaps obey the declared policy; blank gaps owned by removed code need not survive.

Each case retains a following described scenario and its executable body byte-for-byte. The committed test diff additionally pins exact removal spans and source hashes, multiple successive dead statements, nested control flow and diagnostic/file identity.

## Invalid-fixture history and guard qualification

Preserve the initial invalid-fixture result separately from success credit: the earlier expectation that a `#` description on a dead effect binding was valid was wrong. Such source produces E1126. The independent probe explicitly requires E1126 and no fix; it is a malformed metadata negative control, never a valid-input preservation success. The original failed run is reported in `verification.md`; no original raw log was supplied or invented here.

A tab-indented explanatory comment produces lexer diagnostic E1003, but direct public-library `collect_fixes` still returns one unreachable removal. `driver.rs:473` discards parse diagnostics, and `rules.rs:235` only recognizes CST Error/BadToken descendants. This behavior predates the change and the comment remains preserved, but library callers cannot infer universal malformed-input refusal from these tests. CLI lint separately returns early on analysis errors (`cli.rs:1693`); editor-wide malformed-source application is outside this review. Evidence should say “tested malformed inline comments and description metadata refuse fixes,” not “all malformed inputs refuse fixes.”

No implementation source, shared decision ledger or living-plan file was edited by this review. No merge/acceptance/checkpoint claim is made.
