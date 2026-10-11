/** Checked native source join. Public markers describe an occurrence; only the
 * actual State call/read and privately captured native arguments authorize it. */
import type { ScenarioReceiptSourceOrigin, StoragePort, TeamScope } from '@canlang/contracts';
import { bindScenarioReceiptMembershipProducer, evaluateScenarioReceiptMembership,
  bindReadPolicyMembershipProducer, evaluateReadPolicyMembership,
  type ScenarioReceiptMembershipSite, type ScenarioReceiptMembershipHandle,
  type ReadPolicyMembershipHandle, type InstalledSourceReadPredicate,
  type InstalledSourceQueryPredicate } from '@canlang/state';
import { assertScenarioReceiptCallExecution, stableStringify, type AdmittedCall } from '@canlang/state/invocation';
import type { GeneratedOperationDef } from '@canlang/state/invocation/registry';
import { StateError } from '@canlang/state/errors';
import { hasRole as stateSubjectRole } from '@canlang/state/policy/roles';
import { isUserRef, type UserRef } from '@canlang/values';
import type { HandlerContext } from './context.js';

type Read = InstalledSourceReadPredicate | InstalledSourceQueryPredicate;
type Observation = Parameters<typeof evaluateReadPolicyMembership>[0];
type Handle = ScenarioReceiptMembershipHandle | ReadPolicyMembershipHandle;
export interface NativeMembershipMarker {
  readonly source: ScenarioReceiptSourceOrigin;
  readonly node: { readonly start: number; readonly end: number };
}
interface Occurrence {
  readonly site: string;
  readonly callIndex: number;
  readonly marker: string;
  readonly handle: Handle;
}
interface Binding {
  /** Retain the complete original inventory, including outer positions and
   * all derive/default/slot recipes, rather than a source/node directory. */
  readonly sites: readonly ScenarioReceiptMembershipSite[];
  readonly occurrences: readonly Occurrence[];
}
interface Frame {
  readonly binding: Binding;
  readonly nativeTeam: HandlerContext['team'];
  readonly team: TeamScope | null;
  readonly teamSnapshot: string;
  readonly failure: (error: unknown) => void;
  readonly call?: AdmittedCall;
  readonly store?: StoragePort;
  readonly observation?: Observation;
  active: boolean;
  pending: boolean;
  failed: boolean;
  error: unknown;
  captured: { readonly occurrence: Occurrence; readonly person: UserRef; readonly team: TeamScope } | null;
}
const owners = new WeakMap<GeneratedOperationDef, Binding>();
const reads = new WeakMap<Read, ReadonlyMap<string, Binding>>();
const frames = new WeakMap<HandlerContext, Frame>();
const calls = new WeakMap<AdmittedCall, Frame>();
const observations = new WeakMap<Observation, Frame>();
export function hasNativeOwnerMembership(def: GeneratedOperationDef): boolean { return owners.has(def); }
const refuse = (message: string): never => { throw new StateError('validation', `Native membership: ${message}`); };
function fail(frame: Frame, error: unknown): never {
  if (!frame.failed) {
    frame.failed = true; frame.error = error; frame.failure(error);
  }
  throw frame.error;
}
function checked(c: HandlerContext): Frame {
  const frame = frames.get(c);
  if (frame === undefined) return refuse('actual installed framework context required.');
  if (frame.failed) throw frame.error;
  try {
    if (!frame.active || c.team !== frame.nativeTeam || stableStringify(frame.team) !== frame.teamSnapshot) {
      return refuse('original live native Team/context required.');
    }
    if (frame.call !== undefined) assertScenarioReceiptCallExecution(frame.call, frame.store!);
    return frame;
  } catch (error) { return fail(frame, error); }
}
function ownObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => { const property = Object.getOwnPropertyDescriptor(value, key);
        return property === undefined || !('value' in property) || !property.enumerable; })) {
    return refuse('closed own-data source marker/user required.');
  }
  return value as Record<string, unknown>;
}
function markerKey(value: unknown): string {
  const marker = ownObject(value, ['source', 'node']);
  const source = ownObject(marker.source, ['path', 'sha256', 'module']);
  const node = ownObject(marker.node, ['start', 'end']);
  if (typeof source.path !== 'string' || source.path.length === 0 || source.path.length > 4096 ||
      typeof source.module !== 'string' || source.module.length === 0 || source.module.length > 4096 ||
      typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) ||
      (node.start as number) < 0 || (node.end as number) <= (node.start as number)) {
    return refuse('exact emitted physical source/node required.');
  }
  return stableStringify({ source, node });
}
function binding(sites: readonly ScenarioReceiptMembershipSite[], handles: readonly Handle[]): Binding {
  // State has synchronously checked every own-data recipe before this copy.
  const snapshot = JSON.parse(stableStringify(sites)) as ScenarioReceiptMembershipSite[];
  const occurrences: Occurrence[] = []; let handleIndex = 0;
  for (const site of snapshot) site.calls.forEach((call, callIndex) => {
    if (call.target.kind !== 'builtin' || call.target.id !== 'active_member') return;
    const handle = handles[handleIndex++];
    if (handle === undefined) return refuse('complete checked handle census required.');
    occurrences.push(Object.freeze({ site: stableStringify(site), callIndex,
      marker: markerKey({ source: call.source, node: call.node }), handle }));
  });
  if (handleIndex !== handles.length) return refuse('complete checked handle census required.');
  return Object.freeze({ sites: snapshot, occurrences: Object.freeze(occurrences) });
}
function capture(frame: Frame | undefined, site: ScenarioReceiptMembershipSite, callIndex: number) {
  if (frame === undefined) return refuse('capture requires its exact actual State owner/read.');
  try {
    const value = frame.captured;
    if (!frame.active || frame.failed || !frame.pending || value === null ||
        value.occurrence.site !== stableStringify(site) || value.occurrence.callIndex !== callIndex) {
      return refuse('once-only synchronized exact original argument capture required.');
    }
    frame.captured = null;
    return Object.freeze({ person: value.person, team: value.team });
  } catch (error) { return fail(frame, error); }
}

