# Pass 7 URI adapter contract investigation

Read-only investigation; no repository edits. Verified 2026-10-07 on macOS using cached url 2.5.8 source and an independently compiled vector harness. No new owner policy accepted here.

## Actual caller closure

- `compiler/src/lsp/server.rs::uri_to_path` has exactly two production calls, in `didOpen` (line 884 at inspection) and changed-text `didChange` (936). Both pass its String to `SourceDb::add`. Tests have three baseline assertions (space, untitled without escapes, literal invalid percent).
- `Server.docs` is keyed by original authored URI strings; pending diagnostics jobs store that string; `doc_id`, didChange, didClose, requests use exact string lookup. No conversion is used for protocol identity.
- `RealAnalysis::snapshot` calls IDE `Snapshot::analyze` with SourceId. The snapshot parses the supplied text, checks only `[file]`, and resolves only that syntax tree. Query positions use source text / LineIndex / UTF-16 units independently of URI or display path. Definition/references (server 341/359), rename (740 onward), diagnostics (1013), code actions and FileEdit preserve authored URI. No reconstructed file URI is emitted.
- `Source.path` is documented as display path, but `SourceDb.by_path` also indexes latest source ID by that string. SourceId remains the true immutable snapshot identity. URI decoding collisions can collapse `lookup` entries, though the current LSP uses docs IDs directly and does not call `lookup`.
- There is no source filesystem/import-loader chain from this helper in the compiler. `analysis/resolve.rs` indexes app/package names from syntax (630 onward) and resolves imports to provided declarations by module name, not filenames. Filesystem reads in the LSP are producer catalog startup reads based on process cwd/env (`RealAnalysis::from_process`), unrelated to document path. Repository-wide Rust/TS searches found no ImportLoader/FsLoader/to_file_path or additional helper callers.
- Source paths flow into diagnostic render/export and codegen sourcemaps/artifact metadata in other consumers, but these are not called by the LSP snapshot path above. Do not describe this slice as fixing import discovery or file reads.

## Existing behavior and real defects

The old decoder collects bytes and then calls `String::from_utf8_lossy`. It is NOT a per-byte Unicode decoder: valid raw and percent-encoded multibyte UTF-8 both work. Invalid decoded UTF-8 is replaced with U+FFFD, causing lost information and possible collisions.

1. Non-file URI percent escapes are decoded despite the helper contract explicitly promising other URI verbatim. `untitled:a%20b.can` becomes `untitled:a b.can`; `vscode-remote://ssh-remote+host/a%20b.can` becomes a different display identity. `%FF` outside file scheme is also lossy.
2. `file://localhost/a.can` becomes relative `localhost/a.can`; remote authority becomes relative `remote/share/a.can`. Authority is confused with a path component.
3. File query/fragment are appended to display filename: `file:///a.can?q=one#frag` becomes `/a.can?q=one#frag` instead of identifying separate URI components.
4. Only lowercase exact `file://` prefix is recognized. FILE:/// and file:/ forms are not converted, while malformed/relative strings still undergo unconditional percent decoding.
5. On Windows, `/C:/Users/a.can` is not the native drive path and `remote/share/a.can` is not UNC. Current Linux/macOS release artifacts do not assert shipping Windows support, so this is a documented platform gap rather than a verified Windows regression.
6. Decoded slash/backslash and NUL behavior is currently unrestricted. `%2F` produces slash; `%5C` produces backslash; `%00` produces NUL. Changing these rules is distinct from Unicode repair.

None of the above alters outbound authored URI or LSP request routing in today's implementation. The practical current defect scope is SourceDb display/index metadata, not arbitrary filesystem access.

## Qualified dependency behavior

`compiler/Cargo.toml` currently pins `url = { version = "=2.5.8", default-features = false, features = ["std"] }`. Cached source is `/Users/vince/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/url-2.5.8`.

- `Url::parse` is an absolute WHATWG URL parser, not a raw URI identity owner. It lowercases scheme, encodes raw Unicode, removes localhost file authority and resolves dot segments. `file:relative.can` parses to `file:///relative.can`. Therefore do not replace protocol keys with `Url::as_str`.
- `Url::path` keeps escapes and excludes query/fragment; extracting path alone would discard remote authority.
- `Url::to_file_path` requires callers to check scheme. On Unix it admits empty/localhost hosts and returns Err for remote authorities. On Windows it supports remote file authority as UNC and local drive forms. It is available on unix/windows/redox/wasi/hermit with std; other targets do not expose the method.
- Unix implementation constructs OsStr from percent-decoded bytes. Actual macOS harness proves invalid UTF-8 and NUL are admitted, despite docs' legacy `Path::new_opt`/NUL failure prose. Thus `to_str` or `into_os_string().into_string` must be used if an exact String is wanted; `to_string_lossy` repeats the old Unicode defect. No real filesystem I/O was attempted with NUL.
- Windows implementation requires strict decoded UTF-8, handles literal or percent-encoded drive colon, and does not reject decoded separators itself. Windows branch was source-inspected only, not runtime tested.
- Invalid percent forms `%`, `%2G` are tolerated verbatim by url parsing / percent decoder. Neither replacing helper nor using Url justifies imposing stricter percent validation without a separate policy.

