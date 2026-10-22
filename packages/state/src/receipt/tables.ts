/**
 * T25-L3 receipt join: stored association/receipt rows (L3 side).
 *
 * Structural L3 encodings of the T25a `ReceiptAssociation` /
 * `AssociatedReceipt` shapes (contracts `work.ts`) as versioned domain
 * rows in the REAL store. Lane 3 must not runtime-import lane 4 (the
 * T24a precedent), so model names, id derivations, row shapes and the
 * completion-consistency rule are structural mirrors, never imports;
 * a work-side conformance pin is future work (T34-F2 owns
 * `work/src/kernel/tables.ts`, which carries no association/receipt
 * tables yet).
 *
 * - Association row: one per (owner model, record, delivery field); id
 *   `receipt-assoc/v1/<model>/<record>/<field>`. Replacement is an
 *   ordinary versioned update selecting a new delivery id; the
 *   superseded attempt keeps its own receipt row.
 * - Receipt row: one per delivery attempt; id = delivery id. Carries
 *   the retained status/result/error plus the result-retention fields
 *   (`contentRef`, `resultExpiresAtMs`) the join's content port reads.
 *
 * `assertReceiptJoin` runs BEFORE the store (fail closed, `StateError`
 * validation); row readers throw loud `ReceiptTableError`s on stored
 * corruption, never guesses.
 */
import type {
  AssociatedReceipt,
  ReceiptAssociation,
  ReceiptError,
  ReceiptStatus,
  ReceiptResultContext,
  CanonicalNominalResult,
  TextRunResultLeaf,
  TextRunReceiptProperty,
  CanonicalJudgmentDeliveryDescriptor,
  CanonicalValueTypes,
  JudgmentSpec,
  FrameworkFilePayloadOrigin,
} from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES, GENERATED_IMAGE_FIELDS } from '@canlang/contracts';
import { decodeValue, encodeValue, normalizeSchema, normalizeValueTypes, parseTypeId, validateValue } from '@canlang/values';
import type { CanValue } from '@canlang/values';
import type {
  CommitBatch,
  CommitResult,
  ModelName,
  RecordId,
  RecordVersion,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import { StateError, storageToStateError } from '../errors.js';

/** Fail-closed table errors; stored corruption surfaces loudly, never guessed. */
export class ReceiptTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptTableError';
  }
}

/**
 * Stored current-attempt association rows. A STRUCTURAL literal, not an
 * import: lane 3 must not runtime-import lane 4 (`@canlang/work` owns
 * the `work.*` namespace), so the join matches rows by model name plus
 * the flat data fields below.
 */
export const RECEIPT_ASSOCIATION_MODEL = 'work.receipt_association';

/** Retained receipt rows, one per delivery attempt. See above. */
export const RECEIPT_MODEL = 'work.receipt';

/** Current-attempt association for one (record, delivery field). Flat. */
export interface AssociationRowData {
  readonly recordModel: string;
  readonly recordId: string;
  readonly field: string;
  /** Current attempt's delivery id; completions carry it as `delivery_id`. */
  readonly deliveryId: string;
  /** Canonical source identity (declaration/binding of the send). */
  readonly source: string;
  /** Owner checkpoint revision of the latest applied receipt progress. */
  readonly revision: number;
}

/**
 * Retained receipt row: the T25a `AssociatedReceipt` plus result
 * retention. `contentRef` is null when no separately-retained content
 * exists (inline/genuinely-null result); `resultExpiresAtMs` is the
 * instant the separately-retained result expires, or null when the
 * result is retained with the summary.
 */
export interface ReceiptRowData {
  readonly deliveryId: string;
  readonly revision: number;
  readonly status: ReceiptStatus;
  readonly result: unknown;
  readonly error: ReceiptError | null;
  readonly contentRef: string | null;
  readonly resultExpiresAtMs: number | null;
  /** Original owning evidence; persistence supplies no issuer or File authority. */
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
}

const RECEIPT_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'succeeded',
  'failed',
  'unknown',
  'skipped',
]);

/** Closed selectors derived from the one owning nominal declaration. */
export const TEXT_RUN_RECEIPT_PROPERTIES: readonly TextRunReceiptProperty[] = Object.freeze(
  DELIVERY_RESULT_LEAVES['TextRun']!.map(leaf => `result.${leaf.name}` as TextRunReceiptProperty),
);

export function isCanonicalTextRunDeclaration(declaration: CanonicalNominalResult | undefined): boolean {
  const leaves = DELIVERY_RESULT_LEAVES['TextRun']!;
  return declaration?.name === 'TextRun' && Array.isArray(declaration.fields) &&
    declaration.fields.length === leaves.length && leaves.every(expected =>
      declaration.fields.filter(leaf => leaf?.name === expected.name && leaf.type === expected.type).length === 1);
}

export function isTextRunReceiptContext(context: ReceiptResultContext | undefined): boolean {
  return context !== undefined &&
    ['std.TextGenerationV1.generate', 'std.TextGenerationV1.cancel', 'std.TextGenerationV1.reconcile'].includes(context.source) &&
    isCanonicalTextRunDeclaration(context.declaredResult);
}

export interface CheckedTextRunResult {
  readonly fields: Readonly<Record<TextRunResultLeaf, string | null>>;
  readonly revision: bigint;
  readonly sequence: bigint;
  readonly usedTokens: bigint | null;
}

/** Exact own data fields and the existing Values scalar codec; never invokes payload accessors. */
function decodeTextRunLeaf(leaf: { readonly name: string; readonly type: string }, value: unknown): { readonly scalar: unknown } | null {
  if (value !== null && typeof value !== 'string') return null;
  const scalar = decodeValue(leaf.type, value);
  if ((leaf.type === 'int' || leaf.type === 'int?') && encodeValue(leaf.type, scalar) !== value) return null;
  return { scalar };
}

export function readTextRunResult(result: unknown, declaration: CanonicalNominalResult | undefined): CheckedTextRunResult | null {
  if (!isCanonicalTextRunDeclaration(declaration) || typeof result !== 'object' || result === null ||
      Array.isArray(result) || (Object.getPrototypeOf(result) !== Object.prototype && Object.getPrototypeOf(result) !== null)) return null;
  const leaves = DELIVERY_RESULT_LEAVES['TextRun']!;
  if (Reflect.ownKeys(result).length !== leaves.length) return null;
  const fields = {} as Record<TextRunResultLeaf, string | null>;
  const decoded = new Map<string, unknown>();
  try {
    for (const leaf of leaves) {
      const property = Object.getOwnPropertyDescriptor(result, leaf.name);
      if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) return null;
      const value: unknown = property.value;
      const decodedLeaf = decodeTextRunLeaf(leaf, value);
      if (decodedLeaf === null) return null;
      decoded.set(leaf.name, decodedLeaf.scalar);
      fields[leaf.name as TextRunResultLeaf] = value as string | null;
    }
  } catch { return null; }
  const revision = decoded.get('revision');
  const sequence = decoded.get('sequence');
  const usedTokens = decoded.get('used_tokens');
  if (typeof revision !== 'bigint' || typeof sequence !== 'bigint' || sequence < 0n ||
      (usedTokens !== null && (typeof usedTokens !== 'bigint' || usedTokens < 0n))) return null;
  return { fields, revision, sequence, usedTokens };
}

/** Rich state describes the run; receipt status describes the delivered observation. */
export function isTextRunReceiptPayload(status: unknown, result: unknown, error: unknown, context: ReceiptResultContext | undefined): boolean {
  if (!isTextRunReceiptContext(context)) return false;
  const run = readTextRunResult(result, context!.declaredResult);
  if (run === null) return false;
  if (context!.request !== undefined) {
    try {
      if (run.fields.source !== context!.request.source || run.revision !== decodeValue('int', context!.request.revision)) return false;
    } catch { return false; }
  }
  const state = run.fields.state;
  const failure = error === undefined ? null : error;
  if (state === 'queued' || state === 'running') return status === 'pending' && failure === null;
  if (state === 'unknown') return status === 'unknown' && (failure === null || isClosedErrorShape(failure));
  return status === 'succeeded' && failure === null;
}

function checkJudgmentBound(value: number, native: boolean, path: readonly string[]): boolean {
  // Descriptor length bounds are JSON integers; runtime value scalars remain exact wire text/native bigint.
  return native && Number.isSafeInteger(value) && value >= 0 &&
    (path.at(-1) === 'min' || path.at(-1) === 'max') &&
    (path[0] === 'valueTypes' || path[0] === 'declaredResult' ||
      (path[0] === 'judgment' && path[1] === 'valueTypes') || (path[0] === 'delivery' && path[1] === 'result'));
}

