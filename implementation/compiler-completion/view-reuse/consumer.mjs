import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const [root, artifactPath, scratch, profile] = process.argv.slice(2);
const dateControl = profile === 'calendar';
const editBody = profile === 'edit-body';
const listColumns = profile === 'list-columns';
const scenarioCheckbox = profile === 'scenario-checkbox';
const agendaPreference = profile === 'agenda-preference';
const unboundOperation = dateControl ? 'ViewReuse.Holiday.create' : 'ViewReuse.save';
const unboundMode = dateControl ? 'create' : 'scenario';
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
const detail = Object.freeze({id:uuidv7(FIXED_NOW, 2), version:'1', fields:Object.freeze({label:'Nested <Detail>', ...(listColumns ? {rank:'7'} : {})})});
const identity = makeIdentity({actor:null, team:null, membership:null});
const formBindings = await createSourceFormBindings(new Uint8Array(32).fill(93), 'view-reuse-fixture');
const columns = Object.entries(generated.appDefinition.models['ViewReuse.Card'].fields)
  .map(([field, declaration]) => ({field, label:field, type:declaration.type}));
const attributes = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
const decodeAttribute = value => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
async function render(preferredLocale, {url='https://example.test/views', hasDetails=true, available=true, selected=false, protection=true, validVersion=true, missingListColumn=false, missingListProjection=false, formCalls}={}) {
  const queries = [];
  const context = buildPresentationContext({
    request:new Request(url, {headers:{'Accept-Language':preferredLocale}}),
    pathname:'/views', isPartial:true, appDefaultLocale:'es', csrfToken:'', principal:identity,
    catalog, ...(protection ? {formBindings} : {}), appId:'ViewReuse', sessionToken:'view-reuse-session', clock:{nowMs:()=>FIXED_NOW},
    query:async (invocation, model, args) => {
      assert.equal(invocation, identity, 'collection query preserves admitted invocation identity');
      assert.equal(args.page, true, 'bare marker requests the installed collection page contract');
      assert.match(args.occurrence, /^can-collection-f\d+-s\d+-/,
        'paged query receives its compiler-owned source occurrence');
      queries.push({model, args});
      if (model === 'ViewReuse.Card') {
        assert.equal(args.parent, undefined);
        const projected = validVersion ? card : {id:card.id, fields:card.fields};
        return {rows:available?[projected]:[], columns};
      }
      assert.equal(model, 'ViewReuse.Detail', 'no extra model or hidden-field refetch');
      assert.equal(args.parent.id, card.id, 'nested query uses the supplied outer row identity');
      const firstDetail = queries.filter(item=>item.model === 'ViewReuse.Detail').length === 1;
      const selectedDetail = missingListProjection && firstDetail ? {...detail, fields:{label:detail.fields.label}} : detail;
      const detailColumns = listColumns ? [
        {field:'label', label:'Detail label', type:'text'},
        ...(!missingListColumn || !firstDetail ? [{field:'rank', label:'Detail rank', type:'int'}] : []),
      ] : [];
      return {rows:hasDetails?[selectedDetail]:[], columns:detailColumns};
    },
  });
  const renderingContext = formCalls === undefined ? context : {...context,
    prepareForm:request=>{formCalls.push(request.operation);return context.prepareForm(request);},
  };
  const bindings = await page.admit(renderingContext);
  if (agendaPreference) {
    assert.equal(bindings.preferences.ViewReuse.appointment_state, null, 'original nullable enum initial preference admits its implicit null');
    assert.equal(bindings.preferences.ViewReuse.explicit, 'confirmed', 'authored enum default remains unchanged');
  }
  const html = await page.render(renderingContext, bindings);
  if (!selected) {
    assert.deepEqual(queries.map(item => item.model), ['ViewReuse.Card'], 'absent/stale/revoked selection never queries details');
    assert.ok(!html.includes('<form') && !html.includes('role="tablist"'), 'unselected rows never render view controls');
    assert.ok(!html.includes('Nested &lt;Detail&gt;'));
    return {context, queries, html};
  }
  assert.deepEqual(queries.map(item => item.model), ['ViewReuse.Card', 'ViewReuse.Detail', 'ViewReuse.Detail']);
  if (!protection || !validVersion) {
    assert.ok(!html.includes('action="/api/operations/ViewReuse.Card.update"'));
    assert.ok(!html.includes('action="/api/operations/ViewReuse.Detail.update"'));
    assert.ok(!html.includes('action="/api/operations/ViewReuse.bind_card"'));
    assert.ok(!html.includes('name="form_binding"'), 'unavailable protected forms cannot publish a seal');
    assert.equal(html.split(`action="/api/operations/${unboundOperation}"`).length - 1, 2,
      'unbound forms remain available when protected forms refuse');
    return {context, queries, html};
  }
  assert.equal(new Set(queries.map(item => item.args.occurrence)).size, 3,
    'table and the two paged list expansions retain distinct occurrences');
  const oneUse=['Outer &lt;Card&gt;', 'Outer &lt;Card&gt;',
    ...(hasDetails?(listColumns?['Nested &lt;Detail&gt;', 'Nested &lt;Detail&gt;']:['Nested &lt;Detail&gt;']):[]),'Outer &lt;Card&gt;', 'Outer &lt;Card&gt;'];
  assert.deepEqual(html.replace(/<[^>]*>/g, '').match(/Outer &lt;Card&gt;|Nested &lt;Detail&gt;/g), ['Outer &lt;Card&gt;',...oneUse,...oneUse],
    'each expansion shadows the nested row and restores its own outer row afterward');
  assert.ok(!html.includes('Outer <Card>') && !html.includes('Nested <Detail>'), 'projection text is escaped');
  if (agendaPreference) {
    const disclosures = [...html.matchAll(/<details\b[^>]*>/g)];
    assert.equal(disclosures.length, 1);
    assert.ok(disclosures.every(match=>!match[0].includes(' open')), 'null initial preference reaches its checked presentation expression as null');
  }
  if (listColumns && hasDetails) {
    const selected = [...html.matchAll(/<dl>[\s\S]*?<\/dl>/g)].map(match=>match[0]);
    assert.equal(selected.length, 2, 'each nested list expansion renders its selected columns once');
    for (const columns of selected) {
      assert.ok(columns.indexOf('Detail rank') < columns.indexOf('Detail label'), 'authored selection preserves column order');
      assert.match(columns, /<dd>[^]*7[^]*<\/dd>/);
      assert.ok(columns.includes('Nested &lt;Detail&gt;'), 'authorized field rendering is escaped');
    }
  }
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
  assert.equal(forms.length, hasDetails ? 10 : 6, 'each show renders its actual unbound, bound action and row edit forms');
  const operationForms = operation => forms.filter(form => attributes(form.split('>')[0]).action === '/api/operations/'+operation);
  const unbound = operationForms(unboundOperation);
  assert.equal(unbound.length, 2);
  const inputIds = unbound.map(form => {
    const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map(match => attributes(match[0]));
    const note = inputs.filter(input => input.name === ui.fieldInputName(unboundMode, 'note'));
    assert.equal(note.length, 1, 'authored input note reaches the installed form preparer/factory once');
    assert.ok(note[0].id?.startsWith('operation-form-source-'), 'form uses a checked source occurrence prefix');
    const labels = [...form.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)];
    const label = labels.find(match => attributes(match[0].split('>')[0])['for'] === note[0].id);
    assert.ok(label, 'declaration label targets its actual input');
    assert.ok(label[0].includes('Authored note'), 'native catalog preserves the parameter declaration label');
    if (dateControl) {
      const metadata = JSON.parse(decodeAttribute(attributes(form.split('>')[0])['data-can-generated-form']));
      assert.equal(metadata.derived.operation, 'ViewReuse.Holiday.create');
      assert.deepEqual(metadata.renderedInputs, ['note', 'day'], 'authored input and calendar keep their complete owning order');
      const dates = inputs.filter(input => input.name === ui.fieldInputName('create', 'day'));
      assert.equal(dates.length, 1, 'authored calendar moves the date input without duplication');
      assert.equal(dates[0].type, 'date');
      assert.equal(dates[0].value, '2030-01-02', 'date declaration default reaches the native control unchanged');
      assert.ok(dates[0].id.startsWith('operation-form-source-'));
      assert.ok(form.includes(`for="${dates[0].id}"`), 'date label targets its actual native input');
      assert.ok(form.includes('Holiday day'));
      assert.ok(html.indexOf(`id="${note[0].id}"`) < html.indexOf(`id="${dates[0].id}"`));
      return [note[0].id, dates[0].id];
    }
    return note[0].id;
  });
  assert.equal(new Set(inputIds.flat()).size, dateControl ? 4 : 2, 'same-operation shows have distinct form controls');
  const editIdentities = {};
  const editControlIds = {};
  for (const [operation, row, expectedCount, fields] of [
    ['ViewReuse.Card.update', card, 2, editBody ? [['flag', 'Card flag'], ['title', 'Card title']] : [['title', 'Card title'], ['flag', 'Card flag']]],
    ['ViewReuse.Detail.update', detail, hasDetails ? 2 : 0, [['label', 'Detail label']]],
  ]) {
    const edits = operationForms(operation);
    assert.equal(edits.length, expectedCount, 'one installed edit form per checked row expansion');
    editControlIds[operation] = [];
    editIdentities[operation] = edits.map(form => {
      const attrs = attributes(form.split('>')[0]);
      const metadata = JSON.parse(decodeAttribute(attrs['data-can-generated-form']));
      assert.equal(metadata.derived.operation, operation);
      assert.deepEqual(metadata.renderedInputs, fields.map(([field]) => field),
        'edit contains exactly the owning writable inputs, authored first then eligible remainder');
      const inputs = [...form.matchAll(/<input\b[^>]*>/g)].map(match => ({tag:match[0], ...attributes(match[0])}));
      assert.deepEqual(inputs.filter(input => fields.some(([field]) => input.name === ui.fieldInputName('update', field)))
        .map(input => input.name), fields.map(([field]) => ui.fieldInputName('update', field)));
      for (const excluded of ['internal', 'at']) {
        assert.ok(!inputs.some(input => input.name === ui.fieldInputName('update', excluded)),
          'nonallowed and server fields remain absent from the automatic edit');
      }
      const tokens = inputs.filter(input => input.name === 'form_binding');
      assert.equal(tokens.length, 1);
      const claims = JSON.parse(Buffer.from(decodeAttribute(tokens[0].value).split('.')[0], 'base64url').toString('utf8'));
      assert.deepEqual(claims.bound, {record:{id:row.id, version:row.version}},
        'edit seal contains only the current projected row identity and version');
      for (const [field, caption] of fields) {
        const control = inputs.filter(input => input.name === ui.fieldInputName('update', field));
        assert.equal(control.length, 1);
        assert.ok(control[0].id.startsWith('operation-form-source-'));
        const label = [...form.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)]
          .find(match => attributes(match[0].split('>')[0])['for'] === control[0].id);
        assert.ok(label?.[0].includes(caption), 'edit control retains the owning field caption');
        if (field === 'flag') {
          assert.equal(control[0].type, 'checkbox');
          assert.match(control[0].tag, /\schecked(?:\s|=|>)/, 'boolean edit control starts with the authorized projection value');
        } else {
          assert.equal(decodeAttribute(control[0].value), row.fields[field],
            'edit control starts with the authorized projection value');
        }
        editControlIds[operation].push(control[0].id);
      }
      return {binding:metadata.bindingIdentity, draft:metadata.draftIdentity};
    });
    assert.equal(new Set(editIdentities[operation].map(item => item.binding)).size, expectedCount);
    assert.equal(new Set(editIdentities[operation].map(item => item.draft)).size, expectedCount);
    assert.equal(new Set(editControlIds[operation]).size, expectedCount * fields.length);
  }
  const boundIdentities = {};
  const scenarioControlIds = [];
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
      if (scenarioCheckbox && operation === 'ViewReuse.bind_card') {
        assert.deepEqual(metadata.renderedInputs, ['attend', 'note'], 'authored scenario checkbox precedes the complete unbound remainder');
        const checkbox = inputs.filter(input=>input.name === ui.fieldInputName('scenario', 'attend'));
        const note = inputs.filter(input=>input.name === ui.fieldInputName('scenario', 'note'));
        assert.equal(checkbox.length, 1, 'selected signature-owned bool renders once');
        assert.equal(checkbox[0].type, 'checkbox');
        assert.equal(note.length, 1, 'unplaced eligible scenario input remains available');
        assert.equal(note[0].value, 'Kept', 'ordinary parameter default is retained by the generated remainder');
        scenarioControlIds.push(checkbox[0].id, note[0].id);
        assert.ok(form.includes('Attendance'), 'checked parameter label reaches the actual control');
        assert.ok(form.includes(`for="${checkbox[0].id}"`), 'scenario declaration label targets its own checkbox');
        assert.ok(form.indexOf(`id="${checkbox[0].id}"`) < form.indexOf(`id="${note[0].id}"`));
        assert.ok(!inputs.some(input=>input.name === ui.fieldInputName('scenario', 'visit')), 'bound own row never becomes editable');
      }
      if (scenarioCheckbox && operation === 'ViewReuse.bind_card') {
        assert.match(form, /<button\b[^>]*\btype="submit"/, 'explicit scenario form keeps its implicit canonical submit control');
      } else {
        assert.ok(form.includes(caption), 'bound action keeps its declaration label');
      }
      return {binding:metadata.bindingIdentity, draft:metadata.draftIdentity};
    });
    assert.equal(new Set(boundIdentities[operation].map(item => item.binding)).size, expectedCount);
    assert.equal(new Set(boundIdentities[operation].map(item => item.draft)).size, expectedCount);
  }
  if (scenarioCheckbox) assert.equal(new Set(scenarioControlIds).size, 4, 'two scenario forms retain distinct checkbox and remainder control identities');
  return {context, radios, panels, queries, html, inputIds, boundIdentities, editIdentities, editControlIds, scenarioControlIds};
}
const unselected = await render('es');
assert.equal(unselected.context.collectionSelections.size, 0);
const selectionUrls = [...unselected.html.matchAll(/<a\b[^>]*>/g)].map(match => attributes(match[0]).href)
  .filter(Boolean).map(href => new URL(decodeAttribute(href), 'https://example.test/views'));
