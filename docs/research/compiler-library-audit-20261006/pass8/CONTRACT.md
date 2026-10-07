# Pass 8 released source-map contracts

Compiler baseline Git tree `295908144f14a070ac5f62122d1d0d982ea47c89`; before Pass8 compiler implementation is `6729b85`. Root integrates dependencies, contracts, decisions and commits; Sol medium owns codec/artifact implementation, permanent independent consumer regressions, independent review and host/cost profile. No coordinate-policy conflict warrants escalation or a new JEV decision. Another AI owns package work: its current mapper is examined and pinned, never edited or staged here.

## Consumer decision before implementation

Preserve original `.can` **zero-based byte columns** in maps, and source-owned CRLF semantics. Half-open Span byte offsets flow through LineIndex::line_col, then subtract one. Actual Cloudflare lookup returns original column+1, invoke's generated-frame branch subtracts one from V8 generated columns before lookup, and the report helper prints the returned position. Independent decoder and actual current producer/mapper/invoke agree: `é😀x` offset6 maps to Can column7. LSP converts separately to UTF16 and consumes no maps. [Qualification](consumer/qualification.md) pins complete closure, source/dependency hashes, actual probe and limits; current-source coordinate code exactly matches the prebuilt compiler probe, so stale rlib position logic is not the oracle.

This resolves the runtime byte-profile contract. It does not establish browser navigation, GUI editor source maps, Node enable-source-maps remapping or workerd original-column semantics. ECMA426's JS column convention does not itself dictate other original content types. No demonstrated consumer mismatch justifies changing this packet's original columns.

## Finite writer packets and acceptance

1. Root releases this finite contract, exact `sourcemap=9.3.2`, defaults disabled/no ram_bundle; Cargo/lock has66→93 packages,27 additions, no existing dependency versions/checksums removed/upgraded. Registry manifests/checksums/licenses/active host features and representative costs need final qualification. Existing serializer/url pins remain. [Lock change](library/lock-change.json), [registration probe](library/registration-probe.log).
2. Sol medium sole codec writer: `compiler/src/codegen/sourcemap.rs` and affected `artifact.rs` typed seam. Use library builder/encoder and explicit returned IDs; preserve SourceDb snapshot arrays even for duplicate paths, and first-appearance name registration. Keep Source.LineIndex byte/CRLF adapter. Public SourceMap/DecodedSegment shapes stay. Retire private alphabet, numeric encoder and numeric decoder.
3. Sol medium witness writer: new `compiler/tests/sourcemap_contract.rs` and isolated consuming harness/fixtures. Independent prescribed decoding/positions plus actual current source mapper/invoke and fresh CLI artifact parse/load/lookup. Cover multi-source/repeated-path snapshots, nonASCII, CRLF, repeated/empty names, empty/unmapped rows, fields/order/content/null and generated indexing. Existing exact codegen and typed artifact fixtures remain acceptance, not the sole oracle.
4. Sol medium clean-room review; root native full checks/Clippy/scoped formatting and matched macOS/Linux release/source/dependency/per-map cost receipt. Commit qualified packets separately. Browser/full package rebuild/transport/language spans are not expanded.

## Classified compatibility matrix

| Boundary | Required outcome | Classification |
| --- | --- | --- |
| Original coordinates | Span.start -> Source.LineIndex::line_col -> 0-based byte line/column | Existing actual Can runtime contract, independent fixed nonASCII/CRLF witnesses |
| Generated points | Each JsLine vector index at generated column0, all lines represented; advisory JsLine.line does not change it | Existing emission attribution/indexing |
| Sources/content | All SourceDb immutable IDs in order, repeated authored paths retain separate snapshot text; manual SourceMap None remains null | Exact lists/content/identity; no builder path dedup collapse |
| Library source IDs | Record returned registration IDs; private collision-free keys may prevent snapshot dedup before restoring authored paths | Explicit translation, never leak private registration keys |
| Names | First appearance, repeated/empty names, including registrations on unmapped lines | Exact names array; returned library IDs used in mapped tokens |
| Valid mapped bytes | Existing AAAAA;AACA;AACA and required typed artifact snapshots unchanged | Byte fixture equality; broader maps qualify equivalent actual mapping outcomes |
| Missing source IDs | Generated segment remains present but lookup returns no original location | Correct meaningful one-field unmapped segment replaces bogus out-of-array attribution; old malformed raw bytes are not promised |
| Empty/no maps | Empty mapping string for no emitted lines; source/name arrays/content fields remain | Exact shape; no dropped source contents/optional fields |
| Map JSON | version,file,sources,sourcesContent,names,mappings order, shared compact control escaping, no newline | Exact established artifact wire bytes |
| Artifact embedding | Borrow typed SourceMap directly, no pre-rendered raw fragment | Retire live RawValue/helper after closure tracing; public to_json adapter stays |
| Library encoded projection | Library exposes encoded mappings through full-map writer; narrow Deserialize projection once per build | Temporary O(encoded map metadata/mappings bytes); source text stays only in final typed contents, measure cost, no new codec/parser |
| Public decode utility | Only tests call it; preserve rows/empty lines/order,1/4/5 fields and signed running view, no source/name table needed | Narrow compatibility view delegates actual VLQ numeric grammar to library; not production artifact parser |
| Malformed numeric input | Reject invalid alphabet/unsafe encoded width and checked-delta overflow without panic | Narrow dependency guards; native error details classified, no malformed-acceptance promise |
| Guarded primitive limits | Candidate accepts !A/éA and corrupts oversized signed high-bit fields in probes | Observed library defects, not an unproved panic claim; guards validate envelope only, no local value decoding |

Independent actual mapper replay passes277 frozen cases/910 lookups; these belong to the owning package profile and do not imply the new compiler decodes that entire malformed corpus identically. The new encoder's required profile is emitted nonnegative source coordinates/IDs and retained signed-delta test view. Native Rust1.99/Node24 and Linux x86_64 release qualification follow; no dependency minimum/Windows/browser claim. Source maps for other AI provider Rust→JS work are distinct from this compiler's `.can`→JS maps.
