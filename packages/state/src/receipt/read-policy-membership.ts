/** Membership at a genuine installed source read, never a business owner call.
 * The checked native loader binds literal source/argument/Team ports. Only the
 * owning State reader opens the coherent observation lifetime below. */
import type { ModelName, ProjectedRecord, RecordId, ScenarioReceiptSourceOrigin, StoragePort, StoredRow, TeamScope } from '@canlang/contracts';
import { isUserRef, type UserRef } from '@canlang/values';
import { StateError } from '../errors.js';
import { checkScenarioReceiptMembershipSites, type ScenarioReceiptMembershipSite } from '../invocation/scenario-membership-plan.js';
import { stableStringify } from '../invocation/replay.js';
import { checkedMembershipFact } from '../policy/membership-facts.js';
import { FenceConflictError } from '../storage/port.js';
import type { ViewerGenerationCallbackReadObservation } from './callback-diagnostics.js';

export type ReadPolicyMembershipHandle = Readonly<object>;
export type InstalledSourceReadPredicate = (observation: Readonly<ViewerGenerationCallbackReadObservation>) => Promise<boolean>;
export type InstalledSourceQueryPredicate = (record: Readonly<ProjectedRecord>,
  observation?: Readonly<ViewerGenerationCallbackReadObservation>) => boolean | Promise<boolean>;
type InstalledRead = InstalledSourceReadPredicate | InstalledSourceQueryPredicate;
type ReadStage = 'read-policy' | 'read-predicate';
export interface ReadPolicyMembershipProducer {
  readonly source: ScenarioReceiptSourceOrigin;
  /** Exact emitted read/callbackRead rule or checked query owner identity. */
  readonly rule: string;
  readonly sites: readonly ScenarioReceiptMembershipSite[];
  /** The literal adapter maps the actual native Team to its corresponding
   * verified read scope. A source-authored Team/id cannot supply this pointer. */
  readonly team: (observation: Readonly<ViewerGenerationCallbackReadObservation>) => TeamScope | null;
  /** Consume this occurrence's actual privately evaluated arguments once,
   * synchronously before any Identity or State read yields. */
  readonly capture: (observation: Readonly<ViewerGenerationCallbackReadObservation>,
    site: ScenarioReceiptMembershipSite, callIndex: number) => { readonly person: UserRef; readonly team: TeamScope };
}
interface BoundRead {
  readonly read: InstalledRead;
  readonly stage: ReadStage;
  readonly source: ScenarioReceiptSourceOrigin;
  readonly rule: string;
  readonly team: ReadPolicyMembershipProducer['team'];
  readonly capture: ReadPolicyMembershipProducer['capture'];
  readonly occurrences: readonly string[];
  readonly callCount: number;
}
/** Internal receipt-owner row closure, never part of a public read input. */
export interface InstalledSourceOwnerRows {
  readonly read: (model: ModelName, id: RecordId) => Promise<StoredRow | null>;
  readonly assertHealthy: () => void;
  /** Exact bounded declared domain supplied by the same owning stage, never a store scan. */
  readonly query?: (model: ModelName, parent?: Readonly<{model: ModelName; id: RecordId}>) => Promise<readonly StoredRow[]>;
  /** Reached original installed-policy decision inputs, confined to its bool lifetime. */
  readonly policyQuery?: (model: ModelName, parent?: Readonly<{model: ModelName; id: RecordId}>) => Promise<readonly StoredRow[]>;
}
export function captureInstalledSourceOwnerRows(scope: InstalledSourceOwnerRows): InstalledSourceOwnerRows {
  const value = object(scope, ['read', 'assertHealthy', ...(Object.hasOwn(scope, 'query') ? ['query'] : []),
    ...(Object.hasOwn(scope, 'policyQuery') ? ['policyQuery'] : [])]);
  if (typeof value.read !== 'function' || typeof value.assertHealthy !== 'function' ||
      Object.hasOwn(value, 'query') && typeof value.query !== 'function' ||
      Object.hasOwn(value, 'policyQuery') && typeof value.policyQuery !== 'function') return fail('owning row closure required.');
  return Object.freeze({ read: value.read, assertHealthy: value.assertHealthy,
    ...(Object.hasOwn(value, 'query') ? { query: value.query } : {}),
    ...(Object.hasOwn(value, 'policyQuery') ? { policyQuery: value.policyQuery } : {}) }) as InstalledSourceOwnerRows;
}
interface ReadLifetime {
  readonly ownerRows: InstalledSourceOwnerRows | undefined;
  readonly read: InstalledRead;
  readonly stage: ReadStage;
  readonly observation: Readonly<ViewerGenerationCallbackReadObservation>;
  readonly store: StoragePort;
  readonly bound: readonly BoundRead[];
  readonly parent: ReadLifetime | null;
  readonly parentNavigation: ReadNavigation | null;
  readonly navigationTargets: Set<string>;
  navigation: ReadNavigation | null;
  pending: boolean;
  poisoned: boolean;
  closed: boolean;
  count: number;
}
interface ReadNavigation {
  readonly key: string;
  child: ReadLifetime | null;
}
const bindings = new WeakMap<InstalledRead, readonly BoundRead[]>();
const invoked = new WeakSet<InstalledRead>();
const installedPredicates = new WeakMap<InstalledSourceQueryPredicate, InstalledSourceQueryPredicateProducer>();
const handles = new WeakMap<ReadPolicyMembershipHandle, {
  readonly bound: BoundRead; readonly site: ScenarioReceiptMembershipSite; readonly callIndex: number;
}>();
const lifetimes = new WeakMap<object, ReadLifetime>();
const contexts = new WeakMap<object, ReadLifetime>();
const fail = (message: string): never => { throw new StateError('validation', `Read-policy membership: ${message}`); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => { const entry = Object.getOwnPropertyDescriptor(value, key);
        return entry === undefined || !('value' in entry) || !entry.enumerable; })) return fail('closed own data required.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : fail('bounded source identity required.');
}
function teamSnapshot(team: TeamScope): string {
  const value = object(team, ['teamId', 'timezone']);
  return stableStringify({ teamId: text(value.teamId), timezone: text(value.timezone) });
}

