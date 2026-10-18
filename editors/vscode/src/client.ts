/**
 * LSP stdio client for the `can` language server.
 *
 * Spawns `can lsp`, speaks Content-Length JSON-RPC over its stdio, forwards
 * open/change/save/close for `.can` documents, renders `publishDiagnostics`
 * into a VS Code diagnostic collection, and serves data requests
 * (hover, completion, definition, references, rename, semantic tokens,
 * code actions) for the providers registered in `extension.ts`.
 *
 * Lifecycle: one client instance serves one server process. When the child
 * dies unexpectedly the instance records `finished`, settles pending
 * requests, disposes the diagnostic collection (clearing stale entries)
 * and fires `onExit` exactly once; further `did*` calls are dropped and
 * writes are refused. Recovery is restart-on-reopen plus the
 * `can.restartServer` command: the extension creates a fresh instance
 * (see `extension.ts`).
 *
 * AMBIENT DECLARATIONS: the `declare global` block below declares the
 * minimal `vscode`/`child_process`/timer surface used here so
 * `tsc --strict` passes with zero npm dependencies (the lane-01 gate pins
 * empty typeRoots, so `@types/vscode`/`@types/node` cannot be used). Each
 * declaration mirrors the real VS Code API subset this client calls; if a
 * wider surface is ever needed, prefer extending this block over adopting
 * `vscode-languageclient`, which would break the zero-dependency gate.
 */

