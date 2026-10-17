import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {format} from '@canlang/stdlib';

const root=resolve(process.argv[2]);
const here=resolve(import.meta.dirname);
const can=resolve(process.argv[3]??resolve(root,'compiler/target/debug/can'));
const baseCatalog=resolve(root,'packages/values/dist/catalog.json');
const receipts=[];
function compile(id,source,{catalog=baseCatalog,exit=0}={}){
 const file=resolve(here,id+'.can');writeFileSync(file,source);
 const run=spawnSync(can,['compile','--format=json','--catalog',catalog,file],{encoding:'utf8',timeout:10000});
 assert.equal(run.error,undefined);assert.equal(run.status,exit,run.stdout+'\n'+run.stderr);
 writeFileSync(resolve(here,id+'.stdout'),run.stdout);writeFileSync(resolve(here,id+'.stderr'),run.stderr);
 const artifact=JSON.parse(run.stdout);
 for(const module of artifact.modules??[]){const path=resolve(here,id,module.path);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,module.js);const syntax=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr)}
 receipts.push({id,exit:run.status,diagnostics:artifact.diagnostics,modules:artifact.modules?.map(m=>m.path)});
 return artifact;
}
async function registry(id,artifact){return (await import(pathToFileURL(resolve(here,id,artifact.modules[0].path)))).canApp()}
const source=`app Audit
Given
 contract Input {template:text,value:text}
 derive identity(v:text):text = v
 derive pair(first:text,second:text=first,third:text=second):text = format("{first}/{second}/{third}",{first=first,second=second,third=third})
 derive reordered(v:Input):text = pair(third=v.value,first=v.template)
 derive mixed(v:Input):text = pair(v.template,third=v.value)
 derive builtin(v:Input):bool = contains(needle=v.value,value=v.template)
 derive nested(v:Input):text = pair(third=identity(v.value),first=identity(v.template))
 derive skip(v:Input):bool = true or contains(needle=v.value,value=v.template)
 derive nullable(first:text?="fallback",second:text?=first):text? = second
 derive null_named():text? = nullable(first=null)
 derive null_hole():text? = nullable(second=null)
 derive null_omitted():text? = nullable()
 derive dynamic(v:Input):text = format(values={name=v.value},template=v.template)
 derive escaped():text = format(values={name="é"},template="{{name}} {{{name}}} }}")
 message hygienic(c:text="C",class:text=c,await:text=class)="{c}/{class}/{await}"@{}
 derive descriptor(v:Input):hygienic = hygienic(await=v.value,c=v.template)
 derive descriptor_default():hygienic = hygienic()
When
Then
`;
const artifact=compile('controls',source);const r=await registry('controls',artifact);
const call=(name,...values)=>r['Audit.'+name]({marker:'context'},...values);
function input(trace,{fail}={}){return {get template(){trace.push('template');if(fail)throw new Error('template failed');return 'ABC'},get value(){trace.push('value');if(fail)throw new Error('value failed');return 'BC'}}}
for(const [name,order,result] of [['reordered',['value','template'],'ABC/ABC/BC'],['mixed',['template','value'],'ABC/ABC/BC'],['nested',['value','template'],'ABC/ABC/BC'],['builtin',['value','template'],true]]){
 const trace=[];assert.equal(await call(name,input(trace)),result);assert.deepEqual(trace,order,name);
 const failure=[];await assert.rejects(call(name,input(failure,{fail:true})),{message:order[0]+' failed'});assert.deepEqual(failure,[order[0]],name+' first error');
}
{const trace=[];assert.equal(await call('skip',input(trace)),true);assert.deepEqual(trace,[])}
assert.equal(await call('null_named'),null);assert.equal(await call('null_hole'),null);assert.equal(await call('null_omitted'),'fallback');
assert.equal(await call('escaped'),format('{{name}} {{{name}}} }}',{name:'é'}));
{const trace=[];const result=await call('descriptor',input(trace));assert.deepEqual(result.params,{c:{type:'text',value:'ABC'},class:{type:'text',value:'ABC'},await:{type:'text',value:'BC'}});assert.deepEqual(trace,['value','template'])}
assert.deepEqual((await call('descriptor_default')).params,{c:{type:'text',value:'C'},class:{type:'text',value:'C'},await:{type:'text',value:'C'}});
for(const template of ['{missing}','{','}']){
 let expected;try{format(template,{name:'é'})}catch(error){expected=error}assert(expected);
 const trace=[];await assert.rejects(call('dynamic',{get value(){trace.push('value');return 'é'},get template(){trace.push('template');return template}}),error=>error.name===expected.name&&error.code===expected.code&&error.message===expected.message);assert.deepEqual(trace,['value','template']);
}
assert(!artifact.modules[0].js.includes('async($can$a'),'synchronous captures introduce no async wrapper');

