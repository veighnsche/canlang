import assert from 'node:assert/strict';
import {existsSync, writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHttpHandler} from '@canlang/interfaces';
import {createTestDeps, testRequest} from '@canlang/interfaces/testing';
import {deriveCsrfToken} from '@canlang/identity';

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
const source = `app NominalPreferenceApp uses=[Reporting]
package Expenses
 Given
  export Expense {status:enum(draft,submitted,approved)=draft label={text="Status"@{nl="Toestand"},values={draft="Draft"@{nl="Concept"},submitted="Submitted"@{nl="Ingediend"},approved="Approved"@{nl="Goedgekeurd"}}}}
  export Bridge {status:Expense.status=approved label={text="Bridge status"@{nl="Brugtoestand"},values={draft="Bridge draft"@{nl="Brugconcept"},approved="Bridge approved"@{nl="Bruggoedkeuring"}}}}
  policy Expense read=public
  policy Bridge read=public
 When
 Then
package Reporting
 use Expenses {Expense,Bridge}
 Given
 When
 Then
  preferences {status:Bridge.status=submitted label={values={approved="Accepted status"@{nl="Geaccepteerde toestand"}}},labelled:Expense.status=approved label={text="Review"@{nl="Beoordeling"},values={approved="Accepted"@{nl="Geaccepteerd"}}},selection:Bridge.status=draft label={values={approved="Accepted selection"@{nl="Geaccepteerde selectie"}}}}
  page /reports title="Reports"
   tabs ((preferences.status))
   tabs (preferences.labelled)
   tabs preferences.selection
`;
const input = resolve(scratch, 'Reporting.can');
writeFileSync(input, source);
const compiled = spawnSync(can, ['compile','--format=json','--catalog',resolve(root,'packages/values/dist/catalog.json'),input], {encoding:'utf8',timeout:15000});
assert.equal(compiled.status, 0, compiled.stdout+'\n'+compiled.stderr);
const artifact = resolve(scratch, 'Reporting.json');
writeFileSync(artifact, compiled.stdout);
const assembly = await assembleModules(loadArtifactFile(artifact), {
  workDir:resolve(scratch,'modules'), stdlibUrl:import.meta.resolve('@canlang/stdlib'), uiUrl:import.meta.resolve('@canlang/ui'),
});
const generated = await import(assembly.entryUrl);
const pages = generated.appDefinition.pages;
assert.equal(pages.length, 1);
assert.equal(pages[0].owner, 'Reporting');
assert.deepEqual(pages[0].preferenceFields, [
  {name:'status',options:['draft','submitted','approved'],defaultValue:'submitted'},
  {name:'labelled',options:['draft','submitted','approved'],defaultValue:'approved'},
  {name:'selection',options:['draft','submitted','approved'],defaultValue:'draft'},
]);
const {deps, identity, logger} = await createTestDeps({descriptors:pages});
const rows = new Map();
const keyOf = ({appId,actorUserId,teamId,owner,field}) => JSON.stringify({appId,actorUserId,teamId,owner,field});
const preferences = {
  async read(key) { return rows.get(keyOf(key)) ?? null; },
  async save(input) {
    const key = keyOf(input);
    if ((rows.get(key)?.version ?? '0') !== input.expectedVersion) return false;
    rows.set(key, {value:input.value,version:String(BigInt(input.expectedVersion)+1n)});
    return true;
  },
};
const unexpected = async () => { throw new Error('unrelated route invoked'); };
const handler = createHttpHandler({...deps,preferences}, {
  operations:unexpected,auth:unexpected,uploads:unexpected,ingress:unexpected,oauth:unexpected,
});
const path = '/reports?team='+identity.teamId;
const get = () => handler(testRequest(path,{cookie:identity.cookie}));
const checked = (html,field,value) => (html.match(/<input\b[^>]*>/g) ?? []).some(input =>
  input.includes(`name="${field}"`) && input.includes(`value="${value}"`) && /\schecked(?:=|\s|>)/.test(input));
