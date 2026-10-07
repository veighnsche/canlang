"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CanLanguageClient = exports.CAN_SEMANTIC_TOKEN_MODIFIERS = exports.CAN_SEMANTIC_TOKEN_TYPES = void 0;
exports.isRecord = isRecord;
const vscodeApi = require('vscode');
const childProcessApi = require('child_process');
/** UTF-8 byte length without TextEncoder/Buffer (dependency-free). */
function utf8Length(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        }
        else if (code < 0x800) {
            bytes += 2;
        }
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                i++;
            }
            else {
                bytes += 3;
            }
        }
        else {
            bytes += 3;
        }
    }
    return bytes;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * Semantic-token legend the client declares in `initialize` and registers
 * with the semantic-tokens provider. Must match the server's advertised
 * legend exactly; single source of truth is `TOKEN_TYPES`/`TOKEN_MODIFIERS`
 * in `compiler/src/ide/tokens.rs`. `test/lsp-capabilities.cjs` asserts the
 * live `initialize` result carries this same legend, so drift fails loudly.
 */
exports.CAN_SEMANTIC_TOKEN_TYPES = [
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
exports.CAN_SEMANTIC_TOKEN_MODIFIERS = [
    'declaration',
    'documentation',
    'defaultLibrary',
    'readonly',
];
/** True for a wire position `vscode.Position` accepts (else it throws). */
function isValidPosition(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const record = value;
    return (Number.isSafeInteger(record.line) &&
        record.line >= 0 &&
        Number.isSafeInteger(record.character) &&
        record.character >= 0);
}
/**
 * Take the leading `length` UTF-8 bytes of `text` (a JS string is UTF-16
 * units, so byte counting must walk scalars, not `slice` by length).
 * Returns null when the prefix is incomplete or the boundary would split
 * a scalar (caller waits for more data).
 */
function takeUtf8Prefix(text, length) {
    let bytes = 0;
    let i = 0;
    while (i < text.length) {
        if (bytes === length) {
            return text.slice(0, i);
        }
        const code = text.charCodeAt(i);
        let charBytes;
        let units = 1;
        if (code < 0x80) {
            charBytes = 1;
        }
        else if (code < 0x800) {
            charBytes = 2;
        }
        else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                charBytes = 4;
                units = 2;
            }
            else {
                charBytes = 3;
            }
        }
        else {
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
class CanLanguageClient {
    serverPath;
    channel;
    trace;
    cwd;
    /** Fired once when an initialized server dies; startup failures reject start(). */
    onExit = null;
    child = null;
    buffer = '';
    nextId = 1;
    pending = new Map();
    diagnostics = null;
    /** One owner per live revision; wire versions also distinguish reopen epochs. */
    documents = new Map();
    nextDocumentVersion = 1;
    /** Raw `initialize` result (server capabilities + serverInfo), once known. */
    capabilities = null;
    ready = false;
    startup = null;
    shutdown = null;
    stopped = null;
    /** Child has exited or failed; the instance is spent, never reused. */
    finished = false;
    /** Graceful `stop()` in flight; suppresses the `onExit` callback. */
    stopping = false;
    constructor(serverPath, channel, trace, cwd) {
        this.serverPath = serverPath;
        this.channel = channel;
        this.trace = trace;
        this.cwd = cwd;
    }
    /** True while the server child is attached and usable. */
    isRunning() {
        return this.ready && !this.finished && this.child !== null;
    }
    /** Spawn the server and complete the initialize handshake. */
    start() {
        if (this.finished || this.stopping) {
            return Promise.reject(new Error('can lsp client is shut down; create a new CanLanguageClient'));
        }
        if (this.startup) {
            return this.startup;
        }
        this.diagnostics = vscodeApi.languages.createDiagnosticCollection('can');
        let child;
        try {
            child = childProcessApi.spawn(this.serverPath, ['lsp'], { cwd: this.cwd });
        }
        catch (err) {
            this.finished = true;
            if (this.diagnostics) {
                this.diagnostics.dispose();
                this.diagnostics = null;
            }
            return Promise.reject(new Error(`could not spawn '${this.serverPath} lsp': ${String(err)}`));
        }
        this.child = child;
        if (child.stdin) {
            // A broken transport cannot serve pending work. Retire it without
            // leaving an unhandled stream error in the extension host.
            child.stdin.on('error', (err) => {
                this.channel.appendLine(`can lsp stdin error: ${String(err)}`);
                this.finish(null);
                child.kill('SIGKILL');
            });
        }
        if (child.stdout) {
            // utf8 string mode: Node reassembles multibyte chars split across chunks.
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this.onData(chunk));
        }
        if (child.stderr) {
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => this.channel.appendLine(chunk));
        }
        child.on('error', (err) => {
            this.channel.appendLine(`can lsp process error: ${String(err)}`);
            // 'error' is usually followed by 'exit'; finish() is once-guarded.
            this.finish(null);
        });
        child.on('exit', (code) => {
            this.finish(typeof code === 'number' ? code : null);
        });
        const initialized = this.sendRequest('initialize', {
            processId: null,
            rootUri: null,
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
                        tokenTypes: [...exports.CAN_SEMANTIC_TOKEN_TYPES],
                        tokenModifiers: [...exports.CAN_SEMANTIC_TOKEN_MODIFIERS],
                    },
                    codeAction: {
                        codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } },
                    },
                },
            },
        });
        let timer;
        this.startup = new Promise((resolve, reject) => {
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
        }).catch((reason) => {
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
    serverCapabilities() {
        return this.capabilities;
    }
    /**
     * Send a data request (hover, completion, definition, references, rename,
     * semantic tokens, code actions) to the server. Rejects when the server
     * is not running; resolves null when the child died mid-flight (callers
     * treat null as "no result").
     */
    request(method, params) {
        return this.isRunning() ? this.sendRequest(method, params) :
            Promise.reject(new Error(`can lsp is not ready (request ${method})`));
    }
    /** All providers share document lifetime, revision and cancellation checks. */
    requestDocument(document, token, method, params, convert) {
        const uri = document.uri.toString();
        const owner = this.documents.get(uri);
        if (!owner || owner.document !== document || owner.version !== document.version ||
            token.isCancellationRequested) {
            return Promise.resolve(undefined);
        }
        return this.sendRequest(method, params, token).then((result) => this.isRunning() && !token.isCancellationRequested &&
            this.documents.get(uri) === owner && document.version === owner.version
            ? convert(result) : undefined);
    }
    /** Check edit targets against the same revision owner used by diagnostics. */
    isDocumentVersion(uri, wireVersion) {
        const owner = this.documents.get(uri);
        return !!owner && owner.document.version === owner.version &&
            (wireVersion === null || wireVersion === owner.wireVersion);
    }
    ownDocument(document) {
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
    stop() {
        if (this.shutdown) {
            return this.shutdown;
        }
        const child = this.child;
        this.child = null;
        this.ready = false;
        this.documents.clear();
        this.stopping = true;
        const dispose = () => {
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
        const writeRaw = (body) => {
            const stdin = child.stdin;
            if (!stdin) {
                return false;
            }
            try {
                stdin.write(`Content-Length: ${utf8Length(body)}\r\n\r\n${body}`);
                return true;
            }
            catch {
                return false;
            }
        };
        const id = this.nextId++;
        this.shutdown = new Promise((resolve) => {
            let settled = false;
            let timer = null;
            const done = (kill) => {
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
                if (settled || this.finished) {
                    return;
                }
                writeRaw(JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null }));
                if (child.stdin) {
                    try {
                        child.stdin.end();
                    }
                    catch {
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
    finish(code) {
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
    didOpen(document) {
        if (!this.isRunning()) {
            return;
        }
        const version = this.ownDocument(document);
        this.sendNotification('textDocument/didOpen', {
            textDocument: {
                uri: document.uri.toString(),
                languageId: document.languageId,
                version,
                text: document.getText(),
            },
        });
    }
    didChange(document) {
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
    didSave(document) {
        if (!this.isRunning()) {
            return;
        }
        this.sendNotification('textDocument/didSave', {
            textDocument: { uri: document.uri.toString() },
        });
    }
    didClose(document) {
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
    sendRequest(method, params, token) {
        if (token?.isCancellationRequested) {
            return Promise.resolve(null);
        }
        const id = this.nextId++;
        const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
        return new Promise((resolve, reject) => {
            let cancellation;
            const settle = (result) => {
                this.pending.delete(id);
                cancellation?.dispose();
                resolve(result);
            };
            this.pending.set(id, settle);
            if (!this.writeFrame(body)) {
                this.pending.delete(id);
                reject(new Error(`can lsp is not running (request ${method})`));
                return;
            }
            const cancel = () => {
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
    sendNotification(method, params) {
        const body = JSON.stringify({ jsonrpc: '2.0', method, params });
        this.writeFrame(body);
    }
    writeFrame(body) {
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
        }
        catch (err) {
            this.channel.appendLine(`can lsp write failed: ${String(err)}`);
            return false;
        }
        return true;
    }
    onData(chunk) {
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
            let message;
            try {
                message = JSON.parse(body);
            }
            catch {
                continue;
            }
            this.onMessage(message);
        }
    }
    onMessage(message) {
        if (message.id !== undefined && message.id !== null && !message.method) {
            const resolve = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
            if (resolve) {
                this.pending.delete(message.id);
                resolve(message.result === undefined ? null : message.result);
            }
            return;
        }
        if (message.method === 'textDocument/publishDiagnostics') {
            this.onPublishDiagnostics(message.params === undefined ? null : message.params);
        }
        else if (message.method === 'window/showMessage' || message.method === 'window/logMessage') {
            this.channel.appendLine(JSON.stringify(message.params === undefined ? null : message.params));
        }
        else if (message.id !== undefined && message.id !== null) {
            // Server-to-client request we do not serve: MethodNotFound.
            const body = JSON.stringify({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: `unknown method '${message.method}'` },
            });
            this.writeFrame(body);
        }
    }
    onPublishDiagnostics(params) {
        if (!this.diagnostics || !isRecord(params)) {
            return;
        }
        const uri = params['uri'];
        const list = params['diagnostics'];
        if (typeof uri !== 'string' || !Array.isArray(list) ||
            typeof params['version'] !== 'number' || !this.isDocumentVersion(uri, params['version'])) {
            return;
        }
        const converted = [];
        for (const item of list) {
            if (!isRecord(item)) {
                continue;
            }
            const record = item;
            const range = record['range'];
            const message = record['message'];
            if (!range || typeof message !== 'string') {
                continue;
            }
            // Never let a malformed range throw inside the frame loop: drop and
            // log the item instead.
            if (!isValidPosition(range.start) || !isValidPosition(range.end)) {
                this.channel.appendLine(`dropping diagnostic with malformed range: ${JSON.stringify(record['range'])}`);
                continue;
            }
            const severity = record['severity'];
            const code = record['code'];
            const source = record['source'];
            converted.push({
                range: new vscodeApi.Range(new vscodeApi.Position(range.start.line, range.start.character), new vscodeApi.Position(range.end.line, range.end.character)),
                message,
                severity: severity === 1
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
     * Settle every pending request with null. Startup treats null as failure;
     * already initialized providers treat it as no result.
     */
    failAllPending() {
        for (const resolve of this.pending.values()) {
            resolve(null);
        }
        this.pending.clear();
    }
}
exports.CanLanguageClient = CanLanguageClient;