Official primary docs: [Url 2.5.8](https://docs.rs/url/2.5.8/url/struct.Url.html#method.to_file_path), [VS Code Uri API](https://code.visualstudio.com/api/references/vscode-api#Uri). VS Code `Uri.toString()` serializes with scheme-specific normalization and supports subsequent Uri.parse; `fsPath` handles UNC, Windows drive casing, and native separator. The checked-in client consistently sends `document.uri.toString()` (`client.ts` 676/690/702/711 and `extension.ts` providers). Incoming diagnostics/locations/workspace edits use Uri.parse. No client fsPath is transmitted. The server's authored URI is this exact received serialization, not necessarily the user's original spelling before VS Code construction.

## Finite platform/authority policy evidence and alternatives

Release matrix `.github/workflows/release.yml` lines 18–20 ships Linux x86_64 and macOS aarch64. Both use Unix file conversion. Therefore finitely qualified native filesystem conversion cases here are local empty authority and localhost; remote authority is unsupported on these hosts. Preserve full remote URI as display fallback, or format remote authority explicitly; stripping it is not valid local conversion. Windows support may use Url's drive/UNC branch, but is a source-only candidate until tested on Windows. The source can cfg-gate native conversion for unsupported OSes and preserve URI.

Contract-compatible candidate (proposal, not accepted decision): keep authored URI in docs and all wire outputs; parse separately only to derive a display String; guard `scheme == "file"`; use native `to_file_path`; use exact UTF-8 extraction; on parse/conversion/string failure retain authored URI. Ordinary non-file strings retain authored bytes. Decide file query/fragment treatment and permissive file forms explicitly, because Url normalization changes more than decoding.

Consequential alternatives needing three independently worded equivalent verified-context JEV consultations if owner/root wants to choose them:

- Display semantics: native platform path with raw fallback vs portable URI-derived file display preserving authority. Compare readability, supported local/remote documents, cross-platform stable metadata, exact byte preservation, and future path indexing. Neither implies real filesystem loading.
- Accepted file forms/normalization: adopt all Url file canonicalization (case, file:/, dot segments, relative-looking file: form, query/fragment omission) vs retain narrow historical file:// contract and treat exceptional forms as raw URI. Compare same corpus and retain exact wire URI under either.
- Encoded separators / NUL / nonUTF8: dependency-native conversion vs explicit conservative string-only fallback on problematic components. The Unicode exactness requirement is straightforward, but introducing rejection rules for separators/NUL is a semantic contract choice.

Ordinary frozen implementation choices do not need fresh JEV: released pinned url version/features, preserve raw authored wire identity, non-file verbatim promise, exact UTF8 extraction over lossy extraction, SourceDb owner unchanged, no new import loader/FS path responsibilities, sequential server writer. Relative/malformed input fallback is an adapter containment choice if permissive existing incoming URI acceptance is frozen; changing protocol validation belongs to the DTO/URI owner decision, coordinated by root.

No JEV tool was found among current enabled tool metadata; this investigation identifies consultation subjects without making those decisions.

## Independent observed vectors (macOS)

Harness `/private/tmp/canlang-pass7-uri-vectors.rs` extracts the actual existing helper and links cached liburl directly, without repository edits. Command: `rustc --edition 2024 ... --extern url=compiler/target/debug/deps/liburl-2fddfc1230637660.rlib -L dependency=compiler/target/debug/deps`. Initial default-edition attempt failed before execution; rerun with Rust 2024 passed.

| Input | Old display | Url/native observed result |
| --- | --- | --- |
| file:///a%20b.can | /a b.can | /a b.can |
| file:///caf%C3%A9.can | /café.can | /café.can |
| file:///café.can | /café.can | serialized escape; native /café.can |
| file:///bad%FF.can | /bad�.can | native nonUTF8 bytes `/bad\\xFF.can` |
| file:///100%.can | /100%.can | /100%.can |
| file:///x%2G.can | /x%2G.can | /x%2G.can |
| file:///a%2Fb.can | /a/b.can | /a/b.can |
| file:///a%5Cb.can | /a\\b.can | /a\\b.can on Unix |
| file:///a%00b.can | embedded NUL | native embedded NUL |
| file://localhost/a.can | localhost/a.can | /a.can |
| file://remote/share/a.can | remote/share/a.can | Err native conversion; host retained in parsed URL |
| file:///C:/Users/a.can | /C:/Users/a.can | /C:/Users/a.can on Unix |
| file:///C%3A/Users/a.can | /C:/Users/a.can | /C:/Users/a.can on Unix |
| FILE:///a.can | FILE:///a.can | /a.can |
| file:/a.can | file:/a.can | /a.can |
| file:///a.can?q=one#frag | /a.can?q=one#frag | /a.can |
| untitled:a%20b.can | untitled:a b.can | parsed escape retained; native Err |
| vscode-remote://ssh-remote+host/a%20b.can | URI with decoded space | parsed escape retained; native Err |
| relative%20name.can | relative name.can | RelativeUrlWithoutBase |
| file:relative.can | file:relative.can | /relative.can |
| file:///a/../b.can | /a/../b.can | /b.can |

Implementation tests should assert expected contract values, not clone implementation; include wire lifecycle integration proving original authored URI survives diagnostics, requests, locations, and edits. Platform-specific path expectations require cfg/platform tests. No repository tests were run since no repository code changed.
