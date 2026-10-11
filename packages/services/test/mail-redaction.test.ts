/**
 * S4: error redaction. Provider bodies carrying secrets must never
 * surface in `DeliveryError` messages; safe provider specificity is
 * preserved and unsafe specificity falls back to generic text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailV1Adapter } from '../src/mail/adapter.js';
import {
  redactUntrusted,
  specificOrGeneric,
} from '../src/mail/redact.js';
import {
  fixedAttachmentSizes,
  fixedClock,
  startControlledMailServer,
} from '../src/ports.js';
import type {
  ControlledMailServer,
  ControlledScenario,
} from '../src/ports.js';
import type { EmailSendInput } from '@canlang/contracts';

const FAKE_TOKEN = 'sk-fake-TEST-TOKEN-00000';
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

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

function makeAdapter(baseUrl: string): EmailV1Adapter {
  return new EmailV1Adapter({
    baseUrl,
    timeoutMs: 5000,
    maxBodyBytes: 1_000_000,
    maxTransportBytes: null,
    clock: fixedClock(1_758_000_000_000),
    sizes: fixedAttachmentSizes({}),
  });
}

const INPUT: EmailSendInput = {
  to: 'reviewer@example.test',
  subject: 'Review',
  body: 'Plan',
  attachments: [],
};

describe('mail redaction', () => {
  it('strips provider tokens from rejection errors', async () => {
    const bodies: unknown[] = [
      `upstream 400: invalid credential Bearer ${FAKE_TOKEN} for acct_99`,
      { error: `credential rejected: token=${FAKE_TOKEN}` },
    ];
    for (const body of bodies) {
      await withServer(
        { kind: 'reject', status: 400, body },
        async (server) => {
          const completion = await makeAdapter(server.url).send(INPUT, { deliveryId: 'del_1' });
          assert.equal(completion.status, 'failed');
          assert.deepEqual(completion.error, {
            code: 'provider_rejected',
            message: 'Mail delivery rejected by provider.',
          });
          const leaked = JSON.stringify(completion);
          assert.ok(!leaked.includes('sk-fake'));
          assert.ok(!leaked.includes('Bearer'));
          assert.ok(!leaked.includes('acct_99'));
        },
      );
    }
  });

  it('preserves safe provider specificity', async () => {
    await withServer(
      {
        kind: 'reject',
        status: 422,
        body: { error: 'Unknown recipient domain' },
      },
      async (server) => {
        const completion = await makeAdapter(server.url).send(INPUT, { deliveryId: 'del_1' });
        assert.equal(completion.status, 'failed');
        assert.equal(completion.error?.code, 'provider_rejected');
        assert.equal(completion.error?.message, 'Unknown recipient domain');
      },
    );
  });

  it('preserves closed mail specificity in rejected reconciliation', async () => {
    for (const message of [
      'Unknown recipient domain',
      'No mailbox here',
      'No mailbox for recipient',
    ]) {
      await withServer(
        { kind: 'invalid-schema', body: { status: 'rejected', message } },
        async (server) => {
          const completion = await makeAdapter(server.url).reconcile('del_1');
          assert.deepEqual(completion, {
            delivery_id: 'del_1',
            status: 'failed',
            result: null,
            error: { code: 'provider_rejected', message },
          });
          assert.equal(server.requests.length, 0);
        },
      );
    }
  });

  it('uses generic explanations for arbitrary rejection and rejected reconciliation messages', async () => {
    for (const message of [
      'bearer synthetic-private-token',
      'Account email reviewer@example.test',
      'Account number 123456789',
      'Message body: private review notes',
      'Trace: send (/private/mail.js:10:3)',
      'Unknown recipient domain: reviewer@example.test',
      'private notes: Unknown recipient domain',
      'VAE decode failed',
      'unrecognized provider explanation',
    ]) {
      const expected = {
        delivery_id: 'del_1',
        status: 'failed',
        result: null,
        error: {
          code: 'provider_rejected',
          message: 'Mail delivery rejected by provider.',
        },
      };
      await withServer(
        { kind: 'reject', status: 400, body: { error: message } },
        async (server) => {
          const completion = await makeAdapter(server.url).send(INPUT, { deliveryId: 'del_1' });
          assert.deepEqual(completion, expected);
        },
      );
      await withServer(
        { kind: 'invalid-schema', body: { status: 'rejected', message } },
        async (server) => {
          const completion = await makeAdapter(server.url).reconcile('del_1');
          assert.deepEqual(completion, expected);
          assert.equal(server.requests.length, 0);
        },
      );
    }
  });

  it('falls back to generic on multiline provider messages', async () => {
    await withServer(
      {
        kind: 'reject',
        status: 400,
        body: { message: 'first line\nsecond line' },
      },
      async (server) => {
        const completion = await makeAdapter(server.url).send(INPUT, { deliveryId: 'del_1' });
        assert.equal(
          completion.error?.message,
          'Mail delivery rejected by provider.',
        );
      },
    );
  });

  it('scrubs credentials, tokens, traces and account ids', () => {
    const dirty = [
      'Authorization: Bearer abc123.xyz',
      'login failed: password=hunter2',
      'config api_key: 12345',
      `key=${FAKE_JWT}`,
      '    at send (/app/mail.js:10:3)',
      'account acct_99 suspended',
    ].join('\n');
    const clean = redactUntrusted(dirty);
    assert.ok(!clean.includes('abc123'));
    assert.ok(!clean.includes('hunter2'));
    assert.ok(!clean.includes('12345'));
    assert.ok(!clean.includes(FAKE_JWT));
    assert.ok(!clean.includes('/app/mail.js'));
    assert.ok(!clean.includes('acct_99'));
    assert.ok(clean.includes('[REDACTED]'));
  });

  it('bounds specificity by length and type', () => {
    assert.equal(specificOrGeneric('ok', 'generic'), 'generic');
    assert.equal(
      specificOrGeneric('x'.repeat(201), 'generic'),
      'generic',
    );
    assert.equal(specificOrGeneric(42, 'generic'), 'generic');
    assert.equal(specificOrGeneric(null, 'generic'), 'generic');
    assert.equal(
      specificOrGeneric(`has token=${FAKE_TOKEN} inside`, 'generic'),
      'generic',
    );
    const message = 'Unknown recipient domain';
    const generic = 'Mail delivery rejected by provider.';
    assert.equal(specificOrGeneric(message, generic, message.length), message);
    assert.equal(specificOrGeneric(message, generic, message.length - 1), generic);
    for (const raw of ['', `${message}\n`, `${message}\r`, `${message}\0`]) {
      assert.equal(specificOrGeneric(raw, generic), generic);
    }
  });

  it('selects only exact authored explanations in their adapter category', () => {
    const permitted = [
      ['Unknown recipient domain', 'Mail delivery rejected by provider.'],
      ['No mailbox here', 'Mail delivery rejected by provider.'],
      ['No mailbox for recipient', 'Mail delivery rejected by provider.'],
      ['model overloaded, try again', 'Model provider reported an error mid-stream.'],
      ['VAE decode failed', 'Image provider reported run failure.'],
    ] as const;
    for (const [message, generic] of permitted) {
      assert.equal(specificOrGeneric(message, generic), message);
      assert.equal(specificOrGeneric(`private ${message}`, generic), generic);
      assert.equal(specificOrGeneric(`${message} private`, generic), generic);
      for (const category of new Set(permitted.map((entry) => entry[1]))) {
        if (category !== generic) {
          assert.equal(specificOrGeneric(message, category), category);
        }
      }
      assert.equal(specificOrGeneric(message, 'generic'), 'generic');
    }
  });
});
