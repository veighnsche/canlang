import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { CompileArtifact } from '@canlang/contracts';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';

const fixturePath = resolve('packages/cloudflare/test/fixtures/model-rule-activation.json');
type Rule = 'invariants' | 'locks';
type Mask = 'none' | 'policy' | 'declaration' | 'policy-absent';

async function refuse(rule?: Rule, mask: Mask = 'none') {
  const artifact = JSON.parse(await readFile(fixturePath, 'utf8')) as CompileArtifact;
  if (rule !== undefined) {
    // Synthetic metadata variants isolate one unsupported feature. Descriptors
    // and executable rules remain the actual compiler output in every variant.
    const model = rule === 'invariants' ? 'ModelRuleActivation.InvariantOnly' : 'ModelRuleActivation.LockedOnly';
    const otherModel = rule === 'invariants' ? 'ModelRuleActivation.LockedOnly' : 'ModelRuleActivation.InvariantOnly';
    const otherRule = rule === 'invariants' ? 'locks' : 'invariants';
    artifact.modules[0]!.js += `
delete appDefinition.models[${JSON.stringify(otherModel)}][${JSON.stringify(otherRule)}];
delete appDefinition.policy.models[${JSON.stringify(otherModel)}][${JSON.stringify(otherRule)}];
${mask === 'policy' ? `delete appDefinition.policy.models[${JSON.stringify(model)}][${JSON.stringify(rule)}];` : ''}
${mask === 'declaration' ? `delete appDefinition.models[${JSON.stringify(model)}][${JSON.stringify(rule)}];` : ''}
const originalCanApp = canApp;
canApp = function() {
  const registry = originalCanApp();
  delete registry.policy.models[${JSON.stringify(otherModel)}][${JSON.stringify(otherRule)}];
  ${mask === 'policy' ? `delete registry.policy.models[${JSON.stringify(model)}][${JSON.stringify(rule)}];` : ''}
  ${mask === 'policy-absent' ? 'delete registry.policy;' : ''}
  return registry;
};
`;
  }
  const dir = await mkdtemp(join(tmpdir(), 'can-model-rule-activation-'));
  try {
    const asm = await assembleModules({ artifact, sourcePath: fixturePath }, {
      workDir: dir, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
      uiUrl: import.meta.resolve('@canlang/ui'),
    });
    await assert.rejects(loadCanonicalDescriptors(asm, artifact), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unsupported|not supported/i);
      assert.match(error.message, rule === undefined ? /invariant|lock/i : rule === 'locks' ? /lock/i : /invariant/i);
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('actual compiled model invariants and locks refuse canonical activation', async () => {
  await refuse();
});

for (const rule of ['invariants', 'locks'] as const) {
  test(`synthetic isolation: emitted ${rule} refuse independently`, async () => {
    await refuse(rule);
  });
  test(`synthetic policy masking: owning ${rule} declarations still refuse`, async () => {
    await refuse(rule, 'policy');
  });
  test(`synthetic declaration masking: emitted ${rule} policy arrays still refuse`, async () => {
    await refuse(rule, 'declaration');
  });
  test(`synthetic missing policy: owning ${rule} declarations still refuse`, async () => {
    await refuse(rule, 'policy-absent');
  });
}
