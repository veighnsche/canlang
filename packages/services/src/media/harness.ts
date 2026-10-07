/**
 * Controlled native ComfyUI endpoint for adapter tests. Spins up a
 * real `node:http` localhost server speaking the verified native
 * shapes (`POST /prompt`, `GET /history/{id}`, `GET /view`, `POST
 * /api/jobs/{id}/cancel`). Tests exercise the adapter through REAL
 * fetch; the fetch function itself is never stubbed.
 *
 * Scripted scenarios simulate DOCUMENTED provider behavior
 * (acceptance, validation failure, queued/missing entries, success
 * and error histories, byte serving, targeted cancel), not a live
 * ComfyUI server: they assert how the adapter substitutes, polls,
 * downloads and reconciles each outcome.
 */
import http from 'node:http';
import { readTextBody } from '../internal/controlled-http.js';
import type { Socket } from 'node:net';

export interface ControlledHistoryEntry {
  /** History `status` object, e.g. `{status_str, completed, messages?}`. */
  readonly status: unknown;
  /** History `outputs` object keyed by node id. */
  readonly outputs: unknown;
}

export type ControlledComfyScenario =
  | {
      readonly kind: 'accept';
      /** Entries served from history, keyed by prompt id. */
      readonly history?: Readonly<Record<string, ControlledHistoryEntry>>;
      /** Bytes served from /view, keyed by filename. */
      readonly files?: Readonly<Record<string, Uint8Array>>;
      /** Full /prompt response override (default: accept with the prompt id). */
      readonly promptBody?: unknown;
    }
  | {
      readonly kind: 'reject-prompt';
      readonly status: number;
      readonly body: unknown;
    }
  | {
      /** Records the prompt server-side but never responds to submit. */
      readonly kind: 'hang-submit';
      readonly history?: Readonly<Record<string, ControlledHistoryEntry>>;
      readonly files?: Readonly<Record<string, Uint8Array>>;
    }
  | { readonly kind: 'hang-all' };

export interface ControlledComfyRequestLog {
  readonly method: string;
  readonly path: string;
  readonly bodyText: string;
  /** Whether an Authorization header was present; the value is never logged. */
  readonly hadAuth: boolean;
}

export interface ControlledComfyServer {
  /** Base URL, e.g. `http://127.0.0.1:PORT`. */
  readonly url: string;
  /** Every request received, in order. */
  readonly requests: readonly ControlledComfyRequestLog[];
  /** Prompt ids recorded via submit, in order. */
  readonly prompts: readonly string[];
  close(): Promise<void>;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  const text = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function startControlledComfyServer(
  scenario: ControlledComfyScenario,
  opts?: { readonly cancelStatus?: number },
): Promise<ControlledComfyServer> {
  return new Promise((resolve, reject) => {
    const requests: ControlledComfyRequestLog[] = [];
    const prompts: string[] = [];
    const sockets = new Set<Socket>();
    const history =
      scenario.kind === 'accept' || scenario.kind === 'hang-submit'
        ? (scenario.history ?? {})
        : {};
    const files =
      scenario.kind === 'accept' || scenario.kind === 'hang-submit'
        ? (scenario.files ?? {})
        : {};

    const handle = async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): Promise<void> => {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      const rawPath = rawUrl.split('?')[0] as string;
      if (scenario.kind === 'hang-all') {
        return; // Never respond to anything.
      }
      if (method === 'POST' && rawPath === '/prompt') {
        const bodyText = await readTextBody(req);
        requests.push({
          method,
          path: rawPath,
          bodyText,
          hadAuth: req.headers['authorization'] !== undefined,
        });
        if (scenario.kind === 'reject-prompt') {
          sendJson(res, scenario.status, scenario.body);
          return;
        }
        let promptId = `server_${prompts.length + 1}`;
        try {
          const parsed = JSON.parse(bodyText) as Record<string, unknown>;
          if (
            typeof parsed['prompt_id'] === 'string' &&
            parsed['prompt_id'].length > 0
          ) {
            promptId = parsed['prompt_id'];
          }
        } catch {
          // Unparseable bodies are logged raw; the adapter is under test.
        }
        prompts.push(promptId);
        if (scenario.kind === 'hang-submit') {
          return; // Recorded, but the response is lost.
        }
        if (scenario.kind === 'accept' && scenario.promptBody !== undefined) {
          sendJson(res, 200, scenario.promptBody);
          return;
        }
        sendJson(res, 200, { prompt_id: promptId, number: prompts.length });
        return;
      }
      if (method === 'GET' && rawPath.startsWith('/history/')) {
        requests.push({
          method,
          path: rawPath,
          bodyText: '',
          hadAuth: req.headers['authorization'] !== undefined,
        });
        const id = decodeURIComponent(rawPath.slice('/history/'.length));
        const entry = history[id];
        if (entry === undefined) {
          sendJson(res, 200, {});
          return;
        }
        sendJson(res, 200, { [id]: entry });
        return;
      }
      if (method === 'GET' && rawPath === '/view') {
        requests.push({
          method,
          path: rawUrl,
          bodyText: '',
          hadAuth: req.headers['authorization'] !== undefined,
        });
        const params = new URL(rawUrl, 'http://localhost').searchParams;
        const filename = params.get('filename') ?? '';
        const bytes = files[filename];
        if (bytes === undefined) {
          sendJson(res, 404, { error: 'no such file' });
          return;
        }
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': bytes.length,
        });
        res.end(Buffer.from(bytes));
        return;
      }
      if (
        method === 'POST' &&
        rawPath.startsWith('/api/jobs/') &&
        rawPath.endsWith('/cancel')
      ) {
        const bodyText = await readTextBody(req);
        requests.push({
          method,
          path: rawPath,
          bodyText,
          hadAuth: req.headers['authorization'] !== undefined,
        });
        const status = opts?.cancelStatus ?? 200;
        if (status === 404) {
          sendJson(res, 404, { error: 'no such route' });
          return;
        }
        sendJson(res, status, { cancelled: status === 200 });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    };

    const server = http.createServer((req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { error: 'harness failure' });
          } catch {
            // Connection already gone.
          }
        }
      });
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('harness failed to bind an ephemeral port'));
        return;
      }
      const close = (): Promise<void> =>
        new Promise((resolveClose) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => {
            resolveClose();
          });
        });
      resolve({ url: `http://127.0.0.1:${address.port}`, requests, prompts, close });
    });
  });
}
