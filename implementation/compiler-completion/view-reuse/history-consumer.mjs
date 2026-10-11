import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root, artifactPath, scratch] = process.argv.slice(2);
const require = createRequire(resolve(root, 'package.json'));
const load = specifier => import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile} = await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules, importVerifiedAssemblyModule} = await load('@canlang/cloudflare/runtime/modules');
const {loadCanonicalDescriptors, invokeMutationCanonical, queryPageRowsCanonical} = await load('@canlang/cloudflare/runtime/invoke');
const {handlePageRequest} = await load('@canlang/interfaces');
const {catalogFromArtifactOperations} = await load('@canlang/interfaces/http/operations');
const {createTestDeps, createGrantFixture, testRequest} = await load('@canlang/interfaces/testing');
const {resolveIdentity} = await load('@canlang/identity');
const {createMemoryStorage} = await load('@canlang/state/storage/memory');
const {queryRecordHistoryForViewer} = await load('@canlang/state/query');
const {StateError} = await load('@canlang/state/errors');
const {uuidv7} = await load('@canlang/state/testing/invocation/fixtures');

const input = loadArtifactFile(artifactPath), artifact = input.artifact;
const artifactBefore = JSON.stringify(artifact);
const fixture = resolve(root, 'compiler/tests/fixtures/row-history.can');
const bytes = readFileSync(fixture), digest = createHash('sha256').update(bytes).digest('hex');
assert.ok(artifact.sources.some(source => resolve(source.path) === fixture && source.sha256 === digest));
assert.equal(artifact.modules[0].map.sourcesContent[0], bytes.toString());
const asm = await assembleModules(input, {
  workDir: resolve(scratch, 'history-modules'),
  stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href,
});
const namespace = await importVerifiedAssemblyModule(asm, artifact.modules[0].path, artifact);
const definition = namespace.appDefinition, app = 'RowHistory', model = `${app}.Entry`;
assert.equal(definition.id, app);
assert.equal(definition.pages.length, 1);
const descriptor = definition.pages[0];
assert.equal(descriptor.path, '/history');
assert.equal(artifact.callables.some(callable => callable.id === `${app}.audit_body`), false);
assert.equal(artifact.operations.some(operation => operation.name === `${app}.audit_body`), false);
const loaded = await loadCanonicalDescriptors(asm, artifact);
assert.deepEqual(loaded.models.map(value => value.name), [model]);
assert.deepEqual(loaded.secretFields.get(model), ['token']);
const declaration = definition.models[model];
assert.deepEqual(declaration.readGrants, [{rule: 'Entry.read.1', by: ['members']}]);
assert.equal(declaration.fields.token.type, 'secret');
assert.equal(loaded.containment.get(model)?.parent, undefined);
const readPolicies = new Map([[model, {by: declaration.readGrants[0].by[0]}]]);
const {deps, identity, logger} = await createTestDeps({descriptors: [descriptor]});
const {token} = await createGrantFixture(identity);
const principal = await resolveIdentity(identity.store, {mcp_grant_token: token});
assert.equal(principal.actor.user_id, identity.userId);
assert.equal(principal.team.team_id, identity.teamId);
const store = createMemoryStorage();
let now = Date.now(), sequence = 0;
const nextId = () => uuidv7(now, ++sequence);
const options = {artifact, asm, app, identity: principal, source: 'worker', store,
  memberships: identity.store, now: () => now};
const rows = [];
for (const label of ['First', 'Hidden', 'Last']) {
  const id = nextId();
  const result = await invokeMutationCanonical({...options, operation: `${model}.create`, operationId: id, inputs: {label}});
  assert.equal(result.status, 'committed');
  const stored = await store.load(model, id);
  assert.ok(stored); assert.equal(stored.version, 1);
  assert.match(stored.data.token, /^[a-f0-9]{64}$/);
  rows.push(stored);
}
now++;
const revised = await invokeMutationCanonical({...options, operation: `${app}.revise`, operationId: nextId(),
  inputs: {entry: {id: rows[0].id, version: '1'}}});
