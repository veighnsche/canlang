/**
 * C2 text-equality executable consumer (CAN18-v1 C2/C3 rule batch).
 *
 * The compiler admits plain owned `text` filter selectors (DESIGN 975
 * scalar + operator table: ordinary string equality, no spelling
 * inventory), proved only via check -> IR -> lower_ui string inspection
 * in `compiler/tests/enum_filter_group.rs`. This test is the actual
 * consumer: it compiles the committed
 * `test/fixtures/text-page-source.can` with the real `can` binary
 * (`CAN_COMPILER_BIN`, catalog `CAN_NATIVE_CATALOG`), stages every
 * emitted module verbatim, imports the page descriptor named by
 * `artifact.pages[0]`, and dispatches it through the real host seam
 * (`handlePageRequest` over `createTestDeps` + a real authorized
 * identity). No predicate engine or handler is handwritten: the bound
 * query is served by the EXISTING State query adapter (`queryRecords`
 * over `createMemoryStorage`), exactly like the B15 enum-page-source
 * consumer this test reuses as its harness pattern.
 *
 * The page carries two lists over the same text control: a DIRECT saved
 * default (`defaults={category=preferences.category}`) and a TEXT
 * LITERAL default (`defaults={category="ops"}`). Filter parameter names
 * are harvested from the rendered controls, never transcribed.
 * Canonical rows (real `tech`/`ops` values) are seeded through the real
 * storage commit path; viewer grants come from the EMITTED
 * `appDefinition`; caller membership resolves through the REAL identity
 * fixture store.
 *
 * Saved text values are already plain strings, so reads lower verbatim
 * with no decoding wrapper and no case inventory. An unknown saved
 * string is NOT a materialization failure (unlike an unknown enum
 * spelling): there is no inventory to violate, so it narrows to no
 * rows through the ordinary string equality (DESIGN 1027: a
 * user-requested filter can only narrow). Unknown REQUEST text is
 * refused by the host preparer only when malformed (control
 * characters, over-long); well-formed text that matches nothing simply
 * matches nothing. Request selection and explicit clear take precedence
 * over saved/literal defaults per list; a denied caller and a revoked
 * session refuse (`forbidden`) before any query.
 *
 * Compiler pin (coordinator-frozen binary consumed read-only via
 * CAN_COMPILER_BIN; the C2 admission is in effect; no compiler source
 * changes, no rebuild):
 * binary: /tmp/can18-text-filter-can
 * binary sha256: a37bb5041b10b80387efa76ca01d88ba805af3e7319d9a8819e82adce71182cc
 * catalog sha256: ca50fdca852170b09f95ec4adb97cc63ddabf26437629c02dfd234991bc486a8 (packages/values/dist/catalog.json, immutable main catalog)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type {
  ColumnMeta,
  CompileArtifact,
  PageDescriptor,
  QueryPredicate,
  ResolvedIdentity,
  RowView,
} from '@canlang/contracts';
import { revokeSessionByToken } from '@canlang/identity';
import { queryRecords } from '@canlang/state/query/engine';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import type { PolicyTable } from '@canlang/state/policy/grants';
import type { MembershipReader } from '@canlang/state/policy/roles';
import { asModel, seedRows } from '@canlang/state/testing/query/fixtures';
import { createTestDeps, testRequest } from '../src/testing.js';
import { handlePageRequest } from '../src/http/pages.js';
import type { PagePreferenceStore } from '../src/ports.js';
import type { ListQueryArgs } from '@canlang/contracts';

const execFileAsync = promisify(execFile);
const FIXTURE = 'packages/interfaces/test/fixtures/text-page-source.can';

test('compiled text-default page filters real rows through the host seam', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(testDir, '..', '..', '..', '..');
  const fixtureBytes = readFileSync(join(root, FIXTURE));
  const fixtureSha = createHash('sha256').update(fixtureBytes).digest('hex');

  const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalog = process.env.CAN_NATIVE_CATALOG ??
    join(root, 'packages/cloudflare/dist/native-catalog.json');
  const catalogSha = createHash('sha256').update(readFileSync(catalog)).digest('hex');
  const env = { ...process.env };
  delete env.CAN_CATALOG;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(compiler,
      ['compile', '--format=json', '--catalog', catalog, FIXTURE],
      { cwd: root, env, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }));
  } catch (error) {
    const out = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    throw new Error(`text fixture compile failed: ${String(out.message)} ` +
      `stdout=${String(out.stdout ?? '').slice(0, 2000)} stderr=${String(out.stderr ?? '').slice(0, 2000)}`);
  }
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!('diagnostics' in artifact), 'real fixture emits clean');
  const source = artifact.sources.find(entry => entry.path === FIXTURE);
  assert.ok(source && source.sha256 === fixtureSha, 'compiled source identity preserved');
  assert.equal(artifact.pages.length, 1);
  const pageRef = artifact.pages[0]!;
  assert.equal(pageRef.owner, 'Probe');
  assert.equal(pageRef.path, '/customers');
  assert.ok(catalogSha.length === 64, 'catalog pin recorded');

  const customerModels = (artifact.models ?? []).filter(entry => entry.name.endsWith('.Customer'));
  assert.equal(customerModels.length, 1, 'exactly one canonical Customer model');
  const MODEL = customerModels[0]!.name;
  const artifactModel = artifact.models?.find(entry => entry.name === MODEL);
  assert.ok(artifactModel, 'canonical model present in compile artifact');
  assert.deepEqual(artifactModel.fields.map(field => field.name).sort(), ['category', 'name']);

  // The emitted text column type is harvested from the emission (never
  // transcribed): the filter descriptor carries `type:"text"` with an
  // empty value-label map (no spelling inventory, like references).
  const entryModule = artifact.modules.find(module => module.path === pageRef.module);
  assert.ok(entryModule, 'page module present in real artifact');
  assert.ok(entryModule.js.includes('type:"text"'), 'emitted text column type present');
  assert.ok(entryModule.js.includes('valueLabels:{}'), 'text descriptor carries no spellings');
  const canonicalColumns: ColumnMeta[] = [
    { field: 'name', label: 'name', type: 'text' },
    { field: 'category', label: 'category', type: 'text', valueLabels: {} },
  ];

  // Stage EVERY emitted module verbatim under one directory.
  const stageDir = mkdtempSync(join(testDir, 'staged-text-page-'));
  try {
    for (const module of artifact.modules) {
      const rel = module.path.replace(/^\.\//, '');
      assert.ok(rel.length > 0 && !rel.startsWith('/') && !rel.includes('..'),
        `stagable module path: ${module.path}`);
      const stagedFile = join(stageDir, rel);
      mkdirSync(dirname(stagedFile), { recursive: true });
      writeFileSync(stagedFile, module.js);
      assert.equal(readFileSync(stagedFile, 'utf8'), module.js, 'staged bytes stay verbatim');
    }
    const stagedEntry = join(stageDir, pageRef.module.replace(/^\.\//, ''));
    const namespace = await import(pathToFileURL(stagedEntry).href) as Record<string, unknown>;
    const descriptor = namespace[pageRef.export] as PageDescriptor;
    assert.equal(descriptor.path, '/customers');
    assert.equal(descriptor.owner, 'Probe');
    assert.equal(typeof descriptor.admit, 'function');
    assert.equal(typeof descriptor.render, 'function');

    // Canonical viewer grants from the EMITTED app definition.
    const appDefinition = (namespace as unknown as { appDefinition: {
      models: Record<string, {
        readGrants: { rule: string; by: string[] }[];
        fields: Record<string, unknown>;
      }>;
    } }).appDefinition;
    const modelKey = Object.keys(appDefinition.models).find(key => key.endsWith('.Customer'));
    assert.ok(modelKey, 'canonical model present in emitted app definition');
    const canonicalModel = appDefinition.models[modelKey]!;
    assert.equal(canonicalModel.readGrants.length, 1);
    assert.deepEqual(canonicalModel.readGrants[0]!.by, ['public']);
    assert.deepEqual(Object.keys(canonicalModel.fields).sort(), ['category', 'name']);
    const grantFields = Object.keys(canonicalModel.fields);
    const policy: PolicyTable = buildPolicyTable([{
      model: asModel(MODEL),
      secretFields: [],
      grants: [{ by: 'public', fields: grantFields }],
    }]);

    const store = createMemoryStorage();
    await seedRows(store, asModel(MODEL), [
      { id: 'row-a', data: { name: 'Ada', category: 'tech' } },
      { id: 'row-b', data: { name: 'Bo', category: 'ops' } },
      { id: 'row-c', data: { name: 'Cy', category: 'ops' } },
    ]);

    const prefs = new Map<string, { value: string; version: string }>();
    const preferences: PagePreferenceStore = {
      read: async key => prefs.get(`${key.owner}/${key.field}`) ?? null,
      save: async key => {
        prefs.set(`${key.owner}/${key.field}`,
          { value: key.value, version: String(Number(key.expectedVersion) + 1) });
        return true;
      },
    };
    const { deps, identity } = await createTestDeps({ descriptors: [descriptor] });
    const memberships: MembershipReader = {
      findMembership: (teamId, userId) => identity.store.findMembership(teamId, userId),
    };
    let principal: ResolvedIdentity | undefined;
    const calls: { occurrence: unknown; where: unknown }[] = [];
    const scoped = { ...deps, preferences,
      createReadScope: (current: ResolvedIdentity) => {
        principal = current;
        return { query: async (invocation: unknown, model: string, args: ListQueryArgs) => {
          assert.equal(invocation, principal, 'query runs under the authorized principal');
          assert.equal(model, MODEL, 'query serves the canonical model');
          calls.push({ occurrence: args.occurrence, where: args.where });
          const caller = invocation as ResolvedIdentity;
          const viewed = await queryRecords({
            policy,
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
          const visible = new Set(viewed.records.flatMap(record => Object.keys(record.data)));
          const rows: RowView[] = viewed.records.map(record => ({
            id: record.id,
            version: String(record.version),
            fields: { ...record.data },
          }));
          return {
            rows,
            columns: canonicalColumns.filter(column => visible.has(column.field)),
            ...(viewed.records.length === 0 ? {
              emptyDeclarations: canonicalColumns.map(({ field, type }) => ({ field, type })),
            } : {}),
          };
        } };
      } };

    const get = async (params: URLSearchParams, authed = true) => {
      const query = authed ? `team=${identity.teamId}&${params}` : params.toString();
      const request = testRequest(`/customers?${query}`, authed ? { cookie: identity.cookie } : {});
      return handlePageRequest(scoped, request);
    };
    // One control+row group per emitted list, in render (source) order:
    // each list heading carries its free-text filter control,
    // immediately followed by its `<ul class="list">` rows.
    const groupsOf = (html: string): { names: string[]; ids: string[] }[] => {
      const tokens = [...html.matchAll(
        /<input type="text"[^>]*\bname="(can-filter:[^"]+)"[^>]*>|<ul class="list">([\s\S]*?)<\/ul>/g,
      )];
      const groups: { names: string[]; ids: string[] }[] = [];
      let names: string[] = [];
      for (const token of tokens) {
        if (token[1] !== undefined) {
          names.push(token[1]);
          continue;
        }
        const ids = [...new Set([...(token[2] ?? '').matchAll(/row-[a-c]/g)]
          .map(match => match[0]))].sort();
        groups.push({ names, ids });
        names = [];
      }
      assert.ok(names.length === 0, 'every control group closes with a row list');
      assert.equal(groups.length, 2, 'two emitted lists render two control+row groups');
      return groups;
    };
    const splitName = (name: string): { occurrence: string; field: string } => {
      assert.ok(name.startsWith('can-filter:'), `emitted filter control name: ${name}`);
      const rest = name.slice('can-filter:'.length);
      const at = rest.lastIndexOf(':');
      return { occurrence: decodeURIComponent(rest.slice(0, at)), field: rest.slice(at + 1) };
    };
    const whereFor = (occurrence: string): unknown[] =>
      calls.filter(call => call.occurrence === occurrence).map(call => call.where);

    // Defaults: nothing saved, no request selectors. The saved default
    // is null and the literal list carries its authored value, so the
    // saved list serves every row with no predicate while the literal
    // list selects its spelling.
    let response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const defaultsHtml = await response.text();
    assert.ok(defaultsHtml.includes('data-can-list-filters'));
    assert.ok(defaultsHtml.includes('<input type="text"'), 'text controls render free-text inputs');
    const groups = groupsOf(defaultsHtml);
    for (const group of groups) {
      assert.equal(group.names.length, 1, 'one category control per list');
      assert.ok(group.names[0]!.endsWith(':category'), 'category control only');
    }
    const savedOccurrence = splitName(groups[0]!.names[0]!).occurrence;
    const literalOccurrence = splitName(groups[1]!.names[0]!).occurrence;
    assert.ok(savedOccurrence !== literalOccurrence, 'two distinct emitted occurrences');
    assert.deepEqual(groups[0]!.ids, ['row-a', 'row-b', 'row-c']);
    assert.deepEqual(groups[1]!.ids, ['row-b', 'row-c']);
    assert.equal(calls.length, 2);
    assert.deepEqual(whereFor(savedOccurrence), [undefined]);
    assert.deepEqual(whereFor(literalOccurrence), [{ op: 'eq', field: 'category', value: 'ops' }]);

    // Occurrence roles are labeled from the EMITTED bytes: the saved
    // list defaults read `preferences.category` while the literal list
    // defaults carry the authored `"ops"` spelling.
    const occurrenceSuffix = encodeURIComponent(JSON.stringify([descriptor.path]));
    const emittedShape = (occurrence: string): string => {
      assert.ok(occurrence.endsWith(occurrenceSuffix), 'runtime occurrence extends its emitted prefix');
      const marker = `occurrence:"${occurrence.slice(0, occurrence.length - occurrenceSuffix.length)}"`;
      const at = entryModule.js.indexOf(marker);
      assert.ok(at >= 0, `emitted occurrence marker present for ${occurrence}`);
      const defaultsAt = entryModule.js.indexOf('defaults:{', at);
      assert.ok(defaultsAt >= 0, `emitted defaults follow the occurrence marker for ${occurrence}`);
      const shapeWindow = entryModule.js.slice(defaultsAt, defaultsAt + 400);
      if (shapeWindow.includes('preferences.category')) return 'saved-read';
      if (shapeWindow.includes('"ops"')) return 'literal';
      assert.fail(`unrecognized emitted defaults shape after ${marker}: ${shapeWindow}`);
    };
    assert.equal(emittedShape(savedOccurrence), 'saved-read');
    assert.equal(emittedShape(literalOccurrence), 'literal');

    // Saved text (string, as the store holds it) filters rows with a
    // typed string predicate on the saved list; the literal list keeps
    // its authored spelling.
    prefs.set('Probe/category', { value: 'ops', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const savedHtml = await response.text();
    const saved = groupsOf(savedHtml);
    assert.deepEqual(saved[0]!.ids, ['row-b', 'row-c']);
    assert.deepEqual(saved[1]!.ids, ['row-b', 'row-c']);
    assert.equal(calls.length, 2);
    for (const occurrence of [savedOccurrence, literalOccurrence]) {
      assert.deepEqual(whereFor(occurrence), [{ op: 'eq', field: 'category', value: 'ops' }]);
      assert.equal(typeof (whereFor(occurrence)[0] as unknown as { value: unknown }).value, 'string');
    }
    assert.ok(savedHtml.includes('value="ops"'), 'current text selection renders in the control');

    // Explicit request beats the saved spelling on the saved list.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[0]!.names[0]!, 'tech']]));
    assert.equal(response.status, 200);
    const overridden = groupsOf(await response.text());
    assert.deepEqual(overridden[0]!.ids, ['row-a']);
    assert.deepEqual(overridden[1]!.ids, ['row-b', 'row-c']);
    assert.equal(calls.length, 2);
    assert.deepEqual(whereFor(savedOccurrence), [{ op: 'eq', field: 'category', value: 'tech' }]);
    assert.deepEqual(whereFor(literalOccurrence), [{ op: 'eq', field: 'category', value: 'ops' }]);

    // Explicit request beats the literal spelling on the literal list.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[1]!.names[0]!, 'tech']]));
    assert.equal(response.status, 200);
    const literalOverridden = groupsOf(await response.text());
    assert.deepEqual(literalOverridden[0]!.ids, ['row-b', 'row-c']);
    assert.deepEqual(literalOverridden[1]!.ids, ['row-a']);
    assert.equal(calls.length, 2);
    assert.deepEqual(whereFor(literalOccurrence), [{ op: 'eq', field: 'category', value: 'tech' }]);
    assert.deepEqual(whereFor(savedOccurrence), [{ op: 'eq', field: 'category', value: 'ops' }]);

    // Explicit clear beats the saved spelling on the saved list.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[0]!.names[0]!, '']]));
    assert.equal(response.status, 200);
    const cleared = groupsOf(await response.text());
    assert.deepEqual(cleared[0]!.ids, ['row-a', 'row-b', 'row-c']);
    assert.deepEqual(cleared[1]!.ids, ['row-b', 'row-c']);
    assert.equal(calls.length, 2);
    assert.deepEqual(whereFor(savedOccurrence), [undefined]);

    // Explicit clear beats the literal spelling on the literal list.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[1]!.names[0]!, '']]));
    assert.equal(response.status, 200);
    const literalCleared = groupsOf(await response.text());
    assert.deepEqual(literalCleared[1]!.ids, ['row-a', 'row-b', 'row-c']);
    assert.equal(calls.length, 2);
    assert.deepEqual(whereFor(literalOccurrence), [undefined]);
    prefs.delete('Probe/category');

    // Malformed selectors refuse with the exact error: control
    // characters and over-long text are malformed (validation), as is
    // the legacy `filter[field]` envelope. The refused list performs no
    // query work: its preparation throws before its runner is reached.
    // (A well-formed sibling may still fire its read-only query: lists
    // with synchronous defaults render concurrently inside one
    // `Promise.all` — pre-existing emission scheduling, equally true of
    // enum-only sync-default pages — so no total-calls bound applies.)
    for (const params of [new URLSearchParams([[groups[0]!.names[0]!, 'o\x01ps']]),
      new URLSearchParams([[groups[0]!.names[0]!, 'x'.repeat(201)]]),
      new URLSearchParams([['filter[category]', 'ops']])]) {
      calls.length = 0;
      response = await get(params);
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { code?: unknown }).code, 'validation');
      assert.deepEqual(whereFor(savedOccurrence), []);
    }

    // An unknown SAVED string never fails materialization (unlike an
    // unknown enum spelling): text carries no case inventory, so the
    // well-formed value narrows the saved list to no rows through the
    // ordinary string equality while the literal list is unaffected.
    prefs.set('Probe/category', { value: 'nope', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(whereFor(savedOccurrence), [{ op: 'eq', field: 'category', value: 'nope' }]);
    assert.deepEqual(whereFor(literalOccurrence), [{ op: 'eq', field: 'category', value: 'ops' }]);
    prefs.delete('Probe/category');

    // Denied caller (no membership) refuses before any query.
    calls.length = 0;
    response = await get(new URLSearchParams(), false);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'forbidden');
    assert.equal(calls.length, 0);

    // Revoked session refuses before any query.
    await revokeSessionByToken(identity.store, { token: identity.sessionToken });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'forbidden');
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
});
