import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root, artifactPath, scratch] = process.argv.slice(2);
registerHooks({resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const candidate = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(candidate)) return {url:candidate.href, shortCircuit:true};
  }
  return next(specifier, context);
}});
const load = path => import(pathToFileURL(resolve(root, path)));
const {loadArtifactFile} = await load('packages/cloudflare/src/runtime/artifact.ts');
const {assembleModules} = await load('packages/cloudflare/src/runtime/modules.ts');
const {buildPresentationContext} = await load('packages/interfaces/dist/src/http/presentation.js');
const {createSourceFormBindings} = await load('packages/interfaces/dist/src/http/form-binding.js');
const {catalogFromArtifactOperations} = await import('@canlang/interfaces/http/operations');
const {makeIdentity, FIXED_NOW, uuidv7} = await import('@canlang/state/testing/invocation/fixtures');
const uiUrl = import.meta.resolve('@canlang/ui');
const ui = await import(uiUrl);
const loaded = loadArtifactFile(artifactPath);
const artifact = loaded.artifact;
const catalog = catalogFromArtifactOperations(artifact);
const assembly = await assembleModules(loaded, {
  workDir:resolve(scratch, 'view-modules'),
  stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl,
});
const generated = await import(assembly.entryUrl);
const registry = generated.canApp();
assert.equal(Object.hasOwn(registry, 'ViewReuse.card_body'), false, 'view is not an exported callable');
assert.equal(artifact.pages.length, 1, 'view does not mount another page');
assert.equal(artifact.callables.some(item => item.id === 'ViewReuse.card_body'), false);
assert.equal(artifact.operations.some(item => item.name === 'ViewReuse.card_body'), false, 'view publishes no operation/tool');
const page = generated.appDefinition.pages[0];
assert.equal(page.path, '/views');
assert.equal(page.title.sourceLocale, 'fr', 'checked owning source locale is canonical');

