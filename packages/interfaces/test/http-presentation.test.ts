/**
 * F2 PresentationContext constructor tests: `buildPresentationContext`
 * field sources, and the dispatch pin that partial and full renders
 * receive equal contexts across all 10 fields (modulo `isPartial`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, collectionFilterName } from '@canlang/contracts';
import type {
  AdmittedBindings,
  PageDescriptor,
  PageDeliveryObserver,
  PageRecordsReader,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
  ColumnMeta,
} from '@canlang/contracts';
import { deriveCsrfToken } from '@canlang/identity';
import { createTestDeps, testRequest } from '../src/testing.js';
import { handlePageRequest } from '../src/http/pages.js';
import { buildPageSourceContext, buildPresentationContext } from '../src/http/presentation.js';
import { resolveRequestIdentity } from '../src/http/context.js';
import { calendar } from '@canlang/ui';

function fakeIdentity(): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: 'none' },
    admitted_at: new Date(0).toISOString(),
  };
}

test('collection enum filters preserve occurrence defaults, explicit clears and the current request context', async () => {
  const occurrence = 'page:/réports/😀:list:1';
  const sibling = 'page:/réports/😀:list:2';
  const fields: ColumnMeta[] = [
    { field: 'state', label: 'State', type: 'enum:App.Item.state', valueLabels: { open: 'Open', closed: 'Closed' } },
    { field: 'niveau', label: 'Level', type: 'enum:App.Item.niveau', valueLabels: { haut: 'High', bas: 'Low' } },
  ];
  const { deps, identity } = await createTestDeps();
  const { identity: principal } = await resolveRequestIdentity(deps.identity.store,
    testRequest('/hello', { cookie: identity.cookie }), { clock: deps.clock, teamId: identity.teamId });
  let queries = 0;
  const query: RowQueryRunner = async () => { queries++; return { rows: [], columns: [] }; };
  const make = (entries: readonly (readonly [string, string])[]) => {
    const params = new URLSearchParams(entries.map(entry => [...entry] as [string, string]));
    params.append('unrelated', 'retained');
    params.append('can-row:original', 'current-row');
    const request = testRequest(`/hello?${params}`, { cookie: identity.cookie });
    const context = buildPresentationContext({ request, pathname: '/hello', isPartial: false,
      appDefaultLocale: 'en', csrfToken: 'original-csrf', principal, query });
    assert.equal(context.principal, principal); assert.equal(context.invocation, principal);
    assert.equal(context.query, query); assert.equal(context.csrfToken, 'original-csrf');
    assert.equal(context.pollUrl, `/hello?${params}`);
    assert.deepEqual([...context.collectionSelections!], [['original', 'current-row']]);
    return context;
  };
  const absent = make([]).prepareCollectionFilters!;
  assert.deepEqual(absent(occurrence, fields, { state: 'open', niveau: null }), [{ field: 'state', op: 'eq', value: 'open' }]);
  assert.deepEqual(absent(occurrence, fields), []);
  assert.deepEqual(absent(occurrence, fields, { state: null }), []);
  const entries: [string, string][] = [[collectionFilterName(occurrence, 'state'), ''],
    [collectionFilterName(occurrence, 'niveau'), 'haut'], [collectionFilterName(sibling, 'state'), 'closed']];
  const selected = make(entries).prepareCollectionFilters!;
  const conditions = selected(occurrence, fields, { state: 'open', niveau: 'bas' });
  assert.deepEqual(conditions, [{ field: 'niveau', op: 'eq', value: 'haut' }]);
  assert.equal(Object.isFrozen(conditions), true); assert.equal(Object.isFrozen(conditions[0]), true);
  assert.deepEqual(selected(sibling, fields), [{ field: 'state', op: 'eq', value: 'closed' }]);
  assert.deepEqual(make(entries).prepareCollectionFilters!(occurrence, fields, { state: 'open', niveau: 'bas' }), conditions,
    'an explicit empty selector remains clear on the next render');
  assert.equal(queries, 0);
});

test('collection enum filters reject malformed source, defaults and current selectors before query or body work', () => {
  const occurrence = 'page:/hello/list:1';
  const field: ColumnMeta = { field: 'state', label: 'State', type: 'enum:App.Item.state', valueLabels: { open: 'Open', closed: 'Closed' } };
  let queries = 0, bodies = 0;
  const prepare = (entries: [string, string][]) => {
    const request = testRequest(`/hello?${new URLSearchParams(entries)}`);
    Object.defineProperty(request, 'json', { value: () => { bodies++; throw new Error('body was read'); } });
    return buildPresentationContext({ request, pathname: '/hello', isPartial: false, appDefaultLocale: 'en',
      csrfToken: '', principal: fakeIdentity(), query: async () => { queries++; return { rows: [], columns: [] }; } }).prepareCollectionFilters!;
  };
  const refuses = (run: () => unknown) => assert.throws(run, (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'validation');
  for (const entries of [
    [[collectionFilterName(occurrence, 'state'), 'open'], [collectionFilterName(occurrence, 'state'), 'closed']],
    [[collectionFilterName(occurrence, 'unknown'), 'open']],
    [[collectionFilterName(occurrence, 'state'), 'unknown']],
    [['filter[state]', 'open']], [['f[state]', 'open']],
  ] as [string, string][][]) refuses(() => prepare(entries)(occurrence, [field]));
  const plain = prepare([]);
  for (const fields of [[field, field], [{ ...field, field: '' }], [{ ...field, type: 'enum' }],
    [{ ...field, type: 'App.Item.state' }], [{ ...field, type: 'enum:' }], [{ ...field, valueLabels: {} }],
    [Object.assign(Object.create({ type: field.type }), { field: field.field, label: field.label, valueLabels: field.valueLabels })]]) {
    refuses(() => plain(occurrence, fields));
  }
  for (const defaults of [{ unknown: 'open' }, { state: 'unknown' }, { state: '' }]) {
    refuses(() => plain(occurrence, [field], defaults));
  }
  refuses(() => plain('', [field]));
  assert.deepEqual(prepare([[collectionFilterName('other', 'unknown'), 'invalid']])(occurrence, [field], { state: 'open' }),
    [{ field: 'state', op: 'eq', value: 'open' }], 'other occurrences are owned by their respective consumers');
  assert.equal(queries, 0); assert.equal(bodies, 0);
});

test('calendar agenda consumes occurrence enum filters through the unchanged authorized query context', async () => {
  const occurrence = 'page:/hello/agenda:1';
  const filter: ColumnMeta = { field: 'state', label: 'State', type: 'enum:Calendar.Booking.state',
    valueLabels: { open: 'Open', closed: 'Closed' } };
  const { deps, identity } = await createTestDeps();
  const { identity: principal } = await resolveRequestIdentity(deps.identity.store,
    testRequest('/hello', { cookie: identity.cookie }), { clock: deps.clock, teamId: identity.teamId });
  let queries = 0, bodies = 0, callbacks = 0;
  const denial = new Error('original authorized query refusal');
  const filterName = collectionFilterName(occurrence, 'state');
  const siblingName = collectionFilterName('page:/hello/agenda:2', 'state');
  const rowName = `can-row:${occurrence}`;
  const preserved = [['unrelated', 'original'], [siblingName, 'closed'], [rowName, 'selected-booking']] as const;
  const make = (selection: string | undefined, refuseQuery = false, zeroRows = selection === '') => {
    const params = new URLSearchParams([...preserved.map(([name, value]) => [name, value]), ['cursor', 'stale-browser-cursor']]);
    if (selection !== undefined) params.set(collectionFilterName(occurrence, 'state'), selection);
    const request = testRequest(`/hello?${params}`, { cookie: identity.cookie });
    Object.defineProperty(request, 'json', { value: () => { bodies++; throw new Error('body was read'); } });
    const query: RowQueryRunner = async (invocation, model, args) => {
      queries++;
      assert.equal(invocation, principal); assert.equal(model, 'Calendar.Booking');
      assert.deepEqual(args, { order: ['starts'], page: true, occurrence, limit: 3, cursor: 'original-cursor',
        ...(selection === '' ? {} : { where: { op: 'eq', field: 'state', value: selection ?? 'open' } }) });
      if (refuseQuery) throw denial;
      return { rows: zeroRows ? [] : [{ id: 'booking', fields: {
        starts: '2026-10-11T12:00:00Z', ends: '2026-10-11T13:00:00Z', state: selection === '' ? 'open' : selection ?? 'open',
      } }], columns: zeroRows ? [] : [filter] };
    };
    const context = buildPresentationContext({ request, pathname: '/hello', isPartial: false,
      appDefaultLocale: 'en', csrfToken: 'original-csrf', principal, query });
    assert.equal(context.pollUrl, `/hello?${params}`);
    assert.equal(context.collectionSelections!.get(occurrence), 'selected-booking');
    return calendar({ kind: 'agenda', context, model: 'Calendar.Booking', startField: 'starts', endField: 'ends',
      filter: [filter], defaults: { state: 'open' }, order: ['starts'], page: true, occurrence,
      limit: 3, cursor: 'original-cursor', empty: 'None', renderRow: (row, view) => {
        callbacks++;
        assert.equal(view, context); assert.equal(view.principal, principal);
        return [`<p>original-${row.id}</p>`];
      } });
  };
  const assertGetControls = (html: string) => {
    assert.ok(html.includes('<form method="get" action="/hello" data-can-agenda-filters>'));
    for (const [name, value] of preserved) {
      assert.ok(html.includes(`<input type="hidden" name="${name}" value="${value}">`), `preserves ${name}`);
    }
    assert.doesNotMatch(html, /name="cursor"|stale-browser-cursor/);
  };
  const defaultHtml = await make(undefined);
  assert.match(defaultHtml, /original-booking/); assertGetControls(defaultHtml);
  assert.ok(defaultHtml.includes(`name="${filterName}" class="select"`));
  assert.ok(defaultHtml.includes('<option value="open" selected>Open</option>'));
  const explicitHtml = await make('closed');
  assert.match(explicitHtml, /original-booking/); assertGetControls(explicitHtml);
  assert.ok(explicitHtml.includes('<option value="closed" selected>Closed</option>'));
  assert.ok(explicitHtml.includes('<option value="open">Open</option>'));
  const clearedHtml = await make('', false, false);
  assertGetControls(clearedHtml);
  assert.ok(clearedHtml.includes('<option value="" selected>'));
  assert.doesNotMatch(clearedHtml, /value="(?:open|closed)" selected/);
  assert.equal(callbacks, 3);
  const clear = await make('');
  assert.match(clear, /None/);
  assert.doesNotMatch(clear, /<option|Open|Closed/);
  const beforeEmpty = callbacks;
  const activeEmpty = await make('closed', false, true);
  assertGetControls(activeEmpty);
  assert.match(activeEmpty, /None/);
  assert.ok(activeEmpty.includes(`<button type="submit" name="${filterName}" value="" class="btn">`));
  assert.equal((activeEmpty.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(activeEmpty, /<option|<select|Open|Closed|original-booking/);
  assert.equal(callbacks, beforeEmpty);
  const beforeInvalid = queries;
  const beforeRefusal = callbacks;
  await assert.rejects(make('unknown'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'validation');
  assert.equal(queries, beforeInvalid);
  assert.equal(callbacks, beforeRefusal);
  await assert.rejects(make('closed', true), error => error === denial);
  assert.equal(callbacks, beforeRefusal);
  assert.equal(bodies, 0);
});

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
  assert.equal(context.actor, null);
  assert.equal(context.actorFacts, null);
  assert.equal(context.team, null);
  assert.deepEqual(context.memberships, []);
  assert.deepEqual(context.canonical?.builtinRoles, ['public']);
  assert.ok(!('currencyScales' in context));
});

test('page source roles require an active membership matching the selected actor and team', () => {
  const stamp = new Date(0).toISOString();
  const identity: ResolvedIdentity = {
    ...fakeIdentity(),
    actor: { user_id: 'user-one', email: 'a@example.test', email_verified: true },
    team: { team_id: 'team-one', timezone: 'Europe/Brussels', created_at: stamp },
    membership: { membership_id: 'member-one', user_id: 'user-one', team_id: 'team-one',
      status: 'active', is_owner: true, roles: [{ role: 'TestApp.reviewer', granted_at: stamp, granted_by: 'user-one' }],
      created_at: stamp, updated_at: stamp },
  };
  const source = buildPageSourceContext(identity);
  assert.equal(source.actor?.id, 'user-one');
  assert.deepEqual(source.actorFacts, { email: 'a@example.test', email_verified: true });
  assert.deepEqual(source.team, { id: 'team-one', timezone: 'Europe/Brussels' });
  assert.deepEqual(source.memberships, ['TestApp.reviewer']);
  assert.deepEqual(source.canonical.builtinRoles, ['public', 'authenticated', 'members', 'owner']);
  for (const membership of [null, { ...identity.membership!, status: 'removed' as const },
    { ...identity.membership!, team_id: 'other-team' }, { ...identity.membership!, user_id: 'other-user' }]) {
    const denied = buildPageSourceContext({ ...identity, membership });
    assert.deepEqual(denied.memberships, []);
    assert.deepEqual(denied.canonical.builtinRoles, ['public', 'authenticated']);
  }
  const owner = buildPageSourceContext({ ...identity, membership: { ...identity.membership!, roles: [] } });
  assert.deepEqual(owner.memberships, []);
});

test('presentation installs exact scoped native readers without exposing effects or losing source facts', async () => {
  const principal = fakeIdentity();
  const source = buildPageSourceContext(principal);
  const records = [{ id: 'row-one', title: 'Granted title' }];
  const selectors = { where: { authored: true }, authority: 'viewer' as const };
  const readRecords: PageRecordsReader = async (model, query) => {
    assert.equal(model, 'TestApp.Todo');
    assert.equal(query, selectors);
    return records;
  };
  const observeDelivery: PageDeliveryObserver = async () => null;
  const context = buildPresentationContext({ request: testRequest('/hello'), pathname: '/hello',
    isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal, source,
    query: fakeQuery(), readRecords, observeDelivery });
  assert.equal(context.canonical?.builtinRoles, source.canonical.builtinRoles);
  assert.equal(context.canonical?.readRecords, readRecords);
  assert.equal(context.canonical?.observeDelivery, observeDelivery);
  assert.equal(await context.canonical!.readRecords!('TestApp.Todo', selectors), records);
  assert.deepEqual(Object.keys(context.canonical!), ['builtinRoles', 'readRecords', 'observeDelivery']);
  assert.equal(Object.isFrozen(context.canonical), true);
  assert.equal('readRecords' in source.canonical, false);
});

test('unbound presentation source reads explicitly refuse', async () => {
  const context = buildPresentationContext({ request: testRequest('/hello'), pathname: '/hello',
    isPartial: true, appDefaultLocale: 'en', csrfToken: '', principal: fakeIdentity(), query: fakeQuery() });
  await assert.rejects(context.canonical!.readRecords!('TestApp.Todo', {}), {
    code: 'validation', message: 'Authorized page source reads are not configured.', retryable: false,
  });
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

  const pageUrl = '/hello?can-row%3Amain=row-one&filter=failed';
  const fullRes = await handlePageRequest(full.deps, testRequest(pageUrl, { headers }));
  assert.equal(fullRes.status, 200);
  const partialRes = await handlePageRequest(
    partial.deps,
    testRequest(pageUrl, { headers: { ...headers, 'HX-Request': 'true' } }),
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
  assert.deepEqual(partialCtx.collectionSelections, fullCtx.collectionSelections);
  assert.deepEqual([...fullCtx.collectionSelections!], [['main', 'row-one']]);
  assert.equal(partialCtx.pollUrl, pageUrl);
  assert.equal(partialCtx.pollContext, fullCtx.pollContext);
  for (const field of ['actor', 'actorFacts', 'team', 'memberships', 'canonical'] as const) {
    assert.deepEqual(partialCtx[field], fullCtx[field]);
  }
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

test('poll context is stable for partial renders and changes with session, caller, team or path', () => {
  const actor = { user_id: 'user-one', email: 'private@example.test', email_verified: true };
  const team = { team_id: 'team-one', timezone: 'UTC', created_at: new Date(0).toISOString() };
  const principal = { ...fakeIdentity(), actor, team };
  const input = { request: testRequest('/hello'), pathname: '/hello', isPartial: false, appDefaultLocale: 'en', csrfToken: 'session-one', principal, query: fakeQuery() };
  const key = buildPresentationContext(input).pollContext;
  assert.equal(key, buildPresentationContext({ ...input, isPartial: true }).pollContext);
  assert.doesNotMatch(key!, /private@example/);
  for (const changes of [
    { csrfToken: 'session-two' },
    { pathname: '/elsewhere' },
    { request: testRequest('/hello?team=team-two') },
    { principal: { ...principal, actor: { ...actor, user_id: 'user-two' } } },
    { principal: { ...principal, team: { ...team, team_id: 'team-two' } } },
  ]) assert.notEqual(key, buildPresentationContext({ ...input, ...changes }).pollContext);
});


test('poll URL preserves the team selector and collection query', () => {
  const context = buildPresentationContext({ request: testRequest('/hello?team=team-two&filter=failed'), pathname: '/hello', isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal: fakeIdentity(), query: fakeQuery() });
  assert.equal(context.path, '/hello');
  assert.equal(context.pollUrl, '/hello?team=team-two&filter=failed');
});

test('collection selections carry exact decoded occurrence keys and opaque row locators only', () => {
  const params = new URLSearchParams([
    ['team', 'team-two'], ['filter', 'failed'], ['can-row:page:/hello/view:é😀', 'row +/%é😀'],
    ['can-row:__proto__', 'constructor'], ['can-row', 'ordinary'], ['filter[can-row:other]', 'ordinary'],
  ]);
  const pageUrl = `/hello?${params}`;
  const principal = fakeIdentity();
  const query = fakeQuery();
  const context = buildPresentationContext({ request: testRequest(pageUrl), pathname: '/hello',
    isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal, query });
  assert.deepEqual([...context.collectionSelections!], [
    ['page:/hello/view:é😀', 'row +/%é😀'], ['__proto__', 'constructor'],
  ]);
  assert.equal(context.principal, principal);
  assert.equal(context.invocation, principal);
  assert.equal(context.query, query);
  assert.equal(context.pollUrl, pageUrl);
  assert.equal(JSON.parse(context.pollContext!)[1], pageUrl);
});

test('ambiguous or empty reserved collection locators refuse the whole selection set', () => {
  for (const reserved of [
    'can-row%3Amain=row-one&can-row%3Amain=row-two',
    'can-row%3Amain=row-one&%63an-row%3Amain=row-one',
    'can-row%3A=row-one', 'can-row%3Amain=',
  ]) {
    const pageUrl = `/hello?filter=failed&can-row%3Aother=row-other&${reserved}`;
    const context = buildPresentationContext({ request: testRequest(pageUrl), pathname: '/hello',
      isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal: fakeIdentity(), query: fakeQuery() });
    assert.equal(context.collectionSelections!.size, 0);
    assert.equal(context.pollUrl, pageUrl);
    assert.equal(JSON.parse(context.pollContext!)[1], pageUrl);
  }
});

test('collection locator extraction bounds the raw query while preserving complete polling state', () => {
  const prefix = 'can-row%3Amain=row-one&filter=';
  const atBudget = prefix + 'x'.repeat(8192 - prefix.length);
  for (const [query, expected] of [[atBudget, [['main', 'row-one']]], [`${atBudget}x`, []]] as const) {
    const pageUrl = `/hello?${query}`;
    const context = buildPresentationContext({ request: testRequest(pageUrl), pathname: '/hello',
      isPartial: true, appDefaultLocale: 'en', csrfToken: '', principal: fakeIdentity(), query: fakeQuery() });
    assert.deepEqual([...context.collectionSelections!], expected);
    assert.equal(context.pollUrl, pageUrl);
    assert.equal(JSON.parse(context.pollContext!)[1], pageUrl);
  }
});
