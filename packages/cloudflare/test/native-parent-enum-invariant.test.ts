/** Source-sealed parent enum rule -> fixture owner frame and native CRUD final view. */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CommitBatch, MutationEnvelope, StoredRow } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, uuidv7 } from '@canlang/state/testing/invocation/fixtures';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const APP = 'ParentEnumInvariant', CUSTOMER = asModel(`${APP}.Customer`), ROLE = asModel(`${APP}.CompanyRole`);
const invariant = 'invariant CompanyRole: row.parent.kind==company';
const SOURCE = `app ${APP}
Given
 Customer {kind:enum(person,company),name:text}
 CompanyRole in Customer {name:text}
 policy Customer read=members
 policy CompanyRole read=members
 ${invariant}
When
 crud Customer by=members fields=kind,name
 crud CompanyRole by=members fields=name
Then
`;
const ref = (row: StoredRow) => ({id: row.id, version: String(row.version)});

test('parent enum invariant activates in default fixture materialization and rechecks changed parents atomically',
  {timeout: 120000}, async () => {
    const directory = await createCheckoutScratch(root, 'native-parent-enum-');
    let worker: Miniflare | undefined;
    try {
      const original = await readFile(join(root, 'draft/apps/CanCustomer/CanCustomer.can'), 'utf8');
      assert.ok(original.split('\n').some(line => line.trim() === invariant));
      const sourcePath = join(directory, 'ParentEnum.can');
      await writeFile(sourcePath, SOURCE);
      const {assembleModules} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const {loadCanonicalDescriptors, materializeCanonicalExampleSnapshots} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const {buildInvoker} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const {installedLocalPreviewInputInventory} = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const {captureSingleFileSource, captureIsCurrent, verifyCompilerSources} = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const {compileCapturedSingleFile} = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const compilerPath = join(root, 'compiler/target/debug/can');
      const capture = await captureSingleFileSource({checkoutRoot: root, appPath: sourcePath, compilerPath,
        catalogPath: join(root, 'packages/cloudflare/dist/native-catalog.json'),
        profile: 'native-parent-enum', ...installedLocalPreviewInputInventory(root, compilerPath),
        semanticOptions: {nativeScenarioReceipts: 'true'},
        helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md')});
      const compiled = await compileCapturedSingleFile(capture);
      assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
      if (compiled.kind !== 'artifact') throw new Error('Original parent enum invariant source did not compile');
      const artifact = compiled.artifact;
      assert.equal(verifyCompilerSources(capture, {complete: true, sources: artifact.sources}).ok, true);
      const policy = artifact.modelPolicies?.find(policy => policy.model === ROLE);
      const rule = policy?.rules.find(rule => rule.kind === 'invariant');
      assert.ok(rule?.kind === 'invariant');
      assert.deepEqual(rule.dependencies.map(dependency => dependency.model), [CUSTOMER]);
      assert.ok(rule.dependencies.every(dependency => dependency.maxTargets > 0));
      const asm = await assembleModules({artifact, sourcePath}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js')});
      await loadCanonicalDescriptors(asm, artifact);
      worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch() {return new Response("ok");}}',
        d1Databases: {IDENTITY: 'parent-enum-identity', OWNER: 'parent-enum-owner'}, d1Persist: join(directory, 'd1')});
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb = await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(ownerDb);
      const now = Date.now(), clock = {nowMs: () => now};
      const identities = createD1IdentityStore(identityDb, {clock});
      const team = await identities.createTeam({timezone: 'UTC'});
      const user = await identities.createUser({email: 'parent-enum@example.test', password_hash: 'unused', email_verified: true});
      await identities.createMembership({team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: []});
      const token = `parent-enum-${user.user_id}`;
      await identities.createSession({user_id: user.user_id, token_sha256: await sha256HexText(token), last_team_id: team.team_id,
        expires_at: new Date(now + 3600_000).toISOString()});
      const identity = await resolveIdentity(identities, {session_token: token}, {clock});
      const underlying = createD1Storage(ownerDb), batches: CommitBatch[] = [];
      const store = {...underlying, async commit(batch: CommitBatch) {
        const committed = await underlying.commit(batch); batches.push(batch); return committed;
      }};
      let sequence = 0;
      const id = () => asId(uuidv7(now, ++sequence));
      const companyId = id(), personId = id(), unrelatedId = id(), roleId = id();
      // This is the exact default example setup entry, not direct raw D1 seeding.
      await materializeCanonicalExampleSnapshots({asm, artifact, store, identity, now, operationId: uuidv7(now, ++sequence), snapshots: [
        {model: CUSTOMER, id: companyId, data: {kind: 'company', name: 'company'}},
        {model: CUSTOMER, id: personId, data: {kind: 'person', name: 'person'}},
        {model: CUSTOMER, id: unrelatedId, data: {kind: 'company', name: 'unrelated'}},
        {model: ROLE, id: roleId, parent: {model: CUSTOMER, id: companyId}, data: {name: 'fixture role'}},
      ]});
      const company = (await store.load(CUSTOMER, companyId))!, person = (await store.load(CUSTOMER, personId))!;
      const role = (await store.load(ROLE, roleId))!;
      assert.equal(role.parent?.id, company.id);
      const setupRevision = await store.readRevision(), rejectedId = id();
      await assert.rejects(materializeCanonicalExampleSnapshots({asm, artifact, store, identity, now,
        operationId: uuidv7(now, ++sequence), snapshots: [
          {model: ROLE, id: rejectedId, parent: {model: CUSTOMER, id: person.id}, data: {name: 'invalid fixture role'}},
        ]}), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === 'rule_failed');
      assert.equal(await store.readRevision(), setupRevision); assert.equal(await store.load(ROLE, rejectedId), null);
      const invoker = buildInvoker(artifact, asm, store, {appId: APP, memberships: identities, source: 'http', now: clock.nowMs});
      const invoke = (operation: string, inputs: MutationEnvelope['inputs']) => invoker.invokeMutation({operation,
        operation_id: uuidv7(now, ++sequence), inputs}, identity);
      const created = await invoke(`${ROLE}.create`, {parent: ref(company), name: 'native role'});
      assert.ok('result' in created, JSON.stringify(created)); assert.equal(created.result.status, 'committed');
      const roles = await store.query({model: ROLE, authority: 'owner'});
      const rejected = await invoke(`${ROLE}.create`, {parent: ref(person), name: 'invalid native role'});
      assert.ok('error' in rejected, JSON.stringify(rejected)); assert.equal(rejected.error.code, 'rule_failed');
      assert.deepEqual(await store.query({model: ROLE, authority: 'owner'}), roles);
      const before = batches.length;
      const changed = await invoke(`${CUSTOMER}.update`, {record: ref(company), kind: 'person'});
      assert.ok('error' in changed, JSON.stringify(changed)); assert.equal(changed.error.code, 'rule_failed');
      assert.equal(batches.length, before + 1); assert.deepEqual(batches.at(-1)!.writes, []); assert.deepEqual(batches.at(-1)!.history, []);
      assert.deepEqual(await store.load(CUSTOMER, company.id), company);
      assert.deepEqual(await store.load(ROLE, role.id), role);
      assert.deepEqual(await store.query({model: ROLE, authority: 'owner'}), roles);
      const unrelated = (await store.load(CUSTOMER, unrelatedId))!;
      const allowed = await invoke(`${CUSTOMER}.update`, {record: ref(unrelated), kind: 'person'});
      assert.ok('result' in allowed, JSON.stringify(allowed)); assert.equal(allowed.result.status, 'committed');
      assert.equal((await store.load(CUSTOMER, unrelated.id))!.data.kind, 'person');
      assert.equal((await store.load(CUSTOMER, unrelated.id))!.version, unrelated.version + 1);
      assert.deepEqual(await store.load(ROLE, role.id), role);
      assert.equal(await captureIsCurrent(capture), true);
      assert.equal(await readFile(sourcePath, 'utf8'), SOURCE);
    } finally { await worker?.dispose(); await rm(directory, {recursive: true, force: true}); }
  });
