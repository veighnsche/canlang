/** Declaration-labelled component: real loader/State admission/native handler;
 * compiler source qualification is owned by the generated consumer. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { CanTypeId, CompileArtifact, ModelName } from '@canlang/contracts';
import { encodeValue } from '@canlang/values';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';

const APP = 'NominalInputs', CUSTOMER = `${APP}.Customer` as ModelName;
const OP = `${APP}.inspect`, MODULE = 'nominal-inputs.mjs', SOURCE = 'nominal-inputs-component.can';
const source = '## Declaration-labelled nested input hydration component.';
const type = (name: string) => name as CanTypeId;
function declaration(): CompileArtifact {
  const operations: NonNullable<CompileArtifact['operations']> = [{ name: OP, kind: 'scenario', description: '',
    inputs: { fields: [
      { name: 'request', field: { kind: 'nominal', name: `${APP}.Request` }, valueType: type(`${APP}.Request`), required: true },
      { name: 'direct', field: { kind: 'ref', model: CUSTOMER, requireVersion: true }, required: true },
      { name: 'customers', field: { kind: 'ref', model: CUSTOMER, requireVersion: true }, array: { required: false }, required: true },
    ] }, result: { type: 'text' } }];
  const policy = { operations: { [OP]: { by: ['members'] } }, models: { [CUSTOMER]: { read: ['customer-read'] } } };
  const js = `let captured,executions=0;
export const inspect=()=>({captured,executions});
export const appDefinition={id:'${APP}',policy:${JSON.stringify(policy)},
 operations:{'${OP}':{handler:'${OP}',by:'members',inputs:{request:{type:'${APP}.Request'},direct:{type:'${CUSTOMER}'},customers:{type:'${CUSTOMER}',array:true}},result:{type:'text'}}},
 models:{'${CUSTOMER}':{fields:{name:{type:'text'}},readGrants:[{rule:'customer-read',by:['members'],fields:['name']}]}},
 contracts:{'${APP}.Contact':{fields:{customer:{type:'${CUSTOMER}'}}},'${APP}.Request':{fields:{customer:{type:'${CUSTOMER}'},alternate:{type:'${CUSTOMER}'},contacts:{type:'${APP}.Contact',array:true},count:{type:'int'},at:{type:'datetime'}}}}};
export function canApp(){return {policy:${JSON.stringify(policy)},operations:${JSON.stringify(operations)},read:{'customer-read':()=>true},
 '${APP}':{inspect:async(c,input)=>{
 executions++;captured=input;
 if(!Object.isFrozen(input.request)||!Object.isFrozen(input.request.contacts)||!Object.isFrozen(input.request.contacts[0]))throw new Error('mutable Contract container');
 if(typeof input.request.count!=='bigint')throw new Error('native int was lost');
 if(Object.keys(input).some(key=>key.includes('/')))throw new Error('literal path escaped hydration');
 return [input.request.customer.name,input.request.alternate.name,input.request.contacts[0].customer.name,input.direct.name,input.customers[0].name,String(input.request.count)].join('|');
 }}};}`;
  return { artifact_version: 1, language_version: 'declaration-labelled', tool_version: 'consumer-component',
    sources: [{ path: SOURCE, sha256: createHash('sha256').update(source).digest('hex') }],
    modules: [{ path: MODULE, js, map: { version: 3, file: MODULE, sources: [SOURCE], sourcesContent: [source], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: MODULE, export: 'inspect', member: [APP, 'inspect'], inputStyle: 'parameters' }],
    operations, models: [{ name: CUSTOMER, deleteMode: 'archive', fields: [
      { name: 'name', field: { kind: 'string' }, valueType: 'text', required: true, serverOnly: false },
    ] }], valueTypes: { contracts: [
      { name: `${APP}.Contact`, fields: [{ name: 'customer', type: type(CUSTOMER) }] },
      { name: `${APP}.Request`, fields: [
        { name: 'customer', type: type(CUSTOMER) }, { name: 'alternate', type: type(CUSTOMER) },
        { name: 'contacts', type: type(`${APP}.Contact[]`) }, { name: 'count', type: 'int' }, { name: 'at', type: 'datetime' },
      ] },
    ] }, pages: [], tests: [], requires: [{ capability: 'canlang.builtins', min_version: 2 },
      { capability: 'state', min_version: 1 }, { capability: 'state.parameters', min_version: 1 }] };
}

it('hydrates declared nested Contract occurrences through actual admitted native views and retains frozen native values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-native-nominal-inputs-'));
  try {
    const artifact = declaration();
    const asm = await assembleModules({ artifact, sourcePath: SOURCE }, {
      workDir: directory, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    });
    const namespace = await importVerifiedAssemblyModule(asm, MODULE, artifact) as {
      inspect(): { executions: number; captured: { request: { at: Parameters<typeof encodeValue>[1]; customer: object; alternate: object; contacts: readonly { customer: object }[] }; direct: object; customers: readonly object[] } };
    };
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'nominal-inputs@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = randomBytes(32).toString('hex');
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3600000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const { store, probe } = createTestMemoryStorage();
    const row = await seedRow(store, CUSTOMER, { id: uuidv7(FIXED_NOW, 801), data: { name: 'Original' } });
    const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, now: () => FIXED_NOW });
    const ref = { id: row.id, version: String(row.version) }, at = '2026-10-15T10:00:00.000Z';
    const inputs = { request: { customer: ref, alternate: ref, contacts: [{ customer: ref }], count: '7', at }, direct: ref, customers: [ref] };
    const originalInputs = structuredClone(inputs), revision = await store.readRevision(), storedBefore = await store.load(CUSTOMER, row.id);
    const outcome = await invoker.invokeMutation({ operation: OP, operation_id: uuidv7(FIXED_NOW, 802), inputs }, identity);
    assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'committed');
    assert.equal(outcome.result.result, 'Original|Original|Original|Original|Original|7');
    assert.equal(outcome.result.records, undefined); assert.deepEqual(inputs, originalInputs);
    const captured = namespace.inspect(); assert.equal(captured.executions, 1);
    assert.equal(encodeValue('datetime', captured.captured.request.at), at);
    assert.equal(captured.captured.request.customer, captured.captured.request.alternate);
    assert.equal(captured.captured.request.customer, captured.captured.request.contacts[0]!.customer);
    assert.equal(captured.captured.request.customer, captured.captured.direct);
    assert.equal(captured.captured.request.customer, captured.captured.customers[0]);
    assert.deepEqual(await store.load(CUSTOMER, row.id), storedBefore);
    assert.equal(await store.readRevision(), revision + 1);
    assert.deepEqual(probe.historyFor(CUSTOMER, row.id), []);
    assert.deepEqual(probe.outboxAll(), []); assert.deepEqual(await store.schedulesDue(Number.MAX_SAFE_INTEGER, 100), []);
    await identities.removeMembership(membership.membership_id);
    const denied = await invoker.invokeMutation({ operation: OP, operation_id: uuidv7(FIXED_NOW, 803), inputs }, identity);
    assert.ok('error' in denied); assert.equal(denied.error.code, 'forbidden');
    assert.equal(namespace.inspect().executions, 1);
    assert.deepEqual(await store.load(CUSTOMER, row.id), storedBefore);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
