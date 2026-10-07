# Production implementation reduction

The user's clarified requirement is accepted: adopting libraries should reduce the production implementation we own. Pass 10 qualifies correctness, compatibility, consumer paths and retirement; those results remain valid for its frozen source. They do not establish sufficient production simplification. Tests, lockfiles, documentation and binary footprint are separate measurements and cannot excuse a flat implementation result.

## Acceptance from this point

- Count the complete production caller/adapter closure for each substitution, excluding tests and evidence. Report gross removed, gross added, net retained code and the original programme aggregate. Keep the comparison at equivalent supported outcomes; record added correctness behavior separately.
- Require a material mechanism-level reduction in owned implementation and control flow. A library plus an adapter as complicated as the predecessor does not meet this exit. Identify the actual declarations, loops, branches and algorithm ownership that disappear; LOC alone is not proof.
- Do not compress formatting, move implementation elsewhere, hide it in macros/generated files, relocate tests or weaken required behavior to produce a smaller count. Library DTOs should be used where they simplify the owning shape, with one narrow projection where their types conflict with an established contract.
- Preserve admitted values, IDs, ordering, versions, omissions, bounds, diagnostics, coordinates and current consumers. New public policy changes remain separate packets; no permission/contract relaxation is selected by this requirement.
- Reconsider an adoption whose compatibility glue consumes the expected savings. Retain/propose a simpler mechanism or classify a justified correctness/standardization benefit explicitly; do not call it a completed production reduction. No blanket rollback or new architecture migration follows.

**Delegation reminder:** Luna low for repeatable counts; Sol low for released routine edits and Sol medium for cross-owner DTO/adaptor work and independent review. Follow the [existing researched allocation](../model-allocation-20261007.md) and justify escalation. Root owns Git and shared decisions; one writer per file. Commit each checked reduction separately.

## Measured baseline

[Corrected metrics](metrics.json) compare original `309644a` to qualified `f889e44f`. Gross physical lines include comments/blanks; only complete top-level `#[cfg(test)]` item spans are excluded. The tracked compiler tree grows 7,713 lines, of which 6,598 are tests/fixtures, 865 Cargo metadata and 69 documentation/scripts/other. Implementation grows **181 lines: 69,119→69,300**. The count is confined to the frozen compiler refs and excludes the other agents' subsequent package/editor/analysis work.

**Correction:** the earlier prefix method incorrectly classified production after an inline test module as tests, especially `migrate_check.rs` and the 159 production lines between `cli.rs` test modules. Its +22 and −29 aggregate claims are invalid. The [reviewed span inventory](line-count-receipt.json) retains exact commits, excluded intervals and totals. A temporary lexical boundary scan supplied this inventory; independent review checked sums and the mixed-module exceptions. This measurement is not executable LOC, branch complexity or proof of simpler ownership. The R01 file-local reduction below remains correct.

Replay the frozen counts from the repository root without maintaining another Rust parser:

```python
import json, subprocess
receipt = json.load(open("docs/research/compiler-library-audit-20261006/production-reduction/line-count-receipt.json"))
for name, entry in receipt["revisions"].items():
    paths = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", entry["commit"], "compiler/src"], text=True).splitlines()
    total = sum(len(subprocess.check_output(["git", "show", entry["commit"] + ":" + path], text=True).splitlines()) for path in paths if path.endswith(".rs"))
    tests = sum(end - start + 1 for spans in entry["reviewed_test_spans"].values() for start, end in spans)
    assert (total, total - tests, tests) == (entry["total_lines"], entry["production_lines"], entry["inline_test_lines"])
    print(name, total - tests, tests)
```

## R01 — Consolidate LSP URI-bearing projections

**Implemented and independently reviewed:** one authored String-URI projection per payload replaces the Standard/Compatible enum branches in `compiler/src/lsp/output.rs`. Every accepted URI already had to preserve its original identity, so reparsing only selected duplicate serializer shapes. The single shapes preserve that contract directly.

Production prefix: **235→184 lines**, **7,064→5,029 bytes**. Gross 94 lines removed/43 added; net **51 removed**. Three URI parse sites, four split serializer enums, duplicate workspace mapping and action dispatch disappear. Existing inline fixtures are byte-identical; no code or tests are relocated.

The library continues to own ranges/positions, diagnostics, text edits and the flattened CodeAction base/kind. Server capabilities, hover/completion, severity and semantic-token legends/constants remain library types. URI-bearing outer location/publication/document/workspace shapes now have one small typed Serde projection. This is deliberately narrower full-DTO adoption, rather than retaining two representations solely to maximize library type coverage.

This supersedes Pass 7's Standard/Exceptional URI implementation rows, with unchanged wire acceptance. The [original contract](../pass7/CONTRACT.md#classified-compatibility-matrix) and prior balanced consultation remain historical evidence; the simpler always-String alternative was already identified there. The user's production-simplicity requirement changes that internal representation choice. This does not reopen URI admission, source conversion or any unresolved external policy, and presents no new difficult policy question requiring consultation.

Preserved outcomes: all authored URI strings, location/range order, current and explicit-null versions, first-seen file grouping/edit order, empty-rename edits, omitted empty-action edits, exact raw ID spelling, shared escaping and complete semantic-token vectors. Backend public DTOs, input/framing/lifecycle and native/display conversion are untouched.

[Independent review](lsp-review.md) accepts the bounded change after inspecting actual caller closure, installed library schema and raw process witnesses. Three unchanged output unit tests pass. The [integration receipt](verification/results.json) passes 62 tests: 32 IDE, 26 admission/lifecycle and four actual typed-output process witnesses. Whole compiler fmt and all-target locked Clippy with warnings denied pass ([root checks](verification/root-checks.json)). Existing target/caches are reused, jobs one, incremental off, offline; no dependency or package change.

Concurrent owner changes in `analysis/resolve.rs`, `tests/analysis.rs` and `tests/lsp_typed_output.rs` were present during verification, pinned and preserved. All 98 source/build/Cargo/completion/editor inputs stay identical during the independent process run. These results qualify that exact current worktree; the new sibling-diagnostic witness is not authored or claimed by this refactor. Only output.rs and this compiler reduction receipt/criterion plus the isolated decision section are staged by root.

Applying only this packet to the frozen programme changes its aggregate implementation delta from **+181 to +130 lines**. It is a checked local reduction, while the aggregate production-reduction objective remains unmet. No new release-size, Linux/Windows, product-parent or clean-build claim is made.

## Remaining bounded assessments

| Boundary | Question before another implementation packet |
| --- | --- |
| JSON input/raw view | Can the pinned reader/error-offset coupling and generic rendering be replaced by a smaller supported library adapter while retaining raw lexemes, duplicates and parsing-time depth protection? Compare complete implementations; changing the contract or replacing it with another scanner does not count. |
| Typed output metadata | Which serializers redeclare information already owned by descriptors/reference models, and can existing declarations serialize directly with smaller projections? Account for live exact scalar/order/layout/omission callers. |
| Remaining compatibility helpers | Is a helper required by an actual public consumer or only by its own tests? Caller presence alone does not establish necessary production ownership. Investigate the real API contract before removal. |

These are assessments, not released rewrites or guessed savings. Prefer the largest demonstrated duplication, release one exact writer and equivalent acceptance at a time, and keep correctness repairs separate from production reduction. Locale/ICU/graph/path policy queues and T37/FP.QUALIFY/FP.INSTALLED-RELEASE retain their original prerequisites. No merge or living-plan checkpoint advancement occurs here.
