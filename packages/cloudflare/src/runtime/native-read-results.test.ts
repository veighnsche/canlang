/** Declaration-labelled public read codec component. The assembled module is
 * hand-authored; these checks make no Compiler/query-source qualification claim. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanTypeId, CompileArtifact, ModelName, StoragePort } from '@canlang/contracts';
import { makeRecordRef } from '@canlang/values';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { FIXED_NOW, seedRow, updateRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { assembleModules, importVerifiedAssemblyModule } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';

const APP = 'NativeReadCodec', TASK = `${APP}.Task` as ModelName, OTHER = `${APP}.Other` as ModelName;
const MODULE = 'native-read-codec.mjs', SOURCE = 'native-read-codec-component.can';
const source = '## Declaration-labelled native read result codec fixture, not compiled source.';
const sha = createHash('sha256').update(source).digest('hex');

function declaration(): CompileArtifact {
  const operations: NonNullable<CompileArtifact['operations']> = ['facts', 'wrapper', 'nullable'].map((name): NonNullable<CompileArtifact['operations']>[number] => ({
    name: `${APP}.${name}`, kind: 'read', description: '', inputs: { fields: [
      { name: 'mode', field: { kind: 'string' }, valueType: 'text', required: true },
    ] }, result: { type: `${APP}.${name === 'wrapper' ? 'Wrapper' : 'Fact[]'}${name === 'nullable' ? '?' : ''}` as CanTypeId },
  }));
  const declarations = Object.fromEntries(operations.map(op => [op.name, { handler: op.name,
    read: true, by: 'members', result: { type: `${APP}.${op.name.endsWith('.wrapper') ? 'Wrapper' : 'Fact'}`,
      ...(op.name.endsWith('.wrapper') ? {} : { array: true }),
      ...(op.name.endsWith('.nullable') ? { nullable: true } : {}) } }]));
  // Model reads use the owning default descriptor loader, with no generated
  // scenario callable: the same shape as typed-authorized-reads.json.
  const allOperations: NonNullable<CompileArtifact['operations']> = [...operations,
    ...[TASK, OTHER].map((name): NonNullable<CompileArtifact['operations']>[number] => ({
      name: `${name}.read`, kind: 'read', description: '', inputs: { fields: [] },
    })),
  ];
  const js = `let retained, afterQuery, replacementReference, getterReads=0, executions=0;
export const inspect=()=>({getterReads,executions});
export const setAfterQuery=callback=>{afterQuery=callback;};
export const setReplacementReference=reference=>{replacementReference=reference;};
const policy={operations:${JSON.stringify(Object.fromEntries(operations.map(op => [op.name, { by: ['members'] }])))},
 models:{'${TASK}':{read:['task-read']},'${OTHER}':{read:['other-read']}}};
export const appDefinition={id:'${APP}',policy,operations:${JSON.stringify(declarations)},
 contracts:{'${APP}.Fact':{fields:{task:{type:'${TASK}'},version:{type:'int'},title:{type:'text'}}},
 '${APP}.Wrapper':{fields:{facts:{type:'${APP}.Fact',array:true},optional:{type:'${APP}.Fact',array:true,nullable:true}}}},
 models:{'${TASK}':{fields:{title:{type:'text'}},readGrants:[{rule:'task-read',by:['members'],fields:['title']}]},
 '${OTHER}':{fields:{title:{type:'text'}},readGrants:[{rule:'other-read',by:['members'],fields:['title']}]}}};
async function read(c,input,wrapper=false){
 executions++;
 const rows=await c.canonical.readRecords('${TASK}',{order:['-title']});
 if(afterQuery){const callback=afterQuery;afterQuery=undefined;await callback();}
 if(input.mode==='null')return null;
 if(input.mode==='empty')return wrapper?{facts:[],optional:null}:[];
 let chosen=rows[0];
 if(input.mode==='hold')retained=chosen;
 if(input.mode==='foreign')chosen=retained;
 if(input.mode==='copy')chosen=Object.defineProperties({},Object.getOwnPropertyDescriptors(chosen));
 if(input.mode==='plain')chosen={model:'${TASK}',id:chosen.id,version:chosen.version};
 if(input.mode==='substitute')chosen=replacementReference;
 if(input.mode==='wrong-model')chosen=(await c.canonical.readRecords('${OTHER}',{}))[0];
 if(input.mode==='accessor')chosen=Object.defineProperties({},Object.fromEntries(['model','id','version'].map(key=>
  [key,{enumerable:true,get(){getterReads++;throw new Error('untrusted getter ran');}}])));
 const facts=rows.map((row,index)=>({task:index===0?chosen:row,version:row.version,title:row.title}));
 if(input.mode==='array-accessor')Object.defineProperty(facts,'0',{enumerable:true,get(){getterReads++;throw new Error('untrusted array getter ran');}});
 if(input.mode==='wrapper-accessor')return Object.defineProperties({optional:null},{facts:{enumerable:true,get(){getterReads++;throw new Error('untrusted contract getter ran');}}});
 return wrapper?{facts,optional:facts}:facts;
}
export function canApp(){return {policy,operations:${JSON.stringify(allOperations)},read:{'task-read':()=>true,'other-read':()=>true},
 '${APP}':{facts:(c,input)=>read(c,input),nullable:(c,input)=>read(c,input),wrapper:(c,input)=>read(c,input,true)}};}`;
  return { artifact_version: 1, language_version: 'declaration-labelled', tool_version: 'consumer-component',
    sources: [{ path: SOURCE, sha256: sha }], modules: [{ path: MODULE, js, map: { version: 3,
      file: MODULE, sources: [SOURCE], sourcesContent: [source], names: [], mappings: '' } }],
    callables: operations.map(op => ({ id: op.name, kind: 'operation', module: MODULE,
      export: op.name.split('.').at(-1)!, member: [APP, op.name.split('.').at(-1)!], inputStyle: 'parameters' })),
    operations: allOperations, pages: [], tests: [], requires: [{ capability: 'canlang.builtins', min_version: 2 },
      { capability: 'state', min_version: 1 }, { capability: 'state.parameters', min_version: 1 }],
    models: [TASK, OTHER].map((name): NonNullable<CompileArtifact['models']>[number] => ({ name, deleteMode: 'archive', fields: [
      { name: 'title', field: { kind: 'string' }, valueType: 'text', required: true, serverOnly: false },
    ] })), valueTypes: { contracts: [
      { name: `${APP}.Fact`, fields: [{ name: 'task', type: TASK as CanTypeId }, { name: 'version', type: 'int' }, { name: 'title', type: 'text' }] },
      { name: `${APP}.Wrapper`, fields: [{ name: 'facts', type: `${APP}.Fact[]` as CanTypeId }, { name: 'optional', type: `${APP}.Fact[]?` as CanTypeId }] },
    ] } };
}

interface FixtureModule {
  inspect(): { getterReads: number; executions: number };
  setAfterQuery(callback: () => Promise<void>): void;
  setReplacementReference(reference: ReturnType<typeof makeRecordRef>): void;
}

it('encodes read-local nominal reference results and refuses copied, foreign or revoked views without effects', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-native-read-codec-'));
  try {
    const artifact = declaration(), asm = await assembleModules({ artifact, sourcePath: SOURCE }, {
      workDir: dir, stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),
    });
    const namespace = await importVerifiedAssemblyModule(asm, MODULE, artifact) as FixtureModule;
    assert.equal(typeof namespace.inspect, 'function'); assert.equal(typeof namespace.setAfterQuery, 'function');
    const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'member@native-read.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = randomBytes(32).toString('hex');
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      expires_at: new Date(FIXED_NOW + 3600000).toISOString(), last_team_id: team.team_id });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const { store: physical, probe } = createTestMemoryStorage();
    const a = await seedRow(physical, TASK, { id: uuidv7(FIXED_NOW, 801), data: { title: 'Alpha' } });
    const initialB = await seedRow(physical, TASK, { id: uuidv7(FIXED_NOW, 802), data: { title: 'Old title' } });
    const b = await updateRow(physical, TASK, initialB, { data: { title: 'Zulu' } });
    assert.equal(typeof namespace.setReplacementReference, 'function');
    namespace.setReplacementReference(makeRecordRef(TASK, b.id, BigInt(b.version)));
    const other = await seedRow(physical, OTHER, { id: uuidv7(FIXED_NOW, 803), data: { title: 'Other' } });
    let commits = 0, receiptReads = 0;
    const store: StoragePort = { ...physical,
      commit: async () => { commits++; throw new Error('fresh read commit tripwire'); },
      readReceipt: async () => { receiptReads++; throw new Error('fresh read receipt tripwire'); },
    };
    const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, now: () => FIXED_NOW });
    const snapshot = async () => ({ revision: await physical.readRevision(),
      rows: await physical.query({ model: TASK, authority: 'owner', archived: 'include' }),
      other: await physical.load(OTHER, other.id), history: [probe.historyFor(TASK, a.id), probe.historyFor(TASK, b.id)],
      outbox: probe.outboxAll(), schedules: await physical.schedulesDue(Number.MAX_SAFE_INTEGER, 100),
      membership: await identities.findMembershipById(membership.membership_id),
      user: await identities.findUserById(user.user_id), team: await identities.findTeamById(team.team_id), commits, receiptReads });
    const before = await snapshot();
    const facts = [b, a].map(row => ({ task: { id: row.id, version: String(row.version) },
      version: String(row.version), title: row.data.title }));
    const invoke = (mode: string, name = 'facts') => invoker.invokeRead({ operation: `${APP}.${name}`, inputs: { mode } }, identity);
    for (const [mode, name, result] of [
      ['normal', 'facts', facts], ['empty', 'facts', []], ['null', 'nullable', null],
      ['normal', 'wrapper', { facts, optional: facts }], ['empty', 'wrapper', { facts: [], optional: null }],
      ['hold', 'facts', facts],
    ] as const) {
      assert.deepEqual(await invoke(mode, name), { result: { result, revision: before.revision } });
      assert.deepEqual(await snapshot(), before, `${mode}/${name} is an ordinary no-effect read`);
    }
    for (const mode of ['copy', 'foreign', 'plain', 'substitute', 'wrong-model', 'accessor', 'array-accessor', 'wrapper-accessor']) {
      const outcome = await invoke(mode, mode === 'wrapper-accessor' ? 'wrapper' : 'facts'); assert.ok('error' in outcome, mode);
      assert.equal(outcome.error.code, 'validation', mode);
      assert.equal(Object.hasOwn(outcome.error, 'operation_id'), false);
      assert.equal(namespace.inspect().getterReads, 0, 'untrusted model identity getters are never read');
      assert.deepEqual(await snapshot(), before, `${mode} cannot write any effects`);
    }
    let revokedSnapshot: Awaited<ReturnType<typeof snapshot>> | undefined;
    namespace.setAfterQuery(async () => {
      await identities.removeMembership(membership.membership_id);
      revokedSnapshot = await snapshot();
    });
    const revoked = await invoke('normal'); assert.ok('error' in revoked);
    // The original ordered domain is re-admitted through State: its owning
    // selector check refuses a title path whose member grant disappeared.
    assert.equal(revoked.error.code, 'validation', JSON.stringify(revoked));
    assert.equal(revoked.error.message, 'Query path "title" is not granted to this caller.');
    assert.ok(revokedSnapshot);
    const freshRevoked = await invoke('normal'); assert.ok('error' in freshRevoked);
    assert.equal(freshRevoked.error.code, 'forbidden', JSON.stringify(freshRevoked));
    assert.deepEqual(await snapshot(), revokedSnapshot, 'current authorization refusal adds no State/Identity effects');
    assert.equal(commits, 0, 'fresh reads never enter receipt or mutation commit');
    assert.equal(receiptReads, 0, 'fresh reads never use mutation receipts');
    assert.equal(namespace.inspect().getterReads, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