declare global {
  namespace vscode {
    export interface Disposable {
      dispose(): void;
    }
    export interface ExtensionContext {
      subscriptions: Disposable[];
    }
    export interface Uri {
      readonly scheme: string;
      readonly fsPath: string;
      toString(): string;
    }
    export namespace Uri {
      function parse(value: string): Uri;
    }
    export interface TextDocument {
      readonly isClosed: boolean;
      uri: Uri;
      languageId: string;
      version: number;
      getText(): string;
    }
    export interface TextDocumentChangeEvent {
      document: TextDocument;
    }
    export interface WorkspaceFolder {
      readonly uri: Uri;
      readonly name?: string;
    }
    export type Event<T> = (listener: (e: T) => void) => Disposable;
    export interface WorkspaceConfiguration {
      get<T>(key: string, defaultValue: T): T;
    }
    export enum DiagnosticSeverity {
      Error = 0,
      Warning = 1,
      Information = 2,
      Hint = 3,
    }
    export class Position {
      constructor(line: number, character: number);
      readonly line: number;
      readonly character: number;
    }
    export class Range {
      constructor(start: Position, end: Position);
      readonly start: Position;
      readonly end: Position;
    }
    export interface CancellationToken {
      readonly isCancellationRequested: boolean;
      onCancellationRequested: Event<void>;
    }
    export type ProviderResult<T> = T | undefined | null | Promise<T | undefined | null>;
    export interface DocumentFilter {
      language?: string;
      scheme?: string;
      pattern?: string;
    }
    export type DocumentSelector = string | DocumentFilter | Array<string | DocumentFilter>;
    export class MarkdownString {
      constructor(value?: string);
      value: string;
    }
    export class Hover {
      constructor(contents: MarkdownString | string);
      contents: MarkdownString | string;
    }
    export enum CompletionItemKind {
      Text = 0,
      Method = 1,
      Function = 2,
      Constructor = 3,
      Field = 4,
      Variable = 5,
      Class = 6,
      Interface = 7,
      Module = 8,
      Property = 9,
      Unit = 10,
      Value = 11,
      Enum = 12,
      Keyword = 13,
      Snippet = 14,
      Color = 15,
      File = 16,
      Reference = 17,
      Folder = 18,
      EnumMember = 19,
      Constant = 20,
      Struct = 21,
      Event = 22,
      Operator = 23,
      TypeParameter = 24,
    }
    export class CompletionItem {
      constructor(label: string);
      label: string;
      kind?: CompletionItemKind;
      detail?: string;
    }
    export class Location {
      constructor(uri: Uri, rangeOrPosition: Range | Position);
      uri: Uri;
      range: Range;
    }
    export class TextEdit {
      constructor(range: Range, newText: string);
      range: Range;
      newText: string;
    }
    export class WorkspaceEdit {
      set(uri: Uri, edits: TextEdit[]): void;
    }
    export class CodeActionKind {
      static readonly QuickFix: CodeActionKind;
    }
    export class CodeAction {
      constructor(title: string, kind?: CodeActionKind);
      title: string;
      kind?: CodeActionKind;
      edit?: WorkspaceEdit;
    }
    export interface CodeActionContext {
      diagnostics: Diagnostic[];
    }
    export interface ReferenceContext {
      includeDeclaration: boolean;
    }
    export class SemanticTokensLegend {
      constructor(tokenTypes: string[], tokenModifiers: string[]);
    }
    export class SemanticTokens {
      constructor(data: Uint32Array);
      readonly data: Uint32Array;
    }
    export interface HoverProvider {
      provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
      ): ProviderResult<Hover>;
    }
    export interface CompletionItemProvider {
      provideCompletionItems(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
      ): ProviderResult<CompletionItem[]>;
    }
    export interface DefinitionProvider {
      provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
      ): ProviderResult<Location | Location[]>;
    }
    export interface ReferenceProvider {
      provideReferences(
        document: TextDocument,
        position: Position,
        context: ReferenceContext,
        token: CancellationToken,
      ): ProviderResult<Location[]>;
    }
    export interface RenameProvider {
      provideRenameEdits(
        document: TextDocument,
        position: Position,
        newName: string,
        token: CancellationToken,
      ): ProviderResult<WorkspaceEdit>;
    }
    export enum SymbolKind {
      File, Module, Namespace, Package, Class, Method, Property, Field,
      Constructor, Enum, Interface, Function, Variable, Constant, String,
      Number, Boolean, Array, Object, Key, Null, EnumMember, Struct, Event,
      Operator, TypeParameter,
    }
    export class DocumentSymbol {
      constructor(name: string, detail: string, kind: SymbolKind, range: Range, selectionRange: Range);
      children: DocumentSymbol[];
    }
    export interface FormattingOptions {
      tabSize: number;
      insertSpaces: boolean;
    }
    export interface DocumentFormattingEditProvider {
      provideDocumentFormattingEdits(document: TextDocument, options: FormattingOptions,
        token: CancellationToken): ProviderResult<TextEdit[]>;
    }
    export interface DocumentSymbolProvider {
      provideDocumentSymbols(document: TextDocument, token: CancellationToken): ProviderResult<DocumentSymbol[]>;
    }
    export class FoldingRange {
      constructor(start: number, end: number);
    }
    export interface FoldingContext {}
    export interface FoldingRangeProvider {
      provideFoldingRanges(document: TextDocument, context: FoldingContext,
        token: CancellationToken): ProviderResult<FoldingRange[]>;
    }
    export class SelectionRange {
      constructor(range: Range, parent?: SelectionRange);
      range: Range;
      parent?: SelectionRange;
    }
    export interface SelectionRangeProvider {
      provideSelectionRanges(document: TextDocument, positions: readonly Position[],
        token: CancellationToken): ProviderResult<SelectionRange[]>;
    }
    export interface DocumentSemanticTokensProvider {
      provideDocumentSemanticTokens(
        document: TextDocument,
        token: CancellationToken,
      ): ProviderResult<SemanticTokens>;
    }
    export interface CodeActionProvider {
      provideCodeActions(
        document: TextDocument,
        range: Range,
        context: CodeActionContext,
        token: CancellationToken,
      ): ProviderResult<CodeAction[]>;
    }
    export interface Diagnostic {
      range: Range;
      message: string;
      severity?: DiagnosticSeverity;
      code?: string | number;
      source?: string;
    }
    export interface DiagnosticCollection extends Disposable {
      set(uri: Uri, diagnostics: Diagnostic[] | undefined): void;
      delete(uri: Uri): void;
    }
    export interface OutputChannel extends Disposable {
      appendLine(value: string): void;
      show(preserveFocus?: boolean): void;
    }
    export enum StatusBarAlignment { Left = 1, Right = 2 }
    export interface StatusBarItem extends Disposable {
      text: string;
      tooltip?: string;
      command?: string;
      show(): void;
      hide(): void;
    }
    export interface FileSystemWatcher extends Disposable {
      onDidCreate(listener: (uri: Uri) => void): Disposable;
      onDidChange(listener: (uri: Uri) => void): Disposable;
      onDidDelete(listener: (uri: Uri) => void): Disposable;
    }
    export interface WorkspaceFoldersChangeEvent {
      added: readonly WorkspaceFolder[];
      removed: readonly WorkspaceFolder[];
    }
    export interface ConfigurationChangeEvent {
      affectsConfiguration(section: string): boolean;
    }
    export namespace workspace {
      const isTrusted: boolean;
      function onDidGrantWorkspaceTrust(listener: () => void): Disposable;
      const textDocuments: TextDocument[];
      const workspaceFolders: readonly WorkspaceFolder[] | undefined;
      function getWorkspaceFolder(uri: Uri): WorkspaceFolder | undefined;
      function getConfiguration(section?: string, scope?: Uri): WorkspaceConfiguration;
      function openTextDocument(uri: Uri): Promise<TextDocument>;
      function createFileSystemWatcher(pattern: string): FileSystemWatcher;
      function onDidChangeWorkspaceFolders(listener: (event: WorkspaceFoldersChangeEvent) => void): Disposable;
      function onDidOpenTextDocument(listener: (doc: TextDocument) => void): Disposable;
      function onDidChangeTextDocument(
        listener: (event: TextDocumentChangeEvent) => void,
      ): Disposable;
      function onDidCloseTextDocument(listener: (doc: TextDocument) => void): Disposable;
      function onDidSaveTextDocument(listener: (doc: TextDocument) => void): Disposable;
      function onDidChangeConfiguration(
        listener: (event: ConfigurationChangeEvent) => void,
      ): Disposable;
    }
    export namespace window {
      const activeTextEditor: { readonly document: TextDocument } | undefined;
      function onDidChangeActiveTextEditor(listener: () => void): Disposable;
      function createStatusBarItem(alignment: StatusBarAlignment, priority?: number): StatusBarItem;
      function createOutputChannel(name: string): OutputChannel;
      function showErrorMessage(message: string): void;
      function showQuickPick(items: string[], options?: { placeHolder?: string }): Promise<string | undefined>;
    }
    export namespace commands {
      function executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
      function registerCommand(
        command: string,
        callback: (...args: unknown[]) => unknown,
      ): Disposable;
    }
    export namespace languages {
      function createDiagnosticCollection(name: string): DiagnosticCollection;
      function registerHoverProvider(
        selector: DocumentSelector,
        provider: HoverProvider,
      ): Disposable;
      function registerCompletionItemProvider(
        selector: DocumentSelector,
        provider: CompletionItemProvider,
        ...triggerCharacters: string[]
      ): Disposable;
      function registerDefinitionProvider(
        selector: DocumentSelector,
        provider: DefinitionProvider,
      ): Disposable;
      function registerReferenceProvider(
        selector: DocumentSelector,
        provider: ReferenceProvider,
      ): Disposable;
      function registerRenameProvider(
        selector: DocumentSelector,
        provider: RenameProvider,
      ): Disposable;
      function registerDocumentFormattingEditProvider(
        selector: DocumentSelector, provider: DocumentFormattingEditProvider,
      ): Disposable;
      function registerDocumentSymbolProvider(
        selector: DocumentSelector, provider: DocumentSymbolProvider,
      ): Disposable;
      function registerFoldingRangeProvider(
        selector: DocumentSelector, provider: FoldingRangeProvider,
      ): Disposable;
      function registerSelectionRangeProvider(
        selector: DocumentSelector, provider: SelectionRangeProvider,
      ): Disposable;
      function registerDocumentSemanticTokensProvider(
        selector: DocumentSelector,
        provider: DocumentSemanticTokensProvider,
        legend: SemanticTokensLegend,
      ): Disposable;
      function registerCodeActionsProvider(
        selector: DocumentSelector,
        provider: CodeActionProvider,
        metadata?: { providedCodeActionKinds?: CodeActionKind[] },
      ): Disposable;
    }
  }

  namespace child_process {
    export interface StdioPipe {
      setEncoding(encoding: string): void;
      on(event: 'data', listener: (chunk: string) => void): void;
      on(event: string, listener: (...args: unknown[]) => void): void;
      write(data: string): void;
      end(): void;
    }
    export interface ChildProcess {
      stdin: StdioPipe | null;
      stdout: StdioPipe | null;
      stderr: StdioPipe | null;
      on(event: string, listener: (...args: unknown[]) => void): void;
      kill(signal?: string): void;
    }
    export function spawn(
      command: string,
      args: string[],
      options?: { cwd?: string },
    ): ChildProcess;
  }

  function require(id: 'vscode'): typeof vscode;
  function require(id: 'child_process'): typeof child_process;
  // Node globals (lib es2022 has no DOM/node types).
  function setTimeout(callback: () => void, ms: number): unknown;
  function clearTimeout(handle: unknown): void;
}

