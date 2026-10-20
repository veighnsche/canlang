# Editor support

Install Can language support in VS Code or Cursor, connect the matching compiler, and verify diagnostics, completion and navigation against your local application workspace.

## Connect the language server

Install the editor extension supplied with the selected Can toolchain, open the application workspace, and let it start `can lsp` over standard input and output. The server loads the same source catalog and project context as the toolchain. In VS Code, set `can.serverPath` if the executable is not on PATH. Trust the workspace to start language tools; syntax highlighting remains available before trust. If the extension cannot find the executable or catalog, correct its installation/workspace configuration and run `Can: Restart Language Server`.

The language server is a source service. It does not start the app preview, deploy an app, run business examples, or perform code generation. Use `can dev ui` for the human preview and the commands in [builds and validation](../11-Verify-and-build/03-builds-and-validation.md) for artifact workflows.

## Work with diagnostics and completion

Diagnostics point to the declaration or use that violates a grammar, name, type, authority or effect rule. Completion is context-sensitive: available words depend on the current section and resolved declarations. A completion suggestion is not permission to expose a declaration publicly; use the owning source declaration and its access rules.

For a whole-app result, run `can check` on the selected application sources. Editor diagnostics can be incomplete while files are being edited or imports are unresolved. Compiler diagnostics remain authoritative for that invocation.

## Navigate and rename

Use definition/reference navigation to inspect where a resolved source name is owned and used. Rename should update the workspace references understood by the language server; review the diff afterward, especially imports, composed applications and text that is not a resolved identifier. Do not use text replacement as a substitute for a semantic rename.

The server is scoped to its workspace and loaded source revision. If it remains stale after a file change, restart the language server and rerun the compiler check. For generated implementation, follow [editing and refinement](../03-Generate-implementation/04-editing-and-refinement.md); changing a generated file does not rename or alter its owning `.can` declaration.

## Install in VS Code or Cursor

1. Install the [Can toolchain](03-installation.md) and verify `can --version` in a new terminal.
2. Obtain `canlang-vscode.vsix` from the matching release's editor bundle. In the editor's Extensions view, choose **… → Install from VSIX…**, select that file, then run **Developer: Reload Window**.
3. Open your application's folder, trust it if you intend to run its language tools, and open a `.can` file. The **Can** status item should become ready. Click it to inspect output or restart the server.

Alternatively, run one of these commands from the directory containing the downloaded VSIX:

```sh
code --install-extension canlang-vscode.vsix
```

```sh
cursor --install-extension canlang-vscode.vsix
```

Install the newer VSIX and reload to update. A `-syntax.vsix` package supplies highlighting only; it does not start a language server or expose its settings.

If the editor's PATH differs from your shell, set the executable path in workspace Settings:

```json
{
  "can.serverPath": "/absolute/path/to/can"
}
```

Replace the path with your installed executable, not a directory or the string `can lsp`. The extension adds `lsp` itself. Each local workspace folder has its own server and catalog; imports do not cross those folder boundaries. Keep a composed app's sources inside the same project folder.

## Verify language tools and recover startup

Open [VerifiedTasks.can](../examples/verified-tasks/VerifiedTasks.can). Hover over `Todo`, navigate from `task:Todo` to its declaration, and inspect completion inside a form. Temporarily change a use of `Todo` to `MissingTodo`: Problems should report the unresolved name. Undo the change and run `can check VerifiedTasks.can` from the application directory.

Syntax colors alone do not establish that the server is running. If the status is unavailable, inspect output, correct the executable/catalog configuration and run **Can: Restart Language Server**. Unsaved open documents take precedence over disk sources in editor analysis; CLI checking reads saved files. Save before comparing them. After a catalog change, restart the server rather than assuming it hot-reloaded.
