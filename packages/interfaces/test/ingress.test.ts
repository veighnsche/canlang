/**
 * S7 provider-ingress tests: mapping unit tests, the route matrix
 * (routing, body caps, verification order, receipt semantics, failure
 * mapping), header forwarding, and `createHttpHandler` mounting.
 */
import { test } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { createMemoryIdentityStore, createFrozenClock } from '@canlang/identity/testing';
import { IdentityError } from '@canlang/identity';
import { createIdentityRemovalIngressVerifier } from '../src/ingress/identity-removal.js';
import assert from 'node:assert/strict';
import type { VerifiedIngressEnvelope, VerifiedTeamsMemberRemovedEnvelope } from '@canlang/contracts';
import type {
  DelegatedContext,
  HttpDeps,
  IngressBinding,
  IngressSink,
  IngressVerifier,
} from '../src/ports.js';
import { systemInterfacesClock } from '../src/ports.js';
import { mapVerifiedIngress } from '../src/ingress/mapping.js';
import { INGRESS_BODY_MAX_BYTES, handleIngressRequest } from '../src/ingress/routes.js';
import { createHttpHandler } from '../src/http/routes.js';
import {
  createFakeCatalog,
  createFakeFileUseInfo,
  createFakeInvoker,
  createFakeKernel,
  createFakeRegistry,
  createIdentityFixture,
  createMemoryRateLimiter,
  createTestApp,
  createTestBinding,
  createTestEnvelope,
  createTestIdentityDeps,
  createTestIngressDeps,
  testRequest,
} from '../src/testing.js';

type IngressSetup = ReturnType<typeof createTestIngressDeps>;

function ingressPost(namespace: string, init: RequestInit = {}): Request {
  return testRequest(`/ingress/${namespace}`, { method: 'POST', ...init });
}

function jsonIngress(namespace: string, body: unknown, headers: Record<string, string> = {}): Request {
  return ingressPost(namespace, {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { code: string; message: string };
  return { status: res.status, code: body.code, message: body.message };
}

function happyDeps(): IngressSetup {
  return createTestIngressDeps({
    verify: { 'acme-billing': createTestEnvelope() },
  });
}

/** Verifier double that captures the exact headers it receives. */
function createCapturingVerifier(envelope: VerifiedIngressEnvelope): IngressVerifier & {
  calls: Array<{ binding: IngressBinding; headers: Record<string, string>; bytes: number }>;
} {
  const calls: Array<{ binding: IngressBinding; headers: Record<string, string>; bytes: number }> = [];
  return {
    calls,
    verify: (binding, input) => {
      calls.push({ binding, headers: input.headers, bytes: input.body.length });
      return Promise.resolve(envelope);
    },
  };
}

function createThrowingVerifier(error: Error): IngressVerifier {
  return {
    verify: () => Promise.reject(error),
  };
}

function createThrowingSink(error: Error): IngressSink {
  return {
    accept: () => Promise.reject(error),
  };
}

/* ------------------------------------------------------------------ */
/* Mapping unit tests.                                                 */
/* ------------------------------------------------------------------ */

test('mapVerifiedIngress builds an actor-null context from the binding', () => {
  const binding = createTestBinding({ team: 'team-9', owner: 'owner-9', namespace: 'shop-events' });
  const context = mapVerifiedIngress(binding, createTestEnvelope());
  assert.equal(context.actor, null);
  assert.equal(context.team, 'team-9');
  assert.equal(context.owner, 'owner-9');
  assert.equal(context.namespace, 'shop-events');
});

test('mapVerifiedIngress passes the verified envelope through as causation', () => {
  const envelope = createTestEnvelope({ producerEventId: 'evt-7', operationKind: 'refund' });
  const context = mapVerifiedIngress(createTestBinding(), envelope);
  assert.equal(context.causation, envelope);
});

/* ------------------------------------------------------------------ */
/* Route matrix.                                                       */
/* ------------------------------------------------------------------ */

test('happy path verifies, maps, sinks, and answers the receipt', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { accepted: true, producer_event_id: 'evt-1' });
  assert.equal(t.verifier.calls.length, 1);
  assert.equal(t.sink.calls.length, 1);
  const call = t.sink.calls[0];
  assert.ok(call !== undefined);
  const context = call.context as DelegatedContext;
  assert.equal(context.actor, null);
  assert.equal(context.team, 'team-1');
  assert.equal(context.owner, 'team-1');
  assert.equal(context.namespace, 'acme-billing');
  assert.deepEqual(context.causation, createTestEnvelope());
  assert.deepEqual(call.event, { charge: 1 });
  // Accepts are not logged (delivery volume).
  assert.equal(t.logger.calls.length, 0);
});

