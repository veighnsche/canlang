import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverGeneratedClosure, snapshotGeneratedClosure } from '../src/runtime/native-dev.test-support.js';
import { captureInputs, captureIsCurrent, captureSingleFileSource, verifyCompilerSources } from '../src/runtime/native-dev.test-support.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true, force:true}))); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

it('captures only compiler-admitted saved files, admits exact contribution sources and invalidates saved edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'can-dev-generated-')); roots.push(root);
  const appRoot = join(root, 'apps/Test');
  const source = 'app Test\nGiven\n trait named $"Add done:bool=false"\n Task {title:text} named\nWhen\nThen\n';
  const saved = {'can.generated/u1/unit.json':'{}', 'can.generated/u1/contributions.can':'app Test\nGiven\n named {done:bool=false}\n',
    'can.generated/u1/implementation.js':'export const irrelevant = true;'};
  await mkdir(join(appRoot,'can.generated/u1'), {recursive:true});
  await writeFile(join(appRoot,'app.can'), source);
  for (const [path, text] of Object.entries(saved)) await writeFile(join(appRoot,path), text);
  await writeFile(join(appRoot,'can.generated/u1/unused.can'), 'app Unused\n');
  const compiler = join(root,'can');
  const report = {ok:true, units:[{id:'u1', association:'retained', current_files:Object.entries(saved).map(([path,text])=>({path,sha256:hash(text)})), compiler_sources:['app.can','can.generated/u1/contributions.can']}]};
  await writeFile(compiler, `#!/usr/bin/env node\nif (process.env.CAN_GENERATION_COMPILER_ONLY !== "1") process.exit(2);\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(report))}));\n`, {mode:0o700});
  for (const path of ['catalog.json','help.json','package.js']) await writeFile(join(root,path),'{}');
  const base = await captureSingleFileSource({checkoutRoot:root,appPath:'apps/Test/app.can',profile:'local-d1-identity',compilerPath:compiler,catalogPath:join(root,'catalog.json'),helpIndexPath:join(root,'help.json'),packageInputPaths:[{name:'runtime',path:join(root,'package.js')}]});
  const closure = await discoverGeneratedClosure(compiler,base.root,base.appPath);
  const snapshot = await snapshotGeneratedClosure(base.root,base.appPath,closure);
  expect(snapshot.map(input=>input.path)).not.toContain('apps/Test/can.generated/u1/unused.can');
  const inputs = await captureInputs(root,closure.files.map(input=>({name:`generated:${input.path}`,path:input.path})));
  const capture = {...base, generatedClosure:closure,sourceSnapshot:snapshot,inputs:[...base.inputs,...inputs]};
  const sources = [{path:'apps/Test/app.can',sha256:hash(source)}, {path:'can.generated/u1/contributions.can',sha256:hash(saved['can.generated/u1/contributions.can'])}];
  expect(verifyCompilerSources(capture,{complete:true,sources})).toEqual({ok:true});
  expect(verifyCompilerSources(capture,{complete:true,sources:[...sources,{path:'can.generated/u1/unused.can',sha256:hash('app Unused\n')}]}).ok).toBe(false);
  expect(await captureIsCurrent(capture)).toBe(true);
  await writeFile(join(appRoot,'can.generated/u1/implementation.js'),'export const irrelevant = false;');
  expect(await captureIsCurrent(capture)).toBe(false);
  expect(new TextDecoder().decode(snapshot.find(input=>input.path.endsWith('implementation.js'))!.bytes)).toContain('true');
  expect(await readFile(join(appRoot,'can.generated/u1/unused.can'),'utf8')).toBe('app Unused\n');
});