const selectedUrl = selectionUrls.find(url => [...url.searchParams].some(([key,value]) => key.startsWith('can-row:') && value===card.id));
assert.ok(selectedUrl, 'actual native split table emits the row selection URL');
assert.equal(selectedUrl.pathname, '/views');
const source = await render('es', {url:selectedUrl.href, selected:true});
assert.equal(source.queries[0].args.occurrence, unselected.queries[0].args.occurrence,
  'selection preserves the paged table occurrence');
assert.deepEqual([...source.context.collectionSelections.values()], [card.id], 'actual Interfaces parses the native selection link');
assert.equal(ui.resolveMessage(page.title, {preferredLocales:source.context.preferredLocales,
  appDefaultLocale:source.context.appDefaultLocale}).locale, 'fr', 'unavailable viewer locale falls back to checked source');
const dutch = await render('nl', {url:selectedUrl.href, selected:true});
assert.deepEqual(dutch.queries.map(item=>item.args.occurrence), source.queries.map(item=>item.args.occurrence),
  'locale rerender preserves paged collection occurrences');
assert.deepEqual(dutch.radios.map(item => item.id), source.radios.map(item => item.id), 'rerender preserves each use identity');
assert.deepEqual(dutch.panels.map(item => item.id), source.panels.map(item => item.id));
assert.deepEqual(dutch.inputIds, source.inputIds, 'locale rerender preserves each show/row form control prefix');
assert.deepEqual(dutch.boundIdentities, source.boundIdentities, 'locale rerender preserves owning signed binding/draft comparisons');
assert.deepEqual(dutch.scenarioControlIds, source.scenarioControlIds, 'locale rerender preserves selected scenario control identities');
assert.deepEqual(dutch.editIdentities, source.editIdentities);
assert.deepEqual(dutch.editControlIds, source.editControlIds, 'locale rerender preserves row edit control identities');
const empty=await render('es', {url:selectedUrl.href, selected:true, hasDetails:false});
assert.deepEqual(empty.queries.map(item=>item.args.occurrence), source.queries.map(item=>item.args.occurrence),
  'fresh nested query preserves paged collection occurrences');