test('unknown namespace answers not_found without touching verifier or sink', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(t.deps, jsonIngress('nope', { charge: 1 }));
  assert.deepEqual(await errorOf(res), { status: 404, code: 'not_found', message: 'Not found.' });
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('verifier null answers 401 forbidden without touching the sink', async () => {
  const t = createTestIngressDeps({ verify: { 'acme-billing': null } });
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.verifier.calls.length, 1);
  assert.equal(t.sink.calls.length, 0);
  // Failure logged at info with routing fields only.
  const logged = t.logger.calls.filter((c) => c.level === 'info');
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.fields?.['namespace'], 'acme-billing');
});

test('envelope/binding namespace mismatch fails closed with 401', async () => {
  const t = createTestIngressDeps({
    verify: { 'acme-billing': createTestEnvelope({ namespace: 'other-ns' }) },
  });
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.sink.calls.length, 0);
  // The binding bug is journaled as an internal incident for operators.
  const internals = t.logger.calls.filter((c) => c.level === 'error');
  assert.equal(internals.length, 1);
});

test('malformed JSON answers validation without calling the verifier', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(
    t.deps,
    ingressPost('acme-billing', {
      headers: { 'content-type': 'application/json' },
      body: '{"charge":',
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'validation');
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('non-object JSON answers validation', async () => {
  for (const body of ['[1,2]', '"str"', '42', 'null', '']) {
    const t = happyDeps();
    const res = await handleIngressRequest(
      t.deps,
      ingressPost('acme-billing', {
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    const err = await errorOf(res);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'validation');
    assert.equal(t.verifier.calls.length, 0);
    assert.equal(t.sink.calls.length, 0);
  }
});

test('over-cap bodies answer limit', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(
    t.deps,
    ingressPost('acme-billing', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(INGRESS_BODY_MAX_BYTES) }),
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'limit');
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('wrong method answers not_found, never a 405 oracle', async () => {
  const t = happyDeps();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await handleIngressRequest(
      t.deps,
      testRequest('/ingress/acme-billing', { method }),
    );
    const err = await errorOf(res);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  }
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('empty namespace, extra segments, and undecodable segments are not_found', async () => {
  const t = happyDeps();
  const paths = ['/ingress/', '/ingress/a/b', '/ingress/%E0%A4%A', '/ingress'];
  for (const path of paths) {
    const res = await handleIngressRequest(t.deps, testRequest(path, { method: 'POST' }));
    const err = await errorOf(res);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  }
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('verifier throw answers a generic 500 and journals an incident', async () => {
  const t = happyDeps();
  const deps = { ...t.deps, verifier: createThrowingVerifier(new Error('hmac boom [SECURITY_DATA]')) };
  const res = await handleIngressRequest(deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 500);
  assert.equal(err.code, 'rule_failed');
  assert.ok(!err.message.includes('[SECURITY_DATA]'));
  assert.equal(t.sink.calls.length, 0);
  const internals = t.logger.calls.filter((c) => c.level === 'error');
  assert.equal(internals.length, 1);
  assert.ok(typeof internals[0]?.fields?.['incident_id'] === 'string');
});

test('sink decline answers 200 {accepted:false} with the envelope receipt', async () => {
  const t = createTestIngressDeps({
    verify: { 'acme-billing': createTestEnvelope() },
    accepted: false,
  });
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { accepted: false, producer_event_id: 'evt-1' });
  // Declines are logged (info); accepts are not.
  assert.equal(t.logger.calls.length, 1);
  assert.equal(t.logger.calls[0]?.level, 'info');
});

test('sink throw answers a generic 500 and journals an incident', async () => {
  const t = happyDeps();
  const deps = { ...t.deps, sink: createThrowingSink(new Error('kernel boom [SECURITY_DATA]')) };
  const res = await handleIngressRequest(deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 500);
  assert.equal(err.code, 'rule_failed');
  assert.ok(!err.message.includes('[SECURITY_DATA]'));
  const internals = t.logger.calls.filter((c) => c.level === 'error');
  assert.equal(internals.length, 1);
});

test('raw headers and body reach the verifier untouched', async () => {
  const envelope = createTestEnvelope();
  const verifier = createCapturingVerifier(envelope);
  const t = createTestIngressDeps({ verify: {} });
  const deps = { ...t.deps, verifier };
  const payload = { charge: 42 };
  const res = await handleIngressRequest(
    deps,
    jsonIngress('acme-billing', payload, { 'x-signature': 'sig-1', 'x-delivery': 'del-9' }),
  );
  assert.equal(res.status, 200);
  assert.equal(verifier.calls.length, 1);
  const call = verifier.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.headers['x-signature'], 'sig-1');
  assert.equal(call.headers['x-delivery'], 'del-9');
  assert.equal(call.bytes, new TextEncoder().encode(JSON.stringify(payload)).length);
});

/* ------------------------------------------------------------------ */
/* Mounting.                                                           */
/* ------------------------------------------------------------------ */

test('POST /ingress/{namespace} reaches the ingress sub-handler via createHttpHandler', async () => {
  const t = happyDeps();
  const identity = await createIdentityFixture({});
  const httpDeps: HttpDeps = {
    app: createTestApp(),
    pages: createFakeRegistry([]),
    invoker: createFakeInvoker({}),
    catalog: createFakeCatalog({}),
    limiter: createMemoryRateLimiter(),
    logger: t.logger,
    clock: systemInterfacesClock,
    identity: createTestIdentityDeps(identity),
    secureCookies: false,
    uploads: { files: createFakeFileUseInfo(false), kernel: createFakeKernel({}) },
    ingress: { bindings: t.deps.bindings, verifier: t.deps.verifier, sink: t.deps.sink },
  };
  const unused = () => Promise.resolve(new Response('unused', { status: 500 }));
  const http = createHttpHandler(httpDeps, {
    operations: unused,
    auth: unused,
    uploads: unused,
    ingress: (req) => handleIngressRequest(t.deps, req),
    oauth: unused,
  });
  const res = await http(jsonIngress('acme-billing', { charge: 3 }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { accepted: true, producer_event_id: 'evt-1' });
  assert.equal(t.sink.calls.length, 1);
});

test('URL-encoded namespace decodes before binding lookup', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(t.deps, jsonIngress('acme%2Dbilling', { charge: 1 }));
  assert.equal(res.status, 200);
  assert.equal(t.verifier.calls.length, 1);
});

test('lowercase-constructed method still routes (fetch normalizes to POST)', async () => {
  const t = happyDeps();
  const req = testRequest('/ingress/acme-billing', {
    method: 'post',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ charge: 1 }),
  });
  assert.equal(req.method, 'POST');
  const res = await handleIngressRequest(t.deps, req);
  assert.equal(res.status, 200);
});


const REMOVAL_TIME = Date.UTC(2026, 9, 11, 12);
const REMOVAL_KEY_BYTES = Buffer.alloc(32, 17);
const REMOVAL_PREVIOUS_BYTES = Buffer.alloc(32, 29);
const removalKey = (bytes: Uint8Array) => `whsec_${Buffer.from(bytes).toString('base64')}`;
const removalBody = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const rawDigest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');

function signedRemoval(original: VerifiedTeamsMemberRemovedEnvelope, body: Uint8Array,
  atMs: number, key: Uint8Array = REMOVAL_KEY_BYTES) {
  const timestamp = String(Math.floor(atMs / 1000));
  const signature = createHmac('sha256', key).update(`${original.producerEventId}.${timestamp}.`).update(body).digest('base64');
  return { headers: { 'webhook-id': original.producerEventId, 'webhook-timestamp': timestamp,
    'webhook-signature': `v1,${signature}` }, body };
}

async function removalVerifierFixture() {
  const store = createMemoryIdentityStore({ clock: createFrozenClock(REMOVAL_TIME) });
  const owner = await store.createUser({ email: 'remover@identity.test', password_hash: 'opaque', email_verified: true });
  const subject = await store.createUser({ email: 'removed@identity.test', password_hash: 'opaque', email_verified: true });
  const team = await store.createTeam({});
  const ownerMembership = await store.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
  const membership = await store.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
  const input = { team_id: team.team_id, member_user_id: subject.user_id, removed_by: owner.user_id,
    namespace: 'identity-removal', operationId: 'remove-original' };
  const original = await store.removeMemberWithOccurrence!(input);
  const binding = createTestBinding({ namespace: input.namespace, adapter: 'standard-webhooks-v1-identity-removal', team: team.team_id, owner: team.team_id });
  const captured: Array<{ envelope: VerifiedTeamsMemberRemovedEnvelope; digest: string }> = [];
  const reads: typeof input[] = [];
  const control = { now: REMOVAL_TIME + 40_000, current: true,
    keys: { current: removalKey(REMOVAL_KEY_BYTES), previous: removalKey(REMOVAL_PREVIOUS_BYTES) } as { current: string; previous?: string } | null };
  const options = { binding, clock: { nowMs: () => control.now }, keys: () => control.keys,
    isCurrent: () => control.current,
    readOriginalOccurrence: async (actual: typeof input) => {
      reads.push(actual);
      return store.readMemberRemovalOccurrence!(actual);
    },
    captureVerified: (envelope: VerifiedTeamsMemberRemovedEnvelope, digest: string) => { captured.push({ envelope, digest }); },
  };
  const verifier = createIdentityRemovalIngressVerifier(options);
  return { store, owner, subject, team, ownerMembership, membership, input, original, binding,
    captured, reads, control, options, verifier };
}

test('Identity removal verifier authenticates independent raw signatures and reads only genuine original facts after readmission', async () => {
  const t = await removalVerifierFixture();
  await t.store.reactivateMembership(t.membership.membership_id, { is_owner: false, roles: [] });
  const grant = await t.store.createMcpGrant({ user_id: t.subject.user_id, team_id: t.team.team_id,
    client_id: 'client', token_sha256: 'fresh-grant', expires_at: new Date(REMOVAL_TIME + 100_000).toISOString() });
  const invitation = await t.store.createInvitation({ team_id: t.team.team_id, email: t.subject.email,
    grants_owner: false, grants_roles: [], invited_by: t.owner.user_id, expires_at: new Date(REMOVAL_TIME + 100_000).toISOString() });
  await t.store.removeMembership(t.ownerMembership.membership_id);
  const revision = t.store.revision();
  const ordinary = removalBody(t.original);
  const reordered = new TextEncoder().encode(`  ${JSON.stringify(Object.fromEntries(Object.entries(t.original).reverse()), null, 2)}\n`);
  for (const body of [ordinary, reordered]) {
    const result = await t.verifier.verify(t.binding, signedRemoval(t.original, body, t.control.now));
    assert.deepEqual(result, t.original); assert.equal(result, t.captured.at(-1)!.envelope);
    assert.equal(t.captured.at(-1)!.digest, rawDigest(body));
    assert.notEqual(t.captured.at(-1)!.digest, t.original.requestDigest);
  }
  assert.notEqual(t.captured[0]!.digest, t.captured[1]!.digest);
  assert.equal(await t.verifier.verify(t.binding, { ...signedRemoval(t.original, ordinary, t.control.now), body: reordered }), null);
  assert.equal(t.captured.length, 2); assert.equal(t.reads.length, 2);
  for (const input of t.reads) assert.deepEqual(input, t.input);
  assert.equal(t.store.revision(), revision);
  assert.equal((await t.store.findMembershipById(t.membership.membership_id))!.status, 'active');
  assert.equal((await t.store.findMcpGrantByTokenHash(grant.token_sha256))!.revoked_at, null);
  assert.equal((await t.store.findInvitationById(invitation.invitation_id))!.revoked_at, null);
});

test('Identity removal verifier refuses malformed signed JSON profiles duplicates UTF8 and source field skew without capture', async () => {
  const t = await removalVerifierFixture(), original = t.original;
  const text = JSON.stringify(original);
  const malformedText = [
    text.replace('{', '{"namespace":"identity-removal",'),
    text.replace('{', '{"namesp\\u0061ce":"identity-removal",'),
    text.replace('"membershipRemoval":{', '"membershipRemoval":{"team_id":"duplicate",'),
    text.replace('"user":{', '"user":{"k\\u0069nd":"user",'),
  ];
  const changes: unknown[] = [null, { ...original, extra: true }, { ...original, operationKind: 'other' },
    { ...original, namespace: 'foreign' }, { ...original, producerEventId: 'foreign-event' },
    { ...original, requestDigest: '0'.repeat(64) }, { ...original, operationId: 'other-op' },
    { ...original, deliveryId: 'invented-delivery' }, { ...original, occurredAt: '2026-10-11T12:00:00Z' },
    { ...original, occurredAt: new Date(REMOVAL_TIME + 1).toISOString() },
    { ...original, membershipRemoval: { ...original.membershipRemoval, team_id: 'foreign-team' } },
    { ...original, membershipRemoval: { ...original.membershipRemoval, membership_id: 'foreign-member' } },
    { ...original, membershipRemoval: { ...original.membershipRemoval, extra: true } },
    { ...original, membershipRemoval: { ...original.membershipRemoval, user: { kind: 'user', id: t.owner.user_id } } },
    { ...original, removedBy: { kind: 'user', id: t.subject.user_id } },
    { ...original, removedBy: { kind: 'user', id: t.owner.user_id, extra: true } },
    { ...original, membershipRemoval: { ...original.membershipRemoval, user: { kind: 'user', id: '' } } },
  ];
  const bodies = [...malformedText.map(value => new TextEncoder().encode(value)), ...changes.map(removalBody),
    new Uint8Array([0xc3, 0x28]), new Uint8Array(INGRESS_BODY_MAX_BYTES + 1)];
  for (const [index, body] of bodies.entries()) assert.equal(
    await t.verifier.verify(t.binding, signedRemoval(original, body, t.control.now)), null, `signed malformed candidate ${index}`);
  assert.equal(t.captured.length, 0);
  const empty = createIdentityRemovalIngressVerifier({ ...t.options, readOriginalOccurrence: async () => null });
  assert.equal(await empty.verify(t.binding, signedRemoval(original, removalBody(original), t.control.now)), null);
  const conflict = createIdentityRemovalIngressVerifier({ ...t.options, readOriginalOccurrence: async () => {
    throw new IdentityError('conflict', 'private-original-conflict');
  } });
  assert.equal(await conflict.verify(t.binding, signedRemoval(original, removalBody(original), t.control.now)), null);
  const captureFailure = createIdentityRemovalIngressVerifier({ ...t.options, captureVerified() { throw new Error('private-capture-failure'); } });
  assert.equal(await captureFailure.verify(t.binding, signedRemoval(original, removalBody(original), t.control.now)), null);
});

test('Identity removal verifier enforces closed canonical webhook headers key rotation and exact installed binding', async () => {
  const t = await removalVerifierFixture(), body = removalBody(t.original);
  const good = signedRemoval(t.original, body, t.control.now);
  const sig = good.headers['webhook-signature'];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const encoded = sig.slice(3), noncanonical = encoded.slice(0, -2) + alphabet[alphabet.indexOf(encoded.at(-2)!) + 1] + '=';
  const headers: Record<string, string>[] = [
    {}, { ...good.headers, 'webhook-id': '' }, { ...good.headers, 'webhook-id': 'bad.id' },
    { ...good.headers, 'webhook-id': 'x'.repeat(201) }, { ...good.headers, 'webhook-id': `${t.original.producerEventId}, ${t.original.producerEventId}` },
    ...['01', '-1', '1.5', '9007199254740992', '1, 2'].map(value => ({ ...good.headers, 'webhook-timestamp': value })),
    ...['v2,' + encoded, 'v1,' + noncanonical, 'v1,' + encoded.slice(0, -1), `${sig}, ${sig}`,
      Array(9).fill(sig).join(' '), 'x'.repeat(4097)].map(value => ({ ...good.headers, 'webhook-signature': value })),
  ];
  for (const value of headers) assert.equal(await t.verifier.verify(t.binding, { headers: value, body }), null);
  assert.deepEqual(await t.verifier.verify(t.binding, { ...good, headers: { ...good.headers,
    'webhook-signature': Array(8).fill(sig).join(' ') } }), t.original);
  for (const binding of [{ ...t.binding }, { ...t.binding, adapter: 'unsupported' }, { ...t.binding, team: 'foreign' }]) {
    assert.equal(await t.verifier.verify(binding, good), null);
  }
  const previous = signedRemoval(t.original, body, t.control.now, REMOVAL_PREVIOUS_BYTES);
  assert.deepEqual(await t.verifier.verify(t.binding, previous), t.original);
  t.control.keys = { current: removalKey(REMOVAL_KEY_BYTES) };
  assert.equal(await t.verifier.verify(t.binding, previous), null);
  for (const key of [null, { current: 'whsec_bad' }, { current: removalKey(REMOVAL_KEY_BYTES).slice(0, -1) },
    { current: removalKey(REMOVAL_KEY_BYTES), previous: 'whsec_bad' }]) {
    t.control.keys = key;
    assert.equal(await t.verifier.verify(t.binding, good), null);
  }
  t.control.keys = { current: removalKey(REMOVAL_KEY_BYTES) };
  (t.binding as { owner: string }).owner = 'changed-owner';
  assert.equal(await t.verifier.verify(t.binding, good), null);
  const unsupported = createTestBinding({ ...t.binding, adapter: 'unsupported' });
  const unsupportedVerifier = createIdentityRemovalIngressVerifier({ ...t.options, binding: unsupported });
  assert.equal(await unsupportedVerifier.verify(unsupported, good), null);
});

test('Identity removal verifier retains original age and attempt boundaries and withholds a suspended closed host', async () => {
  const t = await removalVerifierFixture(), body = removalBody(t.original);
  for (const delta of [-300_000, 30_000]) assert.deepEqual(await t.verifier.verify(t.binding,
    signedRemoval(t.original, body, t.control.now + delta)), t.original);
  for (const delta of [-301_000, 31_000]) assert.equal(await t.verifier.verify(t.binding,
    signedRemoval(t.original, body, t.control.now + delta)), null);
  for (const now of [REMOVAL_TIME + 86_400_000, REMOVAL_TIME - 30_000]) {
    t.control.now = now;
    assert.deepEqual(await t.verifier.verify(t.binding, signedRemoval(t.original, body, now)), t.original);
  }
  for (const now of [REMOVAL_TIME + 86_400_001, REMOVAL_TIME - 30_001]) {
    t.control.now = now;
    assert.equal(await t.verifier.verify(t.binding, signedRemoval(t.original, body, now)), null);
  }
  for (const now of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    t.control.now = now;
    assert.equal(await t.verifier.verify(t.binding, signedRemoval(t.original, body, REMOVAL_TIME + 40_000)), null);
  }
  t.control.now = REMOVAL_TIME + 40_000;
  const capturesBeforeAsync = t.captured.length;
  let asyncCaptures = 0;
  const asyncCapture = createIdentityRemovalIngressVerifier({ ...t.options, async captureVerified(original, digest) {
    asyncCaptures++;
    assert.deepEqual(original, t.original);
    assert.equal(digest, rawDigest(body));
    throw new Error('private-async-capture-rejection');
  } });
  assert.equal(await asyncCapture.verify(t.binding, signedRemoval(t.original, body, t.control.now)), null);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(asyncCaptures, 1);
  assert.equal(t.captured.length, capturesBeforeAsync);
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const verifier = createIdentityRemovalIngressVerifier({ ...t.options, readOriginalOccurrence: async input => {
    const original = await t.options.readOriginalOccurrence(input); entered(); await gate; return original;
  } });
  const before = t.captured.length;
  const pending = verifier.verify(t.binding, signedRemoval(t.original, body, t.control.now));
  await entry; t.control.current = false; release();
  assert.equal(await pending, null); assert.equal(t.captured.length, before);
  const reads = t.reads.length;
  assert.equal(await verifier.verify(t.binding, signedRemoval(t.original, body, t.control.now)), null);
  assert.equal(t.reads.length, reads);
});

test('Identity removal verifier captures signed input before awaits and refuses a key retired during original lookup', async () => {
  const t = await removalVerifierFixture(), body = removalBody(t.original);
  const digest = rawDigest(body), signed = signedRemoval(t.original, body, t.control.now);
  const captured = t.verifier.verify(t.binding, signed);
  body.fill(0);
  signed.headers['webhook-id'] = 'changed';
  signed.headers['webhook-timestamp'] = '0';
  signed.headers['webhook-signature'] = 'changed';
  assert.deepEqual(await captured, t.original);
  assert.equal(t.captured.at(-1)!.digest, digest);

  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const verifier = createIdentityRemovalIngressVerifier({ ...t.options, readOriginalOccurrence: async input => {
    const original = await t.options.readOriginalOccurrence(input); entered(); await gate; return original;
  } });
  const before = t.captured.length;
  const pending = verifier.verify(t.binding, signedRemoval(t.original, removalBody(t.original), t.control.now));
  await entry;
  t.control.keys = { current: removalKey(REMOVAL_PREVIOUS_BYTES) };
  release();
  assert.equal(await pending, null);
  assert.equal(t.captured.length, before);
});

test('Identity removal HTTP ingress preserves private original causation digest binding and safe parse-before-verifier refusal', async () => {
  const t = await removalVerifierFixture(), body = removalBody(t.original);
  const base = createTestIngressDeps({ bindings: [t.binding] });
  const associations = new WeakMap<object, string>();
  let verifies = 0, accepts = 0;
  const genuine = createIdentityRemovalIngressVerifier({ ...t.options, captureVerified(original, digest) {
    associations.set(original, digest);
  } });
  const deps = { ...base.deps,
    verifier: { async verify(binding: IngressBinding, input: { headers: Record<string, string>; body: Uint8Array }) {
      verifies++; return genuine.verify(binding, input);
    } },
    sink: { async accept(context: DelegatedContext, event: unknown) {
      accepts++; assert.equal(context.actor, null); assert.equal(context.team, t.team.team_id);
      assert.equal(context.namespace, t.input.namespace);
      assert.deepEqual(context.causation, t.original);
      assert.equal(associations.get(context.causation), rawDigest(body));
      assert.equal(associations.has({ ...context.causation }), false);
      assert.deepEqual(event, t.original);
      return { accepted: true };
    } },
  };
  const good = signedRemoval(t.original, body, t.control.now);
  let response = await handleIngressRequest(deps, ingressPost(t.input.namespace, { headers: good.headers, body: JSON.stringify(t.original) }));
  assert.equal(response.status, 200); assert.equal(accepts, 1); assert.equal(verifies, 1);
  response = await handleIngressRequest(deps, ingressPost(t.input.namespace, { headers: good.headers, body: '{' }));
  assert.equal(response.status, 400); assert.equal(verifies, 1); assert.equal(accepts, 1);
  response = await handleIngressRequest(deps, ingressPost(t.input.namespace, { headers: { ...good.headers,
    'webhook-signature': 'v1,PRIVATE-secret-sentinel' }, body: JSON.stringify(t.original) }));
  assert.equal(response.status, 401); assert.equal(accepts, 1);
  const refusal = await response.text(); assert.ok(!refusal.includes('PRIVATE-secret-sentinel'));
  const logs = JSON.stringify(base.logger.calls);
  assert.ok(!logs.includes('PRIVATE-secret-sentinel')); assert.ok(!logs.includes(t.original.requestDigest));
  assert.ok(!logs.includes(t.subject.user_id)); assert.ok(!logs.includes('membershipRemoval'));
});
