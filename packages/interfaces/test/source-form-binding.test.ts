import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base64UrlToBytes, bytesToBase64Url } from '@canlang/identity';
import type { ClosedInputs, DerivedOperationInputs, ResolvedIdentity } from '@canlang/contracts';
import { createSourceFormBindings } from '../src/http/form-binding.js';
import type { SourceFormBindingContext } from '../src/ports.js';

const hostKey = new Uint8Array(32).fill(77);
const revision = 'artifact-source-revision';
const identity: ResolvedIdentity = {
  actor: { user_id: 'user-1', email: 'user@example.test', email_verified: true },
  team: { team_id: 'team-1', timezone: 'UTC', created_at: '2026-10-08T00:00:00Z' },
  membership: null, binding: { kind: 'session', session_id: 'session-1' }, admitted_at: '2026-10-08T00:00:00Z',
};
const derived: DerivedOperationInputs = {
  operation: 'Store.Entry.update', kind: 'update', artifactVersion: 1,
  inputs: [
    { name: 'record', kind: 'ref', model: 'Store.Entry', versioned: true, required: true },
    { name: 'title', kind: 'string', required: false },
    { name: 'unselected', kind: 'string', required: false },
  ],
};
const context: SourceFormBindingContext = {
  appId: 'Store', sessionToken: '01234567890123456789012345678901', identity, derived,
  operationId: 'rendered-nonce-1', nowMs: 1_800_000_000_000,
};
const bound: ClosedInputs = { record: { id: 'entry-1', version: '7' } };

