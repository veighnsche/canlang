/** Checked native source join. Public markers describe an occurrence; only the
 * actual State call/read and privately captured native arguments authorize it. */
import type { ScenarioReceiptSourceOrigin, StoragePort, Team, TeamScope } from '@canlang/contracts';
import { bindScenarioReceiptMembershipProducer, evaluateScenarioReceiptMembership,
  bindReadPolicyMembershipProducer, evaluateReadPolicyMembership,
  type ScenarioReceiptMembershipSite, type ScenarioReceiptMembershipHandle,
  type ReadPolicyMembershipHandle, type InstalledSourceReadPredicate,
  type InstalledSourceQueryPredicate } from '@canlang/state';
import { assertScenarioReceiptCallExecution, stableStringify, type AdmittedCall,
  checkScenarioReceiptMembershipSites,
  bindScenarioReceiptSendMembershipProducer, evaluateScenarioReceiptSendMembership,
  bindScenarioDispatchMembershipProducer, type ScenarioDispatchMembershipPorts,
  type ScenarioDispatchMembershipProducer, type ScenarioDispatchMembershipExecution,
  type ScenarioReceiptSendGuard } from '@canlang/state/invocation';
import { readDispatchGuardExecution, registerDispatchGuardRevalidation,
  type DispatchGuardExecution, type DispatchGuardExecutionContext } from '@canlang/work/dispatch';
import type { GeneratedOperationDef } from '@canlang/state/invocation/registry';
import type { AdmittedReadScenarioCall } from '@canlang/state/invocation/invoke';
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
  /** Indices in this actual privately bound site's original ordered call census. */
  readonly sourceCall?: { readonly siteIndex: number; readonly callIndex: number };
}
interface Occurrence {
  readonly site: string;
  readonly siteIndex: number;
  readonly callIndex: number;
  readonly marker: string;
  readonly handle?: Handle;
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
  readonly authorityReport?: AdmittedReadScenarioCall;
  readonly sourceSend?: { readonly predicate: string; readonly node: string };
  readonly dispatch?: {
    readonly execution: DispatchGuardExecution;
    readonly context: DispatchGuardExecutionContext;
    readonly team: Team | null;
    readonly teamSnapshot: string;
    observer: ScenarioDispatchMembershipExecution | undefined;
    captured: { readonly occurrence: Occurrence; readonly person: UserRef; readonly team: Team } | null;
    completed: boolean;
  };
  active: boolean;
  pending: boolean;
  failed: boolean;
  error: unknown;
  captured: { readonly occurrence: Occurrence; readonly person: UserRef; readonly team: TeamScope } | null;
}
const owners = new WeakMap<GeneratedOperationDef, Binding>();
const authorityReports = new WeakMap<GeneratedOperationDef, Binding>();
const reads = new WeakMap<Read, ReadonlyMap<string, Binding>>();
const frames = new WeakMap<HandlerContext, Frame>();
const calls = new WeakMap<AdmittedCall, Frame>();
const observations = new WeakMap<Observation, Frame>();
const sourceSends = new WeakMap<GeneratedOperationDef, ReadonlyMap<string, { readonly binding: Binding; readonly node: string }>>();
const sourceSendCalls = new WeakMap<AdmittedCall, Frame>();
const dispatches = new WeakMap<GeneratedOperationDef, ReadonlyMap<string, {
  readonly binding: Binding;
  readonly producer: ScenarioDispatchMembershipProducer<DispatchGuardExecution> | undefined;
}>>();
const dispatchExecutions = new WeakMap<DispatchGuardExecution, Frame>();
const eventRoles = new WeakMap<HandlerContext, (role: string, subject: UserRef) => Promise<boolean>>();
/** The checked Maintain IF/WHEN installs this only inside its live owner
 * decision callback. State validates the role, actual Plan assignee and fence. */