/** Copies identify their issuer only for poisoning, never for authority. */
function observationLifetime(observation: unknown): ReadLifetime | undefined {
  if (typeof observation !== 'object' || observation === null) return undefined;
  const exact = lifetimes.get(observation);
  if (exact !== undefined) return exact;
  const context = Object.getOwnPropertyDescriptor(observation, 'context');
  return context !== undefined && 'value' in context && typeof context.value === 'object' && context.value !== null
    ? contexts.get(context.value) : undefined;
}
function poison(lifetime: ReadLifetime | undefined): void {
  for (let current = lifetime; current !== undefined; current = current.parent ?? undefined) current.poisoned = true;
}
function checkNestedNavigation(current: ReadLifetime, parent: ReadLifetime): void {
  const observation = current.observation;
  if (!parent.pending || parent.navigation === null ||
      parent.navigation !== current.parentNavigation || parent.navigation.child !== current ||
      parent.store !== current.store || parent.ownerRows !== current.ownerRows || parent.observation.revision !== observation.revision ||
      parent.observation.fence !== observation.fence ||
      parent.observation.context.actorUserId !== observation.context.actorUserId ||
      parent.observation.context.teamId !== observation.context.teamId ||
      parent.observation.context.membership !== observation.context.membership ||
      parent.observation.context.memberships !== observation.context.memberships) {
    return fail('nested read crossed its original owning navigation.');
  }
}

function checkLifetimeLevel(current: ReadLifetime): void {
  current.ownerRows?.assertHealthy();
  const observation = current.observation;
  if (current.closed || current.poisoned || lifetimes.get(observation) !== current ||
      contexts.get(observation.context) !== current || observation.fence !== undefined &&
      observation.fence.revision !== observation.revision) {
    return fail('read crossed its original active observation/checkpoint.');
  }
  const parent: ReadLifetime | null = current.parent;
  if (parent !== null) checkNestedNavigation(current, parent);
}