function snapshotJudgmentEntry(
  value: object,
  key: string | symbol,
  array: boolean,
  length: number,
  out: Record<string, unknown> | unknown[],
  native: boolean,
  ancestors: Set<object>,
  depth: number,
  path: readonly string[],
): void {
  if (array && key === 'length') return;
  if (typeof key !== 'string' || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    throw new Error('invalid judgment key');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    throw new Error('invalid judgment accessor');
  }
  (out as Record<string, unknown>)[key] = snapshotJudgmentData(descriptor.value, native, ancestors, depth + 1, [...path, key]);
}

function openJudgmentComposite(
  value: object,
  depth: number,
  ancestors: Set<object>,
): { readonly array: boolean; readonly keys: readonly (string | symbol)[] } {
  if (depth > 64 || ancestors.has(value)) throw new Error('invalid judgment data');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('invalid judgment prototype');
  }
  const keys = Reflect.ownKeys(value);
  if (array && keys.length !== (value as unknown[]).length + 1) throw new Error('invalid judgment array');
  return { array, keys };
}

/** Detach own data before schema/codec reads; accessors and inherited/extended arrays have no authority. */
function snapshotJudgmentData(value: unknown, native = false, ancestors = new Set<object>(), depth = 0, path: readonly string[] = []): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'bigint' && native)) return value;
  if (typeof value === 'number' && checkJudgmentBound(value, native, path)) return value;
  if (typeof value !== 'object') throw new Error('invalid judgment data');
  const { array, keys } = openJudgmentComposite(value, depth, ancestors);
  const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
  ancestors.add(value);
  for (const key of keys) {
    snapshotJudgmentEntry(value, key, array, array ? (value as unknown[]).length : 0, out, native, ancestors, depth, path);
  }
  ancestors.delete(value);
  return Object.freeze(out);
}

function exactJudgmentKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

interface JudgmentSpecCheck {
  readonly spec: JudgmentSpec;
  readonly inventory: CanonicalValueTypes;
}

function checkJudgmentDeclaration(detached: ReceiptResultContext, spec: JudgmentSpec): boolean {
  return exactJudgmentKeys(spec, ['declaration', 'version', 'revision', 'language', 'noul', 'choice', 'score']) &&
    typeof spec.declaration === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(spec.declaration) &&
    typeof spec.version === 'bigint' && spec.version >= 0n && spec.version <= 9223372036854775807n &&
    typeof spec.revision === 'string' && /^sha256:[0-9a-f]{64}$/.test(spec.revision) &&
    typeof spec.language === 'string' && decodeValue('locale', spec.language) === spec.language &&
    detached.source === `${spec.declaration}.evaluate` && detached.declaredResult?.name === spec.declaration &&
    Array.isArray(spec.noul) && Array.isArray(spec.choice) && Array.isArray(spec.score);
}

function checkJudgmentInventory(inventory: CanonicalValueTypes): boolean {
  return Array.isArray(inventory.contracts) && (inventory.enums === undefined || Array.isArray(inventory.enums)) &&
    (inventory.aliases === undefined || Array.isArray(inventory.aliases)) &&
    exactJudgmentKeys(inventory, ['contracts', ...(Object.hasOwn(inventory, 'enums') ? ['enums'] : []),
      ...(Object.hasOwn(inventory, 'aliases') ? ['aliases'] : [])]);
}

function checkJudgmentSpecShape(detached: ReceiptResultContext): JudgmentSpecCheck | null {
  const spec = detached.judgment?.specification;
  const inventory = detached.judgment?.valueTypes;
  if (!spec || !inventory || !exactJudgmentKeys(detached.judgment!, ['specification', 'valueTypes']) ||
      !checkJudgmentDeclaration(detached, spec) || !checkJudgmentInventory(inventory)) return null;
  return { spec, inventory };
}

interface JudgmentQuestionCheck {
  readonly spec: JudgmentSpec;
  readonly fields: ReadonlyMap<string, string>;
  readonly fieldType: (name: string, field: string) => string | undefined;
  readonly sameFields: (type: string | undefined, expected: Readonly<Record<string, string>>) => boolean;
  readonly enumMatches: (type: string, ids: readonly string[], runtimeName?: string) => boolean;
  readonly aliases: ReadonlyMap<string, unknown>;
  readonly runtimeChoices: JudgmentSpec['choice'][number][];
  readonly questions: Set<string>;
}

function checkQuestionIdentity(
  questions: Set<string>,
  fields: ReadonlyMap<string, string>,
  kind: 'noul' | 'choice' | 'score',
  question: JudgmentSpec['noul'][number] | JudgmentSpec['choice'][number] | JudgmentSpec['score'][number],
): { readonly type: string | undefined } | null {
  if (!exactJudgmentKeys(question, kind === 'noul' ? ['id', 'instructions', 'yes', 'no'] :
      kind === 'choice' ? ['id', 'instructions', 'options'] : ['id', 'instructions', 'levels']) ||
      typeof question.id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(question.id) ||
      questions.has(question.id) || ['specification_revision', 'model', 'input_tokens', 'output_tokens'].includes(question.id) ||
      typeof question.instructions !== 'string' || question.instructions === '') return null;
  questions.add(question.id);
  return { type: fields.get(question.id) };
}

function checkNoulQuestion(
  question: JudgmentSpec['noul'][number],
  type: string | undefined,
  sameFields: (type: string | undefined, expected: Readonly<Record<string, string>>) => boolean,
): boolean {
  return !((question.yes === null) !== (question.no === null) || (question.yes !== null &&
      (typeof question.yes !== 'string' || question.yes === '' || typeof question.no !== 'string' || question.no === '')) ||
      !sameFields(type, { probability: 'decimal' }));
}

function checkOptionEntries(
  kind: 'choice' | 'score',
  entries: unknown,
  type: string | undefined,
): entries is { readonly id: string; readonly description: string }[] {
  if (!Array.isArray(entries) || entries.length < 2 || entries.length > (kind === 'choice' ? 26 : 10) ||
      !entries.every(entry => exactJudgmentKeys(entry, ['id', 'description']) && typeof entry.id === 'string' &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.id) && typeof entry.description === 'string' && entry.description !== '') ||
      new Set(entries.map(entry => (entry as { id: string }).id)).size !== entries.length || !type) {
    return false;
  }
  return true;
}

function resolveOptionIdentity(
  fieldType: (name: string, field: string) => string | undefined,
  kind: 'choice' | 'score',
  type: string,
): { readonly distribution: string; readonly identity: string; readonly element: string } | null {
  const parsed = parseTypeId(type);
  if (parsed.array || parsed.nullable || parsed.base.kind !== 'nominal') return null;
  const distribution = fieldType(parsed.base.path, kind === 'choice' ? 'probabilities' : 'levels');
  if (!distribution) return null;
  const array = parseTypeId(distribution);
  if (!array.array || array.nullable || array.base.kind !== 'nominal') return null;
  const identity = fieldType(array.base.path, kind === 'choice' ? 'option' : 'level');
  if (!identity) return null;
  return { distribution, identity, element: array.base.path };
}

function checkOptionQuestion(
  check: JudgmentQuestionCheck,
  kind: 'choice' | 'score',
  question: JudgmentSpec['choice'][number] | JudgmentSpec['score'][number],
  type: string | undefined,
): boolean {
  const { spec, fieldType, sameFields, enumMatches, runtimeChoices } = check;
  const entries = kind === 'choice' ? (question as JudgmentSpec['choice'][number]).options :
    (question as JudgmentSpec['score'][number]).levels;
  if (!checkOptionEntries(kind, entries, type)) return false;
  const resolved = resolveOptionIdentity(fieldType, kind, type!);
  if (resolved === null) return false;
  const { distribution, identity, element } = resolved;
  if (!enumMatches(identity, entries.map(entry => entry.id), kind === 'choice' ? `${spec.declaration}.${question.id}.choice` : undefined) ||
      !sameFields(element, kind === 'choice' ? { option: identity, probability: 'decimal' } :
        { level: identity, index: 'int', description: 'text', probability: 'decimal' }) ||
      !sameFields(type, kind === 'choice' ? { choice: identity, probabilities: distribution, confidence: 'decimal' } :
        { score: 'decimal', levels: distribution, confidence: 'decimal' })) return false;
  if (kind === 'choice' && check.aliases.has(identity)) {
    runtimeChoices.push(question as JudgmentSpec['choice'][number]);
  }
  return true;
}

