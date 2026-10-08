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
const {buildPresentationContext} = await load('packages/interfaces/src/http/presentation.ts');
const {makeIdentity} = await import('@canlang/state/testing/invocation/fixtures');
const uiUrl = import.meta.resolve('@canlang/ui');
const ui = await import(uiUrl);
const loaded = loadArtifactFile(artifactPath);
const artifact = loaded.artifact;
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
const card = Object.freeze({id:'card-visible', version:'1', fields:Object.freeze({title:'Outer <Card>'})});
const detail = Object.freeze({id:'detail-visible', version:'1', fields:Object.freeze({label:'Nested <Detail>'})});
const identity = makeIdentity({actor:null, team:null, membership:null});
async function render(preferredLocale) {
  const queries = [];
  const context = buildPresentationContext({
    request:new Request('https://example.test/views', {headers:{'Accept-Language':preferredLocale}}),
    pathname:'/views', isPartial:true, appDefaultLocale:'es', csrfToken:'', principal:identity,
    query:async (invocation, model, args) => {
      assert.equal(invocation, identity, 'collection query preserves admitted invocation identity');
      queries.push({model, args});
      if (model === 'ViewReuse.Card') {
        assert.equal(args.parent, undefined);
        return {rows:[card], columns:[]};
      }
      assert.equal(model, 'ViewReuse.Detail', 'no extra model or hidden-field refetch');
      assert.equal(args.parent.id, card.id, 'nested query uses the supplied outer row identity');
      return {rows:[detail], columns:[]};
    },
  });
  const bindings = await page.admit(context);
  const html = await page.render(context, bindings);
  assert.deepEqual(queries.map(item => item.model), ['ViewReuse.Card', 'ViewReuse.Detail', 'ViewReuse.Detail']);
  assert.deepEqual(html.match(/Outer &lt;Card&gt;|Nested &lt;Detail&gt;/g), [
    'Outer &lt;Card&gt;', 'Outer &lt;Card&gt;', 'Nested &lt;Detail&gt;', 'Outer &lt;Card&gt;', 'Outer &lt;Card&gt;',
    'Outer &lt;Card&gt;', 'Outer &lt;Card&gt;', 'Nested &lt;Detail&gt;', 'Outer &lt;Card&gt;', 'Outer &lt;Card&gt;',
  ], 'each expansion shadows the nested row and restores its own outer row afterward');
  assert.ok(!html.includes('Outer <Card>') && !html.includes('Nested <Detail>'), 'projection text is escaped');
  const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
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
  return {context, radios, panels, queries};
}
const source = await render('es');
assert.equal(ui.resolveMessage(page.title, {preferredLocales:source.context.preferredLocales,
  appDefaultLocale:source.context.appDefaultLocale}).locale, 'fr', 'unavailable viewer locale falls back to checked source');
const dutch = await render('nl');
assert.deepEqual(dutch.radios.map(item => item.id), source.radios.map(item => item.id), 'rerender preserves each use identity');
assert.deepEqual(dutch.panels.map(item => item.id), source.panels.map(item => item.id));
console.log(JSON.stringify({consumer:'real CLI artifact → public loader/assembler → installed UI page admission/render',
  uses:2, sourceLocale:'fr', rerenderLocale:'nl', nestedRowRestored:true, distinctTabControls:true,
  queriesPerRender:source.queries.map(item => item.model)}));
