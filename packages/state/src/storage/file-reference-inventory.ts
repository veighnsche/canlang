import type { FrameworkFileReferenceField as Field, FrameworkFileReferenceModel,
  FrameworkFileReferenceProducer, FrameworkFilePayloadOrigin, FrameworkOpaqueFieldResolution, FrameworkOpaquePayloadOrigin,
  InstalledFileReferenceInventory, JudgmentSpec, ModelName, ReceiptError, ReceiptResultContext, StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readAssociationRow, readReceiptRow, createJudgmentReceiptContext,
  type AssociationRowData, type ReceiptRowData } from '../receipt/tables.js';
import { FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL, fanoutNavigationRowId,
  readFanoutOwnerScanRow, type FanoutNavigationData, type FanoutOwnerScanData } from '../fanout/navigation.js';
import { fanoutIntentRowId, fanoutChildRowId } from '../fanout/tables.js';
import { decodeValue } from '@canlang/values';
import { assertOpaqueDeliveryProfileMatch } from './opaque-file-declarations.js';

const string = Object.freeze({ kind: 'control', value: 'string' } as const);
const number = Object.freeze({ kind: 'control', value: 'number' } as const);
const nullableString = Object.freeze({ ...string, nullable: true } as const);
const nullableNumber = Object.freeze({ ...number, nullable: true } as const);
const result = Object.freeze({ kind: 'opaque', role: 'retained-result' } as const);
const filePayloadOrigin = Object.freeze({ kind: 'opaque', role: 'payload-origin', payloadField: 'result', optional: true } as const);
const deferred = Object.freeze({ kind: 'opaque', role: 'deferred-input' } as const);
type Fields<T> = { readonly [K in keyof T]-?: Field };
const errorFields = Object.freeze({ code: string, message: string } satisfies Fields<ReceiptError>);
const nullableError = Object.freeze({ kind: 'control', value: 'object', fields: errorFields, nullable: true } as const);
const association = { recordModel: string, recordId: string, field: string,
  deliveryId: string, source: string, revision: number } satisfies Fields<AssociationRowData>;
const receipt = { deliveryId: string, revision: number, status: string, result,
  error: nullableError, contentRef: nullableString, resultExpiresAtMs: nullableNumber, filePayloadOrigin } satisfies Fields<ReceiptRowData>;
const navigation = { owner: string, fanoutId: string, sourceOccurrence: string,
  handler: string, cohort: string, intentVersion: number,
  lastVisitedChildId: nullableString } satisfies Fields<FanoutNavigationData>;
const ownerScan = { owner: string, lastVisitedIntentId: nullableString } satisfies Fields<FanoutOwnerScanData>;

const models: readonly FrameworkFileReferenceModel[] = Object.freeze([
  [RECEIPT_ASSOCIATION_MODEL, association, 'receipt/tables', 'AssociationRowData'],
  [RECEIPT_MODEL, receipt, 'receipt/tables', 'ReceiptRowData'],
  [FANOUT_NAVIGATION_MODEL, navigation, 'fanout/navigation', 'FanoutNavigationData'],
  [FANOUT_OWNER_SCAN_MODEL, ownerScan, 'fanout/navigation', 'FanoutOwnerScanData'],
].map(([model, fields, module, declaration]) => Object.freeze({ model: model as ModelName,
  source: Object.freeze({ package: '@canlang/state', module: module as string, export: declaration as string }),
  fields: Object.freeze(fields as Readonly<Record<string, Field>>) })));

function invalid(message: string): never { throw new StateError('validation', `State File inventory: ${message}`); }

/** Shared bounded-copy budget (one detached inventory tree). */
interface InventoryCopyBudget {
  nodes: number;
  readonly active: Set<object>;
}

/** One entry in key order, with the StoredRow pre-S5 parent rule at depth 0. */
function copyInventoryJsonEntries(
  out: Record<string, unknown> | unknown[],
  node: object,
  keys: readonly (string | symbol)[],
  array: boolean,
  depth: number,
  budget: InventoryCopyBudget,
): void {
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) ||
        !descriptor.enumerable || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (node as unknown[]).length)) {
      return invalid('enumerable own data properties required.');
    }
    // StoredRow's pre-S5 parent omission/undefined means no parent.
    const member = depth === 0 && key === 'parent' && descriptor.value === undefined ? null :
      copyInventoryJsonPart(descriptor.value, depth + 1, budget);
    Object.defineProperty(out, key, { value: member,
      enumerable: true, writable: true, configurable: true });
  }
}

