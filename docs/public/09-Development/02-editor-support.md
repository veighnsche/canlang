# Editor support

Connect an editor to Can's language server for source-aware diagnostics, completion, navigation and safe workspace edits.

## Connect the language server

Install the editor extension supplied with the selected Can toolchain, open the application workspace, and let it start `can lsp` over standard input and output. The server loads the same source catalog and project context as the toolchain. In VS Code, set `can.serverPath` if the executable is not on PATH. Trust the workspace to start language tools; syntax highlighting remains available before trust. If the extension cannot find the executable or catalog, correct its installation/workspace configuration and run `Can: Restart Language Server`.

The language server is a source service. It does not start the app preview, deploy an app, run business examples, or perform code generation. Use `can dev ui` for the human preview and the commands in [builds and validation](./06-builds-and-validation.md) for artifact workflows.

## Work with diagnostics and completion

Diagnostics point to the declaration or use that violates a grammar, name, type, authority or effect rule. Completion is context-sensitive: available words depend on the current section and resolved declarations. A completion suggestion is not permission to expose a declaration publicly; use the owning source declaration and its access rules.

For a whole-app result, run `can check` on the selected application sources. Editor diagnostics can be incomplete while files are being edited or imports are unresolved. Compiler diagnostics remain authoritative for that invocation.

## Navigate and rename

Use definition/reference navigation to inspect where a resolved source name is owned and used. Rename should update the workspace references understood by the language server; review the diff afterward, especially imports, composed applications and text that is not a resolved identifier. Do not use text replacement as a substitute for a semantic rename.

The server is scoped to its workspace and loaded source revision. If it remains stale after a file change, restart the language server and rerun the compiler check. For generated implementation, follow [editing and refinement](../08-Code-generation/04-editing-and-refinement.md); changing a generated file does not rename or alter its owning `.can` declaration.
