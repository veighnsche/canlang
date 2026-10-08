import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../..');
const bin='/private/tmp/can-compiler-0134ebb0-page-handoff/can';
const catalog=path.join(root,'packages/values/dist/catalog.json');
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const files=[bin,catalog,path.join(root,'compiler/src/codegen/js.rs'),path.join(root,'compiler/src/codegen/ir.rs')];
for(const pkg of ['values','ui','stdlib','contracts','state','cloudflare']) {
 files.push(path.join(root,'packages',pkg,'package.json'));
 for(const sub of ['src','dist']) { const walk=d=>{ if(!fs.existsSync(d))return; for(const e of fs.readdirSync(d,{withFileTypes:true})) {const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.isFile())files.push(p);} };walk(path.join(root,'packages',pkg,sub)); }
}
const pins=()=>Object.fromEntries(files.map(p=>[p,hash(p)]));
const before=pins();
fs.writeFileSync(path.join(here,'pins.before.json'),JSON.stringify({binary:bin,binaryHash:hash(bin),catalog,catalogHash:hash(catalog),node:process.version,versions:process.versions,files:before},null,2));
if(hash(bin)!=='b2608559e9af0e934a0727faad1d31aee43528cb87a9359f3576a6d8b3db3a7e')throw Error('binary changed');
if(hash(catalog)!=='cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62')throw Error('catalog changed');
const values=await import('@canlang/values');
const ui=await import('@canlang/ui');
const capture=async fn=>{try{return {ok:true,value:await fn()};}catch(e){return {ok:false,name:e.name,code:e.code,message:e.message};}};
const captionContext=Object.freeze({preferredLocales:[],appDefaultLocale:'en'});
// Contract-only CaptionContext: public factory preconditions, not route dispatcher or canonical actor provenance.
const definitions=[
 ['date0001','date','date("0001-01-01")','{x,date}','Jan 1, 1'],
 ['date0099','date','date("0099-01-01")','{x,date}','Jan 1, 99'],
 ['date2001','date','date("2001-01-01")','{x,date}','Jan 1, 2001'],
 ['date2024','date','date("2024-02-29")','{x,date}','Feb 29, 2024'],
 ['instant','datetime','datetime("2024-03-31T22:30:00Z")','{x,time}',null],
 ['decimal','decimal','1.50','{x,number}','1.5'],
 ['integer','int','2','{x,number,integer}','2'],
 ['ordinal','int','2','{x,selectordinal,one {one} two {two} few {few} other {other}}','two']
];
const observations=[];
for(const [id,type,expr,pattern,expected] of definitions){
 const source=`app TemporalPage source="en"\ncontext\n locale default="en"\nGiven\n message probe(x:${type}) = "${pattern}"@{}\nWhen\nThen\n page / title="Temporal"\n  text probe(x=${expr})\n`;
 const sourcePath=path.join(here,id+'.can');fs.writeFileSync(sourcePath,source);
 const args=['compile','--format=json','--catalog',catalog,sourcePath];
 const r=spawnSync(bin,args,{encoding:'utf8',cwd:root});
 fs.writeFileSync(path.join(here,id+'.stdout'),r.stdout);fs.writeFileSync(path.join(here,id+'.stderr'),r.stderr);
 const artifact=JSON.parse(r.stdout);
 const row={id,type,sourcePath,sourceHash:hash(sourcePath),command:[bin,...args],exit:r.status,expected,artifactHash:hash(path.join(here,id+'.stdout'))};
 if(r.status===0){
  const out=path.join(here,id);fs.mkdirSync(out,{recursive:true});
  for(const m of artifact.modules)fs.writeFileSync(path.join(out,m.path),m.js);
  const pageRef=artifact.pages[0];
  const entry=await import(pathToFileURL(path.join(out,pageRef.module)).href);
  const descriptor=entry[pageRef.export];
  row.actualExport={module:pageRef.module,export:pageRef.export,exactIdentity:entry.appDefinition.pages[0]===descriptor};
  const bindings=await descriptor.admit(captionContext);
  row.admit=bindings;
  row.generatedRender=await capture(()=>descriptor.render(captionContext,bindings));
 }
 observations.push(row);
}
const controls=[];
for(const [text,expected] of [['0001-01-01','Jan 1, 1'],['0099-01-01','Jan 1, 99'],['2001-01-01','Jan 1, 2001'],['2024-02-29','Feb 29, 2024']]) {
 const tagged=values.date(text);
 controls.push({id:'constructor-and-supported-presentation-'+text,tagged,expected,values:await capture(()=>values.renderMessage('{x,date}',{x:{type:'date',value:tagged}},'en',{timeZone:'UTC'})),uiSupportedString:await capture(()=>ui.formatMessage('{x,date}',{args:{x:{type:'date',value:text}},locale:'en',timeZone:'UTC'}))});
}
for(const zone of ['UTC','Europe/Brussels','Mars/Olympus']) {
 controls.push({id:'real-host-zone-'+zone,assert:await capture(()=>values.assertTimezone(zone)),localDate:await capture(()=>values.local_date(values.datetime('2024-03-31T22:30:00Z'),zone)),expected:zone==='UTC'?{kind:'date',year:2024,month:3,day:31}:zone==='Europe/Brussels'?{kind:'date',year:2024,month:4,day:1}:{error:'invalid-construction'}});
}
for(const row of observations) {
 assert.equal(row.exit,0,`${row.id}: source must compile`);
 assert.equal(row.actualExport.exactIdentity,true);
 assert.deepEqual(row.admit,{});
 if(row.id==='integer'||row.id==='ordinal') {
  assert.deepEqual(row.generatedRender,{ok:true,value:`<p>\u2068${row.expected}\u2069</p>`});
 } else {
  assert.equal(row.generatedRender.ok,false,`${row.id}: retained carrier refusal`);
  assert.equal(row.generatedRender.name,'TypeError');
  const expectedMessage={date:'type date needs a valid YYYY-MM-DD civil date',datetime:'type datetime needs a canonical RFC3339 UTC instant',decimal:'type decimal needs a bigint or canonical decimal string'}[row.type];
  assert.equal(row.generatedRender.message,`message argument \"x\": ${expectedMessage}`);
 }
}
for(const control of controls) {
 if(control.id.startsWith('constructor-and-')) {
  assert.deepEqual(control.values,{ok:true,value:control.expected});
  if(control.tagged.year<100) assert.equal(control.uiSupportedString.ok,false);
  else assert.deepEqual(control.uiSupportedString,{ok:true,value:control.expected});
 } else if(control.expected.error) {
  assert.equal(control.assert.code,control.expected.error);
  assert.equal(control.localDate.code,control.expected.error);
 } else {
  assert.deepEqual(control.localDate,{ok:true,value:control.expected});
 }
}
const after=pins();
const changes=files.filter(p=>before[p]!==after[p]);
fs.writeFileSync(path.join(here,'pins.after.json'),JSON.stringify({files:after,changes},null,2));
const output={scope:'unchanged emitted page export -> public UI factory with supported CaptionContext only; no canonical request/context, browser or timezone propagation claim',captionContext,observations,controls,changes};
fs.writeFileSync(path.join(here,'outcomes.json'),JSON.stringify(output,(_,v)=>typeof v==='bigint'?v.toString()+'n':v,2));
console.log(JSON.stringify({observations:observations.map(x=>({id:x.id,exit:x.exit,result:x.generatedRender})),controls,changes},(_,v)=>typeof v==='bigint'?v.toString()+'n':v,2));