const vscodeApi = require('vscode');
const childProcessApi = require('child_process');

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RpcMessage {
  id?: number | string | null;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string };
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspDiagnostic {
  range: { start: LspPosition; end: LspPosition };
  severity?: number;
  code?: string | number;
  message: string;
  source?: string;
}

/** UTF-8 byte length without TextEncoder/Buffer (dependency-free). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function isRecord(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Semantic-token legend the client declares in `initialize` and registers
 * with the semantic-tokens provider. Must match the server's advertised
 * legend exactly; single source of truth is `TOKEN_TYPES`/`TOKEN_MODIFIERS`
 * in `compiler/src/ide/tokens.rs`. `test/lsp-capabilities.cjs` asserts the
 * live `initialize` result carries this same legend, so drift fails loudly.
 */
export const CAN_SEMANTIC_TOKEN_TYPES: string[] = [
  'namespace',
  'type',
  'class',
  'interface',
  'enum',
  'struct',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'keyword',
  'comment',
  'string',
  'number',
  'operator',
];

/** Modifier legend; source of truth as above (bit order matters). */
export const CAN_SEMANTIC_TOKEN_MODIFIERS: string[] = [
  'declaration',
  'documentation',
  'defaultLibrary',
  'readonly',
];

/** True for a wire position `vscode.Position` accepts (else it throws). */
function isValidPosition(value: unknown): value is LspPosition {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as { line?: unknown; character?: unknown };
  return (
    Number.isSafeInteger(record.line) &&
    (record.line as number) >= 0 &&
    Number.isSafeInteger(record.character) &&
    (record.character as number) >= 0
  );
}

