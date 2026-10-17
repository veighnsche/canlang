# OUT-R04 comment-preserving unreachable removal

Status: implemented, focused checks passed, awaiting independent review. No merge,
acceptance-ledger update, or file-tree checkpoint advancement occurred.

## Verified context and implementation

The audit's OUT-R04 gate distinguishes runtime-safe removal from preservation of
author prose. `compiler/src/lint/rules.rs` previously replaced an unreachable
statement's complete CST span with an empty string. Leading explanatory comments
are covered by that span, so the fix erased them too.

The replacement now retains every `SyntaxKind::Comment` physical line in the
removed subtree, with its original indentation, prose, order, and preceding LF
or CRLF. The edit keeps the original statement span, source hash, diagnostic,
and atomic stale/invalid/overlap checks. Comments outside that span and surviving
declarations are untouched. Whitespace-only gaps within removed code need not
survive; this preserves authored comment lines, not absolute byte offsets.

Descriptions are distinct metadata: effects with `#` descriptions already
produce E1126. Removal additionally refuses a CST statement preceded by an
attached Description sibling or containing nested Description nodes. It does
not delete metadata or transfer it to another declaration. Existing syntax
error and semicolon refusals remain. Inline/trailing `##` on a code line is
malformed in the current grammar; standalone comments trailing a suite survive.

## Alternatives evaluated against preservation and source scope

* Keep comments in source order and indentation while removing dead executable
  text: preserves authored prose, leaves unrelated source unchanged, and needs
  no new semantic comment attachment model. Selected for this fix.
* Remove comments deliberately with their statement: keeps a smaller result,
  but loses author context despite identical runtime behavior. Rejected because
  author preservation is the task's explicit requirement.
* Reassociate comments with a surviving statement/declaration: can offer a
  semantic destination but requires interpreting author intent; choosing a new
  owner risks misleading readers and changing sibling metadata. Not selected.

No JEV consultation was needed for this conservative source-preservation change:
the author requirements resolve prose preservation, and the fix deliberately
does not introduce a language-level comment attachment policy.

## Focused verification and freeze

Final command: `cargo test --manifest-path compiler/Cargo.toml --test lint --test authoring`
passed: 32 lint tests and 30 authoring tests, zero failures.
`git diff --check -- compiler/src/lint/rules.rs compiler/tests/lint.rs` passed.

Three new tests cover independent literal expected sources and exact edit spans;
multiple comments; UTF-8 prose; leading, interstatement, nested, and suite-trailing
comments; a string containing `##`; valid metadata on surviving siblings; LF and
CRLF; successful recheck/re-lint; no further fixes at fixed point; E1126
description refusal; malformed inline comments; semicolon refusal; and stale,
invalid-span, and overlap refusal through the existing public fix consumer.

The existing `fix_refuses_stale_and_invalid` test also verifies a span splitting
a UTF-8 character. A strengthened metadata assertion initially failed because
the test assumed effect descriptions were valid; after verifying E1126, the
fixture expectation was corrected and the final focused command passed.

Source/test freeze at HEAD `17dd3bbdc7d3aec6fcb1b1cd7ea7c831d4a2fe0c` (working changes):

| File | SHA-256 |
| --- | --- |
| `compiler/src/lint/rules.rs` | `13bdc3be2861417f84cca820bdbfe844beaac95541e3b63397af2ed4f54a50da` |
| `compiler/tests/lint.rs` | `3afc4728750746ff37817011140d438b368f303253af673c40043a79bc7c879e` |

Only those source/test files and this evidence packet are owned by this task.
Concurrent analysis/codegen/editor/package changes were not modified.

## Proposed decision for shared DECISIONS.md after review

Proposed: unreachable-statement lint removal preserves every explanatory `##`
comment line inside the removed CST span in authored order and indentation.
Runtime deadness does not authorize deletion of author prose. Do not infer a new
comment owner. Refuse removal involving `#` metadata rather than deleting or
reassigning it. Keep source-hash and atomic edit validation unchanged.

Remaining qualification: comments can describe code that is now gone; authors
may choose to revise or delete that prose themselves. Absolute line numbers and
blank lines inside removed statements are not preserved. Nested overlapping
fixes retain the existing atomic overlap refusal; this packet does not add a
batch-selection policy. General formatter/comment attachment design and native
editor application remain outside this focused repair. Independent review is
still required before acceptance.