test('source binding survives transport and reconstruction with the same configured key, retaining canonical retry inputs', async () => {
  const renderer = await createSourceFormBindings(hostKey, revision);
  const dispatcher = await createSourceFormBindings(bytesToBase64Url(hostKey), revision);
  const proof = await renderer.seal(context, bound, ['title']);
  assert.equal(proof.identity, 'e1d8e432fc743de97601b1c52e592e6429f14bf6024a8a9d8587409917b0b214', 'omitting occurrence preserves the original comparison hash');
  assert.equal(proof.draftIdentity, '6afbb53c3f723e4da5c6fcd29a212853ae1e3de682d7db62e055b3416e20c612');
  const token = proof.token;
  const transported = JSON.parse(JSON.stringify({ token, inputs: { title: 'Edited draft' } })) as { token: string; inputs: ClosedInputs };
  const restored = await dispatcher.restore({ ...context, nowMs: context.nowMs + 1_000 }, transported.token, transported.inputs);
  assert.ok(restored);
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), { title: 'Edited draft', record: { id: 'entry-1', version: '7' } });
  assert.equal(Object.getPrototypeOf(restored), null);
  assert.deepEqual(await dispatcher.restore(context, token, transported.inputs), restored, 'retries reconstruct the same canonical inputs');
  assert.deepEqual(transported.inputs, { title: 'Edited draft' }, 'restoration does not mutate submitted inputs');
  const fresh = await renderer.seal({ ...context, operationId: 'fresh-nonce', nowMs: context.nowMs + 1_000 }, bound, ['title']);
  assert.equal(fresh.identity, proof.identity, 'fresh nonce and expiry retain the same source binding identity');
  assert.equal(fresh.draftIdentity, proof.draftIdentity);
  assert.notEqual(fresh.token, token);
  const changedRecord = await renderer.seal(context, { record: { id: 'entry-2', version: '7' } }, ['title']);
  assert.notEqual(changedRecord.identity, proof.identity); assert.notEqual(changedRecord.draftIdentity, proof.draftIdentity);
  const changedVersion = await renderer.seal(context, { record: { id: 'entry-1', version: '8' } }, ['title']);
  assert.notEqual(changedVersion.identity, proof.identity);
  assert.equal(changedVersion.draftIdentity, proof.draftIdentity, 'same record at a new version permits editable draft transfer only');
  const changedContext = await renderer.seal({ ...context, appId: 'AnotherApp' }, bound, ['title']);
  assert.notEqual(changedContext.identity, proof.identity); assert.notEqual(changedContext.draftIdentity, proof.draftIdentity);
  const changedSchema = await renderer.seal({ ...context, derived: { ...derived, inputs: [
    derived.inputs[0]!, { ...derived.inputs[1]!, required: true }, derived.inputs[2]!,
  ] } }, bound, ['title']);
  assert.notEqual(changedSchema.draftIdentity, proof.draftIdentity);
  assert.equal(new TextDecoder().decode(base64UrlToBytes(token.split('.')[0]!)!).includes(revision), false, 'host revision details are not disclosed');
  const occurrenceContext = { ...context, occurrence: 'page:/entries/form:1/row:entry-1' };
  const scoped = await renderer.seal(occurrenceContext, bound, ['title']);
  const sibling = await renderer.seal({ ...occurrenceContext, occurrence: 'page:/entries/form:2/row:entry-1' }, bound, ['title']);
  assert.notEqual(scoped.identity, proof.identity);
  assert.notEqual(scoped.draftIdentity, proof.draftIdentity);
  assert.notEqual(sibling.identity, scoped.identity, 'same operation, refs and editable selection have distinct presentation occurrences');
  assert.notEqual(sibling.draftIdentity, scoped.draftIdentity);
  assert.equal(scoped.token, proof.token, 'occurrence never enters the signed payload');
  assert.equal(sibling.token, proof.token);
  const refreshed = await renderer.seal({ ...occurrenceContext, operationId: 'fresh-occurrence-nonce', nowMs: context.nowMs + 1_000 }, bound, ['title']);
  assert.equal(refreshed.identity, scoped.identity);
  assert.equal(refreshed.draftIdentity, scoped.draftIdentity);
  const newer = await renderer.seal(occurrenceContext, { record: { id: 'entry-1', version: '8' } }, ['title']);
  assert.notEqual(newer.identity, scoped.identity);
  assert.equal(newer.draftIdentity, scoped.draftIdentity);
  assert.deepEqual(await dispatcher.restore(context, scoped.token, transported.inputs), restored);
  assert.deepEqual(await dispatcher.restore({ ...context, occurrence: 'different-presentation' }, scoped.token, transported.inputs), restored,
    'restoration checks submission authority independently of occurrence');
});

test('source binding rejects altered proofs, bound overrides and edits outside the signed selection', async () => {
  const service = await createSourceFormBindings(hostKey, revision);
  const { token } = await service.seal(context, bound, ['title']);
  assert.equal(await service.restore(context, token, { record: { id: 'entry-1', version: '7' } }), null);
  assert.equal(await service.restore(context, token, { record: { id: 'entry-2', version: '9' }, title: 'Changed' }), null);
  assert.equal(await service.restore(context, token, { unselected: 'Declared but not selected' }), null);
  assert.equal(await service.restore(context, token, { unknown: 'Unknown' }), null);
  const [payload, signature] = token.split('.') as [string, string];
  const changed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)!)) as Record<string, unknown>;
  changed['bound'] = { record: { id: 'entry-2', version: '7' } };
  const tampered = `${bytesToBase64Url(new TextEncoder().encode(JSON.stringify(changed)))}.${signature}`;
  assert.equal(await service.restore(context, tampered, { title: 'Changed' }), null);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
  assert.deepEqual(base64UrlToBytes(alias), base64UrlToBytes(signature), 'Identity decoder permits unused tail bits');
  assert.equal(await service.restore(context, `${payload}.${alias}`, {}), null, 'the form protocol requires canonical spelling');
  assert.equal(await service.restore(context, 'x'.repeat(32_769), {}), null);
  assert.equal(await service.restore(context, 'not.a.valid.token', {}), null);
});

