# C05P-fixes: released fixes

Defining writer: compiler/src/lint/driver.rs and cli.rs. Shared json.rs/Cargo/CLI integration has one root writer; no packages edits.

## Contract

Typed fix/rejection DTOs preserve ordered fields, all variants, source hashes/spans, caller list order, empty replacements and controls. CLI lint --fix extends DiagnosticResult with a typed flattened envelope and final fixes field; no byte-string splicing remains. Without --fix, fixes is absent; with --fix an empty list remains present. Collection/application/stale/overlap rules and one CLI newline remain.

## Qualification

Sol medium writer/review; root CLI integration. Four fixed fixtures and the new hermetic empty-fix real binary witness pass. Existing b3_s4 four tests pass, including actual deterministic nonempty fix JSON and real LSP stale edit/codeAction lifecycle; 29 lint tests passed in focused writer qualification.

Independent review: ../family-review.md and integrated final-review.md; full host/source/runtime pins, final checks and representative dependency footprint are integrated in the Pass5 receipt. Typed fixed expectations are outcome witnesses; neither old encoder nor Serde is the sole oracle. Source-map codecs and the ordered input-model renderer remain separately owned C08/C06/C07 packets.
