/** Original Partner record route, source-owned capture action and public field policy. */
import { createCheckoutScratch } from '../src/dev/checkout-scratch.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact } from '@canlang/contracts';
import type { PageHttpDeps } from '@canlang/interfaces';
import { createSourceFormBindings, handlePageRequest } from '@canlang/interfaces';
import { buildSessionCookie, createD1IdentityStore, ensureIdentitySchema, sha256HexText, resolveIdentity } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asId, asModel, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { loadCanonicalDescriptors, materializeCanonicalExampleSnapshots } from '@canlang/cloudflare/runtime/invoke';
import { assembleWorker } from '@canlang/cloudflare/worker/assembly';
import { buildDerivedInputsModule } from '../dist/deploy/bundle.js';
import { discoverGeneratedClosure } from '../dist/dev/generated-capture.js';
import { preparePartnerShareSource } from './partner-share-source.ts';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const app = 'CanAffiliate', partnerModel = asModel('affiliate.Partner'), locationModel = asModel('rent_catalog.Location');
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(tables.success, true);
  const rows: Record<string, readonly Record<string, unknown>[]> = {};
  for (const { name } of tables.results) {
    const result = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(result.success, true);
    rows[name] = result.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return rows;
}

test('original Partner share record route renders only public fields under a nonprivileged member', { timeout: 180000 }, async () => {
  const directory = await realpath(await createCheckoutScratch(root, 'native-partner-share-'));
  let worker: Miniflare | undefined, completed = false;
  try {
    const selected = await preparePartnerShareSource(directory);
    const compiler = process.env.CAN_COMPILER ?? join(root, 'compiler/target/debug/can');
    const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
    const generated = await discoverGeneratedClosure(compiler, root, selected.sourcePath);
    const generatedPaths = generated.files.map(file => resolve(root, file.path));
    const inputPaths = [...new Set([selected.sourcePath, ...selected.originalInputPaths, ...generatedPaths, compiler, catalog])];
    const hashes = () => Promise.all(inputPaths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
    const beforeHashes = await hashes();
    const env = { ...process.env }; delete env.CAN_CATALOG;
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, selected.sourcePath],
      { cwd: root, env, timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.equal(artifact.artifact_version, 1);
    const sourceIdentity = createHash('sha256').update(selected.source).digest('hex');
    assert.ok(artifact.sources.some(source => resolve(source.path) === selected.sourcePath && source.sha256 === sourceIdentity));
    const expectedSources = new Map([[selected.sourcePath, sourceIdentity]]);
    for (const path of generated.compilerSources) {
      // Discovery names the primary operand relative to the checkout; this
      // direct native compile uses its captured absolute path instead.
      if (resolve(root, path) === selected.sourcePath) continue;
      const physical = resolve(generated.root, path);
      assert.ok(generatedPaths.includes(physical), `uncaptured saved compiler source ${path}`);
      expectedSources.set(path, createHash('sha256').update(await readFile(physical)).digest('hex'));
    }
    const byPath = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path);
    assert.deepEqual(artifact.sources.map(({ path, sha256 }) => ({ path, sha256 })).sort(byPath),
      [...expectedSources].map(([path, sha256]) => ({ path, sha256 })).sort(byPath));
    const assembly = await assembleModules({ artifact, sourcePath: selected.sourcePath }, { workDir: join(directory, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const loaded = await loadCanonicalDescriptors(assembly, artifact);
    assert.ok(loaded.models.some(model => model.name === 'sales_attribution.Capture'));
    // Every original invariant remains installed; setup is not a reduced model table.
    assert.ok(loaded.models.some(model => model.name === 'refer.Program'));
    assert.ok(loaded.models.some(model => model.name === 'refer.Advocate'));
    assert.deepEqual(artifact.modelPolicies?.flatMap(policy => policy.rules.filter(rule => rule.kind === 'invariant').map(() => policy.model)).sort(),
      ['employee.Employee', 'customer.CompanyRole', 'refer.Program', 'refer.Advocate', 'affiliate.Partner', 'sales_attribution.Capture'].sort());
    assert.deepEqual(artifact.modelPolicies?.flatMap(policy => policy.rules.filter(rule => rule.kind === 'lock').map(() => policy.model)).sort(),
      ['refer.Advocate', 'refer.Credit', 'sales_attribution.Capture'].sort());
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { IDENTITY: 'partner-page-identity', STATE: 'partner-page-state' }, d1Persist: join(directory, 'd1') });
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const db = await worker.getD1Database('STATE') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db);
    const clock = { nowMs: () => FIXED_NOW }, identities = createD1IdentityStore(identityDb, { clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const reader = await identities.createUser({ email: 'reader@partner.example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: reader.user_id, is_owner: false, roles: [] });
    const broker = await identities.createUser({ email: 'broker@partner.example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: broker.user_id, is_owner: false, roles: [] });
    const owner = await identities.createUser({ email: 'owner@partner.example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
    const token = 'native-partner-page-reader';
    await identities.createSession({ user_id: reader.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
      expires_at: new Date(FIXED_NOW + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    assert.equal(identity.actor?.user_id, reader.user_id);
    const physical = createD1Storage(db);
    const site = asId(uuidv7(FIXED_NOW, 401)), active = asId(uuidv7(FIXED_NOW, 402)), inactive = asId(uuidv7(FIXED_NOW, 403));
    const snapshots: Parameters<typeof materializeCanonicalExampleSnapshots>[0]["snapshots"] = [
      { model: locationModel, id: site, data: { name: 'Main', address: '1 Example Road', timezone: 'Europe/Brussels', currency: 'EUR', hours: '09:00–18:00', arrival: 'Report to reception', active: true } },
      ...[active, inactive].map((id) => ({ model: partnerModel, id, data: {
        window: '2592000000', provider_revision: '0', onboarding_delivery: null, account_delivery: null,
        onboarding_url: null, onboarding_expires: null, provider_state: 'ready', name: id === active ? 'Broker <public>' : 'Inactive broker',
        account: { id: broker.user_id }, email: 'private-broker@example.test', locations: [{ id: site, version: '1' }], products: ['office'],
        rate: '0.1', agreement: 'private agreement', milestone: 'completed', provider_account: 'private-connected-account', onboarded: true, active: id === active,
      } })),
    ];
    await materializeCanonicalExampleSnapshots({ asm: assembly, artifact, store: physical, identity,
      now: FIXED_NOW, operationId: uuidv7(FIXED_NOW, 404), snapshots });
    const derivedModule = await import(`data:text/javascript,${encodeURIComponent(buildDerivedInputsModule(artifact))}`);
    const derivedInputs = derivedModule.derivedInputs as NonNullable<Parameters<typeof assembleWorker>[2]['http']>['derivedInputs'];
    assert.ok(derivedInputs);
    const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(54), 'native-partner-share');
    const served = await assembleWorker(artifact, assembly, { store: physical, identityStore: identities, now: clock.nowMs,
      pageReads: { scope: { app, owner: team.team_id, ownerPackage: 'affiliate' }, sourceIdentity },
      http: { formBindings, derivedInputs, createPageHandler: deps => request => handlePageRequest(deps as unknown as PageHttpDeps, request) } }, { active: true });
    const cookie = buildSessionCookie(token, { secure: false, maxAgeSeconds: 3600 }).split(';')[0]!;
    const resources = async () => ({ state: await snapshot(db), identity: await snapshot(identityDb) });
    const baseline = await resources();
    for (const partial of [false, true]) {
      const response = await served.fetch(new Request(`https://partner.example.test/partners/share/${active}`, { headers: { cookie, ...(partial ? { 'hx-request': 'true' } : {}) } }));
      assert.equal(response.status, 200, await response.clone().text());
      const html = await response.text();
      assert.match(html, /Broker &lt;public&gt;/);
      assert.match(html, /Use attribution code/);
      assert.ok(html.includes('sales_attribution.capture'), 'the rendered action is the original imported operation');
      for (const secret of ['private-broker@example.test', 'private agreement', 'private-connected-account']) assert.equal(html.includes(secret), false);
      assert.deepEqual(await resources(), baseline, 'rendering never invokes attribution capture');
    }
    for (const id of [inactive, uuidv7(FIXED_NOW, 405), 'malformed-record-id']) {
      const response = await served.fetch(new Request(`https://partner.example.test/partners/share/${id}`, { headers: { cookie } }));
      assert.ok(response.status >= 400, await response.clone().text());
      assert.equal((await response.text()).includes('private agreement'), false);
      assert.deepEqual(await resources(), baseline);
    }
    assert.deepEqual(await hashes(), beforeHashes);
    assert.deepEqual(await discoverGeneratedClosure(compiler, root, selected.sourcePath), generated);
    completed = true;
  } finally {
    await worker?.dispose();
    if (completed) await rm(directory, { recursive: true, force: true });
    else console.error(`Retained original Partner page closure: ${directory}`);
  }
});

/** Genuine original declarations/rules through the same owner session used by
 * default example setup. Fixture staging validates final invariants, and
 * deliberately bypasses entry locks; original lock edits remain pending below.
 * No test operation or permission replaces the source. */
test('original Program and Advocate query invariants validate final fixture transactions and dependency changes atomically', { timeout: 180000 }, async (t) => {
  const directory = await realpath(await createCheckoutScratch(root, 'native-partner-invariants-'));
  let worker: Miniflare | undefined, completed = false;
  try {
    const selected = await preparePartnerShareSource(directory);
    const compiler = process.env.CAN_COMPILER ?? join(root, 'compiler/target/debug/can');
    const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
    const generated = await discoverGeneratedClosure(compiler, root, selected.sourcePath);
    const paths = [...new Set([selected.sourcePath, ...selected.originalInputPaths,
      ...generated.files.map(file => resolve(root, file.path)), compiler, catalog])];
    const hashes = () => Promise.all(paths.map(async path => createHash('sha256').update(await readFile(path)).digest('hex')));
    const originalHashes = await hashes();
    const env = { ...process.env }; delete env.CAN_CATALOG;
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, selected.sourcePath],
      { cwd: root, env, timeout: 90000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.ok(artifact.sources.some(source => resolve(source.path) === selected.sourcePath && source.sha256 === createHash('sha256').update(selected.source).digest('hex')));
    assert.equal(artifact.modelPolicies?.flatMap(policy => policy.rules.filter(rule => rule.kind === 'invariant')).length, 6);
    const program = asModel('refer.Program'), advocate = asModel('refer.Advocate'), credit = asModel('refer.Credit');
    const programRule = artifact.modelPolicies?.find(policy => policy.model === program)?.rules.find(rule => rule.kind === 'invariant');
    assert.ok(programRule?.kind === 'invariant');
    assert.deepEqual(programRule.dependencies.map(dependency => dependency.model).sort(), [credit, advocate].sort());
    const advocateRule = artifact.modelPolicies?.find(policy => policy.model === advocate)?.rules.find(rule => rule.kind === 'invariant');
    assert.ok(advocateRule?.kind === 'invariant'); assert.deepEqual(advocateRule.dependencies.map(dependency => dependency.model), [advocate]);
    const asm = await assembleModules({ artifact, sourcePath: selected.sourcePath }, { workDir: join(directory, 'modules'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    await loadCanonicalDescriptors(asm, artifact);
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { IDENTITY: 'partner-invariant-identity', STATE: 'partner-invariant-state' }, d1Persist: join(directory, 'd1') });
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const db = await worker.getD1Database('STATE') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db);
    const clock = { nowMs: () => FIXED_NOW }, identities = createD1IdentityStore(identityDb, { clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'invariants@partner.example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = 'native-original-invariant-owner';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
      expires_at: new Date(FIXED_NOW + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const underlying = createD1Storage(db), queried: string[] = [];
    const store: import('@canlang/contracts').StoragePort = { ...underlying, query: async spec => {
      queried.push(spec.model); return underlying.query(spec);
    } };
    let sequence = 700;
    const id = () => asId(uuidv7(FIXED_NOW, ++sequence));
    const apply = (snapshots: Parameters<typeof materializeCanonicalExampleSnapshots>[0]['snapshots']) =>
      materializeCanonicalExampleSnapshots({ asm, artifact, store, identity, now: FIXED_NOW, operationId: uuidv7(FIXED_NOW, ++sequence), snapshots });
    const rejected = async (snapshots: Parameters<typeof apply>[0]) => {
      const before = await snapshot(db);
      await assert.rejects(apply(snapshots), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'rule_failed');
      assert.deepEqual(await snapshot(db), before, 'failed owner transactions publish no rows, versions, history, claims or outbox');
    };
    const site = id(), eur = id(), usd = id(), first = id(), second = id(), earned = id();
    const money = (currency: string, minor = '100') => ({ minor, currency });
    const programData = (currency: string) => ({ name: currency, locations: [{ id: site, version: '1' }], products: ['meeting'],
      reward: money(currency), destination: 'https://example.test/' });
    await apply([
      { model: locationModel, id: site, data: { name: 'Main', address: '1 Example Road', timezone: 'Europe/Brussels', currency: 'EUR', hours: '09:00–18:00', arrival: 'Reception', active: true } },
      { model: program, id: eur, data: programData('EUR') }, { model: program, id: usd, data: programData('USD') },
    ]); // Both original ALL predicates accept their empty Credit domains.
    await apply([
      { model: advocate, id: first, parent: { model: program, id: eur }, data: { account: { id: user.user_id }, email: 'first@example.test', code: 'first' } },
      { model: advocate, id: second, parent: { model: program, id: usd }, data: { account: { id: user.user_id }, email: 'second@example.test', code: 'second' } },
    ]); // Each original global ANY excludes the candidate's own identity.
    const creditData = { source: 'earned', customer: 'new-customer', amount: money('EUR'), reversal: null, qualification: 'Original qualification' };
    await apply([{ model: credit, id: earned, parent: { model: advocate, id: first }, data: creditData }]);
    await rejected([{ model: credit, id: id(), parent: { model: advocate, id: first }, data: { ...creditData, source: 'wrong-currency', amount: money('USD') } }]);
    const eurRow = (await store.load(program, eur))!;
    await rejected([{ model: program, id: eur, data: { ...eurRow.data, reward: money('USD') } }]);
    queried.length = 0;
    await apply([{ model: advocate, id: id(), parent: { model: program, id: usd }, data: { account: { id: user.user_id }, email: 'third@example.test', code: 'third' } }]);
    assert.ok(queried.includes(credit), 'an Advocate change really rechecks Program through its original Credit query');
    await rejected([{ model: advocate, id: id(), parent: { model: program, id: usd }, data: { account: { id: user.user_id }, email: 'duplicate@example.test', code: 'first' } }]);
    const usdRow = (await store.load(program, usd))!;
    await apply([
      { model: program, id: usd, data: { ...usdRow.data, reward: money('EUR') } },
      { model: credit, id: id(), parent: { model: advocate, id: second }, data: { ...creditData, source: 'same-final-transaction' } },
    ]); // The invariant sees both actual final changes together.
    const advocateRow = (await store.load(advocate, first))!, creditRow = (await store.load(credit, earned))!;
    await t.test('original Advocate and Credit locked-field edits reject through an admitted mutation', {
      skip: 'Pending a production mutation carrier with the checked original policies and no invented source grants: fixture staging intentionally skips entry locks, and the selected source declares no Advocate/Credit update operation. State model-policies and native-local-rules tests cover lock enforcement separately.',
    }, async () => {
      // Retain the original expected rejections; release requires routing these
      // writes through that admitted mutation carrier rather than fixture apply.
      await rejected([{ model: advocate, id: first, parent: advocateRow.parent!, data: { ...advocateRow.data, code: 'changed-locked-code' } }]);
      await rejected([{ model: credit, id: earned, parent: creditRow.parent!, data: { ...creditRow.data, amount: money('EUR', '101') } }]);
    });
    assert.deepEqual(await hashes(), originalHashes);
    assert.deepEqual(await discoverGeneratedClosure(compiler, root, selected.sourcePath), generated);
    completed = true;
  } finally {
    await worker?.dispose();
    if (completed) await rm(directory, { recursive: true, force: true });
    else console.error(`Retained original Partner invariant closure: ${directory}`);
  }
});
