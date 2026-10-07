# C05P-explain: released explain

Defining writer: compiler/src/explain.rs. Shared json.rs/Cargo/CLI integration has one root writer; no packages edits.

## Contract

Borrowed six-field ordered DTOs preserve compact code/title/severity/explanation/example_valid/example_invalid, empty strings and controls, lowercase severity, no serializer newline and one CLI newline. Catalog entries and text rendering are unchanged.

## Qualification

Sol medium writer/review. Three fixed/full CLI fixtures plus three unit tests pass. Known E1001 runs through the fresh actual binary; independent fixed output is the oracle.

Independent review: ../family-review.md and integrated final-review.md; full host/source/runtime pins, final checks and representative dependency footprint are integrated in the Pass5 receipt. Typed fixed expectations are outcome witnesses; neither old encoder nor Serde is the sole oracle. Source-map codecs and the ordered input-model renderer remain separately owned C08/C06/C07 packets.
