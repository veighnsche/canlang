import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapReadRulesToPolicy, readModelPolicyEntry } from '../src/runtime/invoke.js';

const fields = ['label', 'token', 'made', 'by', 'profile'];
const entry = { read: ['Model.read.1'], public: ['Model.read.1'] };
const provenance = (selected?: string[]) => ({
  secretFields: ['token'],
  declaration: { fields: Object.fromEntries(fields.map((name) => [name, {}])),
    readGrants: [{ rule: 'Model.read.1', ...(selected === undefined ? {} : { fields: selected }) }] },
  readRules: { 'Model.read.1': () => true },
});

test('omitted selector expands to nonsecret fields including ordinary server stamps', () => {
  const policy = mapReadRulesToPolicy('App.Model', entry, fields, provenance()).input!;
  assert.deepEqual(policy.secretFields, ['token']);
  assert.deepEqual(policy.grants[0]!.fields, ['label', 'made', 'by', 'profile']);
});

test('selected public grant keeps only its declared fields and mixed slices honor only public marks', () => {
  const proof = provenance(['label']);
  proof.declaration.readGrants.push({ rule: 'Model.read.2', fields: ['profile'] });
  Object.assign(proof.readRules, { 'Model.read.2': () => false });
  const policy = mapReadRulesToPolicy('App.Model', { ...entry, read: ['Model.read.1', 'Model.read.2'] }, fields, proof).input!;
  assert.deepEqual(policy.grants, [{ by: 'public', fields: ['label'] }]);
});

test('absent policy denies and pure unevaluable rules keep their loud refusal posture', () => {
  assert.deepEqual(mapReadRulesToPolicy('App.Model', undefined, fields, provenance()).input!.grants, []);
  assert.equal(mapReadRulesToPolicy('App.Model', { read: ['Model.read.1'] }, fields).ruled, true);
  assert.equal(readModelPolicyEntry({ policy: { models: Object.create({ 'App.Model': entry }) } }, 'App.Model'), undefined);
});

test('unproved, skewed, malformed and inherited selectors refuse instead of broadening', () => {
  assert.throws(() => mapReadRulesToPolicy('App.Model', entry, fields), /provenance/);
  const absent = provenance();
  absent.declaration.readGrants = [];
  assert.throws(() => mapReadRulesToPolicy('App.Model', entry, fields, absent), /identities/);
  for (const selected of [[], ['undeclared'], ['label', 'label'], ['profile..token']]) {
    assert.throws(() => mapReadRulesToPolicy('App.Model', entry, fields, provenance(selected)), /selector/);
  }
  const inherited = provenance(['label']);
  inherited.declaration.readGrants[0] = Object.create({ rule: 'Model.read.1', fields: ['label'] });
  assert.throws(() => mapReadRulesToPolicy('App.Model', entry, fields, inherited), /identity/);
  const inheritedFields = provenance();
  inheritedFields.declaration.readGrants[0] = Object.assign(Object.create({ fields: ['label'] }), { rule: 'Model.read.1' });
  assert.throws(() => mapReadRulesToPolicy('App.Model', entry, fields, inheritedFields), /inherited/);
});

// Hand-written policy profiles over the historical emitted T18 artifact. These
// test the actual canonical consumer; they do not prove a fresh compiler join.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import type { CompileArtifact, ModelName, RecordId, ResolvedIdentity } from '@canlang/contracts';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { T18_SHOP_ARTIFACT_JSON } from '@canlang/state/mutation/t18-shop.artifact';
import { buildInvoker } from '../src/worker/assembly.js';
import { loadCanonicalDescriptors } from '../src/runtime/invoke.js';