assert.equal(empty.html.split('No records.').length-1,2,'omitted empty props reach the released shared UI default');
assert.deepEqual(empty.radios.map(item=>item.id),source.radios.map(item=>item.id));
assert.deepEqual(empty.inputIds, source.inputIds, 'nested requery preserves each show/row form control prefix');
assert.deepEqual(empty.boundIdentities['ViewReuse.bind_card'], source.boundIdentities['ViewReuse.bind_card'],
  'nested requery preserves the outer row action occurrence');
assert.deepEqual(empty.editIdentities['ViewReuse.Card.update'], source.editIdentities['ViewReuse.Card.update']);
assert.deepEqual(empty.editControlIds['ViewReuse.Card.update'], source.editControlIds['ViewReuse.Card.update'],
  'Card edit after nested shadowing retains the restored outer row across requery');
const unknownUrl = new URL(selectedUrl);
const selectionKey = [...unknownUrl.searchParams.keys()].find(key => key.startsWith('can-row:'));
unknownUrl.searchParams.set(selectionKey, uuidv7(FIXED_NOW, 99));
await render('es', {url:unknownUrl.href});
await render('es', {url:selectedUrl.href, available:false});
await render('es', {url:selectedUrl.href, selected:true, hasDetails:false, protection:false});
await render('es', {url:selectedUrl.href, selected:true, hasDetails:false, validVersion:false});
if (listColumns) {
  for (const [missing, refusal] of [
    [{missingListColumn:true}, /missing columns: rank/],
    [{missingListProjection:true}, /missing projected fields: rank/],
  ]) {
    const formCalls = [];
    await assert.rejects(render('es', {url:selectedUrl.href, selected:true, ...missing, formCalls}), refusal);
    assert.deepEqual(formCalls, ['ViewReuse.bind_card'], 'first rejected list stops later row/edit/unbound form preparation');
  }
}
console.log(JSON.stringify({consumer:'real CLI artifact → public loader/assembler → installed UI page admission/render',
  uses:2, sourceLocale:'fr', rerenderLocale:'nl', nestedRowRestored:true, distinctTabControls:true, nativeBooleanStatus:true, sharedEmptyDefault:true,
  nativeUnboundForms:true, distinctStableFormControls:true, declarationInputLabel:true,
  signedImplicitAndNestedActionBindings:true,
  nativeSplitSelection:true, absentUnknownRevokedDetailSuppressed:true,
  nativePagedTableAndLists:true, stablePagedOccurrences:true,
  nativeProjectedRowEdits:true, distinctStableEditControls:true, identityOnlyEditSeals:true,
  ...(editBody ? {nativeAuthoredCheckboxFirst:true, completeWritableRemainder:true} : {}),
  ...(listColumns ? {nativeOrderedAuthorizedListColumns:true, missingColumnsAndProjectionRefuse:true} : {}),
  ...(scenarioCheckbox ? {nativeSelectedScenarioCheckbox:true, protectedBoundRow:true, completeScenarioRemainder:true} : {}),
  ...(agendaPreference ? {nativeImplicitNullableEnumDefault:true, authoredEnumDefaultPreserved:true} : {}),
  queriesPerRender:source.queries.map(item => item.model)}));