function checkJudgmentQuestion(
  check: JudgmentQuestionCheck,
  kind: 'noul' | 'choice' | 'score',
  question: JudgmentSpec['noul'][number] | JudgmentSpec['choice'][number] | JudgmentSpec['score'][number],
): boolean {
  const identity = checkQuestionIdentity(check.questions, check.fields, kind, question);
  if (identity === null) return false;
  if (kind === 'noul') {
    return checkNoulQuestion(question as JudgmentSpec['noul'][number], identity.type, check.sameFields);
  }
  return checkOptionQuestion(check, kind, question as JudgmentSpec['choice'][number] | JudgmentSpec['score'][number],
    identity.type);
}

function checkJudgmentQuestions(check: JudgmentQuestionCheck): boolean {
  for (const [kind, entries] of [['noul', check.spec.noul], ['choice', check.spec.choice], ['score', check.spec.score]] as const) {
    for (const question of entries) {
      if (!checkJudgmentQuestion(check, kind, question)) return false;
    }
  }
  return true;
}

function checkedJudgmentContext(context: ReceiptResultContext | undefined) {
  try {
    if (context === undefined) return null;
    const detached = snapshotJudgmentData(context, true) as ReceiptResultContext;
    const specCheck = checkJudgmentSpecShape(detached);
    if (specCheck === null) return null;
    const { spec, inventory } = specCheck;
    const normalized = normalizeValueTypes(inventory);
    const contracts = new Map(normalized.valueTypes.contracts.map(declaration => [declaration.name, declaration]));
    const enums = new Map((normalized.valueTypes.enums ?? []).map(declaration => [declaration.name, declaration.cases]));
    const aliases = new Map((normalized.valueTypes.aliases ?? []).map(declaration => [declaration.name, declaration]));
    const runtimeChoices: JudgmentSpec['choice'][number][] = [];
    const schema = normalized.valueSchema;
    const root = contracts.get(spec.declaration);
    if (!root || !exactJudgmentKeys(detached.declaredResult, ['name', 'fields']) ||
        !Array.isArray(detached.declaredResult.fields) || root.fields.length !== detached.declaredResult.fields.length ||
        !root.fields.every((field, index) => sameJudgmentWire(field, detached.declaredResult.fields[index]))) return null;
    const fields = new Map(root.fields.map(field => [field.name, field.type]));
    const fieldType = (name: string, field: string): string | undefined =>
      contracts.get(name)?.fields.find(leaf => leaf.name === field)?.type;
    const questions = new Set<string>();
    const sameFields = (type: string | undefined, expected: Readonly<Record<string, string>>): boolean => {
      if (!type) return false;
      const parsed = parseTypeId(type);
      if (parsed.array || parsed.nullable || parsed.base.kind !== 'nominal') return false;
      const declaration = parsed.base.path;
      const actual = contracts.get(declaration)?.fields;
      return actual !== undefined && actual.length === Object.keys(expected).length &&
        Object.entries(expected).every(([name, kind]) => fieldType(declaration, name) === kind);
    };
    const enumMatches = (type: string, ids: readonly string[], runtimeName?: string): boolean => {
      const parsed = parseTypeId(type);
      const cases = parsed.base.kind === 'enum' ? parsed.base.cases :
        parsed.base.kind === 'nominal' ? enums.get(parsed.base.path) : undefined;
      if (parsed.array || parsed.nullable) return false;
      if (cases !== undefined) return cases.length === ids.length && cases.every((id, index) => id === ids[index]);
      if (parsed.base.kind !== 'nominal' || parsed.base.path !== runtimeName) return false;
      const alias = aliases.get(parsed.base.path);
      return alias !== undefined && exactJudgmentKeys(alias, ['name', 'type', 'min', 'max', 'format']) &&
        alias.type === 'text' && alias.min === 1 && alias.max === 80 && alias.format === 'name' &&
        ids.every(id => id.length >= 1 && id.length <= 80 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(id));
    };
    if (!checkJudgmentQuestions({ spec, fields, fieldType, sameFields, enumMatches, aliases, runtimeChoices,
        questions })) {
      return null;
    }
    if (questions.size < 1 || questions.size > 32 ||
        fields.size !== questions.size + 4 ||
        fields.get('specification_revision') !== 'text' || fields.get('model') !== 'text' ||
        fields.get('input_tokens') !== 'int' || fields.get('output_tokens') !== 'int') return null;
    return { context: detached, schema, runtimeChoices };
  } catch { return null; }
}

/** Original static source and exact checked schema inventory; no suffix-based authority. */
export function isJudgmentReceiptContext(context: ReceiptResultContext | undefined): boolean {
  return checkedJudgmentContext(context) !== null;
}

/** The delivery declaration defines the context; later caller mutation cannot rewrite it. */
export function createJudgmentReceiptContext(
  delivery: CanonicalJudgmentDeliveryDescriptor,
  specification: JudgmentSpec,
  valueTypes: CanonicalValueTypes,
): ReceiptResultContext {
  const detached = snapshotJudgmentData({ delivery, specification, valueTypes }, true) as {
    delivery: CanonicalJudgmentDeliveryDescriptor; specification: JudgmentSpec; valueTypes: CanonicalValueTypes;
  };
  const d = detached.delivery, spec = detached.specification;
  if (!exactJudgmentKeys(d, ['kind', 'judgment', 'capability', 'operation', 'version', 'result']) ||
      d.kind !== 'delivery' || d.judgment !== true || d.capability !== spec.declaration || d.operation !== 'evaluate' ||
      typeof spec.version !== 'bigint' || d.version !== spec.version.toString()) {
    throw new ReceiptTableError('Invalid static Judgment delivery context.');
  }
  const context: ReceiptResultContext = Object.freeze({ source: `${d.capability}.${d.operation}`,
    declaredResult: d.result, judgment: Object.freeze({ specification: spec, valueTypes: detached.valueTypes }) });
  if (!isJudgmentReceiptContext(context)) throw new ReceiptTableError('Invalid static Judgment delivery context.');
  return context;
}

function sameJudgmentWire(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return exactJudgmentKeys(right, Object.keys(left)) && Object.keys(left).every(key => sameJudgmentWire(left[key], right[key]));
}

/** Decode exact nested declared types while preserving usage as int64 bigint. */
export function readJudgmentResult(result: unknown, context: ReceiptResultContext | undefined): Readonly<Record<string, CanValue>> | null {
  const checked = checkedJudgmentContext(context);
  if (checked === null) return null;
  try {
    const wire = snapshotJudgmentData(result);
    const value = validateValue(checked.schema, checked.context.declaredResult.name, wire, 'create');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const resultValue = value as Readonly<Record<string, CanValue>>;
    if (resultValue['specification_revision'] !== checked.context.judgment!.specification.revision ||
        typeof resultValue['model'] !== 'string' || resultValue['model'] === '' ||
        typeof resultValue['input_tokens'] !== 'bigint' || resultValue['input_tokens'] < 0n ||
        typeof resultValue['output_tokens'] !== 'bigint' || resultValue['output_tokens'] < 0n ||
        !sameJudgmentWire(wire, encodeValue(checked.context.declaredResult.name, value, undefined, checked.schema))) return null;
    // Runtime aliases bound representation; the original frozen specification alone grants candidate membership.
    for (const question of checked.runtimeChoices) {
      const answer = resultValue[question.id] as Readonly<Record<string, CanValue>>;
      const probabilities = answer['probabilities'];
      if (!question.options.some(option => option.id === answer['choice']) || !Array.isArray(probabilities) ||
          probabilities.length !== question.options.length || probabilities.some((entry, index) =>
            (entry as Readonly<Record<string, CanValue>>)['option'] !== question.options[index]!.id)) return null;
    }
    return resultValue;
  } catch { return null; }
}

/** Static Judgment receipts carry a checked result only on success, never rich progress. */
export function isJudgmentReceiptPayload(status: unknown, result: unknown, error: unknown, context: ReceiptResultContext | undefined): boolean {
  if (!isJudgmentReceiptContext(context)) return false;
  const payload = result === undefined ? null : result, failure = error === undefined ? null : error;
  if (status === 'succeeded') return failure === null && readJudgmentResult(payload, context) !== null;
  if (payload !== null) return false;
  let closedFailure = false;
  try { closedFailure = isClosedErrorShape(snapshotJudgmentData(failure)); } catch { return false; }
  if (status === 'failed') return closedFailure;
  if (status === 'unknown') return failure === null || closedFailure;
  return (status === 'pending' || status === 'skipped') && failure === null;
}

const GENERATED_IMAGE_SCHEMA = normalizeSchema({ contracts: { GeneratedImage: {
  fields: Object.fromEntries(GENERATED_IMAGE_FIELDS.map(field => [field.name, { type: field.type }])),
} } });

