/**
 * B11 bounded real-source bool-page test (CAN18-v1 REVIEW-13 item 1).
 *
 * The B6 preparer test transcribes filter columns from the recorded artifact
 * and hand-drives `list` with a hand-written occurrence. This test instead
 * drives the whole compiled path: it compiles the committed
 * `test/fixtures/bool-page-source.can` with the real `can` binary
 * (`CAN_COMPILER_BIN`, catalog `CAN_NATIVE_CATALOG`), stages the EMITTED
 * module bytes verbatim, imports the page descriptor named by
 * `artifact.pages[0]`, and dispatches it through the real host seam
 * (`handlePageRequest` over `createTestDeps` + a real authorized identity).
 * Filter parameter names are harvested from the rendered controls, never
 * transcribed, so the emitted occurrence stays the source of truth
 * throughout. Occurrence roles (plain defaults, inline negation, helper
 * call, comparison) are labeled from the EMITTED bytes (the
 * `defaults:{...}` shape following each `occurrence:"..."` marker), never
 * from source spans.
 *
 * Staging note: the cloudflare `assembleModules` seam cannot be reused here
 * (`@canlang/cloudflare` depends on `@canlang/interfaces`, so importing it
 * would cycle). The bytes are staged unmodified under this package's `dist`
 * output, where the emitted bare `@canlang/ui` / `@canlang/stdlib` imports
 * resolve to the real installed workspace builds. The stdlib bindings are
 * out of the page path (`hasRole` only runs in the unused `canApp` read
 * rules; `ValueError` only on title-construction mismatch), so the render
 * exercises the real UI `list` + host preparer + bound query.
 *
 * Query note: the bound query is served by the EXISTING State query
 * adapter (`queryRecords` over `createMemoryStorage`), not a handwritten
 * predicate engine. Canonical rows (real `true`/`false` values) are seeded
 * through the real storage commit path; the model name is asserted on every
 * call; viewer grants come from the EMITTED `appDefinition` (the canonical
 * `readGrants` are asserted, never transcribed); caller membership resolves
 * through the REAL identity fixture store; and the emitted `where`
 * predicates reach the engine unmodified (no handwritten AST). Rendering
 * columns are projected from the COMPILE artifact's canonical model fields
 * and cross-checked against the emitted filter declarations. Four emitted
 * lists render per page (one query each), demultiplexed by occurrence.
 *
 * Saved-bool decoding (B11): a SAVED bool preference reaches the emitted
 * render as the store spelling `"true"` / `"false"` (the preference store
 * is string-typed), and the compiler emission decodes those strict
 * spellings to real booleans AT THE CHECKED TYPED PREFERENCE READ, before
 * any bool expression consumes them. Malformed spellings throw a
 * validation refusal at the read (never truthy, never a silent filter);
 * the host still requires boolean `bool` defaults (B6 semantics retained).
 * The page carries four lists over the same toggle: plain saved defaults,
 * an inline `not(preferences.active ?? false)`, an equivalent
 * `inverted(preferences.active)` derive-helper call, and the B13
 * discriminator `((preferences.active ?? false) == false)` comparison.
 * Under saved `"false"` the latter three MUST agree and select `true`
 * rows.
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
  PageDescriptor,
  QueryPredicate,
  ResolvedIdentity,
  RowView,
} from '@canlang/contracts';
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
const FIXTURE = 'packages/interfaces/test/fixtures/bool-page-source.can';
const MODEL = 'Probe.Customer';

test('compiled bool toggle page filters real true/false rows through the host seam', async () => {
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
    throw new Error(`bool fixture compile failed: ${String(out.message)} ` +
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
  const emitted = artifact.modules.find(module => module.path === pageRef.module);
  assert.ok(emitted, 'page module present in real artifact');

  // Canonical rendering columns from the COMPILE artifact's model fields,
  // cross-checked against the emitted filter declarations (never
  // transcribed: every name, type and case comes from canonical output).
  const artifactModel = artifact.models?.find(entry => entry.name === MODEL);
  assert.ok(artifactModel, 'canonical model present in compile artifact');
  const canonicalColumns: ColumnMeta[] = artifactModel.fields.map(field => {
    if (field.field.kind === 'string') {
      return { field: field.name, label: field.name, type: 'text' };
    }
    if (field.field.kind === 'boolean') {
      return {
        field: field.name, label: field.name, type: 'bool',
        valueLabels: { true: 'true', false: 'false' },
      };
    }
    if (field.field.kind === 'enum') {
      return {
        field: field.name, label: field.name, type: `enum:${MODEL}.${field.name}`,
        valueLabels: Object.fromEntries(field.field.values.map(value => [value, value])),
      };
    }
    throw new Error(`bool-page fixture needs a mapped column for ${field.name}`);
  });
  assert.deepEqual(canonicalColumns.map(column => column.field), ['name', 'kind', 'active']);
  assert.ok(emitted.js.includes('type:"enum:Probe.Customer.kind"'),
    'derived enum column matches the emitted filter declaration');
  assert.ok(emitted.js.includes('type:"bool"'), 'derived bool column matches the emission');

  const stageDir = mkdtempSync(join(testDir, 'staged-bool-page-'));
  try {
    const stagedFile = join(stageDir, 'page.mjs');
    writeFileSync(stagedFile, emitted.js);
    assert.equal(readFileSync(stagedFile, 'utf8'), emitted.js, 'staged bytes stay verbatim');
    const namespace = await import(pathToFileURL(stagedFile).href) as Record<string, unknown>;
    const descriptor = namespace[pageRef.export] as PageDescriptor;
    assert.equal(descriptor.path, '/customers');
    assert.equal(descriptor.owner, 'Probe');
    assert.equal(typeof descriptor.admit, 'function');
    assert.equal(typeof descriptor.render, 'function');

    // Canonical viewer grants from the EMITTED app definition: the
    // `readGrants` spellings are asserted, never transcribed.
    const appDefinition = (namespace as unknown as { appDefinition: {
      models: Record<string, {
        readGrants: { rule: string; by: string[] }[];
        fields: Record<string, unknown>;
      }>;
    } }).appDefinition;
    const canonicalModel = appDefinition.models[MODEL];
    assert.ok(canonicalModel, 'canonical model present in emitted app definition');
    assert.equal(canonicalModel.readGrants.length, 1);
    assert.deepEqual(canonicalModel.readGrants[0]!.by, ['public']);
    const grantFields = Object.keys(canonicalModel.fields);
    assert.deepEqual([...grantFields].sort(), ['active', 'kind', 'name']);
    const policy: PolicyTable = buildPolicyTable([{
      model: asModel(MODEL),
      secretFields: [],
      grants: [{ by: 'public', fields: grantFields }],
    }]);

    const store = createMemoryStorage();
    await seedRows(store, asModel(MODEL), [
      { id: 'cust-a1', data: { name: 'Ada', kind: 'individual', active: true } },
      { id: 'cust-b1', data: { name: 'Bo', kind: 'company', active: false } },
      { id: 'cust-c1', data: { name: 'Cy', kind: 'company', active: true } },
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
    // The REAL identity fixture store answers caller membership; public
    // grants admit without consulting it, but every lookup observes live
    // fixture state (no membership double).
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
          // Production projection: declared columns filtered to the
          // fields actually present in authorized projected rows.
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
    // each list heading carries its filter controls, immediately followed
    // by its `<ul class="list">` rows.
    const groupsOf = (html: string): { names: string[]; ids: string[] }[] => {
      const tokens = [...html.matchAll(
        /<select[^>]*\bname="(can-filter:[^"]+)"[^>]*>|<ul class="list">([\s\S]*?)<\/ul>/g,
      )];
      const groups: { names: string[]; ids: string[] }[] = [];
      let names: string[] = [];
      for (const token of tokens) {
        if (token[1] !== undefined) {
          names.push(token[1]);
          continue;
        }
        const ids = [...new Set([...(token[2] ?? '').matchAll(/cust-[a-c]1/g)]
          .map(match => match[0]))].sort();
        groups.push({ names, ids });
        names = [];
      }
      assert.ok(names.length === 0, 'every control group closes with a row list');
      assert.equal(groups.length, 4, 'four emitted lists render four control+row groups');
      return groups;
    };
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
    const whereFor = (occurrence: string): unknown[] =>
      calls.filter(call => call.occurrence === occurrence).map(call => call.where);

    // Defaults: nothing saved, no request selectors. The plain list serves
    // every stored row; the negated lists default null through `?? false`
    // and select true rows, and the comparison list agrees with them.
    let response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const defaultsHtml = await response.text();
    assert.ok(defaultsHtml.includes('data-can-list-filters'));
    const groups = groupsOf(defaultsHtml);
    const plainNames = groups[0]!.names;
    assert.equal(plainNames.length, 2);
    const kindName = plainNames.find(name => name.endsWith(':kind'))!;
    const plainActiveName = plainNames.find(name => name.endsWith(':active'))!;
    assert.ok(kindName && plainActiveName, 'plain list renders both emitted filter controls');
    const plainOccurrence = splitName(kindName).occurrence;
    assert.equal(splitName(plainActiveName).occurrence, plainOccurrence, 'one emitted occurrence');
    const negANames = groups[1]!.names;
    const negBNames = groups[2]!.names;
    const negCNames = groups[3]!.names;
    assert.deepEqual(negANames.map(splitName).map(part => part.field), ['active']);
    assert.deepEqual(negBNames.map(splitName).map(part => part.field), ['active']);
    assert.deepEqual(negCNames.map(splitName).map(part => part.field), ['active']);
    const negAOccurrence = splitName(negANames[0]!).occurrence;
    const negBOccurrence = splitName(negBNames[0]!).occurrence;
    const negCOccurrence = splitName(negCNames[0]!).occurrence;
    assert.ok(plainOccurrence !== negAOccurrence && plainOccurrence !== negBOccurrence &&
      plainOccurrence !== negCOccurrence && negAOccurrence !== negBOccurrence &&
      negAOccurrence !== negCOccurrence && negBOccurrence !== negCOccurrence,
      'four distinct emitted occurrences');
    // Every phase below reuses these harvested names: the emitted
    // occurrence is never transcribed.
    assert.deepEqual(groups[0]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(groups[1]!.ids, ['cust-a1', 'cust-c1']);
    assert.deepEqual(groups[2]!.ids, ['cust-a1', 'cust-c1']);
    assert.deepEqual(groups[3]!.ids, ['cust-a1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [undefined]);
    assert.deepEqual(whereFor(negAOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.deepEqual(whereFor(negBOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.deepEqual(whereFor(negCOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.equal(typeof (whereFor(negAOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');
    assert.equal(typeof (whereFor(negCOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');

    // Occurrence roles are labeled from the EMITTED bytes: the
    // `defaults:{...}` shape following each `occurrence:"..."` marker.
    // Render order is source order (plain, inline negation, helper call,
    // comparison).
    const occurrenceSuffix = encodeURIComponent(JSON.stringify([descriptor.path]));
    const emittedShape = (occurrence: string): string => {
      assert.ok(occurrence.endsWith(occurrenceSuffix), 'runtime occurrence extends its emitted prefix');
      const marker = `occurrence:"${occurrence.slice(0, occurrence.length - occurrenceSuffix.length)}"`;
      const at = emitted.js.indexOf(marker);
      assert.ok(at >= 0, `emitted occurrence marker present for ${occurrence}`);
      const head = emitted.js.slice(emitted.js.indexOf('defaults:{', at), emitted.js.indexOf('defaults:{', at) + 24);
      if (head.startsWith('defaults:{active:!(')) return 'inline-negation';
      if (head.startsWith('defaults:{active:await')) return 'helper-call';
      if (head.startsWith('defaults:{active:(((')) return 'comparison';
      if (head.startsWith('defaults:{kind:')) return 'direct-defaults';
      assert.fail(`unrecognized emitted defaults shape after ${marker}: ${head}`);
    };
    assert.equal(emittedShape(plainOccurrence), 'direct-defaults');
    assert.equal(emittedShape(negAOccurrence), 'inline-negation');
    assert.equal(emittedShape(negBOccurrence), 'helper-call');
    assert.equal(emittedShape(negCOccurrence), 'comparison');

    // Request true serves only true rows with a typed boolean predicate.
    calls.length = 0;
    response = await get(new URLSearchParams([[plainActiveName, 'true']]));
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-a1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.equal(typeof (whereFor(plainOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');

    // Request false serves only the false row.
    calls.length = 0;
    response = await get(new URLSearchParams([[plainActiveName, 'false']]));
    assert.equal(response.status, 200);
    const falseHtml = await response.text();
    assert.deepEqual(groupsOf(falseHtml)[0]!.ids, ['cust-b1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [{ op: 'eq', field: 'active', value: false }]);
    assert.ok(falseHtml.includes('<option value="false" selected>'));

    // Explicit clear stays cleared.
    calls.length = 0;
    response = await get(new URLSearchParams([[plainActiveName, '']]));
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [undefined]);

    // Saved enum spelling (string, as the store holds it) filters rows.
    prefs.set('Probe/kind', { value: 'company', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [{ op: 'eq', field: 'kind', value: 'company' }]);

    // Explicit request beats the saved enum spelling.
    calls.length = 0;
    response = await get(new URLSearchParams([[kindName, 'individual']]));
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-a1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [{ op: 'eq', field: 'kind', value: 'individual' }]);

    // Saved enum composes with a request bool toggle into one typed query.
    calls.length = 0;
    response = await get(new URLSearchParams([[plainActiveName, 'false']]));
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-b1']);
    assert.equal(calls.length, 4);
    const composed = whereFor(plainOccurrence);
    assert.equal(composed.length, 1);
    assert.equal((composed[0] as unknown as { op: unknown }).op, 'and');
    assert.ok(((composed[0] as unknown as { args: unknown }).args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'kind' &&
      (arg as { field?: unknown; value?: unknown }).value === 'company'));
    assert.ok(((composed[0] as unknown as { args: unknown }).args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'active' &&
      (arg as { field?: unknown; value?: unknown }).value === false));
    prefs.delete('Probe/kind');

    // Saved bool spelling (string, as the store holds it) decodes at the
    // checked typed read to a boolean predicate serving true rows.
    prefs.set('Probe/active', { value: 'true', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const savedTrueHtml = await response.text();
    const savedTrue = groupsOf(savedTrueHtml);
    assert.deepEqual(savedTrue[0]!.ids, ['cust-a1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.equal(typeof (whereFor(plainOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');
    assert.ok(savedTrueHtml.includes('<option value="true" selected>'));
    // The negated lists invert the saved spelling and agree.
    assert.deepEqual(savedTrue[1]!.ids, ['cust-b1']);
    assert.deepEqual(savedTrue[2]!.ids, ['cust-b1']);
    assert.deepEqual(savedTrue[3]!.ids, ['cust-b1']);
    assert.deepEqual(whereFor(negAOccurrence), [{ op: 'eq', field: 'active', value: false }]);
    assert.deepEqual(whereFor(negBOccurrence), [{ op: 'eq', field: 'active', value: false }]);
    assert.deepEqual(whereFor(negCOccurrence), [{ op: 'eq', field: 'active', value: false }]);

    // B13 DISCRIMINATOR: saved "false" selects TRUE rows through the
    // inline negation, and the equivalent helper call and comparison
    // agree exactly.
    prefs.set('Probe/active', { value: 'false', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const savedFalseHtml = await response.text();
    const savedFalse = groupsOf(savedFalseHtml);
    assert.deepEqual(savedFalse[0]!.ids, ['cust-b1']);
    assert.deepEqual(whereFor(plainOccurrence), [{ op: 'eq', field: 'active', value: false }]);
    assert.deepEqual(savedFalse[1]!.ids, ['cust-a1', 'cust-c1']);
    assert.deepEqual(savedFalse[2]!.ids, ['cust-a1', 'cust-c1']);
    assert.deepEqual(savedFalse[3]!.ids, ['cust-a1', 'cust-c1']);
    assert.deepEqual(whereFor(negAOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.deepEqual(whereFor(negBOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.deepEqual(whereFor(negCOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.equal(typeof (whereFor(negAOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');
    assert.equal(typeof (whereFor(negBOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');
    assert.equal(typeof (whereFor(negCOccurrence)[0] as unknown as { value: unknown }).value, 'boolean');

    // Explicit request beats the saved bool spelling on the plain list.
    calls.length = 0;
    response = await get(new URLSearchParams([[plainActiveName, 'true']]));
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-a1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [{ op: 'eq', field: 'active', value: true }]);

    // Explicit clear beats the saved bool spelling.
    calls.length = 0;
    response = await get(new URLSearchParams([[plainActiveName, '']]));
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(plainOccurrence), [undefined]);

    // Saved enum and saved bool compose into one typed query.
    prefs.set('Probe/kind', { value: 'company', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    assert.deepEqual(groupsOf(await response.text())[0]!.ids, ['cust-b1']);
    assert.equal(calls.length, 4);
    const savedComposed = whereFor(plainOccurrence);
    assert.equal(savedComposed.length, 1);
    assert.equal((savedComposed[0] as unknown as { op: unknown }).op, 'and');
    assert.ok(((savedComposed[0] as unknown as { args: unknown }).args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'kind' &&
      (arg as { field?: unknown; value?: unknown }).value === 'company'));
    assert.ok(((savedComposed[0] as unknown as { args: unknown }).args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'active' &&
      (arg as { field?: unknown; value?: unknown }).value === false));
    prefs.delete('Probe/kind');

    // Request precedence through the negation path: an explicit false on
    // the inline list serves the false row while the helper and comparison
    // lists keep following the saved negation.
    calls.length = 0;
    response = await get(new URLSearchParams([[negANames[0]!, 'false']]));
    assert.equal(response.status, 200);
    const overridden = groupsOf(await response.text());
    assert.deepEqual(overridden[1]!.ids, ['cust-b1']);
    assert.deepEqual(overridden[2]!.ids, ['cust-a1', 'cust-c1']);
    assert.deepEqual(overridden[3]!.ids, ['cust-a1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(negAOccurrence), [{ op: 'eq', field: 'active', value: false }]);
    assert.deepEqual(whereFor(negBOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.deepEqual(whereFor(negCOccurrence), [{ op: 'eq', field: 'active', value: true }]);

    // Clear through the negation path: an explicit clear on the helper
    // list serves every row while the inline and comparison lists keep
    // following saved.
    calls.length = 0;
    response = await get(new URLSearchParams([[negBNames[0]!, '']]));
    assert.equal(response.status, 200);
    const cleared = groupsOf(await response.text());
    assert.deepEqual(cleared[1]!.ids, ['cust-a1', 'cust-c1']);
    assert.deepEqual(cleared[2]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(cleared[3]!.ids, ['cust-a1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(negAOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    assert.deepEqual(whereFor(negBOccurrence), [undefined]);
    assert.deepEqual(whereFor(negCOccurrence), [{ op: 'eq', field: 'active', value: true }]);
    prefs.delete('Probe/active');

    // Malformed selectors refuse before query or body work.
    for (const params of [new URLSearchParams([[plainActiveName, 'yes']]),
      new URLSearchParams([['filter[active]', 'true']])]) {
      calls.length = 0;
      response = await get(params);
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { code?: unknown }).code, 'validation');
      assert.equal(calls.length, 0);
    }

    // A malformed SAVED spelling never reaches a query: the host rejects
    // the stored value before admission or render work (`rule_failed`,
    // well-formed but semantically rejected).
    prefs.set('Probe/active', { value: 'yes', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'rule_failed');
    assert.equal(calls.length, 0);
    prefs.delete('Probe/active');

    // Denied caller (no membership) refuses before any query.
    calls.length = 0;
    response = await get(new URLSearchParams(), false);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'forbidden');
    assert.equal(calls.length, 0);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
});
