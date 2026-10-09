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
  export Expense {status:enum(draft,submitted,approved)=draft label={text="Status",values={draft="Draft",submitted="Submitted",approved="Approved"}}}
  policy Expense read=public
 When
 Then
package Reporting
 use Expenses {Expense}
 Given
 When
 Then
  preferences {status:Expense.status=submitted,labelled:Expense.status=approved label={text="Review",values={approved="Accepted"}}}
  page /reports title="Reports"
   tabs preferences.status
   tabs preferences.labelled
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
for (const label of ['Status','Draft','Submitted','Approved','Review','Accepted']) assert.ok(html.includes(label),label);
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
