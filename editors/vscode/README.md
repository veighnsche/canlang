# Canlang draft syntax highlighting

A declarative VS Code-compatible extension for the current `.can` drafts in this project. `GRAMMAR.md` defines source spelling; `DESIGN.md` defines semantics. Those documents currently call the design v1. This extension follows their current content rather than assigning a new language version.

The extension contributes the `can` language, `source.can` TextMate scopes and one-space indentation defaults. It distinguishes full-line `##` comments, `#` description metadata, `#=` message references, JSON strings and `@{...}` localization. Declarations, Given/When/Then, type positions, effects, examples, routes, presentation and maintenance forms receive syntactic scopes. Field, parameter, attribute and member names remain names even when they match syntax words; builtin names are not globally reserved. Variable uses, properties and syntactic calls use standard `variable.other.readwrite`, `variable.other.property` and `entity.name.function.call` scopes so themes can distinguish them.

Highlighting approximates contextual syntax. It provides no diagnostics, compiler integration, commands, snippets or runtime dependencies by itself; diagnostics come from the LSP client below. It does not validate a program or consistency between drafts. Documented page polling/refresh, CSV form import and preference ordering are highlighted independently of prototype-parser coverage. Single/triple/raw strings, `//` and `/* */` comments, and old `fn` declarations have no special support.

## LSP client (real server, all 7 capabilities)

`src/extension.ts` activates on the `can` language and `src/client.ts` spawns `can lsp` over stdio (Content-Length JSON-RPC), forwarding open/change/save/close for `.can` documents and rendering `publishDiagnostics` in the editor. The server is the real analyzer — hover, completion, definition, references, rename, semantic tokens and code actions are all implemented server-side (`compiler/src/lsp/server.rs` advertises them in `capabilities()`), and the client registers a provider for each:

- hover (markdown), completion (with LSP kinds), go-to-definition, find-all-references, rename (workspace edit), full-document semantic tokens, and quickfix code actions (e.g. the `I1002` redundant-`?.` rewrite).

There are no npm dependencies: both files carry ambient declarations for the minimal `vscode`/`child_process` surface they use. Adopting `vscode-languageclient` was considered and rejected — it would break the zero-dependency `tsc --strict` gate (lane-01 pins empty typeRoots); extending the hand-rolled client was smaller and keeps the build hermetic.

Settings: `can.serverPath` (default `can` on PATH) selects the server binary; `can.traceServer` logs LSP traffic to the Can output channel. Changing either setting restarts the server automatically. The contributed `Can: Restart Language Server` command (`can.restartServer`) restarts it on demand; when the server crashes, the client reports the exit code and offers restart-on-reopen as well as the command. The client `initialize` handshake advertises real support for every capability above, including the semantic-token legend (which must match `TOKEN_TYPES`/`TOKEN_MODIFIERS` in `compiler/src/ide/tokens.rs`; the round-trip test below fails loudly on drift).

Build from this directory (TypeScript via bunx, no install step):

```sh
bunx -p typescript@5.6.3 tsc --strict --target es2022 --module commonjs --lib es2022 --outDir out --rootDir src src/extension.ts src/client.ts
```

or `bun run compile` once TypeScript is available. Type-shape check without emitting:

```sh
bunx -p typescript@5.6.3 tsc --noEmit --strict --target es2022 --lib es2022 src/extension.ts src/client.ts
```

Run: build first, then launch the extension host from this directory (or install the packaged VSIX) with a `can` binary on PATH, and open any `.can` file. Server stderr and (with `can.traceServer`) framed traffic appear in the Can output channel. All seven providers flow end to end against the real server: hover a symbol, trigger completion, jump to a definition, list references, rename a binding, observe semantic coloring beyond the TextMate grammar, and accept a quickfix on an `I1002` redundant `?.`.

Round-trip verification (no IDE needed): `node test/lsp-capabilities.cjs` (or `bun run test:lsp`) spawns the real `can` binary over stdio and asserts every capability against the `test/*.can` fixtures — `initialize` advertisement plus hover, completion, definition, references, rename, `semanticTokens/full` and code actions. Binary resolution: `$CAN_BIN`, then `compiler/target/debug/can`, then `can` on PATH.

The local artifact is `../../output/editor/canlang-draft-highlighting-0.1.11.vsix`. Install with the IDE's `--install-extension` CLI option. Remove `can-lang.can-lang` first, then reload existing IDE windows to unload the obsolete language server and load the new grammar. The separate `.ail` extension is unrelated.

Cursor install (same VSIX, VSCode-compatible manifest): from this directory, after building (file-icon export and `bun run compile` are automatic on pack via `vscode:prepublish`),

```sh
npx -y @vscode/vsce package --out ../../output/editor/canlang-draft-highlighting-0.1.11.vsix
cursor --install-extension ../../output/editor/canlang-draft-highlighting-0.1.11.vsix
```

