/** Declaration-labelled native owner-rule component; original compiler source
 * and reverse-dependency qualification are owned by the generated consumer. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CompileArtifact, ModelName } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, makeBatch, makeRow, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';

const APP = 'OwnerReferences', CHECKED = `${APP}.Checked` as ModelName, CONTACT = `${APP}.Contact` as ModelName,
  CUSTOMER = `${APP}.Customer` as ModelName, MODULE = 'owner-references.mjs', SOURCE = 'owner-references-component.can';
function artifact(queries = false): CompileArtifact {
  const source = '## Declaration-labelled owner rule reference component.';
  const operations: NonNullable<CompileArtifact['operations']> = [{ name: `${CHECKED}.create`, kind: 'create', description: '', inputs: { fields: [
    { name: 'contact', field: { kind: 'ref', model: CONTACT, requireVersion: true }, required: true },
    { name: 'accept', field: { kind: 'boolean' }, valueType: 'bool', required: true },
    { name: 'mode', field: { kind: 'string' }, valueType: 'text', required: true },
  ] } }];
  const policy = { operations: { [`${CHECKED}.create`]: { by: ['members'] } }, models: {
    [CHECKED]: { read: ['read'], invariants: ['Checked.require.1'] }, [CONTACT]: { read: ['read'] }, [CUSTOMER]: { read: ['read'] },
  } };
  const declarations = { [CHECKED]: { fields: { contact: { type: CONTACT }, accept: { type: 'bool' }, mode: { type: 'text' } }, invariants: ['Checked.require.1'] },
    [CONTACT]: { fields: { title: { type: 'text' } } }, [CUSTOMER]: { fields: { active: { type: 'bool' } } } };
  const js = `import {nativeReadReference,records} from '@canlang/stdlib';
let trace=[],held,escaped;
export const Checked_create='${CHECKED}.create';
export const inspect=()=>trace;
export const escape=()=>escaped();
async function predicate(c,row){
 trace=[];
 if(row.mode.startsWith('query-')){
   if(row.mode==='query-domain'){try{await records(c,'${CHECKED}');}catch{}return true;}
   if(row.mode.startsWith('query-parent')){
     const contact=await nativeReadReference(c,row.contact);
     const parent=row.mode==='query-parent-copy'?{...contact.parent}:row.mode==='query-parent-wrong'?row.contact:contact.parent;
     if(row.mode!=='query-parent'){try{await records(c,'${CONTACT}',{parent});}catch{}return true;}
     const children=await records(c,'${CONTACT}',{parent});
     if(children.length!==1||children[0].id!==contact.id)throw new Error('contained owner query escaped its parent');
     return true;
   }
   if(row.mode==='query-shape'){try{await records(c,'${CUSTOMER}',{limit:1});}catch{}return true;}
   if(row.mode==='query-bool'){try{await records(c,'${CUSTOMER}',{where:()=>1});}catch{}return true;}
   if(row.mode==='query-throw'){await records(c,'${CUSTOMER}',{where:()=>{throw new Error('original query predicate failed');}});return true;}
   const candidates=await records(c,'${CUSTOMER}',{where:async candidate=>{trace.push('where:'+candidate.id);return true;}});
   escaped=()=>records(c,'${CUSTOMER}');
   for(const candidate of candidates){trace.push('predicate:'+candidate.id);if(candidate.active)return true;}return false;
 }
 if(!row.accept)return true;
 if(row.mode==='direct-nested'){return row.contact.title==='Original contact';}
 const read=async(value,label)=>{trace.push(label);return nativeReadReference(c,value);};
 if(row.mode==='copy'){try{await read({...row.contact},'copy');}catch{}return true;}
 if(row.mode==='root-copy'){try{await read({...row},'root-copy');}catch{}return true;}
 if(row.mode==='foreign'){try{await read(held,'foreign');}catch{}return true;}
 if(row.mode==='store'){try{await c.store.load('${CONTACT}',row.contact.id);}catch{}return true;}
 if(await read(row,'root')!==row)throw new Error('root view changed');
 const contact=await read(row.contact,'contact');
 if(await read(row.contact,'cached-contact')!==contact)throw new Error('target cache changed');
 const parent=await read(contact.parent,'parent');
 held=row.contact;escaped=()=>nativeReadReference(c,row.contact);
 return parent.active;
}
export const appDefinition={id:'${APP}',policy:${JSON.stringify(policy)},models:${JSON.stringify(declarations)}};
export function canApp(){return {policy:${JSON.stringify(policy)},operations:${JSON.stringify(operations)},
 Checked:{create:async()=>{throw new Error('canonical CRUD must own creation');}},read:{read:()=>true},
 invariants:{'Checked.require.1':predicate},modelPolicyBindings:[{id:'${APP}.Checked.require.1',module:'${MODULE}',ownerPackage:'${APP}',model:'${CHECKED}',kind:'invariant',evaluate:predicate${queries ? `,queryModels:['${CUSTOMER}','${CONTACT}']` : ''}}${queries ? `,{id:'${APP}.Checked.require.1.root',module:'${MODULE}',ownerPackage:'${APP}',model:'${CHECKED}',kind:'dependency',select:()=>[]},{id:'${APP}.Checked.require.1.child',module:'${MODULE}',ownerPackage:'${APP}',model:'${CHECKED}',kind:'dependency',select:()=>[]}` : ''}]};}`;
  return { artifact_version: 1, language_version: 'declaration-labelled', tool_version: 'consumer-component',
    sources: [{ path: SOURCE, sha256: createHash('sha256').update(source).digest('hex') }],
    modules: [{ path: MODULE, js, map: { version: 3, file: MODULE, sources: [SOURCE], sourcesContent: [source], names: [], mappings: '' } }],
    operations, callables: [{ id: `${CHECKED}.create`, kind: 'operation', module: MODULE, export: 'Checked_create', member: ['Checked', 'create'] }], pages: [], tests: [], models: [
      { name: CHECKED, deleteMode: 'archive', fields: [
        { name: 'contact', field: { kind: 'ref', model: CONTACT }, required: true, serverOnly: false },
        { name: 'accept', field: { kind: 'boolean' }, valueType: 'bool', required: true, serverOnly: false },
        { name: 'mode', field: { kind: 'string' }, valueType: 'text', required: true, serverOnly: false },
      ] },
      { name: CONTACT, parent: CUSTOMER, deleteMode: 'archive', fields: [
        { name: 'title', field: { kind: 'string' }, valueType: 'text', required: true, serverOnly: false },
      ] },
      { name: CUSTOMER, deleteMode: 'archive', fields: [
        { name: 'active', field: { kind: 'boolean' }, valueType: 'bool', required: true, serverOnly: false },
      ] },
    ], modelPolicies: [{ abi: 'state.owner-model-policies@1', model: CHECKED, ownerPackage: APP, module: MODULE,
      rules: [{ kind: 'invariant', id: `${APP}.Checked.require.1`, dependencies: queries ? [{ id: `${APP}.Checked.require.1.root`, model: CUSTOMER, maxTargets: 1000 }, { id: `${APP}.Checked.require.1.child`, model: CONTACT, maxTargets: 1000 }] : [] }], hooks: [] }],
    requires: [{ capability: 'canlang.builtins', min_version: 2 }, { capability: 'state', min_version: 1 }] };
}

test('native owner rule references stay lazy, issued, cached, sticky and scoped to their actual rule frame', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-rule-references-'));
  try {
    const selected = artifact(), asm = await assembleModules({ artifact: selected, sourcePath: SOURCE }, {
      workDir: directory, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    });
    const module = await importVerifiedAssemblyModule(asm, MODULE, selected) as { inspect(): string[]; escape(): Promise<unknown> };
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({}), user = await identities.createUser({ email: 'owner-references@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = 'owner-rule-reference-component';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3600000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const { store, probe } = createTestMemoryStorage();
    const seededCustomer = await seedRow(store, CUSTOMER, { id: uuidv7(FIXED_NOW, 901), data: { active: true } });
    const customer = await store.load(CUSTOMER, seededCustomer.id); assert.ok(customer);
    const contact = { ...makeRow({ id: uuidv7(FIXED_NOW, 902), data: { title: 'Original contact' } }), parent: { model: CUSTOMER, id: customer.id } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: CONTACT, row: contact }] }));
    const invoker = buildInvoker(selected, asm, store, { appId: APP, memberships: identities, now: () => FIXED_NOW });
    let index = 903;
    const create = (mode: string, accept = true) => invoker.invokeMutation({ operation: `${CHECKED}.create`, operation_id: uuidv7(FIXED_NOW, index++),
      inputs: { contact: { id: contact.id, version: String(contact.version) }, accept, mode } }, identity);
    const skipped = await create('normal', false); assert.ok('result' in skipped, JSON.stringify(skipped));
    assert.deepEqual(module.inspect(), [], 'a skipped branch performs no reference read');
    const normal = await create('normal'); assert.ok('result' in normal, JSON.stringify(normal));
    assert.deepEqual(module.inspect(), ['root', 'contact', 'cached-contact', 'parent']);
    await assert.rejects(module.escape(), /closed/);
    const rowsBefore = await store.query({ model: CHECKED, authority: 'owner' }), historyBefore = probe.historyFor(CONTACT, contact.id);
    for (const mode of ['copy', 'root-copy', 'foreign', 'store']) {
      const outcome = await create(mode); assert.ok('error' in outcome, JSON.stringify(outcome));
      assert.equal(outcome.error.code, 'validation', mode);
      assert.deepEqual(await store.query({ model: CHECKED, authority: 'owner' }), rowsBefore, mode);
      assert.deepEqual(probe.historyFor(CONTACT, contact.id), historyBefore, mode);
      assert.deepEqual(probe.outboxAll(), []); assert.deepEqual(await store.schedulesDue(Number.MAX_SAFE_INTEGER, 100), []);
    }
    assert.deepEqual(await store.load(CUSTOMER, customer.id), customer);
    assert.deepEqual((await store.load(CONTACT, contact.id))!.data, contact.data);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('native owner rule rows hydrate nested references before predicate member reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-rule-nested-'));
  try {
    const selected = artifact(), asm = await assembleModules({ artifact: selected, sourcePath: SOURCE }, {
      workDir: directory, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    });
    const module = await importVerifiedAssemblyModule(asm, MODULE, selected) as { inspect(): string[] };
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({}), user = await identities.createUser({ email: 'owner-nested@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = 'owner-rule-nested-component';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3600000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const { store } = createTestMemoryStorage();
    const seededCustomer = await seedRow(store, CUSTOMER, { id: uuidv7(FIXED_NOW, 901), data: { active: true } });
    const customer = await store.load(CUSTOMER, seededCustomer.id); assert.ok(customer);
    const contact = { ...makeRow({ id: uuidv7(FIXED_NOW, 902), data: { title: 'Original contact' } }), parent: { model: CUSTOMER, id: customer.id } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: CONTACT, row: contact }] }));
    const invoker = buildInvoker(selected, asm, store, { appId: APP, memberships: identities, now: () => FIXED_NOW });
    const direct = await invoker.invokeMutation({ operation: `${CHECKED}.create`, operation_id: uuidv7(FIXED_NOW, 903),
      inputs: { contact: { id: contact.id, version: String(contact.version) }, accept: true, mode: 'direct-nested' } }, identity);
    assert.ok('result' in direct, JSON.stringify(direct));
    assert.deepEqual(module.inspect(), [], 'a direct nested member read performs no reference read');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('native owner invariant queries use only checked final domains and preserve ordering, lazy predicates and frame refusal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-owner-rule-queries-'));
  try {
    const selected = artifact(true), asm = await assembleModules({ artifact: selected, sourcePath: SOURCE }, {
      workDir: directory, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    });
    const module = await importVerifiedAssemblyModule(asm, MODULE, selected) as { inspect(): string[]; escape(): Promise<unknown> };
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({}), user = await identities.createUser({ email: 'owner-query@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = 'owner-query-component';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3600000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const { store, probe } = createTestMemoryStorage();
    const first = await seedRow(store, CUSTOMER, { id: uuidv7(FIXED_NOW, 801), data: { active: true } });
    const second = await seedRow(store, CUSTOMER, { id: uuidv7(FIXED_NOW, 802), data: { active: false } });
    const archived = { ...makeRow({ id: uuidv7(FIXED_NOW, 803), data: { active: true } }), archivedAt: FIXED_NOW };
    const contact = { ...makeRow({ id: uuidv7(FIXED_NOW, 804), data: { title: 'Original contact' } }), parent: { model: CUSTOMER, id: first.id } };
    await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: CUSTOMER, row: archived }, { kind: 'insert', model: CONTACT, row: contact }] }));
    const invoker = buildInvoker(selected, asm, store, { appId: APP, memberships: identities, now: () => FIXED_NOW });
    let sequence = 805;
    const create = (mode: string) => invoker.invokeMutation({ operation: `${CHECKED}.create`, operation_id: uuidv7(FIXED_NOW, sequence++),
      inputs: { contact: { id: contact.id, version: String(contact.version) }, accept: true, mode } }, identity);
    const normal = await create('query-normal'); assert.ok('result' in normal, JSON.stringify(normal));
    assert.deepEqual(module.inspect(), [`where:${first.id}`, `where:${second.id}`, `predicate:${first.id}`]);
    await assert.rejects(module.escape(), /closed/);
    const contained = await create('query-parent'); assert.ok('result' in contained, JSON.stringify(contained));
    const before = await store.query({ model: CHECKED, authority: 'owner' });
    for (const mode of ['query-domain', 'query-shape', 'query-bool', 'query-parent-copy', 'query-parent-wrong']) {
      const refused = await create(mode); assert.ok('error' in refused, JSON.stringify(refused));
      assert.equal(refused.error.code, 'validation', mode);
      assert.deepEqual(await store.query({ model: CHECKED, authority: 'owner' }), before);
      assert.deepEqual(probe.outboxAll(), []);
    }
    const authored = await create('query-throw'); assert.ok('error' in authored, JSON.stringify(authored));
    assert.equal(authored.error.code, 'rule_failed');
    assert.equal(authored.error.message, 'original query predicate failed');
    assert.deepEqual(await store.query({ model: CHECKED, authority: 'owner' }), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
