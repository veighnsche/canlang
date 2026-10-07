# C05A: released artifact

Defining writer: compiler/src/codegen/artifact.rs. Shared json.rs/Cargo/CLI integration has one root writer; no packages edits.

## Contract

Borrowed typed artifact/module/callable/migration DTOs preserve key order, explicit arrays, omitted directives vs present empty directives, source identities, JS text and no serializer newline. Operations/models serialize directly as typed slices, avoiding reparsing/double serialization. SourceMap remains a syntax-qualified compiler-owned raw adapter; coordinates and codecs remain C08 work.

## Qualification

Sol medium writer/review. Two full independent byte fixtures and the actual fresh binary artifact consumer pass. Actual Cloudflare parseArtifactText/loadArtifactFile/assertCompiledIdentity verify source hashes, identities, maps, ordered models/operations/types, integer-string/control/bool defaults and omitted nullable defaults. Existing b1_join/b3_migrate (11 tests) pass. Real decimal default lowering E6008 is an existing limitation; authored scale remains qualified by fixed artifact bytes.

Independent review: ../family-review.md and integrated final-review.md; full host/source/runtime pins, final checks and representative dependency footprint are integrated in the Pass5 receipt. Typed fixed expectations are outcome witnesses; neither old encoder nor Serde is the sole oracle. Source-map codecs and the ordered input-model renderer remain separately owned C08/C06/C07 packets.
