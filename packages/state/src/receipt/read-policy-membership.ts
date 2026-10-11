/** Membership at a genuine installed source read, never a business owner call.
 * The checked native loader binds literal source/argument/Team ports. Only the
 * owning State reader opens the coherent observation lifetime below. */
import type { ScenarioReceiptSourceOrigin, StoragePort, TeamScope } from '@canlang/contracts';
import { isUserRef, type UserRef } from '@canlang/values';
import { StateError } from '../errors.js';
import { checkScenarioReceiptMembershipSites, type ScenarioReceiptMembershipSite } from '../invocation/scenario-membership-plan.js';
import { stableStringify } from '../invocation/replay.js';
import { checkedMembershipFact } from '../policy/membership-facts.js';
import { FenceConflictError } from '../storage/port.js';
import type { ViewerGenerationCallbackReadObservation } from './callback-diagnostics.js';

export type ReadPolicyMembershipHandle = Readonly<object>;
export type InstalledSourceReadPredicate = (observation: Readonly<ViewerGenerationCallbackReadObservation>) => Promise<boolean>;
export interface ReadPolicyMembershipProducer {
  readonly source: ScenarioReceiptSourceOrigin;
  /** Exact emitted read/callbackRead rule identity, not an application alias. */
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
  readonly read: InstalledSourceReadPredicate;
  readonly source: ScenarioReceiptSourceOrigin;
  readonly rule: string;
  readonly team: ReadPolicyMembershipProducer['team'];
  readonly capture: ReadPolicyMembershipProducer['capture'];
  readonly occurrences: readonly string[];
  readonly callCount: number;
}
interface ReadLifetime {
  readonly read: InstalledSourceReadPredicate;
  readonly observation: Readonly<ViewerGenerationCallbackReadObservation>;
  readonly store: StoragePort;
  readonly bound: readonly BoundRead[];
  pending: boolean;
  poisoned: boolean;
  closed: boolean;
  count: number;
}
const bindings = new WeakMap<InstalledSourceReadPredicate, readonly BoundRead[]>();
const invoked = new WeakSet<InstalledSourceReadPredicate>();
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

/** Bind once per exact rule before any read. Shape checking alone does not
 * attest emitted JavaScript; the same verified native loader supplies these
 * ports and the installed ordinary/callback read predicate. */
