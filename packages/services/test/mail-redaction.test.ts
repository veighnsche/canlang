/**
 * S4: error redaction. Provider bodies carrying secrets must never
 * surface in `DeliveryError` messages; safe provider specificity is
 * preserved and unsafe specificity falls back to generic text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmailV1Adapter } from '../src/mail/adapter.ts';
import {
  redactUntrusted,
  specificOrGeneric,
} from '../src/mail/redact.ts';
import {
  fixedAttachmentSizes,
  fixedClock,
  sequentialIds,
  startControlledMailServer,
} from '../src/ports.ts';
import type {
  ControlledMailServer,
  ControlledScenario,
} from '../src/ports.ts';
import type { EmailSendInput } from '../../contracts/src/services.js';

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
    ids: sequentialIds('del'),
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
          const completion = await makeAdapter(server.url).send(INPUT);
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
        const completion = await makeAdapter(server.url).send(INPUT);
        assert.equal(completion.status, 'failed');
        assert.equal(completion.error?.code, 'provider_rejected');
        assert.equal(completion.error?.message, 'Unknown recipient domain');
      },
    );
  });

  it('falls back to generic on multiline provider messages', async () => {
    await withServer(
      {
        kind: 'reject',
        status: 400,
        body: { message: 'first line\nsecond line' },
      },
      async (server) => {
        const completion = await makeAdapter(server.url).send(INPUT);
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
    assert.equal(specificOrGeneric('ok', 'generic'), 'ok');
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
  });
});