export function isCanonicalImageRunDeclaration(declaration: CanonicalNominalResult | undefined): boolean {
  const leaves = DELIVERY_RESULT_LEAVES['ImageRun']!;
  return declaration?.name === 'ImageRun' && Array.isArray(declaration.fields) &&
    declaration.fields.length === leaves.length && leaves.every(expected =>
      declaration.fields.filter(leaf => leaf?.name === expected.name && leaf.type === expected.type).length === 1);
}

export function isImageRunReceiptContext(context: ReceiptResultContext | undefined): boolean {
  return context !== undefined &&
    ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source) &&
    isCanonicalImageRunDeclaration(context.declaredResult);
}

export interface CheckedImageRunResult {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly outputs: CanValue;
  readonly revision: bigint;
  readonly sequence: bigint;
  readonly chargedJobs: bigint | null;
}

function snapshotImageOutputEntry(
  value: object,
  key: string | symbol,
  array: boolean,
  length: number,
  out: Record<string, unknown> | unknown[],
  depth: number,
): void {
  if (array && key === 'length') return;
  if (typeof key !== 'string' || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    throw new Error('invalid output key');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
    throw new Error('invalid output accessor');
  }
  (out as Record<string, unknown>)[key] = snapshotImageOutputData(descriptor.value, depth + 1);
}

/** Bounded own-data snapshot before Values reads nested data; no getters, inherited data or omissions. */
function snapshotImageOutputData(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth > 2) throw new Error('invalid nested output data');
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('invalid nested output prototype');
  }
  const keys = Reflect.ownKeys(value);
  const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null) as Record<string, unknown>;
  if (array && keys.length !== value.length + 1) throw new Error('sparse or extended output array');
  for (const key of keys) {
    snapshotImageOutputEntry(value, key, array, array ? value.length : 0, out, depth);
  }
  return out;
}

function decodeImageOutputsLeaf(value: unknown, leafType: string): CanValue | null {
  const snapshot = snapshotImageOutputData(value);
  const outputs = validateValue(GENERATED_IMAGE_SCHEMA, leafType, snapshot, 'create');
  // Values decodes exact integers; require their canonical wire spelling too.
  if (!Array.isArray(outputs) || !Array.isArray(snapshot) || outputs.some((output, index) =>
    encodeValue('int', (output as Record<string, CanValue>)['position']!) !==
      (snapshot[index] as Record<string, unknown>)['position'])) return null;
  return outputs;
}

function decodeImageScalarLeaf(leafType: string, value: unknown): { readonly scalar: CanValue } | null {
  if (value !== null && typeof value !== 'string') return null;
  const scalar = decodeValue(leafType, value);
  if ((leafType === 'int' || leafType === 'int?') && encodeValue(leafType, scalar) !== value) return null;
  return { scalar };
}

/** Canonical source ImageRun, never the provider byte-result shape. File shape alone adds no authority. */
export function readImageRunResult(result: unknown, declaration: CanonicalNominalResult | undefined): CheckedImageRunResult | null {
  if (!isCanonicalImageRunDeclaration(declaration) || typeof result !== 'object' || result === null ||
      Array.isArray(result) || (Object.getPrototypeOf(result) !== Object.prototype && Object.getPrototypeOf(result) !== null)) return null;
  const leaves = DELIVERY_RESULT_LEAVES['ImageRun']!;
  if (Reflect.ownKeys(result).length !== leaves.length) return null;
  const fields: Record<string, unknown> = {};
  const decoded = new Map<string, CanValue>();
  try {
    for (const leaf of leaves) {
      const property = Object.getOwnPropertyDescriptor(result, leaf.name);
      if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) return null;
      const value: unknown = property.value;
      if (leaf.name === 'outputs') {
        const outputs = decodeImageOutputsLeaf(value, leaf.type);
        if (outputs === null) return null;
        decoded.set(leaf.name, outputs);
      } else {
        const scalarLeaf = decodeImageScalarLeaf(leaf.type, value);
        if (scalarLeaf === null) return null;
        decoded.set(leaf.name, scalarLeaf.scalar);
      }
      fields[leaf.name] = value;
    }
  } catch { return null; }
  return finishImageRunResult(fields, decoded);
}

function finishImageRunResult(
  fields: Record<string, unknown>,
  decoded: ReadonlyMap<string, CanValue>,
): CheckedImageRunResult | null {
  const revision = decoded.get('revision');
  const sequence = decoded.get('sequence');
  const chargedJobs = decoded.get('charged_jobs');
  if (typeof revision !== 'bigint' || typeof sequence !== 'bigint' || sequence < 0n ||
      (chargedJobs !== null && (typeof chargedJobs !== 'bigint' || chargedJobs < 0n))) return null;
  return { fields, outputs: decoded.get('outputs')!, revision, sequence, chargedJobs };
}

export function isImageRunReceiptPayload(status: unknown, result: unknown, error: unknown, context: ReceiptResultContext | undefined): boolean {
  if (!isImageRunReceiptContext(context)) return false;
  const run = readImageRunResult(result, context!.declaredResult);
  if (run === null) return false;
  if (context!.request !== undefined) {
    try {
      const revision = decodeValue('int', context!.request.revision);
      if (encodeValue('int', revision) !== context!.request.revision ||
          run.fields.source !== context!.request.source || run.revision !== revision) return false;
    } catch { return false; }
  }
  const failure = error === undefined ? null : error;
  if (run.fields.state === 'queued' || run.fields.state === 'running') return status === 'pending' && failure === null;
  if (run.fields.state === 'unknown') return status === 'unknown' && (failure === null || isClosedErrorShape(failure));
  return status === 'succeeded' && failure === null;
}

/**
 * Deterministic association row id under owner model + record + field.
 * Components are encoded so `/` separators stay unambiguous (the
 * `everySlotRowId` precedent). One row per locator: a second insert
 * for the same locator collides on the store primary key.
 */
export function associationRowId(model: string, recordId: string, field: string): string {
  if (model === '' || recordId === '' || field === '') {
    throw new ReceiptTableError(
      'associationRowId needs a non-empty model, recordId and field.',
    );
  }
  return `receipt-assoc/v1/${encodeURIComponent(model)}/${encodeURIComponent(recordId)}/${encodeURIComponent(field)}`;
}

function checkRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReceiptTableError(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkString(record: Record<string, unknown>, field: string, what: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw new ReceiptTableError(`${what}.${field} must be a non-empty string.`);
  }
  return value;
}

function checkRevision(record: Record<string, unknown>, field: string, what: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ReceiptTableError(`${what}.${field} must be an integer >= 0.`);
  }
  return value;
}

function checkStatus(record: Record<string, unknown>): ReceiptStatus {
  const value = record['status'];
  if (typeof value !== 'string' || !RECEIPT_STATUSES.has(value)) {
    throw new ReceiptTableError(
      `work.receipt.status is unknown: ${JSON.stringify(value)}.`,
    );
  }
  return value as ReceiptStatus;
}

function checkNullableContentRef(record: Record<string, unknown>): string | null {
  const value = record['contentRef'];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value === '') {
    throw new ReceiptTableError('work.receipt.contentRef must be a non-empty string or null.');
  }
  return value;
}

function checkNullableExpiry(record: Record<string, unknown>): number | null {
  const value = record['resultExpiresAtMs'];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ReceiptTableError(
      'work.receipt.resultExpiresAtMs must be finite epoch ms or null.',
    );
  }
  return value;
}

/** Deep JSON-safety: row data must survive the store JSON round-trip. */
function checkJsonSafe(value: unknown, what: string): void {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) {
      return;
    }
    switch (typeof node) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(node)) {
          throw new ReceiptTableError(`${what}${path} must be finite JSON.`);
        }
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        throw new ReceiptTableError(`${what}${path} is not JSON-safe.`);
      case 'object': {
        if (seen.has(node)) {
          throw new ReceiptTableError(`${what}${path} is cyclic.`);
        }
        seen.add(node);
        if (Array.isArray(node)) {
          node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
          return;
        }
        for (const [key, entry] of Object.entries(node)) {
          visit(entry, `${path}.${key}`);
        }
        return;
      }
    }
  };
  visit(value, '');
}

/**
 * Closed safe-error shape: exactly {code, message}, no extras.
 * Structural mirror of the work-side closed-error predicate.
 */
function isClosedErrorShape(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as Record<string, unknown>;
  if (Object.keys(candidate).length !== 2) {
    return false;
  }
  return typeof candidate['code'] === 'string' && typeof candidate['message'] === 'string';
}

/**
 * Stored receipt-payload consistency (DESIGN section 8.0): a structural
 * mirror of the work-side completion check. Context-free pending carries
 * no payload; checked TextRun context additionally admits pending/unknown
 * run snapshots. Succeeded carries no error; failed carries a
 * closed error and no result; unknown carries no result and at most a
 * closed diagnostic; skipped carries nothing. Never throws: predicate
 * over stored/caller input. Agreement with the work-side check over
 * every non-pending status is pinned by the join tests against the
 * real function.
 */
