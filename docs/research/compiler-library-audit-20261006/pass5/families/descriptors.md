# C05M-descriptors: released descriptors

Defining writer: compiler/src/codegen/js.rs. Shared json.rs/Cargo/CLI integration has one root writer; no packages edits.

## Contract

Typed Serialize implementations preserve descriptor tags/keys, source order, omit-vs-present-empty options, array false, exact i128/decimal/duration/money minor string values and authored decimal scale. Object literal members remain ordered including duplicates. Only compiler-owned encoded literal defaults use syntax-qualified RawValue. The released shared quote adapter replaces the final private string loop; expressions/identifiers/evaluation/HTML are separate.

## Qualification

Sol medium writer and review. Six independent byte fixtures pass; existing focused MCP/codegen cases pass. Actual unmodified CLI modules run model defaults/message metadata and generated testkit setup/observe closures for six independently specified decoded control/Unicode cases. Production decimal default lowering currently rejects with existing E6008, so wire-scale fixtures do not claim production decimal execution.

Independent review: ../family-review.md and integrated final-review.md; full host/source/runtime pins, final checks and representative dependency footprint are integrated in the Pass5 receipt. Typed fixed expectations are outcome witnesses; neither old encoder nor Serde is the sole oracle. Source-map codecs and the ordered input-model renderer remain separately owned C08/C06/C07 packets.
