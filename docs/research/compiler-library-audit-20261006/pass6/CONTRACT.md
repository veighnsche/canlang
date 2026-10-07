# Pass 6 released input contract

Scope: the shared JSON input grammar and catalog/LSP consumer qualification. Root is the sole integrator; Sol high owns `compiler/src/json.rs`, Sol low owns routine caller/producer witnesses, and Sol medium provides independent review. No packages edits, package rebuilds, dependency/features changes, protocol redesign or merge is authorized by this packet.

## Finite packets and ownership

1. Baseline witnesses: `compiler/tests/json_input_contract.rs`, `catalog_input_contract.rs` and Unix/Node24 `catalog_producer_runtime.rs`. Independent expected admission/tree/code/anchor outcomes qualify the old implementation first. Existing Pass2 real-process admission/lifecycle witnesses remain acceptance requirements.
2. Shared input engine: `compiler/src/json.rs` only, with private parse-time budget/error tests. Retain public Json views, ordering, first lookup, integer view, output rendering and quote ownership. Replace grammar through existing pinned Serde; no new grammar clone or whole-subtree RawValue/ignored validation.
3. Real LSP witnesses: narrowly assigned process admission tests for malformed grammar/Unicode, raw IDs and depth edges, with actual initialization/recovery/lifecycle. Catalog witnesses run against the released engine, including the unchanged owning producer and actual exported runtime.
4. Integration: root-owned error comparison, native/Linux profile and parse/end-to-end cost evidence, review corrections and receipt. Reject an adapter that cannot meet outcomes with proportionate complexity; incomplete retirement must be declared explicitly.

## Compatibility matrix

| Boundary | Frozen acceptance | Classification |
| --- | --- | --- |
| Object storage/lookup | Ordered decoded `(String, Json)` pairs, retain all duplicates; first-match get | Exact representation and semantic lookup |
| Numbers | Every legal JSON number, arbitrary magnitude/exponent, exact authored text including -0/E/+000 | Byte equality for lexemes/render and supported reply IDs; no floating conversion |
| Integer accessor | `as_i64` admits in-range lexical integer syntax only; -0 is zero | Exact semantic acceptance, separate from LSP ID policy |
| LSP identifiers | String or exact mathematically integral signed i32 number with raw spelling; absent differs from invalid explicit null | Existing Pass2 policy, including decimal/exponent spellings and reserved decoded duplicate rejection |
| Strings/keys | Strict decoded Rust strings, Unicode pairs accepted; lone surrogates, raw controls and bad escapes reject | Semantic decoded value; malformed admission exact |
| JSON document | One complete value, JSON whitespace only, strict number/delimiter grammar, reject trailing non-whitespace | Admission exact; no historical malformed acceptance is promised |
| Depth | Root value-entry depth0 through64; empty terminal []/{} at64 valid; reject entry65 during parsing | Exact admission, protection before tree/tail materialization |
| Bytes/framing | Callers decode strict UTF-8; unchanged 64 MiB inclusive frame-body cap checked before allocation | Existing released mapping; framing quirks remain unchanged |
| Catalog members | Unknown fields ignored by projection after full syntax/Unicode/depth validation; decoded duplicate fields first-match; duplicate entry IDs reject | Exact owner semantics; E6003/E6004 and original primary span |
| LSP duplicates | Reserved top-level jsonrpc/id/method/params duplicates reject; unknown and nested policies unchanged | Existing owner semantics, legal unique ID correlation retained |
| Parser errors | In-range zero-based UTF-8 byte location; `invalid JSON at byte N: reason` display envelope | Native grammar wording/location intentionally classified, not old byte/text equality |
| Error callers | Catalog retains E6003/origin/caller anchor; LSP retains fixed -32700/null `invalid JSON` | Caller-visible code/span/protocol equality |
| ParseError reason field | Owned native reason, accepted with the classified error matrix and first-failure byte witnesses | Public Rust field type change (`&'static str` -> String); no current production field readers/constructors, unpublished crate; outside source users unqualified |
| Output representations | Existing typed Serde families and compatibility Json renderer unchanged | Pass5 acceptance retained; manual structural rendering is not an input parser |

## Pins and independent evidence

Baseline compiler commit: 8581390afab9f3968230c5fbb070c41a1e749819. Rust 1.99.0, edition2024. serde=1.0.229 (std/derive), serde_json=1.0.151 (std/raw_value), defaults disabled; no additional feature is released here. Native full package profile: Node v24.21.0. The producer logs pin authored catalog, unchanged script, built catalog/runtime and existing/fresh 22,290-byte catalog. Isolated actual producer output hash: `cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62`.

The first 9 baseline tests passed, followed by the actual producer/runtime witness (1, no skip). Source/built CATALOG deep equality covers59 entries; unchanged emitter verifies implemented runtime exports and emits59 entries/15 features. Actual Unicode trim, catalog loader and fresh CLI check passed. Tests use prescribed expected values/admission/codes; baseline snapshots record legacy errors only for classification, not as the sole correctness oracle.

Candidate scratch evidence is preserved separately and does not constitute production acceptance. Unix producer qualification claims only its executed profile; absent Node24/built packages produce explicit skips. Native and local pinned Linux compiler profiles and final runtime hashes will be recorded at integration.
