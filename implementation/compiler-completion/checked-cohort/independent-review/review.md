# S9-Q06 / ARCH-01 independent high review

Accepted for the selected finite input-owner contract, with the additional coherent caller migration in `compiler/tests/b4_examples.rs`. No remaining implementation blocker was found. This review does not certify root's later integrated full-suite or strict Clippy gates.

## Input freeze and inspected source

Read `selected-contract.md` and `implementation-receipt.md`, then independently read the seven frozen source/test files before drawing conclusions. All seven hashes match `implementation-pins.json` at the start and end of this review. `start-pins.json` records the isolated snapshot's build inputs, and `end-pins.json` records the final seven hashes and inspected support files. The snapshot is `/private/tmp/can-checked-cohort-independent-review`; all compilation used `/private/tmp/can-checked-cohort-independent-target`.

The additional caller migration is pinned separately: `compiler/tests/b4_examples.rs` SHA-256 `ba7ff3a3db07480dfbbb89bf95e234b43877788386e525cd838a26c333cec79a`. It was the only inspected support file that changed between snapshot and final review. The retained 21 test bodies were run from the original isolated snapshot, and did not include b4_examples. The repaired b4_examples source was subsequently inspected; root's separately executed 25/25 result is preserved as `root-b4-examples-caller-repair.log` and identified as root evidence, not an independently executed review command.

## Implementation findings

- SourceDb's source vector and path index remain private and append-only. Public `get`/`iter` return immutable references; copying and editing a public Source value does not change the stored source. Each new/default SourceDb owns a fresh private `Arc<()>`; whole-owner moves/swaps and appends preserve it. The Arc owns a real refcount allocation despite its unit payload. CheckedProgram retains that allocation, so dropping/replacing the original owner cannot free its identity for a later owner to reuse.
- Catalog's fields are private; all public queries return immutable references, slices, or copied enum values. Independently loading creates a new allocation; derived Clone preserves the token while cloning immutable data. No public mutator, deserializer, identity handle, constructor with chosen identity, or unchecked CheckedProgram constructor was found. Private visibility was also tested through an external crate.
- CheckedCohort retains only source/catalog identity handles, the original DB length, and an owned copy of the exact selected ID sequence. Validation compares Arc owners, then the original selection bound, then catalog association. A public SourceId that did not exist at check time cannot become admitted by later appends. Ordered nonzero IDs remain their original IDs; duplicate IDs remain in the recorded selection. Existing resolver E2002 duplicate-module handling remains responsible for duplicate declarations.
- Public emit preserves E6005 precedence for incomplete production input. Both emit and public ir::build independently refuse E6011 before constructing Cx. Test-only bypasses only completeness. Refusal artifacts contain no executable modules/tests or semantic registries; refusal IR leaves every executable/fact collection empty. Metadata inventory and catalog-version metadata are not authenticated semantic output.
- Cx reparses only `checked_files`; no remaining `db.iter()` parse path exists in IR lowering. Appended and unselected malformed files cannot add lowered semantics. Artifact and source-map adapters still inventory the full coherent DB, including original SourceId association and duplicated display paths, as explicitly declared metadata behavior.
- Public program tables/catalog_version and DiagnosticResult remain caller-editable. A positive external control edits facts and observes that provenance remains valid. This is consistent with the declared caller-responsibility boundary; owner identity does not establish clean analysis, complete diagnostics, semantic truth, or a shipping decision. Raw IR/JS/artifact constructors remain synthetic low-level carriers.

## Caller closure and corrected compatibility claim

The original packet's claim that every shipped repository check/emit caller already retained its owner was false. Its saved inventory omitted the unqualified imported emit call in `b4_examples.rs::emit_test_only`. Root's broader caller regression found `minimal_table_rows_emit_expected_and_error`: `check_src` dropped its DB, then emission rebuilt an independent equivalent DB with `program_db`. E6011 was therefore the intended result under the selected contract, but that fixture required migration to keep one owner. Root repaired the caller by creating/checking/emitting with the same DB and removed the unused reconstruction helper. No production gate was weakened. The source diff is saved as `b4-examples-caller-migration.diff`.

The final closure scan includes imported `emit`, EmitSources, direct `ir::build`, and CheckedProgram construction rather than relying only on qualified call spelling. `complete-lowering-admission-callers.txt` preserves the inventory. Inspected all emitting helper families: production cli::run_compile and CatalogAnalyzer::analyze_owned; codegen's check_example/emit_test_only, all their call sites and t31_program's moved-DB return; b3_i5::entry_js; mcp_p1/mcp_p4::compile_source; both b1_join entries; b4_examples' repaired minimal fixture and already coherent assert_draft_parity. Direct IR callers in b3_migrate, js_binding_runtime, flat_expression_runtime, and codegen retain their owners. No further independent equivalent reconstruction was found in these shipped lowering callers.