function checkTypedReceiptPayload(
  status: unknown,
  payload: unknown,
  failure: unknown,
  context: ReceiptResultContext | undefined,
): boolean | null {
  if (context !== undefined && context !== null && 'judgment' in context) {
    return isJudgmentReceiptPayload(status, payload, failure, context);
  }
  // Explicit TextGeneration declaration context never falls through to an
  // untyped succeeded payload after a malformed rich result.
  if (payload !== null && context !== undefined && context.source.startsWith('std.TextGenerationV1.')) {
    return isTextRunReceiptPayload(status, payload, failure, context);
  }
  if (payload !== null && context !== undefined &&
      ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source)) {
    return isImageRunReceiptPayload(status, payload, failure, context);
  }
  return null;
}

function checkStatusPayload(status: unknown, payload: unknown, failure: unknown): boolean {
  if (status === 'pending') {
    return payload === null && failure === null;
  }
  if (status === 'succeeded') {
    return failure === null;
  }
  if (status === 'failed') {
    return payload === null && isClosedErrorShape(failure);
  }
  if (status === 'unknown') {
    return payload === null && (failure === null || isClosedErrorShape(failure));
  }
  if (status === 'skipped') {
    return payload === null && failure === null;
  }
  return false;
}

export function isStoredReceiptPayload(
  status: unknown,
  result: unknown,
  error: unknown,
  context?: ReceiptResultContext,
): boolean {
  const payload = result === undefined ? null : result;
  const failure = error === undefined ? null : error;
  return checkTypedReceiptPayload(status, payload, failure, context) ?? checkStatusPayload(status, payload, failure);
}

/** Read one association row's data, failing closed on any shape drift. */
export function readAssociationRow(row: StoredRow): ReceiptAssociation {
  const data = checkRecord(row.data, 'work.receipt_association data');
  const recordModel = checkString(data, 'recordModel', 'work.receipt_association');
  const recordId = checkString(data, 'recordId', 'work.receipt_association');
  const field = checkString(data, 'field', 'work.receipt_association');
  const deliveryId = checkString(data, 'deliveryId', 'work.receipt_association');
  const source = checkString(data, 'source', 'work.receipt_association');
  const revision = checkRevision(data, 'revision', 'work.receipt_association');
  if (row.id !== associationRowId(recordModel, recordId, field)) {
    throw new ReceiptTableError(
      'work.receipt_association row id must equal its model/record/field derivation.',
    );
  }
  return { locator: { recordId, field }, deliveryId, source, revision };
}

/** One receipt row's data: the retained receipt plus its retention binding. */
export interface StoredReceiptRow {
  readonly receipt: AssociatedReceipt;
  readonly contentRef: string | null;
  readonly resultExpiresAtMs: number | null;
  /** Original owning evidence; persistence supplies no issuer or File authority. */
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
}

interface OriginSnapshotBudget {
  nodes: number;
  textSize: number;
  readonly ancestors: Set<object>;
}

function snapshotOriginEntry(
  node: object,
  key: string | symbol,
  array: boolean,
  length: number,
  out: Record<string, unknown> | unknown[],
  depth: number,
  budget: OriginSnapshotBudget,
): void {
  if (array && key === 'length') return;
  if (typeof key !== 'string' || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin has an invalid key.');
  }
  const property = Object.getOwnPropertyDescriptor(node, key);
  if (property === undefined || !Object.hasOwn(property, 'value') || !property.enumerable) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin must contain own data properties.');
  }
  if ((budget.textSize += key.length) > 2_000_000) throw new ReceiptTableError('work.receipt filePayloadOrigin exceeds its bounds.');
  Object.defineProperty(out, key, { enumerable: true, configurable: true, writable: true,
    value: snapshotOriginValue(property.value, depth + 1, budget) });
}

function snapshotOriginValue(node: unknown, depth: number, budget: OriginSnapshotBudget): unknown {
  if (++budget.nodes > 20_000 || depth > 32) throw new ReceiptTableError('work.receipt filePayloadOrigin exceeds its bounds.');
  if (node === null || typeof node === 'boolean') return node;
  if (typeof node === 'string') {
    if ((budget.textSize += node.length) > 2_000_000) throw new ReceiptTableError('work.receipt filePayloadOrigin exceeds its bounds.');
    return node;
  }
  if (typeof node === 'number' && Number.isFinite(node)) return node;
  if (typeof node !== 'object' || budget.ancestors.has(node)) throw new ReceiptTableError('work.receipt filePayloadOrigin must be own JSON data.');
  const array = Array.isArray(node), prototype = Object.getPrototypeOf(node);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin must be own JSON data.');
  }
  const keys = Reflect.ownKeys(node);
  if (keys.length > 20_000 || (array && keys.length !== node.length + 1)) throw new ReceiptTableError('work.receipt filePayloadOrigin must be dense bounded JSON.');
  const out: Record<string, unknown> | unknown[] = array ? [] : {};
  budget.ancestors.add(node);
  for (const key of keys) {
    snapshotOriginEntry(node, key, array, array ? node.length : 0, out, depth, budget);
  }
  budget.ancestors.delete(node);
  return out;
}

/** Bounded own JSON snapshot; neither accessors nor inherited facts become evidence. */
function snapshotReceiptOrigin(value: unknown): unknown {
  return snapshotOriginValue(value, 0, { nodes: 0, textSize: 0, ancestors: new Set<object>() });
}

function originRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !exactJudgmentKeys(value, keys)) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin has an incomplete or extended header.');
  }
  return value as Record<string, unknown>;
}
function originString(value: unknown): value is string { return typeof value === 'string' && value !== ''; }

interface OriginRecords {
  readonly inventory: Record<string, unknown>;
  readonly slot: Record<string, unknown>;
  readonly scope: Record<string, unknown>;
  readonly skipped: boolean;
  readonly origin: Record<string, unknown>;
  readonly intent: Record<string, unknown>;
  readonly request: Record<string, unknown>;
  readonly caller: Record<string, unknown>;
  readonly source: Record<string, unknown>;
  readonly association: Record<string, unknown>;
  readonly declarationKind: unknown;
  readonly declaration: Record<string, unknown>;
  readonly canonical: Record<string, unknown> | null;
  readonly artifact: Record<string, unknown> | null;
  readonly callable: Record<string, unknown> | null;
  readonly callerCanonical: Record<string, unknown> | null;
  readonly callerArtifact: Record<string, unknown> | null;
}

function readOriginRecords(header: Record<string, unknown>): OriginRecords {
  const inventory = originRecord(header.inventory, ['owner', 'snapshotId', 'digest']);
  const slot = originRecord(header.slot, ['model', 'id', 'created', 'createdBy', 'field', 'role']);
  const scope = originRecord(header.scope, ['app', 'ownerPackage', 'owner']);
  const skipped = (header.origin as { kind?: unknown } | null)?.kind === 'delivery-skipped';
  const retained = (header.origin as { kind?: unknown } | null)?.kind === 'retained-delivery-result';
  const origin = originRecord(header.origin, retained ?
    ['kind', 'deliveryId', 'intent', 'request', 'caller', 'declaration', 'resultDeclarationId', 'completion', 'originalCommit', 'dispatch'] : skipped ?
    ['kind', 'deliveryId', 'send', 'request', 'caller', 'association', 'guard', 'declaration', 'resultDeclarationId'] :
    ['kind', 'deliveryId', 'intent', 'request', 'caller', 'association', 'declaration', 'resultDeclarationId']);
  return { inventory, slot, scope, skipped, origin, ...readOriginParties(origin, skipped) };
}