/** One detached node: primitives pass through, plain objects/arrays recurse. */
function copyInventoryJsonPart(node: unknown, depth: number, budget: InventoryCopyBudget): unknown {
  if (++budget.nodes > 20_000 || depth > 32) return invalid('JSON budget exceeded.');
  if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
  if (typeof node === 'number' && Number.isFinite(node)) return node;
  if (typeof node !== 'object' || node === null || budget.active.has(node)) return invalid('JSON data required.');
  const array = Array.isArray(node), proto = Object.getPrototypeOf(node);
  if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid('plain own data required.');
  const keys = Reflect.ownKeys(node);
  if (array && keys.length !== node.length + 1) return invalid('dense arrays required.');
  budget.active.add(node);
  const out: Record<string, unknown> | unknown[] = array ? [] : {};
  copyInventoryJsonEntries(out, node, keys, array, depth, budget);
  budget.active.delete(node);
  return out;
}

/** Detached bounded JSON data only; inspect descriptors before reading values. */
function copyJson(value: unknown): unknown {
  return copyInventoryJsonPart(value, 0, { nodes: 0, active: new Set<object>() });
}

function closed(value: unknown, fields: Readonly<Record<string, Field>>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('object required.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !Object.hasOwn(fields, key))) return invalid('unknown field.');
  for (const [key, field] of Object.entries(fields)) {
    checkClosedField(data, key, field);
  }
  return data;
}

/** One declared field: presence, then the control value shape. */
function checkClosedField(data: Record<string, unknown>, key: string, field: Field): void {
  if (!Object.hasOwn(data, key)) {
    if (field.kind === 'control' && field.optional === true || field.kind === 'opaque' && field.role === 'payload-origin' && field.optional === true) return;
    return invalid(`missing ${key}.`);
  }
  const member = data[key];
  if (field.kind === 'opaque') return;
  if (member === null && field.nullable === true) return;
  if (field.value === 'object') { closed(member, field.fields); return; }
  if (field.value === 'string-array' ? !Array.isArray(member) || member.some(item => typeof item !== 'string') :
      typeof member !== field.value || field.value === 'number' && !Number.isFinite(member)) return invalid(`invalid ${key}.`);
}

/** Intrinsic shape only: membership and retained intent authority require the actual owning join. */
function validateNavigation(row: StoredRow): void {
  const data = row.data as unknown as FanoutNavigationData;
  if (row.archivedAt !== null || row.parent !== null ||
      !Number.isSafeInteger(row.version) || !Number.isSafeInteger(data.intentVersion) || data.intentVersion < 1 ||
      data.owner === '' || data.sourceOccurrence === '' || data.handler === '' ||
      (data.cohort !== 'model' && data.cohort !== 'anchored-collection') ||
      data.fanoutId !== fanoutIntentRowId(data.sourceOccurrence, data.handler, data.cohort) ||
      row.id !== fanoutNavigationRowId(data.owner, data.fanoutId)) return invalid('navigation identity.');
  if (data.lastVisitedChildId !== null) {
    try {
      const parts = data.lastVisitedChildId.split('/');
      if (parts.length !== 5 || data.lastVisitedChildId !== fanoutChildRowId(
        data.sourceOccurrence, data.handler, decodeURIComponent(parts[4]!))) return invalid('navigation child position.');
    } catch { return invalid('navigation child position.'); }
  }
}

/** Shape validation grants no File-free proof, payload closure, owner, or cross-row authority. */
function validateRow(model: ModelName, value: StoredRow): void {
  const declaration = models.find(candidate => candidate.model === model);
  if (declaration === undefined) return invalid('unknown exact model.');
  const copied = copyJson(value) as Record<string, unknown>;
  if (typeof copied === 'object' && copied !== null && !Object.hasOwn(copied, 'parent')) copied.parent = null;
  const row = closed(copied, { id: string, version: number, created: number, updated: number,
    createdBy: string, updatedBy: string, archivedAt: nullableNumber, parent: deferred, data: deferred });
  if (row.id === '' || row.createdBy === '' || row.updatedBy === '' ||
      !Number.isInteger(row.version) || (row.version as number) < 1 ||
      (row.created as number) < 0 || (row.updated as number) < 0 ||
      row.archivedAt !== null && (row.archivedAt as number) < 0) return invalid('invalid row metadata.');
  if (row.parent !== null) closed(row.parent, { model: string, id: string });
  const data = closed(row.data, declaration.fields), stored = row as unknown as StoredRow;
  switch (model) {
    case RECEIPT_ASSOCIATION_MODEL: readAssociationRow(stored); break;
    case RECEIPT_MODEL: readReceiptRow(stored, originalReceiptContext(stored)); break;
    case FANOUT_NAVIGATION_MODEL: validateNavigation(stored); break;
    case FANOUT_OWNER_SCAN_MODEL: readFanoutOwnerScanRow(stored, data.owner as string); break;
  }
}

/** Decode only the frozen owning result context; current schemas never substitute. */
function originalReceiptContext(row: StoredRow): ReceiptResultContext | undefined {
  const binding = row.data.filePayloadOrigin as FrameworkFilePayloadOrigin | undefined;
  if (binding === undefined) return undefined;
  try {
    if (binding.origin.kind !== 'delivery-result' && binding.origin.kind !== 'delivery-skipped') return invalid('receipt requires its original delivery recipe.');
    const origin = binding.origin, declaration = origin.declaration;
    if (declaration.kind === 'judgment') {
      const specification = { ...declaration.specification,
        version: decodeValue('int', declaration.specification.version) } as JudgmentSpec;
      return createJudgmentReceiptContext(declaration.canonical, specification, declaration.valueTypes);
    }
    if (declaration.kind !== 'capability' && declaration.kind !== 'generation') return invalid('unknown original provider context.');
    return { source: origin.kind === 'delivery-skipped' ? origin.send.target : origin.intent.target, declaredResult: declaration.canonical.result,
      ...(declaration.kind === 'generation' ? { request: declaration.request } : {}) };
  } catch { return invalid('invalid original provider result context.'); }
}

/** Arguments have already passed bounded own-data copying; key order is immaterial. */
function sameData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>, keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameData(a[key], b[key]));
}

