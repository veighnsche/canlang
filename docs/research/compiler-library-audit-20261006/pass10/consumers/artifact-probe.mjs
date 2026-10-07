import assert from 'node:assert/strict';
import {readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {dirname,join,relative} from 'node:path';
const [mode,base,artifactPath,sourcePath,checkout]=process.argv.slice(2);
if(mode==='installed') assert.throws(()=>readFileSync(join(checkout,'package.json')),e=>e.code==='ERR_ACCESS_DENIED');
const entry = mode==='installed' ? import.meta.resolve('@canlang/cloudflare/runtime/artifact') : pathToFileURL(join(base,'packages/cloudflare/dist/runtime/artifact.js')).href;
const root=dirname(dirname(fileURLToPath(entry)));
const pins={};function checked(file){const p=realpathSync(file);if(mode==='installed'){assert.ok(p.startsWith(base+'/'));assert.ok(!p.startsWith(checkout+'/'));}pins[p]=createHash('sha256').update(readFileSync(p)).digest('hex');return pathToFileURL(p).href;}
const {parseArtifactText,loadArtifactFile,assertCompiledIdentity}=await import(checked(fileURLToPath(entry)));
const loaded=loadArtifactFile(artifactPath);const a=parseArtifactText(readFileSync(artifactPath,'utf8'),artifactPath).artifact;assert.deepEqual(loaded.artifact,a);
const bytes=readFileSync(sourcePath);const hash=createHash('sha256').update(bytes).digest('hex');assertCompiledIdentity(a,{sourcePath,sourceSha256:hash,languageVersion:'1.0',toolVersion:'0.1.0'});
assert.equal(a.artifact_version,1);assert.equal(a.sources[0].sha256,hash);assert.equal(a.models.length,1);const m=a.models[0];assert.equal(m.name,'Shop.Gadget');assert.deepEqual(m.fields.map(f=>f.name),['title','stock','price','active','nick']);assert.deepEqual(m.fields.map(f=>f.default?.value),['é😀\b\f','9223372036854775807',undefined,true,undefined]);assert.equal(m.fields[4].nullable,true);assert.equal(m.deleteMode,'archive');assert.ok(a.operations.some(o=>o.name==='Shop.Gadget.create'));
// Decode independently from the consumer codec, and compare every emitted row.
function decode(map){const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';let source=0,line=0,column=0,name=0;return map.split(';').map(row=>{let generated=0;return row?row.split(',').map(seg=>{let fields=[],v=0,shift=0;for(const c of seg){let n=alphabet.indexOf(c);assert.ok(n>=0);v+=(n%32)*2**shift;if(n<32){fields.push(v%2?-Math.floor(v/2):Math.floor(v/2));v=0;shift=0;}else shift+=5;}assert.equal(shift,0);generated+=fields[0];if(fields.length===1)return[generated];source+=fields[1];line+=fields[2];column+=fields[3];const result=[generated,source,line,column];if(fields.length===5){name+=fields[4];result.push(name);}return result;}):[];});}
const {lookup}=await import(checked(join(root,'runtime/sourcemap.js')));
let points=0;for(const mod of a.modules){assert.deepEqual(mod.map.sources,[sourcePath]);assert.deepEqual(mod.map.sourcesContent,[bytes.toString('utf8')]);const rows=decode(mod.map.mappings);assert.equal(rows.length,mod.js.split('\n').length-1);for(const [i,segments] of rows.entries()){assert.equal(segments.length,1);const s=segments[0];assert.equal(s[0],0);assert.equal(s[1],0);assert.deepEqual(lookup(mod.map,i+1,0),{source:sourcePath,line:s[2]+1,column:s[3]+1,...(s.length===5?{name:mod.map.names[s[4]]}:{})});points++;}}
assert.deepEqual(lookup(a.modules[0].map,1,0),{source:sourcePath,line:1,column:1});
const {assembleModules}=await import(checked(join(root,'runtime/modules.js')));
const stdlib=mode==='installed'?import.meta.resolve('@canlang/cloudflare/runtime/stdlib'):pathToFileURL(join(base,'packages/cloudflare/dist/runtime/stdlib.js')).href;
const asm=await assembleModules(loaded,{workDir:join(dirname(artifactPath),mode+'-emitted'),stdlibUrl:checked(fileURLToPath(stdlib))});
for(const url of Object.values(asm.moduleUrls))assert.ok(fileURLToPath(url).startsWith(dirname(artifactPath)+'/'));
const module=await import(asm.entryUrl);assert.equal(typeof module.canApp,'function');const app=module.canApp();assert.ok(app);
const fields=module.appDefinition.models['Shop.Gadget'].fields;assert.equal(fields.title.default,'é😀\b\f');assert.equal(fields.stock.default,9223372036854775807n);assert.equal(fields.active.default,true);assert.equal(fields.nick.nullable,true);assert.equal(Object.hasOwn(fields.price,'default'),false);
const {invokeCallable}=await import(checked(join(root,'runtime/invoke.js')));
const refused=await invokeCallable(asm,a,'Shop.Gadget.create',{caller:{kind:'anonymous'},memberships:[],store:{},clock:()=>0,preferences:{}},[{}]);assert.equal(refused.ok,false);assert.equal(refused.error,'forbidden');assert.ok(refused.mapped);assert.deepEqual(refused.mapped,{source:sourcePath,line:5,column:5,name:'canApp'});

// The actual unchanged generated app module executes; separately assert its
// literal metadata, including BigInt, after import and canApp evaluation.
const js=a.modules[0].js;assert.ok(js.includes('default:9223372036854775807n'));assert.ok(js.includes('default:"é😀\\u0008\\u000c"'));assert.ok(js.includes('default:true'));
const testkitEntry=mode==='installed'?import.meta.resolve('@canlang/testkit'):pathToFileURL(join(base,'packages/testkit/dist/index.js')).href;
const {formatFailureLocation}=await import(checked(fileURLToPath(testkitEntry)));assert.equal(formatFailureLocation(lookup(a.modules[0].map,1,0)),sourcePath+':1:1');assert.equal(formatFailureLocation(refused.mapped),sourcePath+':5:5');
console.log(JSON.stringify({mode,checkoutRead:mode==='installed'?'ERR_ACCESS_DENIED':'current dist',artifactVersion:a.artifact_version,sourceHash:hash,models:a.models.length,operations:a.operations.length,mapPoints:points,emittedExecution:'actual assembleModules + import + canApp',appKeys:Object.keys(app),defaults:'evaluated exact control/Unicode text, BigInt9223372036854775807, bool and nullable',emittedNegative:refused,testkit:'actual formatFailureLocation on emitted source map',pins}));
