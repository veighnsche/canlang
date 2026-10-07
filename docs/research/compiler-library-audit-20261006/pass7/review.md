# Pass7 independent review receipt

Reviewed 2026-10-07. Allocation: Sol, medium (parent-selected). Read-only code review; this receipt is the sole review edit. No Git operations.

Scope: typed live capabilities, positions/ranges/enums, diagnostics, locations, rename/code-action edits; admitted IDs and escaping; permissive authored URI identities; display-only native file projection; existing source coordinate ownership and document lifecycle. Inspected `output.rs`, `uri.rs`, final `server.rs`/`mod.rs`, the independent integration tests, `source.rs`, JSON input/output adapters, and VS Code location/edit/diagnostic consumers. Also inspected the installed lsp-types Uri serializer: it emits original `as_str()`.

## Executed checks

- `cargo test --manifest-path compiler/Cargo.toml lsp:: --lib`: 29 passed, 0 failed (90 filtered); includes both Unix URI adapter tests, lifecycle/raw ID/escaping checks and grouped edit versions/order.
- `cargo test --manifest-path compiler/Cargo.toml --test lsp_typed_output`: 3 passed, 0 failed; repeated after final native URI integration. Real stdio process witnesses cover all live output families, CRLF/supplementary UTF-16 coordinates, changed document versions, and opaque URI routing.
- `python3 - <<'PY' ... PY`: independent finite adversarial stdio probe, rerun against the final rebuilt binary. Used Python `json.dumps` and independent Content-Length framing/`json.loads` output parsing. Initialized the server, opened each URI with fixture text and versions 0–9, requested rename at line 6/character 14 with `newName: foo`, then shutdown/exit. Asserted exact URI/version document identifiers in every rename and exact matching diagnostic publication. Result: 10 URI identities passed, 22 output frames, exit 0.

Probe corpus below uses JSON escaping to expose literal control characters:

```json
["", "/a.can", "FILE:///A%2fB.can", "file:/a.can", "x:%00", "file:///q\u0000\n\t.can", "file:///x%ED%A0%80.can", "file://[bad", " foo ", "file:///a%252Fb.can"]
```

Probe used `editors/vscode/test/lsp-capabilities.can` verbatim. SHA-256 witnesses:

```text
input framed bytes  4746da112efe615ec025690b820ec5f37f97c9d3d971898f9e3985ea09206c45
output framed bytes f4fcb9fb14891ebc7330195e9f4a277fb56188d4b0195c1acea7ad1ec025f957
fixture UTF-8 bytes 85aa43ee466489cac94812f6623bd77265e1b605a686d8e344c62d20cba0cd01
```

Reviewed final snapshots (SHA-256):

```text
compiler/src/lsp/output.rs d68eb8a2291ed63682597945d39c3d0b00d52f9f5aa54a3b07f71b1e946aad30
compiler/src/lsp/uri.rs 3e7cf29690c1a257085d35f04b6dc50d0fb3255911ac6c5fdaf37e471245a08f
compiler/src/lsp/server.rs 79c53edb9ba35b411e48d7d0064776dfbb4b8b622f748dbb13d3958cb9f78743
compiler/src/lsp/mod.rs 722f436d11ac0cfdbf0a04ed958f7c75c86e31d98118adcdb6b0fba6fe11421e
compiler/tests/lsp_typed_output.rs 3249abed75aa14dc52288d338006a7362396a5d0e0167ef55eb5de85bbaa6cef
compiler/target/debug/can a8d3c421d922dac3d257d6a6bee3d45c91720ec8785e8350b9d2098b2fe395a0
```

## Findings and limits

No concrete correctness findings. Parseable Uri DTOs retain authored spelling; rejected strings use narrow compatibility serialization. Current edit versions, unopened null versions, first-seen URI grouping and edit order are covered. Final `uri_to_path` delegates to the native display adapter; routing/wire URI identity stays authored, and no filesystem loading was introduced. `source::LineIndex` remains the coordinate conversion owner.

Windows drive/UNC tests exist but were not executed on this Unix host. The adversarial probe checks rename identifiers and diagnostic routing, while the committed real-process tests supply precise edit/range/output-family assertions. No new symbol capability or transport migration was requested or assessed.
