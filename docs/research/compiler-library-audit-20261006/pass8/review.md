# Pass 8 independent review

Reviewed 2026-10-07 against pre-Pass-8 commit `6729b85`. Scope: raw production diff, cached sourcemap 9.3.2 APIs/encoder/parser, final consumer regression source, and independently authored adversarial probes. No actionable correctness findings. No coordinate conflict requiring design escalation was demonstrated.

## Production findings

- `compiler/src/codegen/sourcemap.rs:38–48`: registration uses unique private keys, retains the actual returned library IDs, and changes only display paths. Cached `builder.rs::set_source` mutates the source vector without modifying its registration hash map; even authored paths equal to another private registration key cannot merge snapshots. Public sources and contents stay in SourceDb order.
- `compiler/src/codegen/sourcemap.rs:51–77`: generated rows use vector indexes and column zero, source coordinates delegate to byte-based LineIndex, and missing SourceIds become library tombstones. Empty and repeated names keep first-appearance order, including a name first seen on an unmapped row. Mapping name references use returned library IDs.
- `compiler/src/codegen/sourcemap.rs:79–94`: standard mapping encoding is owned by sourcemap's JSON writer. The final optimization removes intermediary source contents. Cached `encoder.rs::serialize_mappings` reads tokens only; `as_raw_sourcemap` handles contents separately. Removing builder contents therefore cannot change mappings, while the public typed map preserves every cloned source text.
- `compiler/src/codegen/sourcemap.rs:104–130` and `compiler/src/codegen/artifact.rs:595–608`: map fields serialize directly through borrowed typed serialization, with stable field order. Artifact module maps are JSON objects, including separate test modules. No rendered fragment or RawValue remains at this boundary. Manual `None` contents retain JSON null and the shared control-byte escaping policy.
- `compiler/src/codegen/sourcemap.rs:155–234`: the compatibility decoder delegates numeric VLQ parsing to the library. Alphabet/encoded-width checks compensate for the cached library's invalid-character acceptance and unchecked signed accumulator, without reconstructing a numeric codec. Delta accumulation is checked. Authored row/segment order, empty rows, and 1/4/5-field forms remain owned by the compatibility view. Source and generated coordinate admission policy is unchanged.
- `compiler/Cargo.toml:33` pins sourcemap `=9.3.2` with default features disabled. Repository searches found only test callers of the public Rust decoder.

## Executed evidence

Independent probes used `rustc` with the root-built existing rlibs and executables under `/tmp`; no Cargo, package installation, Git mutation, or production edits were performed by this reviewer.

1. Adversarial SourceDb fixture: authored paths `can-source:1`, `can-source:0`, repeated `can-source:1` with different snapshot bytes; reversed source references; empty/repeated names; named unmapped row; empty source; empty generated map retaining all sources. Fixed expected library-decoded source/name tuples matched. Original `é😀x` byte offset 6 remained column 6 in the map.
2. Numeric envelope fixture: all nonalphabet byte characters except legal row delimiters rejected; maximum accepted 13-digit negative magnitude decoded to `-4611686018427387903`; excessive top payload bits, 14-digit inputs, unfinished continuations, and accumulated i64 overflow returned errors.
3. Probe against the rebuilt final rlib after contents optimization: exact ASCII `AAAAA;AACA;AACA` for first named row followed by unnamed rows, retained public source text, production and test-module nested object JSON, manual null contents, and `\\u0008`/`\\u000c` escaping all passed.
4. Executed `compiler/target/debug/deps/sourcemap_contract-354f7960a36a2283 --nocapture` directly, including after the final optimization: 1 passed. The independent arithmetic decoder used fixed byte-coordinate expectations. Actual source implementations of artifact parse/load, Cloudflare lookup/invokeCallable, and testkit reporting passed. Synthetic generated-frame invocation reported `coordinate.can:1:7`; fresh CLI artifact had 1 module and 24 mapping points with fixed frontend ownership anchors. Node 24.21.0; consumer codec 1.6.0, SHA-256 `2768e18f3bf937a0111c98872ff3e8ec8f5165d103a082b91f5127351beab7d0`.

## Reviewed source pins

| File | SHA-256 |
| --- | --- |
| compiler/src/codegen/sourcemap.rs | 93bb7708447b30ba5cb40c41bd1400c41407a4d1d5665343faf697320e07459a |
| compiler/src/codegen/artifact.rs | 5ee76bea1b84bb36985e99277292e688f02ae9097257ecafbb5571774c2c5d61 |
| compiler/tests/sourcemap_contract.rs | d6b245794c1aa323ba9eaa14804d734da1eaaf7c30e0a22e4ffaa39ed0c4bece |
| compiler/tests/fixtures/sourcemap-consumer.mjs | 3b16e56520173a45ca44e98858009714e2308b7281353a3d6ddeb67f805f0b32 |
| packages/cloudflare/src/runtime/sourcemap.ts | 565f9c8521b6eaed277a65bbb8b82c4edea0c4f67ddada9df071dd16d4199113 |
| packages/cloudflare/src/runtime/invoke.ts | 55178802cd4697279491b3997e79eb28b070a4ff580973d4513abdfe5023d2db |
| packages/cloudflare/src/runtime/artifact.ts | e04b6ee1dc35b427d2e70aff35410142c1a1eabcfd73dc9ace973f965a51b04d |
| packages/cloudflare/src/runtime/context.ts | 9f628244197b61fc376319c9a4fe5aed82fbd04a62b283c96e564f6877a614d8 |
| packages/testkit/src/reporting/report.ts | 79cbbfce42ed673196b6f0d2b32d567a3d302e4b8104429119bfd52a6ae6bcd1 |

## Limits

This receipt qualifies the current Can original-source byte-column profile and generated point mappings. It does not qualify browser UTF-16 navigation, deployed Cloudflare execution, large-memory resource limits, or all possible frontend lowering constructs. LSP UTF-16 positions retain their separate existing LineIndex owner. Root owns full Cargo checks and release bookkeeping; their results are recorded separately.