/** Receipt-owned physical projection only. Source authentication and all File
 * occurrence/fact correspondence are independently checked by guarded census. */
function resolveOpaqueField(model: ModelName, value: StoredRow, field: string, context: {
  readonly installed: InstalledFileReferenceInventory; readonly binding: FrameworkFilePayloadOrigin;
}): FrameworkOpaqueFieldResolution {
  if (model !== RECEIPT_MODEL || field !== 'result') return invalid('unknown receipt opaque field.');
  // No provider, reader, promise or live observation can participate in this
  // synchronous resolution. Thenables/accessors/functions fail the own JSON copy.
  const row = copyJson(value) as StoredRow;
  const copied = copyJson(context) as typeof context;
  const { stored, binding } = checkReceiptBinding(model, row, copied);
  const { origin, send, declarations } = checkReceiptLifetimeScope(copied, binding, row, model, field);
  checkReceiptSkippedGuard(stored, origin, send);
  const provider = checkReceiptProvider(declarations, origin);
  checkReceiptCaller(declarations, origin);
  checkReceiptAssociation(declarations, origin);
  const voidResult = checkReceiptProviderResult(provider, origin);
  let presence: 'value' | 'no-result';
  if (row.data.result === null) {
    if (stored.receipt.status === 'succeeded' && !voidResult) return invalid('successful nonvoid receipt requires its original result.');
    presence = 'no-result';
  } else {
    if (voidResult || stored.receipt.status === 'failed' || stored.receipt.status === 'skipped') return invalid('receipt result contradicts its owning phase.');
    // The owning receipt codec has checked supported pending/unknown rich
    // observations against the original TextRun/ImageRun/Judgment context.
    presence = 'value';
  }
  return { binding, values: [{ path: [], kind: 'result', declarationId: provider.id, presence }] };
}

