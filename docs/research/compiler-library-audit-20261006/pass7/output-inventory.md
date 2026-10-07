# Pass 7 LSP output contract inventory (read-only production)

Scope: compiler/src/lsp/server.rs is the sole output construction owner. transport.rs owns existing input/framing/error/id and is not to be migrated. LanguageAnalysis domain DTOs and source LineIndex remain existing public ownership. No production edits made during this inventory.

## Finite live families

1. initialize: InitializeResult / ServerCapabilities / ServerInfo / PositionEncodingKind UTF16 / TextDocumentSyncKind FULL / CompletionOptions default empty / SemanticTokensOptions+Legend.
2. hover: Option<Hover> with MarkupContent markdown; range omitted.
3. completion: Vec<lsp_types::CompletionItem>; label + optional CompletionItemKind only. Unknown string kind must remain omitted. Current names exhaustive 1..25.
4. definition/references: Vec<Location>; URI and Range, original location order retained.
5. rename: WorkspaceEdit document_changes = DocumentChanges::Edits(vec![TextDocumentEdit]); even invalid name has one file with zero edits. Missing-document case remains result:null. OptionalVersionedTextDocumentIdentifier version currently illegally omitted and must be corrected to current open version.
6. semanticTokens/full: SemanticTokens, flattened raw quintuple bytes currently analysis Vec<u32>; use chunks_exact(5) -> SemanticToken with result_id None. Valid real producers generate complete quintuples. Need preserve custom trait behavior if incomplete input is possible, or keep narrow typed wrapper data Vec<u32> to avoid truncation. Root should decide.
7. codeAction: Vec<CodeAction>; title/kind; edit omitted when edits empty; CodeActionKind can carry existing arbitrary string; first-seen URI grouping and per-group original edit order retained. Each grouped URI lookup in server docs supplies current version or null for unopened URI (required field).
8. diagnostics: PublishDiagnosticsParams URI/version/Vec<Diagnostic>; Diagnostic uses range, severity enum ERROR/WARNING/INFORMATION, string code, source can, message. All other diagnostic properties omitted.

No document/workspace symbol callback/request/output/capability exists. Symbol-related live output is completion kind. Adding symbol API exceeds closed output migration.

## Ownership and conversion

LineIndex::to_lsp(text, offset, true) in compiler/src/source.rs already owns clamping, CRLF, astral UTF16 and scalar-boundary behavior. span_to_range(server.rs) uses it. Reuse span_to_range for diagnostics, then convert TextPos -> lsp_types::Position and LspRange -> lsp_types::Range at wire boundary. Avoid duplicated coordinate arithmetic or new source owner dependency on lsp-types.

Actual production caller is cli.rs -> run_stdio -> Server<RealAnalysis>. Public Server tests use existing Json calls. LanguageAnalysis DTOs are used internally in server.rs and hermetic analyses therein; no additional external Rust analysis implementations found. Keep public DTOs/trait stable.

## Envelope/input invariants

transport::parse_call validates duplicate reserved keys/ID exact integer lexemes/first member data separately; lifecycle valid_params admission unchanged. Json Num raw ID spellings include negative zero/exponents and must echo identically. Existing response byte prefix jsonrpc,id,result and errors jsonrpc,id,error retained. No blanket Value or raw JSON roundtrip for DTOs. Use server-private generic Serialize envelope with exact Json id serializer or RawValue only for rendered ID; DTO payload serialize directly. Transport compatibility helpers remain unchanged.

Stale queue/pump, shutdown lifecycle, full sync handling, didOpen/didChange integer admission unaffected. Incoming URI admission must not silently tighten through library parse without explicit contract decision.

## Existing observables/tests

compiler/src/lsp/transport.rs JSON-RPC response_shapes test checks members but mostly contains; compiler/tests/lsp_admission.rs has exact response bytes for invalid params/error and raw ID prefix/order, source IDs not normalized. compiler/tests/ide.rs asserts providers and semantic payloads/substrings; editors/vscode/test/lsp-capabilities.cjs uses JSON.stringify equality on Location/Range objects, making those property orders observable! Location current uri,range; Range start,end; Position line,character should match library field order. Capability/action/diagnostic tests do not snapshot complete byte order. Library field-order changes must still be enumerated/classified before accepted.

Real sessions: editors/vscode/test/lsp-capabilities.cjs advertised seven providers, legend UTF16; compiler/tests/b3_s4.rs code-action real stdio session; b3_authoring_join.rs rename/apply change/republish and CLI fix join; lsp_admission.rs hostile frame/admission sessions. Separate test owner should add complete output family/session coverage including edit version current changes, version:null unopened files, URI/edit ordering, Unicode ranges/escaping and old empty/omission shapes.

## Library fit / verified source

https://docs.rs/lsp-types/latest/lsp_types/struct.OptionalVersionedTextDocumentIdentifier.html reports latest 0.97.0 and fields uri:Uri, version:Option<i32>; docs expressly describe null when unopened. https://docs.rs/lsp-types/latest/lsp_types/struct.ServerCapabilities.html is typed capabilities source. 0.97.0 is not currently in local cargo registry. URI shape differs pre-0.97 url::Url; root/URI worker owns admission/preservation proposal before writer release. Root owns Cargo/lock and dependency pin.

## Proposed implementation release boundary

Writer: server.rs only, optional private output child module if needed. No packages/Cargo/lock/Git/docs decisions writes. Typed DTO payload serialization should be pure infallible owned primitive payloads; errors must not escape protocol lifecycle or panic on input-admitted URI. Preserve empties/omissions/array ordering. Versions are intentional correctness change; reorder-only changes reviewed/classified; all other payload members must match existing schema.
