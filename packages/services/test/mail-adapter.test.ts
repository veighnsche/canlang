/**
 * S4: EmailV1 adapter over REAL fetch against localhost harness
 * servers. Covers the acceptance receipt, rejection mapping, timeout
 * to unknown + reconcile through the original identity, pre-send
 * transport-limit rejection with the frozen request intact, invalid
 * provider schemas, transient retry, and redirect refusal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EmailV1Adapter,
  MailAttachmentError,
  MailTransportLimitError,
  assertValidCompletion,
  skippedCompletion,
} from '../src/mail/adapter.js';
import {
  fixedAttachmentSizes,
  fixedClock,
  startControlledMailServer,
} from '../src/ports.js';
import type {
  ControlledMailServer,
  ControlledScenario,
} from '../src/ports.js';
import type {
  CapabilityCompletion,
  EmailAccepted,
  EmailSendInput,
} from '@canlang/contracts';

const CLOCK_NOW = 1_758_000_000_000;

function makeAdapter(
  baseUrl: string,
  opts?: {
    timeoutMs?: number;
    maxTransportBytes?: number | null;
    maxBodyBytes?: number;
    sizes?: Record<string, number>;
    authorization?: string;
  },
): EmailV1Adapter {
  return new EmailV1Adapter({
    baseUrl,
    timeoutMs: opts?.timeoutMs ?? 5000,
    maxBodyBytes: opts?.maxBodyBytes ?? 1_000_000,
    maxTransportBytes: opts?.maxTransportBytes ?? 10_000_000,
    ...(opts?.authorization === undefined
      ? {}
      : { authorization: opts.authorization }),
    clock: fixedClock(CLOCK_NOW),
    sizes: fixedAttachmentSizes(
      opts?.sizes ?? { file_a: 1000, file_b: 2000 },
    ),
  });
}

function inputFor(over: Partial<EmailSendInput> = {}): EmailSendInput {
  return {
    to: 'reviewer@example.test',
    subject: 'Review',
    body: 'Plan',
    attachments: [],
    ...over,
  };
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

describe('EmailV1 adapter', () => {
  it('returns the acceptance receipt on provider accept', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.send(inputFor({ attachments: ['file_a'] }), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.delivery_id, 'del_1');
      assert.equal(completion.status, 'succeeded');
      assert.deepEqual(completion.result, { reference: 'mail_1' });
      assert.equal(completion.error, null);
      assert.deepEqual(Object.keys(completion).sort(), [
        'delivery_id',
        'error',
        'result',
        'status',
      ]);
      assert.equal(server.requests.length, 1);
      const logged = server.requests[0];
      assert.equal(logged?.idempotencyKey, 'del_1');
      assert.deepEqual(JSON.parse(logged?.bodyText ?? ''), {
        delivery_id: 'del_1',
        to: 'reviewer@example.test',
        subject: 'Review',
        body: 'Plan',
        attachments: ['file_a'],
      });
    });
  });

  it('maps provider rejection to failed with a closed error', async () => {
    await withServer(
      { kind: 'reject', status: 400, body: { error: 'No mailbox here' } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.delivery_id, 'del_1');
        assert.equal(completion.status, 'failed');
        assert.equal(completion.result, null);
        assert.deepEqual(completion.error, {
          code: 'provider_rejected',
          message: 'No mailbox here',
        });
        assert.deepEqual(Object.keys(completion.error ?? {}).sort(), [
          'code',
          'message',
        ]);
      },
    );
  });

  it('sends the configured authorization without logging its value', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const authed = makeAdapter(server.url, { authorization: 'Bearer test-secret' });
      const completion = await authed.send(inputFor(), { deliveryId: 'del_1' });
      assert.equal(completion.status, 'succeeded');
      assert.equal(server.requests.length, 1);
      assert.equal(server.requests[0]?.hadAuth, true);
      const anon = makeAdapter(server.url);
      await anon.send(inputFor(), { deliveryId: 'del_2' });
      assert.equal(server.requests[1]?.hadAuth, false);
    });
  });

  it('maps 429 and 408 to unknown so the retry budget applies', async () => {
    for (const [status, code] of [
      [429, 'provider_rate_limited'],
      [408, 'provider_client_timeout'],
    ] as const) {
      await withServer(
        { kind: 'reject', status, body: { error: 'slow down' } },
        async (server) => {
          const adapter = makeAdapter(server.url);
          const completion = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
          assert.equal(completion.delivery_id, 'del_1');
          assert.equal(completion.status, 'unknown');
          assert.equal(completion.result, null);
          assert.equal(completion.error?.code, code);
        },
      );
    }
  });

  it('times out to unknown, then reconciles success by identity', async () => {
    await withServer(
      { kind: 'hang', reconcile: 'accepted' },
      async (server) => {
        const adapter = makeAdapter(server.url, { timeoutMs: 50 });
        const lost = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(lost.status, 'unknown');
        assert.equal(lost.delivery_id, 'del_1');
        assert.equal(lost.result, null);
        assert.deepEqual(lost.error, {
          code: 'transport_timeout',
          message: 'Mail send timed out; outcome unknown.',
        });
        const found = await adapter.reconcile('del_1');
        assert.equal(found.delivery_id, 'del_1');
        assert.equal(found.status, 'succeeded');
        assert.deepEqual(found.result, { reference: 'mail_1' });
        assert.equal(found.error, null);
      },
    );
  });

  it('times out to unknown, then reconciles a confirmed failure', async () => {
    await withServer(
      { kind: 'hang', reconcile: 'rejected' },
      async (server) => {
        const adapter = makeAdapter(server.url, { timeoutMs: 50 });
        const lost = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(lost.status, 'unknown');
        assert.equal(lost.delivery_id, 'del_1');
        const confirmed = await adapter.reconcile('del_1');
        assert.equal(confirmed.delivery_id, 'del_1');
        assert.equal(confirmed.status, 'failed');
        assert.equal(confirmed.result, null);
        assert.deepEqual(confirmed.error, {
          code: 'provider_rejected',
          message: 'No mailbox for recipient',
        });
      },
    );
  });

  it('stays unknown when reconcile reports pending', async () => {
    await withServer(
      { kind: 'hang', reconcile: 'pending' },
      async (server) => {
        const adapter = makeAdapter(server.url, { timeoutMs: 50 });
        const lost = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(lost.status, 'unknown');
        const still = await adapter.reconcile('del_1');
        assert.equal(still.delivery_id, 'del_1');
        assert.equal(still.status, 'unknown');
        assert.equal(still.result, null);
        assert.equal(still.error, null);
      },
    );
  });

  it('fails an unreadable acceptance body as an invalid response', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url, { maxBodyBytes: 5 });
      const completion = await adapter.send(inputFor(), {
        deliveryId: 'del_1',
      });
      assert.equal(completion.delivery_id, 'del_1');
      assert.equal(completion.status, 'failed');
      assert.equal(completion.result, null);
      assert.deepEqual(completion.error, {
        code: 'invalid_response',
        message: 'Mail provider returned an invalid response.',
      });
    });
  });

  it('maps an unreachable provider to unknown, never failed', async () => {
    const doomed = await startControlledMailServer({ kind: 'accept' });
    const url = doomed.url;
    await doomed.close();
    const adapter = makeAdapter(url);
    const completion = await adapter.send(inputFor(), {
      deliveryId: 'del_1',
    });
    assert.equal(completion.delivery_id, 'del_1');
    assert.equal(completion.status, 'unknown');
    assert.equal(completion.result, null);
    assert.deepEqual(completion.error, {
      code: 'transport_unreachable',
      message: 'Mail provider unreachable; outcome unknown.',
    });
  });

  it('rejects oversized aggregates pre-send, attachments intact', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url, {
        maxTransportBytes: 10_000,
        sizes: { file_a: 6000, file_b: 6000 },
      });
      let caught: unknown;
      try {
        await adapter.send(inputFor({ attachments: ['file_a', 'file_b'] }), {
          deliveryId: 'del_1',
        });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof MailTransportLimitError);
      assert.equal(caught.limitBytes, 10_000);
      assert.deepEqual([...caught.request.attachments], [
        'file_a',
        'file_b',
      ]);
      assert.equal(caught.request.attachmentBytes, 12_000);
      assert.equal(caught.request.deliveryId, 'del_1');
      assert.equal(caught.request.createdAt, CLOCK_NOW);
      assert.ok(Object.isFrozen(caught.request));
      assert.ok(Object.isFrozen(caught.request.attachments));
      assert.equal(server.requests.length, 0);
    });
  });

  it('maps invalid provider schemas to failed, never pending', async () => {
    const bodies: unknown[] = [{ wrong: true }, 'not json at all', { reference: 42 }];
    for (const body of bodies) {
      await withServer({ kind: 'invalid-schema', body }, async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.status, 'failed');
        assert.notEqual(completion.status, 'pending');
        assert.equal(completion.result, null);
        assert.deepEqual(completion.error, {
          code: 'invalid_response',
          message: 'Mail provider returned an invalid response.',
        });
      });
    }
  });

  it('maps invalid reconcile payloads to failed', async () => {
    await withServer(
      { kind: 'invalid-schema', body: { status: 'accepted' } },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.reconcile('del_1');
        assert.equal(completion.status, 'failed');
        assert.equal(completion.error?.code, 'invalid_response');
      },
    );
  });

  it('retries with the same identity after a transient 5xx', async () => {
    await withServer(
      { kind: 'flaky-then-accept', failures: 1 },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const first = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(first.status, 'unknown');
        assert.deepEqual(first.error, {
          code: 'provider_transient',
          message: 'Mail provider returned a transient error; outcome unknown.',
        });
        const second = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(second.status, 'succeeded');
        assert.deepEqual(second.result, { reference: 'mail_1' });
        assert.equal(server.requests.length, 2);
      },
    );
  });

  it('refuses cross-origin redirects as unknown', async () => {
    await withServer({ kind: 'accept' }, async (other) => {
      await withServer(
        { kind: 'redirect', status: 302, location: `${other.url}/send` },
        async (server) => {
          const adapter = makeAdapter(server.url);
          const completion = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
          assert.equal(completion.delivery_id, 'del_1');
          assert.equal(completion.status, 'unknown');
          assert.equal(completion.result, null);
          assert.deepEqual(completion.error, {
            code: 'redirect_refused',
            message:
              'Mail provider redirected off the configured endpoint; outcome unknown.',
          });
        },
      );
    });
  });

  it('maps redirect loops to unknown with the original identity', async () => {
    await withServer(
      { kind: 'redirect', status: 307, location: '/send' },
      async (server) => {
        const adapter = makeAdapter(server.url);
        const completion = await adapter.send(inputFor(), {
          deliveryId: 'del_1',
        });
        assert.equal(completion.delivery_id, 'del_1');
        assert.equal(completion.status, 'unknown');
        assert.equal(completion.result, null);
        assert.deepEqual(completion.error, {
          code: 'too_many_redirects',
          message:
            'Mail provider redirected repeatedly without answering; outcome unknown.',
        });
      },
    );
  });

  it('refuses to send when an attachment size is unknown', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url);
      await assert.rejects(
        adapter.send(inputFor({ attachments: ['ghost'] }), {
          deliveryId: 'del_1',
        }),
        (err: unknown) => {
          assert.ok(err instanceof MailAttachmentError);
          assert.deepEqual([...err.refs], ['ghost']);
          return true;
        },
      );
      assert.equal(server.requests.length, 0);
    });
  });

  it('fails reconcile of an unknown delivery with a typed error', async () => {
    await withServer({ kind: 'accept' }, async (server) => {
      const adapter = makeAdapter(server.url);
      const completion = await adapter.reconcile('del_999');
      assert.equal(completion.delivery_id, 'del_999');
      assert.equal(completion.status, 'failed');
      assert.deepEqual(completion.error, {
        code: 'unknown_delivery',
        message: 'Mail provider has no record of this delivery.',
      });
    });
  });

  it('validates completion envelopes per section 8', () => {
    assertValidCompletion(skippedCompletion('del_1'));
    assert.throws(
      () =>
        assertValidCompletion({
          delivery_id: 'del_1',
          status: 'succeeded',
          result: { reference: 'mail_1' },
          error: { code: 'x', message: 'y' },
        }),
      /succeeded requires/,
    );
    assert.throws(
      () =>
        assertValidCompletion({
          delivery_id: 'del_1',
          status: 'failed',
          result: { reference: 'mail_1' },
          error: null,
        }),
      /failed requires/,
    );
    assert.throws(
      () =>
        assertValidCompletion({
          delivery_id: 'del_1',
          status: 'unknown',
          result: { reference: 'mail_1' },
          error: null,
        }),
      /unknown requires/,
    );
    const pendingReceipt = {
      delivery_id: 'del_1',
      status: 'pending',
      result: null,
      error: null,
    } as unknown as CapabilityCompletion<EmailAccepted>;
    assert.throws(
      () => assertValidCompletion(pendingReceipt),
      /never a completion/,
    );
  });
});