function healthyLifetime(lifetime: ReadLifetime): void {
  for (let current: ReadLifetime | null = lifetime; current !== null; current = current.parent) {
    checkLifetimeLevel(current);
  }
}

/** Internal State navigation lease; no caller can issue or replace its observation. */
export function withinInstalledReadObservation<Result>(observation: Readonly<ViewerGenerationCallbackReadObservation>,
  input: { readonly store: StoragePort; readonly model: ModelName; readonly id: RecordId },
  execute: (checkpoint: () => Promise<void>,
    loadRow: (model: ModelName, id: RecordId) => Promise<StoredRow | null>,
    ownerRows: InstalledSourceOwnerRows | undefined) => Promise<Result>): Promise<Result> {
  return withinInstalledSourceReadLease(observation, input, false, execute);
}

/** Private collection/ref consumer. Control authority comes from the actual
 * installed read-policy lifetime, never a caller-selected query option. */
export function withinInstalledSourceReadQuery<Result>(observation: Readonly<ViewerGenerationCallbackReadObservation>,
  input: { readonly store: StoragePort; readonly model: ModelName },
  execute: (checkpoint: () => Promise<void>,
    loadRow: (model: ModelName, id: RecordId) => Promise<StoredRow | null>,
    ownerRows: InstalledSourceOwnerRows | undefined, control: boolean) => Promise<Result>): Promise<Result> {
  return withinInstalledSourceReadLease(observation, input, true, execute);
}

/** A genuine source-Require predicate may borrow only its State-issued owner
 * rows. Ordinary source reads and read-policy control queries use the viewer
 * path above and cannot enter this lease. */
export function withinInstalledOwnerDecisionQuery<Result>(observation: Readonly<ViewerGenerationCallbackReadObservation>,
  input: { readonly store: StoragePort; readonly model: ModelName },
  execute: (checkpoint: () => Promise<void>, ownerRows: InstalledSourceOwnerRows) => Promise<Result>): Promise<Result> {
  const lifetime = observationLifetime(observation);
  if (lifetime?.stage !== 'read-predicate' || lifetime.ownerRows?.query === undefined) {
    return fail('owner decision query needs its active checked source Require.');
  }
  return withinInstalledSourceReadLease(observation, input, true, async (checkpoint, _loadRow, ownerRows, control) => {
    if (control || ownerRows?.query === undefined) return fail('owner decision query lost its original owner domain.');
    return execute(checkpoint, ownerRows);
  });
}