export function bindReadPolicyMembershipProducer(read: InstalledSourceReadPredicate,
  producer: ReadPolicyMembershipProducer): readonly ReadPolicyMembershipHandle[] {
  if (typeof read !== 'function' || invoked.has(read)) return fail('owning installed predicate must bind before execution.');
  object(producer, ['source', 'rule', 'sites', 'team', 'capture']);
  if (typeof producer.team !== 'function' || typeof producer.capture !== 'function') return fail('literal native Team and capture ports required.');
  const rawSource = object(producer.source, ['path', 'sha256', 'module']);
  const source = Object.freeze({ path: text(rawSource.path), sha256: text(rawSource.sha256), module: text(rawSource.module) });
  const rule = text(producer.rule), sites = checkScenarioReceiptMembershipSites(producer.sites);
  if (sites.some(site => site.stage !== 'read-policy' || site.owner !== rule ||
      stableStringify(site.source) !== stableStringify(source))) return fail('exact original read-policy rule/source required.');
  const previous = bindings.get(read) ?? [];
  const occurrences = sites.map(site => stableStringify({ source: site.source, owner: site.owner, node: site.node }));
  const callCount = sites.reduce((count, site) => count + site.calls.length, 0);
  if (previous.length >= 200 || new Set(occurrences).size !== occurrences.length ||
      previous.some(bound => bound.rule === rule ||
      bound.occurrences.some(occurrence => occurrences.includes(occurrence)))) return fail('one bounded binding per exact rule/occurrence required.');
  const bound: BoundRead = Object.freeze({ read, source, rule, team: producer.team, capture: producer.capture,
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
  input: Readonly<ViewerGenerationCallbackReadObservation>, store: StoragePort): Promise<boolean> {
  invoked.add(read);
  const observation = Object.freeze({ ...input, context: Object.freeze({ ...input.context }) });
  const lifetime: ReadLifetime = { read, observation, store, bound: bindings.get(read) ?? [],
    pending: false, poisoned: false, closed: false, count: 0 };
  lifetimes.set(observation, lifetime); contexts.set(observation.context, lifetime);
  try {
    const value = await read(observation);
    if (lifetime.pending || lifetime.poisoned || typeof value !== 'boolean') return fail('caught, pending or malformed source read cannot authorize.');
    return value;
  } catch (error) { lifetime.poisoned = true; throw error; }
  finally { lifetime.closed = true; }
}

/** Only a State-issued live coherent observation and its exact checked handle
 * can evaluate membership. Current facts join the owning reader's complete
 * Identity observation/revalidation, never the scenario or dispatch ledger. */
export async function evaluateReadPolicyMembership(observation: Readonly<ViewerGenerationCallbackReadObservation>,
  input: { readonly site: ReadPolicyMembershipHandle }): Promise<boolean> {
  let lifetime = typeof observation === 'object' && observation !== null ? lifetimes.get(observation) : undefined;
  let acquired = false;
  try {
    // A shallow copy still identifies the original context for poisoning, but
    // never gains its observation authority.
    if (lifetime === undefined && typeof observation === 'object' && observation !== null) {
      const context = Object.getOwnPropertyDescriptor(observation, 'context');
      if (context !== undefined && 'value' in context && typeof context.value === 'object' && context.value !== null) {
        lifetime = contexts.get(context.value);
      }
    }
    object(input, ['site']); const issued = handles.get(input.site);
    if (lifetime === undefined || lifetime.observation !== observation || lifetime.closed || lifetime.poisoned ||
        lifetime.pending || issued === undefined || issued.bound.read !== lifetime.read ||
        !lifetime.bound.includes(issued.bound) || lifetime.count >= 200) return fail('exact live nonconcurrent source read/occurrence required.');
    lifetime.pending = true; acquired = true; lifetime.count++;
    const team = issued.bound.team(observation);
    if (team === null) return fail('actual corresponding native Team required.');
    const snapshot = teamSnapshot(team);
    if (team.teamId !== observation.context.teamId) return fail('actual corresponding native Team required.');
    const values = issued.bound.capture(observation, issued.site, issued.callIndex);
    object(values, ['person', 'team']); const person = object(values.person, ['kind', 'id']);
    if (!isUserRef(values.person) || !Object.isFrozen(values.person) || person.kind !== 'user' || values.team !== team) {
      return fail('actual owning Values user and exact verified Team pointer required.');
    }
    const teamId = text(team.teamId), personId = text(person.id), current = lifetime;
    const healthy = () => {
      if (current.closed || current.poisoned || !current.pending || lifetimes.get(observation) !== current ||
          issued.bound.team(observation) !== team || teamSnapshot(team) !== snapshot ||
          observation.context.teamId !== teamId || observation.fence !== undefined &&
          observation.fence.revision !== observation.revision) return fail('membership crossed its original read/Team/checkpoint.');
    };
    const checkpoint = async () => {
      const revision = await current.store.readRevision(); healthy();
      if (revision !== observation.revision) throw new FenceConflictError(observation.revision, revision);
    };
    healthy(); await checkpoint(); healthy();
    const fact = checkedMembershipFact(await observation.context.memberships.findMembership(teamId, personId), teamId, personId);
    healthy(); await checkpoint(); healthy();
    observation.fence?.enroll({ kind: 'membership', teamId, userId: personId });
    return fact?.status === 'active';
  } catch (error) { if (lifetime !== undefined) lifetime.poisoned = true; throw error; }
  finally { if (acquired) lifetime!.pending = false; }
}
