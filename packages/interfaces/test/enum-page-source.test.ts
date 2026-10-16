/**
 * B15 executable enum-default consumer (CAN18-v1 REVIEW-18 outcome 6).
 *
 * B14 (commit 55c36c2df) admits computed enum filter defaults (direct,
 * helper-call, coalesced saved reads) but proves it only via
 * check -> IR -> lower_ui string inspection — never
 * compiled/assembled/executed. This test is the actual consumer: it
 * compiles the committed `test/fixtures/enum-page-source.can` with the
 * real `can` binary (`CAN_COMPILER_BIN`, catalog `CAN_NATIVE_CATALOG`),
 * stages EVERY emitted module verbatim (the entrypoint plus the helper
 * package module, so the imported derive resolves through its real
 * relative import), imports the page descriptor named by
 * `artifact.pages[0]`, and dispatches it through the real host seam
 * (`handlePageRequest` over `createTestDeps` + a real authorized
 * identity). No predicate engine or handler is handwritten: the bound
 * query is served by the EXISTING State query adapter (`queryRecords`
 * over `createMemoryStorage`), exactly like the B9
 * bool-page-source consumer this test reuses as its harness pattern.
 *
 * The page carries four lists over the same enum toggle: a DIRECT saved
 * default, an equivalent LOCAL derive-helper call, an equivalent
 * IMPORTED derive-helper call (from the fixture's `EnumKindLib`
 * package), and a COALESCECED fallback across two saved enum reads.
 * Filter parameter names are harvested from the rendered controls, never
 * transcribed; occurrence roles are labeled from the EMITTED bytes (the
 * `defaults:{...}` shape following each `occurrence:"..."` marker).
 * Canonical rows (real `individual`/`company` spellings) are seeded
 * through the real storage commit path; the model name is the single
 * canonical `*.Customer` model in the compile artifact; viewer grants
 * come from the EMITTED `appDefinition`; caller membership resolves
 * through the REAL identity fixture store.
 *
 * Saved enum values are already case spellings, so reads lower verbatim
 * and an unknown saved spelling is rejected at saved-preference
 * materialization (the checked typed read, `rule_failed`, before any
 * query work); unknown REQUEST spellings are refused by the host
 * preparer against the column inventory (`validation`). Request
 * selection and explicit clear take precedence over saved spellings per
 * list; a denied caller and a revoked session refuse (`forbidden`)
 * before any query.
 *
 * Compiler pin (coordinator-frozen binary consumed read-only via
 * CAN_COMPILER_BIN; `--version` dc2d5ec20, i.e. the B14 intake commit,
 * so the proven B14 admission is in effect; no compiler source changes,
 * no rebuild):
 * binary: /tmp/can18-filter-probe-can
 * binary sha256: 783b66e9e0e5f81e49295e63485ba564f6db080e108261d5632bc1933a2f83c3
 * catalog sha256: ca50fdca852170b09f95ec4adb97cc63ddabf26437629c02dfd234991bc486a8 (packages/cloudflare/dist/native-catalog.json)
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
const FIXTURE = 'packages/interfaces/test/fixtures/enum-page-source.can';

test('compiled enum-default page filters real rows through the host seam', async () => {
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
    throw new Error(`enum fixture compile failed: ${String(out.message)} ` +
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

  // The single canonical Customer model, whatever unit owns it (the
  // fixture imports the model from its helper package).
  const customerModels = (artifact.models ?? []).filter(entry => entry.name.endsWith('.Customer'));
  assert.equal(customerModels.length, 1, 'exactly one canonical Customer model');
  const MODEL = customerModels[0]!.name;
  const artifactModel = artifact.models?.find(entry => entry.name === MODEL);
  assert.ok(artifactModel, 'canonical model present in compile artifact');
  const kindField = artifactModel.fields.find(field => field.name === 'kind');
  assert.ok(kindField, 'kind field present');
  assert.equal(kindField.field.kind, 'enum', 'kind is an enum field');
  const kindCases = kindField.field.kind === 'enum' ? kindField.field.values : [];
  assert.deepEqual([...kindCases].sort(), ['company', 'individual']);

  // The emitted enum column type is harvested from the emission (never
  // transcribed): exactly one distinct enum column type exists.
  const entryModule = artifact.modules.find(module => module.path === pageRef.module);
  assert.ok(entryModule, 'page module present in real artifact');
  const enumTypes = [...new Set([...entryModule.js.matchAll(/type:"(enum:[^"]+)"/g)]
    .map(match => match[1]))];
  assert.equal(enumTypes.length, 1, 'one emitted enum column type');
  const canonicalColumns: ColumnMeta[] = [
    { field: 'name', label: 'name', type: 'text' },
    {
      field: 'kind', label: 'kind', type: enumTypes[0]!,
      valueLabels: Object.fromEntries(kindCases.map(value => [value, value])),
    },
  ];
  assert.deepEqual(artifactModel.fields.map(field => field.name).sort(), ['kind', 'name']);

  // Stage EVERY emitted module verbatim under one directory so the
  // entrypoint's relative import of the helper package module resolves
  // to real compiled bytes (no hand-written shim).
  const stageDir = mkdtempSync(join(testDir, 'staged-enum-page-'));
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

    // The imported helper is real compiled code in the artifact, never
    // a handwritten stand-in.
    assert.ok(artifact.modules.some(module => module.js.includes('pickImported')),
      'imported helper ships in emitted modules');

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
    assert.deepEqual(Object.keys(canonicalModel.fields).sort(), ['kind', 'name']);
    const grantFields = Object.keys(canonicalModel.fields);
    const policy: PolicyTable = buildPolicyTable([{
      model: asModel(MODEL),
      secretFields: [],
      grants: [{ by: 'public', fields: grantFields }],
    }]);

    const store = createMemoryStorage();
    await seedRows(store, asModel(MODEL), [
      { id: 'cust-a1', data: { name: 'Ada', kind: 'individual' } },
      { id: 'cust-b1', data: { name: 'Bo', kind: 'company' } },
      { id: 'cust-c1', data: { name: 'Cy', kind: 'company' } },
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
    // each list heading carries its filter control, immediately followed
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

    // Defaults: nothing saved, no request selectors. Every default is
    // null, so every list serves every stored row with no predicate.
    let response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const defaultsHtml = await response.text();
    assert.ok(defaultsHtml.includes('data-can-list-filters'));
    const groups = groupsOf(defaultsHtml);
    for (const group of groups) {
      assert.equal(group.names.length, 1, 'one kind control per list');
      assert.ok(group.names[0]!.endsWith(':kind'), 'kind control only');
    }
    const directOccurrence = splitName(groups[0]!.names[0]!).occurrence;
    const localOccurrence = splitName(groups[1]!.names[0]!).occurrence;
    const importedOccurrence = splitName(groups[2]!.names[0]!).occurrence;
    const coalescedOccurrence = splitName(groups[3]!.names[0]!).occurrence;
    assert.ok(new Set([directOccurrence, localOccurrence,
      importedOccurrence, coalescedOccurrence]).size === 4, 'four distinct emitted occurrences');
    // Every phase below reuses these harvested names: the emitted
    // occurrence is never transcribed.
    for (const group of groups) assert.deepEqual(group.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(directOccurrence), [undefined]);
    assert.deepEqual(whereFor(localOccurrence), [undefined]);
    assert.deepEqual(whereFor(importedOccurrence), [undefined]);
    assert.deepEqual(whereFor(coalescedOccurrence), [undefined]);

    // Occurrence roles are labeled from the EMITTED bytes: the
    // `defaults:{...}` shape following each `occurrence:"..."` marker.
    // Helper calls lower to `await`ed registry bindings whose plain
    // qualified names (`Probe.pickLocal`, `EnumKindLib.pickImported`)
    // the emitted `canApp` registry binds to distinct ids; the defaults
    // reference those ids. Render order is source order (direct, local
    // helper, imported helper, coalesced fallback).
    const helperBinding = (qualified: string): string => {
      const binding = entryModule.js.match(
        new RegExp(`"${qualified}":\\$can\\$s\\$([0-9a-f]+)`));
      assert.ok(binding, `emitted registry binds ${qualified}`);
      return `$can$s$${binding[1]}`;
    };
    const localBinding = helperBinding('Probe.pickLocal');
    const importedBinding = helperBinding('EnumKindLib.pickImported');
    assert.ok(localBinding !== importedBinding, 'local and imported helpers are distinct bindings');
    const occurrenceSuffix = encodeURIComponent(JSON.stringify([descriptor.path]));
    const emittedShape = (occurrence: string): string => {
      assert.ok(occurrence.endsWith(occurrenceSuffix), 'runtime occurrence extends its emitted prefix');
      const marker = `occurrence:"${occurrence.slice(0, occurrence.length - occurrenceSuffix.length)}"`;
      const at = entryModule.js.indexOf(marker);
      assert.ok(at >= 0, `emitted occurrence marker present for ${occurrence}`);
      const defaultsAt = entryModule.js.indexOf('defaults:{', at);
      assert.ok(defaultsAt >= 0, `emitted defaults follow the occurrence marker for ${occurrence}`);
      const shapeWindow = entryModule.js.slice(defaultsAt, defaultsAt + 400);
      if (shapeWindow.includes(localBinding)) return 'local-helper';
      if (shapeWindow.includes(importedBinding)) return 'imported-helper';
      if (shapeWindow.includes('preferences.backup')) return 'coalesced';
      if (shapeWindow.includes('preferences.kind')) return 'direct';
      assert.fail(`unrecognized emitted defaults shape after ${marker}: ${shapeWindow}`);
    };
    assert.equal(emittedShape(directOccurrence), 'direct');
    assert.equal(emittedShape(localOccurrence), 'local-helper');
    assert.equal(emittedShape(importedOccurrence), 'imported-helper');
    assert.equal(emittedShape(coalescedOccurrence), 'coalesced');

    // Saved enum spelling (string, as the store holds it) filters rows.
    // All four defaults agree exactly: direct, local helper, imported
    // helper, and the coalesced fallback select company rows with a
    // typed string predicate.
    prefs.set('Probe/kind', { value: 'company', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const savedHtml = await response.text();
    const saved = groupsOf(savedHtml);
    for (const group of saved) assert.deepEqual(group.ids, ['cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    for (const occurrence of [directOccurrence, localOccurrence,
      importedOccurrence, coalescedOccurrence]) {
      assert.deepEqual(whereFor(occurrence), [{ op: 'eq', field: 'kind', value: 'company' }]);
      assert.equal(typeof (whereFor(occurrence)[0] as unknown as { value: unknown }).value, 'string');
    }
    assert.ok(savedHtml.includes('<option value="company" selected>'));

    // Saved kind wins over saved backup on every list.
    prefs.set('Probe/kind', { value: 'individual', version: '2' });
    prefs.set('Probe/backup', { value: 'company', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    for (const group of groupsOf(await response.text())) assert.deepEqual(group.ids, ['cust-a1']);
    assert.equal(calls.length, 4);
    for (const occurrence of [directOccurrence, localOccurrence,
      importedOccurrence, coalescedOccurrence]) {
      assert.deepEqual(whereFor(occurrence), [{ op: 'eq', field: 'kind', value: 'individual' }]);
    }

    // Explicit request beats the saved spelling on the direct list.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[0]!.names[0]!, 'company']]));
    assert.equal(response.status, 200);
    const overridden = groupsOf(await response.text());
    assert.deepEqual(overridden[0]!.ids, ['cust-b1', 'cust-c1']);
    assert.deepEqual(overridden[1]!.ids, ['cust-a1']);
    assert.deepEqual(overridden[2]!.ids, ['cust-a1']);
    assert.deepEqual(overridden[3]!.ids, ['cust-a1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(directOccurrence), [{ op: 'eq', field: 'kind', value: 'company' }]);
    assert.deepEqual(whereFor(localOccurrence), [{ op: 'eq', field: 'kind', value: 'individual' }]);

    // Explicit clear beats the saved spelling on the direct list.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[0]!.names[0]!, '']]));
    assert.equal(response.status, 200);
    const cleared = groupsOf(await response.text());
    assert.deepEqual(cleared[0]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(cleared[1]!.ids, ['cust-a1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(directOccurrence), [undefined]);

    // B15 DISCRIMINATOR: with no saved kind, only the coalesced list
    // falls back to the saved backup; the direct and helper lists serve
    // every row with no predicate.
    prefs.delete('Probe/kind');
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const fallback = groupsOf(await response.text());
    assert.deepEqual(fallback[0]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(fallback[1]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(fallback[2]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(fallback[3]!.ids, ['cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(directOccurrence), [undefined]);
    assert.deepEqual(whereFor(localOccurrence), [undefined]);
    assert.deepEqual(whereFor(importedOccurrence), [undefined]);
    assert.deepEqual(whereFor(coalescedOccurrence), [{ op: 'eq', field: 'kind', value: 'company' }]);

    // Request precedence through the coalesced path: an explicit
    // individual on the coalesced list serves the individual row while
    // the direct and helper lists keep following the fallback.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[3]!.names[0]!, 'individual']]));
    assert.equal(response.status, 200);
    const coalescedOverridden = groupsOf(await response.text());
    assert.deepEqual(coalescedOverridden[0]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(coalescedOverridden[3]!.ids, ['cust-a1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(coalescedOccurrence), [{ op: 'eq', field: 'kind', value: 'individual' }]);
    assert.deepEqual(whereFor(directOccurrence), [undefined]);

    // Clear through the local-helper path: an explicit clear on the
    // local list serves every row while the imported list keeps
    // following saved.
    prefs.set('Probe/kind', { value: 'company', version: '3' });
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[1]!.names[0]!, '']]));
    assert.equal(response.status, 200);
    const helperCleared = groupsOf(await response.text());
    assert.deepEqual(helperCleared[1]!.ids, ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.deepEqual(helperCleared[2]!.ids, ['cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(localOccurrence), [undefined]);
    assert.deepEqual(whereFor(importedOccurrence), [{ op: 'eq', field: 'kind', value: 'company' }]);

    // Request through the imported-helper path: an explicit individual
    // on the imported list serves the individual row while the local
    // list keeps following saved.
    calls.length = 0;
    response = await get(new URLSearchParams([[groups[2]!.names[0]!, 'individual']]));
    assert.equal(response.status, 200);
    const importedOverridden = groupsOf(await response.text());
    assert.deepEqual(importedOverridden[2]!.ids, ['cust-a1']);
    assert.deepEqual(importedOverridden[1]!.ids, ['cust-b1', 'cust-c1']);
    assert.equal(calls.length, 4);
    assert.deepEqual(whereFor(importedOccurrence), [{ op: 'eq', field: 'kind', value: 'individual' }]);
    assert.deepEqual(whereFor(localOccurrence), [{ op: 'eq', field: 'kind', value: 'company' }]);
    prefs.delete('Probe/kind');
    prefs.delete('Probe/backup');

    // Malformed selectors refuse before query or body work.
    for (const params of [new URLSearchParams([[groups[0]!.names[0]!, 'bogus']]),
      new URLSearchParams([['filter[kind]', 'company']])]) {
      calls.length = 0;
      response = await get(params);
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { code?: unknown }).code, 'validation');
      assert.equal(calls.length, 0);
    }

    // An unknown SAVED spelling never reaches a query: the host rejects
    // the stored value at saved-preference materialization (the checked
    // typed read, `rule_failed`) before admission, render, or any query,
    // helper, or body work — the same owning boundary as the B9
    // malformed saved bool.
    prefs.set('Probe/kind', { value: 'bogus', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'rule_failed');
    assert.equal(calls.length, 0);
    prefs.delete('Probe/kind');

    // The coalesced fallback reads the backup too: an unknown saved
    // backup spelling refuses at the same page-wide materialization
    // (`rule_failed`) with no query issued.
    prefs.set('Probe/backup', { value: 'bogus', version: '1' });
    calls.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'rule_failed');
    assert.equal(calls.length, 0);
    prefs.delete('Probe/backup');

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