async function withinInstalledSourceReadLease<Result>(observation: Readonly<ViewerGenerationCallbackReadObservation>,
  input: { readonly store: StoragePort; readonly model: ModelName; readonly id?: RecordId }, collection: boolean,
  execute: (checkpoint: () => Promise<void>,
    loadRow: (model: ModelName, id: RecordId) => Promise<StoredRow | null>,
    ownerRows: InstalledSourceOwnerRows | undefined, control: boolean) => Promise<Result>): Promise<Result> {
  const lifetime = observationLifetime(observation); let navigation: ReadNavigation | undefined;
  try {
    object(input, collection ? ['store', 'model'] : ['store', 'model', 'id']);
    const model = text(input.model), id = collection ? '' : text(input.id);
    // A data query may enter that model's original policy, whose decision
    // inspects the same model without recursively projecting its own policy.
    // Distinguish only the actual installed control lifetime, never an option.
    const key = collection ? `${lifetime?.stage === 'read-policy' ? 'control-query' : 'query'}\0${model}` : `record\0${model}\0${id}`;
    if (model.includes('\0') || id.includes('\0') || typeof execute !== 'function' ||
        lifetime === undefined || lifetime.observation !== observation || lifetime.store !== input.store ||
        lifetime.pending || lifetime.navigation !== null) return fail('exact live nonconcurrent owning read required for navigation.');
    healthyLifetime(lifetime);
    if (lifetime.navigationTargets.has(key) || lifetime.navigationTargets.size >= 100) {
      return fail('navigation repeats an active target or exceeds its containment depth.');
    }
    navigation = { key, child: null };
    lifetime.navigationTargets.add(key); lifetime.navigation = navigation; lifetime.pending = true;
    const lease = navigation;
    const healthy = () => {
      healthyLifetime(lifetime);
      if (!lifetime.pending || lifetime.navigation !== lease || !lifetime.navigationTargets.has(key)) {
        return fail('navigation crossed its original active lease.');
      }
    };
    const checkpoint = async () => {
      try {
        healthy(); const revision = await lifetime.store.readRevision(); healthy();
        if (revision !== observation.revision) throw new FenceConflictError(observation.revision, revision);
      } catch (error) { poison(lifetime); throw error; }
    };
    // The owning reader captures metadata synchronously, then performs its
    // first checkpoint before any cohort or source read can yield.
    healthy();
    let loading = false;
    const loadRow = async (model: ModelName, id: RecordId) => {
      let acquired = false;
      try {
        healthy();
        if (loading) return fail('concurrent navigation row load refused.');
        loading = true; acquired = true;
        await checkpoint();
        const row = lifetime.ownerRows === undefined
          ? await lifetime.store.cohortLoad({ model, id, expectedRevision: observation.revision })
          : await lifetime.ownerRows.read(model, id);
        healthy(); await checkpoint();
        return row;
      } catch (error) { poison(lifetime); throw error; }
      finally { if (acquired) loading = false; }
    };
    const result = await execute(checkpoint, loadRow, lifetime.ownerRows, lifetime.stage === 'read-policy');
    if (loading) return fail('navigation cannot return with an unfinished row load.');
    if (lease.child !== null) return fail('navigation cannot return with an unfinished child source read.');
    await checkpoint();
    return result;
  } catch (error) { poison(lifetime); throw error; }
  finally {
    if (navigation !== undefined) {
      lifetime!.navigationTargets.delete(navigation.key);
      lifetime!.navigation = null; lifetime!.pending = false;
    }
  }
}

/** Checked native identity for a source WHERE, including pure/role-only expressions.
 * Metadata is supplied by the verified loader, never by a read request. */
export interface InstalledSourceQueryPredicateProducer {
  readonly source: ScenarioReceiptSourceOrigin;
  readonly rule: string;
}

/** Bind the original function once before first use. This marker creates no
 * grants, membership handles or observations; State owns evaluation below. */
export function bindInstalledSourceQueryPredicate(read: InstalledSourceQueryPredicate,
  producer: InstalledSourceQueryPredicateProducer): void {
  if (typeof read !== 'function' || invoked.has(read) || installedPredicates.has(read)) {
    return fail('owning installed query predicate must bind once before execution.');
  }
  object(producer, ['source', 'rule']);
  const raw = object(producer.source, ['path', 'sha256', 'module']);
  const source = Object.freeze({ path: text(raw.path), sha256: text(raw.sha256), module: text(raw.module) });
  const rule = text(producer.rule);
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || [source.path, source.module, rule].some(value => /[\u0000-\u001f\u007f]/.test(value))) {
    return fail('exact bounded original source/rule identity required.');
  }
  try { [source.path, source.module, rule].forEach(value => encodeURIComponent(value)); }
  catch { return fail('valid original source/rule identity required.'); }
  if ((bindings.get(read) ?? []).some(bound => bound.stage !== 'read-predicate' ||
      bound.rule !== rule || stableStringify(bound.source) !== stableStringify(source))) {
    return fail('query marker must match its exact original read-predicate bindings.');
  }
  installedPredicates.set(read, Object.freeze({ source, rule }));
}

/** Bind once per exact rule before any read. Shape checking alone does not
 * attest emitted JavaScript; the same verified native loader supplies these
 * ports and the installed ordinary/callback read predicate. */
