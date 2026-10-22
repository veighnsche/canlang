/** Actual final-net source staging inside the owning mutation finalizer.
 * Facts carry identity/version only; no copied token, saved JSON or framework
 * row can open this lifetime or acquire business-row disclosure authority. */
import type { DomainWrite, InvocationContext, ModelName, RecordId, RecordVersion, Revision } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { stableStringify } from '../invocation/replay.js';
import type { SystemCommandContext } from '../ports/system.js';
import type { MutationWritesResult, OwnerMutationReadView } from './pipeline.js';

export interface OwnerMutationFinalChange {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly version: RecordVersion;
  readonly kind: 'created' | 'updated' | 'deleted';
}
declare const sourceStageBrand: unique symbol;
export interface OwnerMutationSourceStage { readonly [sourceStageBrand]: true }
export type OwnerMutationSourceStager = (stage: OwnerMutationSourceStage) => Promise<readonly DomainWrite[]>;
export interface OwnerMutationSourceStageView {
  readonly context: InvocationContext;
  readonly revision: Revision;
  readonly maxRows: number;
  readonly changes: readonly OwnerMutationFinalChange[];
  readonly entry: OwnerMutationReadView;
  readonly final: OwnerMutationReadView;
  readonly framework: SystemCommandContext;
  readonly consumeWork: (amount?: number) => void;
}
const FRAMEWORK_MODELS = new Set(['work.handler_occurrence', 'work.occurrence', 'work.fanout_intent',
  'work.fanout_checkpoint', 'work.fanout_child', 'work.schedule', 'work.supersession']);
const stageIdentity = Symbol('owner-mutation-source-stage');
interface StageLedger {
  phase: 'active' | 'checking' | 'closed';
  pending: number;
  poisoned: boolean;
  readonly poison: () => void;
  view?: OwnerMutationSourceStageView;
}
const stages = new WeakMap<object, StageLedger>();
const identities = new WeakMap<object, StageLedger>();
const businessWrites = new WeakMap<MutationWritesResult, readonly DomainWrite[]>();
function fail(ledger: StageLedger | undefined, message: string): never {
  if (ledger !== undefined) { ledger.poisoned = true; ledger.poison(); }
  throw new StateError('validation', `Owner mutation source: ${message}`);
}
function active(ledger: StageLedger): void {
  if (ledger.phase !== 'active' || ledger.poisoned) fail(ledger, 'stage is closed or poisoned.');
}
/** Consume only the original live token. Its private symbol lets a copied
 * token poison its own run without turning the copy into an active carrier.
 * Raw/serialized tokens refuse without attribution. A caught unidentifiable
 * or foreign helper misuse cannot poison an unrelated owner without its
 * genuine token; uncaught callback errors poison the calling pipeline. */
export function readOwnerMutationSourceStage(stage: OwnerMutationSourceStage): OwnerMutationSourceStageView {
  const ledger = typeof stage === 'object' && stage !== null ? stages.get(stage) : undefined;
  if (ledger === undefined) {
    const descriptor = typeof stage === 'object' && stage !== null ? Object.getOwnPropertyDescriptor(stage, stageIdentity) : undefined;
    const original = descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'object' && descriptor.value !== null
      ? identities.get(descriptor.value) : undefined;
    if (original !== undefined) { original.poisoned = true; original.poison(); }
    return fail(original, 'genuine active finalization token required.');
  }
  active(ledger);
  if (ledger.pending !== 0) return fail(ledger, 'stage read cannot overlap an outstanding reader.');
  return ledger.view!;
}
/** Genuine finalized results retain their original business subset privately;
 * legacy/no-source finalization keeps the existing result.writes behavior. */
export function ownerMutationBusinessWrites(result: MutationWritesResult): readonly DomainWrite[] {
  return businessWrites.get(result) ?? result.writes;
}