assert.equal(revised.status, 'committed');
const revision = await store.readRevision();
const catalog = catalogFromArtifactOperations(artifact);
let mode = 'normal', trace = [], originalRows = [], accepted = [], refused = [], boundedReads = 0;
const bounded = store.historyReadBounded.bind(store);
let revokeDuringRead = false;
store.historyReadBounded = async request => {
  boundedReads++;
  const result = await bounded(request);
  if (revokeDuringRead) {
    revokeDuringRead = false;
    const membership = await identity.store.findMembership(identity.teamId, identity.userId);
    assert.ok(membership);
    await identity.store.removeMembership(membership.membership_id);
  }
  return result;
};
const pageDeps = {...deps,
  app: {...deps.app, appId: app, brand: 'Row history', ownerLabels: new Map([[app, 'Row history']])},
  catalog: {...catalog, derivedFor: operation => {
    trace.push(['form', operation]);
    return catalog.derivedFor(operation);
  }},
  createReadScope: current => {
    assert.equal(current.actor.user_id, identity.userId);
    assert.equal(current.team.team_id, identity.teamId);
    return {
      query: async (invocation, selectedModel, args) => {
        assert.equal(invocation, current);
        assert.equal(selectedModel, model);
        const result = await queryPageRowsCanonical({...options, identity: current, model: selectedModel, args});
        originalRows = result.rows;
        assert.deepEqual(originalRows.map(row => row.id), rows.map(row => row.id));
        assert.deepEqual(originalRows.map(row => row.version), ['2', '1', '1']);
        for (const row of originalRows) {
          assert.equal(typeof row.version, 'string');
          assert.deepEqual(Object.keys(row.fields), ['label']);
          assert.equal(Object.hasOwn(row.fields, 'token'), false);
        }
        return result;
      },
      readHistory: async locator => {
        assert.equal(locator.model, model);
        assert.ok(originalRows.some(row => row === locator.record), 'history receives the exact original queried RowView');
        assert.equal(typeof locator.record.version, 'string', 'business-row BigInt cannot replace the original row version');
        assert.notEqual(locator.record.fields.label, 'Hidden', 'source gate suppresses the reader');
        trace.push(['history', locator.record.id]);
        if (mode === 'unexpected') throw new Error('history-runtime-sentinel');
        try {
          const result = await queryRecordHistoryForViewer({model, recordId: locator.record.id, store,
            memberships: identity.store, policy: loaded.policy, readPolicies,
            context: {actorUserId: current.actor.user_id, teamId: current.team.team_id}});
          assert.equal(result.revision, revision);
          for (const entry of result.entries) {
            assert.equal(Object.hasOwn(entry, 'auditProjection'), false);
            for (const values of [entry.before, entry.after]) if (values !== null) assert.deepEqual(Object.keys(values), ['label']);
          }
          accepted.push(result);
          return result;
        } catch (error) {
          assert.ok(error instanceof StateError); refused.push(error); throw error;
        }
      },
    };
  },
};
const request = () => testRequest(`/history?team=${identity.teamId}`, {cookie: identity.cookie, headers: {'HX-Request': 'true'}});
const render = async selectedMode => {
  mode = selectedMode; trace = []; accepted = []; refused = [];
  const response = await handlePageRequest(pageDeps, request());
  return {response, html: await response.text()};
};
const normal = await render('normal');
assert.equal(normal.response.status, 200, `${normal.html}\n${JSON.stringify(logger.calls)}`);
assert.deepEqual(trace, [
  ['history', rows[0].id], ['history', rows[0].id], ['form', `${app}.save`],
  ['form', `${app}.save`],
  ['history', rows[2].id], ['history', rows[2].id], ['form', `${app}.save`],
], 'each source expansion reads once, before its later form, in collection row order');
assert.equal(accepted.length, 4); assert.equal(refused.length, 0); assert.equal(boundedReads, 4);
assert.deepEqual(accepted[0].entries.map(entry => [entry.change, entry.version, entry.before, entry.after]), [
  ['create', 1, null, {label: 'First'}], ['update', 2, {label: 'First'}, {label: 'Revised'}],
]);
assert.deepEqual(accepted[1], accepted[0]);
assert.deepEqual(accepted[2].entries.map(entry => entry.after), [{label: 'Last'}]);
assert.deepEqual(accepted[3], accepted[2]);
assert.equal((normal.html.match(/action="\/api\/operations\/RowHistory.save"/g) ?? []).length, 3);
assert.equal((normal.html.match(/<summary[^>]*>History<\/summary>/g) ?? []).length, 4);
assert.match(normal.html, /<details/);
assert.doesNotMatch(normal.html, /<details[^>]*\sopen(?:[\s=>])/);
assert.doesNotMatch(normal.html, /data-can-history="(?:empty|unavailable)"/);
assert.ok(normal.html.indexOf('First') < normal.html.indexOf('Revised', normal.html.indexOf('First')));
for (const forbidden of ['auditProjection', ...rows.map(row => row.data.token)]) assert.ok(!normal.html.includes(forbidden));

const unexpected = await render('unexpected');
assert.equal(unexpected.response.status, 422);
assert.deepEqual(trace, [['history', rows[0].id]], 'an earlier history rejection suppresses the next view, later form and later collection rows');
assert.equal(accepted.length, 0); assert.equal(boundedReads, 4);
assert.ok(!unexpected.html.includes('history-runtime-sentinel'));

revokeDuringRead = true;
const denied = await render('normal');
assert.equal(denied.response.status, 200);
assert.equal(accepted.length, 0); assert.equal(refused.length, 4);
assert.equal(refused[0].code, 'forbidden');
assert.equal(boundedReads, 5, 'current membership denial stops subsequent physical history reads');
assert.equal((denied.html.match(/data-can-history="unavailable"/g) ?? []).length, 4);
assert.doesNotMatch(denied.html, /data-can-history="empty"/);
assert.doesNotMatch(denied.html, /<details[^>]*\sopen(?:[\s=>])/);
for (const forbidden of ['First', 'auditProjection', ...rows.map(row => row.data.token), ...refused.map(error => error.message)]) {
  assert.ok(!denied.html.includes(forbidden), `withholds ${forbidden}`);
}
assert.equal(await store.readRevision(), revision, 'presentations and refusals do not write State');
assert.equal(JSON.stringify(artifact), artifactBefore);
console.log('original CLI history: verified loader, Memory State/Identity, exact rows, current projection, gates, source order and refusal passed');
