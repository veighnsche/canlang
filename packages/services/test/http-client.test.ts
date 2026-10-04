/**
 * S4: typed fetch wrapper over REAL fetch against localhost harness
 * servers. Covers transport classification, same-endpoint redirect
 * policy, timeout, and the bounded body cap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { httpRequest } from '../src/http/client.ts';
import type { HttpClientConfig } from '../src/http/client.ts';
import {
  HttpBodyLimitError,
  HttpRedirectError,
  HttpTooManyRedirectsError,
  HttpTransportError,
} from '../src/http/errors.ts';
import { startControlledMailServer } from '../src/ports.ts';
import type {
  ControlledMailServer,
  ControlledScenario,
} from '../src/ports.ts';

function configFor(server: ControlledMailServer): HttpClientConfig {
  return { baseUrl: server.url, timeoutMs: 5000, maxBodyBytes: 1_000_000 };
}

async function withServer<T>(
  scenario: ControlledScenario,
  run: (server: ControlledMailServer) => Promise<T>,
): Promise<T> {
  const server = await startControlledMailServer(scenario);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

describe('http client', () => {
  it('posts JSON and returns the bounded response', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const response = await httpRequest(configFor(server), {
        method: 'POST',
        path: '/send',
        body: JSON.stringify({ to: 'a@example.test' }),
        idempotencyKey: 'del_1',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.bodyText), {
        reference: 'mail_1',
      });
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]?.idempotencyKey, 'del_1');
    });
  });

  it('follows same-origin redirects', async () => {
    await withServer(
      { kind: 'redirect', status: 307, location: '/send-final' },
      async (server) => {
        const response = await httpRequest(configFor(server), {
          method: 'POST',
          path: '/send',
          body: '{"to":"a@example.test"}',
          idempotencyKey: 'del_1',
        });
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.bodyText), {
          reference: 'mail_1',
        });
        // 307 preserves method, path chain, body and idempotency key.
        assert.equal(server.requests.length, 2);
        assert.equal(server.requests[1]?.method, 'POST');
        assert.equal(server.requests[1]?.path, '/send-final');
        assert.equal(
          server.requests[1]?.bodyText,
          '{"to":"a@example.test"}',
        );
        assert.equal(server.requests[1]?.idempotencyKey, 'del_1');
      },
    );
  });

  it('converts same-origin 302 POST to GET', async () => {
    await withServer(
      { kind: 'redirect', status: 302, location: '/send-final' },
      async (server) => {
        const response = await httpRequest(configFor(server), {
          method: 'POST',
          path: '/send',
          body: '{}',
        });
        assert.equal(response.status, 200);
        assert.deepEqual(JSON.parse(response.bodyText), {
          reference: 'mail_get',
        });
        // Only the initial POST was logged; the follow-up was a GET.
        assert.equal(server.requests.length, 1);
      },
    );
  });

  it('fails loudly on same-origin redirect loops', async () => {
    await withServer(
      { kind: 'redirect', status: 307, location: '/send' },
      async (server) => {
        await assert.rejects(
          httpRequest(configFor(server), {
            method: 'POST',
            path: '/send',
            body: '{}',
          }),
          HttpTooManyRedirectsError,
        );
        assert.ok(server.requests.length <= 6);
      },
    );
  });

  it('refuses cross-origin redirects with a typed error', async () => {
    await withServer({ kind: 'accept' }, async (other) => {
      await withServer(
        { kind: 'redirect', status: 302, location: `${other.url}/send` },
        async (server) => {
          await assert.rejects(
            httpRequest(configFor(server), {
              method: 'POST',
              path: '/send',
              body: '{}',
            }),
            (err: unknown) => {
              assert.ok(err instanceof HttpRedirectError);
              assert.equal(
                err.fromOrigin,
                new URL(server.url).origin,
              );
              assert.equal(err.toOrigin, new URL(other.url).origin);
              assert.notEqual(err.fromOrigin, err.toOrigin);
              return true;
            },
          );
          // Refused BEFORE following: the foreign server saw nothing.
          assert.equal(other.requests.length, 0);
        },
      );
    });
  });

  it('maps a hung response to a timeout transport error', async () => {
    await withServer(
      { kind: 'hang', reconcile: 'accepted' },
      async (server) => {
        const config = configFor(server);
        await assert.rejects(
          httpRequest({ ...config, timeoutMs: 50 }, {
            method: 'POST',
            path: '/send',
            body: '{}',
          }),
          (err: unknown) => {
            assert.ok(err instanceof HttpTransportError);
            assert.equal(err.kind, 'timeout');
            return true;
          },
        );
      },
    );
  });

  it('times out a dripping body under the same deadline', async () => {
    await withServer({ kind: 'drip', delayMs: 5000 }, async (server) => {
      const config = configFor(server);
      await assert.rejects(
        httpRequest({ ...config, timeoutMs: 50 }, {
          method: 'POST',
          path: '/send',
          body: '{}',
        }),
        (err: unknown) => {
          assert.ok(err instanceof HttpTransportError);
          assert.equal(err.kind, 'timeout');
          return true;
        },
      );
    });
    await withServer({ kind: 'drip', delayMs: 20 }, async (server) => {
      const response = await httpRequest(configFor(server), {
        method: 'POST',
        path: '/send',
        body: '{}',
      });
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(response.bodyText), {
        reference: 'mail_drip',
      });
    });
  });

  it('maps a refused connection to a network transport error', async () => {
    const server = await startControlledMailServer({ kind: 'accept' });
    const url = server.url;
    await server.close();
    await assert.rejects(
      httpRequest(
        { baseUrl: url, timeoutMs: 2000, maxBodyBytes: 1000 },
        { method: 'GET', path: '/deliveries/del_1' },
      ),
      (err: unknown) => {
        assert.ok(err instanceof HttpTransportError);
        assert.equal(err.kind, 'network-error');
        return true;
      },
    );
  });

  it('rejects oversized bodies instead of truncating', async () => {
    await withServer(
      { kind: 'invalid-schema', body: `{"pad":"${'x'.repeat(2000)}"}` },
      async (server) => {
        await assert.rejects(
          httpRequest(
            { ...configFor(server), maxBodyBytes: 100 },
            { method: 'POST', path: '/send', body: '{}' },
          ),
          (err: unknown) => {
            assert.ok(err instanceof HttpBodyLimitError);
            assert.equal(err.maxBytes, 100);
            assert.equal(err.status, 200);
            return true;
          },
        );
      },
    );
  });

  it('rejects off-base paths and invalid config', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      await assert.rejects(
        httpRequest(configFor(server), {
          method: 'GET',
          path: 'http://127.0.0.1:1/elsewhere',
        }),
        TypeError,
      );
      await assert.rejects(
        httpRequest(
          { baseUrl: 'not-a-url', timeoutMs: 100, maxBodyBytes: 100 },
          { method: 'GET', path: '/' },
        ),
        TypeError,
      );
      await assert.rejects(
        httpRequest(
          { ...configFor(server), timeoutMs: 0 },
          { method: 'GET', path: '/' },
        ),
        RangeError,
      );
      await assert.rejects(
        httpRequest(
          { ...configFor(server), maxBodyBytes: -1 },
          { method: 'GET', path: '/' },
        ),
        RangeError,
      );
    });
  });
});
