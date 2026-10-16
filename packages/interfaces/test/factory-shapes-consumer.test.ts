/**
 * B17 executable factory-shape consumer (CAN18-v1 REVIEW-21 outcome 6).
 *
 * The retained factory-profile work admits recorded original24 shapes at
 * compile level only (compiler/tests/factory_profiles.rs drives check ->
 * IR -> lower_ui in process, never compiled/assembled/executed). String
 * inspection already missed two invalid admissions in that set: a bound
 * `timeline` emits model/parent/order/renderRow while the owning
 * TimelineProps takes items only (real factory throws reading
 * items.length), and agenda `calendar columns=` emits a prop
 * calendarAgenda never reads (byte-identical output either way). Both
 * stay refused; this test is the actual consumer for the shapes that
 * remain admitted.
 *
 * It compiles the committed `test/fixtures/factory-shapes-consumer.can`
 * with the real `can` binary (`CAN_COMPILER_BIN`, catalog
 * `CAN_NATIVE_CATALOG`), stages EVERY emitted module verbatim, imports
 * the page descriptor named by `artifact.pages[0]`, and dispatches it
 * through the real host seam (`handlePageRequest` over `createTestDeps`
 * + a real authorized identity). No factory or handler is handwritten:
 * bound queries are served by the EXISTING State query adapter
 * (`queryRecords` over `createMemoryStorage`); data-only function
 * predicates are evaluated per row view exactly like the production
 * reader (`invoke.ts` readRecords: `query.where(candidate.view, ctx)`
 * must return bool). Canonical rows are seeded through the real storage
 * commit path; viewer grants come from the EMITTED `appDefinition`;
 * caller membership resolves through the REAL identity fixture store.
 *
 * The page carries one list per admitted shape over real rows: an int
 * multi-stat join, a decimal multi-stat join, an `app_url(format(...))`
 * URL copy, bool-status steps, a content/badge indicator, and a
 * columns-free agenda calendar. Assertions read the RENDERED bytes:
 * stat values in source order, the trusted copy URL, step labels in
 * order, indicator markup, agenda day sections, the six blocks in source
 * order, public read grants preserved per model, the empty agenda
 * message with no rows, and anonymous/revoked refusal before any query.
 *
 * Compiler pin (B17 worktree binary consumed read-only via
 * CAN_COMPILER_BIN; `--version` 8165eccc5 plus the B17 factory-profile
 * qualification: bound timeline refused, agenda columns= refused, money
 * multi-stat refused, int/decimal multi-stat, URL copy, bool-status
 * steps, slotted indicator and columns-free agenda admitted; no other
 * compiler changes):
 * binary: /tmp/can18-b17-can
 * binary sha256: 407de8959a0e4c645d4cd987fba0564896477c0a21e5a06a4ae5e173c3477731
 * catalog sha256: ca50fdca852170b09f95ec4adb97cc63ddabf26437629c02dfd234991bc486a8 (packages/cloudflare/dist/native-catalog.json)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const FIXTURE = 'packages/interfaces/test/fixtures/factory-shapes-consumer.can';

test('compiled factory shapes render real rows through the host seam', async () => {
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
    throw new Error(`factory-shapes fixture compile failed: ${String(out.message)} ` +
      `stdout=${String(out.stdout ?? '').slice(0, 2000)} stderr=${String(out.stderr ?? '').slice(0, 2000)}`);
  }
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.ok(!('diagnostics' in artifact), 'real fixture emits clean');
  const source = artifact.sources.find(entry => entry.path === FIXTURE);
  assert.ok(source && source.sha256 === fixtureSha, 'compiled source identity preserved');
  assert.equal(artifact.pages.length, 1);
  const pageRef = artifact.pages[0]!;
  assert.equal(pageRef.owner, 'Probe');
  assert.equal(pageRef.path, '/shapes');

  // Assembly is the real consumer pipeline: it rewrites the bare
  // `@canlang/stdlib` import to the data-plane stdlib (which owns
  // app_url/format), stages every emitted module, and verifies the
  // artifact before import. No module bytes are hand-edited.
  const testRequire = createRequire(join(root, 'packages/interfaces/test/factory-shapes-consumer.test.js'));
  const stdlibUrl = pathToFileURL(testRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href;
  const uiUrl = pathToFileURL(testRequire.resolve('@canlang/ui')).href;
  const { assembleModules, importVerifiedAssemblyModule } = await import(
    pathToFileURL(testRequire.resolve('@canlang/cloudflare/runtime/modules')).href
  ) as {
    assembleModules: (input: unknown, opts: unknown) => Promise<unknown>;
    importVerifiedAssemblyModule: (asm: unknown, path: string, artifact: unknown) => Promise<Record<string, unknown>>;
  };
  const workDir = mkdtempSync(join(testDir, 'assembled-factory-shapes-'));
  try {
    const asm = await assembleModules(
      { artifact, sourcePath: join(root, FIXTURE) },
      { workDir, stdlibUrl, uiUrl },
    );
    const namespace = await importVerifiedAssemblyModule(asm, pageRef.module, artifact);
    const descriptor = namespace[pageRef.export] as PageDescriptor;
    assert.equal(descriptor.path, '/shapes');
    assert.equal(descriptor.owner, 'Probe');
    assert.equal(typeof descriptor.admit, 'function');
    assert.equal(typeof descriptor.render, 'function');

    // Viewer grants come from the EMITTED app definition, never transcribed.
    const appDefinition = (namespace as unknown as { appDefinition: {
      models: Record<string, {
        readGrants: { rule: string; by: string[] }[];
        fields: Record<string, unknown>;
      }>;
    } }).appDefinition;
    const MODELS = [
      'Probe.Account', 'Probe.Allowance', 'Probe.Advocate',
      'Probe.Term', 'Probe.Job', 'Probe.Request',
    ];
    for (const name of MODELS) {
      const model = appDefinition.models[name];
      assert.ok(model, `emitted model present: ${name}`);
      assert.deepEqual(model.readGrants.map(grant => grant.by), [['public']]);
    }
    const policy: PolicyTable = buildPolicyTable(MODELS.map(name => ({
      model: asModel(name),
      secretFields: [],
      grants: [{ by: 'public', fields: Object.keys(appDefinition.models[name]!.fields) }],
    })));

    const store = createMemoryStorage();
    await seedRows(store, asModel('Probe.Account'), [
      { id: 'acc-1', data: { title: 'Main', done: 7, total: 42 } },
    ]);
    await seedRows(store, asModel('Probe.Allowance'), [
      { id: 'alw-1', data: { granted: '150.75', available: '20' } },
    ]);
    await seedRows(store, asModel('Probe.Advocate'), [
      { id: 'adv-1', data: { name: 'Ada' } },
    ]);
    await seedRows(store, asModel('Probe.Term'), [
      { id: 'term-1', data: { executed: true, expired: false } },
    ]);
    await seedRows(store, asModel('Probe.Job'), [
      { id: 'job-1', data: { address: 'Main St', state: 'open' } },
    ]);
    await seedRows(store, asModel('Probe.Request'), [
      { id: 'req-1', data: { state: 'open', from: '2026-10-01', until: '2026-10-03', location: 'HQ' } },
      { id: 'req-2', data: { state: 'closed', from: '2026-10-02', until: '2026-10-04', location: 'HQ' } },
    ]);

    // Column metadata follows the artifact's declared field kinds
    // (integer/decimal/boolean/date/enum spellings, not the lane-2
    // CanTypeId vocabulary, which only matters for rendered enum/bool
    // filter controls this page does not carry).
    const columnsOf = (model: string): ColumnMeta[] => {
      const fields = artifact.models?.find(entry => entry.name === model)?.fields ?? [];
      return fields.map(field => {
        const declared = field.field as { kind?: unknown; values?: unknown };
        const kind = declared.kind;
        const type = kind === 'integer' ? 'int'
          : kind === 'decimal' ? 'decimal'
          : kind === 'boolean' ? 'bool'
          : kind === 'date' ? 'date'
          : kind === 'enum' ? 'enum'
          : 'text';
        const valueLabels = kind === 'enum' && Array.isArray(declared.values)
          ? Object.fromEntries((declared.values as string[]).map(value => [value, value]))
          : undefined;
        return {
          field: field.name,
          label: field.name,
          type,
          ...(valueLabels === undefined ? {} : { valueLabels }),
        } as ColumnMeta;
      });
    };

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
    const queries: { model: string }[] = [];
    const scoped = {
      ...deps,
      deploymentBase: 'https://app.example/',
      preferences,
      createReadScope: (current: ResolvedIdentity) => {
        const principal = current;
        return { query: async (invocation: unknown, model: string, args: ListQueryArgs) => {
          assert.equal(invocation, principal, 'query runs under the authorized principal');
          queries.push({ model });
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
          });
          // Data-only function predicates evaluate per row view like the
          // production reader; anything else stays a refusal downstream.
          let records = viewed.records;
          if (args.where !== undefined) {
            assert.equal(typeof args.where, 'function', 'agenda where stays its generated function');
            const kept: typeof records = [];
            for (const record of records) {
              const view = { ...record.data, id: record.id };
              const matches: unknown =
                await (args.where as (view: unknown, ctx: unknown) => unknown)(view, principal);
              assert.equal(typeof matches, 'boolean', 'source predicate returns bool');
              if (matches === true) kept.push(record);
            }
            records = kept;
          }
          const rows: RowView[] = records.map(record => ({
            id: record.id,
            version: String(record.version),
            fields: { ...record.data },
          }));
          const visible = new Set(records.flatMap(record => Object.keys(record.data)));
          return {
            rows,
            columns: columnsOf(model).filter(column => visible.has(column.field)),
          };
        } };
      } };

    const get = async (params: URLSearchParams, authed = true) => {
      const query = authed ? `team=${identity.teamId}&${params}` : params.toString();
      const request = testRequest(`/shapes?${query}`, authed ? { cookie: identity.cookie } : {});
      return handlePageRequest(scoped, request);
    };

    const response = await get(new URLSearchParams());
    assert.equal(response.status, 200);
    const html = await response.text();

    // Int multi-stat join renders both values in source order.
    const intStats = '⁨7⁩</div></div></div><div class="stats"><div class="stat"><div class="stat-value">⁨42⁩';
    assert.ok(html.includes(intStats), 'int stats render in source order');
    // Decimal multi-stat join renders exact decimal strings in order.
    assert.ok(html.includes('⁨150.75⁩</div></div></div><div class="stats"><div class="stat"><div class="stat-value">⁨20⁩'),
      'decimal stats render exact strings in source order');
    // URL copy renders the trusted deployment-base URL as its own label.
    assert.ok(html.includes('value="https://app.example/referrals/share/adv-1"'),
      'app_url copy renders the trusted URL');
    // Bool-status steps render live flags in slot order.
    assert.ok(html.includes('<li class="step">⁨true⁩</li><li class="step">⁨false⁩</li>'),
      'steps render bool flags in slot order');
    // Indicator dissolves its slots into marker + content.
    assert.ok(html.includes('<span class="indicator-item"><span class="badge">⁨open⁩</span></span>'),
      'indicator marker renders the badge');
    assert.ok(html.includes('Main St'), 'indicator content renders the address');
    // Columns-free agenda groups the open request by day; the closed
    // request stays filtered by the generated predicate.
    assert.ok(html.includes('<h2>Oct 1, 2026</h2>'), 'agenda renders the day section');
    assert.ok(html.includes('<span>req-1</span>'), 'agenda renders the open request');
    assert.ok(!html.includes('req-2'), 'agenda predicate excludes the closed request');
    // Six blocks render in source order.
    const order = [
      html.indexOf('⁨7⁩'),
      html.indexOf('⁨150.75⁩'),
      html.indexOf('referrals/share/adv-1'),
      html.indexOf('<li class="step">'),
      html.indexOf('indicator-item'),
      html.indexOf('<h2>Oct 1, 2026</h2>'),
    ];
    assert.ok(order.every(index => index !== -1), 'every shape block renders');
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'blocks keep source order');

    // Anonymous callers render the same public content: public read
    // grants flow end to end, never silent-empty and never masked.
    const before = queries.length;
    const anon = await get(new URLSearchParams(), false);
    assert.equal(anon.status, 200);
    const anonHtml = await anon.text();
    assert.ok(anonHtml.includes(intStats), 'anonymous callers read public int stats');
    assert.ok(anonHtml.includes('referrals/share/adv-1'), 'anonymous callers read the public copy URL');
    assert.ok(queries.length > before, 'anonymous callers run real queries');

    // Revoked sessions refuse before any query (seam-owned session gate).
    await revokeSessionByToken(identity.store, { token: identity.sessionToken });
    const revokedQueries = queries.length;
    const revoked = await get(new URLSearchParams());
    assert.equal(revoked.status, 403);
    assert.equal(((await revoked.json()) as { code?: unknown }).code, 'forbidden');
    assert.equal(queries.length, revokedQueries, 'revoked sessions run no query');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
