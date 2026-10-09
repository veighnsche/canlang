/** Defining State default-attribution controls using checked parameter
 * descriptors and Values inventory. Expression/native-ref proof and Compiler
 * source execution belong to their owning producer, not this hand-built test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, MutationEnvelope, Receipt } from '@canlang/contracts';
import { receiptIdentityFor, type AdmittedCall } from './admission.js';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import type { MutationWritesResult, OwnerMutationSession } from '../mutation/pipeline.js';
import { buildPolicyTable } from '../policy/grants.js';
import { IncompatibleArtifactError, loadArtifactDescriptors, type ArtifactDescriptorSlice } from './registry.js';
import { invoke, type ExecutionEffects } from './invoke.js';
import { beginScenarioReceiptMutation, observeScenarioInputComputedDefault, projectScenarioReceipt } from './scenario-receipt.js';
import { FIXED_NOW, asId, asModel, createMemoryIdentityStore, makeIdentity, makeEnvelope,
  seedMember, seedRow, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('Defaults.Record'), OP = 'Defaults.create', APP = 'scenario-input-defaults';
const CREATED = asId('created'), bounds = { maxRows: 10, maxWork: 1000 }, cause = { cause: 'scenario' } as const;
let sequence = 40_000;
const origin = () => ({ path: 'defaults.can', sha256: 'c'.repeat(64), module: 'defaults.mjs' });
const packet = () => ({ quantity: '7', label: 'packet', memo: null });
function artifact(): ArtifactDescriptorSlice {
  return { artifact_version: 1, sources: [{ path: 'defaults.can', sha256: 'c'.repeat(64) }],
    modules: [{ path: 'defaults.mjs', js: 'export const identity="Defaults.create";',
      map: { version: 3, file: 'defaults.mjs', sources: ['defaults.can'], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: 'defaults.mjs', export: 'identity', member: ['create'], inputStyle: 'parameters' }],
    valueTypes: { contracts: [{ name: 'Defaults.Packet', fields: [
      { name: 'quantity', type: 'int' as CanTypeId }, { name: 'label', type: 'text' as CanTypeId },
      { name: 'memo', type: 'text?' as CanTypeId },
    ] }] },
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'label', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: false, serverOnly: false,
        default: { kind: 'literal', value: 'model label' } },
      { name: 'token', field: { kind: 'secret' }, required: false, serverOnly: true,
        default: { kind: 'server', init: 'random_secret' } },
    ] }],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'seed', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
      { name: 'label', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: false,
        default: { kind: 'literal', value: 'input label' } },
      { name: 'nullable', field: { kind: 'integer' }, valueType: 'int?' as CanTypeId, nullable: true, required: false },
      { name: 'nullableArray', field: { kind: 'string' }, valueType: 'text[]?' as CanTypeId,
        nullable: true, array: { required: false }, required: false },
      { name: 'supplied', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId, required: false,
        default: { kind: 'literal', value: true } },
      { name: 'explicitNull', field: { kind: 'string' }, valueType: 'text?' as CanTypeId, nullable: true, required: false,
        default: { kind: 'literal', value: 'unused fallback' } },
      { name: 'emptyArray', field: { kind: 'integer' }, valueType: 'int[]' as CanTypeId, array: { required: false }, required: false },
      { name: 'defaultless', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: false },
      { name: 'count', field: { kind: 'integer' }, valueType: 'int' as CanTypeId, required: false, computedDefault: true },
      { name: 'tags', field: { kind: 'string' }, valueType: 'text[]?' as CanTypeId, nullable: true,
        array: { required: false }, required: false, computedDefault: true },
      { name: 'mode', field: { kind: 'enum', values: ['one', 'two'] }, valueType: 'enum(one,two)' as CanTypeId,
        required: false, computedDefault: true },
      { name: 'legacy', field: { kind: 'enum', values: ['one', 'two'] }, required: false, computedDefault: true },
      { name: 'packet', field: { kind: 'nominal', name: 'Defaults.Packet' }, valueType: 'Defaults.Packet' as CanTypeId,
        required: false, computedDefault: true },
      { name: 'alias', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: false, computedDefault: true },
    ] }, result: { type: 'void' as CanTypeId, disclosure: { version: 1, source: origin(), returns: [
      { id: 'implicit-return', source: origin(), influences: [], dependencies: [] },
    ] } } }],
  };
}
const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';
const stateError = (error: unknown) => error instanceof StateError;
const forbidden = (error: unknown) => error instanceof StateError && error.code === 'forbidden';
const effects = (output: MutationWritesResult): ExecutionEffects => ({ ...output, result: null, outbox: [], fileAssignments: [] });
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {}, fileAssignments: [] });
async function world(extraInputs: MutationEnvelope['inputs'] = {}, source = artifact()) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false, roles: [] });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(source, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const seeded = await seedRow(store, MODEL, { id: 'seed', data: { label: 'seed label', token: 'seed secret' } });
  const row = await store.load(MODEL, seeded.id); assert.ok(row);
  const policy = buildPolicyTable([{ model: MODEL, secretFields: ['token'], grants: [{ by: 'members', fields: ['label'] }] }]);
  const wireRef = { id: row.id, version: String(row.version) };
  return { store, memberships, member, identity, table, row, policy, wireRef, registry: loaded.registry,
    app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { seed: wireRef,
      supplied: false, explicitNull: null, ...extraInputs }) };
}
type World = Awaited<ReturnType<typeof world>>;
function reports(w: World) { return [
  { name: 'count', wire: '9' }, { name: 'tags', wire: ['first', 'second'] }, { name: 'mode', wire: 'two' },
  { name: 'legacy', wire: 'one' }, { name: 'packet', wire: packet() }, { name: 'alias', wire: w.wireRef },
]; }
function reportAll(call: AdmittedCall, w: World) {
  for (const report of reports(w)) if (!Object.hasOwn(call.inputs, report.name)) {
    observeScenarioInputComputedDefault(call, w.store, report);
  }
}
async function start(call: AdmittedCall, w: World): Promise<OwnerMutationSession> {
  const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
  await session.stage({ op: 'create', model: MODEL, id: CREATED, data: {} }, cause);
  return session;
}
async function domain(w: World) { return { seed: await w.store.load(MODEL, w.row.id),
  created: await w.store.load(MODEL, CREATED), history: await w.store.historyFor(MODEL, CREATED),
  outbox: await w.store.outboxPending(), schedules: await w.store.schedulesDue(FIXED_NOW, 10) }; }

test('parameter scenario finalizes the typed input and real model default union and replays without executing', async () => {
  const w = await world(); let receipt: Receipt | undefined, admitted: AdmittedCall | undefined; let executes = 0;
  const input = { ...w, execute: async (call: AdmittedCall) => {
    executes++; admitted = call;
    assert.deepEqual(call.inputs['emptyArray'], []);
    assert.equal(Object.hasOwn(call.inputs, 'label'), false);
    const session = await start(call, w); reportAll(call, w);
    const output = await session.finalize();
    assert.ok(Object.isFrozen(output)); assert.ok(Object.isFrozen(output.resolvedDefaults));
    assert.equal(output.writes.length, 1); assert.equal(output.history.length, 1);
    const created = output.writes[0]; assert.ok(created); assert.equal(created.kind, 'insert');
    if (created.kind !== 'insert') throw new Error('Expected owning create');
    const expected = { label: 'input label', nullable: null, nullableArray: null,
      count: '9', tags: ['first', 'second'], mode: 'two', legacy: 'one', packet: packet(), alias: w.wireRef,
      [`0:${MODEL}.label`]: 'model label', [`0:${MODEL}.token`]: created.row.data['token'] };
    assert.deepEqual(output.resolvedDefaults, expected);
    assert.equal(created.row.data['label'], 'model label'); assert.equal(created.row.version, 1);
    assert.equal(typeof created.row.data['token'], 'string');
    for (const name of ['supplied', 'explicitNull', 'emptyArray', 'defaultless']) {
      assert.equal(Object.hasOwn(output.resolvedDefaults, name), false);
    }
    return effects(output);
  }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt); assert.ok(admitted);
  const retained = receipt, before = await domain(w), revision = await w.store.readRevision();
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executes, 1);
  assert.deepEqual(receipt, retained); assert.deepEqual(await domain(w), before);
  assert.equal(await w.store.readRevision(), revision);
  for (const provided of [{ nullable: null }, { label: 'input label' }, { count: '9' }]) {
    await assert.rejects(invoke({ ...input, envelope: { ...w.envelope, inputs: { ...w.envelope.inputs, ...provided } } }),
      error => error instanceof StateError && error.code === 'conflict');
  }
  assert.equal(executes, 1); assert.deepEqual(await domain(w), before);
  const projected = await projectScenarioReceipt({ ...w, receipt });
  assert.equal(projected.result, null); assert.deepEqual(projected.records[0]!.data, { label: 'model label' });
  assert.throws(() => observeScenarioInputComputedDefault(admitted!, w.store, reports(w)[0]!), forbidden);
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
});

test('unchanged null-prototype admitted ref and nominal inputs keep their execution provenance', async () => {
  const w = await world({ packet: Object.assign(Object.create(null), packet()) });
  w.envelope.inputs['seed'] = Object.assign(Object.create(null), w.wireRef);
  await invoke({ ...w, execute: async call => {
    assert.equal(Object.getPrototypeOf(call.inputs['packet']), null);
    assert.equal(Object.getPrototypeOf(call.inputs['seed']), null);
    const session = await start(call, w); reportAll(call, w);
    const output = await session.finalize();
    assert.equal(Object.hasOwn(output.resolvedDefaults, 'packet'), false);
    return effects(output);
  } });
  assert.ok(await w.store.load(MODEL, CREATED));
});

test('supplied computed values including null contribute no defaults and nullable computed arrays validate null', async () => {
  for (const mode of ['supplied', 'computed-null'] as const) {
    const supplied = { count: '0', tags: null, mode: 'one', legacy: 'two', packet: packet(),
      alias: { id: 'seed', version: '1' } };
    const w = await world(mode === 'supplied' ? supplied : {});
    let receipt: Receipt | undefined;
    await invoke({ ...w, execute: async call => {
      const session = await start(call, w);
      if (mode === 'computed-null') for (const report of reports(w)) {
        observeScenarioInputComputedDefault(call, w.store, report.name === 'tags' ? { name: 'tags', wire: null } : report);
      }
      const output = await session.finalize();
      for (const { name } of reports(w)) assert.equal(Object.hasOwn(output.resolvedDefaults, name), mode === 'computed-null');
      if (mode === 'computed-null') assert.equal(output.resolvedDefaults['tags'], null);
      return effects(output);
    }, observeCommittedReceipt: value => { receipt = value; } });
    assert.ok(receipt); assert.equal(receipt.outcome.status, 'committed');
  }
});

test('computed default reports refuse missing duplicate out-of-order type bulk accessor and foreign claims even when caught', async () => {
  for (const mode of ['missing', 'duplicate', 'order', 'type', 'bulk', 'accessor', 'hidden', 'extra', 'foreign-store'] as const) {
    const w = await world(), before = await domain(w); let getters = 0;
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await start(call, w), ordered = reports(w);
      if (mode === 'missing') {
        for (const report of ordered.slice(0, -1)) observeScenarioInputComputedDefault(call, w.store, report);
      } else {
        if (mode === 'duplicate') observeScenarioInputComputedDefault(call, w.store, ordered[0]!);
        let report: unknown = mode === 'order' ? ordered[1] : mode === 'type' ? { name: 'count', wire: 9 }
          : mode === 'bulk' ? ordered : mode === 'extra' ? { ...ordered[0]!, extra: true } : { ...ordered[0]! };
        if (mode === 'accessor') Object.defineProperty(report, 'wire', { enumerable: true, get: () => { getters++; return '9'; } });
        if (mode === 'hidden') Object.defineProperty(report, 'wire', { enumerable: false, value: '9' });
        assert.throws(() => observeScenarioInputComputedDefault(call, mode === 'foreign-store' ? { ...w.store } : w.store,
          report as Parameters<typeof observeScenarioInputComputedDefault>[2]), stateError);
      }
      await assert.rejects(session.finalize(), validation);
      return empty();
    } }), validation);
    assert.equal(getters, 0); assert.deepEqual(await domain(w), before);
  }
});

test('computed default validation enforces checked array enum nominal and earlier admitted reference profiles', async () => {
  for (const mode of ['array', 'typed-enum', 'legacy-enum', 'nominal', 'ref-id', 'ref-version', 'ref-shape'] as const) {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await start(call, w);
      const badName = mode === 'array' ? 'tags' : mode === 'typed-enum' ? 'mode' : mode === 'legacy-enum' ? 'legacy'
        : mode === 'nominal' ? 'packet' : 'alias';
      for (const report of reports(w)) {
        if (report.name !== badName) { observeScenarioInputComputedDefault(call, w.store, report); continue; }
        const wire = mode === 'array' ? ['okay', null] : mode.endsWith('enum') ? 'outside'
          : mode === 'nominal' ? { quantity: '7', label: 'packet', memo: null, unknown: 'field' }
          : mode === 'ref-id' ? { ...w.wireRef, id: 'foreign-row' }
          : mode === 'ref-version' ? { ...w.wireRef, version: '99' } : { ...w.wireRef, extra: true };
        assert.throws(() => observeScenarioInputComputedDefault(call, w.store, { name: badName, wire }), validation);
        break;
      }
      await assert.rejects(session.finalize(), validation);
      return empty();
    } }), validation);
    assert.deepEqual(await domain(w), before);
  }
});

test('final default union refuses missing or overridden input and model contributions', async () => {
  for (const mode of ['missing', 'input', 'model'] as const) {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await start(call, w); reportAll(call, w);
      const output = await session.finalize(), defaults = { ...output.resolvedDefaults };
      if (mode === 'missing') delete defaults['count'];
      else defaults[mode === 'input' ? 'label' : `0:${MODEL}.label`] = 'executor override';
      return { ...effects(output), resolvedDefaults: defaults };
    } }), validation);
    assert.deepEqual(await domain(w), before);
  }
});

test('input contributions cannot collide with actual canonical model-default identities', async () => {
  const source = artifact();
  source.operations![0]!.inputs.fields.find(input => input.name === 'label')!.name = `0:${MODEL}.label`;
  const w = await world({}, source), before = await domain(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await start(call, w); reportAll(call, w);
    await assert.rejects(session.finalize(), validation);
    return empty();
  } }), validation);
  assert.deepEqual(await domain(w), before);
});

test('default attribution snapshots admitted input references and hash without evaluating top-level accessors', async () => {
  for (const mode of ['input', 'ref', 'hash', 'getter'] as const) {
    const w = await world(), before = await domain(w); let getterCalls = 0;
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await start(call, w), hash = call.inputHash, ref = call.recordRefs[0]!.row;
      const input = call.inputs, oldLabel = ref.data['label'];
      const inputDescriptor = Object.getOwnPropertyDescriptor(call, 'inputs')!;
      if (mode === 'input') input['supplied'] = true;
      else if (mode === 'ref') (ref.data as Record<string, unknown>)['label'] = 'drifted admitted row';
      else if (mode === 'hash') call.inputHash = 'drifted hash';
      else Object.defineProperty(call, 'inputs', { enumerable: true, configurable: true,
        get: () => { getterCalls++; return input; } });
      assert.throws(() => observeScenarioInputComputedDefault(call, w.store, reports(w)[0]!), stateError);
      if (mode === 'input') input['supplied'] = false;
      else if (mode === 'ref') (ref.data as Record<string, unknown>)['label'] = oldLabel;
      else if (mode === 'hash') call.inputHash = hash;
      else Object.defineProperty(call, 'inputs', inputDescriptor);
      await assert.rejects(session.finalize(), validation);
      return empty();
    } }), validation);
    assert.equal(getterCalls, 0); assert.deepEqual(await domain(w), before);
  }
});

test('computed defaults require the active exact admitted call and an open owning session', async () => {
  for (const mode of ['before-begin', 'copied-call', 'after-finalize'] as const) {
    const w = await world(), before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      if (mode === 'before-begin') {
        observeScenarioInputComputedDefault(call, w.store, reports(w)[0]!);
        return empty();
      }
      const session = await start(call, w);
      if (mode === 'copied-call') {
        observeScenarioInputComputedDefault({ ...call }, w.store, reports(w)[0]!);
        return empty();
      }
      reportAll(call, w); const output = await session.finalize();
      assert.throws(() => observeScenarioInputComputedDefault(call, w.store, reports(w)[0]!), validation);
      return effects(output);
    } }), stateError);
    assert.deepEqual(await domain(w), before);
  }
});

test('caught input-hash drift retains the original rejected-receipt identity and replays without execution', async () => {
  const w = await world(), before = await domain(w); let executions = 0;
  let admitted: AdmittedCall | undefined, originalHash: string | undefined;
  const input = { ...w, execute: async (call: AdmittedCall) => {
    executions++; admitted = call; originalHash = call.inputHash;
    await start(call, w);
    call.inputHash = 'executor drift must not become receipt identity';
    assert.throws(() => observeScenarioInputComputedDefault(call, w.store, reports(w)[0]!), forbidden);
    return empty();
  } };
  await assert.rejects(invoke(input), forbidden);
  assert.ok(admitted); assert.ok(originalHash);
  const rejected = await w.store.readReceipt(receiptIdentityFor(admitted.context)); assert.ok(rejected);
  assert.equal(rejected.inputHash, originalHash); assert.equal(rejected.outcome.status, 'rejected');
  const revision = await w.store.readRevision();
  await assert.rejects(invoke(input), forbidden);
  assert.equal(executions, 1);
  assert.deepEqual(await w.store.readReceipt(rejected.identity), rejected);
  assert.equal(await w.store.readRevision(), revision); assert.deepEqual(await domain(w), before);
});

test('callable input style refuses own and inherited accessors without evaluation and leaves legacy defaults unacquired', async () => {
  for (const mode of ['own-getter', 'inherited-getter', 'hidden', 'invalid'] as const) {
    const source = artifact(), callable = source.callables![0]!; let getters = 0;
    Reflect.deleteProperty(callable, 'inputStyle');
    if (mode === 'inherited-getter') {
      const prototype = Object.create(Object.prototype);
      Object.defineProperty(prototype, 'inputStyle', { enumerable: true, get: () => { getters++; return 'parameters'; } });
      Object.setPrototypeOf(callable, prototype);
    } else if (mode === 'own-getter') {
      Object.defineProperty(callable, 'inputStyle', { enumerable: true, get: () => { getters++; return 'parameters'; } });
    } else Object.defineProperty(callable, 'inputStyle', { enumerable: mode !== 'hidden',
      value: mode === 'invalid' ? 'envelope' : 'parameters' });
    assert.throws(() => loadArtifactDescriptors(source, { by: 'members' }), error =>
      error instanceof IncompatibleArtifactError && error.reason === 'malformed_descriptor');
    assert.equal(getters, 0);
  }
  const source = artifact(); let findGetters = 0;
  Object.defineProperty(source.callables!, 'find', { get: () => { findGetters++; throw new Error('Unused array method'); } });
  assert.ok(loadArtifactDescriptors(source, { by: 'members' }).registry.has(OP));
  assert.equal(findGetters, 0);
  const legacy = artifact(); Reflect.deleteProperty(legacy.callables![0]!, 'inputStyle');
  const w = await world({}, legacy); let executions = 0;
  const input = { ...w, execute: async (call: AdmittedCall) => {
    executions++;
    const session = await start(call, w), output = await session.finalize();
    assert.deepEqual(Object.keys(output.resolvedDefaults).sort(), [`0:${MODEL}.label`, `0:${MODEL}.token`].sort());
    return effects(output);
  } };
  assert.equal((await invoke(input)).status, 'committed');
  const before = await domain(w), revision = await w.store.readRevision();
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(executions, 1);
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
});
