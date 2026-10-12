/** Owning selector consumer control, not native source qualification. Exact
 * declaration-labelled module bytes use the installed default loader and real
 * protected assembler; no hand-issued assembly or source-policy grants.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import type { CompileArtifact, ModelName } from '@canlang/contracts';

const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
const installed = (path: string) => new URL(`../../dist/${path}`, import.meta.url).href;
const APP = 'SelectorParent', ROOT = `${APP}.Conversation`, CHILD = `${APP}.Run`, OTHER = `${APP}.Other`;
const source = '## Declaration-labelled selector consumer control; not compiler source production.\n';
const digest = createHash('sha256').update(source).digest('hex');
type Mode = 'child' | 'root' | 'unknown' | 'mismatch' | 'dotted' | 'metadata';
function fixture(mode: Mode): CompileArtifact {
  const selector = mode === 'dotted' ? 'parent.id' : mode === 'metadata' ? 'created' : 'parent';
  const parent = mode === 'root' ? undefined : ROOT;
  const emittedParent = mode === 'unknown' ? `${APP}.Missing` : mode === 'mismatch' ? OTHER : parent;
  const models = [ROOT, OTHER, CHILD].map((name): NonNullable<CompileArtifact['models']>[number] => ({name, deleteMode: 'archive' as const,
    ...(name === CHILD && parent !== undefined ? {parent} : {}),
    fields: [{name: name === CHILD ? 'unfinished' : 'title', field: name === CHILD ? {kind: 'boolean' as const} : {kind: 'string' as const},
      valueType: name === CHILD ? 'bool' : 'text', required: true, serverOnly: false}]}));
  const policies = Object.fromEntries(models.map(model => [model.name, {read: [`${model.name}.read.1`]}]));
  const declarations = Object.fromEntries(models.map(model => [model.name, {
    ...(model.name === CHILD && emittedParent !== undefined ? {parent: emittedParent} : {}),
    fields: {[model.fields[0]!.name]: {type: model.fields[0]!.valueType}},
    readGrants: [{rule: `${model.name}.read.1`, by: ['members'], fields: model.name === CHILD ? [selector, 'unfinished'] : ['title']}],
  }]));
  const js = `const policy={models:${JSON.stringify(policies)}};
export const appDefinition={id:${JSON.stringify(APP)},policy,models:${JSON.stringify(declarations)},operations:{}};
export function canApp(){return {policy,read:{${models.map(model => `${JSON.stringify(`${model.name}.read.1`)}:()=>true`).join(',')}}};}`;
  return {artifact_version: 1, language_version: 'declaration-labelled', tool_version: 'selector-consumer-control',
    sources: [{path: 'selector-parent-control.can', sha256: digest}],
    modules: [{path: 'selector-parent.mjs', js, map: {version: 3, file: 'selector-parent.mjs', sources: ['selector-parent-control.can'], sourcesContent: [source], names: [], mappings: ''}}],
    models, operations: models.map(model => ({name: `${model.name}.read`, kind: 'read' as const, description: '', inputs: {fields: []}})),
    callables: [], pages: [], tests: [], requires: [{capability: 'canlang.builtins', min_version: 2}, {capability: 'state', min_version: 1}, {capability: 'state.parameters', min_version: 1}]};
}

test('only protected matching contained model provenance admits singular parent selector', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-read-selector-parent-'));
  try {
    const {assembleModules} = await nodeImport(installed('runtime/modules.js')) as typeof import('./modules.js');
    const {loadCanonicalDescriptors, mapReadRulesToPolicy} = await nodeImport(installed('runtime/invoke.js')) as typeof import('./invoke.js');
    const sourcePath = join(directory, 'selector-parent-control.can'); await writeFile(sourcePath, source);
    const assemble = (artifact: CompileArtifact, mode: string) => assembleModules({artifact, sourcePath},
      {workDir: join(directory, mode), stdlibUrl: installed('runtime/stdlib.js'), uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href});
    const artifact = fixture('child'), asm = await assemble(artifact, 'child');
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    const containment = loaded.containment as ReadonlyMap<string, {parent?: string}>;
    assert.equal(containment.get(CHILD)?.parent, ROOT);
    const policies = loaded.policy as ReadonlyMap<ModelName, {grants: readonly {fields: readonly string[]}[]}>;
    assert.deepEqual(policies.get(CHILD as ModelName)!.grants[0]!.fields, ['parent', 'unfinished']);
    for (const mode of ['root', 'unknown', 'mismatch', 'dotted', 'metadata'] as const) {
      const rejected = fixture(mode), owned = await assemble(rejected, mode);
      await assert.rejects(loadCanonicalDescriptors(owned, rejected), /malformed or undeclared read selector/, mode);
    }
    // Public provenance alone cannot establish checked containment authority.
    assert.throws(() => mapReadRulesToPolicy(CHILD, {read: [`${CHILD}.read.1`]}, ['unfinished'], {
      secretFields: [], declaration: {parent: ROOT, fields: {unfinished: {type: 'bool'}},
        readGrants: [{rule: `${CHILD}.read.1`, by: ['members'], fields: ['parent']}]}, readRules: {[`${CHILD}.read.1`]: () => true},
    }), /malformed or undeclared read selector/);
    const drift = fixture('child'), owned = await assemble(drift, 'drift');
    const modulePath = fileURLToPath(owned.moduleUrls['selector-parent.mjs']!);
    await writeFile(modulePath, (await readFile(modulePath, 'utf8')) + '\n// closure drift\n');
    await assert.rejects(loadCanonicalDescriptors(owned, drift), /assembly|module|artifact|correspondence|changed/i);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
