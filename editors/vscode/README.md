# Canlang for VS Code and Cursor

Edit `.can` files with syntax highlighting, language tools, and Can file icons. The extension supports VS Code 1.91 or newer and compatible editors such as Cursor.

## Features

- **Syntax highlighting** for Given / When / Then, declarations, types, operations, pages, examples, and localization. `##` comments and `#` descriptions have distinct highlighting.
- **Diagnostics** in the editor and Problems panel as you edit.
- **Completion and hover information** to help you explore symbols and types.
- **Navigation and refactoring** through Go to Definition, Find All References, and Rename Symbol.
- **Semantic highlighting and quick fixes** supplied by the Can language server.
- **Can file icons** with light and dark variants, plus one-space indentation defaults for `.can` files.

Syntax highlighting, icons, and indentation work without the compiler. Diagnostics and the other language tools require the `can` compiler, installed separately.

## Install

1. Get the extension's `.vsix` file. The [release workflow](https://github.com/veighnsche/canlang/actions/workflows/release.yml) produces an `editor-bundle` artifact containing `canlang-vscode.vsix`; download and extract it from a successful run. If you already have a locally built VSIX, use that file.
2. Open the Extensions view in VS Code or Cursor, open its **…** menu, and choose **Install from VSIX…**. Select the file.
3. Run **Developer: Reload Window** from the Command Palette, then open a `.can` file.

You can also install from a terminal:

```sh
# VS Code
code --install-extension canlang-vscode.vsix

# Cursor
cursor --install-extension canlang-vscode.vsix
```

Use the path to your downloaded file if it has a different name or location. To update, install the newer VSIX and reload the window.

If you only want syntax highlighting, use a package whose name ends in `-syntax.vsix`, when available. That variant includes highlighting, icons, and indentation, and does not start a language server or provide its settings and restart command.

## Set up language tools

Install the `can` compiler using the [installation guide](https://github.com/veighnsche/canlang/blob/main/docs/install.md). The extension looks for `can` on your editor's `PATH` and starts the language server when you open a `.can` file.

If the compiler is installed elsewhere, set **Can: Server Path** in Settings to the full path of the executable. For example, in `settings.json`:

```json
{
  "can.serverPath": "/absolute/path/to/can"
}
```

Point this setting at the executable itself; the extension adds the `lsp` argument. After setup, open a `.can` file, hover over a symbol, or use your editor's completion and navigation commands. Available quick fixes appear through the editor's lightbulb menu.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `can.serverPath` | `can` | Compiler executable to use for language tools. |
| `can.traceServer` | `false` | Log language-server traffic to the **Can** output channel for troubleshooting. |

Changing either setting restarts the language server. You can also run **Can: Restart Language Server** from the Command Palette.

## Troubleshooting

**Highlighting or language tools are missing.** Check the language mode in the status bar: it should be **Canlang**. Ensure the extension is enabled and reload the window after installing an update. If you have the older `can-lang.can-lang` extension installed, uninstall it to avoid conflicts.

**The language server cannot start or has stopped.** Check that `can --version` works and that `can.serverPath` points to the correct executable. If your terminal finds `can` but the editor cannot, set its full path explicitly. Open the Output panel and select **Can** for details, then run **Can: Restart Language Server**. A syntax-only package provides no diagnostics or language tools.

**Colors or icons differ from the examples you have seen.** Highlighting follows your editor theme. File-icon themes can override the Can icon; the built-in Seti theme displays it.

The extension follows the current Canlang draft syntax. Highlighting alone does not check a program; compiler diagnostics provide validation. See the [language grammar](https://github.com/veighnsche/canlang/blob/main/docs/specification/GRAMMAR.md) and [example applications](https://github.com/veighnsche/canlang/tree/main/examples) for source examples.
