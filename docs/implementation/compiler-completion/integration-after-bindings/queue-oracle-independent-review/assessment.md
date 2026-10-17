# Independent queue oracle review

Verdict: accept the one-assertion correction. No production regression is hidden by it.

- Scope pin: `git diff -- compiler/tests/authoring.rs` changes only the pre-pump `pending_count()` expectation from 3 to 1 and two explanatory comments. The reviewed file SHA-256 is `ce01a4427c8b5f6bad20bff85b809f13e9106cca9f6797f9ca5c164fc21ccf61`, matching `authoring-queue-oracle-correction.json`.
- Behavior pin: three distinct full-text versions (1, 2, 3) are received. In accepted commit `f7566ce3`, each changed text calls `retain_live_sources()`, whose `pending.retain` keeps only entries matching the live document URI, version, and source ID *before* IDs remap. Thus the queue has one current entry before `pump()`; the original full suite failed exactly at old expected 3 versus actual 1.
- Publication pin: the test still requires exactly one `textDocument/publishDiagnostics`, version 3, excludes versions 1 and 2, and requires the queue to drain to zero. `pump()` independently checks current URI/version/source before publishing. The updated count does not weaken those observable assertions.
- Consistency pin: `compiler/src/lsp/server.rs` still expects count 2 for an equal-text version change because the `changed == false` path skips pruning, then publishes only version 2. Its invalid-notification test keeps count 1; `compiler/tests/authoring.rs` incremental-only test also keeps count 1. These distinct paths explain the differing counts.
- Receipt pin: `full-suite.log` records the pre-correction single failure at `tests/authoring.rs:705` (29/30 authoring passed). `authoring-corrected.log` records 30/30 passed after the correction. No redundant full suite was run for this review.

Limit: this review is confined to the queue oracle correction and cited receipts; it does not re-review the server/lint implementation or other pending changes.