// These are the dispatcher-supplied authorized projections consumed by the
// real collection factory. No hidden fields or privileged lookup are offered.
const card = Object.freeze({id:uuidv7(FIXED_NOW, 1), version:'1', fields:Object.freeze({title:'Outer <Card>',flag:true})});
const detail = Object.freeze({id:uuidv7(FIXED_NOW, 2), version:'1', fields:Object.freeze({label:'Nested <Detail>'})});
const identity = makeIdentity({actor:null, team:null, membership:null});
const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(93), 'view-reuse-fixture');
const columns = Object.entries(generated.appDefinition.models['ViewReuse.Card'].fields)
  .map(([field, declaration]) => ({field, label:field, type:declaration.type}));
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
const decodeAttribute = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
async function render(preferredLocale, {url='https://example.test/views', hasDetails=true, available=true, selected=false}={}) {
  const queries = [];
  const context = buildPresentationContext({
    request:new Request(url, {headers:{'Accept-Language':preferredLocale}}),
    pathname:'/views', isPartial:true, appDefaultLocale:'es', csrfToken:'', principal:identity,
    catalog, formBindings, appId:'ViewReuse', sessionToken:'view-reuse-session', clock:{nowMs:()=>FIXED_NOW},
    query:async (invocation, model, args) => {
      assert.equal(invocation, identity, 'collection query preserves admitted invocation identity');
      queries.push({model, args});
      if (model === 'ViewReuse.Card') {
        assert.equal(args.parent, undefined);
        return {rows:available?[card]:[], columns};
      }
      assert.equal(model, 'ViewReuse.Detail', 'no extra model or hidden-field refetch');
      assert.equal(args.parent.id, card.id, 'nested query uses the supplied outer row identity');
      return {rows:hasDetails?[detail]:[], columns:[]};
    },
  });
  const bindings = await page.admit(context);
  const html = await page.render(context, bindings);
  if (!selected) {
    assert.deepEqual(queries.map(item => item.model), ['ViewReuse.Card'], 'absent/stale/revoked selection never queries details');
    assert.ok(!html.includes('<form') && !html.includes('role="tablist"'), 'unselected rows never render view controls');
    assert.ok(!html.includes('Nested &lt;Detail&gt;'));
    return {context, queries, html};
  }
  assert.deepEqual(queries.map(item => item.model), ['ViewReuse.Card', 'ViewReuse.Detail', 'ViewReuse.Detail']);
  const oneUse=['Outer &lt;Card&gt;', 'Outer &lt;Card&gt;',
    ...(hasDetails?['Nested &lt;Detail&gt;']:[]),'Outer &lt;Card&gt;', 'Outer &lt;Card&gt;'];
  assert.deepEqual(html.replace(/<[^>]*>/g, '').match(/Outer &lt;Card&gt;|Nested &lt;Detail&gt;/g), ['Outer &lt;Card&gt;',...oneUse,...oneUse],
    'each expansion shadows the nested row and restores its own outer row afterward');
  assert.ok(!html.includes('Outer <Card>') && !html.includes('Nested <Detail>'), 'projection text is escaped');
  const statuses=[...html.matchAll(/<span class="([^"]*)" aria-label="([^"]*)">/g)]
    .filter(match=>match[1].split(' ').includes('status'));
  assert.equal(statuses.length,2,'checked boolean status uses the existing native factory in both views');
  for(const status of statuses){
    assert.ok(status[1].split(' ').includes('status-success'));
    assert.ok(status[1].split(' ').includes('status-sm'));
    assert.ok(status[2]);
  }
  const radios = [...html.matchAll(/<input\b[^>]*\btype="radio"[^>]*>/g)].map(match => attributes(match[0]));
  const panels = [...html.matchAll(/<div\b[^>]*\brole="tabpanel"[^>]*>/g)].map(match => attributes(match[0]));
  assert.equal(radios.length, 4);
  assert.equal(panels.length, 4);
  assert.equal(new Set(radios.map(item => item.id)).size, 4, 'two uses have distinct transient radio IDs');
  assert.equal(new Set(panels.map(item => item.id)).size, 4, 'two uses have distinct panel IDs');
  assert.equal(new Set([...radios, ...panels].map(item => item.id)).size, 8);
  assert.equal(new Set(radios.map(item => item.name)).size, 2, 'each use owns its radio group');
  for (const radio of radios) {
    assert.ok(radio.id && radio.name);
    const panel = panels.find(item => item.id === radio['aria-controls']);
    assert.ok(panel);
    assert.equal(panel['aria-labelledby'], radio.id);
  }
  const captions = preferredLocale === 'nl' ? ['Afstemming', 'Geschiedenis'] : ['Coordination', 'History'];
  assert.deepEqual(radios.map(item => item['aria-label']), [...captions, ...captions]);
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]);
  assert.equal(forms.length, hasDetails ? 6 : 4, 'each show renders its actual unbound and bound source forms');
  const operationForms = operation => forms.filter(form => attributes(form.split('>')[0]).action === '/api/operations/'+operation);
  const unbound = operationForms('ViewReuse.save');
  assert.equal(unbound.length, 2);
  const inputIds = unbound.map(form => {
    const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map(match => attributes(match[0]));
    const note = inputs.filter(input => input.name === ui.fieldInputName('scenario', 'note'));
    assert.equal(note.length, 1, 'authored input note reaches the installed form preparer/factory once');
    assert.ok(note[0].id?.startsWith('operation-form-source-'), 'form uses a checked source occurrence prefix');
    const labels = [...form.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)];
    const label = labels.find(match => attributes(match[0].split('>')[0])['for'] === note[0].id);
    assert.ok(label, 'declaration label targets its actual input');
    assert.ok(label[0].includes('Authored note'), 'native catalog preserves the parameter declaration label');
    return note[0].id;
  });
  assert.equal(new Set(inputIds).size, 2, 'same-operation shows have distinct form controls');
  const boundIdentities = {};
  for (const [operation, expectedCount, caption] of [
    ['ViewReuse.bind_card', 2, 'Bind card'],
    ['ViewReuse.recover_detail', hasDetails ? 2 : 0, 'Recover detail'],
  ]) {
    const selected = operationForms(operation);
    assert.equal(selected.length, expectedCount);
    boundIdentities[operation] = selected.map(form => {
      const attrs = attributes(form.split('>')[0]);
      const metadata = JSON.parse(decodeAttribute(attrs['data-can-generated-form']));
      assert.equal(metadata.derived.operation, operation);
      assert.match(metadata.bindingIdentity, /^[a-f0-9]{64}$/);
      assert.match(metadata.draftIdentity, /^[a-f0-9]{64}$/);
      const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map(match => attributes(match[0]));
      const tokens = inputs.filter(input => input.name === 'form_binding');
      assert.equal(tokens.length, 1, 'actual source-binding service seals each protected form');
      const token = decodeAttribute(tokens[0].value).split('.');
      assert.equal(token.length, 2);
      const claims = JSON.parse(Buffer.from(token[0], 'base64url').toString('utf8'));
      assert.deepEqual(claims.bound, operation === 'ViewReuse.bind_card'
        ? {visit:{id:card.id, version:card.version}}
        : {attempt:{id:detail.id, version:detail.version}}, 'native sealed binding retains the correct outer or nested row');
      assert.ok(form.includes(caption), 'bound action keeps its declaration label');
      return {binding:metadata.bindingIdentity, draft:metadata.draftIdentity};
    });
    assert.equal(new Set(boundIdentities[operation].map(item => item.binding)).size, expectedCount);
    assert.equal(new Set(boundIdentities[operation].map(item => item.draft)).size, expectedCount);
  }
  return {context, radios, panels, queries, html, inputIds, boundIdentities};
}
const unselected = await render('es');
assert.equal(unselected.context.collectionSelections.size, 0);
const selectionUrls = [...unselected.html.matchAll(/<a\b[^>]*>/g)].map(match => attributes(match[0]).href)
  .filter(Boolean).map(href => new URL(decodeAttribute(href), 'https://example.test/views'));
