# Pass 7 released output and URI contracts

Baseline compiler Git tree: `3a32c3a20464da0b1f958ac6059c5010a3aad3de` (compiler unchanged since Pass6 closure). The complete source/tool/catalog/runtime/dependency manifests and matched releases follow in the integration profile. Rust1.99.0/edition2024, native macOS aarch64 and locally emulated Linux x86_64 are the claimed release profiles. Node24.21.0 exercises the unchanged real VS Code consumer. Windows conversion is source-inspected only; no Windows runtime or external Rust backend qualification is promised.

## Finite writer packets

1. Root: release this contract and Cargo/lock integration, pinned `lsp-types=0.97.0`, defaults disabled and no proposed APIs. Four new packages only: lsp-types0.97.0, fluent-uri0.1.4, bitflags1.3.2, serde_repr0.1.21. Existing serde1.0.229/std/derive, serde_json1.0.151/std/raw_value and url2.5.8/std pins stay. The library's ordinary serde_json feature activates default std already present. No dependency version upgrades.
2. Sol medium DTO writer: `compiler/src/lsp/server.rs`, private `output.rs`, `mod.rs` registration. Convert eight actual families: initialization, hover, completion, definition/references, rename, semantic tokens, code actions, diagnostics. Preserve domain callback types and input/transport. No symbols endpoint is live or advertised; no new symbols capability. One released serializer-family packet, not an input rewrite.
3. Root, serialized after DTO writer: private `lsp/uri.rs`, `uri_to_path` adapter and registration. Existing two production callers are didOpen/didChange into SourceDb display paths, not filesystem/import reads. Delete old hex/lossy decoder after closure tracing. Original String URI owns docs/jobs/routing/replies; immutable SourceId owns snapshots. Source.LineIndex stays the only position converter.
4. Sol medium process witness writer: new `compiler/tests/lsp_typed_output.rs`, fresh actual binary and source-owned editor fixtures. Independent expected results for all families, current versions7→8, Unicode/CRLF, diagnostics and opaque identities. Ten-second process bound, no mocked backend or package skip in native sessions.
5. Sol medium independent review and host/dependency profile; root runs final native integration, unchanged real editor consumer, scoped formatting/Clippy, accepts measured cost and writes receipt. No escalation justified at contract release. Existing Pass2 admission/termination and Pass6 grammar witnesses remain required.

## Classified compatibility matrix

| Boundary | Acceptance | Classification |
| --- | --- | --- |
| Success envelopes/IDs | jsonrpc,id,result order, original admitted numeric/string ID lexemes | Exact bytes for envelope prefix, controls and obligated IDs; RawValue only for rendered admitted ID |
| Failures/framing | Existing fixed errors, strict bytes/identifier/version/param policy,64MiB body bound, termination | Released Pass2/6 behavior unchanged; no lsp-server dependency |
| Payload DTOs | All supported fields/values, option omissions, list ordering, empties and nulls | Semantic equality except frozen coordinate/location byte order and compact string policy |
| Object order | Position line,character; Range start,end; Location uri,range | Existing real editor JSON.stringify expectations preserve order |
| Permitted order differences | Library capability codeAction placement; diagnostic params uri,diagnostics,version | Semantic consumers; classified order-only change from uri,version,diagnostics |
| Strings | Shared compact formatter keeps control escaping, Unicode and one body with no serializer newline | Existing byte policy; serialize payload directly without input reparse/Value roundtrip |
| Current edit targets | Open target uses current i32 doc version, unopened code-action target explicit version:null | Correctness repair: omitted OptionalVersionedTextDocumentIdentifier.version was invalid; no promise of old omission |
| Edits/actions | First-seen file grouping, original edit order, empty rename edits, omitted empty action edit | Exact lists/omissions; legacy server always uses documentChanges, capability negotiation remains its existing profile |
| Coordinates/snapshots | UTF16 Source.LineIndex, CRLF/supplementary spans, current SourceId snapshots, stale work dropped | Exact independent coordinate/current result expectations; no second coordinate index |
| Semantic tokens | Preserve public backend Vec<u32> completely, including incomplete final tuple | Narrow typed raw vector, not silent chunks_exact truncation; typed legend/constants used |
| Wire URI | Original string bytes in every notification/location/edit and exact doc routing | Exact identity; no WHATWG canonicalization or new input restrictions |
| Standard URI DTOs | lsp_types::Uri parseable strings use complete library DTOs | Probe confirms original spelling including percent case/FILE and non-file schemes; parser accepts relative/empty |
| Exceptional URI DTOs | Raw Unicode and malformed-percent strings retain original String in small typed compatibility views | Existing server String admission unchanged, no dropped results or panics; other fields use library types |
| Native display conversion | Case-insensitive explicitly authored file:// only; checked file scheme and native authority, exact UTF8/no NUL, otherwise original string | Deliberate finite policy; query/fragment excluded and library dot handling within scope |
| Other displays | Non-file, file:/, file:relative, failed parsing/native conversion remain original string | Non-file verbatim promise repaired; no filesystem loading responsibility |
| Host authorities | Unix local/localhost projected; remote raw; escaped separators use dependency-native rules | Linux/macOS qualified; Windows drive/UNC code exists but unexecuted |
| Invalid decoded file bytes | Invalid UTF8 or NUL uses raw identity fallback | Lossy replacement/collision repair; containment is metadata conversion, not protocol rejection |

## Evidence and policy selection

[Actual caller/consumer inventory](output-inventory.md), [URI investigation](uri-investigation.md), [crate probe](uri-library-probe.log) and independently compiled old/dependency [vector harness](uri-vector-probe.rs) distinguish observed old defects from intended compatibility. The legacy helper already decoded valid multibyte UTF8 correctly; this is not a per-byte Unicode bug claim.

Three independently worded verified-context JEV consultations compare the same outcomes/alternatives. [Assessment](consultation/assessment.md) records advice/uncertainty. Selected narrow typed compatibility views and narrow native display conversion; admission tightening is a larger separate input policy, and always-String outer DTOs remain a fairly considered simpler alternative with less complete library adoption. Output wire identities are separate from native/display projection under every alternative.

The existing full-framed witnesses and unchanged `editors/vscode/test/lsp-capabilities.cjs` provide the actual consuming seam. New tests specify independent expected spans, versions, exact opaque routing, omissions and family values; neither old encoder nor library serialization is the sole oracle. Multi-file/unopened-null custom backend behavior is unit-qualified separately because current RealAnalysis returns same-file edits. No broad editor negotiation, Windows, external analysis backend or filesystem import claim.