test('source binding fences current app, session, actor, team, operation, schema, nonce, revision, host key and expiry', async () => {
  const service = await createSourceFormBindings(hostKey, revision);
  const { token } = await service.seal(context, bound, ['title']);
  const mismatches: SourceFormBindingContext[] = [
    { ...context, appId: 'AnotherApp' },
    { ...context, sessionToken: 'another-session' },
    { ...context, identity: { ...identity, actor: { ...identity.actor!, user_id: 'user-2' } } },
    { ...context, identity: { ...identity, team: { ...identity.team!, team_id: 'team-2' } } },
    { ...context, derived: { ...derived, operation: 'Store.Entry.rename' } },
    { ...context, derived: { ...derived, inputs: derived.inputs.map(input => input.name === 'title' ? { ...input, required: true } : input) } },
    { ...context, operationId: 'rendered-nonce-2' },
    { ...context, nowMs: context.nowMs - 1 },
    { ...context, nowMs: context.nowMs + 15 * 60 * 1000 },
  ];
  for (const mismatch of mismatches) assert.equal(await service.restore(mismatch, token, {}), null);
  assert.ok(await service.restore({ ...context, nowMs: context.nowMs + 15 * 60 * 1000 - 1 }, token, {}));
  const revised = await createSourceFormBindings(hostKey, 'new-revision');
  assert.equal(await revised.restore(context, token, {}), null);
  const otherHost = await createSourceFormBindings(new Uint8Array(32).fill(78), revision);
  assert.equal(await otherHost.restore(context, token, {}), null);
  const callerKnownKey = await createSourceFormBindings(new TextEncoder().encode(context.sessionToken), revision);
  const forged = await callerKnownKey.seal(context, { record: { id: 'chosen-entry', version: '1' } }, ['title']);
  assert.equal(await service.restore(context, forged.token, {}), null, 'knowing the session cannot sign source bindings');
});

test('retained source restoration accepts only expired checked CRUD claims under the original signed context', async () => {
  const service = await createSourceFormBindings(hostKey, revision);
  const { token } = await service.seal(context, bound, ['title']);
  const expiry = context.nowMs + 15 * 60 * 1000;
  for (const malformed of [null, undefined, {}, { ...context, derived: null }, { ...context, derived: undefined }]) {
    assert.equal(await service.restoreRetained!(malformed as unknown as SourceFormBindingContext, token, {}), null);
  }
  assert.equal(await service.restoreRetained!({ ...context, nowMs: expiry - 1 }, token, {}), null);
  assert.equal(await service.restore({ ...context, nowMs: expiry }, token, {}), null);
  for (const nowMs of [expiry, context.nowMs + 24 * 60 * 60 * 1000 + 1]) {
    const expired = { ...context, nowMs };
    assert.deepEqual(JSON.parse(JSON.stringify(await service.restoreRetained!(expired, token, { title: 'Retry' }))),
      { title: 'Retry', record: { id: 'entry-1', version: '7' } });
    for (const mismatch of [
      { ...expired, appId: 'Other' }, { ...expired, sessionToken: 'Other' },
      { ...expired, identity: { ...identity, actor: { ...identity.actor!, user_id: 'other' } } },
      { ...expired, identity: { ...identity, team: { ...identity.team!, team_id: 'other' } } },
      { ...expired, operationId: 'other' },
      { ...expired, derived: { ...derived, inputs: derived.inputs.slice(0, 1) } },
      { ...expired, derived: { ...derived, operation: 'Other.update' } },
    ]) assert.equal(await service.restoreRetained!(mismatch, token, {}), null);
    for (const inputs of [{ unselected: 'extra' }, { record: { id: 'entry-1', version: '7' } }]) {
      assert.equal(await service.restoreRetained!(expired, token, inputs), null);
    }
    assert.equal(await service.restoreRetained!(expired, `${token}x`, {}), null);
    assert.equal(await (await createSourceFormBindings(hostKey, 'changed')).restoreRetained!(expired, token, {}), null);
    assert.equal(await (await createSourceFormBindings(new Uint8Array(32).fill(78), revision)).restoreRetained!(expired, token, {}), null);
  }
  const scenario = { ...context, derived: { ...derived, kind: 'scenario' as const } };
  const scenarioProof = await service.seal(scenario, bound, ['title']);
  assert.ok(await service.restore(scenario, scenarioProof.token, {}));
  assert.equal(await service.restoreRetained!({ ...scenario, nowMs: expiry }, scenarioProof.token, {}), null);
  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(token.split('.')[0]!)!)) as Record<string, unknown>;
  payload['expires'] = expiry - 1;
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', hostKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes));
  assert.equal(await service.restoreRetained!({ ...context, nowMs: expiry },
    `${bytesToBase64Url(bytes)}.${bytesToBase64Url(signature)}`, {}), null, 'even a signed altered lease span is refused');
});