function vsSeverity(severity: Json): vscode.DiagnosticSeverity | undefined {
  return severity === 1
    ? vscodeApi.DiagnosticSeverity.Error
    : severity === 2
      ? vscodeApi.DiagnosticSeverity.Warning
      : severity === 3
        ? vscodeApi.DiagnosticSeverity.Information
        : severity === 4
          ? vscodeApi.DiagnosticSeverity.Hint
          : undefined;
}

/**
 * Convert one wire diagnostic item. Returns null to drop the item; reports
 * a malformed range through `logMalformed` instead of throwing inside the
 * frame loop.
 */
function toVsDiagnostic(
  item: Json,
  logMalformed: (range: unknown) => void,
): vscode.Diagnostic | null {
  if (!isRecord(item)) {
    return null;
  }
  const range = item['range'] as { start?: unknown; end?: unknown } | undefined;
  const message = item['message'];
  if (!range || typeof message !== 'string') {
    return null;
  }
  // Never let a malformed range throw inside the frame loop: drop and
  // log the item instead.
  if (!isValidPosition(range.start) || !isValidPosition(range.end)) {
    logMalformed(item['range']);
    return null;
  }
  const code = item['code'];
  const source = item['source'];
  return {
    range: new vscodeApi.Range(
      new vscodeApi.Position(range.start.line, range.start.character),
      new vscodeApi.Position(range.end.line, range.end.character),
    ),
    message,
    severity: vsSeverity(item['severity']),
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    source: typeof source === 'string' ? source : undefined,
  };
}

/**
 * Take the leading `length` UTF-8 bytes of `text` (a JS string is UTF-16
 * units, so byte counting must walk scalars, not `slice` by length).
 * Returns null when the prefix is incomplete or the boundary would split
 * a scalar (caller waits for more data).
 */
function takeUtf8Prefix(text: string, length: number): string | null {
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    if (bytes === length) {
      return text.slice(0, i);
    }
    const code = text.charCodeAt(i);
    let charBytes: number;
    let units = 1;
    if (code < 0x80) {
      charBytes = 1;
    } else if (code < 0x800) {
      charBytes = 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        charBytes = 4;
        units = 2;
      } else {
        charBytes = 3;
      }
    } else {
      charBytes = 3;
    }
    if (bytes + charBytes > length) {
      return null;
    }
    bytes += charBytes;
    i += units;
  }
  return bytes === length ? text : null;
}

/** Thin wrapper around a `can lsp` stdio child process. */
export class CanLanguageClient {
  /** Fired once when an initialized server dies; startup failures reject start(). */
  onExit: ((code: number | null) => void) | null = null;

  private child: child_process.ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (result: Json) => void>();
  private diagnostics: vscode.DiagnosticCollection | null = null;
  /** One owner per live revision; wire versions also distinguish reopen epochs. */
  private readonly documents = new Map<string, {
    document: vscode.TextDocument;
    version: number;
    wireVersion: number;
  }>();
  private nextDocumentVersion = 1;
  /** Raw `initialize` result (server capabilities + serverInfo), once known. */
  private capabilities: Json = null;
  private ready = false;
  private startup: Promise<void> | null = null;
  private shutdown: Promise<void> | null = null;
  private stopped: (() => void) | null = null;
  /** Child has exited or failed; the instance is spent, never reused. */
  private finished = false;
  /** Graceful `stop()` in flight; suppresses the `onExit` callback. */
  private stopping = false;

