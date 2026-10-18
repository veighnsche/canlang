/** Actual captured compiler output and committed native navigation consumer.
 * No canonical source query, File/history, portable host or provider claim. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';
import type { CompileArtifact, ModelName, RecordId, StoragePort } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { makeBatch, makeRow, asModel, asId } from '@canlang/state/testing/invocation/fixtures';
import { distribution } from '@canlang/values/distribution';
import { prepareLocalPreviewCapture } from './native-dev.test-support.js';
import { captureIsCurrent, captureSingleFileSource } from './native-dev.test-support.js';
import { compileCapturedSingleFile } from './native-dev.test-support.js';
import { buildInvoker } from '../worker/assembly.js';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { loadCanonicalDescriptors } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const fixture = join(root, 'packages/cloudflare/test/fixtures/native-conditional-navigation.can');
const app = 'NativeConditionalNavigation', parentModel = asModel(`${app}.Parent`);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

it('runs original committed conditional parent/root projections and refuses source, authority and checkpoint drift', { timeout: 120000 }, async () => {
  const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
    appPath: fixture, compilerPath: join(root, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
  const staging = await mkdtemp(join(tmpdir(), 'can-native-conditional-navigation-'));
  try {
    assert.equal(await captureIsCurrent(capture), true);
    assert.equal(digest(await readFile(fixture, 'utf8')), capture.sourceSha256);
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact', 'original conditional navigation source must compile');
    if (compiled.kind !== 'artifact') throw new Error('Conditional navigation compiler prerequisite unavailable.');
    const artifact: CompileArtifact = compiled.artifact;
    assert.deepEqual(artifact.sources, [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
    const originalModules = artifact.modules.map(module => ({ path: module.path, sha256: digest(module.js) }));
    const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: staging,
      stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
    for (const module of artifact.modules) await importVerifiedAssemblyModule(asm, module.path, artifact);
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    assert.ok(loaded.sourceReadPolicies.has(parentModel), 'ordinary-only original grants are discovered');
    assert.equal(loaded.callbackReadGrants.size, 0, 'ordinary projection uses no callback permission');
    assert.equal(loaded.sourceReadPolicies.get(parentModel)!.grants.length, 2);
    assert.deepEqual(loaded.sourceReadPolicies.get(parentModel)!.secretFields, ['token']);

    for (const mode of ['allowed', 'ancestor-denied', 'subject-revoked', 'secret', 'suppressed',
      'transform-subject', 'transform-caller', 'transform-state'] as const) {
      const now = Date.now(), clock = createFrozenClock(now), memberships = createMemoryIdentityStore({ clock });
      const team = await memberships.createTeam({ timezone: 'UTC' });
      const caller = await memberships.createUser({ email: 'caller@conditional-navigation.test', password_hash: 'unused', email_verified: true });
      const subject = await memberships.createUser({ email: 'subject@conditional-navigation.test', password_hash: 'unused', email_verified: true });
      const callerMembership = await memberships.createMembership({ team_id: team.team_id, user_id: caller.user_id, is_owner: false, roles: [] });
      const subjectMembership = await memberships.createMembership({ team_id: team.team_id, user_id: subject.user_id, is_owner: false, roles: [] });
      const token = `conditional-navigation-${mode}`;
      await memberships.createSession({ user_id: caller.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(now + 3600000).toISOString(), last_team_id: team.team_id });
      const identity = await resolveIdentity(memberships, { session_token: token }, { clock });
      const backing = createMemoryStorage();
      const rootRow = makeRow({ id: asId('root'), data: { label: 'Root visible', enabled: mode !== 'ancestor-denied' } });
      const parentRow = { ...makeRow({ id: asId('parent'), data: { label: 'Parent visible', kind: 'Two-grant union',
        enabled: true, author: { id: subject.user_id }, token: 'SECRET NEVER DISCLOSED' } }),
        parent: { model: asModel(`${app}.Root`), id: rootRow.id } };
      const childRow = { ...makeRow({ id: asId('child'), data: { label: 'Child' } }), parent: { model: parentModel, id: parentRow.id } };
      await backing.commit(makeBatch(await backing.readRevision(), { writes: [
        { kind: 'insert', model: asModel(`${app}.Root`), row: rootRow },
        { kind: 'insert', model: parentModel, row: parentRow },
        { kind: 'insert', model: asModel(`${app}.Child`), row: childRow },
      ] }));
      if (mode === 'subject-revoked') await memberships.removeMembership(subjectMembership.membership_id);
      const revision = await backing.readRevision();
      let commits = 0, parentLoads = 0, transformed = false;
      const store: StoragePort = { ...backing, commit: async batch => { commits++; return backing.commit(batch); },
        cohortLoad: async request => {
          const row = await backing.cohortLoad(request);
          if (request.model === parentModel && ++parentLoads === 2 && mode.startsWith('transform-')) {
            transformed = true;
            if (mode === 'transform-subject') await memberships.removeMembership(subjectMembership.membership_id);
            if (mode === 'transform-caller') await memberships.removeMembership(callerMembership.membership_id);
            if (mode === 'transform-state') await backing.commit(makeBatch(await backing.readRevision(), { writes: [
              { kind: 'insert', model: asModel(`${app}.Root`), row: makeRow({ id: asId('moved'), data: { label: 'Moved', enabled: true } }) },
            ] }));
          }
          return row;
        } };
      const invoker = buildInvoker(artifact, asm, store, { memberships, now: () => now });
      const invoke = (name: string) => invoker.invokeRead({ operation: `${app}.${name}`,
        inputs: { child: { id: childRow.id, version: String(childRow.version) } } }, identity);
      if (mode === 'allowed') {
        for (const [operation, result] of [['parentLabel', 'Parent visible'], ['parentKind', 'Two-grant union'], ['rootLabel', 'Root visible']] as const) {
          assert.deepEqual(await invoke(operation), { result: { result, revision } });
        }
      } else {
        const outcome = await invoke(mode === 'secret' ? 'withheldEnabled' : mode === 'suppressed' ? 'suppressed' : 'parentLabel');
        assert.ok('error' in outcome, `${mode} must withhold the original result`);
        assert.equal('result' in outcome, false);
        if (mode === 'secret') assert.equal(outcome.error.code, 'forbidden');
        if (mode === 'suppressed') assert.equal(outcome.error.code, 'rule_failed');
        if (mode.startsWith('transform-')) assert.equal(transformed, true, 'drift occurs inside the actual projector transform');
      }
      assert.equal(commits, 0, 'navigation and all refusals stage no business effects or read receipts');
      assert.equal(await backing.readRevision(), revision + (mode === 'transform-state' ? 1 : 0));
      for (const [model, row] of [[asModel(`${app}.Root`), rootRow], [parentModel, parentRow], [asModel(`${app}.Child`), childRow]] as const) {
        assert.deepEqual(await backing.load(model as ModelName, row.id as RecordId), row, 'original data and version remain unchanged');
        assert.deepEqual(await backing.historyFor(model, row.id), [], 'read has no history');
      }
    }
    assert.deepEqual(artifact.modules.map(module => ({ path: module.path, sha256: digest(module.js) })), originalModules);
    for (const module of artifact.modules) await importVerifiedAssemblyModule(asm, module.path, artifact);
    assert.equal(await captureIsCurrent(capture), true, 'original source and installed closure finish current');
  } finally { await rm(staging, { recursive: true, force: true }); }
});
