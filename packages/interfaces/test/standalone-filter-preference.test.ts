/**
 * B16 standalone saved-preference filter consumer (CAN18-v1 REVIEW-19).
 *
 * The B7/B14 factory profile admitted `filter preferences.state` by
 * IR/strings only; the emitted `ui.filter({context,model,filter,defaults})`
 * fails in real @canlang/ui with `TypeError: Cannot read properties of
 * undefined (reading 'type')` because `filter()` owns the field-owner
 * `FilterProps` contract (field/idPrefix/mode), not a collection
 * descriptor. The repair emits the bound-tabs binding shape on the
 * standalone control (name, owned finite-choice options, the saved read,
 * its compare-and-set version, the caller POST target), and `filter()`
 * renders Filter presentation over that binding through the EXISTING
 * page-preference save path. This test drives the whole compiled path
 * the way the B9 bool-page consumer does: it compiles the committed
 * `test/fixtures/standalone-filter-preference.can` with the real `can`
 * binary (`CAN_COMPILER_BIN`, catalog `CAN_NATIVE_CATALOG`), stages the
 * EMITTED module bytes verbatim, imports the page descriptors named by
 * `artifact.pages`, and dispatches them through the real host seam
 * (`createHttpHandler` over `createTestDeps` + a real authorized
 * identity, real memory storage served by the EXISTING State query
 * adapter, and a versioned page-preference store).
 *
 * Staging note: the cloudflare `assembleModules` seam cannot be reused
 * here (`@canlang/cloudflare` depends on `@canlang/interfaces`, so
 * importing it would cycle). The bytes are staged unmodified under this
 * package's `dist` output, where the emitted bare `@canlang/ui` /
 * `@canlang/stdlib` imports resolve to the real installed workspace
 * builds (same as the B9 consumer).
 *
 * Proven here, all against the real emission (no transcribed shapes):
 * the standalone control renders the saved selection in authored
 * position ahead of its sibling list; an authorized save round-trips
 * through the EXISTING page-preference contract (caller-path POST with
 * CSRF plus compare-and-set version, 303 then serving); stale versions
 * conflict (409), bad CSRF is forbidden (403), bad values refuse (400);
 * the saved selection serves through the UNCHANGED sibling list
 * occurrence (typed predicate, request precedence, explicit clear);
 * a second app's ordinary same-named `state` preference keeps its own
 * meaning (module-scoped binding, independent save/serve); an explicit
 * bool `false` selection renders checked and serves (strict canonical
 * spelling, POST/store stay string-valued); malformed selectors and
 * anonymous callers refuse before any query.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type {
  ColumnMeta,
  CompileArtifact,
  ListQueryArgs,
  PageDescriptor,
  QueryPredicate,
  ResolvedIdentity,
  RowView,
} from '@canlang/contracts';
import { deriveCsrfToken } from '@canlang/identity';
import { queryRecords } from '@canlang/state/query/engine';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import type { PolicyTable } from '@canlang/state/policy/grants';
import type { MembershipReader } from '@canlang/state/policy/roles';
import { asModel, seedRows } from '@canlang/state/testing/query/fixtures';
import { createTestDeps, testRequest } from '../src/testing.js';
import { createHttpHandler } from '../src/http/routes.js';
import type { HttpSubHandlers } from '../src/http/routes.js';
import type { PagePreferenceKey, PagePreferenceStore } from '../src/ports.js';

const execFileAsync = promisify(execFile);
const FIXTURE = 'packages/interfaces/test/fixtures/standalone-filter-preference.can';
const JOB = 'Probe.Job';
const TASK = 'Other.Task';

function spySub(): HttpSubHandlers {
  const noop = async (_req: Request) => new Response('noop!', { status: 200 });
  return {
    operations: async (_req: Request, _op: string) => new Response('op!', { status: 200 }),
    auth: noop, uploads: noop, ingress: noop, oauth: noop,
  };
}

test('compiled standalone saved-preference filter renders, saves and serves through the host seam', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(testDir, '..', '..', '..', '..');
  const fixtureBytes = readFileSync(join(root, FIXTURE));
  const fixtureSha = createHash('sha256').update(fixtureBytes).digest('hex');

  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalog = process.env.CAN_NATIVE_CATALOG ??
    join(root, 'packages/cloudflare/dist/native-catalog.json');
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(compiler,
      ['compile', '--format=json', '--catalog', catalog, FIXTURE],
      { cwd: root, env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    const out = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    throw new Error(`standalone-filter fixture compile failed: ${String(out.message)} ` +
      `stdout=${String(out.stdout ?? '').slice(0, 2000)} stderr=${String(out.stderr ?? '').slice(0, 2000)}`);
  }
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!('diagnostics' in artifact), 'real fixture emits clean');
  const source = artifact.sources.find(entry => entry.path === FIXTURE);
  assert.ok(source && source.sha256 === fixtureSha, 'compiled source identity preserved');
  assert.equal(artifact.pages.length, 3);
  const refOf = (path: string) => {
    const ref = artifact.pages.find(entry => entry.path === path);
    assert.ok(ref, `page ${path} present in real artifact`);
    return ref;
  };
  const dRef = refOf('/d');
  const eRef = refOf('/e');
  const oRef = refOf('/other');
  assert.equal(dRef.owner, 'Probe');
  assert.equal(eRef.owner, 'Probe');
  assert.equal(oRef.owner, 'Other');

  // The repaired emission carries the owned-preference binding on every
  // standalone control — never the collection descriptor the
  // field-owner control cannot consume.
  const bindingStates = (artifact.modules.map(module => module.js).join('\n').match(/binding:\{name:"state"/g) ?? []).length;
  assert.equal(bindingStates, 2, 'both same-named state controls carry their own binding');
  const joint = artifact.modules.map(module => module.js).join('\n');
  assert.ok(joint.includes('binding:{name:"archived"'), 'bool control carries its preference binding');
  assert.ok(!joint.includes('filter({context:c,model:'), 'no collection-shaped filter call remains');

  // Canonical rendering columns from the COMPILE artifact's model fields
  // (never transcribed): every name, type and case comes from canonical
  // output, cross-checked against the emitted filter declarations.
  const columnsOf = (model: string, kinds: Record<string, 'string' | 'enum' | 'boolean'>): ColumnMeta[] => {
    const artifactModel = artifact.models?.find(entry => entry.name === model);
    assert.ok(artifactModel, `canonical model ${model} present in compile artifact`);
    return artifactModel.fields.map(field => {
      if (field.field.kind === 'string') {
        assert.equal(kinds[field.name], 'string');
        return { field: field.name, label: field.name, type: 'text' };
      }
      if (field.field.kind === 'enum') {
        assert.equal(kinds[field.name], 'enum');
        return {
          field: field.name, label: field.name, type: `enum:${model}.${field.name}`,
          valueLabels: Object.fromEntries(field.field.values.map(value => [value, value])),
        };
      }
      if (field.field.kind === 'boolean') {
        assert.equal(kinds[field.name], 'boolean');
        return {
          field: field.name, label: field.name, type: 'bool',
          valueLabels: { true: 'true', false: 'false' },
        };
      }
      throw new Error(`standalone-filter fixture needs a mapped column for ${field.name}`);
    });
  };
  const jobColumns = columnsOf(JOB, { location: 'string', state: 'enum', archived: 'boolean' });
  const taskColumns = columnsOf(TASK, { title: 'string', state: 'enum' });
  assert.ok(joint.includes('type:"enum:Probe.Job.state"'), 'sibling enum declaration matches emission');
  assert.ok(joint.includes('type:"bool"'), 'sibling bool declaration matches emission');
  assert.ok(joint.includes('type:"enum:Other.Task.state"'), 'second-app declaration matches emission');

  const stageDir = mkdtempSync(join(testDir, 'staged-standalone-filter-'));
  try {
    const stagedByModule = new Map<string, string>();
    for (const module of artifact.modules) {
      const stagedFile = join(stageDir, `${stagedByModule.size}.mjs`);
      writeFileSync(stagedFile, module.js);
      assert.equal(readFileSync(stagedFile, 'utf8'), module.js, 'staged bytes stay verbatim');
      stagedByModule.set(module.path, stagedFile);
    }
    const descriptorOf = async (ref: { module: string; export: string; path: string }) => {
      const stagedFile = stagedByModule.get(ref.module);
      assert.ok(stagedFile, `page module staged for ${ref.path}`);
      const namespace = await import(pathToFileURL(stagedFile).href) as Record<string, unknown>;
      const descriptor = namespace[ref.export] as PageDescriptor;
      assert.equal(descriptor.path, ref.path);
      assert.equal(typeof descriptor.admit, 'function');
      assert.equal(typeof descriptor.render, 'function');
      return { descriptor, namespace };
    };
    const dPage = await descriptorOf(dRef);
    const ePage = await descriptorOf(eRef);
    const oPage = await descriptorOf(oRef);
    const dProbe = dPage.descriptor;
    const eProbe = ePage.descriptor;
    const oOther = oPage.descriptor;
    assert.equal(dProbe.owner, 'Probe');
    assert.equal(eProbe.owner, 'Probe');
    assert.equal(oOther.owner, 'Other');

    // Each page preference descriptor is its own save contract anchor:
    // same-named fields across apps never share an entry.
    const fieldNamesOf = (descriptor: PageDescriptor): string[] =>
      (descriptor.preferenceFields ?? []).map(field => field.name);
    assert.deepEqual(fieldNamesOf(dProbe), ['state']);
    assert.deepEqual(fieldNamesOf(eProbe), ['archived']);
    assert.deepEqual(fieldNamesOf(oOther), ['state']);
    const dState = dProbe.preferenceFields![0]!;
    assert.deepEqual([...dState.options].sort(), ['closed', 'open']);
    assert.equal(dState.defaultValue, null);
    const eArchived = eProbe.preferenceFields![0]!;
    assert.deepEqual([...eArchived.options].sort(), ['false', 'true']);
    assert.equal(eArchived.defaultValue, null);
    const oState = oOther.preferenceFields![0]!;
    assert.deepEqual([...oState.options].sort(), ['closed', 'open']);
    assert.equal(oState.defaultValue, null);

    // Canonical viewer grants from the EMITTED app definitions: the
    // `readGrants` spellings are asserted, never transcribed.
    const policyOf = (namespace: Record<string, unknown>, model: string, fields: string[]): PolicyTable => {
      const appDefinition = (namespace as unknown as { appDefinition: {
        models: Record<string, {
          readGrants: { rule: string; by: string[] }[];
          fields: Record<string, unknown>;
        }>;
      } }).appDefinition;
      const canonicalModel = appDefinition.models[model];
      assert.ok(canonicalModel, `canonical model ${model} present in emitted app definition`);
      assert.equal(canonicalModel.readGrants.length, 1);
      assert.deepEqual(canonicalModel.readGrants[0]!.by, ['public']);
      assert.deepEqual([...Object.keys(canonicalModel.fields)].sort(), [...fields].sort());
      return buildPolicyTable([{
        model: asModel(model),
        secretFields: [],
        grants: [{ by: 'public', fields: Object.keys(canonicalModel.fields) }],
      }]);
    };
    const jobPolicy = policyOf(dPage.namespace, JOB, ['location', 'state', 'archived']);
    const taskPolicy = policyOf(oPage.namespace, TASK, ['title', 'state']);
    const serving = new Map<string, { policy: PolicyTable; columns: ColumnMeta[] }>([
      [JOB, { policy: jobPolicy, columns: jobColumns }],
      [TASK, { policy: taskPolicy, columns: taskColumns }],
    ]);

    const store = createMemoryStorage();
    await seedRows(store, asModel(JOB), [
      { id: 'job-a1', data: { location: 'HQ', state: 'open', archived: false } },
      { id: 'job-b1', data: { location: 'Depot', state: 'closed', archived: false } },
      { id: 'job-c1', data: { location: 'Harbor', state: 'open', archived: true } },
    ]);
    await seedRows(store, asModel(TASK), [
      { id: 'task-a1', data: { title: 'Alpha', state: 'open' } },
      { id: 'task-b1', data: { title: 'Beta', state: 'closed' } },
    ]);

    const rows = new Map<string, { value: string; version: string }>();
    const keyOf = (key: PagePreferenceKey) => JSON.stringify({
      appId: key.appId, actorUserId: key.actorUserId, teamId: key.teamId,
      owner: key.owner, field: key.field,
    });
    const preferences: PagePreferenceStore = {
      async read(key) { return rows.get(keyOf(key)) ?? null; },
      async save(input) {
        const key = keyOf(input);
        const before = rows.get(key);
        if ((before?.version ?? '0') !== input.expectedVersion) return false;
        rows.set(key, { value: input.value, version: String(BigInt(input.expectedVersion) + 1n) });
        return true;
      },
    };
    const { deps, identity } = await createTestDeps({ descriptors: [dProbe, eProbe, oOther] });
    // The REAL identity fixture store answers caller membership; public
    // grants admit without consulting it, but every lookup observes live
    // fixture state (no membership double).
    const memberships: MembershipReader = {
      findMembership: (teamId, userId) => identity.store.findMembership(teamId, userId),
    };
    let principal: ResolvedIdentity | undefined;
    const calls: { occurrence: unknown; where: unknown }[] = [];
    const scoped = {
      ...deps, preferences,
      createReadScope: (current: ResolvedIdentity) => {
        principal = current;
        return {
          query: async (invocation: unknown, model: string, args: ListQueryArgs) => {
            assert.equal(invocation, principal, 'query runs under the authorized principal');
            const served = serving.get(model);
            assert.ok(served, `query serves a canonical model: ${model}`);
            calls.push({ occurrence: args.occurrence, where: args.where });
            const caller = invocation as ResolvedIdentity;
            const viewed = await queryRecords({
              policy: served.policy,
              model: asModel(model),
              authority: 'viewer',
              context: {
                actorUserId: caller.actor?.user_id ?? null,
                teamId: caller.team?.team_id ?? null,
              },
              memberships,
              store,
              ...(args.where === undefined ? {} : { where: args.where as QueryPredicate }),
              ...(args.limit === undefined ? {} : { limit: args.limit }),
            });
            // Production projection: declared columns filtered to the
            // fields actually present in authorized projected rows.
            const visible = new Set(viewed.records.flatMap(record => Object.keys(record.data)));
            const rowViews: RowView[] = viewed.records.map(record => ({
              id: record.id,
              version: String(record.version),
              fields: { ...record.data },
            }));
            return {
              rows: rowViews,
              columns: served.columns.filter(column => visible.has(column.field)),
              ...(viewed.records.length === 0 ? {
                emptyDeclarations: served.columns.map(({ field, type }) => ({ field, type })),
              } : {}),
            };
          },
        };
      },
    };
    const handler = createHttpHandler(scoped, spySub());
    const get = async (pagePath: string, params: URLSearchParams, authed = true) => {
      const query = authed ? `team=${identity.teamId}&${params}` : params.toString();
      return handler(testRequest(`${pagePath}?${query}`, authed ? { cookie: identity.cookie } : {}));
    };
    const post = (pagePath: string, field: string, csrf: string, value: string, version: string) =>
      testRequest(`${pagePath}?team=${identity.teamId}`, {
        method: 'POST', cookie: identity.cookie,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, _version: version, [field]: value }),
      });

    // The standalone preference form: the single Filter-presentation
    // save form for one preference field (sibling lists keep their own
    // method=get occurrence controls, and the shell settings surface
    // keeps its select-based save form from the same descriptor).
    const standaloneFormOf = (html: string, field: string): { action: string; body: string } => {
      const forms = [...html.matchAll(/<form action="([^"]+)" method="post">([\s\S]*?)<\/form>/g)];
      const found = forms.filter(form => form[2] !== undefined &&
        form[2].includes('<div class="filter">') && form[2].includes(`name="${field}"`) &&
        form[2].includes('name="_version"'));
      assert.equal(found.length, 1, `one standalone saved-preference form renders for ${field}`);
      return { action: found[0]![1]!, body: found[0]![2]! };
    };
    const checkedOption = (body: string, value: string, label: string): boolean =>
      body.includes(`value="${value}" aria-label="${label}" checked`);
    // Harvested control names carry the ENCODED occurrence
    // (`can-filter:` + encodeURIComponent(occurrence) + `:` + field, per
    // the host preparer); decode it back to the raw occurrence the query
    // owner receives.
    const splitName = (name: string): { occurrence: string; field: string } => {
      assert.ok(name.startsWith('can-filter:'), `emitted filter control name: ${name}`);
      const rest = name.slice('can-filter:'.length);
      const at = rest.lastIndexOf(':');
      return { occurrence: decodeURIComponent(rest.slice(0, at)), field: rest.slice(at + 1) };
    };
    const listGroupOf = (html: string, idPattern: RegExp): { name: string; ids: string[] } => {
      const names = [...html.matchAll(/<select[^>]*\bname="(can-filter:[^"]+)"[^>]*>/g)]
        .map(match => match[1]!);
      assert.equal(names.length, 1, 'one sibling list filter control renders');
      const lists = [...html.matchAll(/<ul class="list">([\s\S]*?)<\/ul>/g)];
      assert.equal(lists.length, 1, 'one sibling list renders one row list');
      const ids = [...new Set([...(lists[0]![1] ?? '').matchAll(idPattern)]
        .map(match => match[0]))].sort();
      return { name: names[0]!, ids };
    };
    const whereFor = (occurrence: string): unknown[] =>
      calls.filter(call => call.occurrence === occurrence).map(call => call.where);

    // Defaults on /d: nothing saved, no request selectors. The standalone
    // form renders in authored position ahead of the sibling list with no
    // selection; the list serves every stored row with no predicate.
    let response = await get('/d', new URLSearchParams());
    assert.equal(response.status, 200);
    const defaultsHtml = await response.text();
    const defaultsForm = standaloneFormOf(defaultsHtml, 'state');
    assert.ok(defaultsForm.action.includes('/d?team='), 'save posts to the caller path');
    assert.ok(defaultsForm.body.includes('name="_csrf" value="'), 'save carries its CSRF token');
    assert.ok(defaultsForm.body.includes('name="_version" value="0"'), 'save carries the null version');
    assert.ok(defaultsForm.body.includes('<legend>S</legend>'), 'preference caption legends the control');
    assert.ok(defaultsForm.body.includes('<div class="filter">'), 'Filter presentation container');
    assert.ok(defaultsForm.body.includes('value="open" aria-label="Open"'), 'open option renders');
    assert.ok(defaultsForm.body.includes('value="closed" aria-label="Closed"'), 'closed option renders');
    assert.ok(!checkedOption(defaultsForm.body, 'open', 'Open'), 'null default checks nothing');
    assert.ok(!checkedOption(defaultsForm.body, 'closed', 'Closed'), 'null default checks nothing');
    assert.ok(!defaultsForm.body.includes('type="reset"'), 'no form-wide reset (would discard drafts)');
    assert.ok(defaultsHtml.indexOf(defaultsForm.body) < defaultsHtml.indexOf('data-can-list-filters'),
      'authored position: the preference control precedes the sibling list');
    // The shared settings surface still renders the same preference from
    // the same descriptor (no duplicated save semantics).
    assert.ok(defaultsHtml.includes('data-can-preference-form="save"'), 'settings save surface coexists');
    const group = listGroupOf(defaultsHtml, /job-[a-c]1/g);
    assert.ok(group.name.endsWith(':state'), 'sibling control selects the owned field');
    const occurrence = splitName(group.name).occurrence;
    assert.equal(splitName(group.name).field, 'state');
    assert.deepEqual(group.ids, ['job-a1', 'job-b1', 'job-c1']);
    assert.equal(calls.length, 1);
    assert.deepEqual(whereFor(occurrence), [undefined]);

    // Refusals before any save: bad CSRF is forbidden, bad values refuse,
    // and neither consults a query.
    const token = await deriveCsrfToken(identity.sessionToken);
    calls.length = 0;
    response = await handler(post('/d', 'state', 'bad', 'open', '0'));
    assert.equal(response.status, 403);
    assert.equal(rows.size, 0);
    for (const value of ['foreign', '', 'null']) {
      response = await handler(post('/d', 'state', token, value, '0'));
      assert.equal(response.status, 400);
      assert.equal(rows.size, 0);
    }
    assert.equal(calls.length, 0);

    // Authorized save round-trips through the existing page-preference
    // contract: caller-path POST with CSRF plus version, 303 back.
    response = await handler(post('/d', 'state', token, 'open', '0'));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/d?team=${identity.teamId}`);
    assert.deepEqual(rows.get(keyOf({
      appId: deps.app.appId, actorUserId: identity.userId,
      teamId: identity.teamId, owner: 'Probe', field: 'state',
    })), { value: 'open', version: '1' });

    // The saved selection renders checked and serves: the sibling list
    // receives the typed predicate unchanged from its own occurrence.
    calls.length = 0;
    response = await get('/d', new URLSearchParams());
    assert.equal(response.status, 200);
    const savedHtml = await response.text();
    const savedForm = standaloneFormOf(savedHtml, 'state');
    assert.ok(checkedOption(savedForm.body, 'open', 'Open'), 'saved selection renders checked');
    assert.ok(!checkedOption(savedForm.body, 'closed', 'Closed'), 'unselected option stays unchecked');
    assert.ok(savedForm.body.includes('name="_version" value="1"'), 'version advances after save');
    const saved = listGroupOf(savedHtml, /job-[a-c]1/g);
    assert.equal(splitName(saved.name).occurrence, occurrence, 'emitted occurrence is stable');
    assert.deepEqual(saved.ids, ['job-a1', 'job-c1']);
    assert.equal(calls.length, 1);
    assert.deepEqual(whereFor(occurrence), [{ op: 'eq', field: 'state', value: 'open' }]);

    // A stale version conflicts without touching the store.
    response = await handler(post('/d', 'state', token, 'closed', '0'));
    assert.equal(response.status, 409);
    assert.deepEqual([...rows.values()], [{ value: 'open', version: '1' }]);

    // Explicit request beats the saved selection on the sibling
    // occurrence; an explicit clear serves every row. Neither rewrites
    // the saved preference.
    calls.length = 0;
    response = await get('/d', new URLSearchParams([[group.name, 'closed']]));
    assert.equal(response.status, 200);
    assert.deepEqual(listGroupOf(await response.text(), /job-[a-c]1/g).ids, ['job-b1']);
    assert.equal(calls.length, 1);
    assert.deepEqual(whereFor(occurrence), [{ op: 'eq', field: 'state', value: 'closed' }]);
    calls.length = 0;
    response = await get('/d', new URLSearchParams([[group.name, '']]));
    assert.equal(response.status, 200);
    const clearedHtml = await response.text();
    assert.deepEqual(listGroupOf(clearedHtml, /job-[a-c]1/g).ids, ['job-a1', 'job-b1', 'job-c1']);
    assert.equal(calls.length, 1);
    assert.deepEqual(whereFor(occurrence), [undefined]);
    assert.ok(checkedOption(standaloneFormOf(clearedHtml, 'state').body, 'open', 'Open'),
      'request selection never rewrites the saved preference');

    // The second app's ordinary same-named preference keeps its own
    // meaning: independent defaults, save, and serving under the
    // module-scoped binding.
    calls.length = 0;
    response = await get('/other', new URLSearchParams());
    assert.equal(response.status, 200);
    const otherDefaultsHtml = await response.text();
    const otherDefaultsForm = standaloneFormOf(otherDefaultsHtml, 'state');
    assert.ok(otherDefaultsForm.action.includes('/other?team='), 'second app saves to its own caller path');
    assert.ok(otherDefaultsForm.body.includes('name="_version" value="0"'), 'second app starts unsaved');
    assert.ok(!checkedOption(otherDefaultsForm.body, 'open', 'Open'), 'second app starts unselected');
    const otherGroup = listGroupOf(otherDefaultsHtml, /task-[a-b]1/g);
    const otherOccurrence = splitName(otherGroup.name).occurrence;
    assert.ok(otherOccurrence !== occurrence, 'distinct emitted occurrences per collection');
    assert.deepEqual(otherGroup.ids, ['task-a1', 'task-b1']);
    assert.equal(calls.length, 1);
    assert.deepEqual(whereFor(otherOccurrence), [undefined]);
    response = await handler(post('/other', 'state', token, 'closed', '0'));
    assert.equal(response.status, 303);
    assert.deepEqual(rows.get(keyOf({
      appId: deps.app.appId, actorUserId: identity.userId,
      teamId: identity.teamId, owner: 'Other', field: 'state',
    })), { value: 'closed', version: '1' });
    calls.length = 0;
    response = await get('/other', new URLSearchParams());
    assert.equal(response.status, 200);
    const otherSavedHtml = await response.text();
    assert.ok(checkedOption(standaloneFormOf(otherSavedHtml, 'state').body, 'closed', 'Closed'),
      'second-app saved selection renders checked');
    assert.deepEqual(listGroupOf(otherSavedHtml, /task-[a-b]1/g).ids, ['task-b1']);
    assert.deepEqual(whereFor(otherOccurrence), [{ op: 'eq', field: 'state', value: 'closed' }]);
    // The first app's saved selection is untouched by the second app.
    calls.length = 0;
    response = await get('/d', new URLSearchParams());
    assert.equal(response.status, 200);
    assert.ok(checkedOption(standaloneFormOf(await response.text(), 'state').body, 'open', 'Open'),
      'first-app saved selection survives the second-app save');

    // An explicit bool false selection renders checked and serves: the
    // decoded read arrives boolean while POST/store stay string-valued.
    calls.length = 0;
    response = await get('/e', new URLSearchParams());
    assert.equal(response.status, 200);
    const boolDefaultsHtml = await response.text();
    const boolDefaultsForm = standaloneFormOf(boolDefaultsHtml, 'archived');
    assert.ok(boolDefaultsForm.body.includes('value="true"'), 'bool true spelling renders');
    assert.ok(boolDefaultsForm.body.includes('value="false"'), 'bool false spelling renders');
    assert.ok(!checkedOption(boolDefaultsForm.body, 'false', 'false'), 'null default checks nothing');
    const boolGroup = listGroupOf(boolDefaultsHtml, /job-[a-c]1/g);
    const boolOccurrence = splitName(boolGroup.name).occurrence;
    assert.deepEqual(boolGroup.ids, ['job-a1', 'job-b1', 'job-c1']);
    assert.deepEqual(whereFor(boolOccurrence), [undefined]);
    response = await handler(post('/e', 'archived', token, 'false', '0'));
    assert.equal(response.status, 303);
    calls.length = 0;
    response = await get('/e', new URLSearchParams());
    assert.equal(response.status, 200);
    const boolSavedHtml = await response.text();
    assert.ok(checkedOption(standaloneFormOf(boolSavedHtml, 'archived').body, 'false', 'false'),
      'explicit false selection renders checked');
    assert.deepEqual(listGroupOf(boolSavedHtml, /job-[a-c]1/g).ids, ['job-a1', 'job-b1']);
    assert.equal(calls.length, 1);
    assert.deepEqual(whereFor(boolOccurrence), [{ op: 'eq', field: 'archived', value: false }]);
    assert.equal(typeof (whereFor(boolOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');
    response = await handler(post('/e', 'archived', token, 'true', '1'));
    assert.equal(response.status, 303);
    calls.length = 0;
    response = await get('/e', new URLSearchParams());
    assert.equal(response.status, 200);
    assert.ok(checkedOption(standaloneFormOf(await response.text(), 'archived').body, 'true', 'true'),
      'explicit true selection renders checked');

    // Malformed selectors refuse before query or body work.
    for (const params of [new URLSearchParams([[group.name, 'yes']]),
      new URLSearchParams([['filter[state]', 'open']])]) {
      calls.length = 0;
      response = await get('/d', params);
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { code?: unknown }).code, 'validation');
      assert.equal(calls.length, 0);
    }

    // An anonymous caller (no active team membership) refuses before any
    // query: saved preferences load only for the resolved actor/team.
    calls.length = 0;
    response = await get('/d', new URLSearchParams(), false);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'forbidden');
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
});