function readOriginParties(origin: Record<string, unknown>, skipped: boolean): {
  readonly intent: Record<string, unknown>;
  readonly request: Record<string, unknown>;
  readonly caller: Record<string, unknown>;
  readonly source: Record<string, unknown>;
  readonly association: Record<string, unknown>;
  readonly declarationKind: unknown;
  readonly declaration: Record<string, unknown>;
  readonly canonical: Record<string, unknown> | null;
  readonly artifact: Record<string, unknown> | null;
  readonly callable: Record<string, unknown> | null;
  readonly callerCanonical: Record<string, unknown> | null;
  readonly callerArtifact: Record<string, unknown> | null;
} {
  const intent = originRecord(skipped ? origin.send : origin.intent, skipped ?
    ['operation', 'operationId', 'target', 'occurrenceIndex'] : ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']);
  const request = originRecord(origin.request, ['binding', 'from']);
  const caller = originRecord(origin.caller, ['source', 'callable', 'canonical', 'artifact', 'resultDeclarationId']);
  const source = originRecord(caller.source, ['path', 'sha256', 'module']);
  const association = origin.kind === 'retained-delivery-result' ? {} : originRecord(origin.association, ['model', 'recordId', 'field']);
  const declarationKind = (origin.declaration as { kind?: unknown } | null)?.kind;
  const declaration = originRecord(origin.declaration, declarationKind === 'generation' ? ['kind', 'canonical', 'artifact', 'request'] :
    declarationKind === 'judgment' ? ['kind', 'canonical', 'artifact', 'specification', 'order', 'valueTypes'] : ['kind', 'canonical', 'artifact']);
  return { intent, request, caller, source, association, declarationKind, declaration,
    canonical: declaration.canonical as Record<string, unknown> | null,
    artifact: declaration.artifact as Record<string, unknown> | null,
    callable: caller.callable as Record<string, unknown> | null,
    callerCanonical: caller.canonical as Record<string, unknown> | null,
    callerArtifact: caller.artifact as Record<string, unknown> | null };
}

function checkOriginHeaderBinding(
  header: Record<string, unknown>,
  inventory: Record<string, unknown>,
  scope: Record<string, unknown>,
  source: Record<string, unknown>,
): boolean {
  return header.version === 1 && Object.values(inventory).every(originString) && originString(header.declarationSetId) &&
    Object.values(scope).every(originString) && Object.values(source).every(originString);
}

function checkOriginSlot(
  slot: Record<string, unknown>,
  row: Pick<StoredRow, 'id' | 'created' | 'createdBy'>,
): boolean {
  return slot.model === RECEIPT_MODEL && slot.id === row.id && slot.created === row.created && slot.createdBy === row.createdBy &&
    typeof slot.created === 'number' && Number.isFinite(slot.created) && slot.created >= 0 && originString(slot.createdBy) &&
    slot.field === 'result' && slot.role === 'retained-result';
}

function checkOriginDelivery(
  origin: Record<string, unknown>,
  deliveryId: string,
  skipped: boolean,
  intent: Record<string, unknown>,
): boolean {
  return ['delivery-result', 'delivery-skipped', 'retained-delivery-result'].includes(String(origin.kind)) && origin.deliveryId === deliveryId &&
    (skipped || intent.intentId === deliveryId) && originString(intent.operation) && originString(intent.operationId) &&
    originString(intent.target) && typeof intent.occurrenceIndex === 'number' &&
    Number.isSafeInteger(intent.occurrenceIndex) && intent.occurrenceIndex >= 0;
}

function checkOriginCallers(
  origin: Record<string, unknown>,
  caller: Record<string, unknown>,
  request: Record<string, unknown>,
  association: Record<string, unknown>,
  intent: Record<string, unknown>,
  callable: Record<string, unknown> | null,
  callerCanonical: Record<string, unknown> | null,
  callerArtifact: Record<string, unknown> | null,
): boolean {
  return Object.values(request).every(originString) && Object.values(association).every(originString) &&
    originString(origin.resultDeclarationId) && originString(caller.resultDeclarationId) &&
    callable?.id === intent.operation && callerCanonical?.name === intent.operation && callerArtifact?.name === intent.operation;
}

function checkOriginCanonical(
  declarationKind: unknown,
  canonical: Record<string, unknown> | null,
  artifact: Record<string, unknown> | null,
  intent: Record<string, unknown>,
): boolean {
  return ['capability', 'generation', 'judgment'].includes(String(declarationKind)) &&
    canonical?.kind === 'delivery' && artifact?.kind === 'delivery' && originString(canonical?.capability) &&
    originString(canonical?.operation) && `${canonical.capability}.${canonical.operation}` === intent.target &&
    artifact.capability === canonical.capability && artifact.operation === canonical.operation &&
    artifact.version === canonical.version;
}

function checkOriginBinding(
  header: Record<string, unknown>,
  records: OriginRecords,
  row: Pick<StoredRow, 'id' | 'created' | 'createdBy'>,
  deliveryId: string,
  context: ReceiptResultContext | undefined,
): void {
  const { inventory, slot, scope, skipped, origin, intent, request, caller, source, association,
    declarationKind, canonical, artifact, callable, callerCanonical, callerArtifact } = records;
  if (!checkOriginHeaderBinding(header, inventory, scope, source) || !checkOriginSlot(slot, row) ||
      !checkOriginDelivery(origin, deliveryId, skipped, intent) ||
      !checkOriginCallers(origin, caller, request, association, intent, callable, callerCanonical, callerArtifact) ||
      !checkOriginCanonical(declarationKind, canonical, artifact, intent) ||
      (context !== undefined && intent.target !== context.source)) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin disagrees with its original receipt binding.');
  }
}

function checkSkippedGuardInputs(guard: Record<string, unknown>): void {
  const names = new Set<string>();
  if (!Array.isArray(guard.inputs) || guard.inputs.length > 200 || guard.inputs.some(value => {
      const input = originRecord(value, ['name', 'type']);
      if (!originString(input.name) || !originString(input.type) || names.has(input.name)) return true;
      names.add(input.name); return false;
    })) {
    throw new ReceiptTableError('work.receipt skipped origin requires its original false SEND and null skipped envelope.');
  }
}

function checkSkippedOrigin(data: object, records: OriginRecords): void {
  const { origin, intent, request, source } = records;
  const guard = originRecord(origin.guard, ['rule', 'source', 'owner', 'node', 'binding', 'target', 'inputs']);
  const guardSource = originRecord(guard.source, ['path', 'sha256', 'module']);
  const node = originRecord(guard.node, ['start', 'end']);
  const validNode = typeof node.start === 'number' && Number.isSafeInteger(node.start) && node.start >= 0 &&
    typeof node.end === 'number' && Number.isSafeInteger(node.end) && node.end > node.start;
  if (!originString(guard.rule) || guard.owner !== intent.operation || guard.target !== intent.target ||
      guard.binding !== request.binding || !sameJudgmentWire(guardSource, source) || !validNode) {
    throw new ReceiptTableError('work.receipt skipped origin requires its original false SEND and null skipped envelope.');
  }
  checkSkippedGuardInputs(guard);
  if (['result', 'error', 'contentRef', 'resultExpiresAtMs'].some(key => {
      const member = Object.getOwnPropertyDescriptor(data, key);
      return member === undefined || !('value' in member) || member.value !== null;
    }) || Object.getOwnPropertyDescriptor(data, 'status')?.value !== 'skipped') {
    throw new ReceiptTableError('work.receipt skipped origin requires its original false SEND and null skipped envelope.');
  }
}

/** Validate local correspondence only; the complete installed source/recipe belongs to State census. */
function receiptOrigin(data: object, row: Pick<StoredRow, 'id' | 'created' | 'createdBy'>,
  deliveryId: string, context?: ReceiptResultContext): FrameworkFilePayloadOrigin | undefined {
  const property = Object.getOwnPropertyDescriptor(data, 'filePayloadOrigin');
  if (property === undefined) {
    if ('filePayloadOrigin' in data) throw new ReceiptTableError('work.receipt filePayloadOrigin must be an own property.');
    return undefined;
  }
  if (!Object.hasOwn(property, 'value') || !property.enumerable) throw new ReceiptTableError('work.receipt filePayloadOrigin must be own data.');
  const header = originRecord(snapshotReceiptOrigin(property.value), ['version', 'inventory', 'declarationSetId', 'slot', 'scope', 'origin', 'files']);
  const records = readOriginRecords(header);
  checkOriginBinding(header, records, row, deliveryId, context);
  if (records.origin.kind === 'retained-delivery-result') {
    const completion = originRecord(records.origin.completion, ['kind', 'source', 'event', 'providerSource', 'binding', 'from',
      'sourceInputsDeclarationId', 'inputsDeclarationId', 'resultDeclarationId', 'delivery']);
    const stamp = originRecord(records.origin.originalCommit, ['revision', 'createdAt']);
    const dispatch = originRecord(records.origin.dispatch, ['kind', 'operationId', 'source', 'occurrenceIndex', 'originOccurrence', 'created', 'actor']);
    if (completion.kind !== 'standard-completion' || completion.providerSource !== records.intent.target ||
        completion.binding !== records.request.binding || completion.from !== records.request.from ||
        completion.resultDeclarationId !== records.origin.resultDeclarationId ||
        !sameJudgmentWire(completion.delivery, records.declaration) || dispatch.kind !== 'capability' ||
        dispatch.source !== records.intent.target || dispatch.operationId !== records.intent.operationId ||
        dispatch.occurrenceIndex !== records.intent.occurrenceIndex || !originString(dispatch.actor) ||
        dispatch.originOccurrence !== null && !originString(dispatch.originOccurrence) ||
        !Number.isSafeInteger(stamp.revision) || (stamp.revision as number) < 1 ||
        !Number.isSafeInteger(stamp.createdAt) || (stamp.createdAt as number) < 0 ||
        !Number.isSafeInteger(dispatch.created) || (dispatch.created as number) < 0 ||
        (dispatch.created as number) > (stamp.createdAt as number) || (stamp.createdAt as number) > row.created) {
      throw new ReceiptTableError('work.receipt retained delivery lost its original completion/dispatch correspondence.');
    }
  }
  // HEAD guards the files array (binding error) before the skipped-origin
  // check: malformed-both inputs report the binding disagreement, not the
  // skipped-envelope error.
  const files = header.files;
  if (!Array.isArray(files)) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin disagrees with its original receipt binding.');
  }
  if (records.skipped) {
    checkSkippedOrigin(data, records);
  }
  for (const entry of files) {
    checkOriginFile(entry);
  }
  return header as unknown as FrameworkFilePayloadOrigin;
}

