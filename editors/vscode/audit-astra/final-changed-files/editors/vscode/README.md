# Canlang draft syntax highlighting

A declarative VS Code-compatible extension for the current `.can` drafts in this project. `GRAMMAR.md` defines source spelling; `DESIGN.md` defines semantics. Those documents currently call the design v1. This extension follows their current content rather than assigning a new language version.

The extension contributes the `can` language, `source.can` TextMate scopes and one-space indentation defaults. It distinguishes full-line `##` comments, `#` description metadata, `#=` message references, JSON strings and `@{...}` localization. Declarations, Given/When/Then, type positions, effects, examples, routes, presentation and maintenance forms receive syntactic scopes. Field, parameter, attribute and member names remain names even when they match syntax words; builtin names are not globally reserved. Variable uses, properties and syntactic calls use standard `variable.other.readwrite`, `variable.other.property` and `entity.name.function.call` scopes so themes can distinguish them.

Highlighting approximates contextual syntax. It provides no language server, diagnostics, compiler integration, commands, snippets or runtime dependencies. It does not validate a program or consistency between drafts. Documented page polling/refresh, CSV form import and preference ordering are highlighted independently of prototype-parser coverage. Single/triple/raw strings, `//` and `/* */` comments, and old `fn` declarations have no special support.

The local artifact is `../../output/editor/canlang-draft-highlighting-0.1.2.vsix`. Install with the IDE's `--install-extension` CLI option. Remove `can-lang.can-lang` first, then reload existing IDE windows to unload the obsolete language server and load the new grammar. The separate `.ail` extension is unrelated.

The installed VSIX contains `package.json`, `syntaxes/can.tmLanguage.json` and this README, plus packaging metadata. It has no executable entry point. `GRAMMAR-AUDIT.md`, `check-highlighting.cjs` and `token-colors.json` are local review/verification assets and are excluded from the installed extension.

`token-colors.json` records the deliberate Canlang-only palette applied to both IDE user settings. Its selectors require `source.can`; they do not replace the editor theme or affect other languages. Given/When/Then share bold white; declaration/control keywords use muted cool gray, types cyan, functions and operation uses amber, bindings/identities blue, fields/keys lavender and literals pink. Scope-based coloring does not resolve an ambiguous imported/bare name.

Run focused verification with `node editors/vscode/check-highlighting.cjs` from the project. It uses the installed IDE TextMate/Oniguruma packages without adding extension dependencies. Set `VSCODE_RESOURCES` to another VS Code-compatible app’s `Contents/Resources/app` to check that engine. The corpus check recurses through all current draft/shared/example sources.