  constructor(
    private readonly serverPath: string,
    private readonly channel: vscode.OutputChannel,
    private readonly trace: boolean,
    private readonly cwd?: string,
    private readonly rootUri?: string,
    private readonly workspaceRoots?: readonly string[],
  ) {}

  /** True while the server child is attached and usable. */
  private isRunning(): boolean {
    return this.ready && !this.finished && this.child !== null;
  }

  /** Spawn the server and complete the initialize handshake. */
  start(): Promise<void> {
    if (this.finished || this.stopping) {
      return Promise.reject(
        new Error('can lsp client is shut down; create a new CanLanguageClient'),
      );
    }
    if (this.startup) {
      return this.startup;
    }
    this.diagnostics = vscodeApi.languages.createDiagnosticCollection('can');
    let child: child_process.ChildProcess;
    try {
      child = childProcessApi.spawn(this.serverPath, ['lsp'], { cwd: this.cwd });
    } catch (err) {
      this.finished = true;
      if (this.diagnostics) {
        this.diagnostics.dispose();
        this.diagnostics = null;
      }
      return Promise.reject(
        new Error(`could not spawn '${this.serverPath} lsp': ${String(err)}`),
      );
    }
    this.child = child;
    if (child.stdin) {
      // A broken transport cannot serve pending work. Retire it without
      // leaving an unhandled stream error in the extension host.
      child.stdin.on('error', (err: unknown) => {
        this.channel.appendLine(`can lsp stdin error: ${String(err)}`);
        this.finish(null);
        child.kill('SIGKILL');
      });
    }
    if (child.stdout) {
      // utf8 string mode: Node reassembles multibyte chars split across chunks.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.onData(chunk));
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => this.channel.appendLine(chunk));
    }
    child.on('error', (err: unknown) => {
      this.channel.appendLine(`can lsp process error: ${String(err)}`);
      // 'error' is usually followed by 'exit'; finish() is once-guarded.
      this.finish(null);
    });
    child.on('exit', (code: unknown) => {
      this.finish(typeof code === 'number' ? code : null);
    });
    const initialized = this.sendRequest('initialize', {
      processId: null,
      rootUri: this.rootUri ?? null,
      workspaceFolders: this.rootUri ? (this.workspaceRoots ?? [this.rootUri])
        .map((uri) => ({ uri, name: uri })) : null,
      capabilities: {
        workspace: { workspaceEdit: { documentChanges: true } },
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { versionSupport: true },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          completion: { completionItem: { documentationFormat: ['markdown', 'plaintext'] } },
          definition: { linkSupport: false },
          references: {},
          rename: { prepareSupport: false },
          semanticTokens: {
            formats: ['relative'],
            requests: { full: true },
            tokenTypes: [...CAN_SEMANTIC_TOKEN_TYPES],
            tokenModifiers: [...CAN_SEMANTIC_TOKEN_MODIFIERS],
          },
          codeAction: {
            codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } },
          },
        },
      },
    });
    let timer: unknown;
    this.startup = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('can lsp initialize timed out after 10 seconds'));
      }, 10000);
      initialized.then((result) => {
        if (this.finished || this.stopping || !isRecord(result) ||
            !isRecord(result['capabilities'])) {
          reject(new Error('can lsp initialize failed'));
          return;
        }
        this.capabilities = result;
        if (!this.writeFrame(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }))) {
          reject(new Error('can lsp initialized write failed'));
          return;
        }
        if (this.finished) {
          reject(new Error('can lsp initialized write failed'));
          return;
        }
        this.ready = true;
        resolve();
      }, reject);
    }).catch((reason: unknown) => {
      clearTimeout(timer);
      if (!this.finished && !this.stopping) {
        this.finish(null);
        child.kill('SIGKILL');
      }
      throw reason;
    });
    this.startup.then(() => clearTimeout(timer), () => clearTimeout(timer));
    return this.startup;
  }

  /** Raw `initialize` result (`{ capabilities, serverInfo }`); null before. */
  serverCapabilities(): Json {
    return this.capabilities;
  }

  /**
   * Send a data request (hover, completion, definition, references, rename,
   * semantic tokens, code actions) to the server. Rejects when the server
   * is not running; resolves null when the child died mid-flight (callers
   * treat null as "no result").
   */
  request(method: string, params: Json): Promise<Json> {
    return this.isRunning() ? this.sendRequest(method, params) :
      Promise.reject(new Error(`can lsp is not ready (request ${method})`));
  }

  /** All providers share document lifetime, revision and cancellation checks. */
  requestDocument<T>(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
    method: string,
    params: Json,
    convert: (result: Json) => T,
  ): Promise<T | undefined> {
    if (!this.isRunning() && this.startup && !this.finished && !this.stopping) {
      const version = document.version;
      return new Promise<T | undefined>((resolve) => {
        let cancellation: vscode.Disposable | undefined;
        let settled = false;
        const complete = (value: T | undefined): void => {
          if (settled) { return; }
          settled = true;
          cancellation?.dispose();
          resolve(value);
        };
        cancellation = token.onCancellationRequested(() => complete(undefined));
        if (settled) { cancellation.dispose(); }
        if (token.isCancellationRequested) { complete(undefined); }
        this.startup!.then(() => {
          if (settled || token.isCancellationRequested || document.isClosed ||
              document.version !== version || !this.isRunning()) {
            complete(undefined);
            return;
          }
          cancellation?.dispose();
          cancellation = undefined;
          // The extension's startup replay may already have synchronized it.
          if (!this.documents.has(document.uri.toString())) { this.didOpen(document); }
          this.requestDocument(document, token, method, params, convert).then(complete, () => complete(undefined));
        }, () => complete(undefined));
      });
    }
    const uri = document.uri.toString();
    const owner = this.documents.get(uri);
    if (!owner || owner.document !== document || owner.version !== document.version ||
        token.isCancellationRequested) {
      return Promise.resolve(undefined);
    }
    return this.sendRequest(method, params, token).then((result) =>
      this.isRunning() && !token.isCancellationRequested &&
      this.documents.get(uri) === owner && document.version === owner.version
        ? convert(result) : undefined);
  }

  /** Check edit targets against the same revision owner used by diagnostics. */
  isDocumentVersion(uri: string, wireVersion: Json): boolean {
    const owner = this.documents.get(uri);
    return !!owner && owner.document.version === owner.version &&
      (wireVersion === null || wireVersion === owner.wireVersion);
  }

  private ownDocument(document: vscode.TextDocument): number {
    const wireVersion = Math.max(this.nextDocumentVersion, document.version);
    this.nextDocumentVersion = wireVersion + 1;
    this.documents.set(document.uri.toString(), {
      document, version: document.version, wireVersion,
    });
    return wireVersion;
  }

  /**
   * Shut the server down: `shutdown` request (2s timeout, then kill),
   * `exit` notification, then a 2s grace period before killing a server
   * that ignores `exit`.
   */
  stop(): Promise<void> {
    if (this.shutdown) {
      return this.shutdown;
    }
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.documents.clear();
    this.stopping = true;
    // Ordinary work loses admission immediately, independently of the
    // child's shutdown acknowledgement or exit deadline.
    this.failAllPending();
    const dispose = (): void => {
      if (this.diagnostics) {
        this.diagnostics.dispose();
        this.diagnostics = null;
      }
      this.stopping = false;
    };
    if (!child || this.finished) {
      this.finish(null);
      dispose();
      return Promise.resolve();
    }
    // `this.child` is detached so new traffic stops at once; the frames
    // below go to the captured child directly.
    const writeRaw = (body: string): boolean => {
      const stdin = child.stdin;
      if (!stdin) {
        return false;
      }
      try {
        stdin.write(`Content-Length: ${utf8Length(body)}\r\n\r\n${body}`);
        return true;
      } catch {
        return false;
      }
    };
    const id = this.nextId++;
    this.shutdown = new Promise<void>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const done = (kill: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        this.stopped = null;
        if (kill) {
          child.kill('SIGKILL');
        }
        this.finish(null);
        dispose();
        resolve();
      };
      this.stopped = () => done(false);
      timer = setTimeout(() => done(true), 2000);
      this.pending.set(id, () => {
        if (settled || this.finished) { return; }
        writeRaw(JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null }));
        if (child.stdin) {
          try {
            child.stdin.end();
          } catch {
            // Already dead; the exit handler settles everything.
          }
        }
        // Give the server a beat to exit on its own; kill stragglers.
        clearTimeout(timer);
        timer = setTimeout(() => done(!this.finished), 2000);
      });
      if (!writeRaw(JSON.stringify({ jsonrpc: '2.0', id, method: 'shutdown', params: null }))) {
        done(true);
      }
    });
    return this.shutdown;
  }

  /**
   * Record child death: settle pending requests, drop the dead child so
   * no further writes are attempted, dispose the diagnostic collection
   * (clearing stale entries) and notify once. Safe to call from both the
   * 'error' and 'exit' handlers; the second call is a no-op.
   */
  private finish(code: number | null): void {
    if (this.finished) {
      return;
    }
    const wasReady = this.ready;
    this.finished = true;
    this.ready = false;
    this.child = null;
    this.documents.clear();
    this.failAllPending();
    if (this.diagnostics) {
      this.diagnostics.dispose();
      this.diagnostics = null;
    }
    if (wasReady && !this.stopping && this.onExit) {
      this.onExit(code);
    }
    this.stopped?.();
  }

  didChangeWatchedFiles(uri: vscode.Uri, type: number): void {
    if (!this.isRunning()) { return; }
    if (!this.documents.has(uri.toString())) { this.diagnostics?.delete(uri); }
    this.sendNotification('workspace/didChangeWatchedFiles', {
      changes: [{ uri: uri.toString(), type }],
    });
  }

  didOpen(document: vscode.TextDocument): void {
    if (!this.isRunning()) {
      return;
    }
    const version = this.ownDocument(document);
    this.diagnostics?.delete(document.uri);
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: document.uri.toString(),
        languageId: document.languageId,
        version,
        text: document.getText(),
      },
    });
  }

  didChange(document: vscode.TextDocument): void {
    if (!this.isRunning()) {
      return;
    }
    const version = this.ownDocument(document);
    this.sendNotification('textDocument/didChange', {
      textDocument: {
        uri: document.uri.toString(),
        version,
      },
      contentChanges: [{ text: document.getText() }],
    });
  }

  didSave(document: vscode.TextDocument): void {
    if (!this.isRunning()) {
      return;
    }
    this.sendNotification('textDocument/didSave', {
      textDocument: { uri: document.uri.toString() },
    });
  }

  didClose(document: vscode.TextDocument): void {
    if (!this.isRunning()) {
      return;
    }
    this.documents.delete(document.uri.toString());
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri: document.uri.toString() },
    });
    if (this.diagnostics) {
      this.diagnostics.delete(document.uri);
    }
  }

  private sendRequest(
    method: string,
    params: Json,
    token?: vscode.CancellationToken,
  ): Promise<Json> {
    if (token?.isCancellationRequested) {
      return Promise.resolve(null);
    }
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise<Json>((resolve, reject) => {
      let cancellation: vscode.Disposable | undefined;
      let deadline: unknown;
      const settle = (result: Json): void => {
        this.pending.delete(id);
        clearTimeout(deadline);
        cancellation?.dispose();
        resolve(result);
      };
      this.pending.set(id, settle);
      if (!this.writeFrame(body, id)) {
        this.pending.delete(id);
        reject(new Error(`can lsp is not running (request ${method})`));
        return;
      }
      // Initialize has its own startup deadline; ordinary requests must also
      // finish when a live process stops responding.
      if (method !== 'initialize' && this.pending.has(id)) {
        deadline = setTimeout(() => {
          if (!this.pending.has(id)) { return; }
          this.channel.appendLine(`can lsp request '${method}' timed out after 10 seconds`);
          this.sendNotification('$/cancelRequest', { id });
          settle(null);
        }, 10000);
      }
      const cancel = (): void => {
        if (this.pending.has(id)) {
          this.sendNotification('$/cancelRequest', { id });
          settle(null);
        }
      };
      cancellation = token?.onCancellationRequested(cancel);
      if (token?.isCancellationRequested) {
        cancel();
      }
      if (!this.pending.has(id)) {
        cancellation?.dispose();
      }
    });
  }

  private sendNotification(method: string, params: Json): void {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.writeFrame(body);
  }

  private writeFrame(body: string, failedRequestId?: number): boolean {
    if (this.trace) {
      this.channel.appendLine(`--> ${body}`);
    }
    if (this.finished) {
      return false;
    }
    const stdin = this.child && this.child.stdin;
    if (!stdin) {
      return false;
    }
    try {
      stdin.write(`Content-Length: ${utf8Length(body)}\r\n\r\n${body}`);
    } catch (err) {
      this.channel.appendLine(`can lsp write failed: ${String(err)}`);
      // A failed write never establishes the revision we just attempted
      // to publish. Retire its transport and every document owner rather
      // than allowing queries/edits against unsent text. The initiating
      // request rejects below; other pending requests settle as no result.
      if (failedRequestId !== undefined) {
        this.pending.delete(failedRequestId);
      }
      const child = this.child;
      this.finish(null);
      child?.kill('SIGKILL');
      return false;
    }
    return true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd);
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Unframed garbage: drop through the header and keep serving.
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length > 64 * 1024 * 1024) {
        this.channel.appendLine(`dropping oversized LSP frame (${match[1]} bytes)`);
        // Skip exactly the bad frame so pipelined valid messages after it
        // survive; when its body has not fully arrived the boundary is
        // unknowable, so the buffered prefix is dropped instead.
        const frame = this.buffer.slice(headerEnd + 4);
        const oversized = takeUtf8Prefix(frame, length);
        if (oversized === null) {
          this.buffer = '';
          return;
        }
        this.buffer = frame.slice(oversized.length);
        continue;
      }
      const frame = this.buffer.slice(headerEnd + 4);
      const body = takeUtf8Prefix(frame, length);
      if (body === null) {
        return;
      }
      this.buffer = frame.slice(body.length);
      if (this.trace) {
        this.channel.appendLine(`<-- ${body}`);
      }
      let message: RpcMessage;
      try {
        message = JSON.parse(body) as RpcMessage;
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: RpcMessage): void {
    if (message.id !== undefined && message.id !== null && !message.method) {
      const resolve = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
      if (resolve) {
        this.pending.delete(message.id as number);
        resolve(message.result === undefined ? null : message.result);
      }
      return;
    }
    if (message.method === 'textDocument/publishDiagnostics') {
      this.onPublishDiagnostics(message.params === undefined ? null : message.params);
    } else if (message.method === 'window/showMessage' || message.method === 'window/logMessage') {
      this.channel.appendLine(JSON.stringify(message.params === undefined ? null : message.params));
    } else if (message.id !== undefined && message.id !== null) {
      // Server-to-client request we do not serve: MethodNotFound.
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `unknown method '${message.method}'` },
      });
      this.writeFrame(body);
    }
  }

  /** Closed publications follow ordinary workspace file notifications. Open
   * overlays retain strict wire-version ownership, including reopen epochs. */
  private isClosedWorkspaceUri(uri: string): boolean {
    if (!this.rootUri || this.documents.has(uri) ||
        vscodeApi.workspace.textDocuments.some((document: vscode.TextDocument) => document.uri.toString() === uri)) {
      return false;
    }
    try {
      const target = vscodeApi.Uri.parse(uri);
      if (target.scheme !== 'file') { return false; }
      const normalize = (path: string): string => path.replace(/\\/g, '/').replace(/\/$/, '');
      const targetPath = normalize(target.fsPath);
      const ownerPath = normalize(vscodeApi.Uri.parse(this.rootUri).fsPath);
      const roots = (this.workspaceRoots ?? [this.rootUri]).map((root) =>
        normalize(vscodeApi.Uri.parse(root).fsPath));
      const owner = roots.filter((root) => targetPath.startsWith(`${root}/`))
        .sort((left, right) => right.length - left.length)[0];
      return owner === ownerPath;
    } catch {
      return false;
    }
  }

  private onPublishDiagnostics(params: Json): void {
    if (!this.diagnostics || !isRecord(params)) {
      return;
    }
    const uri = params['uri'];
    const list = params['diagnostics'];
    if (typeof uri !== 'string' || !Array.isArray(list)) { return; }
    const version = params['version'];
    if (typeof version === 'number' ? !this.isDocumentVersion(uri, version) :
        (version !== undefined && version !== null) || !this.isClosedWorkspaceUri(uri)) {
      return;
    }
    const converted: vscode.Diagnostic[] = [];
    for (const item of list) {
      const diagnostic = toVsDiagnostic(item, (range) => {
        this.channel.appendLine(
          `dropping diagnostic with malformed range: ${JSON.stringify(range)}`,
        );
      });
      if (diagnostic !== null) {
        converted.push(diagnostic);
      }
    }
    this.diagnostics.set(vscodeApi.Uri.parse(uri), converted);
  }

  /**
   * Settle every pending request with null. Startup treats null as failure;
   * already initialized providers treat it as no result.
   */
  private failAllPending(): void {
    for (const resolve of this.pending.values()) {
      resolve(null);
    }
    this.pending.clear();
  }
}
