/** Native source -> installed canonical invoker; memory State, not browser/D1 coverage. */
import { createCheckoutScratch } from '../dev/checkout-scratch.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import type { ModelName, OperationId, RecordId, ResolvedIdentity } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { distribution } from '@canlang/values/distribution';
import { compileCapturedSingleFile } from '../dev/compiler-check.js';
import { prepareLocalPreviewCapture } from '../dev/preview-inputs.js';
import { captureIsCurrent, captureSingleFileSource } from '../dev/source-capture.js';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules } from './modules.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const APP = 'CandidateAdmission';
const source = `app CandidateAdmission
Given
 Parent {name:text,archived:bool=false}
 Note in Parent {body:text=" ready " trim,author:user server=actor,archived:bool=false}
 Scan {name:text trim}
 policy Parent read=members
 policy Note read=members
 policy Scan read=members
When
 crud Parent by=members fields=name when=not row.archived delete=remove
 crud Note by=members fields=body when=row.author==actor and row.body=="ready" and not row.parent.archived and not row.archived delete=remove
 crud Scan by=members fields=name when=count(Scan as stored where stored.name==row.name)==0 and (row.name=="Alpha" or count(Scan as stored where stored.name=="Alpha")==1) delete=remove
 scenario archive_parent(parent:Parent) by=members
  require not parent.archived
  do set parent {archived=true}
Then
`;

test('native CRUD admits normalized candidates before writes and leaves source scenario guards independent', { timeout: 120_000 }, async () => {
  const scratch = await createCheckoutScratch(root, 'crud-candidate-');
  const path = join(scratch, 'CandidateAdmission.can');
  try {
    await writeFile(path, source);
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
      appPath: path, compilerPath: process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact', JSON.stringify(compiled.kind === 'diagnostics' ? compiled.envelope.diagnostics : compiled.kind));
    if (compiled.kind !== 'artifact') throw new Error('Native candidate-admission fixture did not compile');
    const artifact = compiled.artifact;
    const asm = await assembleModules({ artifact, sourcePath: path }, { workDir: join(scratch, 'assembly'),
      stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const member = async (email: string) => {
      const user = await identities.createUser({ email, password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
      const token = randomBytes(32).toString('hex');
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(now + 3_600_000).toISOString(), last_team_id: team.team_id });
      return { user, identity: await resolveIdentity(identities, { session_token: token }, { clock }) };
    };
    const alice = await member('alice@candidate.test'), bob = await member('bob@candidate.test');
    const { store, probe } = createTestMemoryStorage();
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
    const model = (name: string) => `${APP}.${name}` as ModelName;
    const nextId = (): OperationId => {
      const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
      return `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}` as OperationId;
    };
    const invoke = (operation: string, inputs: Record<string, unknown>, identity: ResolvedIdentity = alice.identity) => {
      const id = nextId();
      return { id, outcome: invoker.invokeMutation({ operation: `${APP}.${operation}`, operation_id: id, inputs }, identity) };
    };
    const commit = async (operation: string, inputs: Record<string, unknown>) => {
      const call = invoke(operation, inputs), outcome = await call.outcome;
      assert.ok('result' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.result.status, 'committed');
      return call.id as unknown as RecordId;
    };
    const reference = async (name: string, id: RecordId) => {
      const row = await store.load(model(name), id);
      assert.ok(row);
      return { id, version: String(row.version) };
    };
    const snapshot = async () => Promise.all(['Parent', 'Note', 'Scan'].map(async name => {
      const rows = await store.query({ model: model(name), authority: 'owner', archived: 'include' });
      return { rows, history: rows.map(row => probe.historyFor(model(name), row.id)) };
    }));
    const deny = async (operation: string, inputs: Record<string, unknown>, identity = alice.identity) => {
      const before = await snapshot(), call = invoke(operation, inputs, identity), outcome = await call.outcome;
      assert.ok('error' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.error.code, 'rule_failed');
      assert.deepEqual(await snapshot(), before, 'refused candidate changes neither stored rows nor history');
      for (const name of ['Parent', 'Note', 'Scan'])
        assert.deepEqual(probe.historyFor(model(name), call.id as unknown as RecordId), []);
    };

    const parent = await commit('Parent.create', { name: 'Parent' });
    const note = await commit('Note.create', { parent: await reference('Parent', parent) });
    assert.deepEqual((await store.load(model('Note'), note))?.data,
      { body: 'ready', author: { id: alice.user.user_id }, archived: false }, 'guard receives normalized defaults and server actor');
    await commit('Note.update', { record: await reference('Note', note), body: '  ready  ' });
    await deny('Note.create', { parent: await reference('Parent', parent), body: 'blocked' });
    await deny('Note.update', { record: await reference('Note', note), body: 'blocked' });
    await deny('Note.update', { record: await reference('Note', note), body: 'ready' }, bob.identity);
    await commit('archive_parent', { parent: await reference('Parent', parent) });
    assert.equal((await store.load(model('Parent'), parent))?.data.archived, true,
      'ordinary source set does not acquire the generated CRUD candidate guard');
    await deny('Note.create', { parent: await reference('Parent', parent) });
    await deny('Note.delete', { record: await reference('Note', note) });

    const scan = await commit('Scan.create', { name: '  Alpha  ' });
    assert.equal((await store.load(model('Scan'), scan))?.data.name, 'Alpha');
    await commit('Scan.update', { record: await reference('Scan', scan), name: '  Beta  ' });
    assert.equal((await store.load(model('Scan'), scan))?.data.name, 'Beta',
      'owner scans exclude the new candidate and retain the old Alpha during update admission');
    await deny('Scan.create', { name: 'Beta' });
    await deny('Scan.update', { record: await reference('Scan', scan), name: 'Gamma' });
    await deny('Scan.delete', { record: await reference('Scan', scan) });
    assert.equal(await captureIsCurrent(capture), true, 'native producer inputs remain current');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