/** Trusted loader only, after exact emitted source/callable verification. */
export function bindNativeOwnerMembership(def: GeneratedOperationDef, input: {
  readonly source: ScenarioReceiptSourceOrigin; readonly app: string;
  readonly sites: readonly ScenarioReceiptMembershipSite[];
}): void {
  if (owners.has(def)) return refuse('owning definition cannot be rebound.');
  const handles = bindScenarioReceiptMembershipProducer(def, { ...input,
    capture: (call, site, index) => capture(calls.get(call), site, index) });
  owners.set(def, binding(input.sites, handles));
}

/** Trusted loader only; rule is the exact original policy/query owner key. */
export function bindNativeReadMembership(read: Read, input: {
  readonly source: ScenarioReceiptSourceOrigin; readonly rule: string;
  readonly sites: readonly ScenarioReceiptMembershipSite[];
}): void {
  const previous = reads.get(read) ?? new Map<string, Binding>();
  if (previous.has(input.rule)) return refuse('installed read rule cannot be rebound.');
  let installed: Binding;
  const handles = bindReadPolicyMembershipProducer(read, { ...input,
    team: observation => {
      const frame = observations.get(observation);
      return frame?.active && !frame.failed && frame.binding === installed ? frame.team : null;
    },
    capture: (observation, site, index) => {
      const frame = observations.get(observation);
      if (frame?.binding !== installed) return refuse('exact installed read/rule capture required.');
      return capture(frame, site, index);
    } });
  installed = binding(input.sites, handles);
  reads.set(read, new Map([...previous, [input.rule, installed]]));
}

/** Role-only checked read declarations need the same private source lifetime,
 * while no empty active_member inventory is registered with State. */
export function bindNativeReadRoleContext(read: Read, sourceRule: string): void {
  const previous = reads.get(read) ?? new Map<string, Binding>();
  if (typeof read !== 'function' || typeof sourceRule !== 'string' || sourceRule.length === 0 ||
      sourceRule.length > 4096 || previous.has(sourceRule)) return refuse('one exact installed source read/rule binding required.');
  reads.set(read, new Map([...previous, [sourceRule,
    Object.freeze({ sites: Object.freeze([]), occurrences: Object.freeze([]) })]]));
}

export interface NativeMembershipFrame {
  assertCompleted(): void;
  close(): void;
}
function open(c: HandlerContext, frame: Frame): NativeMembershipFrame {
  if (frames.has(c)) return refuse('native context cannot be rebound.');
  frames.set(c, frame);
  return Object.freeze({
    assertCompleted() {
      checked(c);
      if (frame.pending || frame.captured !== null) {
        return fail(frame, new StateError('validation', 'Native membership must complete before its owner/read returns.'));
      }
    },
    close() {
      frame.active = false;
      if (frame.pending || frame.captured !== null) {
        fail(frame, new StateError('validation', 'Native membership owner/read closed with pending work.'));
      }
    },
  });
}
/** Only actual execution supplies this State call and its original receipt store. */
export function openNativeOwnerMembershipFrame(c: HandlerContext, call: AdmittedCall,
  store: StoragePort, failure: (error: unknown) => void): NativeMembershipFrame {
  assertScenarioReceiptCallExecution(call, store);
  const installed = owners.get(call.def as GeneratedOperationDef);
  // Installation must preserve an unevaluated branch on a no-Team call.
  // The actual active_member execution still requires a verified live Team.
  if (installed === undefined || calls.has(call) ||
      (call.context.team === null ? c.team != null : c.team == null ||
        c.team.id !== call.context.team.teamId || c.team.timezone !== call.context.team.timezone)) {
    return refuse('actual bound owner call and corresponding native Team required.');
  }
  const frame: Frame = { binding: installed, nativeTeam: c.team, team: call.context.team,
    teamSnapshot: stableStringify(call.context.team), call, store, failure,
    active: true, pending: false, failed: false, error: undefined, captured: null };
  const lifecycle = open(c, frame); calls.set(call, frame); return lifecycle;
}

