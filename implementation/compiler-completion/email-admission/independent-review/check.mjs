import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {decodeValue,encodeValue} from '@canlang/values';
const root=process.cwd(), dir=root+'/implementation/compiler-completion/email-admission/independent-review';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const freeze=JSON.parse(readFileSync(root+'/implementation/compiler-completion/email-admission/implementation/freeze.json'));
for(const [p,h] of Object.entries(freeze.files)) assert.equal(hash(root+'/'+p),h,p);
const denied=new Set([...Array(33).keys(),127,160,5760,...Array.from({length:11},(_,i)=>8192+i),8232,8233,8239,8287,12288,65279]);
const expected=s=>[...s].filter(c=>c==='@').length===1&&!s.startsWith('@')&&!s.endsWith('@')&&![...s].some(c=>denied.has(c.codePointAt(0)));
const saved=JSON.parse(readFileSync(root+'/implementation/compiler-completion/email-admission/implementation/observations.json'));
const vectors=JSON.parse(readFileSync(root+'/implementation/compiler-completion/email-admission/vectors.json'));
assert.equal(saved.length,113); assert.equal(vectors.length,113);
let anchors=0, modules=0, imports=0;
for(let i=0;i<saved.length;i++) {
 const v=vectors[i],r=saved[i],base=root+'/implementation/compiler-completion/email-admission/implementation/fixtures/'+v.id;
 assert.equal(v.expected,expected(v.value));assert.equal(r.id,v.id);assert.equal(r.value,v.value);
 assert.equal(hash(base+'/value.can'),r.sourceHash);
 for(const direction of ['decode','encode']){assert.equal(r[direction].accepted,v.expected);if(v.expected)assert.equal(r[direction].value,v.value);}
 for(const command of ['check','compile']){
  assert.equal(r[command].accepted,v.expected);assert.equal(r[command].exit===0,v.expected);
  const out=JSON.parse(readFileSync(base+'/'+command+'.stdout'));
  if(!v.expected){assert.equal(out.diagnostics.length,1);assert.equal(out.diagnostics[0].code,'E3001');assert.equal(out.complete,true);assert.equal(out.omitted,0);assert.equal(out.modules,undefined); const src=readFileSync(base+'/value.can');assert.deepEqual(out.diagnostics[0].primary,{file:0,start:src.indexOf(Buffer.from('='))+1,end:src.lastIndexOf(Buffer.from(' }'))});if(command==='check')anchors++;}
  if(v.expected&&command==='compile'){
   assert.equal(out.models[0].fields[0].default.value,v.value);
   const m=out.modules[0];assert.equal(readFileSync(base+'/'+m.path,'utf8'),m.js);
   if(m.js.includes('@canlang/ui'))imports++;
   const loaded=await import(pathToFileURL(base+'/'+m.path));assert.equal(loaded.appDefinition.models['T.M'].fields.address.default,v.value);modules++;
  }
 }
}
const cases=new Set();
for(let n=0;n<=5;n++)for(let mask=0;mask<2**n;mask++)cases.add(Array.from({length:n},(_,i)=>mask&(1<<i)?'@':'a').join(''));
for(const cp of [31,32,33,126,127,128,132,133,134,159,160,161,5759,5760,5761,8191,8192,8202,8203,8204,8231,8232,8233,8234,8238,8239,8240,8286,8287,8288,12287,12288,12289,65278,65279,65280,0x1f642])for(const side of [0,1])cases.add(side?'a@b'+String.fromCodePoint(cp):String.fromCodePoint(cp)+'a@b');
for(const s of ['É+X@例子','e\u0301@B','E@-B_..','a@b.1','a@'+ 'z'.repeat(80),'x＠y','x@\u0085','\u200b@b'])cases.add(s);
const results=[];let i=0;
for(const value of cases){const want=expected(value);const record={id:i,value,expected:want};
 for(const [direction,fn]of [['decode',decodeValue],['encode',encodeValue]]) {try{const got=fn('email',value);assert.equal(want,true);assert.equal(got,value);record[direction]='accepted-exact';}catch(e){if(e.name==='AssertionError')throw e;assert.equal(want,false);assert.equal(e.name,direction==='decode'?'SchemaError':'ValueError');record[direction]=e.name;}}
 const fixture=dir+'/fixtures/'+i;mkdirSync(fixture,{recursive:true});const source=fixture+'/value.can';writeFileSync(source,`app R\nGiven\n M { email:email=${JSON.stringify(value)} }\nWhen\nThen\n`);
 for(const command of ['check','compile']) {const run=spawnSync(root+'/compiler/target/debug/can',[command,'--format=json','--catalog',root+'/packages/values/dist/catalog.json',source],{encoding:'utf8',timeout:10000});assert.ifError(run.error);writeFileSync(fixture+'/'+command+'.stdout',run.stdout);writeFileSync(fixture+'/'+command+'.stderr',run.stderr);assert.equal(run.status===0,want);record[command]=run.status;
  const out=JSON.parse(run.stdout);if(want&&command==='compile'){assert.equal(out.models[0].fields[0].default.value,value); const m=out.modules[0];writeFileSync(fixture+'/'+m.path,m.js);const loaded=await import(pathToFileURL(fixture+'/'+m.path));assert.equal(loaded.appDefinition.models['R.M'].fields.email.default,value);record.importedExact=true;}if(!want){assert.equal(out.diagnostics[0].code,'E3001');assert.equal(out.modules,undefined);}}
 results.push(record);i++;
}
const pins={};for(const p of ['compiler/src/analysis/types.rs','compiler/tests/email_admission.rs','compiler/target/debug/can','packages/values/src/wire.ts','packages/values/src/internal/wire-core.ts','packages/values/dist/src/index.js','packages/values/dist/src/wire.js','packages/values/dist/src/internal/wire-core.js','packages/values/dist/catalog.json'])pins[p]=hash(root+'/'+p);
assert.equal(pins['compiler/target/debug/can'],JSON.parse(readFileSync(root+'/implementation/compiler-completion/email-admission/implementation/summary.json')).compilerHash);
writeFileSync(dir+'/results.json',JSON.stringify({pins,freezeFilesVerified:Object.keys(freeze.files).length,reused:{cases:saved.length,anchors,metadataModulesImported:modules,uiImports:imports},fresh:{cases:results.length,directions:2*results.length,check:results.length,compile:results.length,accepted:results.filter(r=>r.expected).length},publicResolved:realpathSync(root+'/node_modules/@canlang/values'),results},null,2)+'\n');
console.log(JSON.stringify({freezeFiles:Object.keys(freeze.files).length,savedCases:saved.length,anchors,modules,uiImports:imports,freshCases:results.length,freshAccepted:results.filter(r=>r.expected).length}));
