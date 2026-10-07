# Flat runtime scratch diagnosis

Scope: initial read-only investigation followed by parent-authorized correction of the exact scratch helper leaf. No Git, network, full suite, or package builds. Existing test binary was run exactly once for the isolated ladder target, then all six tests ran once through locked/offline Cargo after the correction.

## Evidence

- Full-suite failure at `compiler/tests/flat_expression_runtime.rs:59:41` is `read_to_string(stdout).unwrap()` after `child.try_wait()` has returned an exit status. The missing file is capture output, not a compiler artifact. The panic prevents reporting the child status, label, and output path; the historical child status cannot be recovered from this log.
- `Scratch::new` names paths using process ID plus `SystemTime::now().as_nanos()` and calls `create_dir_all`, which accepts an existing directory. All six concurrent tests use this helper. `Drop` recursively removes that path.
- A host Rust clock probe running six synchronized threads with the identical timestamp expression reported duplicate timestamps in 760/1000 batches. A nanosecond representation does not make the clock unique.
- A collision means two Scratch owners share one path. Their per-command labels need not collide: one owner finishing and dropping its Scratch removes all capture files while another owner has an open child output descriptor. The descriptor remains writable after unlink, but reading by its pathname then raises NotFound. This matches the observed successful file creation followed by failure at line 59.
- The exact ladder target passed (exit 0; 1 passed, 5 filtered; 18.61s) with the existing test executable and real compiler/stdlib/Node bodies. Source/runtime behavior was not weakened or skipped.
- Source searches found no production compiler directory/file removal on this command route; the only cli.rs remove_dir_all is inside its cfg(test) helper. Scratch removal is test-owned.

## Conclusion and limits

Timestamp collision and shared cleanup is a demonstrated infrastructure defect and the strongest explanation for the historical failure. The historical log does not record paths, so it does not prove which pair collided. The isolated passing run establishes that the failure does not reproduce in a single scratch owner; it is not full-suite acceptance.

## Minimal proposed correction

Only `compiler/tests/flat_expression_runtime.rs`: use `tempfile::TempDir` allocated by `tempfile::Builder::new().prefix("can-flat-").tempdir()` for exclusive directory creation and RAII cleanup, change existing `&scratch.0` consumers to `scratch.0.path()`, remove custom Drop and SystemTime/UNIX_EPOCH imports. `tempfile` is already a direct locked dependency. Preserve concurrent execution, the 30-second child deadline/reaping, file-backed capture, every compiler stage, and every external Node/package body.

Then run the focused six-test runtime binary concurrently using Cargo with locked/offline inputs. No wider validation is claimed here. Improving path/status diagnostics is optional; exclusive allocation alone resolves the lifecycle defect.

## Implemented correction and verification

The parent released the exact `compiler/tests/flat_expression_runtime.rs` helper source lease. The correction above is implemented, with only scratch ownership, obsolete imports/Drop removal, and path projections changed. `source-before.rs` was verified against its initial SHA pin before saving `source.diff` and `source-after.rs`.

Command: `cargo test --manifest-path compiler/Cargo.toml --locked --offline --test flat_expression_runtime -- --nocapture`.

Exit 0; 6 passed, 0 failed, 0 ignored, 0 filtered; runtime 16.79s. All compiler stages, existing subprocess labels/deadline/reaping, artifacts and actual Node/stdlib bodies remain intact. No SKIP output occurred. This is focused runtime acceptance only; wider suite and Clippy are left to the parent integration run.
