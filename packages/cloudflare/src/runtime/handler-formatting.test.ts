import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompileArtifact } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  FIXED_NOW, asOperationId, createMemoryIdentityStore, makeIdentity, seedMember, uuidv7,
} from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { createContext } from './context.js';

// The compiled scenario's integer result remains unchanged; its handwritten
// body observes the real bridge/context handoff, not compiler format lowering.
test('selected-app formatting facts reach admitted handlers without viewer or input defaults', async () => {
  const memberships = createMemoryIdentityStore();
  const team = await memberships.createTeam('Europe/Brussels');
  const member = await seedMember(memberships, { teamId: team.team_id, isOwner: false });
  const identity = makeIdentity({ membership: member.membership, team: member.team, email: member.user.email });
  const dir = await mkdtemp(join(tmpdir(), 'can-handler-formatting-'));
  try {
    for (const [index, mode] of ['authored', 'legacy', 'explicit-app-id'].entries()) {
      const artifact = JSON.parse(await readFile(resolve('packages/cloudflare/test/fixtures/typed-scenario-values.json'), 'utf8')) as CompileArtifact;
      const entry = artifact.modules[0]!;
      const expected = mode === 'authored' ? 'fr-CA' : mode === 'legacy' ? 'en' : null;
      entry.js = entry.js.replace('appDefaultLocale:"en",', mode === 'legacy' ? '' : 'appDefaultLocale:"fr-CA",');
      const original = 'return $can$l$363a76616c7565;';
      assert.ok(entry.js.includes(original));
      entry.js = entry.js.replace(original, `
        c.preferences.TypedScenarioValues = { locale: "de-DE", appDefault: "de-DE" };
        if (${JSON.stringify(expected)} === null) {
          if (Object.hasOwn(c, "formatting")) throw new Error("fabricated formatting scope");
        } else {
          if (c.formatting?.appDefault !== ${JSON.stringify(expected)}) throw new Error("wrong selected-app default");
          if (!Object.isFrozen(c.formatting)) throw new Error("mutable formatting scope");
          if (Object.keys(c.formatting).join() !== "appDefault") throw new Error("extra formatting facts");
        }
        if (c.team?.timezone !== "Europe/Brussels") throw new Error("lost admitted team zone");
        return $can$l$363a76616c7565;
      `);
      const asm = await assembleModules({ artifact, sourcePath: 'unrelated/de-DE.can' }, {
        workDir: join(dir, mode), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
        uiUrl: import.meta.resolve('@canlang/ui'),
      });
      const invoker = buildInvoker(artifact, asm, createTestMemoryStorage().store, {
        memberships, now: () => FIXED_NOW,
        ...(mode === 'explicit-app-id' ? { appId: 'TypedScenarioValues' } : {}),
      });
      const outcome = await invoker.invokeMutation({
        operation: 'TypedScenarioValues.echo', operation_id: asOperationId(uuidv7(FIXED_NOW, index + 1)),
        inputs: { value: '123' },
      }, identity);
      assert.ok('result' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.result.result, '123');
    }
    const supplied = { appDefault: 'fr-CA' };
    const context = createContext({ caller: { userId: 'host', roles: [] }, store: createTestMemoryStorage().store, formatting: supplied });
    supplied.appDefault = 'de-DE';
    assert.equal(context.formatting?.appDefault, 'fr-CA');
    assert.throws(() => Object.assign(context.formatting!, { appDefault: 'de-DE' }), TypeError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