const aliasSource=`app AliasAudit
use Owner {compute as class,descriptor as renamed}
Given
 derive word():text = "caller"
 derive run():text = class(third="third")
 derive inspect():renamed = renamed(await="supplied")
When
Then
package Owner
 Given
  derive word():text = "owner"
  export derive compute(c:text=word(),second:text=c,third:text=second):text = format("{c}/{second}/{third}",{c=c,second=second,third=third})
  export message descriptor(c:text=word(),class:text=c,await:text=class)="{c}/{class}/{await}"@{}
 When
 Then
`;
const aliases=compile('aliases',aliasSource);const a=await registry('aliases',aliases);
assert.equal(await a['AliasAudit.run']({}),'owner/owner/third');
assert.deepEqual((await a['AliasAudit.inspect']({})).params,{c:{type:'text',value:'owner'},class:{type:'text',value:'owner'},await:{type:'text',value:'supplied'}});

const custom=JSON.parse(readFileSync(baseCatalog,'utf8'));
const target=custom.entries.find(e=>e.id==='contains');
target.signature='contains(value:int,needle:text)->bool; contains(needle:text,value:text)->bool';
const customPath=resolve(here,'winning.catalog.json');writeFileSync(customPath,JSON.stringify(custom));
const winning=compile('winning','app Win\nGiven\n derive run():bool = contains(value="ABC",needle="BC")\nWhen\nThen\n',{catalog:customPath});
const win=await registry('winning',winning);assert.equal(await win['Win.run']({}),false,'second same-arity overload supplies needle before value to actual facade');
target.signature='contains(text:int,end:text)->bool; contains(needle:text,value:text)->bool';writeFileSync(customPath,JSON.stringify(custom));
const differentlyNamed=compile('winning-names','app Win\nGiven\n derive run():bool = contains(value="ABC",needle="BC")\nWhen\nThen\n',{catalog:customPath});
const wn=await registry('winning-names',differentlyNamed);assert.equal(await wn['Win.run']({}),false);
target.effects='state-read';writeFileSync(customPath,JSON.stringify(custom));
const awaits=compile('awaits','app AwaitAudit\nGiven\nWhen\n scenario run() read=true -> bool by=members\n  do return false and contains(value="ABC",needle="BC")\nThen\n',{catalog:customPath});
assert.match(awaits.modules[0].js,/false && await \(\(/);assert(!awaits.modules[0].js.includes('async($can$a'));
await assert.rejects(registry('awaits',awaits),/does not provide an export named 'require'/);
receipts.push({id:'state-read-runtime',status:'OPEN',reason:'Actual emitted module fails import on absent stdlib require; syntax and await/lazy placement verified, runtime context forwarding not claimed.'});

for(const [id,expression,expected] of [
 ['missing-sorted','format(values={},template="{z}{a}{z}")',["`format` placeholder '{a}' has no values entry","`format` placeholder '{z}' has no values entry"]],
 ['escaped-missing','format(values={},template="{{literal}} {z}")',["`format` placeholder '{z}' has no values entry"]],
 ['malformed-reversed','format(values={},template="}")',['malformed `format` template: unmatched closing brace']],
]){
 const src=`app Diag\nGiven\n derive run():text = ${expression}\nWhen\nThen\n`;const result=compile(id,src,{exit:10});
 assert.deepEqual(result.diagnostics.map(d=>d.code),expected.map(()=> 'E3005'));assert.deepEqual(result.diagnostics.map(d=>d.message),expected);
 for(const diagnostic of result.diagnostics)assert.equal(src.slice(diagnostic.primary.start,diagnostic.primary.end),expression.slice(expression.indexOf('template=')+9,-1));
}
const exact=compile('exact-arity','app Exact\nGiven\n derive run():bool = contains(value="ABC")\nWhen\nThen\n',{exit:10});assert(exact.diagnostics.some(d=>d.code==='E3005'));assert(exact.diagnostics.every(d=>d.code!=='E6008'));
writeFileSync(resolve(here,'observations.json'),JSON.stringify({scope:'Independent actual production CLI and unmodified installed facade controls; direct getter inputs qualify evaluation only.',receipts},null,2)+'\n');
console.log(JSON.stringify({ok:true,receipts:receipts.length}));
