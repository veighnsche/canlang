# Checked cohort implementation receipt

Status: implemented in the seven leased files, frozen for independent high review. Root owns Git, shared decisions/navigation, and final integration. No commits, report/lint/type/JS/artifact/package edits were made by this worker. `implementation-pins.json` is the review freeze for the seven files; it was verified unchanged after focused checks. `selected-contract.md` retains the earlier proposal/caller/JEV qualification, and the historical probe remains explicitly pinned to compiler 530a0b7e rather than the later merged feature checkpoint.

## Resulting behavior

`SourceDb::Default`/`new` each retain a fresh private Arc allocation identity; appends/moves preserve it. The immutable loaded Catalog owns an independent identity, and derived Clone preserves it. CheckedProgram retains only handles, original DB allocation count, and exact selected file order. No source/catalog content is copied for provenance, no hash/version shortcut is accepted, and there is no global authority registry or cache.

Both emit and public ir::build refuse mismatched source/catalog owners with E6011 and no executable output before parsing/lowering. Originally nonexistent selected IDs stay invalid even if append later allocates them. Test-only acknowledges only incomplete analysis, never provenance mismatch. Incomplete production still returns the existing E6005 before considering lowering. Cx parses only recorded selected files; artifact and map inventory still include the entire supplied coherent DB, including appended and unselected sources.

Original-owner checking/emission, moved owners, and a Catalog clone after dropping the moved original all remain supported. Catalog removal (Some-to-None), insertion (None-to-Some), independent identical reload, and changed-content/same-version reload refuse. Rechecking the foreign/new owner restores supported behavior. Public tables/DiagnosticResult remain editable: caller completeness/analysis-load error merging/shipping responsibilities are preserved and no authenticated checker-truth claim is added.

Existing public signatures are retained; `checked_files` is a new immutable accessor. A private CheckedProgram association prevents external struct literals. No shipped repository caller was found constructing CheckedProgram by literal; the two historical saved probe recipes remain historical and were not reconstructed or counted as production closure.

## Executed validation

| Check | Result | Saved evidence / scope |
| --- | --- | --- |
| New public checked_cohort integration target | 8 passed | `current-cohort-tests.stdout/stderr`, `current-cohort-tests-exit.json`; real owned analyzer, exact foreign IDs/spans/equal bytes/hash refusal, swap/recheck, moves/clone/drop/appends/full inventory, changed catalog effects + requirement version under recheck, completeness/test-only, ordered nonzero subsets, invalid original ID then append, catalog absence transitions |
| Existing direct migration target | 9 passed | `current-direct-migrations.stdout/stderr`; direct IR and artifact caller coverage |
| Existing public emitter seam | 1 passed | `current-direct-public-emitter.stdout/stderr`; actual Node execution of retained public direct-IR/emitter/import controls |
| Existing codegen incomplete gate | 1 passed | `current-existing-incomplete-gate.stdout/stderr` |
| Existing codegen catalog effects | 1 passed | `current-existing-catalog-effects.stdout/stderr` |
| Existing codegen requirement pins | 1 passed | `current-existing-requirements.stdout/stderr` |
| Actual current production CLI compile | Exit 0; 1 source, 1 module, OLD preserved | `current-cli-control-receipt.json`, raw artifact `current-cli-control.stdout`, stderr; CLI artifact inspected, generated JS not executed by this smoke |
| Scoped formatting | Exit 0 | `current-format-receipt.json` and streams; skip_children prevents touching disjoint owners |
| Focused strict Clippy | Exit 101 due solely to then-existing syntax/layout.rs:296 single_match | `current-cohort-clippy-receipt.json` and streams; no cohort diagnostic was reported; parser owner subsequently corrected it and root explicitly owns final batched strict Clippy, so the failed attempt is not relabeled passed |

`current-focused-checks.json` records exact commands/exit statuses. All cargo commands used offline mode and the separate `/private/tmp/can-checked-cohort-current-target` target directory. No broader suite or repeated caller test run was launched after these passed. Root's final integration checks are separate from historical feature-suite coverage.

## Limits and advice

The eight new cohort tests inspect artifacts/IR; their names do not imply generated application runtime acceptance. The separately existing Node seam qualifies only its retained direct-emitter/import behavior. No complete app workflow, GUI, platform, other-host, parser/resource certification, benchmark, reduction measurement, or new checked-binding publication is claimed.

Full compiler build-input hashes in `current-build-input-pins.json` are a post-check source observation amid disjoint owners. They do not certify a static whole working tree across every command. The leased implementation pins remained unchanged; root owns the later integrated compiler freeze and strict gate after parser/frame changes.

The selected contract deliberately rejects independently constructed equivalent DB/catalog owners. Future requirements for that substitution need a new qualified contract; hash-only fallbacks remain unsupported. JEV's three independently phrased equivalent choices all favor owner tokens, but confidence is 0.61/0.61/0.31 and the last response nearly ties exact snapshots. Saved requests/replies and uncertainty are advice, not evidence of correctness. No further difficult decision or JEV retry arose during implementation.
