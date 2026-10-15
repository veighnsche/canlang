// Compiler callback ABI only. Canonical host/schema authority is qualified by
// the owning CF native tests; these explicit factory controls assert lowering.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const [root, artifactPath, scratch] = process.argv.slice(2);
const load = path => import(pathToFileURL(resolve(root,path)));
const {loadArtifactFile} = await load('packages/cloudflare/dist/runtime/artifact.js');
const {assembleModules} = await load('packages/cloudflare/dist/runtime/modules.js');
const {decodeValue} = await load('packages/values/dist/src/index.js');
const fixture = { mode:'native', trace:[], history:0, values:[] };
globalThis.sourceRowFixture = fixture;
const wire = Object.freeze({id:'item-one',version:'2',fields:Object.freeze({
 label:'Visible',owner:{id:'actor-one'},at:'2026-10-15T10:00:00.000Z',score:'41',
})});
fixture.wire=wire;
const native = {id:wire.id,version:2n};
for (const [name,type] of [['label','text'],['owner','user?'],['at','datetime?'],['score','int']]) {
 Object.defineProperty(native,name,{enumerable:true,get(){fixture.trace.push(name);return decodeValue(type,wire.fields[name]);}});
}
Object.defineProperty(native,'unused',{enumerable:true,get(){throw new Error('unused source getter evaluated');}});
fixture.native=Object.freeze(native);
const uiPath=resolve(scratch,'ui.mjs');
writeFileSync(uiPath, `export * from ${JSON.stringify(pathToFileURL(resolve(root,'packages/ui/dist/src/index.js')).href)};
export async function list(props){const f=globalThis.sourceRowFixture;await props.renderRow(f.wire,props.context,...(f.mode==='native'?[f.native]:[]));return '';}
export function text(props){globalThis.sourceRowFixture.values.push(props.values);return '';}
export function history(props){const f=globalThis.sourceRowFixture;if(props.record!==f.wire)throw new Error('history lost original RowView');JSON.stringify(props.record);f.history++;return '';}
`);
const loaded=loadArtifactFile(artifactPath);
const asm=await assembleModules(loaded,{workDir:resolve(scratch,'modules'),
 stdlibUrl:pathToFileURL(resolve(root,'packages/cloudflare/dist/runtime/stdlib.js')).href,
 uiUrl:pathToFileURL(uiPath).href});
const reference=loaded.artifact.pages[0], module=await import(asm.moduleUrls[reference.module]);
const page=module[reference.export];
const context={path:'/',preferredLocales:[],appDefaultLocale:'en',memberships:[],canonical:{builtinRoles:[]}};
await page.render(context,{});
assert.deepEqual(fixture.trace,['label','owner','at','score']);
assert.equal(fixture.history,1);
assert.deepEqual(fixture.values[0],['Visible',decodeValue('user',wire.fields.owner),decodeValue('datetime',wire.fields.at),41n]);
assert.equal(JSON.stringify(wire).includes('2026-10-15T10:00:00.000Z'),true);
fixture.mode='generic';fixture.trace.length=0;
await page.render(context,{});
assert.deepEqual(fixture.trace,[],'unchanged two-argument generic factory does not use private native source');
assert.equal(fixture.history,2);
assert.deepEqual(fixture.values[1],['Visible',wire.fields.owner,wire.fields.at,wire.fields.score]);
delete globalThis.sourceRowFixture;
