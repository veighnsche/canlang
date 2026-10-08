# Independent native-run accounting

The captured command exited 0 on source `83d40be0` (HEAD unchanged across the run). The raw log SHA-256 is `f005c4bdd9a0d6236e32dd40fc454666c668cf7fa551664d8c91ba4afb1c2338`, matching `completion.json`. Anchored parsing found 69 Cargo result summaries: 67 nonempty and 2 empty. They report 1162 passed, 0 failed, 0 ignored, 0 measured, and 0 filtered out across 68 `Running` lines. There are no test-result failures.

At run start and completion, the recorded input manifests contain 127 compiler inputs, 1,770 package producer files, and 5 external `.can` fixtures. Each before/after manifest is identical; current checks against each captured path and hash report no missing files or hash mismatches. The completion record also reports no changes in all three scopes. Current package worktree changes include 12 source/status entries, but none of the 1,770 captured producer files currently has a hash mismatch. These current package edits occurred outside the recorded producer-output scope and after the completed run, so the suite result does not cover those edits.

The log has one body refusal: `SKIP mode 4750: this host did not retain the requested fixture bits` (line 1083). The separate native qualification receipt reports exit 0 for the exact mode-retention test, with the body not skipped and unchanged source hashes. This qualifies that one body separately; it adds no count to the 1,162 full-suite passes.

The stable root checks report exit 0 for strict all-target Clippy and the owned Rust-format command over five listed files. The recorded scope explicitly says the initial global format attempt flagged two unchanged historical files; this is not a whole-workspace formatting pass.

This accounting establishes the captured finite test run and its input scope only; it does not establish completion of the broader compiler goal.