test('source binding admits only normalized singular versioned refs and preserves own prototype-named inputs', async () => {
  const service = await createSourceFormBindings(hostKey, revision);
  for (const occurrence of ['', undefined, null, 1, '\uD800', '\uDC00']) {
    await assert.rejects(service.seal({ ...context, occurrence } as SourceFormBindingContext, bound, ['title']), TypeError);
  }
  await assert.rejects(service.seal(context, { title: 'Immutable scalar' }, []), TypeError);
  await assert.rejects(service.seal(context, { record: { id: 'entry-1', version: '07' } }, ['title']), TypeError);
  await assert.rejects(service.seal(context, { record: { id: 'entry-1', version: '7', privateField: 'not allowed' } }, ['title']), TypeError);
  await assert.rejects(service.seal(context, bound, ['record']), TypeError);
  await assert.rejects(service.seal(context, bound, ['title', 'title']), TypeError);
  const unversioned = { ...context, derived: { ...derived, inputs: derived.inputs.map(input => input.name === 'record' ? { ...input, versioned: false } : input) } };
  await assert.rejects(service.seal(unversioned, bound, ['title']), TypeError);
  const arrayRef = { ...context, derived: { ...derived, inputs: derived.inputs.map(input => input.name === 'record' ? { ...input, array: { required: true } } : input) } };
  await assert.rejects(service.seal(arrayRef, bound, ['title']), TypeError);
  const ownContext = { ...context, derived: { ...derived, inputs: [
    { ...derived.inputs[0]!, name: '__proto__' }, { name: 'constructor', kind: 'string' as const, required: false },
  ] } };
  const ownBound = Object.fromEntries([['__proto__', { id: 'entry-1', version: '7' }]]);
  const ownToken = await service.seal(ownContext, ownBound, ['constructor']);
  const restored = await service.restore(ownContext, ownToken.token, Object.fromEntries([['constructor', 'Edit']]));
  assert.ok(restored); assert.equal(Object.getPrototypeOf(restored), null);
  assert.equal(Object.hasOwn(restored, '__proto__'), true); assert.equal(Object.hasOwn(restored, 'constructor'), true);
  assert.deepEqual(restored['__proto__'], { id: 'entry-1', version: '7' }); assert.equal(restored['constructor'], 'Edit');
});

test('source binding requires an explicit correctly sized key, canonical key encoding and nonempty revision', async () => {
  await assert.rejects(createSourceFormBindings(new Uint8Array(31), revision), TypeError);
  await assert.rejects(createSourceFormBindings(hostKey, ''), TypeError);
  await assert.rejects(createSourceFormBindings('not-base64url!', revision), TypeError);
  const encoded = bytesToBase64Url(hostKey), alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias = encoded.slice(0, -1) + alphabet[alphabet.indexOf(encoded.at(-1)!) + 1];
  await assert.rejects(createSourceFormBindings(alias, revision), TypeError);
});