const first = await get();
assert.equal(first.status,200,JSON.stringify(logger.calls));
const html = await first.text();
assert.match(html,/name="status"/);
assert.match(html,/name="labelled"/);
assert.ok(checked(html,'status','submitted'));
assert.match(html,/name="_version" value="0"/);
const forms = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
const preferenceForm = name => forms.find(form => form.includes(`name="${name}"`));
const statusForm = preferenceForm('status');
assert.ok(statusForm,'values-only receiving label has its real preference form');
for (const label of ['Bridge status','Bridge draft','Submitted','Accepted status']) assert.ok(statusForm.includes(label),label);
assert.ok(!statusForm.includes('<legend>Status</legend>'),'immediate reuse text replaces ultimate enum text');
assert.ok(!statusForm.includes('Bridge approved'),'receiving case overrides the immediate source');
assert.ok(!statusForm.includes('Approved'),'receiving case override replaces the inherited approved caption');
const labelledForm = preferenceForm('labelled');
assert.ok(labelledForm,'whole receiving label has its real preference form');
for (const label of ['Review','Draft','Submitted','Accepted']) assert.ok(labelledForm.includes(label),label);
assert.ok(!labelledForm.includes('<legend>Status</legend>'),'explicit text replaces the inherited field caption');
const selectionForm = preferenceForm('selection');
assert.ok(selectionForm,'renamed values-only receiving label has its real preference form');
for (const label of ['Bridge draft','Submitted','Accepted selection']) assert.ok(selectionForm.includes(label),label);
assert.ok(!selectionForm.includes('<legend>'),'renamed field does not inherit the nominal text caption');
assert.ok(!selectionForm.includes('Status'));
assert.ok(!selectionForm.includes('Bridge status'),'renamed receiving field does not inherit immediate text');
assert.ok(!selectionForm.includes('Bridge approved'),'renamed receiving case override replaces immediate case');
assert.ok(!selectionForm.includes('Approved'));
assert.ok(checked(html,'selection','draft'),'renamed field retains its receiving default');
const dutch = await handler(testRequest(path,{cookie:identity.cookie,headers:{'accept-language':'nl'}}));
assert.equal(dutch.status,200,JSON.stringify(logger.calls));
const translated = await dutch.text();
const translatedForms = translated.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [];
const translatedStatus = translatedForms.find(form => form.includes('name="status"'));
const translatedLabelled = translatedForms.find(form => form.includes('name="labelled"'));
const translatedSelection = translatedForms.find(form => form.includes('name="selection"'));
for (const label of ['Brugtoestand','Brugconcept','Ingediend','Geaccepteerde toestand']) assert.ok(translatedStatus?.includes(label),label);
for (const label of ['Beoordeling','Concept','Ingediend','Geaccepteerd']) assert.ok(translatedLabelled?.includes(label),label);
for (const label of ['Brugconcept','Ingediend','Geaccepteerde selectie']) assert.ok(translatedSelection?.includes(label),label);
assert.ok(!translatedSelection.includes('<legend>'),'renamed translated field has no inherited legend');
assert.ok(!translatedSelection.includes('Toestand'));
assert.ok(!translatedSelection.includes('Brugtoestand'));
assert.ok(!translatedSelection.includes('Bruggoedkeuring'));
assert.ok(!translatedSelection.includes('Goedgekeurd'));
assert.ok(checked(translated,'selection','draft'));
assert.ok(!translatedStatus.includes('<legend>Toestand</legend>'),'immediate translated text replaces ultimate enum text');
assert.ok(!translatedStatus.includes('Bruggoedkeuring'),'receiving translated case overrides immediate source');
assert.ok(!translatedStatus.includes('Goedgekeurd'),'translated receiving override replaces the translated nominal case');
assert.ok(checked(translated,'status','submitted'),'locale changes preserve the current enum case');
assert.equal(rows.size,0,'presentation requests do not write preferences');
const token = await deriveCsrfToken(identity.sessionToken);
const post = (value,version,csrf=token) => handler(testRequest(path, {
  method:'POST',cookie:identity.cookie,headers:{'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({_csrf:csrf,_version:version,status:value}),
}));
assert.equal((await post('approved','0','bad')).status,403);
assert.equal((await post('foreign','0')).status,400);
assert.equal(rows.size,0);
const saved = await post('approved','0');
assert.equal(saved.status,303,JSON.stringify(logger.calls));
assert.equal(saved.headers.get('location'),path);
assert.deepEqual([...rows.entries()], [[keyOf({appId:deps.app.appId,actorUserId:identity.userId,
  teamId:identity.teamId,owner:'Reporting',field:'status'}),{value:'approved',version:'1'}]]);
const current = await get();
assert.equal(current.status,200);
const changed = await current.text();
assert.ok(checked(changed,'status','approved'),'saved status is checked in its own control');
assert.ok(!checked(changed,'status','submitted'),'previous status is no longer checked');
assert.ok(checked(changed,'labelled','approved'),'the other preference retains its default');
assert.match(changed,/name="_version" value="1"/);
assert.equal((await post('draft','0')).status,409);
assert.equal((await handler(testRequest(path))).status,403);
const membership = (await identity.store.listUserMemberships(identity.userId)).find(row=>row.team_id===identity.teamId);
assert.ok(membership);
await identity.store.removeMembership(membership.membership_id);
assert.equal((await get()).status,403);
assert.equal((await post('draft','1')).status,403);
assert.deepEqual([...rows.values()],[{value:'approved',version:'1'}]);
console.log('generated nominal preferences: real UI, receiving owner/default, inherited and overridden labels, saved current/version, CSRF/case/stale/anonymous/revoked refusals');