const selectedUrl = selectionUrls.find(url => [...url.searchParams].some(([key,value]) => key.startsWith('can-row:') && value===card.id));
assert.ok(selectedUrl, 'actual native split table emits the row selection URL');
assert.equal(selectedUrl.pathname, '/views');
const source = await render('es', {url:selectedUrl.href, selected:true});
assert.deepEqual([...source.context.collectionSelections.values()], [card.id], 'actual Interfaces parses the native selection link');
assert.equal(ui.resolveMessage(page.title, {preferredLocales:source.context.preferredLocales,
  appDefaultLocale:source.context.appDefaultLocale}).locale, 'fr', 'unavailable viewer locale falls back to checked source');
const dutch = await render('nl', {url:selectedUrl.href, selected:true});
assert.deepEqual(dutch.radios.map(item => item.id), source.radios.map(item => item.id), 'rerender preserves each use identity');
assert.deepEqual(dutch.panels.map(item => item.id), source.panels.map(item => item.id));
assert.deepEqual(dutch.inputIds, source.inputIds, 'locale rerender preserves each show/row form control prefix');
assert.deepEqual(dutch.boundIdentities, source.boundIdentities, 'locale rerender preserves owning signed binding/draft comparisons');
const empty=await render('es', {url:selectedUrl.href, selected:true, hasDetails:false});
assert.equal(empty.html.split('No records.').length-1,2,'omitted empty props reach the released shared UI default');
assert.deepEqual(empty.radios.map(item=>item.id),source.radios.map(item=>item.id));
assert.deepEqual(empty.inputIds, source.inputIds, 'nested requery preserves each show/row form control prefix');
assert.deepEqual(empty.boundIdentities['ViewReuse.bind_card'], source.boundIdentities['ViewReuse.bind_card'],
  'nested requery preserves the outer row action occurrence');
const unknownUrl = new URL(selectedUrl);
const selectionKey = [...unknownUrl.searchParams.keys()].find(key => key.startsWith('can-row:'));
unknownUrl.searchParams.set(selectionKey, uuidv7(FIXED_NOW, 99));
await render('es', {url:unknownUrl.href});
await render('es', {url:selectedUrl.href, available:false});
console.log(JSON.stringify({consumer:'real CLI artifact → public loader/assembler → installed UI page admission/render',
  uses:2, sourceLocale:'fr', rerenderLocale:'nl', nestedRowRestored:true, distinctTabControls:true, nativeBooleanStatus:true, sharedEmptyDefault:true,
  nativeUnboundForms:true, distinctStableFormControls:true, declarationInputLabel:true,
  signedImplicitAndNestedActionBindings:true,
  nativeSplitSelection:true, absentUnknownRevokedDetailSuppressed:true,
  queriesPerRender:source.queries.map(item => item.model)}));
