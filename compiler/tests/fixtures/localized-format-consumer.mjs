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
