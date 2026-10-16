/**
 * B9 bounded real-source bool-page test (CAN18-v1 REVIEW-11 item 2).
 *
 * The B6 preparer test transcribes filter columns from the recorded artifact
 * and hand-drives `list` with a hand-written occurrence. This test instead
 * drives the whole compiled path: it compiles the committed
 * `test/fixtures/bool-page-source.can` with the real `can` binary
 * (`CAN_COMPILER_BIN`, catalog `CAN_NATIVE_CATALOG`), stages the EMITTED
 * module bytes verbatim, imports the page descriptor named by
 * `artifact.pages[0]`, and dispatches it through the real host seam
 * (`handlePageRequest` over `createTestDeps` + a real authorized identity)
 * against stored rows holding actual `true`/`false` values. Filter parameter
 * names are harvested from the rendered controls, never transcribed, so the
 * emitted occurrence stays the source of truth throughout.
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
 * Saved-bool coercion (B10): a SAVED bool preference reaches the emitted
 * render as the store spelling `"true"` / `"false"` (the preference store
 * is string-typed), and the compiler emission coerces those strict
 * spellings to real booleans in the `defaults` object before the host
 * preparer sees them. The preparer still requires boolean `bool` defaults
 * (B6 semantics retained: string defaults refuse with zero queries, never
 * truthy coercion, never partial filtering). Saved/request precedence for
 * the bool toggle is proven on the same path below, matching the
 * string-saved enum field.
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
  ResolvedIdentity,
  RowView,
} from '@canlang/contracts';
import { createTestDeps, testRequest } from '../src/testing.js';
import { handlePageRequest } from '../src/http/pages.js';
import type { PagePreferenceStore } from '../src/ports.js';

const execFileAsync = promisify(execFile);
const FIXTURE = 'packages/interfaces/test/fixtures/bool-page-source.can';

const STORED: RowView[] = [
  { id: 'cust-a1', version: '1', fields: { name: 'Ada', kind: 'individual', active: true } },
  { id: 'cust-b1', version: '1', fields: { name: 'Bo', kind: 'company', active: false } },
  { id: 'cust-c1', version: '1', fields: { name: 'Cy', kind: 'company', active: true } },
];

/** Query-owner projection: the State runner owns these in production; the
 * filter declarations under test arrive via the emitted render instead. */
const COLUMNS: ColumnMeta[] = [
  { field: 'name', label: 'name', type: 'text' },
  { field: 'kind', label: 'kind', type: 'enum:Probe.Customer.kind',
    valueLabels: { individual: 'individual', company: 'company' } },
  { field: 'active', label: 'active', type: 'bool', valueLabels: { true: 'true', false: 'false' } },
];