function readOriginFileProvenance(file: Record<string, unknown>): {
  readonly kind: unknown; readonly provenance: Record<string, unknown>;
} {
  const provenanceKind = (file.provenance as { kind?: unknown } | null)?.kind;
  const provenance = originRecord(file.provenance, provenanceKind === 'request' ?
    ['kind', 'app', 'team', 'owner', 'principal', 'adapter', 'deliveryId', 'resultPath'] :
    ['kind', 'source', 'adapter', 'occurrenceId', 'fieldPath', 'itemIndex']);
  return { kind: provenanceKind, provenance };
}

function checkOriginFile(entry: unknown): void {
  const fact = originRecord(entry, ['path', 'file']);
  if (!Array.isArray(fact.path) || fact.path.some(segment => !(typeof segment === 'string' ||
      (typeof segment === 'number' && Number.isSafeInteger(segment) && segment >= 0)))) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin has an invalid File path.');
  }
  const file = originRecord(fact.file, ['ref', 'receiver', 'provenance', 'contentType', 'sizeBytes', 'bytesDigest', 'finalizedAtMs', 'retention']);
  const receiver = originRecord(file.receiver, ['app', 'team', 'owner', 'principal']);
  const retainsAttached = typeof file.retention === 'object' && file.retention !== null && Object.hasOwn(file.retention, 'retainAttached');
  const retention = originRecord(file.retention, ['unattachedHorizonMs', 'retentionMs', ...(retainsAttached ? ['retainAttached'] : [])]);
  const { kind: provenanceKind, provenance } = readOriginFileProvenance(file);
  const epoch = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (!originString(file.ref) || !originString(file.contentType) || typeof file.bytesDigest !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(file.bytesDigest) || !epoch(file.sizeBytes) || !epoch(file.finalizedAtMs) ||
      !Object.values(receiver).every(originString) || !epoch(retention.unattachedHorizonMs) || !epoch(retention.retentionMs) ||
      retainsAttached && retention.retainAttached !== true ||
      !['request', 'event'].includes(String(provenanceKind)) ||
      !Object.entries(provenance).every(([key, value]) => key === 'itemIndex' ? epoch(value) : originString(value))) {
    throw new ReceiptTableError('work.receipt filePayloadOrigin has invalid original File facts.');
  }
}

/** Read one receipt row's data, failing closed on any shape drift. */
export function readReceiptRow(row: StoredRow, context?: ReceiptResultContext): StoredReceiptRow {
  const data = checkRecord(row.data, 'work.receipt data');
  const deliveryId = checkString(data, 'deliveryId', 'work.receipt');
  const revision = checkRevision(data, 'revision', 'work.receipt');
  const status = checkStatus(data);
  const result = data['result'] === undefined ? null : data['result'];
  const error = data['error'] === undefined ? null : data['error'];
  if (!isStoredReceiptPayload(status, result, error, context)) {
    throw new ReceiptTableError(
      `work.receipt payload is inconsistent for status ${JSON.stringify(status)}.`,
    );
  }
  if (row.id !== deliveryId) {
    throw new ReceiptTableError('work.receipt row id must equal its deliveryId.');
  }
  const filePayloadOrigin = receiptOrigin(data, row, deliveryId, context);
  return {
    receipt: {
      deliveryId,
      revision,
      status,
      result,
      error: error as ReceiptError | null,
    },
    contentRef: checkNullableContentRef(data),
    resultExpiresAtMs: checkNullableExpiry(data),
    ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }),
  };
}

export interface NewRowMeta {
  /** UTC epoch ms for created/updated. */
  readonly nowMs: number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
}

function newRow(
  id: string,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,
): StoredRow {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new ReceiptTableError(`${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new ReceiptTableError(`${what}: actor must be a non-empty string.`);
  }
  checkJsonSafe(data, `${what} data`);
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: meta.nowMs,
    updated: meta.nowMs,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    archivedAt: null,
    parent: null,
    // Deep clone: staged rows must not alias caller-owned nested data.
    data: structuredClone(data),
  };
}

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. The observation revision must advance
 * monotonically (equal revisions are idempotent replays); a decreased
 * revision is stale progress and refused here, before the store. Callers
 * stage the result with `expectedVersion: row.version`.
 */
function withRowData(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  revision: number,
  meta: NewRowMeta,
  what: string,
): StoredRow {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new ReceiptTableError(`${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new ReceiptTableError(`${what}: actor must be a non-empty string.`);
  }
  const current = (row.data as Readonly<Record<string, unknown>>)['revision'];
  if (typeof current === 'number' && revision < current) {
    throw new ReceiptTableError(
      `${what}: stale revision ${revision} under current ${current}.`,
    );
  }
  checkJsonSafe(data, `${what} data`);
  return {
    ...row,
    version: (row.version + 1) as RecordVersion,
    updated: meta.nowMs,
    updatedBy: meta.actor,
    // Deep clone: staged rows must not alias caller-owned nested data.
    data: structuredClone(data),
  };
}

/** Producer-side insert: the current-attempt association for one locator. */
export function newAssociationRow(input: AssociationRowData, meta: NewRowMeta): StoredRow {
  const row = newRow(
    associationRowId(input.recordModel, input.recordId, input.field),
    input as unknown as Readonly<Record<string, unknown>>,
    meta,
    'work.receipt_association',
  );
  // The constructor validates shape, never linkage: fail fast here so a
  // malformed association never stages.
  readAssociationRow(row);
  return row;
}

/** Producer-side insert: the retained receipt row for one delivery attempt. */
export function newReceiptRow(input: ReceiptRowData, meta: NewRowMeta, context?: ReceiptResultContext): StoredRow {
  if (context !== undefined && context !== null && ('judgment' in context ||
      (input.result != null && (context.source.startsWith('std.TextGenerationV1.') ||
        ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source)))) &&
      !isStoredReceiptPayload(input.status, input.result, input.error, context)) {
    throw new ReceiptTableError('work.receipt payload is inconsistent for its declared context.');
  }
  const filePayloadOrigin = receiptOrigin(input, { id: input.deliveryId as RecordId, created: meta.nowMs, createdBy: meta.actor }, input.deliveryId, context);
  const row = newRow(
    input.deliveryId,
    (filePayloadOrigin === undefined ? input : { ...input, filePayloadOrigin }) as unknown as Readonly<Record<string, unknown>>,
    meta,
    'work.receipt',
  );
  readReceiptRow(row, context);
  return row;
}

/** Conditional-update replacement for one association row (see `withRowData`). */
export function withAssociationRowData(
  row: StoredRow,
  data: AssociationRowData,
  meta: NewRowMeta,
): StoredRow {
  const next = withRowData(
    row,
    data as unknown as Readonly<Record<string, unknown>>,
    data.revision,
    meta,
    'work.receipt_association',
  );
  readAssociationRow(next);
  return next;
}