export function bindReadPolicyMembershipProducer(read: InstalledRead,
  producer: ReadPolicyMembershipProducer): readonly ReadPolicyMembershipHandle[] {
  if (typeof read !== 'function' || invoked.has(read)) return fail('owning installed predicate must bind before execution.');
  object(producer, ['source', 'rule', 'sites', 'team', 'capture']);
  if (typeof producer.team !== 'function' || typeof producer.capture !== 'function') return fail('literal native Team and capture ports required.');
  const rawSource = object(producer.source, ['path', 'sha256', 'module']);
  const source = Object.freeze({ path: text(rawSource.path), sha256: text(rawSource.sha256), module: text(rawSource.module) });
  const rule = text(producer.rule), sites = checkScenarioReceiptMembershipSites(producer.sites), stage = sites[0]?.stage;
  if (stage !== 'read-policy' && stage !== 'read-predicate') return fail('an exact current-read stage is required.');
  if (sites.some(site => site.stage !== stage || site.owner !== rule ||
      stableStringify(site.source) !== stableStringify(source))) return fail('exact original read-policy rule/source required.');
  const marker = installedPredicates.get(read as InstalledSourceQueryPredicate);
  if (marker !== undefined && (stage !== 'read-predicate' || marker.rule !== rule ||
      stableStringify(marker.source) !== stableStringify(source))) {
    return fail('membership binding must match its exact original query marker.');
  }
  const previous = bindings.get(read) ?? [];
  const occurrences = sites.map(site => stableStringify({ source: site.source, owner: site.owner, node: site.node }));
  const callCount = sites.reduce((count, site) => count + site.calls.length, 0);
  if (previous.length >= 200 || new Set(occurrences).size !== occurrences.length ||
      previous.some(bound => bound.rule === rule ||
      bound.occurrences.some(occurrence => occurrences.includes(occurrence)))) return fail('one bounded binding per exact rule/occurrence required.');
  const bound: BoundRead = Object.freeze({ read, stage, source, rule, team: producer.team, capture: producer.capture,
    occurrences: Object.freeze(occurrences), callCount });
  const result: ReadPolicyMembershipHandle[] = [];
  for (const site of sites) site.calls.forEach((call, callIndex) => {
    if (call.target.kind !== 'builtin' || call.target.id !== 'active_member') return;
    const handle = Object.freeze({}); handles.set(handle, { bound, site, callIndex }); result.push(handle);
  });
  if (result.length === 0 || previous.reduce((count, entry) => count + entry.callCount, callCount) > 200) {
    return fail('bounded complete original active_member inventory required.');
  }
  bindings.set(read, Object.freeze([...previous, bound]));
  return Object.freeze(result);
}

/** Internal State reader join, intentionally absent from package barrels.
 * Each coherent snapshot replay gets a fresh lifetime and native pair capture.
 * No public open/registration API can issue a read observation. */
export async function evaluateInstalledReadPolicy(read: InstalledSourceReadPredicate,
  input: Readonly<ViewerGenerationCallbackReadObservation>, store: StoragePort,
  owningObservation?: Readonly<ViewerGenerationCallbackReadObservation>,
  ownerRows?: InstalledSourceOwnerRows): Promise<boolean> {
  return evaluateInstalledRead(read, 'read-policy', input, store, observation => read(observation), owningObservation, ownerRows);
}

/** Internal viewer query join. The original projected record remains the
 * first argument; only State supplies the live predicate's second argument. */
export async function evaluateInstalledReadPredicate(read: InstalledSourceQueryPredicate,
  record: Readonly<ProjectedRecord>, input: Readonly<ViewerGenerationCallbackReadObservation>,
  store: StoragePort, ownerRows?: InstalledSourceOwnerRows): Promise<boolean> {
  return evaluateInstalledRead(read, 'read-predicate', input, store, observation => read(record, observation), undefined, ownerRows);
}

/** Internal query selection only. Unchanged predicates retain their existing
 * once-only execution after grant discovery; a checked source predicate
 * joins discovery and coherent replay of its actual candidate domain. */
export function hasInstalledReadPredicateMembership(read: InstalledSourceQueryPredicate): boolean {
  return bindings.get(read)?.some(bound => bound.stage === 'read-predicate') === true;
}

/** Internal detection preserves the generic ABI for unmarked functions. */
export function hasInstalledSourceQueryPredicate(read: InstalledSourceQueryPredicate): boolean {
  return installedPredicates.has(read) || hasInstalledReadPredicateMembership(read);
}

/** Internal accepted unbound route: record the actual function's first use
 * without issuing membership authority or repeating its execution. */