const at = Date.UTC(2026, 9, 7, 12);
const identity = {
  actor: { user_id: 'user-a', email: 'user-a@example.invalid', email_verified: true },
  team: { team_id: 'team-a', timezone: 'UTC' }, membership: null,
  binding: { kind: 'none' }, admitted_at: new Date(at).toISOString(),
} as ResolvedIdentity;
const memberships = { async findMembership(team: string, user: string) {
  return { membership_id: 'member-a', team_id: team, user_id: user, is_owner: false,
    status: 'active' as const, roles: [], created_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString() };
} };
function profile(selected?: string[], variant: 'public' | 'absent' | 'missing' | 'skew' | 'historical' = 'public', extra = '') {
  const artifact = JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
  let source = artifact.modules[0]!.js;
  if (variant !== 'historical') source = source.replace('export function canApp(){\nreturn {', 'export function canApp(){\nreturn {\npolicy:appDefinition.policy,');
  if (variant !== 'historical' && variant !== 'absent') {
    source = source.replace('"Shop.Team":{read:["Team.read.1"]}', '"Shop.Team":{read:["Team.read.1"],public:["Team.read.1"]}');
    source = source.replace('"Team.read.1":(c,row)=>hasRole(c,"members")', '"Team.read.1":(c,row)=>true');
  }
  if (variant === 'absent') source = source.replace('"Shop.Team":{read:["Team.read.1"]}', '"Shop.Team":{}');
  if (selected !== undefined) source = source.replace('readGrants:[{rule:"Team.read.1"}]', `readGrants:[{rule:"Team.read.1",fields:${JSON.stringify(selected)}}]`);
  if (variant === 'missing') source = source.replace('readGrants:[{rule:"Team.read.1"}]', 'readGrants:[]');
  if (variant === 'skew') source = source.replace('policy:appDefinition.policy,', 'policy:{...appDefinition.policy,models:{...appDefinition.policy.models,"Shop.Team":{read:["Team.read.1"],public:["Team.read.1"],locks:[]}}},');
  const dir = mkdtempSync(join(tmpdir(), 'can-secret-metadata-'));
  const module = join(dir, 'shop.mjs');
  source = source.replace('"@canlang/stdlib"', JSON.stringify(new URL('../src/runtime/stdlib.js', import.meta.url).href));
  source += extra;
  writeFileSync(module, source);
  return { artifact, asm: { dir, entryUrl: pathToFileURL(module).href, moduleUrls: { 'shop.mjs': pathToFileURL(module).href } }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('actual canonical create stores plain generated hex; read/query omit it but retain actor/now stamps', async () => {
  const { store } = createTestMemoryStorage();
  const world = profile();
  try {
    const invoker = buildInvoker(world.artifact, world.asm, store, { memberships, now: () => at });
    const random = randomBytes(10).toString('hex');
    const time = at.toString(16).padStart(12, '0');
    const id = `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
    const created = await invoker.invokeMutation({ operation: 'Shop.Team.create', operation_id: id,
      inputs: { name: 'visible label', owner: 'user-a', flags: [] } }, identity);
    assert.ok('result' in created, JSON.stringify(created));
    assert.equal(created.result.result, null);
    const publicRow = created.result.records![0] as { data: Record<string, unknown> };
    assert.equal(Object.hasOwn(publicRow.data, 'token'), false);
    const stored = await store.load('Shop.Team' as ModelName, id as RecordId);
    assert.ok(stored);
    const raw = stored.data;
    assert.ok(typeof raw.token === 'string');
    assert.match(raw.token, /^[0-9a-f]{64}$/);
    const read = await invoker.invokeRead({ operation: 'Shop.Team.read', inputs: {} }, identity);
    assert.ok('result' in read, JSON.stringify(read));
    const rows = (read.result as any).records;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.name, 'visible label');
    assert.equal(rows[0].data.made, raw.made);
    assert.deepEqual(rows[0].data.by, raw.by);
    assert.equal(Object.hasOwn(rows[0].data, 'token'), false);
    const selected = profile(['name']);
    try {
      const onlyLabel = await buildInvoker(selected.artifact, selected.asm, store, { memberships, now: () => at })
        .invokeRead({ operation: 'Shop.Team.read', inputs: {} }, identity);
      assert.ok('result' in onlyLabel, JSON.stringify(onlyLabel));
      assert.deepEqual((onlyLabel.result as any).records[0].data, { name: 'visible label' });
    } finally { selected.cleanup(); }
    const absent = profile(undefined, 'absent');
    try {
      const denied = await buildInvoker(absent.artifact, absent.asm, store, { memberships, now: () => at })
        .invokeRead({ operation: 'Shop.Team.read', inputs: {} }, identity);
      assert.ok('result' in denied);
      assert.deepEqual((denied.result as any).records, []);
    } finally { absent.cleanup(); }
  } finally { world.cleanup(); }
});

test('actual canonical preload refuses explicit secret subtree and selector/policy skew', async () => {
  for (const selected of [['token'], ['token.part']]) {
    const world = profile(selected);
    try { await assert.rejects(loadCanonicalDescriptors(world.asm, world.artifact), /secret/); }
    finally { world.cleanup(); }
  }
  for (const variant of ['missing', 'skew'] as const) {
    const world = profile(undefined, variant);
    try { await assert.rejects(loadCanonicalDescriptors(world.asm, world.artifact), /identities|disagreement/); }
    finally { world.cleanup(); }
  }
  const old = profile(undefined, 'historical');
  try {
    const canonical = await loadCanonicalDescriptors(old.asm, old.artifact);
    assert.deepEqual((canonical.policy as Map<string, any>).get('Shop.Team').grants, []);
  } finally { old.cleanup(); }
});

async function populatedReadStore() {
  const { store } = createTestMemoryStorage();
  const valid = profile();
  try {
    const time = at.toString(16).padStart(12, '0');
    const random = randomBytes(10).toString('hex');
    const id = `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-8${random.slice(4, 7)}-${random.slice(7, 19)}`;
    const created = await buildInvoker(valid.artifact, valid.asm, store, { memberships, now: () => at })
      .invokeMutation({ operation: 'Shop.Team.create', operation_id: id,
        inputs: { name: 'visible', owner: 'user-a', flags: [] } }, identity);
    assert.ok('result' in created, JSON.stringify(created));
    return store;
  } finally { valid.cleanup(); }
}
const anonymous = { actor: null, team: null, membership: null,
  binding: { kind: 'none' }, admitted_at: new Date(at).toISOString() } as ResolvedIdentity;

// Actual mounted canonical read is attempted as well as direct preload, including
// on the old candidate where these profiles returned stored public row content.
async function assertCanonicalProvenanceRefusal(world: ReturnType<typeof profile>, message: RegExp) {
  const store = await populatedReadStore();
  let error: unknown;
  try { await loadCanonicalDescriptors(world.asm, world.artifact); } catch (caught) { error = caught; }
  const mounted = await buildInvoker(world.artifact, world.asm, store, { memberships, now: () => at })
    .invokeRead({ operation: 'Shop.Team.read', inputs: {} }, anonymous);
  assert.ok(error instanceof Error, `preload accepted; mounted outcome ${JSON.stringify(mounted)}`);
  assert.match(error.message, message);
  assert.ok('error' in mounted, JSON.stringify(mounted));
}

for (const inherited of [false, true]) {
  test(`canonical policy agreement ignores ${inherited ? 'inherited' : 'non-enumerable'} toJSON hiding a forged public mark`, async () => {
    const hook = inherited
      ? 'Object.setPrototypeOf(forged,{toJSON(){return {read:["Team.read.1"]}}});'
      : 'Object.defineProperty(forged,"toJSON",{value:()=>({read:["Team.read.1"]})});';
    const world = profile(undefined, 'public', `
      delete appDefinition.policy.models["Shop.Team"].public;
      const originalFactory=canApp;
      canApp=function(){const registry=originalFactory();const forged={read:["Team.read.1"],public:["Team.read.1"]};
        ${hook}
        return {...registry,policy:{...appDefinition.policy,models:{...appDefinition.policy.models,"Shop.Team":forged}}};};
    `);
    try { await assertCanonicalProvenanceRefusal(world, /disagreement/); } finally { world.cleanup(); }
  });

  test(`canonical duplicate selector agreement ignores ${inherited ? 'inherited' : 'non-enumerable'} array toJSON`, async () => {
    const broad = profile();
    const hook = inherited
      ? 'Object.setPrototypeOf(grants,Object.assign(Object.create(Array.prototype),{toJSON:()=>[{rule:"Team.read.1"}]}));'
      : 'Object.defineProperty(grants,"toJSON",{value:()=>[{rule:"Team.read.1"}]});';
    const narrow = profile(['name'], 'public', `const grants=appDefinition.models["Shop.Team"].readGrants;${hook}`);
    broad.artifact.modules.push({ ...broad.artifact.modules[0]!, path: 'duplicate.mjs' });
    Object.assign(broad.asm.moduleUrls, { 'duplicate.mjs': narrow.asm.entryUrl });
    try { await assertCanonicalProvenanceRefusal(broad, /contradictory/); }
    finally { broad.cleanup(); narrow.cleanup(); }
  });
}

for (const forgeMark of [false, true]) {
  test(`actual canonical rule ${forgeMark ? 'mark' : 'declaration'} cannot be proven by an overridden includes`, async () => {
    const world = profile(['name'], 'public', `
      appDefinition.models["Shop.Team"].readGrants[0].rule="Forged.rule";
      ${forgeMark ? 'appDefinition.policy.models["Shop.Team"].public=["Forged.rule"];' : ''}
      Object.defineProperty(appDefinition.policy.models["Shop.Team"].read,"includes",{value:()=>true});
      const originalFactory=canApp;
      canApp=function(){const registry=originalFactory();return {...registry,read:{...registry.read,"Forged.rule":()=>true}};};
    `);
    try { await assertCanonicalProvenanceRefusal(world, /no emitted rule|rule identity/); } finally { world.cleanup(); }
  });
}

for (const member of ['read', 'public', 'fields', 'readGrants'] as const) {
  test(`actual canonical ${member} sparse own elements refuse without trusting every or iterator hooks`, async () => {
    const target = member === 'fields' ? 'appDefinition.models["Shop.Team"].readGrants[0].fields'
      : member === 'readGrants' ? 'appDefinition.models["Shop.Team"].readGrants'
      : `appDefinition.policy.models["Shop.Team"].${member}`;
    const world = profile(['name'], 'public', `
      ${target}=Array(1);
      Object.defineProperty(${target},"every",{value:()=>true});
      Object.defineProperty(${target},Symbol.iterator,{value:function*(){yield "Team.read.1";}});
      Object.defineProperty(appDefinition.policy.models["Shop.Team"].read,"includes",{value:()=>true});
    `);
    try { await assertCanonicalProvenanceRefusal(world, /malformed|identity/); } finally { world.cleanup(); }
  });
}

test('changing own rule getter cannot turn a narrow declared grant into a broad anonymous read', async () => {
  const world = profile(['name'], 'public', `
    let demands=0;
    Object.defineProperty(appDefinition.models["Shop.Team"].readGrants[0],"rule",{
      get(){return ++demands<=3?"Team.read.1":"Forged.rule";}});
    const originalFactory=canApp;
    canApp=function(){const registry=originalFactory();return {...registry,read:{...registry.read,"Forged.rule":()=>true}};};
    export function metadataDemands(){return demands;}
  `);
  try {
    await assertCanonicalProvenanceRefusal(world, /accessor/);
    const emitted = await import(world.asm.entryUrl);
    assert.equal(emitted.metadataDemands(), 0);
  } finally { world.cleanup(); }
});

// The supported generated metadata profile owns data. Accessors at this
// evidence boundary refuse without executing; this is not a compiler proof.
for (const [label, target, key] of [
  ['selector', 'appDefinition.models["Shop.Team"].readGrants[0]', 'fields'],
  ['grant list', 'appDefinition.models["Shop.Team"]', 'readGrants'],
  ['model field names', 'appDefinition.models["Shop.Team"]', 'fields'],
  ['public marks', 'appDefinition.policy.models["Shop.Team"]', 'public'],
  ['read rule callable', 'registry.read', 'Team.read.1'],
] as const) {
  test(`own ${label} accessor refuses without demand in the actual canonical read`, async () => {
    const body = `const target=${target};const saved=target[${JSON.stringify(key)}];
      Object.defineProperty(target,${JSON.stringify(key)},{get(){demands++;return saved;}});`;
    const extra = label === 'read rule callable'
      ? `let demands=0;const originalFactory=canApp;canApp=function(){const registry=originalFactory();${body}return registry;};`
      : `let demands=0;${body}`;
    const world = profile(['name'], 'public', extra + 'export function metadataDemands(){return demands;}');
    try {
      await assertCanonicalProvenanceRefusal(world, /accessor/);
      const emitted = await import(world.asm.entryUrl);
      assert.equal(emitted.metadataDemands(), 0);
    } finally { world.cleanup(); }
  });
}

for (const member of ['fields', 'readGrants'] as const) {
  test(`changing virtual ${member} length cannot hide an invalid own element`, async () => {
    const target = member === 'fields' ? 'appDefinition.models["Shop.Team"].readGrants[0].fields'
      : 'appDefinition.models["Shop.Team"].readGrants';
    const elements = member === 'fields' ? '["name","undeclared"]' : '[{rule:"Team.read.1",fields:["name"]},42]';
    const world = profile(['name'], 'public', `
      let demands=0;
      ${target}=new Proxy(${elements},{get(array,key,receiver){
        if(key==="length"){demands++;return 1;}return Reflect.get(array,key,receiver);}});
      export function metadataDemands(){return demands;}
    `);
    try {
      await assertCanonicalProvenanceRefusal(world, /malformed|undeclared/);
      const emitted = await import(world.asm.entryUrl);
      assert.equal(emitted.metadataDemands(), 0);
    } finally { world.cleanup(); }
  });
}

test('a claimed selector length must agree with its actual own index keys', async () => {
  const world = profile(['name'], 'public', `
    appDefinition.models["Shop.Team"].readGrants[0].fields=new Proxy(["name","undeclared"],{
      getOwnPropertyDescriptor(array,key){const property=Reflect.getOwnPropertyDescriptor(array,key);
        return key==="length"?{...property,value:1}:property;}});
  `);
  try { await assertCanonicalProvenanceRefusal(world, /malformed/); } finally { world.cleanup(); }
});

test('ordinary own narrow selector data remains valid with an undemanded virtual length hook', async () => {
  const world = profile(['name'], 'public', `
    appDefinition.models["Shop.Team"].readGrants[0].fields=new Proxy(["name"],{
      get(array,key,receiver){if(key==="length")throw new Error("virtual length demanded");
        return Reflect.get(array,key,receiver);}});
  `);
  try {
    const store = await populatedReadStore();
    const read = await buildInvoker(world.artifact, world.asm, store, { memberships, now: () => at })
      .invokeRead({ operation: 'Shop.Team.read', inputs: {} }, anonymous);
    assert.ok('result' in read, JSON.stringify(read));
    assert.deepEqual((read.result as any).records[0].data, { name: 'visible' });
  } finally { world.cleanup(); }
});

test('valid actual elements preserve narrow reads without invoking metadata methods or serializers', async () => {
  const world = profile(['name'], 'public', `
    for(const list of [appDefinition.policy.models["Shop.Team"].read,appDefinition.policy.models["Shop.Team"].public,
      appDefinition.models["Shop.Team"].readGrants,appDefinition.models["Shop.Team"].readGrants[0].fields]){
      for(const key of ["includes","every",Symbol.iterator,"toJSON"])
        Object.defineProperty(list,key,{value:()=>{throw new Error("metadata method invoked");}});
    }
    Object.defineProperty(appDefinition.policy.models["Shop.Team"],"toJSON",{value:()=>{throw new Error("policy serializer invoked");}});
  `);
  try {
    const store = await populatedReadStore();
    const loaded = await loadCanonicalDescriptors(world.asm, world.artifact);
    assert.deepEqual((loaded.policy as Map<string, any>).get('Shop.Team').grants[0].fields, ['name']);
    const read = await buildInvoker(world.artifact, world.asm, store, { memberships, now: () => at })
      .invokeRead({ operation: 'Shop.Team.read', inputs: {} }, anonymous);
    assert.ok('result' in read, JSON.stringify(read));
    assert.deepEqual((read.result as any).records[0].data, { name: 'visible' });
  } finally { world.cleanup(); }
});

for (const member of ['read', 'public', 'fields', 'readGrants'] as const) {
  test(`actual canonical ${member} malformed elements cannot be replaced by array methods`, async () => {
    const target = member === 'fields' ? 'appDefinition.models["Shop.Team"].readGrants[0].fields'
      : member === 'readGrants' ? 'appDefinition.models["Shop.Team"].readGrants'
      : `appDefinition.policy.models["Shop.Team"].${member}`;
    const yielded = member === 'readGrants' ? '{rule:"Team.read.1",fields:["name"]}'
      : member === 'fields' ? '"name"' : '"Team.read.1"';
    const world = profile(['name'], 'public', `
      ${target}=[42];
      Object.defineProperty(${target},"every",{value:()=>true});
      Object.defineProperty(${target},Symbol.iterator,{value:function*(){yield ${yielded};}});
      Object.defineProperty(appDefinition.policy.models["Shop.Team"].read,"includes",{value:()=>true});
    `);
    try { await assertCanonicalProvenanceRefusal(world, /malformed|identity/); } finally { world.cleanup(); }
  });
}
