/** Literal State declaration/traversal controls only; no native source or receiving File authority is attested. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FrameworkFilePayloadOrigin, FrameworkFileReferenceModel, FrameworkOpaqueDeclarationSet,
  ArtifactModel, CanTypeId, CanonicalModelDescriptor, FrameworkOpaqueSendGuardDeclaration, FileReferenceInventory, FileRetirementAuthority, OperationName, OperationId } from '@canlang/contracts';
import { normalizeValueTypes } from '@canlang/values';
import { bindOpaqueFileDeclarations, resolveOpaqueFileProjection, validateOpaqueFileOrigin } from '../../src/storage/opaque-file-declarations.js';
import { bindFileFrameworkProducers, emptyFileGuard, guardFileCommit, checkedFileInventory } from '../../src/storage/file-retirement.js';
import { bindModelLexicalSnapshotProfile, modelLexicalSnapshotOccurrences } from '../../src/ports/model-lexical-snapshot.js';
import { asId, asModel, asRevision, makeRow } from '../invocation/fixtures.js';

const source = { path: 'guard.can', sha256: 'a'.repeat(64), module: 'guard.mjs' };
const identity = { owner: 'Guard', snapshotId: 'guard/original', digest: 'guard/digest' };
const guard = (): FrameworkOpaqueSendGuardDeclaration => ({ rule: 'Guard.send:guard:10', source: { ...source },
  owner: 'Guard.send', node: { start: 10, end: 30 }, binding: 'Guard.Images', target: 'std.ImagesV1.submit',
  inputs: [{ name: 'picture', type: 'file' }, { name: 'enabled', type: 'bool' }] });
function declarationSet(): FrameworkOpaqueDeclarationSet {
  return { id: 'guard/declarations', inventory: { ...identity }, snapshot: { ...identity, installedRevision: asRevision(0), installedAt: 100 },
    sources: [{ path: source.path, sha256: source.sha256 }], canonicalModels: [], artifactModels: [],
    valueTypes: structuredClone(normalizeValueTypes({ contracts: [] }).valueTypes), originalContracts: {}, valueDefaults: [],
    declarations: [{ id: 'guard/inputs', source: { kind: 'send-guard', ...guard() }, profile: { kind: 'inputs',
      canonical: [{ name: 'picture', kind: 'file', valueType: 'file', required: true },
        { name: 'enabled', kind: 'boolean', valueType: 'bool', required: true }],
      artifact: [{ name: 'picture', field: { kind: 'file' }, valueType: 'file', required: true },
        { name: 'enabled', field: { kind: 'boolean' }, valueType: 'bool', required: true }],
    } }] };
}
const admit = (set = declarationSet()) => bindOpaqueFileDeclarations([set], () => {}).get(set.id)!;
function binding(): FrameworkFilePayloadOrigin {
  return { version: 1, inventory: { ...identity }, declarationSetId: 'guard/declarations',
    slot: { model: asModel('Guard.Dispatch'), id: asId('dispatch'), created: 100, createdBy: 'caller', field: 'sourceGuard', role: 'deferred-input' },
    scope: { app: 'guard-app', ownerPackage: 'Guard', owner: 'guard-team' }, files: [], origin: { kind: 'send-guard',
      intent: { intentId: 'original-intent', operation: 'Guard.send' as OperationName, operationId: 'original-business' as OperationId,
        target: 'std.ImagesV1.submit', occurrenceIndex: 0, dispatchGuard: 'Guard.send:guard:10' },
      declaration: guard(), inputsDeclarationId: 'guard/inputs',
    } };
}

test('original send-guard declaration preserves exact ordered lexical inputs and traverses the actual inputs projection', () => {
  const bound = admit();
  validateOpaqueFileOrigin(bound, binding());
  assert.deepEqual(resolveOpaqueFileProjection(bound, { path: ['inputs'], kind: 'inputs', declarationId: 'guard/inputs' },
    { picture: { id: 'file-original' }, enabled: false }), [{ path: ['picture'], ref: 'file-original' }]);
  assert.ok(Object.isFrozen(bound.declarationSet.declarations[0]!.source));
  for (const value of [{ enabled: true }, { picture: { id: 'file-original' }, enabled: true, extra: true },
    { picture: { id: 'file-original' }, enabled: 'true' }, { picture: null, enabled: true }]) {
    assert.throws(() => resolveOpaqueFileProjection(bound, { path: ['inputs'], kind: 'inputs', declarationId: 'guard/inputs' }, value));
  }
  assert.throws(() => resolveOpaqueFileProjection(bound, { path: [], kind: 'inputs', declarationId: 'guard/inputs' },
    { picture: { id: 'file-original' }, enabled: true }));
});

test('send-guard declarations refuse invented callable metadata, reordered or missing slots, defaults and invalid original source', () => {
  for (const mode of ['callable', 'source', 'node', 'name', 'type', 'slots', 'order', 'default', 'optional'] as const) {
    const set = declarationSet(), entry = set.declarations[0]!;
    assert.equal(entry.source.kind, 'send-guard'); assert.equal(entry.profile.kind, 'inputs');
    if (entry.source.kind !== 'send-guard' || entry.profile.kind !== 'inputs') continue;
    if (mode === 'callable') Object.assign(entry.source, { callable: { id: 'Guard.send' } });
    if (mode === 'source') Object.assign(entry.source.source, { sha256: 'b'.repeat(64) });
    if (mode === 'node') Object.assign(entry.source.node, { end: 10 });
    if (mode === 'name') Object.assign(entry.source.inputs[1]!, { name: 'picture' });
    if (mode === 'type') Object.assign(entry.source.inputs[0]!, { type: 'file?' });
    if (mode === 'slots') (entry.profile.canonical as unknown[]).pop();
    if (mode === 'order') { (entry.profile.canonical as unknown[]).reverse(); (entry.profile.artifact as unknown[]).reverse(); }
    if (mode === 'default') {
      Object.assign(entry.profile.canonical[1]!, { default: { kind: 'literal', value: true } });
      Object.assign(entry.profile.artifact[1]!, { default: { kind: 'literal', value: true } });
    }
    if (mode === 'optional') { Object.assign(entry.profile.canonical[1]!, { required: false }); Object.assign(entry.profile.artifact[1]!, { required: false }); }
    assert.throws(() => admit(set), mode);
  }
});

test('original dispatch guard and selected input declaration cannot be replaced by matching current spellings', () => {
  const bound = admit();
  for (const mode of ['dispatch-guard', 'owner', 'target', 'declaration', 'binding', 'source', 'interval'] as const) {
    const input = binding(); assert.equal(input.origin.kind, 'send-guard');
    if (input.origin.kind !== 'send-guard') continue;
    if (mode === 'dispatch-guard') Object.assign(input.origin.intent, { dispatchGuard: 'other-rule' });
    if (mode === 'owner') Object.assign(input.origin.intent, { operation: 'Other.send' });
    if (mode === 'target') Object.assign(input.origin.intent, { target: 'std.TextGenerationV1.generate' });
    if (mode === 'declaration') Object.assign(input.origin, { inputsDeclarationId: 'missing/inputs' });
    if (mode === 'binding') Object.assign(input.origin.declaration, { binding: 'Guard.OtherImages' });
    if (mode === 'source') Object.assign(input.origin.declaration.source, { module: 'current-guard.mjs' });
    if (mode === 'interval') Object.assign(input.origin.declaration.node, { start: 11 });
    assert.throws(() => validateOpaqueFileOrigin(bound, input), mode);
  }
  const mutable = declarationSet(), original = binding(), captured = admit(mutable);
  Object.assign(mutable.declarations[0]!.source, { binding: 'changed-after-binding' });
  validateOpaqueFileOrigin(captured, original);
});

test('only absent optional deferred payloads may skip census; present values and orphan origin headers refuse', () => {
  const declaration: FrameworkFileReferenceModel = { model: asModel('Fixture.Dispatch'),
    source: { package: 'fixture', module: 'dispatch', export: 'DispatchData' }, fields: {
      sourceGuard: { kind: 'opaque', role: 'deferred-input', optional: true },
      sourceGuardOrigin: { kind: 'opaque', role: 'payload-origin', payloadField: 'sourceGuard', optional: true },
    } };
  const framework = bindFileFrameworkProducers([{ models: [declaration], validateRow: () => {} }]);
  const inventory: FileReferenceInventory = { ...identity, canonicalModels: [], artifactModels: [], frameworkModels: [declaration],
    valueTypes: structuredClone(normalizeValueTypes({ contracts: [] }).valueTypes) };
  checkedFileInventory(inventory, framework);
  const authority: FileRetirementAuthority = { app: 'fixture-app', stateOwner: 'fixture-owner', stateStoreId: 'fixture-state', fileStoreId: 'fixture-files',
    receiver: { app: 'fixture-app', team: 'fixture-team', owner: 'fixture-team' } };
  const state = { ...emptyFileGuard(), authority, inventories: [{ authority, inventory,
    snapshot: { ...identity, installedRevision: asRevision(0), installedAt: 100 } }] };
  const check = (data: Record<string, unknown>) => guardFileCommit(state, authority, [], [{ model: declaration.model, row: makeRow({ data }) }], framework);
  assert.equal(check({}).opaqueLifetimes.length, 0);
  for (const data of [{ sourceGuard: undefined }, { sourceGuard: null }, { sourceGuard: {} },
    { sourceGuardOrigin: {} }, { sourceGuard: {}, sourceGuardOrigin: {} }]) assert.throws(() => check(data));
  for (const field of [{ kind: 'opaque', role: 'retained-result', optional: true },
    { kind: 'opaque', role: 'deferred-input', optional: false }]) {
    assert.throws(() => bindFileFrameworkProducers([{ models: [{ ...declaration, fields: { sourceGuard: field } } as unknown as FrameworkFileReferenceModel], validateRow: () => {} }]));
  }
});


function modelSnapshotSet(): FrameworkOpaqueDeclarationSet {
  const set = declarationSet(), model = asModel('Guard.Run');
  const fields: ArtifactModel['fields'] = [
    { name: 'packet', field: { kind: 'nominal', name: 'Guard.Packet' }, valueType: 'Guard.Packet' as CanTypeId, required: true, serverOnly: false },
    { name: 'hidden', field: { kind: 'secret' }, valueType: 'secret' as CanTypeId, required: false, serverOnly: true },
  ];
  const canonical: CanonicalModelDescriptor = { name: model, deleteMode: 'remove', fields: Object.fromEntries(fields.map(({ name, field: _field, ...value }) => [name, value])) };
  Object.assign(set, { canonicalModels: [canonical], artifactModels: [{ name: model, deleteMode: 'remove', fields }],
    valueTypes: structuredClone(normalizeValueTypes({ contracts: [{ name: 'Guard.Packet', fields: [
      { name: 'photo', type: 'file' }, { name: 'photos', type: 'file[]' },
    ] }] }, [model]).valueTypes),
    originalContracts: { 'Guard.Packet': { fields: { photo: { type: 'file' }, photos: { type: 'file', array: true } } } },
  });
  const entry = set.declarations[0]!;
  assert.equal(entry.source.kind, 'send-guard'); assert.equal(entry.profile.kind, 'inputs');
  if (entry.source.kind !== 'send-guard' || entry.profile.kind !== 'inputs') throw new Error('fixture');
  Object.assign(entry.source, { inputs: [{ name: 'run', type: model }] });
  Object.assign(entry.profile, {
    canonical: [{ name: 'run', kind: 'ref', model, versioned: false, required: true }],
    artifact: [{ name: 'run', field: { kind: 'ref', model, requireVersion: false }, required: true }],
  });
  return set;
}
const snapshotProjection = { path: ['inputs'], kind: 'inputs' as const, declarationId: 'guard/inputs' };
const modelSnapshot = () => ({ ...makeRow({ data: { packet: { photo: { id: 'one' }, photos: [{ id: 'two' }] } } }), parent: null });

function nullableModelRefSet(exactValueType = false, nestedFiles = true): FrameworkOpaqueDeclarationSet {
  const set = modelSnapshotSet(), entry = set.declarations[0]!, model = asModel('Guard.Run');
  if (entry.source.kind !== 'send-guard' || entry.profile.kind !== 'inputs') throw new Error('fixture');
  Object.assign(entry.source, { inputs: [{ name: 'run', type: 'Guard.Run?' }, { name: 'packet', type: 'Guard.Packet' }] });
  Object.assign(entry.profile, {
    canonical: [{ name: 'run', kind: 'ref', model, versioned: true, required: true, nullable: true },
      { name: 'packet', kind: 'nominal', valueType: 'Guard.Packet', required: true }],
    artifact: [{ name: 'run', field: { kind: 'ref', model, requireVersion: true }, required: true, nullable: true,
      ...(exactValueType ? { valueType: 'Guard.Run?' } : {}) },
      { name: 'packet', field: { kind: 'nominal', name: 'Guard.Packet' }, valueType: 'Guard.Packet', required: true }],
  });
  if (!nestedFiles) {
    Object.assign(entry.source, { inputs: entry.source.inputs.slice(0, 1) });
    Object.assign(entry.profile, { canonical: entry.profile.canonical.slice(0, 1), artifact: entry.profile.artifact.slice(0, 1) });
  }
  return set;
}

test('nullable SEND model inputs retain canonical versioned refs and the separate nested File census', () => {
  for (const exactValueType of [false, true]) {
    const bound = admit(nullableModelRefSet(exactValueType)), refsOnly = admit(nullableModelRefSet(exactValueType, false));
    for (const run of [{ id: 'ref', version: '1' }, null]) {
      assert.deepEqual(resolveOpaqueFileProjection(bound, snapshotProjection,
        { run, packet: { photo: { id: 'one' }, photos: [{ id: 'two' }] } }), [
        { path: ['packet', 'photo'], ref: 'one' },
        { path: ['packet', 'photos', 0], ref: 'two' },
      ]);
      assert.deepEqual(resolveOpaqueFileProjection(refsOnly, snapshotProjection, { run }), []);
    }
  }
});

test('nullable SEND model refs refuse absent required slots, invalid versions and snapshot-shaped values', () => {
  const bound = admit(nullableModelRefSet()), packet = { photo: { id: 'one' }, photos: [] };
  assert.throws(() => resolveOpaqueFileProjection(bound, snapshotProjection, { packet }));
  for (const run of [undefined, { id: 'ref' }, { id: 'ref', version: undefined },
    { id: 'ref', version: null }, { id: 'ref', version: '' }, { id: 'ref', version: 0 },
    { id: 'ref', version: '1', extra: true }, modelSnapshot()]) {
    assert.throws(() => resolveOpaqueFileProjection(bound, snapshotProjection, { run, packet }));
  }
});

test('nullable SEND model ref profiles require exact nullable and original source correspondence', () => {
  for (const mode of ['source', 'canonical-nullable', 'artifact-nullable', 'missing-nullable', 'value-type', 'version'] as const) {
    const set = nullableModelRefSet(true), entry = set.declarations[0]!;
    if (entry.source.kind !== 'send-guard' || entry.profile.kind !== 'inputs') throw new Error('fixture');
    if (mode === 'source') Object.assign(entry.source.inputs[0]!, { type: 'Guard.Run' });
    if (mode === 'canonical-nullable') Object.assign(entry.profile.canonical[0]!, { nullable: false });
    if (mode === 'artifact-nullable') Object.assign(entry.profile.artifact[0]!, { nullable: false });
    if (mode === 'missing-nullable') delete (entry.profile.artifact[0]! as { nullable?: boolean }).nullable;
    if (mode === 'value-type') Object.assign(entry.profile.artifact[0]!, { valueType: 'Guard.Run' });
    if (mode === 'version') Object.assign(entry.profile.artifact[0]!.field, { requireVersion: false });
    assert.throws(() => admit(set), mode);
  }
});

test('SEND model lexical snapshots census nested Files while partial projected fields remain absent', () => {
  const bound = admit(modelSnapshotSet());
  assert.deepEqual(resolveOpaqueFileProjection(bound, snapshotProjection, { run: modelSnapshot() }), [
    { path: ['run', 'data', 'packet', 'photo'], ref: 'one' },
    { path: ['run', 'data', 'packet', 'photos', 0], ref: 'two' },
  ]);
  assert.deepEqual(resolveOpaqueFileProjection(bound, snapshotProjection, { run: { ...modelSnapshot(), data: {} } }), []);
  for (const wire of [{ id: 'bare-reference' }, { ...modelSnapshot(), archivedAt: 10 },
    { ...modelSnapshot(), version: 0 }, { ...modelSnapshot(), extra: true },
    { ...modelSnapshot(), parent: { model: 'Guard.Other', id: 'parent' } },
    { ...modelSnapshot(), data: { extra: { id: 'untyped' } } },
    { ...modelSnapshot(), data: { hidden: 'secret' } },
    { ...modelSnapshot(), data: { packet: { photo: { id: 'one' }, photos: ['not-a-file'] } } }]) {
    assert.throws(() => resolveOpaqueFileProjection(bound, snapshotProjection, { run: wire }));
  }
});

test('model lexical profile retains exact containment and refuses copied profiles and namespace collisions', () => {
  const set = modelSnapshotSet(), root = set.artifactModels[0]!;
  const parent = asModel('Guard.Parent');
  Object.assign(root, { parent });
  Object.assign(set, { artifactModels: [...set.artifactModels, { name: parent, fields: [], deleteMode: 'remove' }],
    canonicalModels: [...set.canonicalModels, { name: parent, fields: {}, deleteMode: 'remove' }] });
  const values = { artifactModels: new Map(set.artifactModels.map(model => [asModel(model.name), model])),
    canonicalModels: set.canonicalModels, valueTypes: set.valueTypes };
  const profile = bindModelLexicalSnapshotProfile(values, asModel('Guard.Run'))!;
  assert.deepEqual(modelLexicalSnapshotOccurrences(profile, { ...modelSnapshot(), parent: { model: parent, id: 'parent' }, data: {} }), []);
  assert.throws(() => modelLexicalSnapshotOccurrences(profile, modelSnapshot()));
  assert.throws(() => modelLexicalSnapshotOccurrences({ ...profile }, modelSnapshot()));
  assert.equal(bindModelLexicalSnapshotProfile(values, 'file' as CanTypeId), undefined);
  const mismatched = structuredClone(set.canonicalModels);
  Object.assign(mismatched[0]!.fields.packet!, { valueType: 'text' });
  assert.throws(() => bindModelLexicalSnapshotProfile({ ...values, canonicalModels: mismatched }, 'Guard.Run' as CanTypeId));
  const unsupported = modelSnapshotSet();
  const unknown = 'Guard.Unknown' as CanTypeId;
  Object.assign(unsupported.artifactModels[0]!, { fields: [...unsupported.artifactModels[0]!.fields,
    { name: 'untyped', field: { kind: 'nominal', name: unknown }, valueType: unknown, required: false, serverOnly: false }] });
  Object.assign(unsupported.canonicalModels[0]!, { fields: { ...unsupported.canonicalModels[0]!.fields,
    untyped: { valueType: unknown, required: false, serverOnly: false } } });
  assert.throws(() => admit(unsupported));
  assert.throws(() => bindModelLexicalSnapshotProfile(values, 'Guard.Run?' as CanTypeId));
  assert.throws(() => bindModelLexicalSnapshotProfile({ ...values, valueTypes: { contracts: [
    ...set.valueTypes.contracts, { name: 'Guard.Run', fields: [] },
  ] } }, 'Guard.Run' as CanTypeId));
  // Ordinary callable references retain their existing ModelRef wire semantics.
  const ordinary = modelSnapshotSet(), entry = ordinary.declarations[0]!;
  Object.assign(entry, { source: { kind: 'callable', source, callable: {
    id: 'Guard.send', kind: 'operation', module: source.module, export: 'canApp', member: ['send'],
  } } });
  const bound = admit(ordinary);
  assert.deepEqual(resolveOpaqueFileProjection(bound, { ...snapshotProjection, path: [] }, { run: { id: 'model-ref' } }), []);
  assert.throws(() => resolveOpaqueFileProjection(bound, { ...snapshotProjection, path: [] }, { run: modelSnapshot() }));
});