type ReceiptOrigin = Extract<FrameworkOpaquePayloadOrigin, { kind: 'delivery-result' } | { kind: 'delivery-skipped' }>;
type NarrowedReceiptBinding = NonNullable<ReturnType<typeof readReceiptRow>['filePayloadOrigin']> & { origin: ReceiptOrigin };
type OpaqueDeclarationSet = NonNullable<InstalledFileReferenceInventory['inventory']['opaqueDeclarationSets']>[number];
type OpaqueDeclaration = OpaqueDeclarationSet['declarations'][number];

/** Persisted original receipt binding against its detached copy. */
function checkReceiptBinding(
  model: ModelName,
  row: StoredRow,
  copied: { readonly binding: FrameworkFilePayloadOrigin },
): { stored: ReturnType<typeof readReceiptRow>; binding: NarrowedReceiptBinding } {
  validateRow(model, row);
  const stored = readReceiptRow(row, originalReceiptContext(row)), binding = stored.filePayloadOrigin;
  if (binding === undefined || !sameData(binding, copied.binding) || (binding.origin.kind !== 'delivery-result' && binding.origin.kind !== 'delivery-skipped')) {
    return invalid('exact persisted original receipt binding required.');
  }
  // The kind check above proves the delivery-result/skipped origin.
  return { stored, binding: binding as NarrowedReceiptBinding };
}

/** Declaration set with receipt lifetime, scope and intent correspondence. */
function checkReceiptLifetimeScope(
  copied: { readonly binding: FrameworkFilePayloadOrigin; readonly installed: InstalledFileReferenceInventory },
  binding: NarrowedReceiptBinding,
  row: StoredRow,
  model: ModelName,
  field: string,
): { installed: InstalledFileReferenceInventory; origin: ReceiptOrigin;
  send: { readonly operation: string; readonly target: string };
  declarations: OpaqueDeclarationSet } {
  const { installed } = copied, origin = binding.origin;
  const send: { readonly operation: string; readonly target: string } =
    origin.kind === 'delivery-skipped' ? origin.send : origin.intent;
  const sets = installed.inventory.opaqueDeclarationSets?.filter(set => set.id === binding.declarationSetId);
  if (sets?.length !== 1) return invalid('one original receipt declaration set required.');
  const declarations = sets[0]!;
  if (!sameData(declarations.inventory, binding.inventory) || binding.inventory.owner !== installed.inventory.owner ||
      binding.scope.app !== installed.authority.app || binding.scope.owner !== installed.authority.receiver.owner) {
    return invalid('original receipt lifetime, scope or intent correspondence.');
  }
  checkReceiptSlotCorrespondence(binding, origin, send, row, model, field);
  return { installed, origin, send, declarations };
}

/** Slot, delivery and intent correspondence for one receipt binding. */
function checkReceiptSlotCorrespondence(
  binding: NarrowedReceiptBinding,
  origin: ReceiptOrigin,
  send: { readonly operation: string; readonly target: string },
  row: StoredRow,
  model: ModelName,
  field: string,
): void {
  if (binding.scope.ownerPackage !== binding.inventory.owner || binding.slot.id !== row.id || binding.slot.created !== row.created ||
      binding.slot.createdBy !== row.createdBy || binding.slot.model !== model || binding.slot.field !== field ||
      binding.slot.role !== 'retained-result' || origin.deliveryId !== row.id || (origin.kind === 'delivery-result' && origin.intent.intentId !== row.id) ||
      send.operation !== origin.caller.callable.id || send.operation !== origin.caller.canonical.name ||
      send.operation !== origin.caller.artifact.name ||
      send.target !== `${origin.declaration.canonical.capability}.${origin.declaration.canonical.operation}`) {
    return invalid('original receipt lifetime, scope or intent correspondence.');
  }
}

