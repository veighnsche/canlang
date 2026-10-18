/**
 * F2 PresentationContext constructor tests: `buildPresentationContext`
 * field sources, and the dispatch pin that partial and full renders
 * receive equal contexts across all 10 fields (modulo `isPartial`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, collectionCursorName, collectionFilterName } from '@canlang/contracts';
import type {
  AdmittedBindings,
  PageDescriptor,
  PageReadScope,
  PageFilePresenter,
  PageFileImageResolver,
  FileValue,
  PageDeliveryObserver,
  PageGenerationCallbackDiagnosticsObserver,
  PageGenerationCallbackDiagnosticResult,
  PageRecordsReader,
  PresentationContext,
  ResolvedIdentity,
  RowQueryRunner,
  ColumnMeta,
  RowView,
  PageSourceContext,
} from '@canlang/contracts';
import { deriveCsrfToken, IdentityError } from '@canlang/identity';
import { CURRENCY_MINOR_UNITS, decodeValue, encodeValue, makeFileValue } from '@canlang/values';
import { createTestDeps, testRequest } from '../src/testing.js';
import { handlePageRequest } from '../src/http/pages.js';
import { buildPageSourceContext, buildPresentationContext } from '../src/http/presentation.js';
import { resolveRequestIdentity } from '../src/http/context.js';
import { calendar, detailsDrawer, gallery, table, text } from '@canlang/ui';

function fakeIdentity(): ResolvedIdentity {
  return {
    actor: null,
    team: null,
    membership: null,
    binding: { kind: 'none' },
    admitted_at: new Date(0).toISOString(),
  };
}

test('breadcrumb context uses only the explicit admitted dispatcher trail', () => {
  const principal = fakeIdentity();
  const forged = { label: 'Private source extra', ancestry: [{ owner: 'Private', path: '/private', title: 'Secret', active: false }] };
  const trusted = Object.freeze({ label: 'Breadcrumbs', ancestry: Object.freeze([
    Object.freeze({ owner: 'Current', path: '/hello', title: 'Hello', active: true }),
  ]) });
  const input = { request: testRequest('/hello'), pathname: '/hello', isPartial: true,
    appDefaultLocale: 'en', csrfToken: '', principal,
    source: { ...buildPageSourceContext(principal), breadcrumbs: forged }, query: fakeQuery() };
  const absent = buildPresentationContext(input);
  assert.equal(Object.hasOwn(absent, 'breadcrumbs'), false);
  assert.equal(buildPresentationContext({ ...input, breadcrumbs: trusted }).breadcrumbs, trusted);
});

test('page now decodes the trusted admission instant and ignores source, request and renderer clock overrides', () => {
  const principal = { ...fakeIdentity(), admitted_at: '1969-12-31T23:59:59.999Z' };
  const source = buildPageSourceContext(principal);
  assert.deepEqual(source.now, { kind: 'datetime', ms: -1n });
  assert.equal(Object.isFrozen(source.now), true);
  assert.equal(encodeValue('datetime', source.now), principal.admitted_at);
  let clockReads = 0;
  const context = buildPresentationContext({
    request: testRequest('/hello?now=2099-01-01T00%3A00%3A00.000Z'), pathname: '/hello',
    isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal,
    source: { ...source, now: decodeValue('datetime', '2099-01-01T00:00:00.000Z') as typeof source.now },
    clock: { nowMs: () => { clockReads++; throw new Error('renderer sampled the clock'); } },
    query: fakeQuery(),
  });
  assert.deepEqual(context.now, source.now);
  assert.equal(Object.isFrozen(context.now), true);
  assert.equal(clockReads, 0);
  for (const admitted_at of ['not-an-instant', '2026-02-30T12:00:00.000Z',
    '2026-10-11T12:00:00Z', '2026-10-11T12:00:00.000+00:00', '+010000-01-01T00:00:00.000Z']) {
    const invalid = { ...principal, admitted_at };
    assert.throws(() => buildPageSourceContext(invalid));
    assert.throws(() => buildPresentationContext({ request: testRequest('/hello'), pathname: '/hello',
      isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal: invalid, source, query: fakeQuery() }));
  }
});

test('full and partial page guards, discovery and data-only table queries share one admitted now', async () => {
  let hostTime = Date.UTC(2026, 9, 11, 12, 0, 0, 123);
  let expectedTime = hostTime;
  let clockReads = 0, admissions = 0, renders = 0, queries = 0, bodies = 0;
  const row: RowView = { id: 'visit-one', version: '3', fields: { title: 'Own visit' } };
  const descriptor: PageDescriptor = {
    owner: 'TestApp', path: '/hello', title: 'Hello',
    admit: async context => {
      admissions++;
      const source = context as PageSourceContext;
      assert.deepEqual(source.now, { kind: 'datetime', ms: BigInt(expectedTime) });
      assert.equal(Object.isFrozen(source.now), true);
      // An await and later clock movement do not move guards or the body boundary.
      await Promise.resolve(); hostTime += 60_000;
      return { admittedNow: source.now };
    },
    render: async (context, bindings) => {
      renders++;
      assert.deepEqual(context.now, bindings['admittedNow']);
      assert.equal(encodeValue('datetime', context.now!), (context.principal as ResolvedIdentity).admitted_at);
      return table({ context, model: 'TestApp.Visit', columns: ['title'],
        where: { op: 'gte', field: 'from', value: encodeValue('datetime', context.now!) },
        order: ['from'], page: true, occurrence: 'page:/hello/table:1', limit: 2,
        renderRow: (actual, view) => {
          bodies++; assert.equal(actual, row); assert.equal(view, context);
          assert.deepEqual(view.now, bindings['admittedNow']);
          return ['<p>Own visit body</p>'];
        } });
    },
  };
  const { deps } = await createTestDeps({ descriptors: [descriptor] });
  const query: RowQueryRunner = async (principal, model, args) => {
    queries++; assert.equal(model, 'TestApp.Visit');
    const instant = new Date(expectedTime).toISOString();
    assert.equal((principal as ResolvedIdentity).admitted_at, instant);
    assert.deepEqual(args, { where: { op: 'gte', field: 'from', value: instant },
      order: ['from'], page: true, occurrence: 'page:/hello/table:1', limit: 2 });
    return { rows: [row], columns: [{ field: 'title', label: 'Title', type: 'text' }] };
  };
  const timed = { ...deps, query, clock: { nowMs: () => { clockReads++; return hostTime++; } } };
  for (const partial of [false, true]) {
    expectedTime = hostTime;
    const before = clockReads;
    const response = await handlePageRequest(timed, testRequest('/hello?now=untrusted', {
      headers: partial ? { 'HX-Request': 'true' } : {},
    }));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Own visit body/);
    assert.equal(clockReads, before + 1, 'only owning Identity samples the request clock');
  }
  assert.equal(admissions, 3, 'full dispatch also admits discovery with the same source instant');
  assert.equal(renders, 2); assert.equal(queries, 2); assert.equal(bodies, 2);
});

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

test('collection bool toggle filters preserve typed conditions, precedence and refusals', () => {
  // Columns transcribed verbatim from actual `can compile` output for a
  // recorded enum+bool filter shape (see
  // test/fixtures/bool-toggle-filters-compiled.json, emitted by the Lane B
  // compiler batch): enum columns keep case-name conditions while `bool`
  // columns select strict booleans. Request text `"true"`/`"false"` parses
  // to booleans; the spellings never travel as truthy filter values.
  const occurrence = 'page:/hello/list:1';
  const fields: ColumnMeta[] = [
    { field: 'kind', label: 'kind', type: 'enum:Probe.Customer.kind', valueLabels: { individual: 'individual', company: 'company' } },
    { field: 'active', label: 'active', type: 'bool', valueLabels: { true: 'true', false: 'false' } },
  ];
  const prepare = (entries: [string, string][]) => {
    const request = testRequest(`/hello?${new URLSearchParams(entries)}`);
    return buildPresentationContext({ request, pathname: '/hello', isPartial: false, appDefaultLocale: 'en',
      csrfToken: '', principal: fakeIdentity(), query: async () => ({ rows: [], columns: [] }) }).prepareCollectionFilters!;
  };
  const plain = prepare([]);
  assert.deepEqual(plain(occurrence, fields), []);
  assert.deepEqual(plain(occurrence, fields, { kind: 'company', active: true }),
    [{ field: 'kind', op: 'eq', value: 'company' }, { field: 'active', op: 'eq', value: true }]);
  assert.deepEqual(plain(occurrence, fields, { active: false }),
    [{ field: 'active', op: 'eq', value: false }]);
  assert.deepEqual(plain(occurrence, fields, { kind: null, active: null }), []);
  for (const conditions of [
    plain(occurrence, fields, { active: true }),
    prepare([[collectionFilterName(occurrence, 'active'), 'true']])(occurrence, fields),
    prepare([[collectionFilterName(occurrence, 'active'), 'false']])(occurrence, fields, { active: true }),
  ]) {
    for (const condition of conditions) {
      assert.equal(condition.op, 'eq');
    }
  }
  const[toggled] = plain(occurrence, fields, { active: true });
  assert.equal(typeof toggled!.value, 'boolean');
  // Saved/request precedence: explicit request wins, explicit clear stays cleared.
  assert.deepEqual(
    prepare([[collectionFilterName(occurrence, 'active'), 'false']])(occurrence, fields, { active: true }),
    [{ field: 'active', op: 'eq', value: false }]);
  assert.deepEqual(
    prepare([[collectionFilterName(occurrence, 'active'), '']])(occurrence, fields, { active: true }), []);
  assert.deepEqual(
    prepare([[collectionFilterName(occurrence, 'kind'), 'individual']])(occurrence, fields, { kind: 'company', active: true }),
    [{ field: 'kind', op: 'eq', value: 'individual' }, { field: 'active', op: 'eq', value: true }]);
  const refuses = (run: () => unknown) => assert.throws(run, (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'validation');
  for (const entries of [
    [[collectionFilterName(occurrence, 'active'), 'yes']],
    [[collectionFilterName(occurrence, 'active'), 'True']],
    [[collectionFilterName(occurrence, 'active'), '1']],
    [[collectionFilterName(occurrence, 'active'), 'true'], [collectionFilterName(occurrence, 'active'), 'false']],
    [[collectionFilterName(occurrence, 'unknown'), 'true']],
    [['filter[active]', 'true']], [['f[active]', 'true']],
  ] as [string, string][][]) refuses(() => prepare(entries)(occurrence, fields));
  for (const defaults of [{ unknown: true }, { active: 'true' }, { active: '' }, { active: 1 }, { kind: true }] as
    Record<string, unknown>[]) {
    refuses(() => plain(occurrence, fields, defaults as Record<string, string | boolean | null>));
  }
  for (const columns of [[fields[1]!, fields[1]!], [{ ...fields[1]!, type: 'boolean' }],
    [{ ...fields[1]!, valueLabels: { true: 'true' } }], [{ ...fields[1]!, valueLabels: { true: 'true', false: 'false', extra: 'x' } }],
    [{ ...fields[1]!, valueLabels: {} }], [{ ...fields[1]!, field: '' }]]) {
    refuses(() => plain(occurrence, columns));
  }
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
    const params = new URLSearchParams([...preserved.map(([name, value]): [string, string] => [name, value]), ['cursor', 'stale-browser-cursor']]);
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

test('table consumes authored occurrence enum defaults and selections without changing protected query or row context', async () => {
  const occurrence = 'page:/hello/table:1';
  const filter: ColumnMeta = { field: 'state', label: 'State', type: 'enum:CanBook.Appointment.state',
    valueLabels: { confirmed: 'Confirmed', cancelled: 'Cancelled' } };
  const title: ColumnMeta = { field: 'title', label: 'Title', type: 'text' };
  const row: RowView = { id: 'appointment-1', version: '7', fields: { title: 'Own appointment', state: 'confirmed' } };
  const parent = { id: 'own-calendar' };
  const where = { op: 'eq', field: 'host', value: 'own-host' };
  const order = ['from'];
  const { deps, identity } = await createTestDeps();
  const { identity: principal } = await resolveRequestIdentity(deps.identity.store,
    testRequest('/hello', { cookie: identity.cookie }), { clock: deps.clock, teamId: identity.teamId });
  const filterName = collectionFilterName(occurrence, 'state');
  const siblingName = collectionFilterName('page:/hello/table:2', 'state');
  const preserved = [['q', 'appointment'], [siblingName, 'cancelled'], [`can-row:${occurrence}`, row.id],
    [collectionCursorName('page:/hello/table:2'), 'sibling-current']] as const;
  const denial = new Error('original table query denial');
  let queries = 0, callbacks = 0, bodies = 0;
  const make = (selection: string | undefined, defaultValue: string | null | undefined,
    empty = false, refuseQuery = false, extra: [string, string][] = []) => {
    const params = new URLSearchParams([...preserved.map(([name, value]): [string, string] => [name, value]),
      ['cursor', 'stale-cursor'], [collectionCursorName(occurrence), 'own-stale-cursor'], ...extra]);
    if (selection !== undefined) params.append(filterName, selection);
    const request = testRequest(`/hello?${params}`, { cookie: identity.cookie });
    Object.defineProperty(request, 'json', { value: () => { bodies++; throw new Error('body was read'); } });
    const active = selection === '' ? null : selection ?? defaultValue;
    const currentRow: RowView = { ...row, fields: { ...row.fields, state: active ?? 'confirmed' } };
    const query: RowQueryRunner = async (invocation, model, args) => {
      queries++;
      assert.equal(invocation, principal); assert.equal(model, 'CanBook.Appointment');
      assert.equal(args.parent, parent); assert.equal(args.order, order);
      assert.deepEqual(args, { parent, where: active == null ? where : { op: 'and', args: [where,
        { op: 'eq', field: 'state', value: active }] }, order, limit: 2, cursor: 'original-cursor', page: true, occurrence });
      if (refuseQuery) throw denial;
      return empty ? { rows: [], columns: [], emptyDeclarations: [{ field: 'title', type: 'text' }] }
        : { rows: [currentRow], columns: [title, filter] };
    };
    const context = buildPresentationContext({ request, pathname: '/hello', isPartial: false,
      appDefaultLocale: 'en', csrfToken: 'original-csrf', principal, query });
    assert.equal(context.principal, principal); assert.equal(context.invocation, principal);
    assert.equal(context.csrfToken, 'original-csrf');
    assert.equal(context.collectionSelections!.get(occurrence), row.id);
    assert.equal(context.pollUrl, `/hello?${params}`);
    return table({ context, model: 'CanBook.Appointment', columns: ['title'], parent, where, order,
      page: true, occurrence, limit: 2, cursor: 'original-cursor', filter: [filter],
      ...(defaultValue === undefined ? {} : { defaults: { state: defaultValue } }), empty: 'No appointments',
      renderRow: (actual, view) => {
        callbacks++; assert.equal(actual, currentRow); assert.equal(view, context);
        assert.equal(actual.version, '7'); assert.equal(actual.fields, currentRow.fields);
        return ['<p>original protected row body</p>'];
      } });
  };
  const assertControls = (html: string) => {
    assert.ok(html.includes('<form method="get" action="/hello" data-can-table-filters>'));
    for (const [name, value] of preserved) {
      assert.ok(html.includes(`<input type="hidden" name="${name}" value="${value}">`));
    }
    assert.doesNotMatch(html, /name="cursor"|stale-cursor/);
    assert.equal(html.includes(`name="${collectionCursorName(occurrence)}"`), false);
  };
  const initial = await make(undefined, 'confirmed');
  assertControls(initial); assert.match(initial, /original protected row body/);
  assert.ok(initial.includes('<option value="confirmed" selected>Confirmed</option>'));
  const selected = await make('cancelled', 'confirmed');
  assertControls(selected);
  assert.ok(selected.includes('<option value="cancelled" selected>Cancelled</option>'));
  assert.ok(selected.includes('<option value="confirmed">Confirmed</option>'));
  for (const [selection, defaultValue] of [[undefined, null], [undefined, undefined], ['', 'confirmed']] as const) {
    const cleared = await make(selection, defaultValue);
    assertControls(cleared); assert.ok(cleared.includes('<option value="" selected>'));
    assert.doesNotMatch(cleared, /value="(?:confirmed|cancelled)" selected/);
  }
  assert.equal(callbacks, 5);
  const activeEmpty = await make('cancelled', 'confirmed', true);
  assertControls(activeEmpty); assert.match(activeEmpty, /No appointments/);
  assert.ok(activeEmpty.includes(`<button type="submit" name="${filterName}" value="" class="btn">`));
  assert.equal((activeEmpty.match(/<button/g) ?? []).length, 1);
  assert.doesNotMatch(activeEmpty, /<option|<select|Confirmed|Cancelled|original protected row body/);
  const clearEmpty = await make('', 'confirmed', true);
  assert.match(clearEmpty, /No appointments/);
  assert.doesNotMatch(clearEmpty, /<option|<select|Confirmed|Cancelled/);
  assert.equal(callbacks, 5);
  const beforeInvalid = queries;
  for (const extra of [
    [[collectionFilterName(occurrence, 'unknown'), 'confirmed']],
    [[filterName, 'unknown']], [[filterName, 'confirmed'], [filterName, 'cancelled']],
    [['f[state]', 'confirmed']], [['filter[state]', 'confirmed']],
  ] as [string, string][][]) {
    await assert.rejects(make(undefined, 'confirmed', false, false, extra), (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'validation');
  }
  assert.equal(queries, beforeInvalid); assert.equal(callbacks, 5);
  await assert.rejects(make('cancelled', 'confirmed', false, true), error => error === denial);
  assert.equal(callbacks, 5); assert.equal(bodies, 0);
});

test('full and partial table pages forward independent opaque occurrence cursors and preserve current GET state', async () => {
  const occurrences = ['page:/hello/table:é😀', 'page:/hello/table:two'];
  const current = ['opaque-first/+%😀', 'opaque-second'];
  const next = ['\"><img src=x onerror=alert(1)> &/+%😀', 'second-next/+'];
  const rows: RowView[] = occurrences.map((_occurrence, index) => ({ id: `own-${index}`, version: String(index + 3),
    fields: { title: `Own row ${index}` } }));
  const parent = { id: 'own-parent' };
  const where = { op: 'eq', field: 'active', value: true };
  const order = ['from'];
  let invocation: unknown;
  let queries = 0, callbacks = 0, bodyReads = 0;
  const descriptor: PageDescriptor = {
    owner: 'TestApp', path: '/hello', title: 'Hello', admit: async () => ({}),
    render: async context => {
      invocation = context.invocation;
      assert.equal(context.principal, context.invocation);
      const html: string[] = [];
      for (const [index, occurrence] of occurrences.entries()) {
        html.push(await table({ context, model: 'TestApp.Visit', columns: ['title'], parent, where, order,
          page: true, occurrence, limit: 2, renderRow: (actual, view) => {
            callbacks++; assert.equal(actual, rows[index]); assert.equal(view, context);
            assert.equal(actual.version, String(index + 3));
            return [`<p>own-body-${index}</p>`];
          } }));
      }
      return html.join('');
    },
  };
  const { deps, identity } = await createTestDeps({ descriptors: [descriptor] });
  const query: RowQueryRunner = async (principal, model, args) => {
    queries++; assert.equal(principal, invocation); assert.equal(model, 'TestApp.Visit');
    assert.equal((principal as ResolvedIdentity).actor?.user_id, identity.userId);
    assert.equal((principal as ResolvedIdentity).team?.team_id, identity.teamId);
    const index = occurrences.indexOf(args.occurrence!);
    assert.ok(index >= 0);
    assert.equal(args.parent, parent); assert.equal(args.where, where); assert.equal(args.order, order);
    assert.deepEqual(args, { parent, where, order, page: true, occurrence: occurrences[index], limit: 2, cursor: current[index] });
    return { rows: [rows[index]!], columns: [{ field: 'title', type: 'text', label: 'Title' }], nextCursor: next[index]! };
  };
  const params = new URLSearchParams([
    ['team', identity.teamId], ['q', 'own visits'], ['unrelated', 'retained'],
    [collectionFilterName(occurrences[0]!, 'state'), 'confirmed'],
    [`can-row:${occurrences[1]}`, rows[1]!.id],
    ...occurrences.map((occurrence, index) => [collectionCursorName(occurrence), current[index]!] as [string, string]),
  ]);
  for (const partial of [false, true]) {
    const request = testRequest(`/hello?${params}`, { cookie: identity.cookie,
      ...(partial ? { headers: { 'HX-Request': 'true' } } : {}) });
    Object.defineProperty(request, 'json', { value: () => { bodyReads++; throw new Error('body read'); } });
    const response = await handlePageRequest({ ...deps, query }, request);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /own-body-0/); assert.match(html, /own-body-1/);
    assert.doesNotMatch(html, /<img src=x/);
    const links = [...html.matchAll(/href="([^"]*)"/g)].map(match => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://can.invalid'));
    for (const [index, occurrence] of occurrences.entries()) {
      const matching = links.filter(url => url.searchParams.get(collectionCursorName(occurrence)) === next[index]);
      assert.equal(matching.length, 1);
      const url = matching[0]!;
      assert.equal(url.origin, 'https://can.invalid'); assert.equal(url.pathname, '/hello');
      const expected = new URLSearchParams(params);
      expected.set(collectionCursorName(occurrence), next[index]!);
      assert.deepEqual([...url.searchParams], [...expected]);
    }
  }
  assert.equal(queries, 4); assert.equal(callbacks, 4); assert.equal(bodyReads, 0);
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
  assert.equal(context.currencyScales, CURRENCY_MINOR_UNITS);
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

test('presentation forwards each whole nullable closed generation diagnostic result without projection', async () => {
  const locator = { record: { id: 'own-row', version: 3n }, field: 'generation' };
  const outcomes: readonly (PageGenerationCallbackDiagnosticResult | null)[] = [null, {
    outcome: 'complete', snapshotAttribution: 'unsupported', failures: [{
      deliveryId: 'own-delivery', sourceOccurrence: 'own-source', occurrenceId: 'own-occurrence',
      handler: 'TestApp.generated', event: 'std.TextV1.generate.completed', recordedAtMs: 1_729_000_000_123n,
      code: 'require-false', message: 'handler requirement rejected the occurrence',
    }],
  }, { outcome: 'unsupported', reason: 'store-profile' }];
  for (const outcome of outcomes) {
    let calls = 0;
    const observer: PageGenerationCallbackDiagnosticsObserver = async actual => {
      calls++; assert.equal(actual, locator); return outcome;
    };
    const context = buildPresentationContext({ request: testRequest('/hello'), pathname: '/hello',
      isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal: fakeIdentity(),
      query: fakeQuery(), observeGenerationCallbackDiagnostics: observer });
    assert.equal(context.canonical?.observeGenerationCallbackDiagnostics, observer);
    assert.equal(await context.canonical!.observeGenerationCallbackDiagnostics!(locator), outcome);
    assert.equal(calls, 1);
  }
});

test('generation callback observer can only be installed by the presentation read scope', async () => {
  const principal = fakeIdentity();
  const source = buildPageSourceContext(principal);
  let injectedCalls = 0;
  const injected: PageGenerationCallbackDiagnosticsObserver = async () => { injectedCalls++; return null; };
  const poisoned = { ...source, canonical: { ...source.canonical, observeGenerationCallbackDiagnostics: injected } };
  const common = { request: testRequest('/hello'), pathname: '/hello', isPartial: false,
    appDefaultLocale: 'en', csrfToken: '', principal, source: poisoned, query: fakeQuery() };
  const absent = buildPresentationContext(common);
  assert.equal(absent.canonical?.observeGenerationCallbackDiagnostics, undefined);
  assert.equal(Object.hasOwn(absent.canonical!, 'observeGenerationCallbackDiagnostics'), false);
  const refusal = new Error('original generation observation refusal');
  const locator = { record: { id: 'own-row', version: 3n }, field: 'generation' };
  const installed: PageGenerationCallbackDiagnosticsObserver = async actual => {
    assert.equal(actual, locator); throw refusal;
  };
  const context = buildPresentationContext({ ...common, observeGenerationCallbackDiagnostics: installed });
  assert.equal(context.canonical?.observeGenerationCallbackDiagnostics, installed);
  assert.equal(context.canonical?.builtinRoles, source.canonical.builtinRoles);
  assert.equal(Object.isFrozen(context.canonical), true);
  await assert.rejects(context.canonical!.observeGenerationCallbackDiagnostics!(locator), error => error === refusal);
  assert.equal(injectedCalls, 0);
});

test('authenticated full and partial pages use their exact scoped whole generation observer once', async () => {
  for (const partial of [false, true]) {
    const row = { id: 'own-generation-row', version: 4n, title: 'Own projected row' };
    const locator = { record: row, field: 'generation' };
    let source: PageSourceContext | undefined;
    let current: ResolvedIdentity | undefined;
    let reads = 0, scopes = 0, bodyReads = 0;
    const observer: PageGenerationCallbackDiagnosticsObserver = async actual => {
      reads++; assert.equal(actual, locator); assert.equal(actual.record, row);
      assert.equal(actual.field, 'generation');
      assert.equal(current?.actor?.user_id, identity.userId);
      assert.equal(current?.team?.team_id, identity.teamId);
      return null;
    };
    const page: PageDescriptor = {
      owner: 'TestApp', path: '/hello', title: 'Hello',
      admit: async actual => { source = actual as PageSourceContext; return {}; },
      render: async context => {
        assert.equal(context.principal, current); assert.equal(context.invocation, current);
        assert.equal(context.actor, source!.actor); assert.equal(context.team, source!.team);
        assert.equal(context.canonical?.builtinRoles, source!.canonical.builtinRoles);
        assert.equal(context.canonical?.observeGenerationCallbackDiagnostics, observer);
        assert.equal(Object.isFrozen(context.canonical), true);
        const projected = await context.canonical!.readRecords!('TestApp.Job', {});
        assert.equal(projected[0], row);
        assert.equal(await context.canonical!.observeGenerationCallbackDiagnostics!(locator), null);
        return '<p>whole scoped generation observation</p>';
      },
    };
    const { deps, identity } = await createTestDeps({ descriptors: [page] });
    const scopedDeps = { ...deps, createReadScope: (principal: ResolvedIdentity) => {
      scopes++; current = principal; assert.ok(source);
      return { query: fakeQuery(), readRecords: async (model: string) => {
        assert.equal(model, 'TestApp.Job'); return [row];
      }, observeGenerationCallbackDiagnostics: observer };
    } };
    const request = testRequest(`/hello?team=${identity.teamId}`, { cookie: identity.cookie,
      ...(partial ? { headers: { 'HX-Request': 'true' } } : {}) });
    Object.defineProperty(request, 'json', { value: () => { bodyReads++; throw new Error('request body read'); } });
    const response = await handlePageRequest(scopedDeps, request);
    assert.equal(response.status, 200); assert.match(await response.text(), /whole scoped generation observation/);
    assert.equal(reads, 1); assert.equal(scopes, 1); assert.equal(bodyReads, 0);
  }
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
  assert.equal(partialCtx.currencyScales, CURRENCY_MINOR_UNITS);
  assert.equal(fullCtx.currencyScales, CURRENCY_MINOR_UNITS);
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


test('full and partial File text presentation uses the original admitted scope and ordered native File objects', async () => {
  for (const partial of [false, true]) {
    const first = makeFileValue('private-first-file'), denied = makeFileValue('private-denied-file');
    const last = makeFileValue('private-last-file');
    const seen: FileValue[] = [];
    let source: PageSourceContext | undefined, current: ResolvedIdentity | undefined, bound: RowQueryRunner | undefined;
    let scopes = 0, reads = 0, hookFinished = false;
    const scope: PageReadScope = {
      query: async function (this: unknown, invocation, model, args) {
        assert.equal(this, scope); assert.equal(invocation, current); assert.equal(model, 'TestApp.Documents');
        assert.deepEqual(args, { limit: 25 }); reads++; return { rows: [], columns: [] };
      },
      onQueryBound: async function (this: unknown, query) {
        assert.equal(this, scope); bound = query; await Promise.resolve(); hookFinished = true;
      },
      presentFile: async function (this: unknown, file) {
        assert.equal(this, scope); assert.equal(hookFinished, true);
        seen.push(file);
        if (file === denied) return null;
        assert.ok(file === first || file === last);
        return file === first ? { href: '/files/open-first', name: 'First document' } :
          { href: '/files/open-last', name: 'Last document' };
      },
    };
    const page: PageDescriptor = { owner: 'TestApp', path: '/file-text', title: 'Files',
      admit: async original => { source = original as PageSourceContext; return {}; },
      render: async context => {
        assert.equal(context.principal, current); assert.equal(context.invocation, current);
        assert.equal(context.actor, source!.actor); assert.equal(context.team, source!.team);
        assert.equal(context.query, bound);
        await context.query('forged renderer identity', 'TestApp.Documents', {});
        const html = await text({ context, values: [[first, denied, first, last]] });
        assert.equal((html.match(/href="\/files\/open-first"/g) ?? []).length, 2);
        assert.equal((html.match(/href="\/files\/open-last"/g) ?? []).length, 1);
        assert.ok(html.includes('File unavailable'));
        assert.ok(html.indexOf('First document') < html.indexOf('File unavailable'));
        assert.ok(html.indexOf('File unavailable') < html.lastIndexOf('First document'));
        assert.ok(html.lastIndexOf('First document') < html.indexOf('Last document'));
        for (const file of [first, denied, last]) assert.ok(!html.includes(file.id));
        return html;
      },
    };
    const { deps, identity } = await createTestDeps({ descriptors: [page] });
    const response = await handlePageRequest({ ...deps,
      createReadScope: (principal: ResolvedIdentity, admitted: PageSourceContext) => {
        scopes++; current = principal; assert.equal(admitted, source);
        assert.equal(principal.actor?.user_id, identity.userId); assert.equal(principal.team?.team_id, identity.teamId);
        return scope;
      },
    }, testRequest(`/file-text?team=${identity.teamId}`, { cookie: identity.cookie,
      ...(partial ? { headers: { 'HX-Request': 'true' } } : {}) }));
    assert.equal(response.status, 200); assert.ok((await response.text()).includes('File unavailable'));
    assert.equal(scopes, 1); assert.equal(reads, 1);
    assert.equal(seen.length, 4);
    for (const [index, expected] of [first, denied, first, last].entries()) assert.equal(seen[index], expected);
  }
});

test('File presenter context comes only from explicit trusted input and never source extras', async () => {
  const principal = fakeIdentity(), file = makeFileValue('private-source-file');
  let forgedCalls = 0, trustedCalls = 0;
  const forged: PageFilePresenter = async () => { forgedCalls++; return { href: 'https://forged.example/file' }; };
  const trusted: PageFilePresenter = async actual => { assert.equal(actual, file); trustedCalls++; return null; };
  const input = { request: testRequest('/files'), pathname: '/files', isPartial: true,
    appDefaultLocale: 'en', csrfToken: '', principal, query: fakeQuery(),
    source: { ...buildPageSourceContext(principal), presentFile: forged } };
  const absent = buildPresentationContext(input);
  assert.equal(Object.hasOwn(absent, 'presentFile'), false);
  await assert.rejects(text({ context: absent, values: [[file]] }), /source-bound presenter/);
  assert.equal(forgedCalls, 0);
  const explicit = buildPresentationContext({ ...input, presentFile: trusted });
  assert.equal(explicit.presentFile, trusted);
  const html = await text({ context: explicit, values: [[file]] });
  assert.ok(html.includes('File unavailable')); assert.ok(!html.includes(file.id)); assert.ok(!html.includes('href='));
  assert.equal(trustedCalls, 1); assert.equal(forgedCalls, 0);
});

test('full and partial File text without an installed presenter refuse rather than invent a link', async () => {
  for (const partial of [false, true]) {
    const file = makeFileValue('never-disclose-file-id');
    const page: PageDescriptor = { owner: 'TestApp', path: '/missing-file-presenter', title: 'Files',
      admit: async () => ({}), render: context => text({ context, values: [[file]] }) };
    const { deps } = await createTestDeps({ descriptors: [page] });
    const response = await handlePageRequest(deps, testRequest('/missing-file-presenter',
      partial ? { headers: { 'HX-Request': 'true' } } : {}));
    assert.equal(response.status, 422);
    const body = await response.text();
    assert.ok(!body.includes(file.id)); assert.ok(!body.includes('href=')); assert.ok(!body.includes('source-bound presenter'));
  }
});


test('full and partial repeated details drawers select only current queried rows and retain enclosing row context', async () => {
  for (const partial of [false, true]) {
    const occurrence = 'page:/details/repeated:é';
    const rows: RowView[] = [
      { id: 'row-one', version: '7', fields: { title: 'First' } },
      { id: 'row-two', version: '9', fields: { title: 'Second' } },
    ];
    const parent: RowView = { id: 'parent-current', version: '3', fields: { title: 'Enclosing parent' } };
    let returned: readonly RowView[] = rows, queryCalls = 0, scopes = 0;
    let principal: ResolvedIdentity | undefined, source: PageSourceContext | undefined;
    const bodies: { row: RowView; context: PresentationContext; parent: RowView }[] = [];
    const page: PageDescriptor = { owner: 'TestApp', path: '/details', title: 'Details',
      admit: async original => {
        source = original as PageSourceContext;
        if (!source.canonical.builtinRoles.includes('members')) throw new IdentityError('forbidden', 'Members only.');
        return {};
      },
      render: async context => {
        assert.equal(context.principal, principal); assert.equal(context.actor, source!.actor);
        const result = await context.query(context.invocation, 'TestApp.Item', { limit: 2 });
        assert.equal(result.rows, returned);
        const html: string[] = [];
        for (const record of result.rows) html.push(await detailsDrawer({ context, occurrence,
          caption: 'Inspect item', record,
          renderBody: async (actual, originalContext) => {
            assert.equal(actual, record); assert.equal(originalContext, context);
            assert.equal(actual.version, record.version);
            bodies.push({ row: actual, context: originalContext, parent });
            await Promise.resolve();
            return [`<p data-details-body="${actual.id}">${parent.id}:${actual.id}:${actual.version}</p>`];
          },
        }));
        return html.join('');
      },
    };
    const { deps, identity } = await createTestDeps({ descriptors: [page] });
    const scoped = { ...deps, createReadScope: (current: ResolvedIdentity, admitted: PageSourceContext) => {
      scopes++; principal = current; assert.equal(admitted, source);
      return { query: async (invocation: unknown, model: string, args: unknown) => {
        assert.equal(invocation, current); assert.equal(model, 'TestApp.Item'); assert.deepEqual(args, { limit: 2 });
        queryCalls++; return { rows: returned, columns: [] };
      } };
    } };
    const request = (params: URLSearchParams) => testRequest(`/details?${params}`, { cookie: identity.cookie,
      ...(partial ? { headers: { 'HX-Request': 'true' } } : {}) });
    const params = new URLSearchParams([['team', identity.teamId], ['q', 'keep me'], ['can-row:sibling', 'other-row']]);
    let response = await handlePageRequest(scoped, request(params));
    assert.equal(response.status, 200);
    const closedHtml = await response.text(); assert.equal(bodies.length, 0); assert.ok(!closedHtml.includes('data-details-body'));
    const openers = [...closedHtml.matchAll(/href="([^"]+)"/g)].map(match => match[1]!.replace(/&amp;/g, '&'))
      .map(href => new URL(href, 'https://component.invalid')).filter(url => url.searchParams.has(`can-row:${occurrence}`));
    assert.equal(openers.length, 2);
    assert.deepEqual(openers.map(url => url.searchParams.get(`can-row:${occurrence}`)), rows.map(row => row.id));
    for (const url of openers) {
      assert.equal(url.pathname, '/details'); assert.equal(url.searchParams.get('team'), identity.teamId);
      assert.equal(url.searchParams.get('q'), 'keep me'); assert.equal(url.searchParams.get('can-row:sibling'), 'other-row');
    }
    const selected = new URLSearchParams(openers[1]!.search);
    response = await handlePageRequest(scoped, request(selected)); assert.equal(response.status, 200);
    const selectedHtml = await response.text();
    assert.equal(bodies.length, 1); assert.equal(bodies[0]!.row, rows[1]); assert.equal(bodies[0]!.parent, parent);
    assert.ok(selectedHtml.includes('parent-current:row-two:9')); assert.ok(!selectedHtml.includes('data-details-body="row-one"'));
    returned = [rows[0]!];
    response = await handlePageRequest(scoped, request(selected)); assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes('data-details-body')); assert.equal(bodies.length, 1);
    returned = rows;
    for (const [key, value] of [[`can-row:${occurrence}`, 'forged-row-id'], ['can-row:foreign-occurrence', 'row-two']] as const) {
      const stale = new URLSearchParams(params); stale.set(key, value);
      response = await handlePageRequest(scoped, request(stale)); assert.equal(response.status, 200);
      assert.ok(!(await response.text()).includes('data-details-body')); assert.equal(bodies.length, 1);
    }
    assert.equal(queryCalls, 5); assert.equal(scopes, 5);
    const denied = await handlePageRequest(scoped, testRequest(`/details?${selected}`,
      partial ? { headers: { 'HX-Request': 'true' } } : {}));
    assert.equal(denied.status, 403); assert.equal(queryCalls, 5); assert.equal(scopes, 5); assert.equal(bodies.length, 1);
  }
});


test('page read scopes close once with their receiver after awaited full partial and HEAD presentation', async () => {
  const principal = fakeIdentity();
  let forgedCloses = 0;
  const forgedContext = buildPresentationContext({ request: testRequest('/scope-close'), pathname: '/scope-close',
    isPartial: false, appDefaultLocale: 'en', csrfToken: '', principal, query: fakeQuery(),
    source: { ...buildPageSourceContext(principal), close: () => { forgedCloses++; } } as PageSourceContext });
  assert.equal(Object.hasOwn(forgedContext, 'close'), false); assert.equal(forgedCloses, 0);
  for (const kind of ['full', 'partial', 'HEAD'] as const) {
    const events: string[] = [];
    const file = makeFileValue('scope-lifecycle-file');
    let closes = 0, scopes = 0;
    const scope: PageReadScope = { query: fakeQuery(),
      presentFile: async function (this: unknown, original) {
        assert.equal(this, scope); assert.equal(original, file);
        events.push('present-start'); await Promise.resolve(); events.push('present-done');
        return { href: '/authorized-file-open', name: 'Authorized file' };
      },
      close: async function (this: unknown) {
        assert.equal(this, scope); closes++;
        assert.deepEqual(events, ['render-start', 'present-start', 'present-done', 'render-done']);
        events.push('close-start'); await Promise.resolve(); events.push('close-done');
      },
    };
    const page: PageDescriptor = { owner: 'TestApp', path: '/scope-close', title: 'Scoped presentation',
      admit: async () => ({}), render: async context => {
        assert.equal(Object.hasOwn(context, 'close'), false);
        assert.equal(Object.hasOwn(context.canonical ?? {}, 'close'), false);
        events.push('render-start');
        const html = await text({ context, values: [file] });
        events.push('render-done'); return html;
      } };
    const { deps } = await createTestDeps({ descriptors: [page] });
    const response = await handlePageRequest({ ...deps, createReadScope: () => { scopes++; return scope; } },
      testRequest('/scope-close', { ...(kind === 'HEAD' ? { method: 'HEAD' } : {}),
        ...(kind === 'partial' ? { headers: { 'HX-Request': 'true' } } : {}) }));
    assert.equal(response.status, 200); assert.equal(scopes, 1); assert.equal(closes, 1);
    assert.equal(events.at(-1), 'close-done');
    const body = await response.text();
    if (kind === 'HEAD') assert.equal(body, ''); else assert.ok(body.includes('Authorized file'));
  }
});

test('page scope failures close only acquired scopes and sanitize asynchronous cleanup failures', async () => {
  for (const partial of [false, true]) {
    for (const failure of ['bind', 'render', 'factory', 'close'] as const) {
      const events: string[] = [];
      let closes = 0, renders = 0;
      const scope: PageReadScope = { query: fakeQuery(),
        onQueryBound: async function (this: unknown) {
          assert.equal(this, scope); events.push('bind'); await Promise.resolve();
          if (failure === 'bind') throw new IdentityError('forbidden', 'Scope binding denied.');
        },
        close: async function (this: unknown) {
          assert.equal(this, scope); closes++; events.push('close'); await Promise.resolve();
          if (failure === 'close') throw new Error('PRIVATE-cleanup-sentinel');
        },
      };
      const page: PageDescriptor = { owner: 'TestApp', path: '/scope-failure', title: 'Scope failure',
        admit: async () => ({}), render: async () => {
          renders++; events.push('render'); await Promise.resolve();
          if (failure === 'render') throw new IdentityError('forbidden', 'Scope rendering denied.');
          return '<p>successful scoped body</p>';
        } };
      const { deps } = await createTestDeps({ descriptors: [page] });
      const response = await handlePageRequest({ ...deps, createReadScope: async () => {
        events.push('factory'); await Promise.resolve();
        if (failure === 'factory') throw new Error('PRIVATE-factory-sentinel');
        return scope;
      } }, testRequest('/scope-failure', partial ? { headers: { 'HX-Request': 'true' } } : {}));
      assert.equal(closes, failure === 'factory' ? 0 : 1);
      assert.equal(renders, failure === 'bind' || failure === 'factory' ? 0 : 1);
      if (failure === 'bind' || failure === 'render') {
        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { code: 'forbidden',
          message: failure === 'bind' ? 'Scope binding denied.' : 'Scope rendering denied.', retryable: false });
      } else {
        assert.equal(response.status, 422);
        const body = await response.text();
        assert.ok(!body.includes('PRIVATE-')); assert.ok(!body.includes('successful scoped body'));
      }
      assert.deepEqual(events, failure === 'factory' ? ['factory'] :
        failure === 'bind' ? ['factory', 'bind', 'close'] : ['factory', 'bind', 'render', 'close']);
    }
  }
});

test('closing the actual page scope withholds an unawaited pending File presentation', async () => {
  for (const partial of [false, true]) {
    const file = makeFileValue('pending-private-file');
    let closed = false, closes = 0, calls = 0;
    let associations = new WeakMap<FileValue, boolean>(); associations.set(file, true);
    let release!: (value: Awaited<ReturnType<PageFilePresenter>>) => void;
    let pending: ReturnType<PageFilePresenter> | undefined, captured: PresentationContext | undefined;
    const scope: PageReadScope = { query: fakeQuery(),
      presentFile: async function (this: unknown, original) {
        assert.equal(this, scope);
        if (closed || associations.get(original) !== true) return null;
        calls++;
        const view = await new Promise<Awaited<ReturnType<PageFilePresenter>>>(resolve => { release = resolve; });
        return closed || associations.get(original) !== true ? null : view;
      },
      close: async function (this: unknown) {
        assert.equal(this, scope); closes++; closed = true; associations = new WeakMap(); await Promise.resolve();
      },
    };
    const page: PageDescriptor = { owner: 'TestApp', path: '/pending-file', title: 'Pending file',
      admit: async () => ({}), render: async context => {
        captured = context; pending = context.presentFile!(file);
        assert.equal(calls, 1); return '<p>bounded page body</p>';
      } };
    const { deps } = await createTestDeps({ descriptors: [page] });
    const response = await handlePageRequest({ ...deps, createReadScope: () => scope },
      testRequest('/pending-file', partial ? { headers: { 'HX-Request': 'true' } } : {}));
    assert.equal(response.status, 200); assert.equal(closes, 1); assert.equal(closed, true);
    release({ href: '/late-file-link', name: 'late private presentation' });
    assert.equal(await pending, null);
    assert.equal(await captured!.presentFile!(file), null); assert.equal(calls, 1);
    const body = await response.text(); assert.ok(!body.includes('late-file-link')); assert.ok(!body.includes(file.id));
  }
});


test('image resolver context accepts only explicit trusted input and strips source extras', async () => {
  const principal = fakeIdentity();
  const row: RowView = { id: 'current-image-row', version: '4', fields: {} };
  const locator = { model: 'TestApp.Image', record: row, field: 'image' };
  let forgedCalls = 0, trustedCalls = 0;
  const forged: PageFileImageResolver = async () => { forgedCalls++; return { previewUrl: '/forged-preview', originalUrl: '/forged-original' }; };
  const trusted: PageFileImageResolver = async actual => { assert.equal(actual, locator); trustedCalls++; return null; };
  const input = { request: testRequest('/images'), pathname: '/images', isPartial: true,
    appDefaultLocale: 'en', csrfToken: '', principal, query: fakeQuery(),
    source: { ...buildPageSourceContext(principal), resolveFileImage: forged, resolveCaller: forged } };
  const absent = buildPresentationContext(input);
  assert.equal(Object.hasOwn(absent, 'resolveFileImage'), false);
  assert.equal(Object.hasOwn(absent, 'resolveCaller'), false);
  const explicit = buildPresentationContext({ ...input, resolveFileImage: trusted });
  assert.equal(explicit.resolveFileImage, trusted);
  assert.equal(await explicit.resolveFileImage!(locator), null);
  assert.equal(trustedCalls, 1); assert.equal(forgedCalls, 0);
});

test('full and partial galleries consume admitted image resolver rows with the original scope and terminal close', async () => {
  for (const partial of [false, true]) {
    for (const output of [{ previewUrl: '/authorized-preview', originalUrl: '/authorized-original' }, null]) {
      const row: RowView = { id: 'current-image-row', version: '8', fields: { image: makeFileValue('original-image-file') } };
      const locator = { model: 'TestApp.Image', record: row, field: 'image' };
      let current: ResolvedIdentity | undefined, source: PageSourceContext | undefined;
      let queries = 0, resolves = 0, closes = 0;
      const events: string[] = [];
      const scope: PageReadScope = {
        query: async function (this: unknown, invocation, model, args) {
          assert.equal(this, scope); assert.equal(invocation, current); assert.equal(model, locator.model);
          assert.deepEqual(args, { occurrence: 'image-scope-gallery', limit: 25 }); queries++;
          return { rows: [row], columns: [{ field: 'image', type: 'file', label: 'Image' }] };
        },
        resolveFileImage: async function (this: unknown, actual) {
          assert.equal(this, scope); assert.equal(actual.record, row);
          assert.equal(actual.model, locator.model); assert.equal(actual.field, locator.field);
          resolves++; events.push('resolve-start'); await Promise.resolve(); events.push('resolve-done');
          return output;
        },
        close: async function (this: unknown) {
          assert.equal(this, scope); closes++;
          assert.deepEqual(events, ['resolve-start', 'resolve-done', 'render-done']);
          await Promise.resolve(); events.push('close-done');
        },
      };
      const page: PageDescriptor = { owner: 'TestApp', path: '/image-scope', title: 'Images',
        admit: async original => { source = original as PageSourceContext; return {}; },
        render: async context => {
          assert.equal(context.principal, current); assert.equal(context.actor, source!.actor);
          assert.equal(Object.hasOwn(context, 'close'), false);
          let bodies = 0;
          const html = await gallery({ context, model: locator.model, image: locator.field,
            occurrence: 'image-scope-gallery', renderRow: (actual, view) => {
              assert.equal(actual, row); assert.equal(view, context); assert.equal(actual.version, '8');
              bodies++; return ['<p>Original image row body</p>'];
            } });
          assert.equal(bodies, 1);
          if (output === null) {
            assert.ok(html.includes('Image unavailable'));
            assert.ok(!html.includes('data-can-gallery-preview data-can-preview-url'));
          } else {
            assert.ok(html.includes('data-can-preview-url="/authorized-preview"'));
            assert.ok(html.includes('data-can-original-url="/authorized-original"'));
            assert.ok(html.includes('data-can-gallery-original href="/authorized-original"'));
          }
          events.push('render-done'); return html;
        },
      };
      const { deps, identity } = await createTestDeps({ descriptors: [page] });
      const response = await handlePageRequest({ ...deps, createReadScope: (principal: ResolvedIdentity, admitted: PageSourceContext) => {
        current = principal; assert.equal(admitted, source);
        assert.equal(principal.actor?.user_id, identity.userId); assert.equal(principal.team?.team_id, identity.teamId);
        return scope;
      } }, testRequest(`/image-scope?team=${identity.teamId}`, { cookie: identity.cookie,
        ...(partial ? { headers: { 'HX-Request': 'true' } } : {}) }));
      assert.equal(response.status, 200); assert.ok((await response.text()).includes('Original image row body'));
      assert.equal(queries, 1); assert.equal(resolves, 1); assert.equal(closes, 1);
      assert.equal(events.at(-1), 'close-done');
    }
  }
});


test('full and partial page scopes re-resolve captured browser credentials and observe current membership and revocation', async () => {
  const forged = () => { throw new Error('source resolver must not escape'); };
  const principal = fakeIdentity();
  const forgedSource = { ...buildPageSourceContext(principal), resolveCaller: forged };
  const isolated = buildPresentationContext({ request: testRequest('/current-caller'), pathname: '/current-caller',
    isPartial: true, appDefaultLocale: 'en', csrfToken: '', principal, query: fakeQuery(),
    source: forgedSource });
  assert.equal(Object.hasOwn(isolated, 'resolveCaller'), false);
  for (const partial of [false, true]) {
    let resolveCaller!: () => Promise<ResolvedIdentity>;
    let admitted: PageSourceContext | undefined, initial: ResolvedIdentity | undefined;
    let reads = 0, closes = 0;
    const page: PageDescriptor = { owner: 'TestApp', path: '/current-caller', title: 'Current caller',
      admit: async source => { admitted = source as PageSourceContext; return {}; },
      render: async context => {
        assert.equal(context.principal, initial); assert.equal(context.actor, admitted!.actor);
        assert.equal(Object.hasOwn(context, 'resolveCaller'), false);
        const before = await resolveCaller();
        assert.equal(before.actor?.user_id, identity.userId); assert.equal(before.team?.team_id, identity.teamId);
        assert.notEqual(before, initial);
        const membership = await identity.store.findMembership(identity.teamId, identity.userId);
        assert.ok(membership);
        await Promise.resolve(); // Stand-in async host step; no File authority is simulated.
        const changedRoles = [{ role: 'TestApp.changed_role', granted_at: initial!.admitted_at,
          granted_by: identity.userId }];
        await identity.store.setMembershipRoles(membership.membership_id, changedRoles);
        request.headers.set('cookie', 'can_session=poisoned-replacement');
        request.headers.set('authorization', 'Bearer foreign-grant');
        const after = await resolveCaller();
        assert.equal(after.actor?.user_id, identity.userId); assert.equal(after.team?.team_id, identity.teamId);
        assert.deepEqual(after.membership?.roles, changedRoles);
        await identity.store.revokeUserSessions(identity.userId);
        await assert.rejects(resolveCaller(), error => error instanceof IdentityError);
        return '<p>Current browser caller checked</p>';
      },
    };
    const { deps, identity } = await createTestDeps({ descriptors: [page] });
    const originalStore = identity.store;
    const store = { ...originalStore, async findSessionByTokenHash(hash: string) {
      reads++; return originalStore.findSessionByTokenHash(hash);
    } };
    const scope: PageReadScope = { query: fakeQuery(), close: async function (this: unknown) {
      assert.equal(this, scope); closes++;
      const atClose = reads;
      await assert.rejects(resolveCaller(), /Page read scope is closed/);
      assert.equal(reads, atClose);
    } };
    const request = testRequest(`/current-caller?team=${identity.teamId}`, { cookie: identity.cookie,
      ...(partial ? { headers: { 'HX-Request': 'true' } } : {}) });
    const response = await handlePageRequest({ ...deps, identity: { store },
      createReadScope: (current: ResolvedIdentity, source: PageSourceContext, resolve) => {
        initial = current; assert.equal(source, admitted); resolveCaller = resolve; return scope;
      } }, request);
    assert.equal(response.status, 200); assert.ok((await response.text()).includes('Current browser caller checked'));
    assert.equal(closes, 1);
    const afterClose = reads;
    await assert.rejects(resolveCaller(), /Page read scope is closed/);
    assert.equal(reads, afterClose);
  }
});

test('page scope termination withholds pending current-caller resolution and late calls without another store read', async () => {
  for (const partial of [false, true]) {
    let resolveCaller!: () => Promise<ResolvedIdentity>;
    let suspend = false, reads = 0, closes = 0;
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let pending!: Promise<{ value?: ResolvedIdentity; error?: unknown }>;
    const page: PageDescriptor = { owner: 'TestApp', path: '/pending-caller', title: 'Pending caller',
      admit: async () => ({}), render: async context => {
        assert.equal(Object.hasOwn(context, 'resolveCaller'), false);
        suspend = true;
        pending = resolveCaller().then(value => ({ value }), error => ({ error }));
        await entered;
        return '<p>Scope ended with a pending host read</p>';
      } };
    const { deps, identity } = await createTestDeps({ descriptors: [page] });
    const originalStore = identity.store;
    const store = { ...originalStore, async findSessionByTokenHash(hash: string) {
      reads++;
      const value = await originalStore.findSessionByTokenHash(hash);
      if (suspend) { enter(); await gate; }
      return value;
    } };
    const scope: PageReadScope = { query: fakeQuery(), close: async function (this: unknown) {
      assert.equal(this, scope); closes++; await Promise.resolve();
    } };
    const response = await handlePageRequest({ ...deps, identity: { store },
      createReadScope: (_current: ResolvedIdentity, _source: PageSourceContext, resolve) => {
        resolveCaller = resolve; return scope;
      } }, testRequest(`/pending-caller?team=${identity.teamId}`, { cookie: identity.cookie,
        ...(partial ? { headers: { 'HX-Request': 'true' } } : {}) }));
    assert.equal(response.status, 200); assert.equal(closes, 1);
    const afterClose = reads;
    await assert.rejects(resolveCaller(), /Page read scope is closed/);
    assert.equal(reads, afterClose);
    release();
    const result = await pending;
    assert.equal(Object.hasOwn(result, 'value'), false);
    assert.ok(result.error instanceof IdentityError); assert.match(result.error.message, /Page read scope is closed/);
  }
});
