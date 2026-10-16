/** Frozen `{text,locale}` carrier acceptance in recorded outbound sinks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBoundMailAdapter } from './bound-mail.js';

const BINDING = {
  deployment: 'deployment.mail',
  capability: 'std.EmailV1',
  capabilityVersion: 1,
  account: 'carrier-mail',
};

const SEND_INPUTS = {
  to: { type: 'email' },
  subject: { type: 'text' },
  body: { type: 'text' },
  attachments: { type: 'text[]' },
};

const USER_INPUTS = {
  to: { type: 'User' },
  subject: { type: 'text' },
  body: { type: 'text' },
  attachments: { type: 'text[]' },
};

function definition() {
  return {
    bindings: { mail: { capability: 'std.EmailV1', from: 'deployment.mail' } },
    capabilities: {
      'std.EmailV1': {
        version: 1,
        operations: {
          send: { result: { type: 'EmailAccepted' }, inputs: SEND_INPUTS },
          send_user: { result: { type: 'EmailAccepted' }, inputs: USER_INPUTS },
        },
      },
    },
  };
}

function options(seen: unknown[], extra: Record<string, unknown> = {}) {
  return {
    appDefinition: definition(),
    binding: { ...BINDING },
    resolveInstalledMailSender: () => ({
      binding: { ...BINDING },
      mail: {
        send: async (input: unknown) => {
          seen.push(input);
          return { delivery_id: 'intent-1', status: 'succeeded', result: { reference: 'ref-1' }, error: null };
        },
        reconcile: async () => null,
      },
    }),
    ...extra,
  };
}

function intent(target: string, args: Record<string, unknown>) {
  return {
    intentId: 'intent-1',
    target,
    arguments: { binding: 'mail', from: 'deployment.mail', arguments: args },
  };
}

const CARRIERS = {
  subject: Object.freeze({ text: 'Bonjour', locale: 'fr' }),
  body: Object.freeze({ text: 'Corps du message', locale: 'fr' }),
};

test('carrier subject and body resolve to their selected text', async () => {
  const seen: unknown[] = [];
  const adapter = createBoundMailAdapter(options(seen));
  const mail = intent('std.EmailV1.send', {
    to: 'reader@example.test',
    subject: CARRIERS.subject,
    body: CARRIERS.body,
    attachments: [],
  });
  assert.equal(adapter.available(mail), true);
  const outcome = await adapter.callProvider(mail);
  assert.deepEqual(outcome, { kind: 'delivered', result: { reference: 'ref-1' } });
  assert.equal(seen.length, 1);
  const sent = seen[0] as Record<string, unknown>;
  assert.equal(sent['subject'], 'Bonjour');
  assert.equal(sent['body'], 'Corps du message');
  assert.equal(sent['to'], 'reader@example.test');
});

test('plain string subject and body keep working', async () => {
  const seen: unknown[] = [];
  const adapter = createBoundMailAdapter(options(seen));
  const mail = intent('std.EmailV1.send', {
    to: 'reader@example.test',
    subject: 'Plain',
    body: 'Still plain',
    attachments: [],
  });
  assert.equal(adapter.available(mail), true);
  await adapter.callProvider(mail);
  const sent = seen[0] as Record<string, unknown>;
  assert.equal(sent['subject'], 'Plain');
  assert.equal(sent['body'], 'Still plain');
});

test('private-mail path stays intact with carriers', async () => {
  const seen: unknown[] = [];
  const adapter = createBoundMailAdapter(options(seen, {
    userRecipients: {
      teamId: 'team-a',
      findMembership: async () => ({ status: 'active', user_id: 'user-1', team_id: 'team-a' }),
      findUserById: async () => ({ user_id: 'user-1', email: 'member@example.test', email_verified: true }),
    },
  }));
  const mail = intent('std.EmailV1.send_user', {
    to: { id: 'user-1' },
    subject: CARRIERS.subject,
    body: CARRIERS.body,
    attachments: [],
  });
  assert.equal(adapter.available(mail), true);
  assert.deepEqual(adapter.userRecipient(mail), { user: 'user-1', team: 'team-a' });
  assert.equal(await adapter.resolveRecipient(mail), 'member@example.test');
  const outcome = await adapter.callProvider(mail, 'member@example.test');
  assert.deepEqual(outcome, { kind: 'delivered', result: { reference: 'ref-1' } });
  const sent = seen[0] as Record<string, unknown>;
  assert.equal(sent['subject'], 'Bonjour');
  assert.equal(sent['to'], 'member@example.test');
});

test('malformed carriers and non-strings still refuse', () => {
  const seen: unknown[] = [];
  const adapter = createBoundMailAdapter(options(seen));
  const cases: Array<[string, unknown, unknown]> = [
    ['missing locale', { text: 'x' }, 'y'],
    ['extra key', { text: 'x', locale: 'en', tag: 'z' }, 'y'],
    ['non-string text', { text: 3, locale: 'en' }, 'y'],
    ['non-canonical locale', { text: 'x', locale: 'EN_us' }, 'y'],
    ['number body', 'x', 7],
    ['object body', 'x', { nested: true }],
  ];
  for (const [name, subject, body] of cases) {
    const mail = intent('std.EmailV1.send', {
      to: 'reader@example.test',
      subject,
      body,
      attachments: [],
    });
    assert.equal(adapter.available(mail), false, name);
  }
  assert.equal(seen.length, 0);
});
