/**
 * F2 PresentationContext constructor tests: `buildPresentationContext`
 * field sources, and the dispatch pin that partial and full renders
 * receive equal contexts across all 10 fields (modulo `isPartial`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME } from '@canlang/contracts';
import type {
  AdmittedBindings,
  PageDescriptor,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
} from '@canlang/contracts';
import { deriveCsrfToken } from '@canlang/identity';
import { createTestDeps, testRequest } from '../src/testing.js';
import { handlePageRequest } from '../src/http/pages.js';
import { buildPresentationContext } from '../src/http/presentation.js';

function fakeIdentity(): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: 'none' },
    admitted_at: new Date(0).toISOString(),
  };
}

function fakeQuery(): RowQueryRunner {
  return (async () => {
    throw new Error('no rows in unit test');
  }) as RowQueryRunner;
}

function capturingPage(captured: PresentationContext[]): PageDescriptor {
  return {
    owner: 'TestApp',
    path: '/hello',
    title: 'Hello',
    admit: async (_context: unknown) => ({}),
    render: async (context: PresentationContext, _bindings: AdmittedBindings) => {
      captured.push(context);
      return '<p>hi</p>';
    },
  };
}

test('buildPresentationContext sets all fields from the inputs', () => {
  const principal = fakeIdentity();
  const query = fakeQuery();
  const request = testRequest('/hello', {
    headers: { 'accept-language': 'nl-NL,nl;q=0.9, ,en;q=0.8' },
  });
  const context = buildPresentationContext({
    request,
    pathname: '/hello',
    isPartial: false,
    appDefaultLocale: 'en',
    csrfToken: 'token-1',
    principal,
    query,
  });
  assert.deepEqual(context.preferredLocales, ['nl-NL', 'nl', 'en']);
  assert.equal(context.appDefaultLocale, 'en');
  assert.deepEqual(context.theme, DEFAULT_THEME);
  assert.equal(context.path, '/hello');
  assert.equal(context.isPartial, false);
  assert.equal(context.csrfToken, 'token-1');
  assert.equal(context.principal, principal);
  assert.equal(context.invocation, principal);
  assert.equal(context.query, query);
  assert.ok(!('currencyScales' in context));
});

test('buildPresentationContext honors isPartial and caps locale tags at 10', () => {
  const tags = Array.from({ length: 12 }, (_, i) => `l${i}`).join(',');
  const context = buildPresentationContext({
    request: testRequest('/hello', { headers: { 'accept-language': tags } }),
    pathname: '/hello',
    isPartial: true,
    appDefaultLocale: 'en',
    csrfToken: '',
    principal: fakeIdentity(),
    query: fakeQuery(),
  });
  assert.equal(context.isPartial, true);
  assert.equal(context.preferredLocales.length, 10);
  assert.deepEqual(context.preferredLocales.slice(0, 2), ['l0', 'l1']);
});

test('buildPresentationContext with no Accept-Language yields no locales', () => {
  const context = buildPresentationContext({
    request: testRequest('/hello'),
    pathname: '/hello',
    isPartial: false,
    appDefaultLocale: 'en',
    csrfToken: '',
    principal: fakeIdentity(),
    query: fakeQuery(),
  });
  assert.deepEqual(context.preferredLocales, []);
});

test('dispatch builds equal partial and full contexts across all 10 fields', async () => {
  const fullCaptured: PresentationContext[] = [];
  const partialCaptured: PresentationContext[] = [];
  const full = await createTestDeps({ descriptors: [capturingPage(fullCaptured)] });
  const partial = await createTestDeps({ descriptors: [capturingPage(partialCaptured)] });
  const headers = { 'accept-language': 'nl,en;q=0.5' };

  const fullRes = await handlePageRequest(full.deps, testRequest('/hello', { headers }));
  assert.equal(fullRes.status, 200);
  const partialRes = await handlePageRequest(
    partial.deps,
    testRequest('/hello', { headers: { ...headers, 'HX-Request': 'true' } }),
  );
  assert.equal(partialRes.status, 200);
  assert.equal(fullCaptured.length, 1);
  assert.equal(partialCaptured.length, 1);
  const fullCtx = fullCaptured[0]!;
  const partialCtx = partialCaptured[0]!;
  assert.equal(fullCtx.isPartial, false);
  assert.equal(partialCtx.isPartial, true);
  assert.deepEqual(partialCtx.preferredLocales, fullCtx.preferredLocales);
  assert.equal(partialCtx.appDefaultLocale, fullCtx.appDefaultLocale);
  assert.deepEqual(partialCtx.theme, fullCtx.theme);
  assert.equal(partialCtx.path, fullCtx.path);
  assert.equal(partialCtx.csrfToken, fullCtx.csrfToken);
  // Separate dispatches stamp separate `admitted_at` clocks; the rest of
  // the identity must be equal.
  const { admitted_at: _fullClock, ...fullPrincipal } = fullCtx.principal as ResolvedIdentity;
  const { admitted_at: _partialClock, ...partialPrincipal } = partialCtx.principal as ResolvedIdentity;
  void _fullClock;
  void _partialClock;
  assert.deepEqual(partialPrincipal, fullPrincipal);
  const { admitted_at: _fullInvClock, ...fullInvocation } = fullCtx.invocation as ResolvedIdentity;
  const { admitted_at: _partialInvClock, ...partialInvocation } = partialCtx.invocation as ResolvedIdentity;
  void _fullInvClock;
  void _partialInvClock;
  assert.deepEqual(partialInvocation, fullInvocation);
  assert.equal(typeof partialCtx.query, 'function');
  assert.equal(typeof fullCtx.query, 'function');
  assert.ok(!('currencyScales' in partialCtx));
  assert.ok(!('currencyScales' in fullCtx));
});

test('anonymous dispatch leaves csrfToken empty', async () => {
  const captured: PresentationContext[] = [];
  const { deps } = await createTestDeps({ descriptors: [capturingPage(captured)] });
  const res = await handlePageRequest(deps, testRequest('/hello'));
  assert.equal(res.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.csrfToken, '');
});

test('authed dispatch derives the CSRF token from the session', async () => {
  const captured: PresentationContext[] = [];
  const { deps, identity } = await createTestDeps({ descriptors: [capturingPage(captured)] });
  const res = await handlePageRequest(deps, testRequest('/hello', { cookie: identity.cookie }));
  assert.equal(res.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.csrfToken, await deriveCsrfToken(identity.sessionToken));
});