/** The installed read closure supplies its exact rule, State-issued observation,
 * and actual corresponding TeamScope. The marker/caller never selects them. */
export function openNativeReadMembershipFrame(c: HandlerContext, read: Read, observation: Observation,
  sourceRule: string, actualReadTeamScope: TeamScope | null, failure: (error: unknown) => void): NativeMembershipFrame {
  const installed = reads.get(read)?.get(sourceRule);
  const previous = observations.get(observation);
  // One State-installed aggregate may evaluate several original source rules
  // sequentially at this same coherent observation, each in a fresh native c.
  if (installed === undefined || previous !== undefined &&
      (previous.active || previous.failed || previous.pending || previous.captured !== null) ||
      (actualReadTeamScope === null ? c.team != null || observation.context.teamId !== null :
        c.team == null || actualReadTeamScope.teamId !== observation.context.teamId)) {
    return refuse('actual installed rule/read observation and corresponding native Team required.');
  }
  const frame: Frame = { binding: installed, nativeTeam: c.team, team: actualReadTeamScope,
    teamSnapshot: stableStringify(actualReadTeamScope), observation, failure,
    active: true, pending: false, failed: false, error: undefined, captured: null };
  const lifecycle = open(c, frame); observations.set(observation, frame); return lifecycle;
}

/** Generated facade only. No request context, Team id or physical marker can
 * create an execution lifetime or substitute for its actual captured values. */
export async function active_member(c: HandlerContext, person: unknown, team: unknown,
  marker: NativeMembershipMarker): Promise<boolean> {
  const frame = checked(c);
  try {
    if (frame.pending || frame.captured !== null) return refuse('membership calls must be awaited sequentially.');
    const user = ownObject(person, ['kind', 'id']);
    if (!isUserRef(person) || !Object.isFrozen(person) || user.kind !== 'user' ||
        frame.team === null || frame.nativeTeam == null || team !== frame.nativeTeam) {
      return refuse('owning frozen Values user and exact actual native Team required.');
    }
    const key = markerKey(marker);
    const matches = frame.binding.occurrences.filter(occurrence => occurrence.marker === key);
    if (matches.length !== 1) {
      return refuse(matches.length === 0 ? 'original checked occurrence absent from this actual outer owner/read.' :
        'ambiguous original occurrence: Compiler must lower the exact outer decision and derive call chain into the emitted membership marker.');
    }
    frame.pending = true;
    frame.captured = { occurrence: matches[0]!, person, team: frame.team };
    const value = frame.call !== undefined
      ? await evaluateScenarioReceiptMembership(frame.call, frame.store!, { site: matches[0]!.handle })
      : await evaluateReadPolicyMembership(frame.observation!, { site: matches[0]!.handle });
    checked(c);
    if (frame.captured !== null) return refuse('State must consume actual arguments before yielding.');
    return value;
  } catch (error) { return fail(frame, error); }
  finally { frame.pending = false; frame.captured = null; }
}

/** Subject roles are current source-read decisions. The owning State reader
 * supplies its tracked MembershipReader and coherent replay; owner mutation
 * helpers cannot substitute an untracked directory or invent commit guards. */
export async function nativeReadSubjectRole(c: HandlerContext, role: string, subject: unknown): Promise<boolean> {
  const frame = checked(c);
  try {
    if (frame.observation === undefined || frame.call !== undefined) {
      return refuse('subject hasRole requires its actual coherent State source-read policy context; owner mutation subject role ledger is unavailable.');
    }
    if (frame.pending || frame.captured !== null) return refuse('membership/role decisions must be awaited sequentially.');
    const person = ownObject(subject, ['kind', 'id']);
    if (!isUserRef(subject) || !Object.isFrozen(subject) || person.kind !== 'user' ||
        typeof role !== 'string' || role.length === 0 || role.length > 4096) {
      return refuse('subject role requires its owning frozen Values user and exact role.');
    }
    const observation = frame.observation, context = observation.context;
    if (observations.get(observation) !== frame || context.teamId !== (frame.team?.teamId ?? null) ||
        observation.fence !== undefined && observation.fence.revision !== observation.revision) {
      return refuse('subject role requires its exact original read/context/checkpoint.');
    }
    frame.pending = true;
    const answer = await stateSubjectRole(context, role, subject.id);
    checked(c);
    if (observations.get(observation) !== frame || frame.observation.context !== context ||
        context.teamId !== (frame.team?.teamId ?? null) ||
        observation.fence !== undefined && observation.fence.revision !== observation.revision) {
      return refuse('subject role crossed its exact original source-read checkpoint.');
    }
    return answer;
  } catch (error) { return fail(frame, error); }
  finally { frame.pending = false; }
}