/** Skipped receipts carry their SEND guard with empty result content. */
function checkReceiptSkippedGuard(
  stored: ReturnType<typeof readReceiptRow>,
  origin: ReceiptOrigin,
  send: { readonly operation: string; readonly target: string },
): void {
  if (origin.kind === 'delivery-skipped' && (stored.receipt.status !== 'skipped' || stored.receipt.result !== null ||
      stored.receipt.error !== null || stored.contentRef !== null || stored.resultExpiresAtMs !== null ||
      origin.guard.owner !== send.operation || origin.guard.target !== send.target || origin.guard.binding !== origin.request.binding ||
      !sameData(origin.guard.source, origin.caller.source))) return invalid('original skipped receipt and SEND guard required.');
}

/** Original provider result declaration with its delivery context match. */
function checkReceiptProvider(declarations: OpaqueDeclarationSet, origin: ReceiptOrigin): OpaqueDeclaration {
  const providerProfiles = declarations.declarations.filter(profile => profile.id === origin.resultDeclarationId);
  if (providerProfiles.length !== 1) return invalid('one original provider result declaration required.');
  const provider = providerProfiles[0]!;
  if (provider.source.kind !== 'delivery' || !sameData(provider.source.source, origin.caller.source)) {
    return invalid('original provider context differs from the result declaration.');
  }
  assertOpaqueDeliveryProfileMatch(provider.source.context, origin.declaration);
  return provider;
}

/** Original caller declaration differs unless implicitly void. */
function checkReceiptCaller(declarations: OpaqueDeclarationSet, origin: ReceiptOrigin): OpaqueDeclaration {
  const callers = declarations.declarations.filter(profile => profile.id === origin.caller.resultDeclarationId);
  if (callers.length !== 1) return invalid('one original caller result declaration required.');
  const caller = callers[0]!;
  const implicitVoid = caller.profile.kind === 'void' && origin.caller.canonical.result === undefined &&
    origin.caller.artifact.result === undefined;
  if (caller.source.kind !== 'callable' || !sameData(caller.source.source, origin.caller.source) ||
      !sameData(caller.source.callable, origin.caller.callable) ||
      caller.profile.kind !== 'result' && caller.profile.kind !== 'void' ||
      !implicitVoid && (!sameData(caller.profile.canonical, origin.caller.canonical.result) ||
      !sameData(caller.profile.artifact, origin.caller.artifact.result))) return invalid('original calling declaration differs.');
  return caller;
}

/** Original association delivery against canonical and artifact models. */
function checkReceiptAssociation(declarations: OpaqueDeclarationSet, origin: ReceiptOrigin): void {
  const canonicalModels = declarations.canonicalModels.filter(candidate => candidate.name === origin.association.model);
  const artifactModels = declarations.artifactModels.filter(candidate => candidate.name === origin.association.model);
  if (canonicalModels.length !== 1 || artifactModels.length !== 1) return invalid('one original association model required.');
  const canonicalField = canonicalModels[0]!.fields[origin.association.field];
  const artifactFields = artifactModels[0]!.fields.filter(candidate => candidate.name === origin.association.field);
  if (canonicalField === undefined || artifactFields.length !== 1 || canonicalField.array !== undefined ||
      artifactFields[0]!.array !== undefined || artifactFields[0]!.field.kind !== 'delivery' ||
      !sameData(canonicalField.delivery, origin.declaration.canonical) ||
      !sameData(artifactFields[0]!.field, origin.declaration.artifact)) return invalid('original association delivery differs.');
}

/** Complete original provider result (void or matching canonical/artifact). */
function checkReceiptProviderResult(provider: OpaqueDeclaration, origin: ReceiptOrigin): boolean {
  const profile = provider.profile;
  const voidResult = profile.kind === 'void' && profile.canonical.type === 'void' && profile.artifact.type === 'void';
  if (!voidResult && (profile.kind !== 'provider-result' ||
      !sameData(profile.canonical, origin.declaration.canonical.result) ||
      !sameData(profile.artifact, origin.declaration.artifact.result))) return invalid('original complete provider result differs.');
  return voidResult;
}

export const STATE_FILE_REFERENCE_PRODUCER: FrameworkFileReferenceProducer = Object.freeze({ models, validateRow, resolveOpaqueField });