/** Internal-only registration; never exported by State's public barrels. */
export function retainOwnerMutationBusinessWrites(result: MutationWritesResult, writes: readonly DomainWrite[]): void {
  businessWrites.set(result, Object.freeze([...writes]));
}

/** Own JSON only, detached before any callback output can become a write. */
function dataCopy<T>(value: T, maximum=20_000, charge?: (nodes:number)=>void): T {
  let nodes = 0; const seen = new Set<object>();
  const budget: DataCopyBudget = { nodes, seen, maximum };
  try { const copied=dataCopyValue(value,0,budget) as T;charge?.(budget.nodes);return copied; }
  catch (error) { if (error instanceof StateError) throw error; return fail(undefined, 'own JSON data required.'); }
}
interface DataCopyBudget { nodes: number; readonly seen: Set<object>; readonly maximum:number; }

function dataCopyEntry(
  part: object,
  key: string | symbol,
  array: boolean,
  length: number,
  out: unknown[] | Record<string, unknown>,
  depth: number,
  budget: DataCopyBudget,
): void {
  if (array && key === 'length') return;
  const member = Object.getOwnPropertyDescriptor(part, key);
  if (typeof key !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
      array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return fail(undefined, 'own enumerable JSON members required.');
  Object.defineProperty(out, key, { value: dataCopyValue(member.value, depth + 1, budget), enumerable: true, configurable: true, writable: true });
}

function checkDataCopyShape(
  part: object,
  array: boolean,
  budget: DataCopyBudget,
): { readonly keys: readonly (string | symbol)[]; readonly count: number } {
  const prototype = Object.getPrototypeOf(part);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    return fail(undefined, 'own JSON prototype required.');
  }
  const keys = Reflect.ownKeys(part);
  if (keys.length > budget.maximum - budget.nodes) return fail(undefined, 'finite JSON budget exceeded.');
  if (!array) return { keys, count: 0 };
  const length = Object.getOwnPropertyDescriptor(part, 'length');
  if (length === undefined || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 ||
      length.value > budget.maximum || keys.length !== length.value + 1) return fail(undefined, 'finite dense array required.');
  return { keys, count: length.value };
}

function dataCopyValue(part: unknown, depth: number, budget: DataCopyBudget): unknown {
  if (++budget.nodes > budget.maximum || depth > 32) return fail(undefined, 'finite JSON budget exceeded.');
  if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
  if (typeof part === 'number' && Number.isFinite(part)) return part;
  if (typeof part !== 'object' || part === null || budget.seen.has(part)) return fail(undefined, 'own JSON data required.');
  const array = Array.isArray(part);
  budget.seen.add(part);
  const { keys, count } = checkDataCopyShape(part, array, budget);
  const out: unknown[] | Record<string, unknown> = array ? [] : {};
  for (const key of keys) {
    dataCopyEntry(part, key, array, count, out, depth, budget);
  }
  budget.seen.delete(part); return out;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) return fail(undefined, 'closed owning write shape required.');
  return value as Record<string, unknown>;
}
type SourceStageInput = Parameters<typeof stageOwnerMutationSources>[0];

async function checkSourceInsert(
  input: SourceStageInput,
  candidate: unknown,
  seen: Set<string>,
  ledger: StageLedger,
): Promise<void> {
  const write = object(candidate, ['kind', 'model', 'row']);
  const model = identity(write['model']);
  if (write['kind'] !== 'insert' || !FRAMEWORK_MODELS.has(model) || input.businessModels.has(model)) return fail(ledger, 'only noncolliding source framework inserts are supported.');
  const rowValue = write['row'];
  const row = object(rowValue, ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'data',
    ...(typeof rowValue === 'object' && rowValue !== null && Object.hasOwn(rowValue, 'parent') ? ['parent'] : [])]);
  // Existing Work codecs own composite identities. Three URI-encoded
  // bounded components need a larger finite carrier budget than a model.
  const id = identity(row['id'], 6000);
  if (row['version'] !== 1 || row['archivedAt'] !== null || row['parent'] !== undefined && row['parent'] !== null ||
      row['created'] !== input.context.now || row['updated'] !== input.context.now ||
      row['createdBy'] !== input.actor || row['updatedBy'] !== input.actor ||
      typeof row['data'] !== 'object' || row['data'] === null || Array.isArray(row['data'])) return fail(ledger, 'source inserts require an original-attribution live unparented version-one row.');
  const key = `${model}\0${id}`;
  if (seen.has(key)) return fail(ledger, 'duplicate source insert identity.'); seen.add(key);
  await input.checkRevision(); input.healthy();
  if (await input.frameworkLoad(model as ModelName, id as RecordId) !== null) return fail(ledger, 'source insert identity already exists.');
  await input.checkRevision(); input.healthy();
}