Snapshot::analyze privately retains the borrowed DB/catalog with its checked program. docs::extract_reference requires successful analysis of the supplied files; policy_dump is a total projection; lint/fix APIs retain their existing input preconditions and hash-guarded edit carriers. These report/edit projections are not covered by the new lowering admission check. Raw js/artifact/sourcemap adapters accept constructed carriers and make no checked-owner guarantee. No additional source edit is inferred from inspecting them.

The private CheckedProgram field intentionally breaks external struct literals. Only check_program constructs a literal in shipped compiler source/tests. The two other repository literals are historical saved synthetic probes in flat-stack/resumption evidence, not executable production clients; no evidence was rewritten. Owner-substitution compatibility is deliberately excluded and may require future design revision if a real client needs it.

## Executed independent controls

Exact commands, exit codes, stdout, and stderr are saved in the corresponding receipt files. The external caller depends on the isolated compiler snapshot and uses public APIs only.

| Review check | Result | Saved evidence |
| --- | --- | --- |
| New public ownership/invariant controls | 9/9 passed | `public-controls-receipt.json`, `public-controls.stdout/stderr`, `external-caller/tests/public_controls.rs` |
| Public CLI injected analyzer returns an independently rebuilt equivalent program | 1/1 passed: production dispatch emits E6011/exit 10 and no executable artifact | `public-cli-caller-receipt.json`, streams, `external-caller/tests/caller_cli.rs` |
| Separate public privacy negative controls | 8/8 failed compilation for the expected API restriction | `privacy-controls-receipts.json`, `compile-fail/*.rs` and streams |
| Frozen author cohort target | 8/8 passed | `retained-21-receipts.json`, `author-cohort.stdout/stderr` |
| Retained direct migration target | 9/9 passed | `retained-migrations.stdout/stderr` |
| Retained public emitter/import seam, actual Node execution | 1/1 passed | `retained-public-node.stdout/stderr` including OUT-R01 execution marker |
| Retained incomplete, catalog-effects, and requirement gates | 3/3 passed | `retained-incomplete`, `retained-catalog-effects`, `retained-requirements` streams |
| Actual can binary with two coherently checked files in supplied order | Exit 0, both source literals and complete source/map inventories verified | `actual-cli-receipts.json`, `actual-cli-coherent.stdout/stderr`, `cli-fixtures/*` |
| Actual can binary malformed-input refusal | Exit 10, diagnostic envelope with no modules | `actual-cli-analysis-refusal.stdout/stderr` |

New controls cover whole-owner swap/replacement; detached Source-copy mutation; catalog clone after original drop; original file-vector mutation; duplicate selected IDs and existing E2002; ordered nonzero selections; missing nonzero ID followed by multiple appends and u32::MAX; E6005 versus E6011 order; source versus catalog refusal order; malformed unselected/appended inventory-only files; coherent None with unresolved builtin errors; empty selection/empty DB owner distinction; and explicit public-fact edit responsibility. A bounded 32-replacement control supplements the retained-allocation source argument; no raw-address, nonce, unsafe token, or repeated long stress ladder was used.

Eight separate compile-fail callers establish that source/catalog mutation through their public borrowed accessors, DB/catalog identity access, mutable checked-file selection, cohort field/module access, and external CheckedProgram literals are unavailable. Expected failures are E0596, E0624, E0599, E0616, E0603, and the private-field literal error, rather than unrelated missing dependencies.

The first snapshot build omitted compile-time completion-file includes and failed before tests. Those setup failures are saved under `snapshot-setup-incomplete*` and `second-setup-*`; the missing support files were copied and pinned before successful checks. The first independent test run had 8 passes and one wrong duplicate-module expectation. Source inspection of resolver's E2002/first-module policy corrected that review-harness assertion; `initial-duplicate-expectation-*` retains the original failure. Neither failure is relabeled as a passed command.

## Limits and uncertainty

No source, shared documentation, Git, or root integration state was mutated by this reviewer. Only this independent-review evidence directory and temporary build/snapshot directories were written. Root owns the newly justified integrated full-suite run and final strict Clippy gate; no broad suite or repeated 3000-case ladder was run here. The author receipt's earlier failed strict Clippy attempt remains a failed attempt and is not evidence for the later root gate.

Artifacts from new cohort or test-only controls are inspected output, not application runtime proof. The retained Node seam qualifies only its actual public-emitter/import behaviors. The new real CLI controls qualify output/refusal, not execution of generated apps or state-machine/platform workflows. Existing integrated state-machine behavior was not redesigned or weakened by these seven changes; broader integrated functionality remains root's verification responsibility.

The three saved JEV choices all recommend owner tokens with confidence 0.61/0.61/0.31, and the last response nearly ties exact snapshots (0.54 versus 0.45). This is qualified design advice, not correctness evidence or a consensus-confidence claim. Equivalent independently rebuilt owners intentionally require rechecking; this review accepts that declared boundary while retaining its compatibility uncertainty.