function applyWhere(rows: RowView[], where: unknown): RowView[] {
  if (where === undefined) return rows;
  assert.equal(typeof where, 'object');
  const predicate = where as { op?: unknown; field?: unknown; value?: unknown; args?: unknown };
  if (predicate.op === 'eq') {
    assert.equal(typeof predicate.field, 'string');
    return rows.filter(row => row.fields[predicate.field as string] === predicate.value);
  }
  if (predicate.op === 'and') {
    assert.ok(Array.isArray(predicate.args));
    return (predicate.args as unknown[]).reduce<RowView[]>(applyWhere, rows);
  }
  throw new Error(`unexpected where shape ${JSON.stringify(where)}`);
}

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

    const store = new Map<string, { value: string; version: string }>();
    const preferences: PagePreferenceStore = {
      read: async key => store.get(`${key.owner}/${key.field}`) ?? null,
      save: async key => {
        store.set(`${key.owner}/${key.field}`,
          { value: key.value, version: String(Number(key.expectedVersion) + 1) });
        return true;
      },
    };
    let queries = 0;
    const wheres: unknown[] = [];
    const { deps, identity } = await createTestDeps({ descriptors: [descriptor] });
    let principal: ResolvedIdentity | undefined;
    const scoped = { ...deps, preferences,
      createReadScope: (current: ResolvedIdentity) => {
        principal = current;
        return { query: async (invocation: unknown, model: string, args: unknown) => {
          queries++;
          assert.equal(invocation, principal, 'query runs under the authorized principal');
          assert.equal(model, 'Probe.Customer');
          const where = (args as { where?: unknown }).where;
          wheres.push(where);
          return { rows: applyWhere(STORED, where), columns: COLUMNS };
        } };
      } };

    const get = async (params: URLSearchParams, authed = true) => {
      const query = authed ? `team=${identity.teamId}&${params}` : params.toString();
      const request = testRequest(`/customers?${query}`, authed ? { cookie: identity.cookie } : {});
      return handlePageRequest(scoped, request);
    };
    const ids = (html: string) =>
      [...new Set([...html.matchAll(/cust-[a-c]1/g)].map(match => match[0]))].sort();

    // Defaults: nothing saved, no request selectors — every stored row serves.
    let response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const defaultsHtml = await response.text();
    assert.deepEqual(ids(defaultsHtml), ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [undefined]);
    assert.ok(defaultsHtml.includes('data-can-list-filters'));
    const names = [...defaultsHtml.matchAll(/<select[^>]*\bname="(can-filter:[^"]+)"[^>]*>/g)]
      .map(match => match[1]!);
    assert.equal(names.length, 2);
    const [kindName, activeName] = [names.find(name => name.endsWith(':kind')),
      names.find(name => name.endsWith(':active'))];
    assert.ok(kindName && activeName, 'both emitted filter controls render');
    assert.equal(kindName.slice(0, kindName.length - ':kind'.length),
      activeName.slice(0, activeName.length - ':active'.length), 'one emitted occurrence');
    // Every phase below reuses these harvested names: the emitted occurrence
    // is never transcribed.

    // Request true serves only true rows with a typed boolean predicate.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams([[activeName, 'true']]));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-a1', 'cust-c1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [{ op: 'eq', field: 'active', value: true }]);
    assert.equal(typeof (wheres[0] as unknown as { value: unknown }).value, 'boolean');

    // Request false serves only the false row.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams([[activeName, 'false']]));
    assert.equal(response.status, 200);
    const falseHtml = await response.text();
    assert.deepEqual(ids(falseHtml), ['cust-b1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [{ op: 'eq', field: 'active', value: false }]);
    assert.ok(falseHtml.includes('<option value="false" selected>'));

    // Explicit clear stays cleared.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams([[activeName, '']]));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [undefined]);

    // Saved enum spelling (string, as the store holds it) filters rows.
    store.set('Probe/kind', { value: 'company', version: '1' });
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-b1', 'cust-c1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [{ op: 'eq', field: 'kind', value: 'company' }]);

    // Explicit request beats the saved enum spelling.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams([[kindName, 'individual']]));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-a1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [{ op: 'eq', field: 'kind', value: 'individual' }]);

    // Saved enum composes with a request bool toggle into one typed query.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams([[activeName, 'false']]));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-b1']);
    assert.equal(queries, 1);
    assert.equal(wheres.length, 1);
    const composed = wheres[0] as unknown as { op: unknown; args: unknown };
    assert.equal(composed.op, 'and');
    assert.ok((composed.args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'kind' &&
      (arg as { field?: unknown; value?: unknown }).value === 'company'));
    assert.ok((composed.args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'active' &&
      (arg as { field?: unknown; value?: unknown }).value === false));
    store.delete('Probe/kind');

    // Saved bool spelling (string, as the store holds it) coerces at
    // emission to a typed boolean predicate serving only true rows.
    store.set('Probe/active', { value: 'true', version: '1' });
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const savedTrueHtml = await response.text();
    assert.deepEqual(ids(savedTrueHtml), ['cust-a1', 'cust-c1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [{ op: 'eq', field: 'active', value: true }]);
    assert.equal(typeof (wheres[0] as unknown as { value: unknown }).value, 'boolean');
    assert.ok(savedTrueHtml.includes('<option value="true" selected>'));

    // Saved false serves only the false row.
    store.set('Probe/active', { value: 'false', version: '1' });
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-b1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [{ op: 'eq', field: 'active', value: false }]);

    // Explicit request beats the saved bool spelling.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams([[activeName, 'true']]));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-a1', 'cust-c1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [{ op: 'eq', field: 'active', value: true }]);

    // Explicit clear beats the saved bool spelling.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams([[activeName, '']]));
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-a1', 'cust-b1', 'cust-c1']);
    assert.equal(queries, 1);
    assert.deepEqual(wheres, [undefined]);

    // Saved enum and saved bool compose into one typed query.
    store.set('Probe/kind', { value: 'company', version: '1' });
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    assert.deepEqual(ids(await response.text()), ['cust-b1']);
    assert.equal(queries, 1);
    assert.equal(wheres.length, 1);
    const savedComposed = wheres[0] as unknown as { op: unknown; args: unknown };
    assert.equal(savedComposed.op, 'and');
    assert.ok((savedComposed.args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'kind' &&
      (arg as { field?: unknown; value?: unknown }).value === 'company'));
    assert.ok((savedComposed.args as unknown[]).some(arg =>
      (arg as { field?: unknown; value?: unknown }).field === 'active' &&
      (arg as { field?: unknown; value?: unknown }).value === false));
    store.delete('Probe/kind');
    store.delete('Probe/active');

    // Malformed selectors refuse before query or body work.
    for (const params of [new URLSearchParams([[activeName, 'yes']]),
      new URLSearchParams([['filter[active]', 'true']])]) {
      queries = 0; wheres.length = 0;
      response = await get(params);
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as { code?: unknown }).code, 'validation');
      assert.equal(queries, 0);
      assert.deepEqual(wheres, []);
    }

    // Denied caller (no membership) refuses before any query.
    queries = 0; wheres.length = 0;
    response = await get(new URLSearchParams(), false);
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code?: unknown }).code, 'forbidden');
    assert.equal(queries, 0);
    assert.deepEqual(wheres, []);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
});
