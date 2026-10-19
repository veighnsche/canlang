/** Genuine unchanged Compiler row-subject source consumed by installed Dev/State and local D1. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
import { createMemoryIdentityStore as createFullIdentityStore } from '@canlang/identity/testing';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { FIXED_NOW, asModel, asOperationId, makeIdentity, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { distribution } from '@canlang/values/distribution';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { invokeCallable, loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';
import { buildInvoker, type MutationOutcome } from '@canlang/cloudflare/worker/assembly';

// Resolve the actual dependency from its installing Cloudflare package.
type D1Database = Parameters<typeof ensureSchema>[0];
interface MiniflareInstance {
  getD1Database(name: string): Promise<D1Database>;
  dispose(): Promise<void>;
}
const localRequire = createRequire(import.meta.url);
const cloudflareModulesPath = localRequire.resolve('@canlang/cloudflare/runtime/modules');
const { Miniflare } = createRequire(cloudflareModulesPath)('miniflare') as {
  Miniflare: new (options: Record<string, unknown>) => MiniflareInstance;
};
let sequence = 0;
function committed(outcome: MutationOutcome) {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  return outcome.result;
}

test('fresh native row-subject metadata authorizes title-only D1 reads with current independent Identity subjects',
  { timeout: 90000 }, async () => {
  const root = resolve('.'), ownerSource = join(root, 'compiler/tests/row_subject_policy.rs');
  const ownerBytes = await readFile(ownerSource, 'utf8');
  assert.ok(ownerBytes.length < 1000000, 'owning test source stays within the extraction bound');
  const matches = [...ownerBytes.matchAll(/const SOURCE: &str = r#"([\s\S]{1,8192}?)"#;/g)];
  assert.equal(matches.length, 1, 'use exactly the original owning Compiler SOURCE constant');
  const original = matches[0]![1]!;
  const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
  const producerHashes = await Promise.all([ownerSource, compiler, catalog].map(async path => digest(await readFile(path))));
  const dir = await mkdtemp(join(tmpdir(), 'can-native-row-subject-'));
  let worker: MiniflareInstance | undefined;
  try {
    const sourcePath = join(dir, 'row-subject.can');
    await writeFile(sourcePath, original);
    const env = { ...process.env }; delete env.CAN_CATALOG;
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--catalog', catalog, sourcePath],
      { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.equal(artifact.artifact_version, 1);
    assert.ok(artifact.modules.length > 0, 'actual native artifact is mandatory');
    assert.ok(artifact.sources.some(source => resolve(source.path) === sourcePath && source.sha256 === digest(original)),
      'compiler source inventory corresponds to the unchanged original bytes');
    const asm = await assembleModules({ artifact, sourcePath }, {
      workDir: join(dir, 'modules'),
      stdlibUrl: pathToFileURL(localRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,
      uiUrl: pathToFileURL(localRequire.resolve('@canlang/ui')).href,
    });
    // Refuse copied/swapped assemblies before a carrierless module initializer
    // can run. Checked source is established from the original artifact.
    const initializerMarker = join(dir, 'unexpected-initializer');
    const swappedPath = join(dir, 'swapped.mjs'), swappedUrl = pathToFileURL(swappedPath).href;
    const uncheckedSource = `import {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(initializerMarker)},'ran');\nexport function canApp(){return {policy:{models:{}}};}\n`;
    await writeFile(swappedPath, uncheckedSource);
    const swapped = { ...asm, entryUrl: swappedUrl,
      moduleUrls: Object.fromEntries(Object.keys(asm.moduleUrls).map(path => [path, swappedUrl])) };
    const noContext = new Proxy({} as Parameters<typeof invokeCallable>[3], {
      get() { throw new Error('unverified callable demanded handler context'); },
    });
    await assert.rejects(() => invokeCallable(swapped, artifact, artifact.callables[0]!.id, noContext),
      /assembler-owned|original verified assembly/);
    await assert.rejects(() => loadCanonicalDescriptors(swapped, artifact),
      /assembler-owned|original verified assembly/);
    const tampered = await assembleModules({ artifact, sourcePath }, {
      workDir: join(dir, 'tampered-modules'),
      stdlibUrl: pathToFileURL(localRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href,
      uiUrl: pathToFileURL(localRequire.resolve('@canlang/ui')).href,
    });
    await writeFile(fileURLToPath(tampered.moduleUrls[artifact.modules[0]!.path]!), uncheckedSource);
    await assert.rejects(() => loadCanonicalDescriptors(tampered, artifact), /staged module bytes changed/);
    const stripped = JSON.parse(JSON.stringify(artifact)) as CompileArtifact;
    for (const module of stripped.modules) module.js = module.js.replaceAll('roleSubject', 'actorSubject');
    await assert.rejects(() => invokeCallable(tampered, stripped, stripped.callables[0]!.id, noContext),
      /artifact differs from assembled source/);
    await assert.rejects(() => loadCanonicalDescriptors(tampered, stripped), /artifact differs from assembled source/);
    await assert.rejects(() => readFile(initializerMarker), { code: 'ENOENT' });
    const namespace = await importVerifiedAssemblyModule(asm, artifact.modules[0]!.path, artifact);
    assert.ok(typeof namespace === 'object' && namespace !== null && 'appDefinition' in namespace);
    const definition = namespace.appDefinition as { id: string; models: Record<string, {
      readGrants: Array<{ rule: string; by: unknown[]; fields: string[] }> }> };
    assert.equal(definition.id, 'RowSubject');
    for (const [model, field] of [['RowSubject.Entry', 'person'], ['RowSubject.OptionalEntry', 'optional']] as const) {
      const grant = definition.models[model]!.readGrants;
      assert.equal(grant.length, 1);
      assert.deepEqual(grant[0]!.by, [{ roleSubject: { role: 'RowSubject.auditor', person: { model, field } } }]);
      assert.deepEqual(grant[0]!.fields, ['title']);
    }
    // The source callable stays generated; canonical descriptor reads consume
    // its checked data carrier, not unsupported native hasRole(subject).
    assert.ok(artifact.modules.some(module => module.js.includes('hasRole(c,"RowSubject.auditor",')));
    await loadCanonicalDescriptors(asm, artifact);
    await assert.rejects(() => loadCanonicalDescriptors({ ...asm, moduleUrls: { ...asm.moduleUrls } }, artifact),
      /original verified assembly/);
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'native-row-subject' }, d1Persist: join(dir, 'd1') });
    const database = await worker.getD1Database('DB') as unknown as D1Database;
    await ensureSchema(database);
    const store = createD1Storage(database);
    const identities = createFullIdentityStore({ clock: { nowMs: () => FIXED_NOW } });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = (email: string) => identities.createUser({ email, email_verified: true, password_hash: 'unused' });
    const caller = await user('caller@row-subject.test'), auditor = await user('auditor@row-subject.test');
    const ordinary = await user('ordinary@row-subject.test');
    const role = { role: 'RowSubject.auditor', granted_at: new Date(FIXED_NOW).toISOString(), granted_by: caller.user_id };
    const callerMembership = await identities.createMembership({ team_id: team.team_id, user_id: caller.user_id, is_owner: true, roles: [] });
    const auditorMembership = await identities.createMembership({ team_id: team.team_id, user_id: auditor.user_id, is_owner: false, roles: [role] });
    const ordinaryMembership = await identities.createMembership({ team_id: team.team_id, user_id: ordinary.user_id, is_owner: true, roles: [] });
    const callerIdentity = makeIdentity({ membership: callerMembership, team, email: caller.email });
    const auditorIdentity = makeIdentity({ membership: auditorMembership, team, email: auditor.email });
    const ordinaryIdentity = makeIdentity({ membership: ordinaryMembership, team, email: ordinary.email });
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => FIXED_NOW });
    const create = async (model: string, inputs: MutationEnvelope['inputs']) => {
      const selectedModel = asModel(`RowSubject.${model}`);
      const beforeIds = new Set((await store.query({ model: selectedModel, authority: 'owner' })).map(row => row.id));
      committed(await invoker.invokeMutation({ operation: `RowSubject.${model}.create`, inputs,
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)) }, callerIdentity));
      // Current subject grants may legitimately disclose zero created rows.
      // Select the actual new physical row without treating disclosure as storage.
      const added = (await store.query({ model: selectedModel, authority: 'owner' })).filter(row => !beforeIds.has(row.id));
      assert.equal(added.length, 1);
      assert.equal(added[0]!.data.title, inputs.title);
      return { id: added[0]!.id };
    };
    const entry = await create('Entry', { person: { id: auditor.user_id }, title: 'auditor title' });
    await create('Entry', { person: { id: ordinary.user_id }, title: 'ordinary owner title' });
    const optional = await create('OptionalEntry', { optional: { id: auditor.user_id }, title: 'optional auditor title' });
    await create('OptionalEntry', { optional: { id: ordinary.user_id }, title: 'optional ordinary title' });
    await create('OptionalEntry', { optional: null, title: 'null title' });
    const snapshot = async () => {
      const names = (await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name").all<{ name: string }>()).results;
      const tables: Record<string, string[]> = {};
      for (const { name } of names) {
        assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
        tables[name] = (await database.prepare(`SELECT * FROM "${name}"`).all()).results.map(row => JSON.stringify(row)).sort();
      }
      return { revision: await store.readRevision(), tables };
    };
    const before = await snapshot();
    const identityResources = async () => ({ team: await identities.findTeamById(team.team_id),
      users: await Promise.all([caller, auditor, ordinary].map(user => identities.findUserById(user.user_id))),
      memberships: await Promise.all([callerMembership, auditorMembership, ordinaryMembership]
        .map(member => identities.findMembershipById(member.membership_id))) });
    const originalIdentityResources = await identityResources();
    let commits = 0, receiptReads = 0, snapshots = 0, revoke = false;
    const reader = { ...identities, async findMembershipsSnapshot(teamId: string, users: readonly string[]) {
      const observed = await identities.findMembershipsSnapshot(teamId, users);
      assert.equal(teamId, team.team_id);
      assert.deepEqual(observed.entries.map(entry => entry.user_id), users);
      snapshots++;
      if (revoke) { revoke = false; await identities.setMembershipRoles(auditorMembership.membership_id, []); }
      return observed;
    } };
    const readStore: StoragePort = { ...store,
      async commit() { commits++; throw new Error('row-subject fresh read commit tripwire'); },
      async readReceipt() { receiptReads++; throw new Error('row-subject fresh read receipt tripwire'); } };
    const readInvoker = buildInvoker(artifact, asm, readStore, { memberships: reader, now: () => FIXED_NOW });
    const read = async (model: string, identity = callerIdentity) => {
      const result = await readInvoker.invokeRead({ operation: `RowSubject.${model}.read`, inputs: {} }, identity);
      assert.deepEqual(await snapshot(), before, 'fresh reads preserve every D1 table, receipt, history and revision');
      assert.ok('result' in result, JSON.stringify(result));
      const served = result.result as { records: Array<{ id: string; data: Record<string, unknown> }>; revision: number };
      assert.equal(served.revision, before.revision);
      return served.records;
    };
    for (const identity of [callerIdentity, ordinaryIdentity, auditorIdentity]) {
      assert.deepEqual((await read('Entry', identity)).map(row => ({ id: row.id, data: row.data })),
        [{ id: entry.id, data: { title: 'auditor title' } }]);
      assert.deepEqual((await read('OptionalEntry', identity)).map(row => ({ id: row.id, data: row.data })),
        [{ id: optional.id, data: { title: 'optional auditor title' } }]);
    }
    assert.ok(snapshots >= 12, 'actual coherent Identity producer establishes and revalidates caller/row facts');
    assert.deepEqual(await identityResources(), originalIdentityResources, 'successful reads change no Identity resources');
    assert.deepEqual(await identities.findMembershipById(callerMembership.membership_id), callerMembership);
    assert.deepEqual(await identities.findMembershipById(ordinaryMembership.membership_id), ordinaryMembership);
    revoke = true;
    const revoked = await readInvoker.invokeRead({ operation: 'RowSubject.Entry.read', inputs: {} }, callerIdentity);
    assert.equal(revoke, false, 'revocation occurred after an actual coherent authority snapshot');
    assert.ok('error' in revoked, JSON.stringify(revoked)); assert.equal(revoked.error.code, 'forbidden');
    assert.deepEqual(await snapshot(), before);
    const revokedIdentityResources = await identityResources();
    assert.deepEqual(revokedIdentityResources.team, originalIdentityResources.team);
    assert.deepEqual(revokedIdentityResources.users, originalIdentityResources.users);
    assert.deepEqual(await read('Entry'), []);
    assert.deepEqual(await read('OptionalEntry', auditorIdentity), [], 'nullable absence never falls back to the auditor actor');
    assert.deepEqual((await identities.findMembershipById(auditorMembership.membership_id))!.roles, []);
    assert.deepEqual(await identities.findMembershipById(callerMembership.membership_id), callerMembership);
    assert.deepEqual(await identities.findMembershipById(ordinaryMembership.membership_id), ordinaryMembership);
    assert.equal(commits, 0); assert.equal(receiptReads, 0);
    assert.deepEqual(await identityResources(), revokedIdentityResources, 'revoked reads add no Identity changes');
    assert.deepEqual(await Promise.all([ownerSource, compiler, catalog].map(async path => digest(await readFile(path)))), producerHashes,
      'original source and native/catalog producers remain unchanged for the consumer');
    assert.equal(await readFile(sourcePath, 'utf8'), original);
  } finally {
    try { await worker?.dispose(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});
