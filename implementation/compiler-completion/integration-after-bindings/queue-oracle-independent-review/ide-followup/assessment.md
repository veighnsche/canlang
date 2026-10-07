# IDE queue oracle follow-up

Verdict: `compiler/tests/ide.rs::server_stale_version_suppressed_with_real_backend` has a second stale queue-count oracle. Correct its pre-pump `pending_count()` expectation from 2 to 1; retain its exact one-publication, version-2-present, version-1-absent assertions. This is a test expectation correction for accepted server behavior, with no production source change needed.

I missed `ide.rs` and other test files in my prior `pending_count()` inventory. That inventory in `../assessment.md` was incomplete; this receipt supersedes only its inventory claim, not its `authoring.rs` verdict.

Evidence pins:

- Frozen input: `ide.rs` opens `"app A\n"` at version 1, then sends a full-text version 2 change containing `FIXTURE`, which starts `"app Tasks\nGiven\n"`. The texts are distinct, so `changed == true` in `compiler/src/lsp/server.rs` and `retain_live_sources()` runs after version 2 is queued.
- Accepted behavior: `retain_live_sources()` removes queued entries whose `(uri, version, id)` no longer matches the current document before private source IDs are remapped. This removes version 1 and keeps version 2. `pump()` also checks URI/version/source before publishing. The source-owner header and implementation are unchanged in the current working tree (`git diff -- compiler/src/lsp/server.rs` empty); this is the behavior accepted in `f7566ce3`.
- Frozen failure: `implementation/compiler-completion/integration-after-bindings/after-bdd-ui/full-suite.log` SHA-256 `61282ebe8dc3c4ebf0ac33c9a233c20008ee181c57082191d88d8138bd3e0262` reports the sole `ide.rs` failure at line 874: actual count 1, expected 2; `ide.rs` had 34/35 passing. Because the assertion stops the test, this log alone does not prove later publication assertions pass after correction.
- Complete count-site inventory (`rg pending_count compiler/tests compiler/src`): `authoring.rs` distinct-text queue 1 then drain 0; incremental-only change leaves 1. `ide.rs` distinct-text change currently expects 2 and is stale. `server.rs` invalid notifications leave 1; equal-text version advance leaves 2 because compaction is skipped. `lsp_typed_output.rs` has 2 live documents after close/reopen, then one changed document queues 1, then shutdown drains 0. `session_history.rs` sends two equal-text changes, queues 2, and shutdown drains 0. These counts reflect distinct paths; no other stale count is evident from this inventory.
- Reviewed `ide.rs` SHA-256 before root's edit: `7dc8eb5db8fdff6930a6a68f335b03c297cfbc7470930e78c877bb32cc6c6336`; `git diff -- compiler/tests/ide.rs` was empty at review time.

No compiler source, test, Git, or build files were written, and no tests were rerun in this review. The corrected `ide.rs` test still needs a targeted passing receipt from the implementation owner.