export function executeUnboundReadPredicate(read: InstalledSourceQueryPredicate,
  record: Readonly<ProjectedRecord>): boolean | Promise<boolean> {
  invoked.add(read);
  return read(record);
}

function checkOwningRead(
  input: Readonly<ViewerGenerationCallbackReadObservation>,
  owningObservation: Readonly<ViewerGenerationCallbackReadObservation>,
  parent: ReadLifetime | undefined,
  store: StoragePort,
  capturedOwnerRows: InstalledSourceOwnerRows | undefined,
): ReadNavigation {
  if (parent === undefined || parent.observation !== owningObservation || parent.store !== store ||
      !parent.pending || parent.navigation === null || parent.navigation.child !== null) {
    return fail('child source read requires its exact live owning navigation.');
  }
  healthyLifetime(parent);
  if (capturedOwnerRows !== undefined && (parent.ownerRows === undefined ||
      capturedOwnerRows.read !== parent.ownerRows.read || capturedOwnerRows.assertHealthy !== parent.ownerRows.assertHealthy ||
      capturedOwnerRows.query !== parent.ownerRows.query || capturedOwnerRows.policyQuery !== parent.ownerRows.policyQuery)) {
    return fail('child source read cannot replace its owning row closure.');
  }
  if (input.revision !== parent.observation.revision || input.fence !== parent.observation.fence ||
      input.context.actorUserId !== parent.observation.context.actorUserId ||
      input.context.teamId !== parent.observation.context.teamId ||
      input.context.membership !== parent.observation.context.membership ||
      input.context.memberships !== parent.observation.context.memberships) {
    return fail('child source read requires the unchanged tracked owning context.');
  }
  return parent.navigation;
}

function openInstalledLifetime(
  read: InstalledRead,
  stage: ReadStage,
  input: Readonly<ViewerGenerationCallbackReadObservation>,
  store: StoragePort,
  parent: ReadLifetime | null,
  parentNavigation: ReadNavigation | null,
  capturedOwnerRows: InstalledSourceOwnerRows | undefined,
): ReadLifetime {
  const observation = Object.freeze({ ...input, context: Object.freeze({ ...input.context }) });
  const lifetime: ReadLifetime = { read, stage, observation, store, ownerRows: parent?.ownerRows ?? capturedOwnerRows,
    bound: bindings.get(read) ?? [], parent, parentNavigation,
    navigationTargets: parent?.navigationTargets ?? new Set(),
    navigation: null, pending: false, poisoned: false, closed: false, count: 0 };
  lifetimes.set(observation, lifetime); contexts.set(observation.context, lifetime);
  if (parentNavigation !== null) parentNavigation.child = lifetime;
  return lifetime;
}

async function evaluateInstalledRead(read: InstalledRead, stage: ReadStage,
  input: Readonly<ViewerGenerationCallbackReadObservation>, store: StoragePort,
  execute: (observation: Readonly<ViewerGenerationCallbackReadObservation>) => boolean | Promise<boolean>,
  owningObservation?: Readonly<ViewerGenerationCallbackReadObservation>,
  ownerRows?: InstalledSourceOwnerRows): Promise<boolean> {
  const parent = owningObservation === undefined ? undefined : observationLifetime(owningObservation);
  let lifetime: ReadLifetime | undefined, parentNavigation: ReadNavigation | null = null;
  try {
    const capturedOwnerRows = ownerRows === undefined ? undefined : captureInstalledSourceOwnerRows(ownerRows);
    if (owningObservation !== undefined) {
      parentNavigation = checkOwningRead(input, owningObservation, parent, store, capturedOwnerRows);
    }
    invoked.add(read);
    if (stage === 'read-policy' && installedPredicates.has(read as InstalledSourceQueryPredicate)) {
      return fail('installed query predicate cannot execute as a read policy.');
    }
    lifetime = openInstalledLifetime(read, stage, input, store, parent ?? null, parentNavigation, capturedOwnerRows);
    healthyLifetime(lifetime);
    const value = await execute(lifetime.observation);
    healthyLifetime(lifetime);
    if (lifetime.pending || lifetime.poisoned || typeof value !== 'boolean') return fail('caught, pending or malformed source read cannot authorize.');
    return value;
  } catch (error) { poison(lifetime ?? parent); throw error; }
  finally {
    if (lifetime !== undefined) {
      lifetime.closed = true;
      if (parentNavigation !== null && parentNavigation.child === lifetime) parentNavigation.child = null;
    }
  }
}

