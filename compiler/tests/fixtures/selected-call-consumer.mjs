import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {format} from '@canlang/stdlib';
const [root,can,scratch]=process.argv.slice(2);
const catalog=resolve(root,'packages/values/dist/catalog.json');
const receipts=[];
function compile(id,source,selectedCatalog=catalog,ok=true){
 const file=resolve(scratch,id+'.can');writeFileSync(file,source);
 const result=spawnSync(can,['compile','--format=json','--catalog',selectedCatalog,file],{encoding:'utf8',timeout:10000});
 assert(!result.error,`${id}: ${result.error}`);
 writeFileSync(resolve(scratch,id+'.stdout'),result.stdout);writeFileSync(resolve(scratch,id+'.stderr'),result.stderr);
 const artifact=JSON.parse(result.stdout);
 assert.equal(result.status,ok?0:10,`${id}: ${result.stdout}\n${result.stderr}`);
 receipts.push({id,exit:result.status,diagnostics:artifact.diagnostics??[]});
 if(ok){
  for(const module of artifact.modules){const path=resolve(scratch,id,module.path);mkdirSync(resolve(path,'..'),{recursive:true});writeFileSync(path,module.js)}
 }
 return artifact;
}
async function entry(id,artifact){return (await import(pathToFileURL(resolve(scratch,id,artifact.modules[0].path)))).canApp()}
const source=`app T
Given
 contract Box {left:text,right:text}
 derive a(v:Box):text = v.left
 derive b(v:Box):text = v.right
 derive positional():text = format("Hi {n}",{n="Bo"})
 derive named():text = format(template="Hi {n}",values={n="Bo"})
 derive reversed():text = format(values={n="Bo"},template="Hi {n}")
 derive ordered(v:Box):bool = starts_with(prefix=v.left,value=v.right)
 derive mixed(v:Box):bool = starts_with(v.right,prefix=v.left)
 derive format_order(v:Box):text = format(values={n=v.right},template=v.left)
 derive nested(v:Box):bool = starts_with(prefix=a(v),value=b(v))
 derive lazy(v:Box):bool = false and starts_with(prefix=v.left,value=v.right)
 derive take(a:text,b:text):text = format("{a}|{b}",{a=a,b=b})
 derive named_derive(v:Box):text = take(b=v.right,a=v.left)
 derive f(a:text="D",b:text=a):text = format("{a}|{b}",{a=a,b=b})
 derive defaults():text = f()
 derive partial():text = f("A")
 derive hole():text = f(b="B")
 derive explicit():text = f(b="B",a="A")
 derive nullable(a:text?="D"):text? = a
 derive omitted_nullable():text? = nullable()
 derive explicit_null():text? = nullable(null)
 derive getter_defaults(v:Box,a:text=v.left,b:text=v.right):text = format("{a}|{b}",{a=a,b=b})
 derive getter_suppressed(v:Box):text = getter_defaults(v,a="manual")
 derive default_after_supplied(v:Box):text = getter_defaults(v,b=v.right)
 derive async_default(v:Box,a:text=a(v),b:text=a):text = format("{a}|{b}",{a=a,b=b})
 derive async_omitted(v:Box):text = async_default(v)
 derive reserved(c:text="C",class:text=c,await:text=class):text = format("{a}|{b}|{d}",{a=c,b=class,d=await})
 derive reserved_call():text = reserved()
 message m(a:text="D",b:text=a)="{a}|{b}"@{}
 message get(v:text,a:text=v,b:text=a)="{v}|{a}|{b}"@{}
 derive text_identity(v:text):text = v
 message async_get(v:text,a:text=text_identity(v),b:text=a)="{a}|{b}"@{}
 derive descriptor_default():m = m()
 derive descriptor_named(v:Box):m = m(b=v.right,a=v.left)
 derive descriptor_hole(v:Box):m = m(b=v.right)
 derive descriptor_earlier(v:Box):get = get(v=v.left)
 derive descriptor_async(v:Box):async_get = async_get(v.left)
 derive message_default():int = count([m()])
 derive message_named(v:Box):int = count([m(b=v.right,a=v.left)])
 derive message_hole(v:Box):int = count([m(b=v.right)])
 derive message_earlier(v:Box):int = count([get(v=v.left)])
 derive bad(template:text):text = format(values={other="X"},template=template)
When
Then
`;
const artifact=compile('selected',source);
const registry=await entry('selected',artifact);
const call=(name,...args)=>registry['T.'+name]({},...args);
for(const name of ['positional','named','reversed'])assert.equal(await call(name),'Hi Bo',name);
for(const [name,expected]of [['defaults','D|D'],['partial','A|A'],['hole','D|B'],['explicit','A|B'],['reserved_call','C|C|C'],['omitted_nullable','D'],['explicit_null',null]])assert.equal(await call(name),expected,name);
function box(trace,fail){return {get left(){trace.push('left');if(fail)throw new Error('first');return 'A'},get right(){trace.push('right');if(fail)throw new Error('second');return 'AB'}}}
for(const name of ['ordered','nested']){const trace=[];assert.equal(await call(name,box(trace)),true);assert.deepEqual(trace,['left','right'],name)}
{const trace=[];await assert.rejects(call('ordered',box(trace,true)),{message:'first'});assert.deepEqual(trace,['left'])}
{const trace=[];assert.equal(await call('lazy',box(trace)),false);assert.deepEqual(trace,[])}
{const trace=[];assert.equal(await call('mixed',box(trace)),true);assert.deepEqual(trace,['right','left'])}
{const trace=[];assert.equal(await call('format_order',{get right(){trace.push('right');return 'Bo'},get left(){trace.push('left');return 'Hi {n}'}}),'Hi Bo');assert.deepEqual(trace,['right','left'])}
{const trace=[];await assert.rejects(call('named_derive',box(trace,true)),{message:'second'});assert.deepEqual(trace,['right'])}
{const trace=[];await assert.rejects(call('message_named',box(trace,true)),{message:'second'});assert.deepEqual(trace,['right'])}
{const trace=[];assert.equal(await call('named_derive',box(trace)),'A|AB');assert.deepEqual(trace,['right','left'])}
{const trace=[];assert.equal(await call('getter_defaults',box(trace)),'A|AB');assert.deepEqual(trace,['left','right'])}
{const trace=[];assert.equal(await call('getter_suppressed',box(trace)),'manual|AB');assert.deepEqual(trace,['right'])}
{const trace=[];assert.equal(await call('default_after_supplied',box(trace)),'A|AB');assert.deepEqual(trace,['right','left'])}
{const trace=[];await assert.rejects(call('default_after_supplied',box(trace,true)),{message:'second'});assert.deepEqual(trace,['right'])}
{const trace=[];await assert.rejects(call('getter_defaults',box(trace,true)),{message:'first'});assert.deepEqual(trace,['left'])}
{const trace=[];assert.equal(await call('async_omitted',box(trace)),'A|A');assert.deepEqual(trace,['left'])}
assert.equal(await call('message_default'),1n);
assert.deepEqual((await call('descriptor_default')).params,{a:{type:'text',value:'D'},b:{type:'text',value:'D'}});
for(const [name,expected,order]of [['descriptor_named',['A','AB'],['right','left']],['descriptor_hole',['D','AB'],['right']],['descriptor_async',['A','A'],['left']]]){const trace=[];const descriptor=await call(name,box(trace));assert.equal(descriptor.params.a.value,expected[0]);assert.equal(descriptor.params.b.value,expected[1]);assert.deepEqual(trace,order,name)}
{const trace=[];const descriptor=await call('descriptor_earlier',box(trace));assert.deepEqual(Object.values(descriptor.params).map(p=>p.value),['A','A','A']);assert.deepEqual(trace,['left'])}
{const trace=[];assert.equal(await call('message_named',box(trace)),1n);assert.deepEqual(trace,['right','left'])}
{const trace=[];assert.equal(await call('message_hole',box(trace)),1n);assert.deepEqual(trace,['right'])}
{const trace=[];assert.equal(await call('message_earlier',box(trace)),1n);assert.deepEqual(trace,['left'])}
let ownerError;try{format('Hi {n}',{other:'X'})}catch(error){ownerError=error}
await assert.rejects(call('bad','Hi {n}'),error=>error.name===ownerError.name&&error.code===ownerError.code&&error.message===ownerError.message);
const alias=compile('alias',`app Consumer\nuse Provider {take as alias,m as notice}\nGiven\n derive word():text = "CONSUMER"\n derive g():text = alias(b="B",a="A")\n derive owner_default():text = alias(b="B")\n derive descriptor():notice = notice(b="B")\n derive msg():int = count([notice(b="B")])\nWhen\nThen\npackage Provider\n Given\n  derive word():text = "D"\n  export derive take(a:text=word(),b:text=a):text = format("{a}|{b}",{a=a,b=b})\n  export message m(a:text=word(),b:text=a)="{a}|{b}"@{}\n When\n Then\n`);
const aliases=await entry('alias',alias);assert.equal(await aliases['Consumer.g']({}),'A|B');assert.equal(await aliases['Consumer.msg']({}),1n);assert.equal(await aliases['Consumer.owner_default']({}),'D|B');assert.equal((await aliases['Consumer.descriptor']({})).params.a.value,'D');
const custom=JSON.parse(readFileSync(catalog,'utf8'));
const starts=custom.entries.find(e=>e.id==='starts_with');starts.signature='starts_with(value:int,prefix:text)->bool; starts_with(prefix:text,value:text)->bool';
const customPath=resolve(scratch,'same-arity.catalog.json');writeFileSync(customPath,JSON.stringify(custom));
const chosen=compile('same-arity','app T\nGiven\n derive g():bool = starts_with(prefix="A",value="AB")\nWhen\nThen\n',customPath);
const chosenFns=await entry('same-arity',chosen);assert.equal(await chosenFns['T.g']({}),false,'winning second overload order');
starts.effects='state-read';writeFileSync(customPath,JSON.stringify(custom));
const purity=compile('await-purity','app T\nGiven\n derive g():bool = starts_with(prefix="A",value="AB")\nWhen\nThen\n',customPath,false);
assert.deepEqual(purity.diagnostics.map(d=>d.code),['E3010']);
const awaited=compile('await-scenario','app T\nGiven\nWhen\n scenario g() read=true -> bool by=members\n  do return starts_with(prefix="A",value="AB") and starts_with(value="AB",prefix="A")\nThen\n',customPath);
assert.match(awaited.modules[0].js,/await starts_with\(/);
assert.match(awaited.modules[0].js,/await \(\(\$can\$a/);
assert(!awaited.modules[0].js.includes("async("),"reordered awaited builtin adds no async capture");
const scenarioFns=await entry('await-scenario',awaited);
assert.equal(await scenarioFns['T.g']({memberships:['members']},{}),false);
await assert.rejects(scenarioFns['T.g']({memberships:[]},{}),{message:'forbidden'});
receipts.push({id:'await-installed-guards',scope:'Actual facade exports load; direct generated handler allow/deny and awaited selected expression execute. This local context does not qualify canonical admission or read-serving.'});
for(const [id,text,messages]of [
 ['missing-named','format(template="{z}{a}",values={})',["`format` placeholder '{a}' has no values entry","`format` placeholder '{z}' has no values entry"]],
 ['missing-reversed','format(values={},template="{z}{a}")',["`format` placeholder '{a}' has no values entry","`format` placeholder '{z}' has no values entry"]],
 ['malformed','format(values={},template="{")',['malformed `format` template: unterminated placeholder']],
]){
 const result=compile(id,`app T\nGiven\n derive g():text = ${text}\nWhen\nThen\n`,catalog,false);
 assert.deepEqual(result.diagnostics.map(d=>d.code),messages.map(()=> 'E3005'),id);
 assert.deepEqual(result.diagnostics.map(d=>d.message),messages,id);
}
for(const [id,expression]of [['builtin-exact-arity','lower()'],['user-required-slot','take("A")'],['user-unknown-slot','take(a="A",unknown="B")']]){
 const result=compile(id,`app T\nGiven\n derive take(a:text,b:text):text = a\n derive g():text = ${expression}\nWhen\nThen\n`,catalog,false);
 assert(result.diagnostics.some(d=>d.code==='E3005'),id);assert(result.diagnostics.every(d=>d.code!=='E6008'),id);
}
const sourceError=compile('unbound-source','app T\nGiven\n derive g():text = lower(value=missing)\nWhen\nThen\n',catalog,false);
assert.deepEqual(sourceError.diagnostics.map(d=>d.code),['E2001']);
const localized=compile('localized','app T\nGiven\n message m="Hi"@{}\n derive g():text = format(m,locale=null)\nWhen\nThen\n');
assert.match(localized.modules[0].js,/format\(c,/);
const lf=await entry('localized',localized);await assert.rejects(lf['T.g']({}),error=>error.code==='invalid-construction');
const localizedNamed=compile('localized-named','app T\nGiven\n message m="Hi"@{}\n derive g():text = format(descriptor=m,locale=null)\nWhen\nThen\n',catalog,false);
assert.deepEqual(localizedNamed.diagnostics.map(d=>d.code),['E6008']);
receipts.push({id:'localized-seam',gap:'Existing emitted context/facade mismatch and named outer-format E6008 retained, not qualified as repaired.'});
writeFileSync(resolve(scratch,'observations.json'),JSON.stringify(receipts,null,2)+'\n');
console.log(JSON.stringify({scope:'Actual public production compile, unmodified installed stdlib/UI imports, finite direct-callable execution; canonical scenario/localized serving gaps retained.',cases:receipts.length,receipts}));
