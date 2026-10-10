import { describe, expect, it } from "vitest";
import type * as barrel from "../src/index.js";
import type * as files from "../src/files.js";
import type * as presentation from "../src/presentation.js";
import type * as services from "../src/services.js";
import type * as state from "../src/state.js";
import type * as wire from "../src/wire.js";

type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

// Interim conflict picks (see index.ts header + lane-07 status handoffs).
// Each line fails to compile if its barrel pick drifts; DELETE the line
// (not the pins) when the owning lanes reconcile the definition.
const operationIdIsState: Equal<barrel.OperationId, state.OperationId> = true;
const deliveryStatusIsServices: Equal<barrel.DeliveryStatus, services.DeliveryStatus> = true;

// Reconciled identities (L4 S8): files.ts re-exports both names from wire,
// so the barrel needs no explicit line — but if either side ever diverges
// again, the name silently drops from the barrel. Each pair fails loudly.
const fileTransferMetaIsWire: Equal<barrel.FileTransferMeta, wire.FileTransferMeta> = true;
const fileTransferMetaIsFiles: Equal<barrel.FileTransferMeta, files.FileTransferMeta> = true;
const uploadIntentRequestIsWire: Equal<barrel.UploadIntentRequest, wire.UploadIntentRequest> = true;
const uploadIntentRequestIsFiles: Equal<barrel.UploadIntentRequest, files.UploadIntentRequest> = true;

// Re-export identities (L5 S4): presentation re-exports these wire types.
// Same-symbol re-exports are NOT ambiguous under `export *` (identical
// resolutions collapse), so the barrel needs no explicit line — but if L5
// ever replaces a re-export with a divergent local definition, the name
// silently drops from the barrel. Each pair fails loudly on that day.
const businessErrorIsWire: Equal<barrel.BusinessError, wire.BusinessError> = true;
const businessErrorIsPresentation: Equal<barrel.BusinessError, presentation.BusinessError> = true;
const fieldErrorIsWire: Equal<barrel.FieldError, wire.FieldError> = true;
const fieldErrorIsPresentation: Equal<barrel.FieldError, presentation.FieldError> = true;
const mutationRefIsWire: Equal<barrel.MutationRef, wire.MutationRef> = true;
const mutationRefIsPresentation: Equal<barrel.MutationRef, presentation.MutationRef> = true;
const sealedHandleIsWire: Equal<barrel.SealedActionHandle, wire.SealedActionHandle> = true;
const sealedHandleIsPresentation: Equal<barrel.SealedActionHandle, presentation.SealedActionHandle> =
  true;

// Re-export identity (L5 C8): presentation re-exports HistoryEntry from state
// (same symbol, collapses under `export *` — pinned so a future divergent
// local definition fails loudly instead of silently dropping the name).
const historyEntryIsState: Equal<barrel.HistoryEntry, state.HistoryEntry> = true;
const historyEntryIsPresentation: Equal<barrel.HistoryEntry, presentation.HistoryEntry> = true;

const opaquePublicIdentities: [
  Equal<barrel.FrameworkFileReferenceProducer, state.FrameworkFileReferenceProducer>,
  Equal<barrel.FrameworkOpaqueFieldResolution, state.FrameworkOpaqueFieldResolution>,
  Equal<barrel.FrameworkFilePayloadOrigin, state.FrameworkFilePayloadOrigin>,
  Equal<barrel.FrameworkOpaquePayloadOrigin, state.FrameworkOpaquePayloadOrigin>,
  Equal<barrel.FrameworkOpaqueDeclaration, state.FrameworkOpaqueDeclaration>,
  Equal<barrel.FrameworkOpaqueDeclarationSet, state.FrameworkOpaqueDeclarationSet>,
  Equal<barrel.FrameworkOpaqueValueDefault, state.FrameworkOpaqueValueDefault>,
  Equal<barrel.FrameworkOpaqueValueProjection, state.FrameworkOpaqueValueProjection>,
  Equal<barrel.FrameworkOpaqueCallable, state.FrameworkOpaqueCallable>,
  Equal<barrel.FrameworkOpaqueDeliveryContext, state.FrameworkOpaqueDeliveryContext>,
  Equal<barrel.FrameworkOpaqueJudgmentSpec, state.FrameworkOpaqueJudgmentSpec>,
  Equal<barrel.RetainedFinalizedFile, files.RetainedFinalizedFile>,
] = [true, true, true, true, true, true, true, true, true, true, true, true];

