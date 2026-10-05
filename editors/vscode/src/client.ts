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
      toString(): string;
    }
    export namespace Uri {
      function parse(value: string): Uri;
    }
    export interface TextDocument {
      uri: Uri;
      languageId: string;
      version: number;
      getText(): string;
    }
    export interface TextDocumentChangeEvent {
      document: TextDocument;
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
      Text = 1,
      Method = 2,
      Function = 3,
      Constructor = 4,
      Field = 5,
      Variable = 6,
      Class = 7,
      Interface = 8,
      Module = 9,
      Property = 10,
      Unit = 11,
      Value = 12,
      Enum = 13,
      Keyword = 14,
      Snippet = 15,
      Color = 16,
      File = 17,
      Reference = 18,
      Folder = 19,
      EnumMember = 20,
      Constant = 21,
      Struct = 22,
      Event = 23,
      Operator = 24,
      TypeParameter = 25,
    }
    export class CompletionItem {
      constructor(label: string);
      label: string;
      kind?: CompletionItemKind;
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
    }
    export interface ConfigurationChangeEvent {
      affectsConfiguration(section: string): boolean;
    }
    export namespace workspace {
      const textDocuments: TextDocument[];
      function getConfiguration(section?: string): WorkspaceConfiguration;
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
      function createOutputChannel(name: string): OutputChannel;
      function showErrorMessage(message: string): void;
    }
    export namespace commands {
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
      function registerDocumentSemanticTokensProvider(
        selector: DocumentSelector,
        provider: DocumentSemanticTokensProvider,
        legend: SemanticTokensLegend,
      ): Disposable;
      function registerCodeActionProvider(
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
      kill(): void;
    }
    export function spawn(command: string, args: string[]): ChildProcess;
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
  /** Fired when the server process exits or fails to spawn. */
  onExit: ((code: number | null) => void) | null = null;

  private child: child_process.ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, (result: Json) => void>();
  private diagnostics: vscode.DiagnosticCollection | null = null;
  /** Raw `initialize` result (server capabilities + serverInfo), once known. */
  private capabilities: Json = null;
  private started = false;
  /** Child has exited or failed; the instance is spent, never reused. */
  private finished = false;
  /** Graceful `stop()` in flight; suppresses the `onExit` callback. */
  private stopping = false;

  constructor(
    private readonly serverPath: string,
    private readonly channel: vscode.OutputChannel,
    private readonly trace: boolean,
  ) {}

  /** True while the server child is attached and usable. */
  private isRunning(): boolean {
    return this.started && !this.finished && this.child !== null;
  }

  /** Spawn the server and complete the initialize handshake. */
  start(): Promise<void> {
    if (this.finished) {
      return Promise.reject(
        new Error('can lsp client is shut down; create a new CanLanguageClient'),
      );
    }
    if (this.started) {
      return Promise.resolve();
    }
    this.started = true;
    this.diagnostics = vscodeApi.languages.createDiagnosticCollection('can');
    let child: child_process.ChildProcess;
    try {
      child = childProcessApi.spawn(this.serverPath, ['lsp']);
    } catch (err) {
      this.started = false;
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
      // Dropped writes after death surface here; log instead of crashing
      // the host on an unhandled 'error'.
      child.stdin.on('error', (err: unknown) => {
        this.channel.appendLine(`can lsp stdin error: ${String(err)}`);
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
    return this.sendRequest('initialize', {
      processId: null,
      rootUri: null,
      capabilities: {
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
    }).then((result) => {
      this.capabilities = result;
      this.sendNotification('initialized', {});
    });
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
    return this.sendRequest(method, params);
  }

  /**
   * Shut the server down: `shutdown` request (2s timeout, then kill),
   * `exit` notification, then a 2s grace period before killing a server
   * that ignores `exit`.
   */
  stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.started = false;
    this.stopping = true;
    const dispose = (): void => {
      if (this.diagnostics) {
        this.diagnostics.dispose();
        this.diagnostics = null;
      }
      this.stopping = false;
    };
    if (!child || this.finished) {
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
    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const done = (kill: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.pending.delete(id);
        if (kill) {
          child.kill();
        }
        dispose();
        resolve();
      };
      timer = setTimeout(() => done(true), 2000);
      this.pending.set(id, () => {
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
    this.finished = true;
    this.child = null;
    this.started = false;
    this.failAllPending();
    if (this.diagnostics) {
      this.diagnostics.dispose();
      this.diagnostics = null;
    }
    if (!this.stopping && this.onExit) {
      this.onExit(code);
    }
  }

  didOpen(document: vscode.TextDocument): void {
    if (!this.isRunning()) {
      return;
    }
    this.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: document.uri.toString(),
        languageId: document.languageId,
        version: document.version,
        text: document.getText(),
      },
    });
  }

  didChange(document: vscode.TextDocument): void {
    if (!this.isRunning()) {
      return;
    }
    this.sendNotification('textDocument/didChange', {
      textDocument: {
        uri: document.uri.toString(),
        version: document.version,
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
    this.sendNotification('textDocument/didClose', {
      textDocument: { uri: document.uri.toString() },
    });
    if (this.diagnostics) {
      this.diagnostics.delete(document.uri);
    }
  }

  private sendRequest(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    if (!this.writeFrame(body)) {
      return Promise.reject(new Error(`can lsp is not running (request ${method})`));
    }
    return new Promise<Json>((resolve) => {
      this.pending.set(id, resolve);
    });
  }

  private sendNotification(method: string, params: Json): void {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    this.writeFrame(body);
  }

  private writeFrame(body: string): boolean {
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

  private onPublishDiagnostics(params: Json): void {
    if (!this.diagnostics || !isRecord(params)) {
      return;
    }
    const uri = params['uri'];
    const list = params['diagnostics'];
    if (typeof uri !== 'string' || !Array.isArray(list)) {
      return;
    }
    const converted: vscode.Diagnostic[] = [];
    for (const item of list) {
      if (!isRecord(item)) {
        continue;
      }
      const record = item as unknown as { [key: string]: unknown };
      const range = record['range'] as { start?: unknown; end?: unknown } | undefined;
      const message = record['message'];
      if (!range || typeof message !== 'string') {
        continue;
      }
      // Never let a malformed range throw inside the frame loop: drop and
      // log the item instead.
      if (!isValidPosition(range.start) || !isValidPosition(range.end)) {
        this.channel.appendLine(
          `dropping diagnostic with malformed range: ${JSON.stringify(record['range'])}`,
        );
        continue;
      }
      const severity = record['severity'];
      const code = record['code'];
      const source = record['source'];
      converted.push({
        range: new vscodeApi.Range(
          new vscodeApi.Position(range.start.line, range.start.character),
          new vscodeApi.Position(range.end.line, range.end.character),
        ),
        message,
        severity:
          severity === 1
            ? vscodeApi.DiagnosticSeverity.Error
            : severity === 2
              ? vscodeApi.DiagnosticSeverity.Warning
              : severity === 3
                ? vscodeApi.DiagnosticSeverity.Information
                : severity === 4
                  ? vscodeApi.DiagnosticSeverity.Hint
                  : undefined,
        code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
        source: typeof source === 'string' ? source : undefined,
      });
    }
    this.diagnostics.set(vscodeApi.Uri.parse(uri), converted);
  }

  /**
   * Settle every pending request with null. Note an async spawn failure
   * also lands here (via the 'error' handler), so the `initialize` request
   * resolves instead of rejecting and `start()` resolves too — harmless
   * because the user-visible failure still surfaces through `onExit`.
   */
  private failAllPending(): void {
    for (const resolve of this.pending.values()) {
      resolve(null);
    }
    this.pending.clear();
  }
}
