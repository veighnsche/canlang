import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,rmSync,readdirSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {assembleModules} from '@canlang/cloudflare/runtime/modules';
import {buildDeployBundle,writeDeployBundle,assertLinksResolve,assertWorkerdLoadable} from '@canlang/cloudflare/deploy/bundle';
import {startLocalDev} from '@canlang/cloudflare/dev/local-run';
import {invokeCallable} from '@canlang/cloudflare/runtime/invoke';
import {encode} from '@jridgewell/sourcemap-codec';
const root=dirname(fileURLToPath(import.meta.url));
for(const spec of ['@canlang/cloudflare/runtime/modules','@canlang/cloudflare/runtime/invoke','@canlang/cloudflare/deploy/bundle','@canlang/cloudflare/dev/local-run']){
 const resolved=fileURLToPath(import.meta.resolve(spec));assert.ok(realpathSync(resolved).startsWith(root+'/node_modules/'));assert.ok(!resolved.includes('/Users/vince/Projects/'));
}
function walk(p){for(const e of readdirSync(p,{withFileTypes:true})){const t=join(p,e.name);assert.ok(!e.isSymbolicLink(),t);if(e.isDirectory())walk(t);}}
walk(root+'/node_modules/@canlang');
// Import and throw share the same generated line; changing producer URL length
// moves the actual Error stack column and exercises composition.
const js='const marker="😀"; import { STDLIB_CONTRACT_VERSION } from "@canlang/stdlib"; export function canApp(){return {boom};} function boom(){throw new Error("installed-kaboom");}\n';
const throwCol=js.indexOf('new Error');const source='original-handler.can';
const map={version:3,file:'app/main.js',sources:[source],sourcesContent:['## fixture\n'.repeat(50)],names:[],mappings:encode([[[0,0,0,0],[throwCol,0,23,8],[throwCol+9,0,24,11]]])};
const artifact={artifact_version:1,language_version:'1.0.0',tool_version:'0.1.0',sources:[{path:source,sha256:'0'.repeat(64)}],modules:[{path:'app/main.js',js,map}],callables:[{id:'fixture.boom',kind:'operation',module:'app/main.js',export:'boom',member:['boom']}],operations:[],pages:[],requires:[],tests:[]};
const bytes=JSON.stringify(artifact);const hash=createHash('sha256').update(bytes).digest('hex');const verdict={active:true};
const dir=root+'/staged-'+(process.env.NODE_OPTIONS?.includes('--enable-source-maps')?'maps-on':'maps-off');mkdirSync(dir,{recursive:true});writeFileSync(dir+'/package.json','{"type":"module"}');
const asm=await assembleModules({artifact,sourcePath:'probe.artifact.json'},{workDir:dir,stdlibUrl:import.meta.resolve('@canlang/stdlib')});
const engineError=await import(asm.entryUrl).then(m=>{try{m.canApp().boom()}catch(e){return e}});
assert.equal(engineError.message,'installed-kaboom');
const engineStack=engineError.stack;let originalMapFalseWitness;
if(!process.env.NODE_OPTIONS?.includes('--enable-source-maps')){const generatedColumn=Number(engineStack.match(/app\/main\.js:1:(\d+)/)?.[1])-1;assert.ok(generatedColumn>=throwCol+9);originalMapFalseWitness={generatedColumn,originalThrowColumn:throwCol,stale:{source,line:25,column:12},expected:{source,line:24,column:9}};}
const expected={source,line:24,column:9};
const invoked=await invokeCallable(asm,artifact,'fixture.boom',{});assert.equal(invoked.ok,false);assert.deepEqual(invoked.mapped,expected);
if(process.env.NODE_OPTIONS?.includes('--enable-source-maps'))assert.ok(engineStack.includes(source+':24:9'),engineStack);
else {for(const url of Object.values(asm.mapUrls??{}))rmSync(fileURLToPath(url));const fallback=await invokeCallable(asm,artifact,'fixture.boom',{});assert.deepEqual(fallback.mapped,expected);}
assert.equal(JSON.stringify(artifact),bytes);assert.equal(createHash('sha256').update(JSON.stringify(artifact)).digest('hex'),hash);
const first=buildDeployBundle(artifact,{verdict});const second=buildDeployBundle(artifact,{verdict});assert.deepEqual(first.modules,second.modules);assert.equal(first.sha256,second.sha256);assertWorkerdLoadable(first.modules);assertLinksResolve(first.modules);
const written=writeDeployBundle(first,root+'/written-bundle');const readBack=Object.fromEntries(Object.keys(first.modules).map(key=>[key,readFileSync(written.dir+'/'+key,'utf8')]));assert.deepEqual(readBack,first.modules);const staged=await import('file://'+written.dir+'/worker/artifact.js');assert.equal(JSON.stringify(staged.artifact),bytes);assert.deepEqual(staged.verdict,verdict);
assert.ok(!Object.keys(first.modules).some(k=>/module-imports|compose|magic-string|trace-mapping|remapping|lexer/.test(k)));assert.ok(Object.keys(first.modules).some(k=>k.includes('sourcemap-codec')));
let writtenEngineStack;
if(process.env.NODE_OPTIONS?.includes('--enable-source-maps')){const writtenError=await import('file://'+written.dir+'/app/main.js').then(m=>{try{m.canApp().boom()}catch(e){return e}});writtenEngineStack=writtenError.stack;assert.ok(writtenEngineStack.includes(source+':24:9'),writtenEngineStack);}
if(!process.env.NODE_OPTIONS?.includes('--enable-source-maps')){
 const modules={...readBack,'worker/diagnostic-probe.js':'import {artifact,modules as asm} from "./artifact.js"; import {invokeCallable} from "../runtime/invoke.js"; export default {async fetch(){const result=await invokeCallable(asm,artifact,"fixture.boom",{});return Response.json(result);}};'};
 const local=await startLocalDev({workerName:'step8-positive-throw',compatibilityDate:'2026-07-15',mainModule:'worker/diagnostic-probe.js',modules,sourceMaps:staged.modules.sourceMaps});
 try{const response=await local.dispatch('/');const result=await response.json();assert.equal(response.status,200);assert.equal(result.error,'installed-kaboom');assert.deepEqual(result.mapped,expected);writeFileSync(root+'/workerd-result.json',JSON.stringify(result,null,2));}finally{await local.dispose();}
}
const report={runtime:process.version,engineStack,writtenEngineStack,writtenReadBack:true,invoke:invoked,artifactSha256:hash,bundleSha256:first.sha256,bundleModules:first.moduleCount,originalMapFalseWitness,sourceMaps:process.env.NODE_OPTIONS??'',publicInstalled:true};
writeFileSync(root+'/result-'+(process.env.NODE_OPTIONS?.includes('--enable-source-maps')?'maps-on':'maps-off')+'.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