// Compile-only declaration controls. No fixture below authenticates an issuer,
// owning producer, persisted binding or permission to reuse a File.
function opaquePublicShapeControls(binding: barrel.FrameworkFilePayloadOrigin,
  resolution: barrel.FrameworkOpaqueFieldResolution, source: barrel.ScenarioReceiptSourceOrigin,
  callable: barrel.ArtifactCallable, resultType: barrel.CanTypeId,
  retained: barrel.RetainedFinalizedFile, judgment: barrel.JudgmentSpec,
  judgmentContext: Extract<barrel.FrameworkOpaqueDeliveryContext, { kind: 'judgment' }>,
  committedDescriptor: barrel.ArtifactCommittedChangeDescriptor, change: barrel.CommittedChangeEvent,
  completion: barrel.FrameworkOpaqueStandardCompletionOrigin,
  declarationSet: barrel.FrameworkOpaqueDeclarationSet) {
  const legacy: barrel.FrameworkFileReferenceProducer = { models: [], validateRow() {} };
  const synchronous: NonNullable<barrel.FrameworkFileReferenceProducer['resolveOpaqueField']> =
    (_model, _row, _field, context) => ({ binding: context.binding, values: resolution.values });
  // @ts-expect-error Resolution must remain synchronous inside the State transaction.
  const asynchronous: NonNullable<barrel.FrameworkFileReferenceProducer['resolveOpaqueField']> = async () => resolution;
  const declaration: barrel.FrameworkOpaqueDeclaration = { id: 'original-result',
    source: { kind: 'callable', source, callable },
    profile: { kind: 'result', canonical: { type: resultType }, artifact: { type: resultType } } };
  const explicitVoid: barrel.FrameworkOpaqueDeclaration = { ...declaration,
    profile: { kind: 'void', canonical: { type: 'void' }, artifact: { type: 'void' } } };
  const original: barrel.FrameworkFilePayloadOrigin = { ...binding,
    slot: { ...binding.slot, created: 123, createdBy: 'original-actor' },
    files: [{ path: ['attachment', 0], file: retained }],
    origin: { kind: 'event-input', occurrenceId: binding.slot.id as barrel.OccurrenceId,
      sourceOccurrence: binding.slot.id as barrel.OccurrenceId,
      declaration: { kind: 'declared-event', source, event: 'Owner.event', inputsDeclarationId: 'original-inputs' },
      lineage: { kind: 'schedule', key: 'original-key', replaces: null }, target: { kind: 'schedule' } } };
  const noResult: barrel.FrameworkOpaqueValueProjection = { path: [], kind: 'result',
    declarationId: explicitVoid.id, presence: 'no-result' };
  const { scope: _scope, ...withoutScope } = binding;
  // @ts-expect-error Original scope is required even for empty or null payloads.
  const missingScope: barrel.FrameworkFilePayloadOrigin = withoutScope;
  const { files: _files, ...withoutFiles } = binding;
  // @ts-expect-error Original receiving File evidence must be explicitly represented.
  const missingFiles: barrel.FrameworkFilePayloadOrigin = withoutFiles;
  const { created: _created, ...withoutCreated } = binding.slot;
  // @ts-expect-error A current version cannot replace the original slot lifetime.
  const missingLifetime: barrel.FrameworkFilePayloadOrigin = { ...binding, slot: withoutCreated };
  // @ts-expect-error A ref string is not original finalized-file evidence.
  const refOnly: barrel.FrameworkFilePayloadOrigin = { ...binding, files: [{ path: [], file: { ref: retained.ref } }] };
  // @ts-expect-error A generic origin cannot replace the source-derived union.
  const genericOrigin: barrel.FrameworkFilePayloadOrigin = { ...binding, origin: { kind: 'result', declarationId: 'original' } };
  // @ts-expect-error Null is not original source correspondence.
  const nullOrigin: barrel.FrameworkFilePayloadOrigin = { ...binding, origin: null };
  // @ts-expect-error A source tag does not establish the complete event declaration.
  const taggedEvent: barrel.FrameworkOpaqueEventDeclaration = { kind: 'declared-event', event: 'Owner.event' };
  // @ts-expect-error Result declarations require both actual canonical and artifact evidence.
  const implicitResult: barrel.FrameworkOpaqueDeclaration = { ...declaration, profile: { kind: 'result' } };
  // @ts-expect-error Missing result metadata cannot be reinterpreted as void.
  const implicitVoid: barrel.FrameworkOpaqueDeclaration = { ...declaration, profile: { kind: 'void' } };
  // @ts-expect-error No-result projections still require explicit phase/presence evidence.
  const implicitAbsence: barrel.FrameworkOpaqueValueProjection = { path: [], kind: 'result', declarationId: 'original' };
  const wireJudgment: barrel.FrameworkOpaqueJudgmentSpec = { ...judgment, version: '1' };
  const orderedJudgment: barrel.FrameworkOpaqueDeliveryContext = { ...judgmentContext,
    specification: wireJudgment, order: ['question-one', 'question-two'] };
  // @ts-expect-error Decoded bigint versions cannot enter persisted JSON specification.
  const bigintJudgment: barrel.FrameworkOpaqueJudgmentSpec = judgment;
  // @ts-expect-error Judgment delivery context requires the wire specification too.
  const decodedContext: barrel.FrameworkOpaqueDeliveryContext = { ...judgmentContext, specification: judgment };
  const { order: _order, ...withoutOrder } = judgmentContext;
  // @ts-expect-error Original interleaved question order is mandatory.
  const unorderedJudgment: barrel.FrameworkOpaqueDeliveryContext = withoutOrder;
  const rawCommitted: barrel.FrameworkOpaqueEventDeclaration = { kind: 'committed-change', source,
    descriptor: committedDescriptor, change, projectionInputsDeclarationId: 'checked-handler-projection' };
  // @ts-expect-error Raw committed source is not the declared-event input projection.
  const wrongProjectionName: barrel.FrameworkOpaqueEventDeclaration = { kind: 'committed-change', source, descriptor: committedDescriptor, change, inputsDeclarationId: 'checked-handler-projection' };
  const terminal: barrel.FrameworkOpaqueStandardCompletionOrigin['terminal'] = { ...completion.terminal, status: 'succeeded' };
  // @ts-expect-error Standard completion cannot retain a pending terminal status.
  const pendingTerminal: barrel.FrameworkOpaqueStandardCompletionOrigin['terminal'] = { ...completion.terminal, status: 'pending' };
  const noValueDefaults: barrel.FrameworkOpaqueDeclarationSet = { ...declarationSet, valueDefaults: [] };
  const literalValueDefaults: barrel.FrameworkOpaqueDeclarationSet = { ...declarationSet, valueDefaults: [
    { contract: 'Original', field: 'nullable', value: null },
    { contract: 'Original', field: 'collection', value: [] },
    { contract: 'Original', field: 'enabled', value: false },
    { contract: 'Original', field: 'label', value: '' },
  ] };
  const { valueDefaults: _defaults, ...withoutDefaults } = declarationSet;
  // @ts-expect-error Missing historical collection is not complete empty default evidence.
  const omittedDefaults: barrel.FrameworkOpaqueDeclarationSet = withoutDefaults;
  // @ts-expect-error A default needs its original owning contract.
  const noDefaultContract: barrel.FrameworkOpaqueValueDefault = { field: 'label', value: '' };
  // @ts-expect-error A default needs its original owning field.
  const noDefaultField: barrel.FrameworkOpaqueValueDefault = { contract: 'Original', value: '' };
  // @ts-expect-error Omission cannot substitute for an explicit null/empty/false wire literal.
  const noDefaultValue: barrel.FrameworkOpaqueValueDefault = { contract: 'Original', field: 'label' };
  // @ts-expect-error Decoded bigint is not the original JSON wire literal.
  const decodedDefault: barrel.FrameworkOpaqueValueDefault = { contract: 'Original', field: 'count', value: 1n };
  // @ts-expect-error Executable defaults are not persisted literal wire values.
  const executableDefault: barrel.FrameworkOpaqueValueDefault = { contract: 'Original', field: 'label', value: () => '' };
  return { legacy, synchronous, asynchronous, declaration, explicitVoid, original, noResult,
    missingScope, missingFiles, missingLifetime, refOnly, genericOrigin, nullOrigin, taggedEvent,
    implicitResult, implicitVoid, implicitAbsence, wireJudgment, orderedJudgment, bigintJudgment,
    decodedContext, unorderedJudgment, rawCommitted, wrongProjectionName, terminal, pendingTerminal,
    noValueDefaults, literalValueDefaults, omittedDefaults, noDefaultContract, noDefaultField,
    noDefaultValue, decodedDefault, executableDefault };
}

describe("assembly conflict picks", () => {
  it("pins the synchronous opaque framework public declarations", () => {
    expect(opaquePublicIdentities).toEqual(Array(12).fill(true));
  });
  it("pins interim picks until owners reconcile", () => {
    expect([
      operationIdIsState,
      deliveryStatusIsServices,
      fileTransferMetaIsWire,
      fileTransferMetaIsFiles,
      uploadIntentRequestIsWire,
      uploadIntentRequestIsFiles,
      businessErrorIsWire,
      businessErrorIsPresentation,
      fieldErrorIsWire,
      fieldErrorIsPresentation,
      mutationRefIsWire,
      mutationRefIsPresentation,
      sealedHandleIsWire,
      sealedHandleIsPresentation,
      historyEntryIsState,
      historyEntryIsPresentation,
    ]).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });


});
