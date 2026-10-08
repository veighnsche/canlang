# ED-R07 supported editor closure

The original requirement in `docs/research/compiler-library-audit-20261006/responsibility-map/editor.md`
is an explicit supported document/root/catalog lifetime and comparison with CLI
and actual consumers. It does not select a workspace engine or promise its
implementation. This packet retains the existing behavior and makes its limits
visible in the shipped compiler and extension documentation.

`compiler/src/ide/queries.rs::Snapshot::analyze` checks/resolves exactly its
requested source. `compiler/src/lsp/server.rs::RealAnalysis` delegates document
queries to that snapshot and captures its catalog in `from_process`.
`compiler/src/cli.rs::CatalogAnalyzer` passes the supplied sources together to
the checker. Opening both files in the editor therefore does not create CLI's
checked program. No advertised server workspace-folder capability or existing
project-reference API was found. Generic navigation/refactoring feature bullets
in the extension README remain, with their document scope now explicit.

`editors/vscode/src/extension.ts::startClient` selects the starting Can
document's owning local folder, falling back to the first local folder.
The extension starts one client and replays all open Can documents to it.
`client.ts::start` passes that cwd to the child, sends `rootUri:null` without
workspace folders, and supplies no catalog watcher. Restart stops the child and
selects cwd again from the active document. `RealAnalysis::from_process` reads
`CAN_CATALOG` before relative catalog candidates; it has no reload path.

Reused direct results: the original valid joint CLI check resolves package
exports/imports, while the same two open LSP files yield E2005 and empty
cross-file definition (`editor-evidence/cross-file-cli-check.stdout` and
`cross-file-server.stdout`). Original catalog sessions demonstrate shared roots,
ignored watched/configuration/folder reload notifications, and fresh-process
reload (`catalog-invalidation.stdout`, `catalog-restart.stdout`). Existing
`editors/vscode/test/server-startup.cjs` qualifies extension cwd selection with
host/child stand-ins. These results are reused for unchanged behavior, not
claimed as freshly executed here.

Executed missing comparison: `catalog-client.cjs` uses freshly compiled exported
client code, actual `can lsp` children and isolated catalogs, comparing one
session across two document roots with separate CLI invocations and client
stop/start after catalog mutation. Its VS Code diagnostic collection is a host
stand-in. Private strict TypeScript compilation succeeded, and both direct
comparison assertions passed: each root's CLI invocation sees its own catalog;
both client documents see the startup cwd catalog; changing that catalog changes
fresh CLI results while the live client retains it; restarting the client sees
the changed catalog. An initial observer-only failure compared a VM-realm array
with a host array; converting its observed diagnostic codes through host
`Array.from` corrected that assertion. No production behavior changed.

Commands (repository cwd):

```sh
mkdir -p implementation/compiler-completion/editor-project-scope/empty
node node_modules/.bun/typescript@5.9.3/node_modules/typescript/lib/tsc.js --strict --target es2022 --module commonjs --lib es2022 --typeRoots implementation/compiler-completion/editor-project-scope/empty --outDir implementation/compiler-completion/editor-project-scope/out --rootDir editors/vscode/src editors/vscode/src/client.ts
node implementation/compiler-completion/editor-project-scope/catalog-client.cjs implementation/compiler-completion/editor-project-scope/out /Users/vince/Projects/canlang/compiler/target/debug/can
```

The generated private client output is disposable and is not a second source
implementation.

Still open: project-wide/unopened-file definition, references and rename;
coordinated multi-root catalogs; automatic reload; actual GUI and installed
extension behavior. These are not relabeled as implemented or retired by the
documentation change. No workspace support policy or framework is selected.
