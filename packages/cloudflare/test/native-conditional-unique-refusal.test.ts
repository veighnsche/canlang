/** A real compiled conditional unique cannot activate as an ordinary CRUD model. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { CompileArtifact } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { loadCanonicalDescriptors } from '@canlang/cloudflare/runtime/invoke';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fixture = fileURLToPath(new URL('./fixtures/conditional-unique-refusal.can', import.meta.url));
const require = createRequire(import.meta.url);
const stdlibUrl = pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const uiUrl = pathToFileURL(require.resolve('@canlang/ui')).href;

test('original conditional unique without model policies refuses whole activation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-conditional-unique-refusal-'));
  try {
    const source = await readFile(fixture, 'utf8');
    const control = join(dir, 'unconditional-control.can');
    assert.equal(source.split('unique Item fields=code where=row.active').length, 2);
    await writeFile(control, source.replace('unique Item fields=code where=row.active', 'unique Item fields=code'));
    const compiler = join(root, 'compiler/target/debug/can');
    const catalog = fileURLToPath(distribution.catalog);
    const compile = async (path: string): Promise<CompileArtifact> => {
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, path],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      return JSON.parse(stdout) as CompileArtifact;
    };
    const conditional = await compile(fixture);
    assert.equal(conditional.modelPolicies, undefined);
    assert.equal(conditional.models?.[0]?.uniqueKeys, undefined,
      'the unjoined conditional key cannot masquerade as an unconditional artifact key');
    assert.match(conditional.modules[0]!.js, /uniques:\[\{fields:\["code"\],where:"Item\.unique\.1"\}\]/);
    const claimed = await assembleModules({ artifact: conditional, sourcePath: fixture },
      { workDir: join(dir, 'conditional-modules'), stdlibUrl, uiUrl });
    await assert.rejects(loadCanonicalDescriptors(claimed, conditional), /conditional unique.*cannot activate/i);

    const plain = await compile(control);
    assert.match(plain.modules[0]!.js, /uniques:\[\{fields:\["code"\]\}\]/,
      'the control retains its original unconditional declaration');
    const safe = await assembleModules({ artifact: plain, sourcePath: control },
      { workDir: join(dir, 'unconditional-modules'), stdlibUrl, uiUrl });
    const loaded = await loadCanonicalDescriptors(safe, plain);
    assert.equal(loaded.models[0]?.name, 'ConditionalRefusal.Item',
      'this refusal does not block an ordinary unique declaration');
    assert.deepEqual(loaded.models[0]?.uniqueKeys, ['code'],
      'the original singular declaration reaches the State model table');

    const fileSource = join(dir, 'unsupported-file-key.can');
    await writeFile(fileSource, source.replace('code:text', 'graph:file')
      .replace('unique Item fields=code where=row.active', 'unique Item fields=graph')
      .replace('fields=code,active', 'fields=graph,active'));
    const fileKey = await compile(fileSource);
    const fileAssembly = await assembleModules({artifact: fileKey, sourcePath: fileSource},
      {workDir: join(dir, 'file-key-modules'), stdlibUrl, uiUrl});
    await assert.rejects(loadCanonicalDescriptors(fileAssembly, fileKey), /unique field.*association/i,
      'a genuine File declaration cannot become a scalar State uniqueness claim');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