/** Conditional-update replacement for one receipt row (see `withRowData`). */
export function withReceiptRowData(
  row: StoredRow,
  data: ReceiptRowData,
  meta: NewRowMeta,
  context?: ReceiptResultContext,
): StoredRow {
  if (context !== undefined && context !== null && ('judgment' in context ||
      (data.result != null && (context.source.startsWith('std.TextGenerationV1.') ||
        ['std.ImagesV1.submit', 'std.ImagesV1.cancel', 'std.ImagesV1.reconcile'].includes(context.source)))) &&
      !isStoredReceiptPayload(data.status, data.result, data.error, context)) {
    throw new ReceiptTableError('work.receipt payload is inconsistent for its declared context.');
  }
  const original = receiptOrigin(row.data, row, row.id as string, context);
  const supplied = receiptOrigin(data, row, data.deliveryId, context);
  if (original !== undefined && supplied !== undefined) {
    const { files: originalFiles, ...originalBinding } = original;
    const { files: suppliedFiles, ...suppliedBinding } = supplied;
    if (!sameJudgmentWire(originalBinding, suppliedBinding)) {
      throw new ReceiptTableError('work.receipt cannot replace its original payload binding.');
    }
    // Replacing a File position may add/remove original observations, but a
    // repeated physical reference must keep its original facts and horizons.
    const priorFacts = new Map(originalFiles.map(entry => [entry.file.ref, entry.file]));
    for (const entry of suppliedFiles) {
      const prior = priorFacts.get(entry.file.ref);
      if (prior !== undefined && !sameJudgmentWire(entry.file, prior)) {
        throw new ReceiptTableError('work.receipt cannot renew or replace original File facts.');
      }
    }
  } else if (original === undefined && supplied !== undefined) {
    throw new ReceiptTableError('work.receipt cannot bind an existing unbound lifetime.');
  }
  const filePayloadOrigin = supplied ?? original;
  const next = withRowData(
    row,
    (filePayloadOrigin === undefined ? data : { ...data, filePayloadOrigin }) as unknown as Readonly<Record<string, unknown>>,
    data.revision,
    meta,
    'work.receipt',
  );
  readReceiptRow(next, context);
  return next;
}

interface JoinWrite {
  readonly model: string;
  readonly id: string;
  readonly deliveryId: string;
  readonly revision: number;
  readonly association?: AssociationRowData;
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
}

function readJoinWrite(
  model: string,
  row: StoredRow,
  updateId: string | null,
  contexts?: ReadonlyMap<string, ReceiptResultContext>,
): JoinWrite {
  if (updateId !== null && updateId !== row.id) {
    throw new StateError(
      'validation',
      `Receipt join: ${model} update id ${JSON.stringify(updateId)} ` +
        `must equal its row id ${JSON.stringify(row.id)}.`,
    );
  }
  try {
    if (model === RECEIPT_ASSOCIATION_MODEL) {
      const association = readAssociationRow(row);
      return {
        model,
        id: row.id as string,
        deliveryId: association.deliveryId,
        revision: association.revision,
        association: row.data as unknown as AssociationRowData,
      };
    }
    const deliveryId = checkString(checkRecord(row.data, 'work.receipt data'), 'deliveryId', 'work.receipt');
    const stored = readReceiptRow(row, contexts?.get(deliveryId));
    return {
      model,
      id: row.id as string,
      deliveryId: stored.receipt.deliveryId,
      revision: stored.receipt.revision,
      ...(stored.filePayloadOrigin === undefined ? {} : { filePayloadOrigin: stored.filePayloadOrigin }),
    };
  } catch (error) {
    if (error instanceof ReceiptTableError) {
      throw new StateError('validation', `Receipt join: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Assert the receipt-join linkage for one commit batch BEFORE it touches
 * the store (fail closed, `StateError` validation):
 *
 * - Every association insert/update carries a receipt insert/update for
 *   the SAME delivery id at the SAME revision in the same batch: the
 *   current-attempt pair advances together, never apart. Initial
 *   association, replacement (new delivery id + new pending receipt)
 *   and current-attempt progress all stage both halves.
 * - Receipt-only writes are allowed: superseded attempts update their
 *   own receipt rows without touching the current association, and
 *   fixtures may provision receipt rows before associating them.
 * - Same-batch duplicate writes to one row and update id/row id
 *   mismatches fail closed.
 *
 * Ordinary batches with neither half pass trivially, so non-receipt
 * callers are unaffected. Claim-style conditional updates on other
 * models pass trivially too.
 */
interface ReceiptJoinScan {
  readonly associations: Map<string, JoinWrite>;
  readonly receipts: Map<string, JoinWrite>;
  readonly seen: Set<string>;
}

function foldReceiptJoinWrite(
  write: NonNullable<CommitBatch['writes']>[number],
  scan: ReceiptJoinScan,
  contexts: ReadonlyMap<string, ReceiptResultContext> | undefined,
): void {
  const model = write.model as string;
  if (model !== RECEIPT_ASSOCIATION_MODEL && model !== RECEIPT_MODEL) {
    return;
  }
  if (write.kind === 'remove') {
    return;
  }
  const rowId = (write.kind === 'insert' ? write.row.id : write.id) as string;
  const key = `${model}\0${rowId}`;
  if (scan.seen.has(key)) {
    throw new StateError(
      'validation',
      `Receipt join: duplicate ${model} write for ${JSON.stringify(rowId)}.`,
    );
  }
  scan.seen.add(key);
  const join =
    write.kind === 'insert'
      ? readJoinWrite(model, write.row, null, contexts)
      : readJoinWrite(model, write.row, write.id as string, contexts);
  if (model === RECEIPT_ASSOCIATION_MODEL) {
    const context = contexts?.get(join.deliveryId);
    if (context !== undefined && readAssociationRow(write.row).source !== context.source) {
      throw new StateError('validation', 'Receipt join: declaration context disagrees with association source.');
    }
    scan.associations.set(join.deliveryId, join);
  } else {
    scan.receipts.set(join.deliveryId, join);
  }
}

function checkSkippedDispatch(batch: CommitBatch, receipts: ReadonlyMap<string, JoinWrite>): void {
  for (const receipt of receipts.values()) {
    const original = receipt.filePayloadOrigin?.origin;
    if (original?.kind !== 'delivery-skipped') continue;
    const send = original.send;
    const queued = batch.outbox?.some(intent => intent.intentId === original.deliveryId ||
      intent.operationId === send.operationId && intent.target === send.target && intent.occurrenceIndex === send.occurrenceIndex);
    const dispatch = batch.writes?.some(write => write.kind !== 'remove' && String(write.model) === 'work.dispatch' &&
      (String(write.row.id) === original.deliveryId || write.row.data.operationId === send.operationId &&
        write.row.data.source === send.target && write.row.data.occurrenceIndex === send.occurrenceIndex));
    if (queued || dispatch) throw new StateError('validation', 'Receipt-only skipped SEND cannot queue its original provider dispatch.');
  }
}

export function assertReceiptJoin(batch: CommitBatch, contexts?: ReadonlyMap<string, ReceiptResultContext>): void {
  const scan: ReceiptJoinScan = { associations: new Map<string, JoinWrite>(),
    receipts: new Map<string, JoinWrite>(), seen: new Set<string>() };
  for (const write of batch.writes ?? []) {
    foldReceiptJoinWrite(write, scan, contexts);
  }
  const { associations, receipts } = scan;
  checkSkippedDispatch(batch, receipts);
  for (const association of associations.values()) {
    const receipt = receipts.get(association.deliveryId);
    if (receipt === undefined) {
      throw new StateError(
        'validation',
        `Receipt join: association for ${JSON.stringify(association.deliveryId)} ` +
          'has no receipt row in this batch.',
      );
    }
    const original = receipt.filePayloadOrigin?.origin;
    if (original !== undefined && ((original.kind !== 'delivery-result' && original.kind !== 'delivery-skipped') ||
        original.association.model !== association.association!.recordModel ||
        original.association.recordId !== association.association!.recordId ||
        original.association.field !== association.association!.field ||
        (original.kind === 'delivery-skipped' ? original.send.target : original.intent.target) !== association.association!.source)) {
      throw new StateError('validation', 'Receipt join: original payload binding disagrees with its association.');
    }
    if (receipt.revision !== association.revision) {
      throw new StateError(
        'validation',
        `Receipt join: receipt revision ${receipt.revision} disagrees with ` +
          `association revision ${association.revision} for ` +
          `${JSON.stringify(association.deliveryId)}.`,
      );
    }
  }
}

/** Single-shot receipt-join commit surface (no retry — callers decide). */
export interface ReceiptJoinPort {
  commitJoin(batch: CommitBatch & { expectedRevision: Revision }): Promise<CommitResult>;
}

/**
 * Create the receipt-join port over one store: linkage-asserted,
 * single-shot fenced commit. Storage errors map via
 * `storageToStateError` (fence conflicts surface as retryable `busy`),
 * mirroring `createTransactionPort`.
 */
export function createReceiptJoinPort(input: { readonly store: StoragePort;
  readonly resultContexts?: (batch: CommitBatch) => ReadonlyMap<string, ReceiptResultContext> }): ReceiptJoinPort {
  return {
    commitJoin: async (batch) => {
      assertReceiptJoin(batch, input.resultContexts?.(batch));
      try {
        return await input.store.commit(batch);
      } catch (error) {
        throw storageToStateError(error);
      }
    },
  };
}
