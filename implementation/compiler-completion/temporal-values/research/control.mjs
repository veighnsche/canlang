import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../../../..');
const bin='/private/tmp/can-temporal-values-control';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const req=createRequire(root+'/package.json');
const resolved=Object.fromEntries(['values','ui','stdlib'].map(n=>[n,req.resolve('@canlang/'+n)]));
const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(p,e.name)):[path.join(p,e.name)]);
const files=['compiler/src/analysis/types.rs','compiler/src/analysis/examples.rs','compiler/src/analysis/resolve.rs','compiler/src/codegen/ir.rs','compiler/src/codegen/js.rs','docs/specification/DESIGN.md',...['values','ui','stdlib','state','contracts'].flatMap(n=>[`packages/${n}/package.json`,...walk(root+`/packages/${n}/dist`).map(p=>path.relative(root,p))]),...['packages/values/src/icu.ts','packages/values/src/temporal.ts','packages/values/src/decimal.ts','packages/ui/src/messages.ts']].filter(p=>fs.existsSync(root+'/'+p));
const pin=()=>Object.fromEntries(files.map(p=>[p,hash(root+'/'+p)]));
const before=pin();
fs.writeFileSync(here+'/pins-before.json',JSON.stringify({binary:{path:bin,sha256:hash(bin),sourceAttribution:'unproven; copied before use; source snapshots independently hashed'},resolved,profile:{node:process.version,versions:process.versions,hostIntl:new Intl.DateTimeFormat().resolvedOptions()},files:before},null,2));
const values=await import(pathToFileURL(resolved.values));
const ui=await import(pathToFileURL(resolved.ui));
const capture=fn=>{try{return {ok:true,value:fn()};}catch(e){return {ok:false,name:e.name,code:e.code,message:e.message};}};
const controls=[];
const add=(id,type,value,pattern)=>controls.push({id,type,pattern,operand:value,values:capture(()=>values.renderMessage(pattern,{x:{type,value}},'en',{timeZone:'UTC'})),ui:capture(()=>ui.formatMessage(ui.message(pattern,{}, {x:{type,value}}),{locale:'en',timeZone:'UTC'}))});
for(const text of ['0001-01-01','0099-01-01','0100-01-01','2024-02-29']){
 const owned=capture(()=>values.date(text));
 controls.push({id:'constructor-'+text,owned});
 add('string-date-'+text,'date',text,'{x,date}');
 if(owned.ok)add('tagged-date-'+text,'date',owned.value,'{x,date}');
}
add('date-time-tagged','date',values.date('2024-02-29'),'{x,time}');
add('date-time-string','date','2024-02-29','{x,time}');
for(const text of ['0001-01-01T00:00:00Z','2024-02-29T12:30:00Z']){
 add('tagged-datetime-'+text,'datetime',values.datetime(text),'{x,time}');
 add('string-datetime-'+text,'datetime',text.replace('Z','.000Z'),'{x,time}');
}
for(const pattern of ['{x,number}','{x,number,integer}','{x,selectordinal,one {one} two {two} few {few} other {other}}']){
 add('decimal-string-'+pattern,'decimal','1.5',pattern);
 add('decimal-tag-'+pattern,'decimal',values.parseDecimal('1.5'),pattern);
 add('int-'+pattern,'int',2n,pattern);
}
controls.push({id:'timezone-UTC',owner:capture(()=>values.assertTimezone('UTC'))},{id:'timezone-Mars',owner:capture(()=>values.assertTimezone('Mars/Olympus'))});
for(const timeZone of ['UTC','Mars/Olympus'])controls.push({id:'format-zone-'+timeZone,values:capture(()=>values.renderMessage('{x,time}',{x:{type:'datetime',value:values.datetime('2024-02-29T12:30:00Z')}},'en',{timeZone})),ui:capture(()=>ui.formatMessage('{x,time}',{args:{x:{type:'datetime',value:'2024-02-29T12:30:00.000Z'}},locale:'en',timeZone}))});
const compile=(id,source,command='compile')=>{
 const input=here+'/'+id+'.can';fs.writeFileSync(input,source);
 const result=spawnSync(bin,[command,'--format=json','--catalog='+root+'/packages/values/dist/catalog.json',input],{encoding:'utf8',cwd:root});
 fs.writeFileSync(here+'/'+id+'.stdout',result.stdout);fs.writeFileSync(here+'/'+id+'.stderr',result.stderr);
 return {id,exit:result.status,envelope:JSON.parse(result.stdout)};
};
const staticControls=[['date-time','app T\nGiven\n message probe(x:date) = "{x,time}"@{}\nWhen\nThen\n'],['timezone-mars','app T\nGiven\nWhen\n scenario s(x:timezone="Mars/Olympus") by=members\n  do\n   let a = x\nThen\n'],...['integer','ordinal'].map(k=>['decimal-'+k,`app T\nGiven\n message probe(x:decimal) = "${k==='integer'?'{x,number,integer}':'{x,selectordinal,one {one} other {other}}'}"@{}\nWhen\nThen\n`])].map(([id,s])=>compile('static-'+id,s,'check'));
const generated=[];
for(const [id,type,expression,pattern] of [['date-low','date','date("0001-01-01")','{x,date}'],['date-0099','date','date("0099-01-01")','{x,date}'],['date-current','date','date("2024-02-29")','{x,date}'],['datetime','datetime','datetime("2024-02-29T12:30:00Z")','{x,time}'],['decimal-literal','decimal','1.5','{x,number}'],['decimal-param','decimal','input','{x,number}']]){
 const source=`app T\nGiven\n message probe(x:${type}) = "${pattern}"@{}\nWhen\n scenario s(${id==='decimal-param'?'input:decimal':''}) read=true -> ${type} by=members\n  do\n   let value = ${expression}\n   let msg = probe(x=value)\n   return value\nThen\n`;
 const result=compile('generated-'+id,source);
 if(result.exit===0){
  const outDir=here+'/'+id; fs.mkdirSync(outDir,{recursive:true});
  for(const m of result.envelope.modules)fs.writeFileSync(outDir+'/'+m.path,m.js);
  const module=await import(pathToFileURL(outDir+'/'+result.envelope.modules[0].path)+'?'+id);
  try{const owned=await module.canApp()['T.s']({memberships:['members']},id==='decimal-param'?{input:values.parseDecimal('1.5')}:{});result.execution={ok:true,owned,joinedUI:capture(()=>ui.formatMessage(ui.message(pattern,{}, {x:{type,value:owned}}),{locale:'en',timeZone:'UTC'}))};}catch(e){result.execution={ok:false,message:e.message};}
 }
 generated.push(result);
}
const after=pin();
fs.writeFileSync(here+'/pins-after.json',JSON.stringify({files:after,changes:files.filter(p=>before[p]!==after[p]),binarySHA256:hash(bin)},null,2));
fs.writeFileSync(here+'/outcomes.json',JSON.stringify({controls,staticControls,generated},(_,v)=>typeof v==='bigint'?v.toString()+'n':v,2));
console.log(JSON.stringify({controls:controls.length,static:staticControls.map(c=>[c.id,c.exit,c.envelope.diagnostics]),generated:generated.map(c=>[c.id,c.exit,c.execution]),changedPins:files.filter(p=>before[p]!==after[p])},(_,v)=>typeof v==='bigint'?v.toString()+'n':v,2));