export function bindNativeEventDecisionRole(c: HandlerContext,
  evaluate: (role: string, subject: UserRef) => Promise<boolean>): () => void {
  const frame = checked(c);
  if (frame.call === undefined && frame.dispatch === undefined || eventRoles.has(c)) {
    return refuse('event subject role requires its unique live owner decision.');
  }
  eventRoles.set(c, evaluate);
  return () => { eventRoles.delete(c); };
}
/** The checked Leave owner callback uses the same coherent subject-role port. */
export function bindNativeLeaveRequestRole(c: HandlerContext,
  evaluate: (role: string, subject: UserRef) => Promise<boolean>): () => void {
  const frame = checked(c);
  if (frame.call === undefined || eventRoles.has(c)) {
    return refuse('Leave reviewer role requires its unique live mutation owner.');
  }
  eventRoles.set(c, evaluate);
  return () => { eventRoles.delete(c); };
}
/** Bind the referral manager check only inside its serial owner decision. */
export function bindNativeReferRejectRole(c: HandlerContext,
  evaluate: (role: string, subject: UserRef) => Promise<boolean>): () => void {
  const frame = checked(c);
  if (frame.call === undefined || eventRoles.has(c)) {
    return refuse('referral manager role requires its unique live mutation owner.');
  }
  eventRoles.set(c, evaluate);
  return () => { eventRoles.delete(c); };
}
/** Bind the checked refund's billing role within its live mutation owner. */
export function bindNativeRentMovementRefundRole(c: HandlerContext,
  evaluate: (role: string, subject: UserRef) => Promise<boolean>): () => void {
  const frame = checked(c);
  if (frame.call === undefined || eventRoles.has(c)) {
    return refuse('movement refund billing role requires its unique live mutation owner.');
  }
  eventRoles.set(c, evaluate);
  return () => { eventRoles.delete(c); };
}
/** Bind collection's finance role inside its checked Invoice owner decision. */
export function bindNativeInvoiceCollectRole(c: HandlerContext,
  evaluate: (role: string, subject: UserRef) => Promise<boolean>): () => void {
  const frame = checked(c);
  if (frame.call === undefined || eventRoles.has(c)) {
    return refuse('invoice collect finance role requires its unique live mutation owner.');
  }
  eventRoles.set(c, evaluate);
  return () => { eventRoles.delete(c); };
}
export function hasNativeOwnerMembership(def: GeneratedOperationDef): boolean { return owners.has(def); }
export function hasNativeAuthorityReportMembership(def: GeneratedOperationDef): boolean { return authorityReports.has(def); }
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
    if (frame.sourceSend !== undefined && sourceSendCalls.get(frame.call!) !== frame) {
      return refuse('source SEND requires its exact fresh native frame.');
    }
    if (frame.dispatch !== undefined) {
      const dispatch = frame.dispatch;
      if (dispatchExecutions.get(dispatch.execution) !== frame ||
          readDispatchGuardExecution(dispatch.execution) !== dispatch.context ||
          stableStringify(dispatch.team) !== dispatch.teamSnapshot ||
          (dispatch.team === null ? c.team != null : c.team == null ||
            c.team.id !== dispatch.team.team_id || c.team.timezone !== dispatch.team.timezone)) {
        return refuse('dispatch requires its exact live Work execution and original admitted Team.');
      }
    }
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
function checkMarkerSelection(marker: Record<string, unknown>): void {
  const selection = ownObject(marker.sourceCall, ['siteIndex', 'callIndex']);
  if (!Number.isSafeInteger(selection.siteIndex) || (selection.siteIndex as number) < 0 ||
      !Number.isSafeInteger(selection.callIndex) || (selection.callIndex as number) < 0) {
    return refuse('exact original site/call indices required.');
  }
}

function checkMarkerSourceNode(marker: Record<string, unknown>): { source: Record<string, unknown>; node: Record<string, unknown> } {
  const source = ownObject(marker.source, ['path', 'sha256', 'module']);
  const node = ownObject(marker.node, ['start', 'end']);
  if (typeof source.path !== 'string' || source.path.length === 0 || source.path.length > 4096 ||
      typeof source.module !== 'string' || source.module.length === 0 || source.module.length > 4096 ||
      typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) ||
      (node.start as number) < 0 || (node.end as number) <= (node.start as number)) {
    return refuse('exact emitted physical source/node required.');
  }
  return { source, node };
}