/** Only a State-issued live coherent observation and its exact checked handle
 * can evaluate membership. Current facts join the owning reader's complete
 * Identity observation/revalidation, never the scenario or dispatch ledger. */
type IssuedRead = NonNullable<ReturnType<typeof handles.get>>;

function acquireReadOccurrence(
  observation: Readonly<ViewerGenerationCallbackReadObservation>,
  input: { readonly site: ReadPolicyMembershipHandle },
  lifetime: ReadLifetime | undefined,
): { readonly lifetime: ReadLifetime; readonly issued: IssuedRead } {
  object(input, ['site']); const issued = handles.get(input.site);
  if (lifetime === undefined || lifetime.observation !== observation || lifetime.closed || lifetime.poisoned ||
      lifetime.pending || issued === undefined || issued.bound.read !== lifetime.read ||
      issued.bound.stage !== lifetime.stage || !lifetime.bound.includes(issued.bound) ||
      lifetime.count >= 200) return fail('exact live nonconcurrent source read/occurrence required.');
  healthyLifetime(lifetime);
  lifetime.pending = true; lifetime.count++;
  return { lifetime, issued };
}

function verifyReadCapture(
  values: unknown,
  team: unknown,
): { readonly teamId: string; readonly personId: string } {
  object(values, ['person', 'team']);
  const person = object((values as Record<string, unknown>).person, ['kind', 'id']);
  if (!isUserRef((values as Record<string, unknown>).person) || !Object.isFrozen((values as Record<string, unknown>).person) ||
      person.kind !== 'user' || (values as Record<string, unknown>).team !== team) {
    return fail('actual owning Values user and exact verified Team pointer required.');
  }
  return { teamId: text((team as { teamId: unknown }).teamId), personId: text(person.id) };
}

export async function evaluateReadPolicyMembership(observation: Readonly<ViewerGenerationCallbackReadObservation>,
  input: { readonly site: ReadPolicyMembershipHandle }): Promise<boolean> {
  const lifetime = observationLifetime(observation);
  let acquired = false;
  try {
    const acquiredRead = acquireReadOccurrence(observation, input, lifetime);
    acquired = true;
    const { issued } = acquiredRead;
    const current = acquiredRead.lifetime;
    const team = issued.bound.team(observation);
    if (team === null) return fail('actual corresponding native Team required.');
    const snapshot = teamSnapshot(team);
    if (team.teamId !== observation.context.teamId) return fail('actual corresponding native Team required.');
    const values = issued.bound.capture(observation, issued.site, issued.callIndex);
    const { teamId, personId } = verifyReadCapture(values, team);
    const healthy = () => {
      healthyLifetime(current);
      if (current.closed || current.poisoned || !current.pending || lifetimes.get(observation) !== current ||
          issued.bound.team(observation) !== team || teamSnapshot(team) !== snapshot ||
          observation.context.teamId !== teamId || observation.fence !== undefined &&
          observation.fence.revision !== observation.revision) return fail('membership crossed its original read/Team/checkpoint.');
    };
    const checkpoint = async () => {
      healthy(); const revision = await current.store.readRevision(); healthy();
      if (revision !== observation.revision) throw new FenceConflictError(observation.revision, revision);
    };
    healthy(); await checkpoint(); healthy();
    const fact = checkedMembershipFact(await observation.context.memberships.findMembership(teamId, personId), teamId, personId);
    healthy(); await checkpoint(); healthy();
    observation.fence?.enroll({ kind: 'membership', teamId, userId: personId });
    return fact?.status === 'active';
  } catch (error) { poison(lifetime); throw error; }
  finally { if (acquired) lifetime!.pending = false; }
}
