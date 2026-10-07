/**
 * Controlled Ollama endpoint for adapter tests. Spins up a real
 * `node:http` localhost server speaking documented `POST /api/chat`
 * shapes (single JSON for `stream:false`, NDJSON for streams).
 * Tests exercise the adapter through REAL fetch; the fetch function
 * itself is never stubbed.
 *
 * Scripted scenarios simulate DOCUMENTED provider behavior (final
 * reply, progressive deltas, mid-stream error, reject, timeout,
 * invalid schema), not a live Ollama server: they assert how the
 * adapter classifies, maps and isolates each outcome.
 */
import http from 'node:http';
import { readTextBody, sendBody } from '../internal/controlled-http.js';
import type { Socket } from 'node:net';

export type ControlledOllamaScenario =
  | { readonly kind: 'final'; readonly body: unknown }
  | {
      readonly kind: 'stream';
      /** NDJSON line payloads, each served as one line. */
      readonly lines: readonly unknown[];
      /** Delay in ms between lines; 0 writes the whole stream at once. */
      readonly lineDelayMs?: number;
    }
  | { readonly kind: 'reject'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hang' }
  | { readonly kind: 'invalid-schema'; readonly body: unknown };

export interface ControlledOllamaRequestLog {
  readonly method: string;
  readonly path: string;
  /** Parsed `stream` flag when the body is JSON, else null. */
  readonly stream: boolean | null;
  /** Parsed `model` when the body is JSON, else null. */
  readonly model: string | null;
  readonly bodyText: string;
  /** Whether an Authorization header was present; the value is never logged. */
  readonly hadAuth: boolean;
}

export interface ControlledOllamaServer {
  /** Base URL, e.g. `http://127.0.0.1:PORT`. */
  readonly url: string;
  /** Every POST received, in order. */
  readonly requests: readonly ControlledOllamaRequestLog[];
  /** Currently open TCP connections; drops when the client hangs up. */
  activeConnections(): number;
  close(): Promise<void>;
}

export function startControlledOllamaServer(
  scenario: ControlledOllamaScenario,
): Promise<ControlledOllamaServer> {
  return new Promise((resolve, reject) => {
    const requests: ControlledOllamaRequestLog[] = [];
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();

    const handle = async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): Promise<void> => {
      const method = req.method ?? 'GET';
      const rawPath = (req.url ?? '/').split('?')[0];
      if (method === 'POST' && rawPath === '/api/chat') {
        const bodyText = await readTextBody(req);
        let stream: boolean | null = null;
        let model: string | null = null;
        try {
          const parsed = JSON.parse(bodyText) as Record<string, unknown>;
          if (typeof parsed['stream'] === 'boolean') {
            stream = parsed['stream'];
          }
          if (typeof parsed['model'] === 'string') {
            model = parsed['model'];
          }
        } catch {
          // Unparseable bodies are logged raw; the adapter is under test.
        }
        requests.push({
          method,
          path: rawPath,
          stream,
          model,
          bodyText,
          hadAuth: req.headers['authorization'] !== undefined,
        });
        switch (scenario.kind) {
          case 'final':
            sendBody(res, 200, scenario.body);
            return;
          case 'stream': {
            res.writeHead(200, {
              'content-type': 'application/x-ndjson',
            });
            const delay = scenario.lineDelayMs ?? 0;
            let index = 0;
            const writeNext = (): void => {
              if (res.destroyed) {
                return;
              }
              if (index >= scenario.lines.length) {
                res.end();
                return;
              }
              const line = scenario.lines[index];
              index += 1;
              res.write(
                typeof line === 'string' ? line : JSON.stringify(line),
              );
              res.write('\n');
              if (delay > 0) {
                const timer = setTimeout(() => {
                  timers.delete(timer);
                  writeNext();
                }, delay);
                timers.add(timer);
              } else {
                writeNext();
              }
            };
            writeNext();
            return;
          }
          case 'reject':
            sendBody(res, scenario.status, scenario.body);
            return;
          case 'hang':
            return; // Never respond; the client must time out.
          case 'invalid-schema':
            sendBody(res, 200, scenario.body);
            return;
        }
      }
      sendBody(res, 404, { error: 'not found' });
    };

    const server = http.createServer((req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) {
          try {
            sendBody(res, 500, { error: 'harness failure' });
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
          for (const timer of timers) {
            clearTimeout(timer);
          }
          timers.clear();
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close(() => {
            resolveClose();
          });
        });
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        activeConnections: () => sockets.size,
        close,
      });
    });
  });
}
