/** Execute the original selected CRM promotion examples with their owning policies and saved Given. */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import type { CompileArtifact } from '@canlang/contracts';
import { prepareCrmPromotionSource } from './crm-promotion-source.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;

test('original CRM promotion examples execute with complete owning policies and saved seat defaults', async () => {
  const directory = await createCheckoutScratch(root, 'native-crm-promotion-');
  try {
    const fixture = await prepareCrmPromotionSource(directory);
    const { installedLocalPreviewInputInventory } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
    const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
    const { discoverGeneratedClosure } = await nodeImport(installed('dev/generated-capture.js')) as typeof import('../src/dev/generated-capture.js');
    const { runCompiledExamples, loadInstalledExampleTestkit } = await nodeImport(installed('dev/example-runner.js')) as typeof import('../src/dev/example-runner.js');
    const compilerPath = join(root, 'compiler/target/debug/can');
    const catalogPath = join(root, 'packages/cloudflare/dist/native-catalog.json');
    const inventory = installedLocalPreviewInputInventory(root, compilerPath);
    const generated = await discoverGeneratedClosure(compilerPath, root, fixture.sourcePath);
    const capture = await captureSingleFileSource({ checkoutRoot: root, appPath: fixture.sourcePath, compilerPath, catalogPath,
      profile: 'native-crm-promotion', helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
      ...inventory,
      // Explicitly capture the unchanged original owners and original saved unit
      // as well as the prepared source and compiler-discovered generated closure.
      extraInputPaths: [...inventory.extraInputPaths, ...fixture.originalInputPaths.map(path => ({
        name: `crm-original:${relative(root, path)}`, path,
      })), ...generated.files.map(file => ({ name: `crm-saved:${file.path}`, path: resolve(root, file.path) }))], semanticOptions: { nativeScenarioReceipts: 'true' } });
    assert.equal(await captureIsCurrent(capture), true);
    const compiled = await promisify(execFile)(compilerPath, ['compile', '--format=json', '--native-scenario-receipts',
      `--catalog=${catalogPath}`, capture.compilerOperand], { cwd: root, maxBuffer: 32 * 1024 * 1024 }).catch((error: unknown) => {
        const failure = error as { stdout?: string; stderr?: string };
        throw new Error(`Original CRM compilation failed:\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, { cause: error });
      });
    const artifact: CompileArtifact = JSON.parse(compiled.stdout);
    assert.equal(await captureIsCurrent(capture), true);
    // This explicit closure also captures the original source owners. Verify the
    // primary source with the single-file verifier, then the entire consumed set
    // against the compiler-discovered saved inputs; no extra source is ignored.
    assert.deepEqual(verifyCompilerSources(capture, { complete: true,
      sources: artifact.sources.filter(source => source.path === capture.compilerOperand) }), { ok: true });
    const expectedSources = new Map([[capture.compilerOperand, capture.sourceSha256]]);
    for (const path of generated.compilerSources) {
      if (path === capture.compilerOperand) continue;
      const physical = relative(root, resolve(generated.root, path));
      const saved = capture.inputs.find(input => input.name === `extra:crm-saved:${physical}`);
      assert.ok(saved?.sha256, `uncaptured saved source ${path}`);
      expectedSources.set(path, saved.sha256);
    }
    const byPath = (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path);
    assert.deepEqual(artifact.sources.map(({ path, sha256 }) => ({ path, sha256 })).sort(byPath),
      [...expectedSources].map(([path, sha256]) => ({ path, sha256 })).sort(byPath));
    assert.deepEqual(artifact.tests.map(suite => suite.scope).sort(),
      ['crm.promote_research', 'crm.prospect', 'crm.research_intake', 'rent_catalog.test_site', 'employee.test_worker', 'customer.test_company', 'customer.test_contact'].sort());
    const operation = artifact.operations?.find(operation => operation.name === 'crm.promote_research');
    assert.ok(operation?.result?.disclosure);
    assert.equal(operation.result.disclosure.queries?.length, 3);
    const result = await runCompiledExamples({ artifactBytes: Buffer.from(compiled.stdout), artifactLabel: fixture.sourcePath,
      sourceRevision: capture.sourceRevision, workerName: `crm-promotion-${randomUUID()}`,
      worker: { mainModule: 'main.mjs', modules: { 'main.mjs': 'export default {fetch(){return new Response(null,{status:404})}};' } },
      compatibilityDate: '2026-07-15', d1Binding: 'DB', testkit: await loadInstalledExampleTestkit(root) });
    assert.equal(result.executed, 6, JSON.stringify(result.report));
    assert.equal(result.ok, true, JSON.stringify(result.report));
    assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(await discoverGeneratedClosure(compilerPath, root, fixture.sourcePath), generated);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 180000);