function markerKey(value: unknown): string {
  const selected = typeof value === 'object' && value !== null && Object.hasOwn(value, 'sourceCall');
  const marker = ownObject(value, ['source', 'node', ...(selected ? ['sourceCall'] : [])]);
  if (selected) checkMarkerSelection(marker);
  const { source, node } = checkMarkerSourceNode(marker);
  return stableStringify({ source, node });
}
function binding(sites: readonly ScenarioReceiptMembershipSite[], handles?: readonly Handle[]): Binding {
  // State has synchronously checked every own-data recipe before this copy.
  const snapshot = JSON.parse(stableStringify(sites)) as ScenarioReceiptMembershipSite[];
  const occurrences: Occurrence[] = []; let handleIndex = 0;
  snapshot.forEach((site, siteIndex) => site.calls.forEach((call, callIndex) => {
    if (call.target.kind !== 'builtin' || call.target.id !== 'active_member') return;
    const handle = handles?.[handleIndex++];
    if (handles !== undefined && handle === undefined) return refuse('complete checked handle census required.');
    occurrences.push(Object.freeze({ site: stableStringify(site), siteIndex, callIndex,
      marker: markerKey({ source: call.source, node: call.node }), ...(handle === undefined ? {} : { handle }) }));
  }));
  if (handles !== undefined && handleIndex !== handles.length) return refuse('complete checked handle census required.');
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

/** The verified authority-report module supplies the exact active_member
 * occurrence inventory; State's admitted read decision supplies live Identity. */
export function bindNativeAuthorityReportMembership(def: GeneratedOperationDef, input: {
  readonly source: ScenarioReceiptSourceOrigin;
  readonly sites: readonly ScenarioReceiptMembershipSite[];
}): void {
  if (authorityReports.has(def) || def.descriptor.kind !== 'read') return refuse('one exact authority report membership owner required.');
  const sites = checkScenarioReceiptMembershipSites(input.sites);
  if (sites.length === 0 || sites.some(site => site.owner !== def.name ||
      stableStringify(site.source) !== stableStringify(input.source) ||
      site.stage !== 'leading-require' && site.calls.some(call =>
        call.target.kind === 'builtin' && call.target.id === 'active_member'))) {
    return refuse('authority report membership must belong to its original leading Require.');
  }
  const count = sites.reduce((sum, site) => sum + site.calls.filter(call =>
    call.target.kind === 'builtin' && call.target.id === 'active_member').length, 0);
  if (count === 0) return refuse('authority report membership needs its checked source occurrence.');
  authorityReports.set(def, binding(sites));
}

/** Bind once after State's exact framework SEND inventory. Each source guard
 * opens a separate fresh native context on its actual still-live State call. */
export function bindNativeSourceSendMembership(def: GeneratedOperationDef, input: {
  readonly source: ScenarioReceiptSourceOrigin; readonly app: string;
  readonly guards: readonly ScenarioReceiptSendGuard[];
  readonly sites: readonly ScenarioReceiptMembershipSite[];
}): void {
  if (sourceSends.has(def)) return refuse('source SEND definition cannot be rebound.');
  const guards = JSON.parse(stableStringify(input.guards)) as ScenarioReceiptSendGuard[];
  const rules = new Set<string>();
  for (const guard of guards) {
    if (typeof guard.rule !== 'string' || guard.rule.length === 0 || guard.rule.length > 4096 ||
        rules.has(guard.rule) || guard.owner !== def.name ||
        stableStringify(guard.source) !== stableStringify(input.source)) {
      return refuse('exact original source SEND guard inventory required.');
    }
    markerKey({ source: guard.source, node: guard.node });
    rules.add(guard.rule);
  }
  if (input.sites.some(site => site.stage !== 'send-dispatch' || site.owner !== def.name ||
      stableStringify(site.source) !== stableStringify(input.source) ||
      guards.filter(guard => stableStringify(guard.node) === stableStringify(site.node)).length !== 1)) {
    return refuse('source SEND membership must belong to its exact original guard.');
  }
  const hasMembership = input.sites.some(site => site.calls.some(call => call.target.kind === 'builtin' && call.target.id === 'active_member'));
  const handles = hasMembership ? bindScenarioReceiptSendMembershipProducer(def, {
    source: input.source, app: input.app, sites: input.sites,
    capture: (call, site, index) => {
      const frame = sourceSendCalls.get(call);
      if (frame?.sourceSend === undefined || frame.sourceSend.node !== stableStringify(site.node)) {
        return refuse('exact source SEND guard capture required.');
      }
      return capture(frame, site, index);
    },
  }) : [];
  const complete = binding(input.sites, handles);
  sourceSends.set(def, new Map(guards.map(guard => {
    const node = stableStringify(guard.node);
    const sites = complete.sites.filter(site => stableStringify(site.node) === node);
    const keys = new Set(sites.map(site => stableStringify(site)));
    return [guard.rule, Object.freeze({ node, binding: Object.freeze({ sites,
      occurrences: Object.freeze(complete.occurrences.filter(occurrence => keys.has(occurrence.site))) }) })];
  })));
}

/** Deferred membership uses the defining State observer and literal Work
 * execution ports. No empty observer is registered for a role-only guard. */
export function bindNativeDispatchMembership(def: GeneratedOperationDef,
  input: Omit<ScenarioDispatchMembershipPorts<DispatchGuardExecution>, 'readExecution' | 'registerRevalidation' | 'capture'>): void {
  const previous = dispatches.get(def) ?? new Map();
  if (typeof input.predicate !== 'string' || input.predicate.length === 0 || input.predicate.length > 4096 ||
      input.sites.some(site => site.stage !== 'send-dispatch' || site.owner !== def.name ||
        stableStringify(site.source) !== stableStringify(input.source))) return refuse('exact original dispatch source and predicate required.');
  if (previous.has(input.predicate)) return refuse('dispatch predicate cannot be rebound.');
  const hasMembership = input.sites.some(site => site.calls.some(call => call.target.kind === 'builtin' && call.target.id === 'active_member'));
  const producer = hasMembership ? bindScenarioDispatchMembershipProducer(def, {
    source: input.source, app: input.app, predicate: input.predicate, sites: input.sites,
    store: input.store, memberships: input.memberships, admit: input.admit,
    readExecution: readDispatchGuardExecution, registerRevalidation: registerDispatchGuardRevalidation,
    capture: (execution, site, callIndex) => {
      const frame = dispatchExecutions.get(execution);
      if (frame?.dispatch === undefined) return refuse('actual dispatch native capture required.');
      try {
        checkedNativeDispatch(frame);
        const value = frame.dispatch.captured;
        if (!frame.pending || value === null || value.occurrence.site !== stableStringify(site) ||
            value.occurrence.callIndex !== callIndex) return refuse('once-only original dispatch argument capture required.');
        frame.dispatch.captured = null;
        return Object.freeze({ person: value.person, team: value.team });
      } catch (error) { return fail(frame, error); }
    },
  }) : undefined;
  dispatches.set(def, new Map([...previous, [input.predicate, Object.freeze({
    binding: binding(input.sites, producer?.sites ?? []), producer })]]));
}

function checkedNativeDispatch(frame: Frame): void {
  const dispatch = frame.dispatch;
  if (dispatch === undefined || !frame.active || frame.failed ||
      dispatchExecutions.get(dispatch.execution) !== frame ||
      readDispatchGuardExecution(dispatch.execution) !== dispatch.context ||
      stableStringify(dispatch.team) !== dispatch.teamSnapshot) {
    return refuse('exact active native dispatch and admitted Team required.');
  }
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
      if (frame.pending || frame.captured !== null || frame.dispatch?.captured != null) {
        return fail(frame, new StateError('validation', 'Native membership must complete before its owner/read returns.'));
      }
      if (frame.dispatch !== undefined) frame.dispatch.completed = true;
    },
    close() {
      frame.active = false;
      if (frame.pending || frame.captured !== null || frame.dispatch?.captured != null) {
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

export function openNativeAuthorityReportMembershipFrame(c: HandlerContext, call: AdmittedReadScenarioCall,
  actualTeam: TeamScope | null, failure: (error: unknown) => void): NativeMembershipFrame {
  const installed = authorityReports.get(call.def);
  if (installed === undefined || call.decision?.scope !== 'authority' ||
      (actualTeam === null ? c.team != null || call.teamId !== null : c.team == null ||
        actualTeam.teamId !== call.teamId || c.team.id !== actualTeam.teamId ||
        c.team.timezone !== actualTeam.timezone)) {
    return refuse('actual admitted authority report and corresponding native Team required.');
  }
  const frame: Frame = { binding: installed, nativeTeam: c.team, team: actualTeam,
    teamSnapshot: stableStringify(actualTeam), authorityReport: call, failure,
    active: true, pending: false, failed: false, error: undefined, captured: null };
  return open(c, frame);
}

/** Only State's source evaluateGuard callback supplies the actual call. Each
 * guard receives a fresh c while sharing its original owner commit ledger. */
export function openNativeSourceSendMembershipFrame(c: HandlerContext, call: AdmittedCall,
  store: StoragePort, predicate: string, failure: (error: unknown) => void): NativeMembershipFrame {
  assertScenarioReceiptCallExecution(call, store);
  const nativePrevious = frames.get(c);
  if (nativePrevious !== undefined) return fail(nativePrevious, new StateError('validation', 'Source SEND needs a fresh native context.'));
  const installed = sourceSends.get(call.def as GeneratedOperationDef)?.get(predicate);
  const previous = sourceSendCalls.get(call);
  if (previous !== undefined && (previous.active || previous.failed || previous.pending || previous.captured !== null)) {
    return fail(previous, new StateError('validation', 'Source SEND native frame is concurrent or poisoned.'));
  }
  if (installed === undefined || (call.context.team === null ? c.team != null : c.team == null ||
      c.team.id !== call.context.team.teamId || c.team.timezone !== call.context.team.timezone)) {
    return refuse('actual bound source SEND and corresponding State Team required.');
  }
  const frame: Frame = { binding: installed.binding, nativeTeam: c.team, team: call.context.team,
    teamSnapshot: stableStringify(call.context.team), call, store, failure,
    sourceSend: Object.freeze({ predicate, node: installed.node }),
    active: true, pending: false, failed: false, error: undefined, captured: null };
  const lifecycle = open(c, frame); sourceSendCalls.set(call, frame); return lifecycle;
}

/** Call at the actual Work evaluator entry, with the original Team that its
 * installed admission port returns. Copied facts/handles cannot open a frame. */
export function openNativeDispatchMembershipFrame(c: HandlerContext, def: GeneratedOperationDef,
  predicate: string, execution: DispatchGuardExecution, actualDispatchTeam: Team | null,
  failure: (error: unknown) => void): NativeMembershipFrame {
  const context = readDispatchGuardExecution(execution);
  const previous = dispatchExecutions.get(execution);
  if (previous !== undefined) return fail(previous, new StateError('validation', 'Dispatch native execution cannot be reopened.'));
  const nativePrevious = frames.get(c);
  if (nativePrevious !== undefined) {
    registerDispatchGuardRevalidation(execution, () => false);
    return fail(nativePrevious, new StateError('validation', 'Dispatch needs a fresh native context.'));
  }
  const installed = dispatches.get(def)?.get(predicate);
  if (installed === undefined || context.predicate !== predicate ||
      context.checkpoint === undefined || (actualDispatchTeam === null ? c.team != null :
        context.checkpoint.owner !== actualDispatchTeam.team_id || c.team == null ||
        c.team.id !== actualDispatchTeam.team_id || c.team.timezone !== actualDispatchTeam.timezone)) {
    // Register refusal before throwing so caught installation misuse cannot claim or skip.
    registerDispatchGuardRevalidation(execution, () => false);
    return refuse('exact installed predicate, fresh Work checkpoint and native Team required.');
  }
  const dispatch: NonNullable<Frame['dispatch']> = { execution, context, team: actualDispatchTeam,
    teamSnapshot: stableStringify(actualDispatchTeam), observer: undefined, captured: null, completed: false };
  const frame: Frame = { binding: installed.binding, nativeTeam: c.team, team: null,
    teamSnapshot: stableStringify(null), dispatch, failure,
    active: true, pending: false, failed: false, error: undefined, captured: null };
  // Native facade misuse must poison the fence even when authored code catches it.
  registerDispatchGuardRevalidation(execution, () => !frame.active && dispatch.completed &&
    !frame.failed && !frame.pending && dispatch.captured === null &&
    stableStringify(dispatch.team) === dispatch.teamSnapshot);
  dispatch.observer = installed.producer?.open(execution);
  const lifecycle = open(c, frame); dispatchExecutions.set(execution, frame); return lifecycle;
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
async function resolveMemberValue(frame: Frame, matches: Frame['binding']['occurrences'], person: UserRef, team: unknown): Promise<boolean> {
  const occurrence = matches[0]!;
  if (frame.dispatch !== undefined) {
    if (frame.dispatch.observer === undefined || frame.dispatch.team === null) return refuse('original dispatch membership observer required.');
    if (occurrence.handle === undefined) return refuse('dispatch membership lacks its checked State handle.');
    frame.dispatch.captured = { occurrence, person, team: frame.dispatch.team };
    return frame.dispatch.observer.evaluate({ site: occurrence.handle });
  }
  if (frame.authorityReport !== undefined) {
    if (frame.authorityReport.decision?.scope !== 'authority' || frame.team === null) {
      return refuse('authority report lost its admitted Identity decision.');
    }
    return frame.authorityReport.decision.activeMember(person.id);
  }
  if (occurrence.handle === undefined) return refuse('membership lacks its checked State handle.');
  frame.captured = { occurrence, person, team: frame.team! };
  if (frame.call !== undefined) {
    return frame.sourceSend !== undefined
      ? evaluateScenarioReceiptSendMembership(frame.call, frame.store!, { site: occurrence.handle })
      : evaluateScenarioReceiptMembership(frame.call, frame.store!, { site: occurrence.handle });
  }
  return evaluateReadPolicyMembership(frame.observation!, { site: occurrence.handle });
}

export async function active_member(c: HandlerContext, person: unknown, team: unknown,
  marker: NativeMembershipMarker): Promise<boolean> {
  const frame = checked(c);
  try {
    if (frame.pending || frame.captured !== null) return refuse('membership calls must be awaited sequentially.');
    const user = ownObject(person, ['kind', 'id']);
    if (!isUserRef(person) || !Object.isFrozen(person) || user.kind !== 'user' ||
        (frame.dispatch === undefined ? frame.team === null : frame.dispatch.team === null) ||
        frame.nativeTeam == null || team !== frame.nativeTeam) {
      return refuse('owning frozen Values user and exact actual native Team required.');
    }
    const key = markerKey(marker);
    const selection = Object.hasOwn(marker, 'sourceCall') ? marker.sourceCall : undefined;
    const matches = frame.binding.occurrences.filter(occurrence => occurrence.marker === key &&
      (selection === undefined || occurrence.siteIndex === selection.siteIndex && occurrence.callIndex === selection.callIndex));
    if (matches.length !== 1) {
      return refuse(matches.length === 0 ? 'original checked occurrence absent from this actual outer owner/read.' :
        'ambiguous original occurrence: Compiler must lower the exact outer decision and derive call chain into the emitted membership marker.');
    }
    frame.pending = true;
    const value = await resolveMemberValue(frame, matches, person, team);
    checked(c);
    if (frame.captured !== null || frame.dispatch?.captured != null) return refuse('State must consume actual arguments before yielding.');
    return value;
  } catch (error) { return fail(frame, error); }
  finally { frame.pending = false; frame.captured = null; if (frame.dispatch !== undefined) frame.dispatch.captured = null; }
}

/** Subject roles are current source-read decisions. The owning State reader
 * supplies its tracked MembershipReader and coherent replay; owner mutation
 * helpers cannot substitute an untracked directory or invent commit guards. */
function checkSubjectPerson(subject: unknown, role: string): UserRef {
  const person = ownObject(subject, ['kind', 'id']);
  if (!isUserRef(subject) || !Object.isFrozen(subject) || person.kind !== 'user' ||
      typeof role !== 'string' || role.length === 0 || role.length > 4096) {
    return refuse('subject role requires its owning frozen Values user and exact role.');
  }
  return subject;
}

function checkSubjectCheckpoint(frame: Frame, observation: NonNullable<Frame['observation']>,
  context: NonNullable<Frame['observation']>['context']): void {
  if (observations.get(observation) !== frame || context.teamId !== (frame.team?.teamId ?? null) ||
      observation.fence !== undefined && observation.fence.revision !== observation.revision) {
    return refuse('subject role requires its exact original read/context/checkpoint.');
  }
}

export async function nativeReadSubjectRole(c: HandlerContext, role: string, subject: unknown): Promise<boolean> {
  const frame = checked(c);
  try {
    const eventRole = eventRoles.get(c);
    if (eventRole !== undefined) {
      if (frame.call === undefined && frame.dispatch === undefined || frame.pending || frame.captured !== null) {
        return refuse('event subject role crossed its owner decision frame.');
      }
      const userSubject = checkSubjectPerson(subject, role);
      frame.pending = true;
      const answer = await eventRole(role, userSubject);
      checked(c);
      if (eventRoles.get(c) !== eventRole || typeof answer !== 'boolean') {
        return refuse('event subject role lost its exact State observation.');
      }
      return answer;
    }
    if (frame.observation === undefined || frame.call !== undefined) {
      return refuse('subject hasRole requires its actual coherent State source-read policy context; owner mutation subject role ledger is unavailable.');
    }
    if (frame.pending || frame.captured !== null) return refuse('membership/role decisions must be awaited sequentially.');
    const userSubject = checkSubjectPerson(subject, role);
    const observation = frame.observation, context = observation.context;
    checkSubjectCheckpoint(frame, observation, context);
    frame.pending = true;
    const answer = await stateSubjectRole(context, role, userSubject.id);
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
