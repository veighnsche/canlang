/** Membership at the actual deferred guard, independent of a closed business
 * call. Literal ports are installed by the verified native loader. Neither
 * recipe shape nor a public Team/id object grants dispatch authority. */
import type { ResolvedIdentity, ScenarioReceiptSourceOrigin, StoragePort, Team } from '@canlang/contracts';
import { isUserRef, type UserRef } from '@canlang/values';
import { StateError } from '../errors.js';
import type { MembershipReader } from '../policy/roles.js';
import type { GeneratedOperationDef } from './registry.js';
import { assertScenarioReceiptDispatchMembershipSource, readScenarioCurrentMembership } from './scenario-receipt.js';
import { checkScenarioReceiptMembershipSites, type ScenarioReceiptMembershipSite } from './scenario-membership-plan.js';
import { stableStringify } from './replay.js';

export type ScenarioDispatchMembershipHandle = Readonly<object>;
/** Structural Work port avoids a State -> Work dependency cycle. The native
 * loader supplies Work's literal private read/register functions. */
export interface ScenarioDispatchMembershipPorts<E extends object> {
  readonly source: ScenarioReceiptSourceOrigin;
  readonly app: string;
  readonly predicate: string;
  readonly sites: readonly ScenarioReceiptMembershipSite[];
  readonly store: StoragePort;
  readonly memberships: MembershipReader;
  readonly readExecution: (execution: E) => {
    readonly predicate: string;
    readonly checkpoint: { readonly revision: number; readonly owner: string } | undefined;
  };
  readonly registerRevalidation: (execution: E, revalidate: () => boolean | Promise<boolean>) => void;
  /** Fresh source-owner Identity from this dispatch's fence before claim. An actor-null
   * service owner is sufficient for this membership tuple, never evidence of
   * an authenticated retained business caller. */
  readonly admit: (execution: E) => ResolvedIdentity | Promise<ResolvedIdentity>;
  /** Consume this runtime evaluation's privately staged arguments once,
   * synchronously before any reader can yield. */
  readonly capture: (execution: E, site: ScenarioReceiptMembershipSite, callIndex: number) => {
    readonly person: UserRef; readonly team: Team;
  };
}
export interface ScenarioDispatchMembershipExecution {
  evaluate(input: { readonly site: ScenarioDispatchMembershipHandle }): Promise<boolean>;
}
export interface ScenarioDispatchMembershipProducer<E extends object> {
  readonly sites: readonly ScenarioDispatchMembershipHandle[];
  /** Open once at guard entry, before executing authored native code. All
   * subsequent evaluations retain this exact private Work execution. */
  open(execution: E): ScenarioDispatchMembershipExecution;
}
interface Observation { readonly person: string; readonly observed: boolean }
interface Ledger {
  readonly owner: object;
  pending: boolean;
  poisoned: boolean;
  closed: boolean;
  identity: ResolvedIdentity | null;
  team: Team | null;
  teamSnapshot: string | null;
  readonly observations: Observation[];
}
interface Bindings { readonly predicates: Set<string>; readonly occurrences: Set<string> }
const boundDefinitions = new WeakMap<GeneratedOperationDef, Bindings>();
const executions = new WeakMap<object, Ledger>();
const fail = (message: string): never => { throw new StateError('validation', `Dispatch membership: ${message}`); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => { const entry = Object.getOwnPropertyDescriptor(value, key);
        return entry === undefined || !('value' in entry) || !entry.enumerable; })) fail('closed own data required.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : fail('bounded identity required.');
}
function teamSnapshot(team: Team): string {
  const value = object(team, ['team_id', 'timezone', 'created_at']);
  return stableStringify({ team_id: text(value.team_id), timezone: text(value.timezone), created_at: text(value.created_at) });
}

/** Bind each predicate once before owning execution through the existing source/callable
 * loader. The frozen Compiler v1 transport cannot activate source gates. */
