/**
 * Controlled System One endpoint for adapter tests. Spins up a real
 * `node:http` localhost server speaking the documented
 * `POST /v1/systemone` batch shape. Tests exercise the adapter
 * through REAL fetch; the fetch function itself is never stubbed.
 *
 * Scripted scenarios simulate DOCUMENTED provider behavior (batch
 * answers, validation/auth/rate-limit/overload errors, timeout,
 * invalid schema), not the remote service itself: they assert how
 * the adapter validates, maps and redacts each outcome.
 */
import http from 'node:http';
import { readTextBody, sendBody } from '../internal/controlled-http.js';
import type { Socket } from 'node:net';

export type ControlledSystemOneScenario =
  | { readonly kind: 'accept'; readonly body: unknown }
  | { readonly kind: 'reject'; readonly status: number; readonly body: unknown }
  | { readonly kind: 'hang' }
  | { readonly kind: 'invalid-schema'; readonly body: unknown };

export interface ControlledSystemOneRequestLog {
  readonly method: string;
  readonly path: string;
  /** Parsed `model` when the body is JSON, else null. */
  readonly model: string | null;
  /** Parsed question ids when the body is JSON, else null. */
  readonly questionIds: readonly string[] | null;
  readonly bodyText: string;
  /** Whether an Authorization header was present; the value is never logged. */
  readonly hadAuth: boolean;
}

export interface ControlledSystemOneServer {
  /** Base URL, e.g. `http://127.0.0.1:PORT`. */
  readonly url: string;
  /** Every POST received, in order. */
  readonly requests: readonly ControlledSystemOneRequestLog[];
  close(): Promise<void>;
}

export function startControlledSystemOneServer(
  scenario: ControlledSystemOneScenario,
): Promise<ControlledSystemOneServer> {
  return new Promise((resolve, reject) => {
    const requests: ControlledSystemOneRequestLog[] = [];
    const sockets = new Set<Socket>();

    const handle = async (
      req: http.IncomingMessage,
      res: http.ServerResponse,
    ): Promise<void> => {
      const method = req.method ?? 'GET';
      const rawPath = (req.url ?? '/').split('?')[0];
      if (method === 'POST' && rawPath === '/v1/systemone') {
        const bodyText = await readTextBody(req);
        let model: string | null = null;
        let questionIds: readonly string[] | null = null;
        try {
          const parsed = JSON.parse(bodyText) as Record<string, unknown>;
          if (typeof parsed['model'] === 'string') {
            model = parsed['model'];
          }
          const questions = parsed['questions'];
          if (
            typeof questions === 'object' &&
            questions !== null &&
            !Array.isArray(questions)
          ) {
            questionIds = Object.keys(questions);
          }
        } catch {
          // Unparseable bodies are logged raw; the adapter is under test.
        }
        requests.push({
          method,
          path: rawPath,
          model,
          questionIds,
          bodyText,
          hadAuth: req.headers['authorization'] !== undefined,
        });
        switch (scenario.kind) {
          case 'accept':
            sendBody(res, 200, scenario.body);
            return;
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
        close,
      });
    });
  });
}
