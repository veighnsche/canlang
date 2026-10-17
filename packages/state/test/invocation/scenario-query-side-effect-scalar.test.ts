/** Pure-control scalar side-effect registration (first-query terminal create).
 *
 * The compiler admits a contained presence-required first query with one
 * top-level create immediately followed by a plain scalar-constant return.
 * Its plan return carries the four query influences (execution-gating
 * provenance via the terminal write) but reads no stored row and derives
 * from no intrinsic input. Registration must admit exactly that
 * pure-control profile while a data-bearing influenced return keeps the
 * projection-or-model-result refusal. Real compiler + real native catalog;
 * no hand-built plans.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadArtifactDescriptors, isGeneratedOperationDef, IncompatibleArtifactError } from '../../src/invocation/registry.js';

const SOURCE = 'app SideEffectSources\nGiven\n P {v:int=0}\n C in P {v:int=0}\n D {w:int=0}\n policy P read=members\n policy C read=members\n policy D read=members\nWhen\n crud P by=members fields=v\n crud C by=members fields=parent,v\n scenario go(p:P,n:int) -> int by=members\n  do\n   let c=first(p.C as c where c.v==n order=c.id)\n   require c!=null\n   create D {w=n} as d\n   return 1\nThen\n';

const OP = 'SideEffectSources.go';

function artifact() {
  // Layout-agnostic checkout root: works from source (vitest) and dist (node --test).
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, 'compiler')) || !existsSync(join(root, 'packages'))) {
    const parent = dirname(root);
    assert.notEqual(parent, root, 'checkout root with compiler/ + packages/ not found');
    root = parent;
  }
  const compilerBin = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
  const catalogPath = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');
  assert.ok(existsSync(compilerBin), `real built compiler required at ${compilerBin} (or CAN_COMPILER_BIN)`);
  assert.ok(existsSync(catalogPath), `real native catalog required at ${catalogPath} (or CAN_NATIVE_CATALOG)`);
  const directory = mkdtempSync(join(tmpdir(), 'can-side-effect-scalar-'));
  const canPath = join(directory, 'side-effect-scalar.can');
  writeFileSync(canPath, SOURCE);
  const output = execFileSync(compilerBin, ['compile', canPath, '--format=json',
    `--catalog=${catalogPath}`, '--native-scenario-receipts'],
  { cwd: directory, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.diagnostics ?? [], []);
  writeFileSync(join(directory, 'artifact.json'), output);
  return parsed;
}

function loadable(parsed: any) {
  return {
    artifact_version: parsed.artifact_version, sources: parsed.sources, modules: parsed.modules,
    callables: parsed.callables, models: parsed.models, operations: parsed.operations,
  };
}

test('pure-control influenced scalar return registers without projection or model result', () => {
  const parsed = artifact();
  const operation = parsed.operations.find((entry: any) => entry.name === OP);
  assert.ok(operation && operation.kind === 'scenario');
  const [returned] = operation.result.disclosure.returns;
  assert.ok(returned);
  assert.deepEqual(returned.dependencies, []);
  const [intrinsic] = returned.intrinsics ?? [];
  assert.ok(intrinsic, 'flow-consumed input is retained, not dropped');
  assert.equal(intrinsic.kind, 'admitted-input');
  assert.equal(intrinsic.parameter, 'n');
  assert.ok(returned.influences.length !== 0, 'gating provenance is retained, not dropped');
  assert.equal(returned.projection ?? null, null);
  const loaded = loadArtifactDescriptors(loadable(parsed) as any, { by: 'members' });
  const def = loaded.registry.get(OP);
  assert.ok(def && isGeneratedOperationDef(def), 'side-effect plan binds');
});

test('data-bearing influenced scalar return keeps the projection-or-model refusal', () => {
  const parsed = artifact();
  const operations = parsed.operations.map((entry: any) => {
    if (entry.name !== OP) return entry;
    const returned = entry.result.disclosure.returns[0];
    // A stored read masquerading on a query-influenced scalar return: the
    // value could now vary with stored-row data, so projection-or-model
    // applies. The dependency carries the exact return-dependency key set
    // against the real model inventory, so only 954 refuses.
    const tainted = {
      ...entry,
      result: {
        ...entry.result,
        disclosure: {
          ...entry.result.disclosure,
          returns: [{ ...returned, dependencies: [{
            id: 'tainted-read', source: entry.result.disclosure.source,
            role: 'data', model: 'SideEffectSources.C', field: 'v', type: 'int',
          }] }],
        },
      },
    };
    return tainted;
  });
  assert.throws(
    () => loadArtifactDescriptors(loadable({ ...parsed, operations }) as any, { by: 'members' }),
    (error: unknown) => error instanceof IncompatibleArtifactError &&
      /without projection require/.test(error.message),
    'stored-read influenced scalar still refuses without projection or model result',
  );
});