then reload the Cursor window with a `can` binary on PATH and open any `.can` file. The `can.restartServer` command is available from the command palette as `Can: Restart Language Server`. No registry publish: the manifest carries `repository`/`license`/`icon` metadata but nothing publishes to any marketplace. [images/icon.png](images/icon.png) is the final opaque 512px extension icon, exported from the adaptive [SVG master](images/logo.svg). The approved raster remains in [images/icon-dark.png](images/icon-dark.png); [logo previews and verification](images/previews/README.md) record the vectorization.

The installed VSIX contains `package.json`, the compiled entry point `out/extension.js` (plus `out/client.js`), `syntaxes/can.tmLanguage.json`, `images/icon.png` and this README, plus packaging metadata. `out/` is generated by the build step above (also run automatically by the `vscode:prepublish` hook on pack) and activates on the `can` language (`activationEvents: onLanguage:can`) and the restart command. `src/`, `test/`, `audit-astra/`, `images/previews/`, `GRAMMAR-AUDIT.md`, `AUDIT-RESOLUTION.md`, `PALETTE.md`, `check-highlighting.cjs`, `generate-file-icons.cjs`, `token-colors.json` and `*-evidence.json` are local review/verification assets excluded from the VSIX via `.vscodeignore`.

The grammar separates Given declarations, When execution, Then/page composition and example tables. Joined expressions, types, selectors and operation targets retain their contextual roles across physical lines. `AUDIT-RESOLUTION.md` records each independent audit finding, its correction and verification limits; the original audit remains preserved separately.

Sequence-example `do` headers use the same bold white structural scope as operation `do`; table values and bindings named `do` keep their ordinary identifier scope.

`token-colors.json` records the deliberate Canlang-only palette applied to both IDE user settings. Its selectors require `source.can`; they do not replace the editor theme or affect other languages. Given/When/Then are bold italic white; app/package/scenario/do/require/examples/page introducers remain bold white; other declaration/control keywords use purple, types teal, functions and operation uses pale yellow, bindings/identities and fields/keys share light blue, and literals use muted green. Frontend component introducers use `entity.name.tag.component.can` with conventional tag blue; page suites supply their presentation context, while guards remain keywords. Translation punctuation stays neutral in prose and quoted-string suffixes; bare and quoted locale keys share the key color. Scope-based coloring does not resolve an ambiguous imported/bare name.

Run focused verification with `node editors/vscode/check-highlighting.cjs` from the project. It uses the installed IDE TextMate/Oniguruma packages without adding extension dependencies. Set `VSCODE_RESOURCES` to another VS Code-compatible app’s `Contents/Resources/app` to check that engine. The corpus check recurses through all current draft/shared/example sources.

The palette follows the locally bundled Dark Modern/Dark+ scope mappings used for Rust, Go and TypeScript, retaining the existing Cursor and Antigravity themes. Categories and grammar scopes are unchanged. `PALETTE.md` records the reference mapping and before/after colors.

Version 0.1.6 follows the user-authorized Given spelling `invariant path: expr`. Version 0.1.7 scopes the Given introducer as `keyword.declaration.invariant.can`, using regular purple (`#C586C0`) and normal font style like derive/policy/lock/fixture; `require` remains the guard/gate spelling in When, Then and migration backfills. Both spellings retain ordinary name roles in fields, models, parameters, bindings and values. The section-aware source migration is `python3 tools/migrate_given_invariants.py` (dry-run by default; add `--apply` to write). Current grammar and parser support this sole Given spelling; historical audit snapshots retain their original inputs.

Version 0.1.9 highlights the entire approved 68-component vocabulary from `design/UI-COMPONENTS.md`, plus contextual `slot`, inline `preferences` and `gallery` headers. Component words remain ordinary field, member and value names outside presentation headers. Bare component leaves can precede a semicolon. The checker derives its coverage inventory from the approved catalog and verifies every component's scope and blue foreground, nested headers and name-role boundaries.

The local Cursor installation uses `../../output/editor/canlang-draft-highlighting-0.1.11-syntax.vsix`, a syntax-only package with the same extension identity and version. Its manifest omits the LSP entry point, activation events, build scripts and server configuration; it packages the grammar and documentation without requiring a `can` binary. The normal source manifest and full package retain the full LSP client described above. Reload the existing Cursor window after installing an updated VSIX. Highlighting does not certify parser/checker or runtime implementation of the components.

## Can file icons

Version 0.1.10 registers the approved Can logo for the `can` language (`.can` files), including Explorer, Quick Open and editor tabs. [Dark](images/file-icon-dark.svg) and [light](images/file-icon-light.svg) variants are generated from [images/logo.svg](images/logo.svg) by `bun run generate:icons`, also run during packaging. They use the IDE's color theme, independently of the operating system's preference. Version 0.1.11 nudges both file-icon variants 2px right within the nominal 16px icon slot; the master logo and extension tile retain their original placement.

The contribution uses VS Code's [language default icon support](https://code.visualstudio.com/api/extension-guides/file-icon-theme#language-default-icons). The built-in Seti file-icon theme displays it for `.can` files; themes that supply their own matching icon or disable language icons can override it. After installing the updated package, reload the CanLang IDE window to refresh the contribution.
