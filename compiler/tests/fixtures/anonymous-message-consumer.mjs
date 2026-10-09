import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {datetime} from '@canlang/stdlib';
import {formatMessage} from '@canlang/ui';
import {buildPresentationContext} from '@canlang/interfaces';

const [root, can, scratch] = process.argv.slice(2);
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

const wording = '{location}; {resource}; {from,date} {from,time} – {until,date} {until,time}; {arrival}; {terms}; /workspace/my-bookings';
const source = `app AnonymousMessages uses=[Wording]
context
 locale default="nl"
package Wording source="fr"
 use std {OperationOutcome}
 Given
  contract Booking {location:text,resource:text,from:datetime,until:datetime,arrival:text,terms:text}
  contract Counts {n:int,word:text,extra:text}
  export message body(location:text,resource:text,from:datetime,until:datetime,arrival:text,terms:text) = "${wording}"@{nl="${wording}"}
  export derive anonymous(value:Booking):text = format("${wording}"@{nl="${wording}"}(until=value.until,resource=value.resource,location=value.location,from=value.from,arrival=value.arrival,terms=value.terms),locale=null)
  export derive named(value:Booking):text = format(body(location=value.location,resource=value.resource,from=value.from,until=value.until,arrival=value.arrival,terms=value.terms),locale=null)
  export derive plural(value:Counts):text = format("{n,plural,one {un {word}} other {plusieurs {word}}}"@{nl="{n,plural,one {een {word}} other {meerdere {word}}}; {extra}"}(extra=value.extra,word=value.word,n=value.n),locale=null)
  message enumBody(mode:OperationOutcome.state)="{mode,select,pending {Waiting} other {{mode}}}"@{nl="{mode,select,pending {Wachten} other {{mode}}}"}
  message capture(seed:text,word:text=seed)="{seed}|{word}"@{nl="{word}:{seed}"}
  message staticCaption="Légende statique"@{nl="Statisch bijschrift"}
  derive boundCaption(seed:text):capture=capture(seed=seed)
  message defaultCaption(seed:text="Défaut",word:text=seed)="{seed}|{word}"@{nl="{word}:{seed}"}
  derive defaultProducer():defaultCaption=defaultCaption()
  derive staticProducer():staticCaption=staticCaption
  export derive enumNamed(value:OperationOutcome):text=format(enumBody(value.state),locale=null)
  export derive enumNamedDescriptor(value:OperationOutcome):enumBody=enumBody(value.state)
  export derive enumAnonymous(value:OperationOutcome):text=format("{mode,select,pending {Waiting} other {{mode}}}"@{nl="{mode,select,pending {Wachten} other {{mode}}}"}(mode=value.state),locale=null)
 When
  export scenario aliased(value:Counts) -> text by=members
   do
    let body="{n,plural,one {un {word}} other {plusieurs {word}}}"@{nl="{n,plural,one {een {word}} other {meerdere {word}}}; {extra}"}(extra=value.extra,word=value.word,n=value.n)
    let alias=((body))
    let final=alias
    let formatted=format(locale=null,descriptor=((final)))
    return "formatted"
  export scenario emptyAlias() -> text by=members
   do
    let body="Salut"@{nl="Dag"}
    let alias=body
    let formatted=format(alias,locale=null)
    return "formatted"
  export scenario namedAlias(value:Counts) -> int by=members
   do
    let body=capture(seed=value.word)
    let alias=body
    let final=((alias))
    let formatted=format(final,locale=null)
    return count([final])
 Then
  page /captions title="Captions"
   card "{n} cards"@{nl="{n} kaarten"}(n=1)
    text "Anonymous body"
   details (("{n} details"@{nl="{n} details nl"}(n=2)))
    text "Details body"
   divider (("{n} dividers"@{nl="{n} scheidingen"}(n=3)))
   card capture(seed="Page")
    text "Named body"
   card boundCaption(seed="Producer")
    text "Producer body"
   card defaultProducer()
    text "Default producer body"
   card staticProducer()
    text "Static producer body"
   fieldset (("{n} groups"@{nl="{n} groepen"}(n=4)))
    text "Fieldset body"
   tabs
    tab "{n} tabs"@{nl="{n} tabbladen"}(n=5)
     text "Tab body"
   card staticCaption
    text "Static card body"
   details ((staticCaption))
    text "Static details body"
   divider staticCaption
   fieldset ((staticCaption))
    text "Static fieldset body"
   tabs
    tab ((staticCaption))
     text "Static tab body"
`;
const file = resolve(scratch, 'AnonymousMessages.can');
writeFileSync(file, source);
const compiled = spawnSync(can, ['compile','--format=json','--catalog',resolve(root,'packages/values/dist/catalog.json'),file], {encoding:'utf8', timeout:15000});
assert.equal(compiled.status, 0, compiled.stdout+'\n'+compiled.stderr);
const artifact = resolve(scratch,'AnonymousMessages.json');
writeFileSync(artifact, compiled.stdout);
// Observe the actual immutable constructor output without publishing a
// descriptor as a text business result. Every call delegates to its owner.
const uiUrl=import.meta.resolve('@canlang/ui');
const observedUi=resolve(scratch,'observed-ui.mjs');
writeFileSync(observedUi,`export * from ${JSON.stringify(uiUrl)};
import {message as nativeMessage} from ${JSON.stringify(uiUrl)};
export function message(...args){const descriptor=nativeMessage(...args);globalThis.anonymousDescriptors.push(descriptor);return descriptor;}`);
const descriptors=[];globalThis.anonymousDescriptors=descriptors;
const assembled = await assembleModules(loadArtifactFile(artifact), {
  workDir:resolve(scratch,'AnonymousMessages'),
  stdlibUrl:import.meta.resolve('@canlang/stdlib'), uiUrl:pathToFileURL(observedUi).href,
});
const registry = (await import(assembled.entryUrl)).canApp();
const captionRef=JSON.parse(compiled.stdout).pages.find(page=>page.path==='/captions');
assert.ok(captionRef);
const captionPage=(await import(assembled.moduleUrls[captionRef.module]))[captionRef.export];
const captionContext=buildPresentationContext({request:new Request('https://example.test/captions'),
  pathname:'/captions',isPartial:false,appDefaultLocale:'nl',csrfToken:'',
  principal:{actor:null,team:null,membership:null,binding:{kind:'none'},admitted_at:'2026-10-09T10:00:00Z'},
  query:async()=>assert.fail('static captions do not query'),
});
const captionHtml=await captionPage.render(captionContext,await captionPage.admit(captionContext));
for(const caption of ['1 kaarten','2 details nl','3 scheidingen','Page:Page','Producer:Producer','Défaut:Défaut','4 groepen','5 tabbladen','Anonymous body','Details body','Named body','Producer body','Default producer body','Static producer body','Fieldset body','Tab body']) {
  assert.ok(captionHtml.includes(caption),`actual UI renders bound caption ${caption}`);
}
assert.equal(captionHtml.match(/Statisch bijschrift/g)?.length,6,'zero-parameter bare/grouped captions render through all five actual UI factories and a valid producer');
for(const body of ['Static card body','Static details body','Static fieldset body','Static tab body']) assert.ok(captionHtml.includes(body),body);
const memberContext={memberships:['members']};
const values = {
  location:'Brussels', resource:'Meeting room',
  from:datetime('2026-10-09T10:00:00Z'), until:datetime('2026-10-09T11:00:00Z'),
  arrival:'Entrance A', terms:'Bring ID',
};
for (const appDefault of ['nl','es']) {
  const context = {formatting:{appDefault},team:{timezone:'Europe/Brussels'}};
  const trace = [];
  const booking = Object.fromEntries(Object.entries(values));
  for (const name of Object.keys(values)) Object.defineProperty(booking,name,{get(){trace.push(name);return values[name]}});
  const actual = await registry['Wording.anonymous'](context,booking);
  assert.deepEqual(trace,['until','resource','location','from','arrival','terms'],'inferred arguments evaluate once in authored order');
  assert.deepEqual(actual,await registry['Wording.named'](context,values),'same native formatter and declared temporal schema');
  assert.equal(actual.locale,appDefault==='nl'?'nl':'fr','null locale honors app fallback and owning source language');
  assert.ok(actual.text.includes('Brussels; Meeting room;'));
  assert.ok(actual.text.endsWith('Entrance A; Bring ID; /workspace/my-bookings'));
  const pluralTrace = [];
  const counts = {get extra(){pluralTrace.push('extra');return 'variant'},get word(){pluralTrace.push('word');return 'tasks'},get n(){pluralTrace.push('n');return 0n}};
  const plural = await registry['Wording.plural'](context,counts);
  assert.deepEqual(pluralTrace,['extra','word','n'],'all variants bind even when source does not reference an argument');
  assert.deepEqual(plural,appDefault==='nl'?{text:'meerdere tasks; variant',locale:'nl'}:{text:'un tasks',locale:'fr'});
  pluralTrace.length=0;
  descriptors.length=0;
  assert.equal(await registry['Wording.aliased']({...context,...memberContext},{value:counts}),'formatted');
  assert.equal(descriptors.length,1,'alias construction happens once before its actual formatter');
  const aliased=descriptors[0];
  assert.deepEqual(pluralTrace,['extra','word','n'],'format aliases consume captured arguments without reevaluation');
  assert.equal(aliased.sourceLocale,'fr');
  assert.deepEqual(Object.keys(aliased.params),['extra','word','n']);
  assert.equal(formatMessage(aliased,{preferredLocales:[],appDefaultLocale:appDefault}),plural.text,'captured alias reaches actual UI sink');
  descriptors.length=0;
  assert.equal(await registry['Wording.emptyAlias']({...context,...memberContext},{}),'formatted');
  assert.equal(descriptors.length,1);
  const empty=descriptors[0];
  assert.equal(formatMessage(empty,{preferredLocales:[],appDefaultLocale:appDefault}),appDefault==='nl'?'Dag':'Salut');
  pluralTrace.length=0;
  descriptors.length=0;
  const namedAlias=await registry['Wording.namedAlias']({...context,...memberContext},{value:counts});
  assert.deepEqual(pluralTrace,['word'],'named local retains once evaluated source and dependent default');
  assert.equal(namedAlias,1n,'named alias formats through Values before returning an ordinary supported result');
  assert.equal(descriptors.length,1);
  assert.deepEqual(descriptors[0].params,{seed:{type:'text',value:'tasks'},word:{type:'text',value:'tasks'}});
  assert.equal(formatMessage(descriptors[0],{preferredLocales:[],appDefaultLocale:appDefault}),appDefault==='nl'?'tasks:tasks':'tasks|tasks');
  for(const state of ['pending','released']) {
    const outcome={source:'request',revision:1n,state};
    const named=await registry['Wording.enumNamed'](context,outcome);
    descriptors.length=0;
    assert.deepEqual(await registry['Wording.enumAnonymous'](context,outcome),named,'ownerless enum presentation uses real Values formatting');
    assert.equal(descriptors.length,1);
    const anonymousDescriptor=descriptors[0];
    assert.deepEqual(named,{text:state==='pending'?(appDefault==='nl'?'Wachten':'Waiting'):'released',locale:appDefault==='nl'?'nl':'fr'});
    for(const descriptor of [anonymousDescriptor,await registry['Wording.enumNamedDescriptor'](context,outcome)]) {
      assert.equal(descriptor.params.mode.type,'enum(pending,confirmed,unavailable,failed,unknown,released)');
      assert.throws(()=>formatMessage(descriptor,{preferredLocales:[],appDefaultLocale:appDefault}),/unsupported message parameter type enum\(pending,confirmed,unavailable,failed,unknown,released\)/,'UI canonical enum admission remains a blocked foreign-owner prerequisite');
    }
  }
  for(const name of ['enumNamed','enumAnonymous']) {
    await assert.rejects(registry['Wording.'+name](context,{source:'request',revision:1n,state:{wrong:'shape'}}),'actual Values enum formatting refuses structural operands');
    // Direct calls bypass typed input admission. The existing Values enum tag
    // validates strings, while domain membership belongs to the input owner.
  }
}
const trace = [];
const broken = {get until(){trace.push('until');throw new Error('first argument')},get resource(){trace.push('resource');return 'unreached'}};
await assert.rejects(registry['Wording.anonymous']({formatting:{appDefault:'nl'},team:null},broken),{message:'first argument'});
assert.deepEqual(trace,['until'],'earlier argument failure preserves lazy later arguments');
trace.length=0;
const failed=new Error('first captured binding');
const brokenCounts={get extra(){trace.push('extra');throw failed},get word(){trace.push('word');return 'unreached'}};
await assert.rejects(registry['Wording.aliased']({formatting:{appDefault:'nl'},team:null,...memberContext},{value:brokenCounts}),error=>error===failed);
assert.deepEqual(trace,['extra'],'alias creation preserves first-failure identity and skips later operands');
await assert.rejects(registry['Wording.aliased']({formatting:{appDefault:'nl'},team:null,...memberContext},{value:{extra:'ok',word:'tasks',n:'invalid'}}),'alias formatter still validates native values at the sink');
console.log('anonymous descriptor: native bilingual date/time, plural schema, source language, null locale, explicit binding and evaluation order passed');
console.log('alias consumer and ownerless Values formatter exercised; canonical ownerless UI formatter remains blocked by exact observed admission refusal');
