# OR-05 bounded JSON/framing outcome qualification

**Accept the original finite task at its declared retained-current-oracle scope.** The original `docs/research/compiler-library-audit-20261006/resumption/audit-costs-and-oracles.md` row 68 chooses “Retain current tests; defer generic framework.” It asks for independent bounded grammar/Unicode/lexeme/depth and malformed-frame outcomes, and additions only for distinct missing outcomes. This review found no distinct uncaught legal outcome or concrete production defect requiring a new test or owning implementation writer. It does not convert that row into universal JSON/transport certification.

## Retained direct checks

The original native run at `83d40be0` recorded JSON contract 6/0, catalog input contract 6/0, real stdio admission 32/0, and framing reader 11/0. Their raw suite sections remain in this packet. The owning checks are `compiler/tests/json_input_contract.rs`, `catalog_input_contract.rs`, `lsp_admission.rs`, and `lsp_frame_reader.rs`; the full raw run remains in `../integration-after-bindings/after-action-invocation/native-run/full-suite.log`.

Those checks exercise authored JSON outcomes, public catalog loading, real stdio lifecycle, and reader boundaries. The separate direct JSON and framing controls remain in `../json-reader/` and `../frame-admission/`. This is historical bounded coverage; it does not claim that later source edits were executed by that run.

## Qualified bounded state classes

| Class | Independent expectation and owning retained witnesses |
| --- | --- |
| JSON values, order and duplicates | `json_input_contract.rs` explicitly constructs ordered `Json` trees, including decoded duplicate keys and ordinary private marker objects; `get` selects first. Catalog loader/CLI preserve first decoded members, while reserved LSP envelope duplicates reject before dispatch. No blanket-serde last-member oracle substitutes for the contract. |
| Lexical number spelling | `json.rs::numeric_source_spans_cover_all_seed_origins_and_eof` crosses root/array/object origins with whitespace and EOF for signed zero, scale, upper/lower exponents, huge magnitudes and exponent spellings. Contract and real LSP admission freeze raw lexemes and distinguish lexical `as_i64` from legal integral RPC IDs. |
| Strict complete grammar | Independent authored malformed number, trailing input, comma and whitespace fixtures reject, including otherwise ignored catalog/LSP fields. Valid mixed values have manually built expected trees. Grammar is not inferred from round trips alone. |
| Unicode and strict strings | Ordinary Unicode and surrogate pairs decode to explicit expected strings. Lone, reversed or incorrectly paired surrogates, bad escapes and raw controls reject, including unknown-field keys and values. Real stdio tests cover six malformed UTF-8 byte families without lossy decoding and preserve a valid Unicode ID. Catalog invalid bytes retain diagnostic/source anchoring. |
| Error anchors and precedence | JSON inline tests assert literal UTF-8 byte positions, native reasons and EOF positions across root/array/object/key failures and container cleanup. The reader stops at byte 65 rather than scanning a 20,001-byte deep tail. Narrow independent RawValue controls demonstrate strict-string/depth failure precedence against later syntax; RawValue acceptance alone is not the oracle. |
| Value-entry depth | Direct public contract freezes 64 and terminal scalar/empty-array/empty-object outcomes under array/object wrappers at 63/64/65. Real catalog and LSP tests freeze their envelope-adjusted depth64 acceptance/depth65 rejection, including unknown values. |
| Partial framed I/O and exact boundaries | Real public `read_message`/`write_message` tests use finite independently authored wires and partial readers/writers. They check Unicode byte lengths, legal extension/LF headers, pipelined bodies, empty complete body and clean EOF separately from torn header/body EOF. |
| Header and body refusal | Header separator participates in 65,536-byte budget; exact boundary admits, excess/unfinished boundary refuses without consuming excess. Equal parsed Content-Length duplicates admit; either conflicting order, malformed or 67,108,865 declaration refuses. 67,108,864 declaration admits acquisition without premature payload allocation. Arrived prefixes and 65,537 complete bodies demonstrate bounded incremental storage/consumption. |
| Transport errors and recovery | Interrupted acquisition retries; injected non-EOF I/O errors immediately propagate; scoped allocation refusal returns I/O errors. Complete malformed UTF-8/JSON consumes one frame, returns one null-ID parse error and permits successful initialization/shutdown/exit. Framing refusal closes held-open stdio with exit1 before dispatching following bytes, including pre-initialize and post-shutdown. Clean/torn EOF follows retained lifecycle disposition. |

The phrase “malformed-frame recovery” is qualified by the actual supported distinction: complete invalid body recovery versus refused uncertain framing closure. Neither source nor this acceptance promises resynchronization after invalid headers.

## Limits and reopening

This is bounded independently expected outcome coverage, not exhaustive grammar enumeration, all arbitrary read interleavings or every possible mixed-error precedence. No complete 64 MiB body was materialized; the cap declaration, no-payload/prefix and smaller complete-body outcomes are separate witnesses. Reader-owned buffers/RSS, slow-peer deadlines, whole-session/JSON memory budgets, unusual peers, live editor launch, additional OS distributions and dependency-upgrade execution remain outside OR-05's finite retention acceptance.

Exact serde_json 1.0.151 `std,raw_value` remains the dependency contract. An upgrade must requalify cursor/lookahead/error-origin and real consumer outcomes; retained evidence does not automatically qualify another version. Add a focused permanent regression only when a concrete missing outcome or valid producer witness identifies a gap. Nothing here authorizes broad framework construction, serialization redesign or production deletion.
