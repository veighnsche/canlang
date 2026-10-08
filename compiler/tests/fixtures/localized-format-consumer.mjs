import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {date, datetime, parseDecimal, money} from '@canlang/stdlib';
import {createTestMemoryStorage} from '@canlang/state/storage/memory';
import {FIXED_NOW, asOperationId, createMemoryIdentityStore, makeIdentity, seedMember, uuidv7} from '@canlang/state/testing/invocation/fixtures';
const [root, can, scratch] = process.argv.slice(2);
// Native TS loading changes only source-owned extension resolution, never
// compiler output, runtime bodies or owning package exports.
registerHooks({resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const candidate = new URL(specifier.slice(0, -3)+'.ts', context.parentURL);
    if (existsSync(candidate)) return {url:candidate.href, shortCircuit:true};
  }
  return next(specifier, context);
}});
const load = path => import(pathToFileURL(resolve(root, path)));
const {loadArtifactFile} = await load('packages/cloudflare/src/runtime/artifact.ts');
const {assembleModules} = await load('packages/cloudflare/src/runtime/modules.ts');

if (process.argv.includes('--label-parameter')) {
  const source=`app LabelParameter uses=[Labels]
context
 locale default="en"
package Labels source="en"
 Given
  message caption = "Actual caption"@{}
  message greet(seed:text="S",label:text=seed,tail:text="T" label=caption) = "{seed}|{label}|{tail}"@{}
  export derive render(seed:text):text = format(greet(seed=seed),locale=null)
  export derive explicit(label:text):text = format(greet(seed="S",label=label),locale=null)
 When
 Then
`;
  const compileSource=(name,text)=>{
    const file=resolve(scratch,name+'.can');
    writeFileSync(file,text);
    return spawnSync(can,['compile','--format=json','--catalog',resolve(root,'packages/values/dist/catalog.json'),file],{encoding:'utf8',timeout:15000});
  };
  const compiled=compileSource('LabelParameter',source);
  assert.equal(compiled.status,0,compiled.stdout+'\n'+compiled.stderr);
  const artifactPath=resolve(scratch,'LabelParameter.json');
  writeFileSync(artifactPath,compiled.stdout);
  const loaded=loadArtifactFile(artifactPath);
  const asm=await assembleModules(loaded,{workDir:resolve(scratch,'LabelParameter'),stdlibUrl:import.meta.resolve('@canlang/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
  const registry=(await import(asm.entryUrl)).canApp();
  const context={formatting:{appDefault:'en'},team:null};
  assert.deepEqual(await registry['Labels.render'](context,'Ready'),{text:'Ready|Ready|T',locale:'en'});
  assert.deepEqual(await registry['Labels.explicit'](context,'Bound'),{text:'S|Bound|T',locale:'en'});
  const refused=compileSource('InvalidLabelCaption',source.replace('message caption = "Actual caption"','message caption(value:text) = "Actual {value}"'));
  assert.equal(refused.status,10,refused.stdout+'\n'+refused.stderr);
  const response=JSON.parse(refused.stdout);
  assert.equal(response.diagnostics.length,1,refused.stdout);
  assert.equal(response.diagnostics[0].code,'E3016');
  assert.equal(response.diagnostics[0].message,"label cannot reference 'caption'; parameterized messages need call syntax");
  assert.equal(response.modules,undefined,'invalid actual caption cannot publish modules');
  console.log('localized contextual label parameter: dependent default and explicit binding execute through generated formatter; invalid actual parameter caption refuses E3016');
  process.exit(0);
}

if (process.argv.includes('--branch-options')) {
  // One source-owned case crosses production compilation, artifact loading,
  // generated imports and the installed formatter facade. This is an
  // expression host with explicit app scope, not a State handler proof.
  const source=`app BranchOptions uses=[Branches]
context
 locale default="en"
package Branches source="en"
 Given
  contract Choice { mode:enum(primary,secondary) }
  contract Input { n:int, mode:Choice.mode, target:locale? }
  export message summary(n:int,mode:Choice.mode,flag:bool,word:text,rank:int) = "{mode,select,primary {{n,plural,=0 {none} one {one {word}} other {{flag,select,true {# {word}} false {# paused} other {# unknown}}}}} other {fallback {word}}}|{rank,selectordinal,one {#st} two {#nd} few {#rd} other {#th}}"@{fr="{mode,select,primary {{n,plural,=0 {aucun} one {un {word}} other {{flag,select,true {# {word}} false {# pause} other {# inconnu}}}}} other {repli {word}}}|{rank,selectordinal,one {#er} other {#e}}"}
  export message exact(amount:decimal) = "{amount,plural,=9007199254740993.125 {exact {amount,number}} one {one #} other {other #}}"@{fr="{amount,plural,=9007199254740993.125 {exact {amount,number}} one {un #} other {autres #}}"}
  export derive render(n:int,mode:Choice.mode,flag:bool,word:text,rank:int,target:locale?):text = format(summary(n,mode,flag,word,rank),locale=target)
  export derive positional(v:Input):text = format(summary(v.n,v.mode,true,"ready",21),locale=v.target)
  export derive reordered(v:Input):text = format(locale=v.target,descriptor=summary(rank=12,word="done",flag=false,mode=v.mode,n=v.n))
  export derive decimal(amount:decimal,target:locale?):text = format(exact(amount),locale=target)
 When
 Then
`;
  const file=resolve(scratch,'BranchOptions.can');
  writeFileSync(file,source);
  const compiled=spawnSync(can,['compile','--format=json','--catalog',resolve(root,'packages/values/dist/catalog.json'),file],{encoding:'utf8',timeout:15000});
  assert.equal(compiled.status,0,compiled.stdout+'\n'+compiled.stderr);
  const artifactPath=resolve(scratch,'BranchOptions.json');
  writeFileSync(artifactPath,compiled.stdout);
  const loaded=loadArtifactFile(artifactPath);
  const asm=await assembleModules(loaded,{workDir:resolve(scratch,'BranchOptions'),stdlibUrl:import.meta.resolve('@canlang/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
  const registry=(await import(asm.entryUrl)).canApp();
  const context={formatting:{appDefault:'en'},team:null};
  const call=(name,...args)=>registry['Branches.'+name](context,...args);
  assert.deepEqual(await call('render',0n,'primary',true,'ready',1n,null),{text:'none|1st',locale:'en'});
  assert.deepEqual(await call('render',1n,'primary',true,'ready',2n,'en-GB'),{text:'one ready|2nd',locale:'en'});
  assert.deepEqual(await call('render',2n,'primary',true,'ready',3n,null),{text:'2 ready|3rd',locale:'en'});
  assert.deepEqual(await call('render',2n,'primary',false,'ready',12n,'de'),{text:'2 paused|12th',locale:'en'});
  assert.deepEqual(await call('render',2n,'secondary',true,'done',11n,null),{text:'fallback done|11th',locale:'en'});
  assert.deepEqual(await call('render',2n,'primary',false,'ready',1n,'fr-CA'),{text:'2 pause|1er',locale:'fr'});

  // The chosen whole-message locale owns category selection, including
  // requested-tag fallback: French zero is cardinal one; English is other.
  assert.deepEqual(await call('decimal',parseDecimal('0'),'fr-CA'),{text:'un 0',locale:'fr'});
  assert.deepEqual(await call('decimal',parseDecimal('0'),'de'),{text:'other 0',locale:'en'});
  assert.deepEqual(await call('decimal',parseDecimal('9007199254740993.125'),null),{text:'exact 9,007,199,254,740,993.125',locale:'en'});
  await assert.rejects(call('decimal',parseDecimal('9007199254740993.126'),null),error=>error.code==='out-of-range' && error.message==='plural selection needs a safe-range operand; this magnitude cannot select exactly');
  await assert.rejects(call('render',9007199254740992n,'primary',true,'ready',1n,null),error=>error.code==='out-of-range' && error.message==='plural selection needs a safe-range int; this magnitude cannot select exactly');

  for (const [name,order,text] of [
    ['positional',['n','mode','target'],'2 ready|21st'],
    ['reordered',['target','mode','n'],'2 paused|12th'],
  ]) {
    const trace=[];
    const input={get n(){trace.push('n');return 2n},get mode(){trace.push('mode');return 'primary'},get target(){trace.push('target');return null}};
    assert.deepEqual(await call(name,input),{text,locale:'en'});
    assert.deepEqual(trace,order,name+': written arguments evaluated once in source order');
    trace.length=0;
    const sentinel=new Error(name+': first argument');
    const failing=Object.fromEntries(['n','mode','target'].map(key=>[key,null]));
    for (const key of ['n','mode','target']) Object.defineProperty(failing,key,{get(){trace.push(key);throw key===order[0]?sentinel:new Error('later argument was evaluated')}});
    await assert.rejects(call(name,failing),error=>error===sentinel);
    assert.deepEqual(trace,[order[0]],name+': first failure preserves identity and skips later arguments');
  }
  console.log('localized branch options: generated nested select/plural/ordinal, exact decimal, locale fallback, argument order and failure identity passed');
  process.exit(0);
}

const {buildInvoker} = await load('packages/cloudflare/src/worker/assembly.ts');

const shared = `package Shared source="fr"
 Given
  contract Box { first:text, target:locale? }
  contract Choice { mode:enum(first,second) }
  export message greeting = "Bonjour"@{nl="Hallo",de="Guten Tag"}
  export message parametrized(a:text="A",b:text=a) = "{a}|{b}"@{nl="{a}:{b}"}
  export message exact(amount:decimal,n:int,day:date,at:datetime) = "{amount,number}|{n,number,integer}|{day,date,short}|{at,date,short}"@{}
  export message strings(mail:email,mode:Choice.mode,flag:bool) = "{mail}|{mode}|{flag}"@{}
  export message monetary(total:money) = "{total}"@{}
  export derive g():text = format(greeting,locale=null)
  export derive target(value:locale?):text = format(locale=value,descriptor=greeting)
  export derive fallback():text = format(greeting,locale="es")
  export derive defaults():text = format(parametrized(),locale=null)
  export derive ordered(v:Box):text = format(locale=v.target,descriptor=parametrized(a=v.first))
  export derive descriptor():greeting = greeting
  export derive returned():text = format(descriptor(),locale=null)
  export derive native(amount:decimal,n:int,day:date,at:datetime):text = format(exact(amount,n,day,at),locale="en")
  export derive scalar_tags(mail:email,mode:Choice.mode,flag:bool):text = format(strings(mail,mode,flag),locale="en")
  export derive money_tag(total:money):text = format(monetary(total),locale=null)
  export derive inline():text = format("Salut"@{nl="Dag"},locale=null)
 When
  export scenario qualify() by=members
   do
    let rendered=g()
    let selected=["plain"] as rendered where rendered=="plain"
    for rendered in ["plain"] limit=1
     let unchanged=count([rendered])
 Then
`;
function compile(app, locale) {
  const file=resolve(scratch,app+'.can');
  writeFileSync(file,`app ${app} uses=[Shared]\ncontext\n locale default="${locale}"\n${shared}`);
  const result=spawnSync(can,['compile','--format=json','--catalog',resolve(root,'packages/values/dist/catalog.json'),file],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  const artifactPath=resolve(scratch,app+'.json'); writeFileSync(artifactPath,result.stdout);
  return loadArtifactFile(artifactPath);
}
const worlds=[];
for (const [app,locale,expected] of [['Dutch','nl','Hallo'],['German','de','Guten Tag']]) {
  const loaded=compile(app,locale), artifact=loaded.artifact;
  const asm=await assembleModules(loaded,{workDir:resolve(scratch,app),stdlibUrl:import.meta.resolve('@canlang/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
  const registry=(await import(asm.entryUrl)).canApp();
  const context={formatting:Object.freeze({appDefault:locale}),team:null,preferences:{locale:'en'}};
  const call=(name,...args)=>registry['Shared.'+name](context,...args);
  assert.deepEqual(await call('g'),{text:expected,locale});
  assert.deepEqual(await call('returned'),{text:expected,locale});
  assert.deepEqual(await call('target','nl'),{text:'Hallo',locale:'nl'});
  assert.deepEqual(await call('target',null),{text:expected,locale});
  assert.deepEqual(await call('fallback'),{text:expected,locale},'explicit unmatched locale uses app fallback');
  assert.deepEqual(await registry['Shared.fallback']({formatting:{appDefault:'es'},team:null}),{text:'Bonjour',locale:'fr'},'owning French source language survives imported package');
  assert.deepEqual(await call('defaults'),{text:locale==='nl'?'A:A':'A|A',locale:locale==='nl'?'nl':'fr'});
  const trace=[];
  const box={get target(){trace.push('target');return 'nl'},get first(){trace.push('first');return 'B'}};
  assert.deepEqual(await call('ordered',box),{text:'B:B',locale:'nl'});
  assert.deepEqual(trace,['target','first'],'written outer arguments evaluated once');
  const failing={get target(){throw new Error('first argument')},get first(){throw new Error('must remain lazy')}};
  await assert.rejects(call('ordered',failing),{message:'first argument'});
  for(const bad of [{},{formatting:{appDefault:'nl'}},{formatting:{appDefault:'nl'},team:{timezone:null}}]) {
    await assert.rejects(registry['Shared.g'](bad),error=>error.code==='invalid-construction');
  }
  assert.deepEqual(await call('scalar_tags','person@example.test','first',true),{text:'person@example.test|first|true',locale:'fr'});
  assert.deepEqual(await call('money_tag',money(parseDecimal('12.34'),'EUR')),{text:'12.34 EUR',locale:'fr'});
  assert.deepEqual(await call('inline'),{text:locale==='nl'?'Dag':'Salut',locale:locale==='nl'?'nl':'fr'});
  const amount=parseDecimal('12345678901234567890.123456789012345678');
  const utc={formatting:{appDefault:locale},team:null};
  const brussels={formatting:{appDefault:locale},team:{timezone:'Europe/Brussels'}};
  const args=[amount,42n,date('0001-01-01'),datetime('2024-01-01T23:30:00Z')];
  const native=await registry['Shared.native'](utc,...args);
  assert.equal(native.locale,'fr');
  assert.ok(native.text.endsWith('|42|01/01/1|01/01/2024'),native.text);
  assert.ok(native.text.startsWith('12\u202f345\u202f678\u202f901\u202f234\u202f567\u202f890,123456789012345678|'),native.text);
  const zoned=await registry['Shared.native'](brussels,...args);
  assert.ok(zoned.text.endsWith('|02/01/2024'),zoned.text);
  worlds.push({app,artifact,asm});
}

// The real selected-app reader, invoker and canonical State bridge execute
// an unchanged emitted handler. Missing explicit legacy scope refuses.
const memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
for(const [index,{app,artifact,asm}] of worlds.entries()) {
  const {store}=createTestMemoryStorage();
  const envelope={operation:'Shared.qualify',operation_id:asOperationId(uuidv7(FIXED_NOW,index+1)),inputs:{}};
  const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
  const outcome=await invoker.invokeMutation(envelope,identity);
  assert.ok('result' in outcome,JSON.stringify(outcome));
  assert.equal(outcome.result.status,'committed');
  const legacy=buildInvoker(artifact,asm,store,{appId:app,memberships,now:()=>FIXED_NOW});
  const refused=await legacy.invokeMutation({...envelope,operation_id:asOperationId(uuidv7(FIXED_NOW,index+100))},identity);
  assert.ok('error' in refused,JSON.stringify(refused));
}
console.log('localized formatter: checked native/schema/source language, runtime locale/order/defaults, missing scope, and actual canonical handler bridge passed');

// A formatted result may be held or returned by a pure presentation derive,
// but the currently unclassified business sinks must refuse before shipping.
const prohibited=[
  ['operator','Given\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\n derive bad():bool = g()=="Bonjour"\nWhen\nThen\n'],
  ['builtin','Given\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\n derive bad():text = lower(g())\nWhen\nThen\n'],
  ['plain-template','Given\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\n derive bad():text = format("{x}",{x=g()})\nWhen\nThen\n'],
  ['derive-argument','Given\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\n derive identity(x:text):text = x\n derive bad():text = identity(g())\nWhen\nThen\n'],
  ['guard','Given\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\nWhen\n scenario bad() by=members\n  require g()=="Bonjour"\n  do let noop=1\nThen\n'],
  ['local-write','Given\n Note {title:text}\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\nWhen\n scenario bad() by=members\n  do\n   let body=g()\n   create Note {title=body} as note\nThen\n'],
  ['result','Given\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\nWhen\n scenario bad() -> text by=members\n  do return g()\nThen\n'],
  ['default','Given\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\n derive identity(x:text=g()):text = x\n derive bad():text = identity()\nWhen\nThen\n'],
  ['query','Given\n Note {title:text}\n policy Note read=members\n message m="Bonjour"@{}\n derive g():text = format(m,locale=null)\nWhen\n scenario bad() by=members\n  do let notes=Note as n where n.title==g()\nThen\n'],
];
for(const [id,body] of prohibited) {
  const file=resolve(scratch,id+'.can'); writeFileSync(file,'app Refused\n'+body);
  const result=spawnSync(can,['compile','--format=json','--catalog',resolve(root,'packages/values/dist/catalog.json'),file],{encoding:'utf8',timeout:15000});
  const response=JSON.parse(result.stdout);
  assert.equal(result.status,10,id+': '+result.stdout+'\n'+result.stderr);
  assert.ok(response.diagnostics.some(d=>d.code==='E6008'&&d.message.includes('formatted')),id+': '+result.stdout);
  assert.equal(response.modules,undefined,'no successful artifact for '+id);
}
console.log('formatted result business sinks: nine source-level refusals passed');