export function bindScenarioDispatchMembershipProducer<E extends object>(def: GeneratedOperationDef,
  ports: ScenarioDispatchMembershipPorts<E>): ScenarioDispatchMembershipProducer<E> {
  object(ports, ['source', 'app', 'predicate', 'sites', 'store', 'memberships', 'readExecution', 'registerRevalidation', 'admit', 'capture']);
  const source = object(ports.source, ['path', 'sha256', 'module']);
  const ownedSource = Object.freeze({ path: text(source.path), sha256: text(source.sha256), module: text(source.module) });
  assertScenarioReceiptDispatchMembershipSource(def, ownedSource);
  text(ports.app); const predicate = text(ports.predicate);
  const bindings = boundDefinitions.get(def) ?? { predicates: new Set<string>(), occurrences: new Set<string>() };
  if (bindings.predicates.has(predicate) || bindings.predicates.size >= 200) return fail('one bounded owning binding per dispatch predicate required.');
  if ([ports.readExecution, ports.registerRevalidation, ports.admit, ports.capture, ports.store?.readRevision,
    ports.memberships?.findMembership].some(value => typeof value !== 'function')) return fail('literal execution/admission/reader ports required.');
  const plans = checkScenarioReceiptMembershipSites(ports.sites);
  if (plans.some(site => site.owner !== def.name || stableStringify(site.source) !== stableStringify(ownedSource) ||
      site.stage !== 'send-dispatch')) return fail('exact owning send-dispatch source required.');
  // A guard's byte interval in its exact owner/source is its occurrence.
  // Changing predicate aliases, call metadata or authored position cannot
  // grant the same physical SEND guard to a second binding.
  const occurrences = plans.map(site => stableStringify({ source: site.source, owner: site.owner, node: site.node }));
  if (new Set(occurrences).size !== occurrences.length || occurrences.some(site => bindings.occurrences.has(site))) {
    return fail('dispatch source occurrence already bound.');
  }
  const issued = new WeakMap<ScenarioDispatchMembershipHandle, { site: ScenarioReceiptMembershipSite; callIndex: number }>();
  const sites: ScenarioDispatchMembershipHandle[] = [];
  for (const site of plans) site.calls.forEach((call, callIndex) => {
    if (call.target.kind !== 'builtin' || call.target.id !== 'active_member') return;
    const handle = Object.freeze({}); issued.set(handle, { site, callIndex }); sites.push(handle);
  });
  if (sites.length === 0) return fail('checked active_member occurrence required.');
  // Retain literal ports; mutating the caller's binding object cannot replace them.
  const { store, memberships, readExecution, registerRevalidation, admit, capture } = ports;
  const owner = Object.freeze({});
  bindings.predicates.add(predicate);
  for (const occurrence of occurrences) bindings.occurrences.add(occurrence);
  boundDefinitions.set(def, bindings);
  return Object.freeze({ sites: Object.freeze(sites), open(execution: E): ScenarioDispatchMembershipExecution {
    // Work authenticates this handle. A copy cannot identify any live execution.
    const context = readExecution(execution);
    const existing = executions.get(execution);
    if (existing !== undefined) { existing.poisoned = true; return fail('dispatch observer already opened.'); }
    const ledger: Ledger = { owner, pending: false, poisoned: false, closed: false,
      identity: null, team: null, teamSnapshot: null, observations: [] };
    executions.set(execution, ledger);
    let revision = -1, teamId = '';
    const healthyTeam = () => {
      if (ledger.poisoned || ledger.pending || ledger.identity?.team !== ledger.team || ledger.team === null ||
          ledger.team.team_id !== teamId || teamSnapshot(ledger.team) !== ledger.teamSnapshot) return fail('private admitted Team changed or execution is poisoned.');
    };
    const checkpoint = async () => {
      if (await store.readRevision() !== revision) throw new StateError('conflict', 'Dispatch membership checkpoint moved.');
    };
    // Register before validating any authored/site/native input: caught misuse
    // cannot omit the private refusal when Work later records skip or claim.
    registerRevalidation(execution, async () => {
      ledger.closed = true;
      if (ledger.poisoned || ledger.pending) return false;
      if (ledger.observations.length === 0) return true;
      try {
        healthyTeam(); await checkpoint();
        for (const observation of ledger.observations) {
          const current = await readScenarioCurrentMembership(memberships, teamId, observation.person);
          healthyTeam(); await checkpoint();
          if (current !== observation.observed) return false;
        }
        healthyTeam(); return true;
      } catch (error) { ledger.poisoned = true; throw error; }
    });
    try {
      const fence = context.checkpoint;
      if (context.predicate !== predicate || fence === undefined || !Number.isSafeInteger(fence.revision) || fence.revision < 0) return fail('actual predicate and fresh owner checkpoint required.');
      revision = fence.revision; teamId = text(fence.owner);
    } catch (error) { ledger.poisoned = true; throw error; }
    return Object.freeze({ async evaluate(input: { readonly site: ScenarioDispatchMembershipHandle }): Promise<boolean> {
      let acquired = false;
      try {
        const live = readExecution(execution);
        if (ledger.owner !== owner || ledger.closed || ledger.poisoned || ledger.pending || live !== context ||
            live.predicate !== predicate || live.checkpoint?.revision !== revision || live.checkpoint.owner !== teamId ||
            ledger.observations.length >= 200) return fail('membership requires its exact live nonconcurrent guard.');
        object(input, ['site']); const occurrence = issued.get(input.site);
        if (occurrence === undefined) return fail('copied or foreign source occurrence.');
        ledger.pending = true; acquired = true;
        const values = capture(execution, occurrence.site, occurrence.callIndex);
        object(values, ['person', 'team']); const person = object(values.person, ['kind', 'id']);
        if (!isUserRef(values.person) || person.kind !== 'user' || !Object.isFrozen(values.person)) return fail('actual owning Values user required.');
        const personId = text(person.id);
        const capturedTeam = values.team;
        if (ledger.identity === null) {
          const identity = await admit(execution);
          object(identity, ['actor', 'team', 'membership', 'binding', 'admitted_at']);
          if (identity.team === null) return fail('current private source-owner Identity/Team required.');
          ledger.identity = identity; ledger.team = identity.team; ledger.teamSnapshot = teamSnapshot(identity.team);
        }
        const healthy = () => {
          if (readExecution(execution) !== context || ledger.closed || ledger.poisoned || !ledger.pending ||
              ledger.identity?.team !== ledger.team || ledger.team === null || capturedTeam !== ledger.team ||
              ledger.team.team_id !== teamId || teamSnapshot(ledger.team) !== ledger.teamSnapshot) return fail('membership crossed its actual native Team/guard lifetime.');
        };
        healthy(); await checkpoint(); healthy();
        const observed = await readScenarioCurrentMembership(memberships, teamId, personId);
        healthy(); await checkpoint(); healthy();
        ledger.observations.push(Object.freeze({ person: personId, observed }));
        return observed;
      } catch (error) { ledger.poisoned = true; throw error; }
      finally { if (acquired) ledger.pending = false; }
    } });
  } });
}
