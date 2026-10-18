import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CompileArtifact } from '@canlang/contracts';
import { loadInstalledExampleTestkit, runCompiledExamples } from './example-bindings.test-support.js';

test('default row identity matches only its provisioned static role array', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'can-role-identity-'));
  let artifact: CompileArtifact;
  try {
    const source = join(directory, 'RoleIdentity.can');
    writeFileSync(source, 'app RoleIdentity\nGiven\nWhen\n scenario check() by=members\n  do require true\nThen\n');
    artifact = JSON.parse(execFileSync(join(process.cwd(), 'compiler/target/debug/can'),
      ['compile', '--format=json', `--catalog=${join(process.cwd(), 'packages/cloudflare/dist/native-catalog.json')}`, source],
      { encoding: 'utf8' })) as CompileArtifact;
  } finally { rmSync(directory, { recursive: true, force: true }); }
  artifact.tests = [{ scope: 'RoleIdentity.check', fixtures: [], module: {
    path: 'tests/role-identity.mjs',
    map: { version: 3, file: 'role-identity.mjs', sources: [], sourcesContent: [], names: [], mappings: '' },
    js: `export function exampleFixtures(){return {fixtures:{},examples:[{operation:'RoleIdentity.check',
      dependencies:[],inputs:async()=>({}),selectors:['as'],selectorChannels:['caller'],observations:[],
      rows:[{dependencies:[],values:async()=>[['RoleIdentity.reader','RoleIdentity.writer']],expected:async()=>[]},
            {dependencies:[],values:async()=>[[]],expected:async()=>[]}]}]};}`,
  } }];
  let calls = 0;
  const result = await runCompiledExamples({
    artifactBytes: Buffer.from(JSON.stringify(artifact)), artifactLabel: 'RoleIdentity.artifact.json',
    sourceRevision: 'role-identity-component', workerName: `role-identity-${randomUUID()}`,
    worker: { mainModule: 'main.mjs', modules: { 'main.mjs': 'export default {fetch(){return new Response(null)}}' } },
    compatibilityDate: '2026-07-15', d1Binding: 'DB', testkit: await loadInstalledExampleTestkit(process.cwd()),
    hooks: {
      materializeFixtures: async () => ({ materialized: [], values: new Map() }),
      observeLive: async () => ({}),
      invoke: async ({ call, identity, rowCaller }) => {
        calls++;
        assert.ok(identity.actor);
        const again = await call.scope.identityFor(call.by, rowCaller, new Map());
        assert.deepEqual(again.actor, identity.actor);
        assert.deepEqual(again.binding, identity.binding);
        assert.deepEqual(again.membership, identity.membership);
        const invalid: unknown[] = [['RoleIdentity.foreign'], ['RoleIdentity.writer','RoleIdentity.reader'],
          ['self'], [['RoleIdentity.reader']], [''], [42], new Array(1)];
        let getterCalls = 0;
        invalid.push(Object.defineProperty([], '0', { enumerable: true, get() { getterCalls++; return 'RoleIdentity.reader'; } }));
        for (const by of invalid) await assert.rejects(call.scope.identityFor(by, rowCaller, new Map()), /no provisioned actor/);
        assert.equal(getterCalls, 0);
        await assert.rejects(call.scope.identityFor(call.by, { ...rowCaller, account: 'foreign' }, new Map()), /no provisioned actor/);
        if ((call.by as unknown[]).length === 0) {
          assert.deepEqual(rowCaller.roles, ['members']);
          await assert.rejects(call.scope.identityFor([], { ...rowCaller, roles: [] }, new Map()), /no provisioned actor/);
        }
        return { ok: true };
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.equal(result.executed, 2);
  assert.equal(calls, 2);
});
