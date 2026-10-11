/** Real Memory State/Identity presentation component; no native host/profile claim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PageDescriptor, PageReadScope, PageSourceContext, ResolvedIdentity, RowView } from '@canlang/contracts';
import { handlePageRequest } from '@canlang/interfaces';
import { createTestDeps, testRequest } from '@canlang/interfaces/testing';
import { calendar, history } from '@canlang/ui';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { buildModelTable, runMutationWrites } from '@canlang/state/mutation';
import { queryRecords, queryRecordHistoryForViewer } from '@canlang/state/query';
import { StateError } from '@canlang/state/errors';
import { field, modelDef, pipelineContext } from '@canlang/state/testing/mutation/fixtures';
import { asId, asModel, makeBatch } from '@canlang/state/testing/invocation/fixtures';
import { grant, modelPolicy, policyTable } from '@canlang/state/testing/query/fixtures';

test('admitted full and partial calendar rows render current-authorized State history and distinguish legacy or revoked reads', async () => {
  const model = asModel('Calendar.Booking');
  for (const partial of [false, true]) {
    let returnedRows: readonly RowView[] = [];
    let callbacks = 0, reads = 0;
    const accepted: Awaited<ReturnType<typeof queryRecordHistoryForViewer>>[] = [];
    const refusals: StateError[] = [];
    const descriptor: PageDescriptor = {
      owner: 'Calendar', path: '/bookings', title: 'Bookings',
      admit: async source => {
        const context = source as PageSourceContext;
        assert.ok(context.actor); assert.ok(context.team);
        return {};
      },
      render: async context => calendar({ kind: 'agenda', context, model,
        startField: 'starts', endField: 'ends', renderRow: async (row, view) => {
          callbacks++;
          assert.equal(view, context); assert.equal(view.isPartial, partial);
          assert.ok(returnedRows.some(original => original === row));
          assert.equal(row.version, row.id === 'booking' ? '2' : '1');
          assert.equal(Object.hasOwn(row.fields, 'hidden'), false);
          assert.equal(Object.hasOwn(row.fields, 'credential'), false);
          return [await history({ context: view, model, record: row })];
        } }),
    };
    const { deps, identity, logger } = await createTestDeps({ descriptors: [descriptor] });
    const store = createMemoryStorage();
    const table = buildModelTable([modelDef(model, { fields: {
      title: field(), starts: field(), ends: field(), hidden: field(), credential: field(),
    }, deleteMode: 'remove' })]);
    const policy = policyTable(modelPolicy(model, {
      grants: [grant('members', ['title', 'starts', 'ends'])], secretFields: [],
    }));
    let instant = 1_800_000_000_000;
    for (const [id, title, secretFields] of [
      ['booking', 'First title', ['credential']], ['legacy', 'Legacy title', undefined],
    ] as const) {
      const effects = await runMutationWrites({ store, table,
        context: pipelineContext({ operation: 'Calendar.Booking.create', actor: identity.userId,
          teamId: identity.teamId, now: instant++ }),
        writes: [{ op: 'create', model, id: asId(id), data: {
          title, starts: '2026-10-11T12:00:00Z', ends: '2026-10-11T13:00:00Z',
          hidden: 'hidden-original', credential: 'original-secret-credential',
        } }], ...(secretFields === undefined ? {} : { secretFields: new Map([[model, secretFields]]) }) });
      await store.commit(makeBatch(await store.readRevision(), effects));
    }
    const update = await runMutationWrites({ store, table,
      context: pipelineContext({ operation: 'Calendar.Booking.update', actor: identity.userId,
        teamId: identity.teamId, now: instant++ }),
      writes: [{ op: 'update', model, id: asId('booking'), data: { title: 'Second title' } }],
      secretFields: new Map([[model, []]]) });
    await store.commit(makeBatch(await store.readRevision(), update));
    assert.ok((await store.historyFor(model, asId('booking'))).every(entry => entry.auditProjection !== undefined));
    assert.equal((await store.historyFor(model, asId('legacy')))[0]!.auditProjection, undefined);
    const revision = await store.readRevision();
    const pageDeps = { ...deps, createReadScope: (principal: ResolvedIdentity) => {
      assert.equal(principal.actor?.user_id, identity.userId);
      assert.equal(principal.team?.team_id, identity.teamId);
      const caller = { actorUserId: identity.userId, teamId: identity.teamId };
      const scope: PageReadScope = {
        query: async (invocation, selectedModel) => {
          assert.equal(invocation, principal); assert.equal(selectedModel, model);
          const result = await queryRecords({ authority: 'viewer', model, policy,
            context: caller, memberships: identity.store, store });
          assert.equal(result.revision, revision);
          returnedRows = result.records.map(record => ({ id: record.id, version: String(record.version),
            fields: { ...record.data } }));
          return { rows: returnedRows, columns: [] };
        },
        readHistory: async locator => {
          reads++;
          assert.equal(locator.model, model);
          assert.ok(returnedRows.some(row => row === locator.record));
          try {
            const result = await queryRecordHistoryForViewer({ model, recordId: asId(locator.record.id),
              store, memberships: identity.store, policy, context: caller,
              readPolicies: new Map([[model, { by: 'members' as const }]]) });
            assert.equal(result.revision, revision);
            accepted.push(result); return result;
          } catch (error) {
            assert.ok(error instanceof StateError); refusals.push(error); throw error;
          }
        },
      };
      return scope;
    } };
    const request = () => testRequest(`/bookings?team=${identity.teamId}`, { cookie: identity.cookie,
      headers: partial ? { 'HX-Request': 'true' } : {} });
    const response = await handlePageRequest(pageDeps, request());
    const html = await response.text();
    assert.equal(response.status, 200, `${html}\n${JSON.stringify(logger.calls)}`);
    assert.match(html, /History/); assert.match(html, /unavailable/i);
    assert.equal((html.match(/data-can-history="unavailable"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /data-can-history="empty"/);
    assert.match(html, /<details/); assert.doesNotMatch(html, /<details[^>]*\sopen(?:[\s=>])/);
    assert.equal(callbacks, 2); assert.equal(reads, 2);
    assert.equal(accepted.length, 1); assert.equal(refusals.length, 1);
    assert.equal(refusals[0]!.code, 'validation');
    assert.deepEqual(accepted[0]!.entries.map(entry => [entry.change, entry.version, entry.before, entry.after]), [
      ['create', 1, null, { title: 'First title', starts: '2026-10-11T12:00:00Z', ends: '2026-10-11T13:00:00Z' }],
      ['update', 2, { title: 'First title', starts: '2026-10-11T12:00:00Z', ends: '2026-10-11T13:00:00Z' },
        { title: 'Second title', starts: '2026-10-11T12:00:00Z', ends: '2026-10-11T13:00:00Z' }],
    ]);
    assert.ok(html.indexOf('First title') < html.indexOf('Second title'));
    for (const result of accepted) for (const entry of result.entries) assert.equal(Object.hasOwn(entry, 'auditProjection'), false);
    for (const forbidden of ['auditProjection', 'hidden-original', 'original-secret-credential', 'Legacy title', refusals[0]!.message]) {
      assert.ok(!html.includes(forbidden), `withholds ${forbidden}`);
    }
    assert.ok(store.historyReadBounded);
    const bounded = store.historyReadBounded.bind(store);
    let revoked = false;
    store.historyReadBounded = async input => {
      const entries = await bounded(input);
      if (!revoked) {
        revoked = true;
        const membership = await identity.store.findMembership(identity.teamId, identity.userId);
        assert.ok(membership); await identity.store.removeMembership(membership.membership_id);
      }
      return entries;
    };
    const before = accepted.length;
    const denied = await handlePageRequest(pageDeps, request());
    assert.equal(denied.status, 200);
    const deniedHtml = await denied.text();
    assert.equal(revoked, true); assert.equal(accepted.length, before);
    assert.match(deniedHtml, /unavailable/i);
    assert.equal((deniedHtml.match(/data-can-history="unavailable"/g) ?? []).length, 2);
    assert.doesNotMatch(deniedHtml, /data-can-history="empty"/);
    assert.equal(refusals.at(-2)!.code, 'forbidden');
    assert.equal(await store.readRevision(), revision);
    for (const forbidden of ['First title', 'Second title', 'auditProjection', 'hidden-original', 'original-secret-credential',
      ...refusals.map(error => error.message)]) assert.ok(!deniedHtml.includes(forbidden));
  }
});
