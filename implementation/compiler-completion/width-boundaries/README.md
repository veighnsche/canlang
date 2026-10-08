# FAIL-R06: source-map name width

The original finite duties are [admission.json](../../../docs/research/compiler-library-audit-20261006/responsibility-map/failure-evidence/admission.json) AR-09/11/17 and the `offset-u32`, `semantic-ids-u32`, `cycle-width`, `icu-wide`, `diagnostic-joining`, and `source-map-growth` entries in [algorithms.json](../../../docs/research/compiler-library-audit-20261006/responsibility-map/failure-evidence/algorithms.json). They are separate responsibilities, not a shared size policy.

`compiler/src/codegen/sourcemap.rs::build` now uses the existing library's returned interned name ID to append new names in first-appearance order. This removes its redundant linear `names.contains` scan for each emitted line. The pinned sourcemap 9.3.2 `SourceMapBuilder::add_name` already owns hash-based lookup and assigns new IDs from its append-only name table. No additional name index or dependency is introduced.

The product regression builds 512 generated rows using 256 distinct names, including the empty name, followed by their reverse-order reuse. It verifies every decoded name/source/line/byte-column coordinate and serialized names, exact Unicode/CRLF source content, and mappings. Existing small map, missing-source, duplicate-path and numeric envelope controls remain unchanged.

Validation: `CARGO_BUILD_JOBS=2 cargo test --manifest-path compiler/Cargo.toml --locked --offline --lib codegen::sourcemap::tests` passed all six checks, including the new wide-name regression.

## Remaining original obligations

- SourceDb source counts, whole-source byte admission, standalone lexer/LineIndex endpoints and semantic IDs still contain unchecked usize-to-u32 conversion. The previously accepted fragment E1008 endpoint admission remains reusable at its narrower API scope; no giant allocation or whole-source guarantee follows from it.
- Catalog loading alone does not qualify an actually used nested signature. `analysis/types.rs::match_shape` and `overload_specificity_count` still recurse through signature shapes; original finite matching controls remain required.
- `analysis/types.rs::field_type_guarded` checks cycles but calls `decl_type` recursively for acyclic reuse. Original finite valid chain controls remain required.
- Graph traversal, ICU branch/slot width and diagnostic multiplicity/output width retain their original finite qualification duties. Existing semantic outcomes should be reused at their declared scope rather than repeated as resource benchmarks.
- Generated/source map numeric widths and per-module repeated source contents/output growth remain distinct from the corrected name scan. No supported extreme count, memory bound, timing threshold or public forged-carrier guarantee is established here.

Next steps are separate finite authored-source controls for actual catalog matching and field reuse in their owning analysis paths. Numeric refusal or resource/support policy requires a separately selected contract; this change adds no cap or suppression.