/** The source finalizer admits one existing Work lifecycle transition, never
 * generic updates. The installed cancellation producer retains exact source
 * effect ownership; State independently checks its physical live preimage. */
async function checkSourceCancellation(input: SourceStageInput, candidate: unknown,
  seen: Set<string>, ledger: StageLedger): Promise<void> {
  const write = object(candidate, ['kind', 'model', 'id', 'expectedVersion', 'row']);
  if (write['kind'] !== 'update' || write['model'] !== 'work.schedule' ||
      input.businessModels.has('work.schedule')) return fail(ledger, 'only noncolliding Work schedule cancellations are supported.');
  const id = identity(write['id'], 6000), key = `work.schedule\0${id}`;
  if (seen.has(key)) return fail(ledger, 'duplicate source write identity.');
  seen.add(key);
  await input.checkRevision(); input.healthy();
  const before = await input.frameworkLoad('work.schedule' as ModelName, id as RecordId);
  await input.checkRevision(); input.healthy();
  if (before === null || before.id !== id || before.archivedAt !== null ||
      write['expectedVersion'] !== before.version || !Number.isSafeInteger(before.version + 1) ||
      !['pending', 'admitted'].includes(String(before.data['state']))) {
    return fail(ledger, 'source cancellation requires its original live pending or admitted version.');
  }
  const expected = { ...before, version: before.version + 1, updated: input.context.now,
    updatedBy: input.actor, data: { ...before.data, state: 'cancelled' } };
  if (stableStringify(write['row']) !== stableStringify(expected)) {
    return fail(ledger, 'source cancellation changed immutable row identity, attribution or data.');
  }
}

function identity(value: unknown, maxLength = 200): string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : fail(undefined, 'bounded nonempty identity required.');
}

/** Internal pipeline-only issuer. It wraps the actual private policy views
 * while finalize holds the outer serial lock; no store/commit port is exposed. */
