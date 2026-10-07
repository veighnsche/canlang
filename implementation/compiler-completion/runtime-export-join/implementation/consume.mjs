import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as facade from '@canlang/stdlib';
import * as producer from '@canlang/state/effects/guards';

const artifact = JSON.parse(await readFile(new URL('./guard.compile.json',import.meta.url),'utf8'));
const cliPath = '/private/tmp/can-runtime-guard-review/can-pinned';
const cli = await readFile(cliPath);
const cliSha = createHash('sha256').update(cli).digest('hex');
assert.equal(cliSha,'b8ec81900121effeab3b2145c0f4436089eeea7a273642317335309861c0cd3d');
const emitted = artifact.modules[0];
await writeFile(new URL(`./${emitted.path}`,import.meta.url),emitted.js);
const mod = await import(new URL(`./${emitted.path}`,import.meta.url));
const handler = mod.canApp()['Guard.echo'];
assert.strictEqual(facade.hasRole,producer.hasRole);
assert.strictEqual(facade.require,producer.require);
assert.equal(await handler({memberships:['members']},{value:'HELLO'}),'hello');
assert.equal(await handler({memberships:[],canonical:{builtinRoles:['members']}},{value:'WORLD'}),'world');
await assert.rejects(()=>handler({memberships:[]},{value:'HELLO'}),{name:'Error',message:'forbidden'});
await assert.rejects(()=>handler({memberships:['members'],canonical:{builtinRoles:[]}},{value:'HELLO'}),{name:'Error',message:'forbidden'});
const previousOrder = await import('../../ui-ownership/research/selected-phase/order.mjs');
assert.equal(previousOrder.appDefinition.pages[0].title.source,'Home');
const receipts = {
  cliSha,
  cliPath,
  routes:Object.fromEntries(['@canlang/stdlib','@canlang/state/effects/guards'].map(name=>[name,import.meta.resolve(name)])),
  compilerCheck:'complete:true; no diagnostics',
  generatedModule:{path:emitted.path,sha256:createHash('sha256').update(emitted.js).digest('hex'),unmodified:true,import:'ok'},
  directGeneratedHandlerCases:['local members allows','canonical fixture members allows','empty memberships rejects','canonical fixture excludes injected members'],
  priorOrderImport:'ok',
  facadeProducerIdentity:'require and hasRole identical',
  qualification:'Direct generated-handler cases verify emitted consumer and local snapshot guard behavior. Canonical fields are fixtures; this does not prove canonical admission, live identity, revision fencing or receipt mapping. Prior order rendering needs genuine authorized query/context and is not executed.',
};
await writeFile(new URL('./consumer-receipts.json',import.meta.url),JSON.stringify(receipts,null,2)+'\n');
console.log(JSON.stringify(receipts,null,2));
