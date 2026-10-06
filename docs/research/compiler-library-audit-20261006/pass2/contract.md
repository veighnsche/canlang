# C02 admission contract — accepted October 7, 2026

This freezes the byte/envelope packet, not the shared JSON migration or framework transport. The [Pass 0 receipt](../pass0/protocol-contracts.md) stays historical. Comparison inputs and host are pinned in [profile.json](profile.json) and [baseline-input-manifest.json](baseline-input-manifest.json).

## Owning caller closure

`run_stdio` receives bounded byte bodies from `transport::read_message`, strictly decodes UTF-8, parses through the existing shared JSON owner, then calls `Server::handle_json`. `transport::parse_call` has that single production consumer. It owns envelope admission and safe ID correlation. The server owns lifecycle and method parameter admission. Neither owner changes the shared `Json::as_i64`, ordered object representation, numeric renderer or depth limit.

Supported callers are the VS Code client (`editors/vscode/src/client.ts`, providers in `extension.ts`), the editor capability process probe, the Rust process driver (`compiler/tests/common/lsp_driver.rs`), compiler authoring/IDE/server fixtures, and CLI process tests. The real editor already sends required initialize/document/context fields; incomplete compiler fixtures must be corrected. Both actual editor null shutdown/exit params and Rust empty-object params remain supported.

## Envelope and response matrix

| Input boundary | Accepted contract / disposition | Classification |
| --- | --- | --- |
| Complete body with invalid UTF-8 or malformed JSON | One `-32700` error with null ID; do not dispatch; consume exactly its frame so a following valid frame works | Correctness repair; lossy string replacement is wrong |
| Non-object, missing/wrong `jsonrpc`, missing/non-string method | `-32600`; echo a unique admitted ID if detected, otherwise null | Correctness repair plus explicit correlation policy |
| Duplicate decoded `jsonrpc`, `id`, `method`, `params` | `-32600`; duplicate ID correlates null, other duplicates may correlate unique admitted ID | Chosen unambiguous LSP boundary policy; shared JSON still retains duplicates |
| Absent ID | Admitted notification: no response, including method-level errors/unknown methods | Intended compatibility |
| Explicit null, bool, object, array, non-integral or out-of-range ID | `-32600` with null ID; never treated as notification | Correctness repair; generic JSON-RPC null allowance does not define this LSP request profile |
| String ID | Admit decoded value, echo same value; original escape byte spelling is not required | Preserved semantic equality |
| Integral numeric value within signed 32-bit range | Admit exact mathematical value regardless of fraction/exponent spelling; echo original JSON number lexeme, including `-0` | Preserved stronger byte fidelity, explicitly selected value interpretation |
| Primitive params | Invalid envelope: `-32600`, with safe correlation, including null-ID error on an absent-ID malformed envelope | Chosen structural interpretation; uncertainty retained below |
| Omitted params | Envelope admitted; supported method validates its own requirements | Absent is retained separately from explicit null |
| Shutdown/exit params | Omitted, explicit null, or empty object accepted; other structured forms fail method admission | Narrow compatibility extension for actual callers |
| Unknown envelope/capability extensions | Accepted; unknown duplicate extension members unchanged | Forward compatibility; no blanket field whitelist |

Exact decimal admission never converts to floating point. Zero is recognized before exponent conversion; exponent arithmetic is bounded/saturating and no allocation or power scales with exponent magnitude. It admits `1.0`, `1e0`, `0.1e1`, `1000e-3`, `2.147483647e9`, `-2.147483648e9`, and huge-exponent zero. It rejects precision-rounded fractions, tiny nonzero fractions and either range overflow. The shared lexical integer accessor remains unchanged.

## Method projection and lifecycle

Only mandatory fields and consumed types for the supported methods are validated; this is not exhaustive validation of every optional LSP capability/diagnostic schema. Unknown extension properties remain accepted. Nested duplicate method properties remain the shared parser's first-match behavior; this packet rejects only reserved envelope duplicates.

- Initialize requires object params containing `processId:integer|null`, `rootUri:string|null`, `capabilities:object`. Validate before Ready. Initialized requires an object.
- Hover/completion/definition require text-document URI and position. References also requires boolean `context.includeDeclaration`; rename requires string `newName`. Semantic-token requests require document URI. Code actions require range and `context.diagnostics` array; ignored diagnostic element schemas are unchanged.
- Positions and ranges use nonnegative LSP integer coordinates capped at `2147483647`; URI values stay strings here. URI decoding/path policy is a later owner.
- DidOpen requires URI, languageId, integer version and text. DidChange requires URI, integer version and an array of change objects with text and correctly shaped range/rangeLength when present. DidClose requires URI. Synchronous cancellation remains a no-op.
- Envelope failure precedes lifecycle. Other admitted preinit requests receive `-32002`; duplicate initialize and post-shutdown requests receive `-32600`; unknown Ready methods receive `-32601`; malformed known method fields receive `-32602`. Method-invalid notifications stay silent and do not mutate documents.
- Drop notifications before initialize and after shutdown except a valid exit. Exit before shutdown returns process status 1; shutdown then exit returns 0. Existing clean EOF/torn disconnect returns 0.

Required version validation removes malformed missing/invalid-version fallback and out-of-range clamping admission. For admitted versions, existing same-text reuse, equal/decreasing version handling, stale diagnostic cancellation, last full-text change selection and ignored incremental-only changes remain unchanged. Full sync and position interpretation are not redesigned.

## Framing classification retained for later transport work

| Existing boundary | This packet |
| --- | --- |
| Inclusive 64 MiB body bound, byte Content-Length, split reads | Preserve and qualify with framing witnesses; reject cap+1 before body allocation |
| CRLF and existing bare-LF extension | Preserve |
| Clean EOF and torn header/body | Preserve existing disconnect exit |
| Case-insensitive header name, trimmed length, `+2` length acceptance | Preserve; digit grammar/ASCII-header policy deferred |
| Duplicate Content-Length (last wins), missing/invalid/conflicting length recovery | Preserve existing behavior; no new resynchronization guarantee. Termination/recovery and equal-duplicate policy remain gated |
| Content-Type/unsupported charset ignored | Known conformance gap; metadata-aware rejection/code selection deferred. Strict body decoding always requires UTF-8 regardless of declared charset |
| Header line/aggregate budgets | No current bound; policy deferred rather than inventing a limit |
| Shared JSON depth and duplicate representation | Preserve; C06 migration still independently gated |

No dependency is introduced. Candidate typed LSP DTOs and framework transport remain later packets; strict admission does not select their APIs or features. This host qualification is macOS arm64. Windows/Linux process behavior is not claimed by local execution.

## Evidence and consultation uncertainty

The [three requests and saved responses](consultation/assessment.md) separate independent gates; they do not select a library. Advice is unanimous on reserved duplicates, detected legal-ID correlation, narrow shutdown compatibility, required-field projection and lifecycle-first precedence. Numeric interpretation and primitive params split 2–1 with low confidence. Primary evidence supports numeric-value interpretation without a lexical prohibition; JSON-RPC's malformed-request example does not isolate primitive params alone. The selected structural boundary is an explicit project policy, not a claim that the specification uniquely mandates that error/no-response distinction.

Primary sources: [LSP 3.17 base types/messages](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/specification.md), [initialize](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/general/initialize.md), [JSON-RPC 2.0](https://www.jsonrpc.org/specification), [JSON number/object grammar](https://www.rfc-editor.org/rfc/rfc8259), [references](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/language/references.md), [code actions](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/language/codeAction.md), [document versions](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/types/versionedTextDocumentIdentifier.md).