export async function stageOwnerMutationSources(input: {
  readonly stager: OwnerMutationSourceStager;
  readonly context: InvocationContext;
  readonly revision: Revision;
  readonly maxRows: number;
  readonly maxSourceNodes?:number;
  readonly maxSourceRows?:number;
  readonly changes: readonly OwnerMutationFinalChange[];
  readonly entry: OwnerMutationReadView;
  readonly final: OwnerMutationReadView;
  readonly actor: string;
  readonly frameworkLoad: SystemCommandContext['load'];
  readonly businessModels: ReadonlySet<string>;
  readonly healthy: () => void;
  readonly poison: () => void;
  readonly checkRevision: () => Promise<void>;
  readonly consumeWork: (amount?: number) => void;
}): Promise<readonly DomainWrite[]> {
  const ledger: StageLedger = { phase: 'active', pending: 0, poisoned: false, poison: input.poison };
  const charge = (amount?: number): void => {
    active(ledger); input.healthy();
    if (ledger.pending !== 0) return fail(ledger, 'work charge cannot overlap an outstanding reader.');
    try { input.consumeWork(amount); } catch (error) { ledger.poisoned = true; input.poison(); throw error; }
  };
  const read = async <T>(execute: () => Promise<T>): Promise<T> => {
    active(ledger); input.healthy();
    if (ledger.pending !== 0) return fail(ledger, 'concurrent source readers are forbidden.');
    ledger.pending++;
    try {
      input.consumeWork(); await input.checkRevision(); active(ledger); input.healthy();
      const value = await execute(); active(ledger); input.healthy();
      await input.checkRevision(); active(ledger); input.healthy();
      return deepFreeze(dataCopy(value));
    } catch (error) { ledger.poisoned = true; input.poison(); throw error; }
    finally { ledger.pending--; }
  };
  const view = (underlying: OwnerMutationReadView): OwnerMutationReadView => Object.freeze({
    get: (model: ModelName, id: RecordId) => read(() => {
      if (!input.businessModels.has(model)) return fail(ledger, 'known owning business model required.');
      return underlying.get(model, id);
    }),
    query: (spec: Parameters<OwnerMutationReadView['query']>[0]) => read(() => {
      const selection = dataCopy(spec);
      if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) return fail(ledger, 'own finite business query required.');
      return underlying.query(deepFreeze(selection));
    }),
  });
  const framework: SystemCommandContext = Object.freeze({ actor: input.actor, now: input.context.now, operation: input.context.operation,
    load: (model: ModelName, id: RecordId) => read(() => {
      if (!FRAMEWORK_MODELS.has(model) || input.businessModels.has(model)) return fail(ledger, 'unknown or colliding framework model.');
      identity(id, 6000); return input.frameworkLoad(model, id);
    }),
    // Unsupported queries are still genuine view misuse and poison this run.
    query: async () => { active(ledger); return fail(ledger, 'framework query requires a defining source join.'); },
  });
  if ([...input.businessModels].some(model => FRAMEWORK_MODELS.has(model))) return fail(ledger, 'business model inventory collides with source framework models.');
  if (input.changes.length > input.maxRows) return fail(ledger, 'final change bound exceeded.');
  input.consumeWork(input.changes.length + 1);
  const tokenIdentity = Object.freeze({});
  const token = Object.freeze({ [stageIdentity]: tokenIdentity }) as unknown as OwnerMutationSourceStage;
  ledger.view = Object.freeze({ context: input.context, revision: input.revision, maxRows: input.maxRows,
    changes: deepFreeze(dataCopy(input.changes)), entry: view(input.entry), final: view(input.final), framework, consumeWork: charge });
  stages.set(token, ledger); identities.set(tokenIdentity, ledger);
  try {
    const output = await input.stager(token);
    if (ledger.pending !== 0) return fail(ledger, 'source callback left an unawaited reader.');
    active(ledger); input.healthy(); ledger.phase = 'checking';
    const maximum=input.maxSourceNodes??20_000;
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>200_000)return fail(ledger,'invalid finite source JSON budget.');
    const writes = dataCopy(output,maximum,input.maxSourceNodes===undefined?undefined:input.consumeWork);
    const maxSourceRows=input.maxSourceRows??input.maxRows;
    if(!Number.isSafeInteger(maxSourceRows)||maxSourceRows<1||input.maxSourceRows!==undefined&&maxSourceRows>1_000)return fail(ledger,'invalid finite source row budget.');
    if (!Array.isArray(writes) || writes.length > maxSourceRows) return fail(ledger, 'bounded source write array required.');
    const seen = new Set<string>();
    for (const candidate of writes) {
      input.consumeWork(); input.healthy();
      if (typeof candidate === 'object' && candidate !== null && candidate.kind === 'update') {
        await checkSourceCancellation(input, candidate, seen, ledger);
      } else await checkSourceInsert(input, candidate, seen, ledger);
    }
    if (ledger.poisoned) return fail(ledger, 'source stage is poisoned.');
    return deepFreeze(writes);
  } catch (error) { ledger.poisoned = true; input.poison(); throw error; }
  finally { ledger.phase = 'closed'; }
}
