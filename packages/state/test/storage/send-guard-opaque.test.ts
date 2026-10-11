/** Literal State declaration/traversal controls only; no native source or receiving File authority is attested. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FrameworkFilePayloadOrigin, FrameworkFileReferenceModel, FrameworkOpaqueDeclarationSet,
  FrameworkOpaqueSendGuardDeclaration, FileReferenceInventory, FileRetirementAuthority, OperationName, OperationId } from '@canlang/contracts';
import { normalizeValueTypes } from '@canlang/values';
import { bindOpaqueFileDeclarations, resolveOpaqueFileProjection, validateOpaqueFileOrigin } from '../../src/storage/opaque-file-declarations.js';
import { bindFileFrameworkProducers, emptyFileGuard, guardFileCommit, checkedFileInventory } from '../../src/storage/file-retirement.js';
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
