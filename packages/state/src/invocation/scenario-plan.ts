/** Closed disclosure-plan validation. Execution/session authority stays in scenario-receipt. */
import type { CanTypeId, ModelName, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { canonicalLocale, parseTypeId, printTypeId } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { stableStringify } from './replay.js';
import { checkQueries, checkQueryProjection } from './scenario-query-plan.js';
import { storedNominalType } from './scenario-stored-value.js';
export const MAX_ITEMS = 200;
export const invalid = (message: string): never => { throw new StateError('validation', `Saved scenario: ${message}`); };

/** Own JSON data only: no accessors, prototypes, aliasing, cycles or unbounded trees. */
export function dataCopy<T>(value: T, decodedValues = false, maximum=20_000): T {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (part: unknown, depth: number): unknown => {
    if (++nodes > maximum || depth > 32) return invalid('data exceeds its finite budget.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (decodedValues && typeof part === 'bigint') return part;
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || part === null || seen.has(part) ||
        (Array.isArray(part) ? Object.getPrototypeOf(part) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(part)))) {
      return invalid('own JSON data is required.');
    }
    seen.add(part);
    const out: unknown[] | Record<string, unknown> = Array.isArray(part) ? [] : {};
    for (const key of Reflect.ownKeys(part)) {
      if (Array.isArray(part) && key === 'length') continue;
      const member = Object.getOwnPropertyDescriptor(part, key);
      if (typeof key !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
          (Array.isArray(part) && !/^(0|[1-9]\d*)$/.test(key))) return invalid('own enumerable data is required.');
      Object.defineProperty(out, key, { value: copy(member.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    if (Array.isArray(part) && Object.keys(out).length !== part.length) return invalid('sparse arrays are unsupported.');
    seen.delete(part); return out;
  };
  return copy(value, 0) as T;
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
        const member = Object.getOwnPropertyDescriptor(value, key);
        return member === undefined || !('value' in member) || !member.enumerable;
      })) return invalid('closed own data shape required.');
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid('nonempty identity required.');
}
export function list(value: unknown): unknown[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS ? value : invalid('bounded array required.');
}
export function scalarType(type: unknown): CanTypeId {
  if (typeof type !== 'string') return invalid('declared scalar type required.');
  if (type === 'void') return type as CanTypeId;
  try {
    const parsed = parseTypeId(type);
    if (printTypeId(parsed) !== type || parsed.requiredArray ||
        !(parsed.base.kind === 'enum' || /^(int|datetime|text|email|timezone|bool|decimal|money|date|duration|currency|user)(\[\])?\??$/.test(type))) {
      return invalid(`unsupported disclosure type ${JSON.stringify(type)}; defining composite/lifetime join required.`);
    }
  } catch (error) {
    if (error instanceof StateError) throw error;
    return invalid('invalid scalar type.');
  }
  return type as CanTypeId;
}
/** Only dependency sites may name an owning stored contract. Results,
 * intrinsics, query influence and changed-record inventories stay scalar. */
function dependencyType(type: unknown): CanTypeId {
  if (type === 'file' || type === 'file?' || type === 'file[]') return type as CanTypeId;
  try { return scalarType(type); }
  catch { return storedNominalType(type); }
}
export function origin(value: unknown): void {
  const source = object(value, ['path', 'sha256', 'module']);
  text(source['path']); text(source['module']);
  if (typeof source['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(source['sha256'])) return invalid('exact source digest required.');
}

/** Original AST intervals, including the sealed numeric syntax kind. Error
 * text belongs to the owning profile; Event keeps its separate kind refusal. */
function checkedSyntaxIntervals(failure: string, kindFailure = failure) {
  return (value: unknown): EventDecisionSite['node'] => {
    const node = object(value, ['start', 'end', 'kind']);
    if (!Number.isSafeInteger(node['start']) || !Number.isSafeInteger(node['end']) ||
        (node['start'] as number) < 0 || (node['end'] as number) <= (node['start'] as number)) return invalid(failure);
    if (!Number.isSafeInteger(node['kind']) || (node['kind'] as number) < 0) return invalid(kindFailure);
    return node as unknown as EventDecisionSite['node'];
  };
}
/** One profile's original site/query identity census. Member retry checks
 * statement containment later, with its ordered effects, so that mode must
 * not admit an earlier containment refusal here. */
function decisionSourceSites(source: ScenarioResultDisclosurePlan['source'],
  span: ReturnType<typeof checkedSyntaxIntervals>, failure: string, mode: 'contained' | 'identity') {
  const ids = new Set<string>();
  const site = (value: unknown, extra: readonly string[] | Readonly<{ key: string; value: string }> = []): EventDecisionSite => {
    const expected = 'key' in extra ? extra : undefined;
    const keys = expected === undefined ? extra as readonly string[] : [expected.key];
    const item = object(value, ['id', 'source', 'node', 'statement', ...keys]);
    const id = text(item['id']); origin(item['source']);
    const node = span(item['node']), statement = span(item['statement']);
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id) ||
        stableStringify(item['source']) !== stableStringify(source) ||
        mode === 'contained' && (node.start < statement.start || node.end > statement.end) ||
        expected !== undefined && item[expected.key] !== expected.value) return invalid(failure);
    ids.add(id); return item as unknown as EventDecisionSite;
  };
  return { ids, site };
}

export interface EventDecisionSite {
  readonly id: string;
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly node: { readonly start: number; readonly end: number; readonly kind: number };
  readonly statement: { readonly start: number; readonly end: number; readonly kind: number };
}
export interface EventDecisionQuerySite {
  readonly id: string;
  readonly decision: 'if' | 'when';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly callSite: EventDecisionSite['node'];
  readonly aliasSite: EventDecisionSite['node'];
  readonly predicateSite: EventDecisionSite['node'];
  readonly model: 'maintain.Cancellation' | 'employee.Employee';
  readonly domainKind: 'event-child' | 'tenant-root';
  readonly ownerPath: readonly string[];
  readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
    readonly callSite: EventDecisionSite['node']; readonly derive: string }[];
}
export interface EventDecisionPlan {
  readonly version: 1;
  readonly owner: 'maintain.remind';
  readonly event: 'maintain.Reminder';
  readonly rowField: 'inspection';
  readonly rowModel: 'maintain.Inspection';
  readonly revisionField: 'revision';
  readonly letSite: EventDecisionSite;
  readonly ifSite: EventDecisionSite;
  readonly whenSite: EventDecisionSite;
  readonly sendSite: EventDecisionSite;
  readonly setSite: EventDecisionSite & { readonly target: 'eventTerm'; readonly field: 'reminded_at'; readonly value: 'now' };
  readonly querySites: readonly EventDecisionQuerySite[];
  readonly roleSites: readonly { readonly id: string; readonly decision: 'if' | 'when';
    readonly source: ScenarioResultDisclosurePlan['source']; readonly callSite: EventDecisionSite['node'];
    readonly role: 'maintain.technician'; readonly deriveChain: EventDecisionQuerySite['deriveChain'] }[];
}
/** The venue observer stages one guarded Rooms confirmation for the single
 * Change row selected by the provider source. */
export interface ObserveVenueQuerySite {
  readonly id: string;
  readonly stage: 'venueScan';
  readonly model: 'events.Change';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly queryNode: EventDecisionSite['node'];
  readonly callSite: EventDecisionSite['node'];
  readonly aliasSite: EventDecisionSite['node'];
  readonly predicateSite: EventDecisionSite['node'];
  readonly selectionSite: EventDecisionSite['node'];
  readonly domainKind: 'tenant-root';
  readonly ownerPath: readonly string[];
  readonly order: readonly unknown[];
  readonly deriveChain: readonly unknown[];
}
export interface ObserveVenueDecisionPlan {
  readonly version: 1;
  readonly owner: 'events.observe_venue';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly sites: { readonly for: EventDecisionSite & { readonly model: 'events.Change' };
    readonly send: EventDecisionSite };
  readonly querySites: readonly ObserveVenueQuerySite[];
  readonly sendRule: { readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source'];
    readonly node: EventDecisionSite['node']; readonly statement: EventDecisionSite['statement'] };
}
/** Closed renewal/follow-up owner profiles; the existing transport field stays stable. */
export interface SuccessRenewalDecisionPlan {
  readonly version: 1;
  readonly owner: 'success.renewal_due' | 'success.remind';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly sites: { readonly require: EventDecisionSite; readonly if: EventDecisionSite;
    readonly send: EventDecisionSite; readonly create: EventDecisionSite };
  readonly sendRule: { readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source'];
    readonly node: EventDecisionSite['node']; readonly statement: EventDecisionSite['statement'] };
}
export function checkObserveVenueDecisionPlan(value: unknown, transport: unknown): ObserveVenueDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'sites', 'querySites', 'sendRule']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as ScenarioResultDisclosurePlan['source'];
  const carrier = transport as ScenarioResultDisclosurePlan['source'];
  if (raw['version'] !== 1 || raw['owner'] !== 'events.observe_venue' || source.module !== 'events' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256) {
    return invalid('observe decision needs its original venue source.');
  }
  const span = checkedSyntaxIntervals('observe decision needs nonempty original source intervals.');
  const sites = object(raw['sites'], ['for', 'send']);
  const { ids, site } = decisionSourceSites(source, span, 'observe decision site differs from its checked source.', 'contained');
  const scanned = site(sites['for'], ['model']);
  if ((sites['for'] as { readonly model: unknown }).model !== 'events.Change') {
    return invalid('observe decision scan needs its original Change target.');
  }
  const send = site(sites['send']);
  if (send.statement.start < scanned.statement.start || send.statement.end > scanned.statement.end) {
    return invalid('observe SEND must stage inside its original venue scan.');
  }
  const scanSites = list(raw['querySites']);
  if (scanSites.length !== 1) {
    return invalid('observe decision needs its single checked Change scan.');
  }
  const scan = object(scanSites[0], ['id', 'stage', 'model', 'source', 'queryNode', 'callSite',
    'aliasSite', 'predicateSite', 'selectionSite', 'domainKind', 'ownerPath', 'order', 'deriveChain']);
  const scanId = text(scan['id']);
  origin(scan['source']);
  span(scan['queryNode']); span(scan['callSite']); span(scan['aliasSite']);
  span(scan['predicateSite']); span(scan['selectionSite']);
  const scanQuery = scan['queryNode'] as EventDecisionSite['node'];
  const scanCall = scan['callSite'] as EventDecisionSite['node'];
  const scanAlias = scan['aliasSite'] as EventDecisionSite['node'];
  const scanPredicate = scan['predicateSite'] as EventDecisionSite['node'];
  const scanSelection = scan['selectionSite'] as EventDecisionSite['node'];
  if (!/^[a-f0-9]{64}$/.test(scanId) || ids.has(scanId) ||
      scan['stage'] !== 'venueScan' || scan['model'] !== 'events.Change' ||
      stableStringify(scan['source']) !== stableStringify(source) ||
      scan['domainKind'] !== 'tenant-root' ||
      list(scan['ownerPath']).length !== 0 ||
      list(scan['order']).length !== 0 ||
      list(scan['deriveChain']).length !== 0 ||
      scanQuery.start < scanned.node.start || scanQuery.end > scanned.node.end ||
      scanPredicate.start < scanned.node.start || scanPredicate.end > scanned.node.end ||
      scanCall.start !== scanned.statement.start || scanCall.end !== scanned.statement.end ||
      scanAlias.start !== scanned.statement.start || scanAlias.end !== scanned.statement.end ||
      scanSelection.start !== scanned.statement.start || scanSelection.end !== scanned.statement.end) {
    return invalid('observe scan differs from its exact Change source site.');
  }
  ids.add(scanId);
  const rule = object(raw['sendRule'], ['rule', 'source', 'node', 'statement']);
  text(rule['rule']); origin(rule['source']); span(rule['node']); span(rule['statement']);
  if (stableStringify(rule['source']) !== stableStringify(source) ||
      stableStringify(rule['node']) !== stableStringify(send.node) ||
      stableStringify(rule['statement']) !== stableStringify(send.statement)) {
    return invalid('observe SEND lacks its original guarded source occurrence.');
  }
  return deepFreeze(raw) as unknown as ObserveVenueDecisionPlan;
}
export function checkSuccessRenewalDecisionPlan(value: unknown, transport: unknown): SuccessRenewalDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'sites', 'sendRule']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as ScenarioResultDisclosurePlan['source'];
  const carrier = transport as ScenarioResultDisclosurePlan['source'];
  if (raw['version'] !== 1 || (raw['owner'] !== 'success.renewal_due' && raw['owner'] !== 'success.remind') || source.module !== 'success' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256) {
    return invalid('renewal decision needs its original success source.');
  }
  const span = checkedSyntaxIntervals('renewal decision needs nonempty original source intervals.');
  const sites = object(raw['sites'], ['require', 'if', 'send', 'create']);
  const { ids, site } = decisionSourceSites(source, span, 'renewal decision site differs from its checked source.', 'contained');
  const required = site(sites['require']);
  const admitted = site(sites['if']);
  const send = site(sites['send']);
  const create = site(sites['create']);
  if (admitted.statement.start < required.statement.end ||
      send.statement.start < admitted.statement.start || send.statement.end > admitted.statement.end ||
      create.statement.start < admitted.statement.start || create.statement.end > admitted.statement.end) {
    return invalid('renewal SEND and Notice must stage inside their exact renewal IF after its Require.');
  }
  const rule = object(raw['sendRule'], ['rule', 'source', 'node', 'statement']);
  text(rule['rule']); origin(rule['source']);
  const ruleNode = object(rule['node'], ['start', 'end']);
  const ruleStatement = object(rule['statement'], ['start', 'end']);
  if (stableStringify(rule['source']) !== stableStringify(source) ||
      ruleNode['start'] !== send.node.start || ruleNode['end'] !== send.node.end ||
      ruleStatement['start'] !== send.statement.start || ruleStatement['end'] !== send.statement.end) {
    return invalid('renewal SEND lacks its original guarded source occurrence.');
  }
  return deepFreeze(raw) as unknown as SuccessRenewalDecisionPlan;
}
export function checkEventDecisionPlan(value: unknown, transport: unknown): EventDecisionPlan {
  const raw = object(value, ['version', 'owner', 'event', 'rowField', 'rowModel', 'revisionField',
    'letSite', 'ifSite', 'whenSite', 'sendSite', 'setSite', 'querySites', 'roleSites']);
  const receiptSource = object(transport, ['path', 'sha256', 'module']);
  if (raw['version'] !== 1 || raw['owner'] !== 'maintain.remind' || raw['event'] !== 'maintain.Reminder' ||
      raw['rowField'] !== 'inspection' || raw['rowModel'] !== 'maintain.Inspection' ||
      raw['revisionField'] !== 'revision') return invalid('event decision requires its exact Maintain handler and event fields.');
  const span = checkedSyntaxIntervals('event decision needs a nonempty original source interval.', 'event decision needs its original syntax kind.');
  const ids = new Set<string>();
  const siteId = (value: unknown): void => {
    const id = text(value);
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id)) return invalid('event decision needs unique checked source identities.');
    ids.add(id);
  };
  const site = (value: unknown, set = false): void => {
    const item = object(value, ['id', 'source', 'node', 'statement', ...(set ? ['target', 'field', 'value'] : [])]);
    siteId(item['id']); origin(item['source']); span(item['node']); span(item['statement']);
    const originalSource = object(item['source'], ['path', 'sha256', 'module']);
    if (originalSource['module'] !== 'maintain' ||
        originalSource['path'] !== receiptSource['path'] ||
        originalSource['sha256'] !== receiptSource['sha256']) {
      return invalid('event decision site differs from its owning source.');
    }
    if (set && (item['target'] !== 'eventTerm' || item['field'] !== 'reminded_at' || item['value'] !== 'now')) {
      return invalid('event decision SET requires its exact Inspection.reminded_at assignment.');
    }
  };
  for (const key of ['letSite', 'ifSite', 'whenSite', 'sendSite'] as const) site(raw[key]);
  site(raw['setSite'], true);
  const chain = (value: unknown): void => {
    const entries = list(value);
    if (entries.length === 0 || entries.length > 8) return invalid('event decision requires its bounded original derive chain.');
    for (const entry of entries) {
      const item = object(entry, ['source', 'callSite', 'derive']);
      origin(item['source']); span(item['callSite']); text(item['derive']);
    }
  };
  const queries = list(raw['querySites']);
  if (queries.length !== 4) return invalid('event decision needs both complete source query domains.');
  for (const [index, entry] of queries.entries()) {
    const item = object(entry, ['id', 'decision', 'source', 'callSite', 'aliasSite', 'predicateSite',
      'model', 'domainKind', 'ownerPath', 'deriveChain']);
    siteId(item['id']); origin(item['source']); span(item['callSite']); span(item['aliasSite']); span(item['predicateSite']);
    const decision = index < 2 ? 'if' : 'when';
    const cancellation = index % 2 === 0;
    if (item['decision'] !== decision || item['model'] !== (cancellation ? 'maintain.Cancellation' : 'employee.Employee') ||
        item['domainKind'] !== (cancellation ? 'event-child' : 'tenant-root') ||
        stableStringify(list(item['ownerPath'])) !== stableStringify(cancellation ? ['parent', 'parent'] : [])) {
      return invalid('event decision query differs from its ordered Cancellation/Employee source domains.');
    }
    chain(item['deriveChain']);
  }
  const roles = list(raw['roleSites']);
  if (roles.length !== 2) return invalid('event decision requires its two original technician role sites.');
  for (const [index, entry] of roles.entries()) {
    const item = object(entry, ['id', 'decision', 'source', 'callSite', 'role', 'deriveChain']);
    siteId(item['id']); origin(item['source']); span(item['callSite']); chain(item['deriveChain']);
    if (item['decision'] !== (index === 0 ? 'if' : 'when') || item['role'] !== 'maintain.technician') {
      return invalid('event decision role differs from its original technician call.');
    }
  }
  return deepFreeze(raw) as unknown as EventDecisionPlan;
}

export interface TermDecisionSite {
  readonly id: string;
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly node: EventDecisionSite['node'];
  readonly statement: EventDecisionSite['statement'];
}
export interface TermDecisionPlan {
  readonly version: 1;
  readonly owner: 'member_terms.term';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly parameters: readonly [
    { readonly name: 'membership'; readonly model: 'member_terms.Membership'; readonly nullable: false },
    { readonly name: 'cycle'; readonly type: 'int' },
    { readonly name: 'capture'; readonly model: 'sales_attribution.Capture'; readonly nullable: true },
  ];
  readonly sites: {
    readonly header: readonly [TermDecisionSite, TermDecisionSite, TermDecisionSite];
    readonly captureIf: TermDecisionSite;
    readonly locationFirst: TermDecisionSite;
    readonly captureRequires: readonly [TermDecisionSite, TermDecisionSite];
    readonly renewalFirst: TermDecisionSite;
    readonly previousRequire: TermDecisionSite;
    readonly createIf: TermDecisionSite;
    readonly create: TermDecisionSite & { readonly model: 'member_terms.Renewal' };
    readonly schedule: TermDecisionSite & { readonly event: 'member_terms.RenewalDue' };
  };
  readonly membershipSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string;
    readonly stage: 'header' | 'capture' | 'renewal';
    readonly model: 'employee.Employee' | 'customer.CompanyRole' | 'sales_attribution.Capture' | 'member_terms.Renewal';
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node'];
    readonly predicateSite: TermDecisionSite['node'];
    readonly domainKind: 'tenant-root' | 'contained-child';
    readonly ownerPath: readonly string[];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
    readonly order: readonly string[];
  }[];
}
export function checkTermDecisionPlan(value: unknown, transport: unknown): TermDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'parameters', 'sites', 'membershipSite', 'querySites']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as { path: string; sha256: string; module: string };
  const carrier = transport as { path: string; sha256: string; module: string };
  if (raw['version'] !== 1 || raw['owner'] !== 'member_terms.term' ||
      source.module !== 'member_terms' || source.path !== carrier.path || source.sha256 !== carrier.sha256) {
    return invalid('term decision requires its exact owning source.');
  }
  const parameters = list(raw['parameters']);
  if (parameters.length !== 3 ||
      stableStringify(parameters) !== stableStringify([
        { name: 'membership', model: 'member_terms.Membership', nullable: false },
        { name: 'cycle', type: 'int' },
        { name: 'capture', model: 'sales_attribution.Capture', nullable: true },
      ])) return invalid('term decision requires its exact three admitted inputs.');
  const checkedSpan = checkedSyntaxIntervals('term decision requires its nonempty original syntax interval.');
  const checkedSite = (value: unknown, own: boolean, extra: readonly string[] = []): void => {
    const site = object(value, ['id', 'source', 'node', 'statement', ...extra]);
    if (!/^[a-f0-9]{64}$/.test(text(site['id']))) return invalid('term decision requires a checked site identity.');
    origin(site['source']);
    if (own && stableStringify(site['source']) !== stableStringify(raw['source'])) {
      return invalid('term decision source site differs from its owning scenario.');
    }
    checkedSpan(site['node']); checkedSpan(site['statement']);
  };
  const sites = object(raw['sites'], ['header', 'captureIf', 'locationFirst', 'captureRequires',
    'renewalFirst', 'previousRequire', 'createIf', 'create', 'schedule']);
  const header = list(sites['header']), captureRequires = list(sites['captureRequires']);
  if (header.length !== 3 || captureRequires.length !== 2) return invalid('term decision requires every authored guard.');
  for (const site of [...header, ...captureRequires,
    ...['captureIf', 'locationFirst', 'renewalFirst', 'previousRequire', 'createIf'].map(key => sites[key])]) {
    checkedSite(site, true);
  }
  checkedSite(sites['create'], true, ['model']);
  if (object(sites['create'], ['id', 'source', 'node', 'statement', 'model'])['model'] !== 'member_terms.Renewal') {
    return invalid('term create must target its checked Renewal.');
  }
  checkedSite(sites['schedule'], true, ['event']);
  if (object(sites['schedule'], ['id', 'source', 'node', 'statement', 'event'])['event'] !== 'member_terms.RenewalDue') {
    return invalid('term schedule must target its checked RenewalDue event.');
  }
  checkedSite(raw['membershipSite'], true);
  const queries = list(raw['querySites']);
  const shapes = [
    { stage: 'header', model: 'employee.Employee', domainKind: 'tenant-root', ownerPath: [], order: [] },
    { stage: 'header', model: 'customer.CompanyRole', domainKind: 'contained-child', ownerPath: ['parent'], order: [] },
    { stage: 'capture', model: 'sales_attribution.Capture', domainKind: 'contained-child', ownerPath: ['parent'],
      order: ['-captured', 'id'] },
    { stage: 'renewal', model: 'member_terms.Renewal', domainKind: 'contained-child', ownerPath: [], order: ['id'] },
  ];
  if (queries.length !== shapes.length) return invalid('term decision requires its four complete owner domains.');
  for (const [index, value] of queries.entries()) {
    const query = object(value, ['id', 'stage', 'model', 'source', 'callSite', 'aliasSite', 'predicateSite',
      'domainKind', 'ownerPath', 'deriveChain', 'order']);
    if (!/^[a-f0-9]{64}$/.test(text(query['id']))) return invalid('term query requires its checked identity.');
    const shape = shapes[index]!;
    if (stableStringify({ stage: query['stage'], model: query['model'], domainKind: query['domainKind'],
      ownerPath: query['ownerPath'], order: query['order'] }) !==
        stableStringify(shape)) return invalid('term decision query differs from its original domain and order.');
    origin(query['source']); checkedSpan(query['callSite']); checkedSpan(query['aliasSite']); checkedSpan(query['predicateSite']);
    const chain = list(query['deriveChain']);
    if (chain.length > 8 || (index === 3 ? chain.length !== 0 : chain.length === 0)) {
      return invalid('term decision query needs its bounded original helper path.');
    }
    for (const step of chain) {
      const item = object(step, ['source', 'callSite', 'derive']);
      origin(item['source']); checkedSpan(item['callSite']); text(item['derive']);
    }
  }
  return deepFreeze(raw) as unknown as TermDecisionPlan;
}

export interface LeaveRequestDecisionPlan {
  readonly version: 1;
  readonly owner: 'leave.request';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly sites: {
    readonly header: readonly [TermDecisionSite, TermDecisionSite, TermDecisionSite];
    readonly policyFirst: TermDecisionSite;
    readonly policyRequire: TermDecisionSite;
    readonly selectedDays: TermDecisionSite;
    readonly selectedRequire: TermDecisionSite;
    readonly requestCreate: TermDecisionSite & { readonly model: 'leave.Request' };
    readonly yearLoop: TermDecisionSite & { readonly limit: 10 };
    readonly allowanceFirst: TermDecisionSite;
    readonly allowanceRequire: TermDecisionSite;
    readonly portionCreate: TermDecisionSite & { readonly model: 'leave.Portion' };
  };
  readonly membershipSite: TermDecisionSite;
  readonly roleSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string;
    readonly stage: 'header' | 'body' | 'year';
    readonly model: ModelName;
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node'];
    readonly predicateSite: TermDecisionSite['node'];
    readonly domainKind: 'team' | 'child';
    readonly ownerPath: readonly string[];
    readonly order: readonly string[];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
  }[];
}
export function checkLeaveRequestDecisionPlan(value: unknown, transport: unknown): LeaveRequestDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'sites', 'membershipSite', 'roleSite', 'querySites']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as { path: string; sha256: string; module: string };
  const carrier = transport as { path: string; sha256: string; module: string };
  if (raw['version'] !== 1 || raw['owner'] !== 'leave.request' || source.module !== 'leave' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256) {
    return invalid('leave request decision requires its exact owning source.');
  }
  const checkedSpan = checkedSyntaxIntervals('leave request decision requires a nonempty checked syntax interval.');
  const checkedSite = (value: unknown, extra: readonly string[] = []): void => {
    const site = object(value, ['id', 'source', 'node', 'statement', ...extra]);
    if (!/^[a-f0-9]{64}$/.test(text(site['id']))) return invalid('leave request decision needs a checked site identity.');
    origin(site['source']); checkedSpan(site['node']); checkedSpan(site['statement']);
    if (stableStringify(site['source']) !== stableStringify(raw['source'])) {
      return invalid('leave request site differs from its original source.');
    }
  };
  const sites = object(raw['sites'], ['header', 'policyFirst', 'policyRequire', 'selectedDays',
    'selectedRequire', 'requestCreate', 'yearLoop', 'allowanceFirst', 'allowanceRequire', 'portionCreate']);
  const header = list(sites['header']);
  if (header.length !== 3) return invalid('leave request requires its three original header guards.');
  for (const site of [...header, ...['policyFirst', 'policyRequire', 'selectedDays', 'selectedRequire',
    'allowanceFirst', 'allowanceRequire'].map(key => sites[key]), raw['membershipSite'], raw['roleSite']]) checkedSite(site);
  checkedSite(sites['requestCreate'], ['model']);
  checkedSite(sites['portionCreate'], ['model']);
  checkedSite(sites['yearLoop'], ['limit']);
  if ((sites['requestCreate'] as { model: unknown }).model !== 'leave.Request' ||
      (sites['portionCreate'] as { model: unknown }).model !== 'leave.Portion' ||
      (sites['yearLoop'] as { limit: unknown }).limit !== 10) {
    return invalid('leave request requires its exact bounded Request and Portion effects.');
  }
  const queries = list(raw['querySites']);
  const shapes = [
    { stage: 'header', model: 'employee.Employee', domainKind: 'team', ownerPath: [], order: [] },
    { stage: 'header', model: 'leave.Request', domainKind: 'child', ownerPath: ['calendar'], order: [] },
    { stage: 'header', model: 'leave.Day', domainKind: 'child', ownerPath: ['calendar'], order: [] },
    { stage: 'body', model: 'leave.Category', domainKind: 'child', ownerPath: ['calendar'], order: ['category.id'] },
    { stage: 'body', model: 'leave.Day', domainKind: 'child', ownerPath: ['calendar'], order: [] },
    { stage: 'year', model: 'leave.Allowance', domainKind: 'child', ownerPath: ['calendar', 'parent'], order: ['allowance.id'] },
  ];
  if (queries.length !== shapes.length) return invalid('leave request requires all six original collection sites.');
  for (const [index, value] of queries.entries()) {
    const query = object(value, ['id', 'stage', 'model', 'source', 'callSite', 'aliasSite', 'predicateSite',
      'domainKind', 'ownerPath', 'order', 'deriveChain']);
    if (!/^[a-f0-9]{64}$/.test(text(query['id'])) ||
        stableStringify({ stage: query['stage'], model: query['model'], domainKind: query['domainKind'],
          ownerPath: query['ownerPath'], order: query['order'] }) !== stableStringify(shapes[index])) {
      return invalid('leave request query differs from its original model, owner path or order.');
    }
    origin(query['source']); checkedSpan(query['callSite']); checkedSpan(query['aliasSite']); checkedSpan(query['predicateSite']);
    const chain = list(query['deriveChain']);
    if (chain.length !== (index === 0 ? 1 : 0)) return invalid('leave request query differs from its original helper path.');
    for (const step of chain) {
      const item = object(step, ['source', 'callSite', 'derive']);
      origin(item['source']); checkedSpan(item['callSite']); text(item['derive']);
    }
  }
  return deepFreeze(raw) as unknown as LeaveRequestDecisionPlan;
}

export interface LeaveDecideDecisionPlan {
  readonly version: 1;
  readonly owner: 'leave.decide';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly sites: {
    readonly header: TermDecisionSite;
    readonly revisionLet: TermDecisionSite;
    readonly approveIf: TermDecisionSite;
    readonly portionRequire: TermDecisionSite;
    readonly approvedSet: TermDecisionSite & { readonly model: 'leave.Request' };
    readonly send: TermDecisionSite;
    readonly deliverySet: TermDecisionSite & { readonly model: 'leave.Request' };
    readonly rejectedSet: TermDecisionSite & { readonly model: 'leave.Request' };
  };
  readonly membershipSite: TermDecisionSite;
  readonly roleSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string;
    readonly stage: 'header' | 'approve' | 'allowance';
    readonly model: ModelName;
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node'];
    readonly predicateSite: TermDecisionSite['node'];
    readonly domainKind: 'team' | 'child' | 'global';
    readonly ownerPath: readonly string[];
    readonly order: readonly string[];
    readonly aggregate?: 'sum';
    readonly selectionSite?: TermDecisionSite['node'];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
  }[];
  readonly sendRule: { readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source'];
    readonly node: TermDecisionSite['node']; readonly statement: TermDecisionSite['statement'] };
}

export function checkLeaveDecideDecisionPlan(value: unknown, transport: unknown): LeaveDecideDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'sites', 'querySites', 'membershipSite', 'roleSite', 'sendRule']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as { path: string; sha256: string; module: string };
  const carrier = transport as { path: string; sha256: string; module: string };
  if (raw['version'] !== 1 || raw['owner'] !== 'leave.decide' || source.module !== 'leave' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256) {
    return invalid('leave decision requires its exact owning source.');
  }
  const checkedSpan = checkedSyntaxIntervals('leave decision requires a nonempty checked syntax interval.');
  const checkedSite = (value: unknown, extra: readonly string[] = []): void => {
    const site = object(value, ['id', 'source', 'node', 'statement', ...extra]);
    if (!/^[a-f0-9]{64}$/.test(text(site['id']))) return invalid('leave decision needs a checked site identity.');
    origin(site['source']); checkedSpan(site['node']); checkedSpan(site['statement']);
    if (stableStringify(site['source']) !== stableStringify(raw['source'])) {
      return invalid('leave decision site differs from its original source.');
    }
  };
  const sites = object(raw['sites'], ['header', 'revisionLet', 'approveIf', 'portionRequire',
    'approvedSet', 'send', 'deliverySet', 'rejectedSet']);
  for (const key of ['header', 'revisionLet', 'approveIf', 'portionRequire', 'send'] as const) checkedSite(sites[key]);
  for (const key of ['approvedSet', 'deliverySet', 'rejectedSet'] as const) {
    checkedSite(sites[key], ['model']);
    if ((sites[key] as { readonly model: unknown }).model !== 'leave.Request') {
      return invalid('leave decision SET requires its original Request target.');
    }
  }
  checkedSite(raw['membershipSite']);
  checkedSite(raw['roleSite']);
  const queries = list(raw['querySites']);
  const shapes = [
    { stage: 'header', model: 'employee.Employee', domainKind: 'team', ownerPath: [] },
    { stage: 'approve', model: 'leave.Portion', domainKind: 'child', ownerPath: ['request'] },
    { stage: 'allowance', model: 'leave.Portion', domainKind: 'global', ownerPath: [], aggregate: 'sum' },
  ];
  if (queries.length !== shapes.length) return invalid('leave decision requires its complete Employee and Portion domains.');
  for (const [index, value] of queries.entries()) {
    const query = object(value, ['id', 'stage', 'model', 'source', 'callSite', 'aliasSite',
      'predicateSite', 'domainKind', 'ownerPath', 'order', 'deriveChain',
      ...(index === 2 ? ['aggregate', 'selectionSite'] : [])]);
    if (!/^[a-f0-9]{64}$/.test(text(query['id'])) ||
        stableStringify({ stage: query['stage'], model: query['model'], domainKind: query['domainKind'],
          ownerPath: query['ownerPath'], order: query['order'],
          ...(index === 2 ? { aggregate: query['aggregate'] } : {}) }) !==
          stableStringify({ ...shapes[index], order: [] })) {
      return invalid('leave decision query differs from its original owner domain.');
    }
    origin(query['source']); checkedSpan(query['callSite']); checkedSpan(query['aliasSite']); checkedSpan(query['predicateSite']);
    if (index === 2) checkedSpan(query['selectionSite']);
    const chain = list(query['deriveChain']);
    if (chain.length !== (index === 1 ? 0 : 1)) return invalid('leave decision query lacks its exact helper chain.');
    for (const step of chain) {
      const item = object(step, ['source', 'callSite', 'derive']);
      origin(item['source']); checkedSpan(item['callSite']); text(item['derive']);
    }
  }
  const sendRule = object(raw['sendRule'], ['rule', 'source', 'node', 'statement']);
  text(sendRule['rule']); origin(sendRule['source']); checkedSpan(sendRule['node']); checkedSpan(sendRule['statement']);
  if (stableStringify(sendRule['source']) !== stableStringify(raw['source']) ||
      stableStringify(sendRule['node']) !== stableStringify((sites['send'] as TermDecisionSite).node) ||
      stableStringify(sendRule['statement']) !== stableStringify((sites['send'] as TermDecisionSite).statement)) {
    return invalid('leave decision SEND Rule differs from its original guarded occurrence.');
  }
  return deepFreeze(raw) as unknown as LeaveDecideDecisionPlan;
}

export interface ReferRejectDecisionPlan {
  readonly version: 1;
  readonly owner: 'refer.reject_source';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly sites: {
    readonly header: TermDecisionSite;
    readonly set: TermDecisionSite & { readonly model: 'refer.SourceEvidence' };
    readonly first: TermDecisionSite;
    readonly createIf: TermDecisionSite;
    readonly absence: TermDecisionSite;
    readonly create: TermDecisionSite & { readonly model: 'refer.Credit' };
  };
  readonly roleSite: TermDecisionSite;
  readonly membershipSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string;
    readonly stage: 'header' | 'first' | 'absence';
    readonly model: 'employee.Employee' | 'refer.Credit';
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly queryNode: TermDecisionSite['node'];
    readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node'];
    readonly predicateSite: TermDecisionSite['node'];
    readonly domainKind: 'team' | 'child';
    readonly ownerPath: readonly string[];
    readonly order: readonly string[];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
  }[];
}

/** The original CanMember retry has one guarded charge followed by one Term SET. */
export interface MemberRetryDecisionPlan {
  readonly version: 1;
  readonly owner: 'member_terms.retry_collection';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly parameters: readonly [{ readonly name: 'term'; readonly model: 'member_terms.Term'; readonly nullable: false }];
  readonly sites: {
    readonly header: readonly [TermDecisionSite, TermDecisionSite];
    readonly locationFirst: TermDecisionSite;
    readonly locationRequire: TermDecisionSite;
    readonly send: TermDecisionSite;
    readonly set: TermDecisionSite & { readonly model: 'member_terms.Term' };
  };
  readonly roleSite: TermDecisionSite;
  readonly membershipSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string;
    readonly stage: 'header';
    readonly model: 'employee.Employee' | 'customer.CompanyRole';
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly queryNode: TermDecisionSite['node'];
    readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node'];
    readonly predicateSite: TermDecisionSite['node'];
    readonly domainKind: 'tenant-root' | 'contained-child';
    readonly ownerPath: readonly string[];
    readonly order: readonly string[];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
  }[];
  readonly sendRule: { readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source'];
    readonly node: TermDecisionSite['node']; readonly statement: TermDecisionSite['statement'] };
}
export function checkMemberRetryDecisionPlan(value: unknown, transport: unknown): MemberRetryDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'parameters', 'sites', 'roleSite', 'membershipSite', 'querySites', 'sendRule']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as { path: string; sha256: string; module: string };
  const carrier = transport as { readonly path: string; readonly sha256: string };
  if (raw['version'] !== 1 || raw['owner'] !== 'member_terms.retry_collection' || source.module !== 'member_terms' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256 ||
      stableStringify(list(raw['parameters'])) !== stableStringify([
        { name: 'term', model: 'member_terms.Term', nullable: false },
      ])) return invalid('member retry requires its exact owning source and Term input.');
  const span = checkedSyntaxIntervals('member retry needs a nonempty checked source interval.');
  const { ids, site } = decisionSourceSites(source, span, 'member retry site differs from its checked source identity.', 'identity');
  const sites = object(raw['sites'], ['header', 'locationFirst', 'locationRequire', 'send', 'set']);
  const header = list(sites['header']);
  if (header.length !== 2) return invalid('member retry needs both original Requires.');
  for (const entry of header) site(entry);
  site(sites['locationFirst']); site(sites['locationRequire']); site(sites['send']); site(sites['set'], ['model']);
  if ((sites['set'] as { readonly model: unknown }).model !== 'member_terms.Term') {
    return invalid('member retry SET needs its original Term target.');
  }
  const ordered = [...header, sites['locationFirst'], sites['locationRequire'], sites['send'], sites['set']] as TermDecisionSite[];
  if (ordered.some((item, index) => {
    const statement = item.statement;
    return item.node.start < statement.start || item.node.end > statement.end ||
      index > 0 && statement.start < ordered[index - 1]!.statement.end;
  })) return invalid('member retry sites differ from the original Requires, FIRST, SEND, SET order.');
  site(raw['roleSite']); site(raw['membershipSite']);
  const queries = list(raw['querySites']);
  if (queries.length !== 2) return invalid('member retry needs its Employee and CompanyRole domains.');
  for (const [index, value] of queries.entries()) {
    const item = object(value, ['id', 'stage', 'model', 'source', 'queryNode', 'callSite', 'aliasSite',
      'predicateSite', 'domainKind', 'ownerPath', 'order', 'deriveChain']);
    const id = text(item['id']); origin(item['source']);
    span(item['queryNode']); span(item['callSite']); span(item['aliasSite']); span(item['predicateSite']);
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id) || item['stage'] !== 'header' ||
        stableStringify({ model: item['model'], domainKind: item['domainKind'], ownerPath: item['ownerPath'], order: item['order'] }) !==
          stableStringify(index === 0 ? { model: 'employee.Employee', domainKind: 'tenant-root', ownerPath: [], order: [] } :
            { model: 'customer.CompanyRole', domainKind: 'contained-child', ownerPath: ['parent'], order: [] })) {
      return invalid('member retry query differs from its bounded source domain.');
    }
    ids.add(id);
    const querySource = item['source'] as { readonly module: string; readonly path: string; readonly sha256: string };
    if (querySource.module !== (index === 0 ? 'employee' : 'customer')) {
      return invalid('member retry query differs from its original helper module.');
    }
    const chain = list(item['deriveChain']);
    if (chain.length !== 1) return invalid('member retry query needs its original helper chain.');
    const step = object(chain[0], ['source', 'callSite', 'derive']);
    origin(step['source']); span(step['callSite']);
    if (step['derive'] !== (index === 0 ? 'employee.can_work' : 'customer.has_role') ||
        stableStringify(step['source']) !== stableStringify(source)) {
      return invalid('member retry query differs from its original helper.');
    }
  }
  const rule = object(raw['sendRule'], ['rule', 'source', 'node', 'statement']);
  text(rule['rule']); origin(rule['source']); span(rule['node']); span(rule['statement']);
  if (stableStringify(rule['source']) !== stableStringify(source) ||
      stableStringify(rule['node']) !== stableStringify((sites['send'] as TermDecisionSite).node) ||
      stableStringify(rule['statement']) !== stableStringify((sites['send'] as TermDecisionSite).statement)) {
    return invalid('member retry SEND lacks its original guarded occurrence.');
  }
  return deepFreeze(raw) as unknown as MemberRetryDecisionPlan;
}

export function checkReferRejectDecisionPlan(value: unknown, transport: unknown): ReferRejectDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'sites', 'roleSite', 'membershipSite', 'querySites']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as { path: string; sha256: string; module: string };
  const carrier = transport as { path: string; sha256: string; module: string };
  if (raw['version'] !== 1 || raw['owner'] !== 'refer.reject_source' || source.module !== 'refer' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256) {
    return invalid('referral rejection needs its exact owning source.');
  }
  const span = checkedSyntaxIntervals('referral rejection needs a nonempty checked source interval.');
  const site = (value: unknown, extra: readonly string[] = []): void => {
    const item = object(value, ['id', 'source', 'node', 'statement', ...extra]);
    if (!/^[a-f0-9]{64}$/.test(text(item['id'])) ||
        stableStringify(item['source']) !== stableStringify(raw['source'])) {
      return invalid('referral rejection site differs from its checked source identity.');
    }
    span(item['node']); span(item['statement']);
  };
  const sites = object(raw['sites'], ['header', 'set', 'first', 'createIf', 'absence', 'create']);
  for (const name of ['header', 'first', 'createIf', 'absence'] as const) site(sites[name]);
  site(sites['set'], ['model']); site(sites['create'], ['model']);
  if ((sites['set'] as { model: unknown }).model !== 'refer.SourceEvidence' ||
      (sites['create'] as { model: unknown }).model !== 'refer.Credit') {
    return invalid('referral rejection requires its original evidence and reversal targets.');
  }
  site(raw['roleSite']); site(raw['membershipSite']);
  const queries = list(raw['querySites']);
  if (queries.length !== 3) return invalid('referral rejection requires its Employee and both Credit query sites.');
  for (const [index, value] of queries.entries()) {
    const query = object(value, ['id', 'stage', 'model', 'source', 'queryNode', 'callSite', 'aliasSite',
      'predicateSite', 'domainKind', 'ownerPath', 'order', 'deriveChain']);
    const header = index === 0;
    origin(query['source']);
    const querySource = query['source'] as { path: string; sha256: string; module: string };
    if (!/^[a-f0-9]{64}$/.test(text(query['id'])) ||
        querySource.path !== source.path || querySource.sha256 !== source.sha256 ||
        querySource.module !== (header ? 'employee' : 'refer') ||
        stableStringify({ stage: query['stage'], model: query['model'], domainKind: query['domainKind'],
          ownerPath: query['ownerPath'], order: query['order'] }) !==
          stableStringify(header ? { stage: 'header', model: 'employee.Employee', domainKind: 'team',
            ownerPath: [], order: [] } : { stage: index === 1 ? 'first' : 'absence', model: 'refer.Credit',
            domainKind: 'child', ownerPath: ['evidence', 'advocate'], order: index === 1 ? ['credit.id'] : [] })) {
      return invalid('referral rejection query differs from its exact source order or parent.');
    }
    span(query['queryNode']); span(query['callSite']); span(query['aliasSite']); span(query['predicateSite']);
    const chain = list(query['deriveChain']);
    if (chain.length !== (header ? 1 : 0)) return invalid('referral rejection query lacks its exact helper chain.');
    if (header) {
      const step = object(chain[0], ['source', 'callSite', 'derive']);
      origin(step['source']); span(step['callSite']);
      if (step['derive'] !== 'employee.can_work' ||
          stableStringify(step['source']) !== stableStringify(raw['source'])) {
        return invalid('referral rejection needs its original Employee helper.');
      }
    }
  }
  return deepFreeze(raw) as unknown as ReferRejectDecisionPlan;
}

/** Exact authored collection and effect occurrences of the movement refund. */
export interface RentMovementRefundDecisionPlan {
  readonly version: 1;
  readonly owner: 'rent_reservations.refund_movement_credit';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly parameters: readonly [
    { readonly name: 'movement'; readonly type: 'rent_reservations.Movement' },
    { readonly name: 'charge_source'; readonly type: 'text' },
    { readonly name: 'amount'; readonly type: 'money' },
    { readonly name: 'reason'; readonly type: 'text' },
  ];
  readonly sites: {
    readonly header: TermDecisionSite; readonly remaining: TermDecisionSite;
    readonly branch: TermDecisionSite; readonly adjustmentFirst: TermDecisionSite;
    readonly bookingSend: TermDecisionSite & { readonly operation: 'invoice.BillingV1.refund' };
    readonly bookingCreate: TermDecisionSite & { readonly model: 'rent_reservations.MovementCredit' };
    readonly adjustmentSend: TermDecisionSite & { readonly operation: 'invoice.BillingV1.refund' };
    readonly adjustmentCreate: TermDecisionSite & { readonly model: 'rent_reservations.MovementCredit' };
    readonly bookingBaseline: TermDecisionSite; readonly adjustmentBaseline: TermDecisionSite;
  };
  readonly roleSite: TermDecisionSite;
  readonly membershipSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string; readonly stage: 'header' | 'remaining' | 'adjustment' | 'baseline';
    readonly model: 'employee.Employee' | 'rent_reservations.MovementCredit' | 'rent_reservations.Adjustment';
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly queryNode: TermDecisionSite['node']; readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node']; readonly predicateSite: TermDecisionSite['node'];
    readonly domainKind: 'team' | 'child'; readonly ownerPath: readonly string[];
    readonly order: readonly string[];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
  }[];
}
export function checkRentMovementRefundDecisionPlan(value: unknown, transport: unknown): RentMovementRefundDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'parameters', 'sites', 'roleSite', 'membershipSite', 'querySites']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as ScenarioResultDisclosurePlan['source'];
  const carrier = transport as ScenarioResultDisclosurePlan['source'];
  if (raw['version'] !== 1 || raw['owner'] !== 'rent_reservations.refund_movement_credit' ||
      source.module !== 'rent_reservations' || source.path !== carrier.path || source.sha256 !== carrier.sha256 ||
      stableStringify(list(raw['parameters'])) !== stableStringify([
        { name: 'movement', type: 'rent_reservations.Movement' }, { name: 'charge_source', type: 'text' },
        { name: 'amount', type: 'money' }, { name: 'reason', type: 'text' },
      ])) return invalid('movement refund needs its exact owning source and four inputs.');
  const span = checkedSyntaxIntervals('movement refund requires nonempty checked source intervals.');
  const { ids, site } = decisionSourceSites(source, span, 'movement refund site differs from its checked source.', 'contained');
  const sites = object(raw['sites'], ['header', 'remaining', 'branch', 'adjustmentFirst',
    'bookingSend', 'bookingCreate', 'adjustmentSend', 'adjustmentCreate',
    'bookingBaseline', 'adjustmentBaseline']);
  const checkedSites = Object.fromEntries(Object.entries(sites).map(([name, value]) => [name,
    site(value, name.endsWith('Send') ? { key: 'operation', value: 'invoice.BillingV1.refund' } :
      name.endsWith('Create') ? { key: 'model', value: 'rent_reservations.MovementCredit' } : undefined)])) as
    Record<keyof RentMovementRefundDecisionPlan['sites'], TermDecisionSite>;
  site(raw['roleSite']); site(raw['membershipSite']);
  if (checkedSites.header.statement.end > checkedSites.remaining.statement.start ||
      checkedSites.remaining.statement.end > checkedSites.branch.statement.start ||
      checkedSites.branch.statement.start > checkedSites.bookingSend.statement.start ||
      checkedSites.bookingSend.statement.end > checkedSites.bookingCreate.statement.start ||
      checkedSites.adjustmentFirst.statement.start > checkedSites.adjustmentSend.statement.start ||
      checkedSites.adjustmentSend.statement.end > checkedSites.adjustmentCreate.statement.start) {
    return invalid('movement refund source sites are out of original order.');
  }
  const queries = list(raw['querySites']);
  if (queries.length !== 4) return invalid('movement refund needs its four complete original query sites.');
  const expected = [
    { stage: 'header', model: 'employee.Employee', domainKind: 'team', ownerPath: [], derive: 'employee.can_work' },
    { stage: 'remaining', model: 'rent_reservations.MovementCredit', domainKind: 'child', ownerPath: ['movement'], derive: null },
    { stage: 'adjustment', model: 'rent_reservations.Adjustment', domainKind: 'child', ownerPath: ['movement', 'parent'], derive: null },
    { stage: 'baseline', model: 'rent_reservations.MovementCredit', domainKind: 'team', ownerPath: [], derive: 'rent_reservations.credit_baseline' },
  ];
  for (const [index, value] of queries.entries()) {
    const item = object(value, ['id', 'stage', 'model', 'source', 'queryNode', 'callSite', 'aliasSite',
      'predicateSite', 'domainKind', 'ownerPath', 'order', 'deriveChain']);
    const id = text(item['id']); origin(item['source']);
    for (const field of ['queryNode', 'callSite', 'aliasSite', 'predicateSite']) span(item[field]);
    const want = expected[index]!;
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id) ||
        stableStringify({ stage: item['stage'], model: item['model'], domainKind: item['domainKind'],
          ownerPath: item['ownerPath'], order: item['order'] }) !==
          stableStringify({ stage: want.stage, model: want.model, domainKind: want.domainKind,
            ownerPath: want.ownerPath, order: [] })) {
      return invalid('movement refund query differs from its exact source domain.');
    }
    ids.add(id);
    const chain = list(item['deriveChain']);
    if (chain.length !== (want.derive === null ? 0 : 1)) {
      return invalid('movement refund query lacks its original helper call.');
    }
    if (want.derive !== null) {
      const step = object(chain[0], ['source', 'callSite', 'derive']);
      origin(step['source']); span(step['callSite']);
      if (step['derive'] !== want.derive ||
          stableStringify(step['source']) !== stableStringify(source)) {
        return invalid('movement refund query differs from its original helper.');
      }
    }
  }
  return deepFreeze(raw) as unknown as RentMovementRefundDecisionPlan;
}

export interface InvoiceCollectDecisionPlan {
  readonly version: 1;
  readonly owner: 'invoice.collect';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly parameters: readonly [{ readonly name: 'invoice'; readonly type: 'invoice.Invoice' }];
  readonly sites: {
    readonly header: readonly [TermDecisionSite, TermDecisionSite];
    readonly cancel: TermDecisionSite;
    readonly invoiceReset: TermDecisionSite & { readonly model: 'invoice.Invoice' };
    readonly createAttempt: TermDecisionSite & { readonly model: 'invoice.Attempt' };
    readonly send: TermDecisionSite & { readonly operation: 'std.PaymentsV1.collect' };
    readonly deliverySet: TermDecisionSite & { readonly model: 'invoice.Attempt' };
    readonly ledgerSet: TermDecisionSite & { readonly model: 'invoice.Invoice' };
    readonly settlementEmit: TermDecisionSite & { readonly event: 'invoice.InvoiceSettlement' };
  };
  readonly roleSite: TermDecisionSite;
  readonly membershipSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string;
    readonly stage: 'balanceCredits' | 'balanceReceivedAttempts' | 'balanceReceivedExternal' |
      'authorityRole' | 'authorityOwn' | 'authorityWork' | 'pendingAttempt' |
      'refundedAttempts' | 'refundedExternal' | 'settlementCollectionPending' | 'settlementRefundPending';
    readonly model: 'invoice.Credit' | 'invoice.Attempt' | 'invoice.ExternalPayment' |
      'invoice.ExternalRefund' | 'customer.CompanyRole' | 'customer.Contact' | 'employee.Employee';
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly queryNode: TermDecisionSite['node']; readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node']; readonly predicateSite: TermDecisionSite['node'] | null;
    readonly selectionSite: TermDecisionSite['node'] | null;
    readonly domainKind: 'child' | 'team'; readonly ownerPath: readonly string[];
    readonly order: readonly string[];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
  }[];
  readonly sendRule: { readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source'];
    readonly node: TermDecisionSite['node']; readonly statement: TermDecisionSite['statement'] };
}
export interface InvoiceIssueDecisionPlan {
  readonly version: 1;
  readonly owner: 'invoice.issue';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly parameters: readonly [{ readonly name: 'invoice'; readonly type: 'invoice.Invoice' },
    { readonly name: 'number'; readonly type: 'text' }];
  readonly sites: {
    readonly headers: readonly [TermDecisionSite, TermDecisionSite];
    readonly defaultsFirst: TermDecisionSite & { readonly model: 'invoice.Defaults' };
    readonly defaultsRequire: TermDecisionSite;
    readonly lineSum: TermDecisionSite & { readonly model: 'invoice.Line' };
    readonly invoiceSet: TermDecisionSite & { readonly model: 'invoice.Invoice' };
    readonly settlementEmit: TermDecisionSite & { readonly event: 'invoice.InvoiceSettlement' };
    readonly mailSend: TermDecisionSite & { readonly operation: 'std.EmailV1.send' };
    readonly overdueSchedule: TermDecisionSite & { readonly event: 'invoice.Overdue' };
  };
  readonly roleSite: TermDecisionSite;
  readonly querySites: readonly {
    readonly id: string;
    readonly stage: 'authorityWork' | 'lineCount' | 'numberUnique' | 'defaultsFirst' |
      'lineTotal' | 'balanceCredits' | 'balanceReceivedAttempts' | 'balanceReceivedExternal' |
      'refundedAttempts' | 'refundedExternal' | 'settlementCollectionPending' |
      'settlementRefundPending';
    readonly model: string;
    readonly source: ScenarioResultDisclosurePlan['source'];
    readonly queryNode: TermDecisionSite['node']; readonly callSite: TermDecisionSite['node'];
    readonly aliasSite: TermDecisionSite['node'] | null;
    readonly predicateSite: TermDecisionSite['node'] | null;
    readonly selectionSite: TermDecisionSite['node'] | null;
    readonly orderSite: TermDecisionSite['node'] | null;
    readonly domainKind: 'child' | 'team'; readonly ownerPath: readonly string[];
    readonly order: readonly string[];
    readonly deriveChain: readonly { readonly source: ScenarioResultDisclosurePlan['source'];
      readonly callSite: TermDecisionSite['node']; readonly derive: string }[];
  }[];
  readonly sendRule: { readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source'];
    readonly node: TermDecisionSite['node']; readonly statement: TermDecisionSite['statement'] };
}
export function checkInvoiceIssueDecisionPlan(value: unknown, transport: unknown): InvoiceIssueDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'parameters', 'sites', 'roleSite', 'querySites', 'sendRule']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as ScenarioResultDisclosurePlan['source'];
  const carrier = transport as ScenarioResultDisclosurePlan['source'];
  if (raw['version'] !== 1 || raw['owner'] !== 'invoice.issue' || source.module !== 'invoice' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256 ||
      stableStringify(list(raw['parameters'])) !== stableStringify([
        { name: 'invoice', type: 'invoice.Invoice' }, { name: 'number', type: 'text' }])) {
    return invalid('Invoice issue needs its exact owning source and two inputs.');
  }
  const span = checkedSyntaxIntervals('Invoice issue needs nonempty checked source intervals.');
  const { ids, site } = decisionSourceSites(source, span, 'Invoice issue site differs from its checked source.', 'contained');
  const sites = object(raw['sites'], ['headers', 'defaultsFirst', 'defaultsRequire', 'lineSum',
    'invoiceSet', 'settlementEmit', 'mailSend', 'overdueSchedule']);
  const headers = list(sites['headers']);
  if (headers.length !== 2) return invalid('Invoice issue needs both original header Requires.');
  for (const entry of headers) site(entry);
  site(sites['defaultsFirst'], { key: 'model', value: 'invoice.Defaults' });
  site(sites['defaultsRequire']);
  site(sites['lineSum'], { key: 'model', value: 'invoice.Line' });
  site(sites['invoiceSet'], { key: 'model', value: 'invoice.Invoice' });
  site(sites['settlementEmit'], { key: 'event', value: 'invoice.InvoiceSettlement' });
  site(sites['mailSend'], { key: 'operation', value: 'std.EmailV1.send' });
  site(sites['overdueSchedule'], { key: 'event', value: 'invoice.Overdue' });
  site(raw['roleSite']);
  const ordered = [...headers, sites['defaultsFirst'], sites['defaultsRequire'], sites['lineSum'],
    sites['invoiceSet'], sites['settlementEmit'], sites['mailSend'], sites['overdueSchedule']] as TermDecisionSite[];
  if (ordered.some((item, index) => index > 0 && item.statement.start < ordered[index - 1]!.statement.start)) {
    return invalid('Invoice issue sites differ from original Require and effect order.');
  }
  const expected = [
    ['authorityWork', 'employee.Employee', 'team', [], [], 'employee.can_work', false, false, true, true],
    ['lineCount', 'invoice.Line', 'child', ['invoice'], [], null, true, true, true, true],
    ['numberUnique', 'invoice.Invoice', 'team', [], [], null, false, false, true, true],
    ['defaultsFirst', 'invoice.Defaults', 'team', [], ['setting.id'], null, false, true, true, false],
    ['lineTotal', 'invoice.Line', 'child', ['invoice'], [], null, false, true, false, true],
    ['balanceCredits', 'invoice.Credit', 'child', ['invoice'], [], null, false, true, false, true],
    ['balanceReceivedAttempts', 'invoice.Attempt', 'child', ['invoice'], [], null, false, false, false, true],
    ['balanceReceivedExternal', 'invoice.ExternalPayment', 'child', ['invoice'], [], null, false, true, false, true],
    ['refundedAttempts', 'invoice.Attempt', 'child', ['invoice'], [], null, false, false, false, true],
    ['refundedExternal', 'invoice.ExternalRefund', 'child', ['invoice'], [], null, false, true, false, true],
    ['settlementCollectionPending', 'invoice.Attempt', 'child', ['invoice'], [], 'invoice.settlement', false, false, true, true],
    ['settlementRefundPending', 'invoice.Attempt', 'child', ['invoice'], [], 'invoice.settlement', false, false, true, true],
  ] as const;
  const queries = list(raw['querySites']);
  if (queries.length !== expected.length) return invalid('Invoice issue needs its complete source query census.');
  for (const [index, value] of queries.entries()) {
    const item = object(value, ['id', 'stage', 'model', 'source', 'queryNode', 'callSite', 'aliasSite',
      'predicateSite', 'selectionSite', 'orderSite', 'domainKind', 'ownerPath', 'order', 'deriveChain']);
    const [stage, model, domainKind, ownerPath, order, derive, aliasNull, predicateNull,
      selectionNull, orderNull] = expected[index]!;
    const id = text(item['id']); origin(item['source']);
    for (const key of ['queryNode', 'callSite'] as const) span(item[key]);
    for (const [key, shouldNull] of [['aliasSite', aliasNull], ['predicateSite', predicateNull],
      ['selectionSite', selectionNull], ['orderSite', orderNull]] as const) {
      if (shouldNull ? item[key] !== null : item[key] === null) {
        return invalid('Invoice issue query source interval differs from its original expression.');
      }
      if (!shouldNull) span(item[key]);
    }
    const querySource = item['source'] as ScenarioResultDisclosurePlan['source'];
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id) ||
        (stage !== 'authorityWork' && (querySource.path !== source.path ||
          querySource.sha256 !== source.sha256)) ||
        querySource.module !== (stage === 'authorityWork' ? 'employee' : 'invoice') ||
        stableStringify([item['stage'], item['model'], item['domainKind'], item['ownerPath'], item['order']]) !==
          stableStringify([stage, model, domainKind, ownerPath, order])) {
      return invalid('Invoice issue query differs from its bounded source domain.');
    }
    ids.add(id);
    const chain = list(item['deriveChain']);
    if (chain.length !== (derive === null ? 0 : 1)) return invalid('Invoice issue query lacks its original helper chain.');
    if (derive !== null) {
      const step = object(chain[0], ['source', 'callSite', 'derive']);
      origin(step['source']); span(step['callSite']);
      if (step['derive'] !== derive || stableStringify(step['source']) !== stableStringify(source)) {
        return invalid('Invoice issue query helper differs from its owning source.');
      }
    }
  }
  const rule = object(raw['sendRule'], ['rule', 'source', 'node', 'statement']);
  text(rule['rule']); origin(rule['source']); span(rule['node']); span(rule['statement']);
  if (stableStringify(rule['source']) !== stableStringify(source) ||
      stableStringify(rule['node']) !== stableStringify((sites['mailSend'] as TermDecisionSite).node) ||
      stableStringify(rule['statement']) !== stableStringify((sites['mailSend'] as TermDecisionSite).statement)) {
    return invalid('Invoice issue Mail SEND lacks its original guarded source occurrence.');
  }
  return deepFreeze(raw) as unknown as InvoiceIssueDecisionPlan;
}
export function checkInvoiceCollectDecisionPlan(value: unknown, transport: unknown): InvoiceCollectDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'parameters', 'sites',
    'roleSite', 'membershipSite', 'querySites', 'sendRule']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as ScenarioResultDisclosurePlan['source'];
  const carrier = transport as ScenarioResultDisclosurePlan['source'];
  if (raw['version'] !== 1 || raw['owner'] !== 'invoice.collect' || source.module !== 'invoice' ||
      source.path !== carrier.path || source.sha256 !== carrier.sha256 ||
      stableStringify(list(raw['parameters'])) !==
        stableStringify([{ name: 'invoice', type: 'invoice.Invoice' }])) {
    return invalid('Invoice collection needs its exact owning source and Invoice input.');
  }
  const span = checkedSyntaxIntervals('Invoice collection needs nonempty checked source intervals.');
  const { ids, site } = decisionSourceSites(source, span, 'Invoice collection site differs from its checked source.', 'contained');
  const sites = object(raw['sites'], ['header', 'cancel', 'invoiceReset', 'createAttempt',
    'send', 'deliverySet', 'ledgerSet', 'settlementEmit']);
  const header = list(sites['header']);
  if (header.length !== 2) return invalid('Invoice collection needs both original Requires.');
  for (const entry of header) site(entry);
  site(sites['cancel']);
  site(sites['invoiceReset'], { key: 'model', value: 'invoice.Invoice' });
  site(sites['createAttempt'], { key: 'model', value: 'invoice.Attempt' });
  site(sites['send'], { key: 'operation', value: 'std.PaymentsV1.collect' });
  site(sites['deliverySet'], { key: 'model', value: 'invoice.Attempt' });
  site(sites['ledgerSet'], { key: 'model', value: 'invoice.Invoice' });
  site(sites['settlementEmit'], { key: 'event', value: 'invoice.InvoiceSettlement' });
  site(raw['roleSite']); site(raw['membershipSite']);
  const ordered = [...header, sites['cancel'], sites['invoiceReset'], sites['createAttempt'],
    sites['send'], sites['deliverySet'], sites['ledgerSet'], sites['settlementEmit']] as TermDecisionSite[];
  if (ordered.some((item, index) => index > 0 && item.statement.start < ordered[index - 1]!.statement.start)) {
    return invalid('Invoice collection sites differ from original Require and effect order.');
  }
  const expected = [
    ['balanceCredits', 'invoice.Credit', 'child', ['invoice'], null, false],
    ['balanceReceivedAttempts', 'invoice.Attempt', 'child', ['invoice'], null, true],
    ['balanceReceivedExternal', 'invoice.ExternalPayment', 'child', ['invoice'], null, false],
    ['authorityRole', 'customer.CompanyRole', 'child', ['invoice', 'parent'], 'customer.has_role', true],
    ['authorityOwn', 'customer.Contact', 'child', ['invoice', 'parent'], 'customer.owns', true],
    ['authorityWork', 'employee.Employee', 'team', [], 'employee.can_work', true],
    ['pendingAttempt', 'invoice.Attempt', 'child', ['invoice'], null, true],
    ['refundedAttempts', 'invoice.Attempt', 'child', ['invoice'], null, true],
    ['refundedExternal', 'invoice.ExternalRefund', 'child', ['invoice'], null, false],
    ['settlementCollectionPending', 'invoice.Attempt', 'child', ['invoice'], 'invoice.settlement', true],
    ['settlementRefundPending', 'invoice.Attempt', 'child', ['invoice'], 'invoice.settlement', true],
  ] as const;
  const queries = list(raw['querySites']);
  if (queries.length !== expected.length) return invalid('Invoice collection needs its complete source query census.');
  for (const [index, value] of queries.entries()) {
    const item = object(value, ['id', 'stage', 'model', 'source', 'queryNode', 'callSite', 'aliasSite',
      'predicateSite', 'selectionSite', 'domainKind', 'ownerPath', 'order', 'deriveChain']);
    const [stage, model, domainKind, ownerPath, derive, predicate] = expected[index]!;
    const id = text(item['id']); origin(item['source']);
    for (const key of ['queryNode', 'callSite', 'aliasSite']) span(item[key]);
    if (predicate ? item['predicateSite'] === null : item['predicateSite'] !== null) {
      return invalid('Invoice collection query predicate differs from its original SUM or ANY.');
    }
    if (predicate) span(item['predicateSite']);
    if (index === 0 || index === 1 || index === 2 || index === 7 || index === 8) {
      span(item['selectionSite']);
    } else if (item['selectionSite'] !== null) {
      return invalid('Invoice collection query selection differs from its original SUM or ANY.');
    }
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id) ||
        stableStringify([item['stage'], item['model'], item['domainKind'], item['ownerPath'], item['order']]) !==
        stableStringify([stage, model, domainKind, ownerPath, []])) {
      return invalid('Invoice collection query differs from its bounded source domain.');
    }
    ids.add(id);
    const chain = list(item['deriveChain']);
    if (chain.length !== (derive === null ? 0 : 1)) {
      return invalid('Invoice collection query lacks its original helper chain.');
    }
    if (derive !== null) {
      const step = object(chain[0], ['source', 'callSite', 'derive']);
      origin(step['source']); span(step['callSite']);
      if (step['derive'] !== derive || stableStringify(step['source']) !== stableStringify(source)) {
        return invalid('Invoice collection query helper differs from its owning source.');
      }
    }
  }
  const rule = object(raw['sendRule'], ['rule', 'source', 'node', 'statement']);
  text(rule['rule']); origin(rule['source']); span(rule['node']); span(rule['statement']);
  if (stableStringify(rule['source']) !== stableStringify(source) ||
      stableStringify(rule['node']) !== stableStringify((sites['send'] as TermDecisionSite).node) ||
      stableStringify(rule['statement']) !== stableStringify((sites['send'] as TermDecisionSite).statement)) {
    return invalid('Invoice collection SEND lacks its original guarded source occurrence.');
  }
  return deepFreeze(raw) as unknown as InvoiceCollectDecisionPlan;
}

/** Exact private Work correspondence and reminder, including the sole
 * presentation-bearing Notice fields paired with each original Mail SEND. */
export interface RentNoticeDecisionPlan {
  readonly version: 1;
  readonly owner: 'rent_reservations.correspondence' | 'rent_reservations.remind';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly event: 'rent_reservations.ReservationChanged' | 'rent_reservations.Reminder';
  readonly sites: Readonly<Record<string, TermDecisionSite & { readonly operation?: string;
    readonly model?: string; readonly event?: string }>>;
  readonly sendRules: readonly { readonly kind: 'confirmation' | 'cancellation' | 'reminder';
    readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source'];
    readonly node: TermDecisionSite['node']; readonly statement: TermDecisionSite['statement'] }[];
}
export function checkRentNoticeDecisionPlan(value: unknown, transport: unknown): RentNoticeDecisionPlan {
  const raw = object(value, ['version', 'owner', 'source', 'event', 'sites', 'sendRules']);
  origin(raw['source']); origin(transport);
  const source = raw['source'] as ScenarioResultDisclosurePlan['source'];
  const owner = raw['owner'];
  const correspondence = owner === 'rent_reservations.correspondence';
  if (raw['version'] !== 1 || (!correspondence && owner !== 'rent_reservations.remind') ||
      raw['event'] !== (correspondence ? 'rent_reservations.ReservationChanged' : 'rent_reservations.Reminder') ||
      source.module !== 'rent_reservations' || source.path !== (transport as typeof source).path ||
      source.sha256 !== (transport as typeof source).sha256) {
    return invalid('Rent Notice needs its exact declared event and owning source.');
  }
  const keys = correspondence ? ['header', 'cancel', 'confirmedIf', 'confirmationSubject',
    'confirmationBody', 'confirmationSend', 'confirmationCreate', 'scheduleIf', 'schedule',
    'cancelledIf', 'cancellationSubject', 'cancellationBody', 'cancellationSend', 'cancellationCreate'] :
    ['header', 'reminderSubject', 'reminderBody', 'reminderSend', 'reminderCreate'];
  const sites = object(raw['sites'], keys);
  const ids = new Set<string>();
  let previous = -1;
  for (const key of keys) {
    const extra = key.endsWith('Send') ? ['operation', 'std.EmailV1.send'] :
      key.endsWith('Create') ? ['model', 'rent_reservations.Notice'] :
      key === 'schedule' ? ['event', 'rent_reservations.Reminder'] : null;
    const site = object(sites[key], ['id', 'source', 'node', 'statement', ...(extra === null ? [] : [extra[0]!])]);
    const node = object(site['node'], ['start', 'end', 'kind']);
    const statement = object(site['statement'], ['start', 'end', 'kind']);
    const id = text(site['id']); origin(site['source']);
    for (const span of [node, statement]) {
      if (!Number.isSafeInteger(span['start']) || !Number.isSafeInteger(span['end']) ||
          !Number.isSafeInteger(span['kind']) || (span['start'] as number) < 0 ||
          (span['end'] as number) <= (span['start'] as number) || (span['kind'] as number) < 0) {
        return invalid('Rent Notice site lacks a checked source interval.');
      }
    }
    if (!/^[a-f0-9]{64}$/.test(id) || ids.has(id) ||
        stableStringify(site['source']) !== stableStringify(source) ||
        (node['start'] as number) < (statement['start'] as number) ||
        (node['end'] as number) > (statement['end'] as number) ||
        (statement['start'] as number) < previous ||
        extra !== null && site[extra[0]!] !== extra[1]) {
      return invalid('Rent Notice site differs from its original effect order.');
    }
    ids.add(id); previous = statement['start'] as number;
  }
  const expected = correspondence ? [['confirmation', 'confirmationSend'], ['cancellation', 'cancellationSend']] :
    [['reminder', 'reminderSend']];
  const rules = list(raw['sendRules']);
  if (rules.length !== expected.length) return invalid('Rent Notice needs its complete SEND Rule census.');
  for (const [index, value] of rules.entries()) {
    const item = object(value, ['kind', 'rule', 'source', 'node', 'statement']);
    const [kind, siteKey] = expected[index]!;
    const send = sites[siteKey!]! as TermDecisionSite;
    if (item['kind'] !== kind || typeof item['rule'] !== 'string' || item['rule'] === '' ||
        stableStringify(item['source']) !== stableStringify(source) ||
        stableStringify(item['node']) !== stableStringify(send.node) ||
        stableStringify(item['statement']) !== stableStringify(send.statement)) {
      return invalid('Rent Notice SEND Rule differs from its exact original source.');
    }
  }
  return deepFreeze(raw) as unknown as RentNoticeDecisionPlan;
}

function checkSourceLoops(value:unknown,source:unknown):NonNullable<ScenarioResultDisclosurePlan['sourceLoops']> {
  const span=(value:unknown):{readonly start:number;readonly end:number}=>{const node=object(value,['start','end']);
    if(!Number.isSafeInteger(node['start'])||!Number.isSafeInteger(node['end'])||
        (node['start'] as number)<0||(node['end'] as number)<=(node['start'] as number))return invalid('Source loop needs exact nonempty original spans.');
    return node as unknown as {readonly start:number;readonly end:number};};
  const raw=object(dataCopy(value),['source','owner','loops']); origin(raw['source']);
  if(stableStringify(raw['source'])!==stableStringify(source))return invalid('Source loop origin differs from its owner.');
  text(raw['owner']); const loops=list(raw['loops']); const ids=new Set<string>(); let total=0;
  if(loops.length===0)return invalid('Source loop inventory must be complete and nonempty.');
  for(const entry of loops){
    const loop=object(entry,['id','node','domain','maximum','parameter','parentModel','model','filtered',...(typeof entry==='object'&&entry!==null&&Object.hasOwn(entry,'copy')?['copy']:[])]);
    const id=text(loop['id']),node=span(loop['node']),domain=span(loop['domain']);
    if(domain.start<node.start||domain.end>node.end)return invalid('Source loop domain left its original statement.');
    for(const key of ['parameter','parentModel','model'])text(loop[key]);
    if(typeof loop['filtered']!=='boolean')return invalid('Source loop original filter marker is required.');
    if(Object.hasOwn(loop,'copy')){
      const copy=object(loop['copy'],['node','call','parent','model','target','fields']);
      const created=span(copy['node']),called=span(copy['call']);
      if(loop['filtered']!==false||created.start<node.start||created.end>node.end||called.end>node.start
          ||text(copy['model'])!==loop['model'])return invalid('Source copy requires its original contained constructor and earlier child.');
      text(copy['parent']);text(copy['target']);const fields=list(copy['fields']),names=new Set<string>();
      if(fields.length===0)return invalid('Source copy retains every scalar constructor slot.');
      for(const entry of fields){const field=object(entry,['name','type','node']),name=text(field['name']),at=span(field['node']);
        if(name==='parent'||names.has(name)||at.start<created.start||at.end>created.end
            ||!['int','text','email','bool','decimal','money','date','datetime','duration','currency'].includes(text(field['type'])))return invalid('Source copy requires unique original scalar fields.');
        names.add(name);
      }
    }
    const maximum=loop['maximum'];
    if(!/^[a-f0-9]{64}$/.test(id)||ids.has(id)||!Number.isSafeInteger(maximum)||
        (maximum as number)<1||(maximum as number)>200)return invalid('Source loop identity or finite bound is invalid.');
    ids.add(id);total+=maximum as number;
  }
  if(total>200)return invalid('Source loop complete domain inventory exceeds its finite budget.');
  return deepFreeze(raw) as unknown as NonNullable<ScenarioResultDisclosurePlan['sourceLoops']>;
}

/** A finite source loop inventory is a budget and correspondence fence,
 * never an independent owner scan or event producer. */
export function checkSourceEmissions(value:unknown,source:unknown):NonNullable<ScenarioResultDisclosurePlan['sourceEmissions']> {
  const span=(value:unknown):{readonly start:number;readonly end:number}=>{const node=object(value,['start','end']);
    if(!Number.isSafeInteger(node['start'])||!Number.isSafeInteger(node['end'])||
        (node['start'] as number)<0||(node['end'] as number)<=(node['start'] as number))return invalid('Source loop needs exact nonempty original spans.');
    return node as unknown as {readonly start:number;readonly end:number};};
  const raw=object(dataCopy(value),['source','owner','loops']); origin(raw['source']);
  if(stableStringify(raw['source'])!==stableStringify(source))return invalid('Source loop origin differs from its owner.');
  text(raw['owner']); const loops=list(raw['loops']); const ids=new Set<string>(); let total=0;
  if(loops.length===0)return invalid('Source loop inventory must be complete and nonempty.');
  for(const entry of loops){
    const loop=object(entry,['id','node','domain','maximum','parameter','parentModel','model','event','handler']);
    const id=text(loop['id']),node=span(loop['node']),domain=span(loop['domain']);
    if(domain.start<node.start||domain.end>node.end)return invalid('Source loop domain left its original statement.');
    for(const key of ['parameter','parentModel','model','event'])text(loop[key]);
    if(loop['handler']!==null)text(loop['handler']);
    const maximum=loop['maximum'];
    if(!/^[a-f0-9]{64}$/.test(id)||ids.has(id)||!Number.isSafeInteger(maximum)||
        (maximum as number)<1||(maximum as number)>500)return invalid('Source loop identity or finite bound is invalid.');
    ids.add(id);total+=maximum as number;
  }
  if(total>500)return invalid('Source loop complete emission inventory exceeds its finite budget.');
  return deepFreeze(raw) as unknown as NonNullable<ScenarioResultDisclosurePlan['sourceEmissions']>;
}

/** Loader checker; callers cannot turn this data into a bound generated def. */
function checkRetainedGuardedHandler(value: unknown, source: unknown): void {
  const frame=object(value,['source','owner','event','node','rules',...(typeof value==='object'&&value!==null&&Object.hasOwn(value,'queries')?['queries']:[]),...(typeof value==='object'&&value!==null&&Object.hasOwn(value,'stagedRules')?['stagedRules']:[])]);
  origin(frame['source']);
  const node=object(frame['node'],['start','end']);
  const rules=list(frame['rules']).map(text);
  if(stableStringify(frame['source'])!==stableStringify(source) ||
      !text(frame['owner']).includes('.') || !text(frame['event']).includes('.') ||
      !Number.isSafeInteger(node['start']) || !Number.isSafeInteger(node['end']) ||
      (node['start'] as number)<0 || (node['end'] as number)<=(node['start'] as number) ||
      rules.length===0 || new Set(rules).size!==rules.length) {
    return invalid('retained SEND frame lacks its complete original handler and guard census.');
  }
  if(Object.hasOwn(frame,'stagedRules')){const staged=list(frame['stagedRules']).map(text);if(staged.length===0||new Set(staged).size!==staged.length||staged.some(rule=>!rules.includes(rule)))return invalid('Staged SEND rules differ from the original complete retained guard census.');}
  if(Object.hasOwn(frame,'queries')){
    const queries=object(frame['queries'],['version','operation','source','sites']),originSource=object(frame['source'],['module','path','sha256']);
    if(queries['version']!==1||queries['operation']!==frame['owner']||object(queries['source'],['module','path','sha256'])['path']!==originSource['path']||object(queries['source'],['module','path','sha256'])['sha256']!==originSource['sha256'])return invalid('Retained query census changed its owning source.');
    const sites=list(queries['sites']);if(sites.length===0||sites.length>MAX_ITEMS)return invalid('Retained query census must be finite and nonempty.');
  }
}

export function checkScenarioResultDisclosurePlan(value: unknown): ScenarioResultDisclosurePlan {
  const plan = object(dataCopy(value), ['version', 'source', 'returns',
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value,'retainedGuardedHandler')?['retainedGuardedHandler']:[]),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value,'sourceLoops')?['sourceLoops']:[]),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value,'sourceEmissions')?['sourceEmissions']:[]),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'queries') ? ['queries'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'eventDecision') ? ['eventDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'termDecision') ? ['termDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'leaveRequestDecision') ? ['leaveRequestDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'leaveDecideDecision') ? ['leaveDecideDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'referRejectDecision') ? ['referRejectDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'memberRetryDecision') ? ['memberRetryDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'rentMovementRefundDecision') ? ['rentMovementRefundDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'invoiceCollectDecision') ? ['invoiceCollectDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'invoiceIssueDecision') ? ['invoiceIssueDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'rentNoticeDecision') ? ['rentNoticeDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'observeVenueDecision') ? ['observeVenueDecision'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'successRenewalDecision') ? ['successRenewalDecision'] : []),

    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'purchaseReceiveAll') ? ['purchaseReceiveAll'] : []),
    ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'eventNoticeAudit') ? ['eventNoticeAudit'] : [])]);
  if (plan['version'] !== 1) return invalid('unsupported dependency plan version.');
  origin(plan['source']);
  if(Object.hasOwn(plan,'sourceLoops'))checkSourceLoops(plan['sourceLoops'],plan['source']);
  if(Object.hasOwn(plan,'sourceEmissions'))checkSourceEmissions(plan['sourceEmissions'],plan['source']);
  if(Object.hasOwn(plan,'sourceLoops') && Object.hasOwn(plan,'sourceEmissions'))return invalid('Independent source loop execution modes cannot be combined.');
  if (Object.hasOwn(plan, 'eventDecision')) checkEventDecisionPlan(plan['eventDecision'], plan['source']);
  if (Object.hasOwn(plan, 'termDecision')) checkTermDecisionPlan(plan['termDecision'], plan['source']);
  if (Object.hasOwn(plan, 'leaveRequestDecision')) checkLeaveRequestDecisionPlan(plan['leaveRequestDecision'], plan['source']);
  if (Object.hasOwn(plan, 'leaveDecideDecision')) checkLeaveDecideDecisionPlan(plan['leaveDecideDecision'], plan['source']);
  if (Object.hasOwn(plan, 'referRejectDecision')) checkReferRejectDecisionPlan(plan['referRejectDecision'], plan['source']);
  if (Object.hasOwn(plan, 'memberRetryDecision')) checkMemberRetryDecisionPlan(plan['memberRetryDecision'], plan['source']);
  if (Object.hasOwn(plan, 'rentMovementRefundDecision')) checkRentMovementRefundDecisionPlan(plan['rentMovementRefundDecision'], plan['source']);
  if (Object.hasOwn(plan, 'invoiceCollectDecision')) checkInvoiceCollectDecisionPlan(plan['invoiceCollectDecision'], plan['source']);
  if (Object.hasOwn(plan, 'invoiceIssueDecision')) checkInvoiceIssueDecisionPlan(plan['invoiceIssueDecision'], plan['source']);
  if (Object.hasOwn(plan, 'rentNoticeDecision')) checkRentNoticeDecisionPlan(plan['rentNoticeDecision'], plan['source']);
  if (Object.hasOwn(plan, 'observeVenueDecision')) checkObserveVenueDecisionPlan(plan['observeVenueDecision'], plan['source']);
  if (Object.hasOwn(plan, 'successRenewalDecision')) checkSuccessRenewalDecisionPlan(plan['successRenewalDecision'], plan['source']);
  if (Object.hasOwn(plan, 'purchaseReceiveAll')) checkPurchaseAllPlan(plan['purchaseReceiveAll'], plan['source']);
  if (Object.hasOwn(plan, 'eventNoticeAudit')) checkEventNoticeAuditPlan(plan['eventNoticeAudit'], plan['source']);
  const queries = checkQueries(plan['queries'] ?? []);
  const returns = list(plan['returns']);
  if (Object.hasOwn(plan,'retainedGuardedHandler')) {
    checkRetainedGuardedHandler(plan['retainedGuardedHandler'],plan['source']);
    if(returns.length!==0 || queries.length!==0 || Object.keys(plan).some(key=>
        !['version','source','returns','queries','retainedGuardedHandler'].includes(key))) {
      return invalid('retained SEND frame cannot publish returns, query grants or another decision mode.');
    }
  } else if (returns.length === 0) return invalid('at least one checked return path required.');
  const ids = new Set<string>(); const dependencies = new Map<string, string>();
  for (const entry of returns) {
    const returned = object(entry, ['id', 'source', 'dependencies', 'influences',
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'intrinsics') ? ['intrinsics'] : []),
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'projection') ? ['projection'] : [])]); const id = text(returned['id']);
    origin(returned['source']);
    if (ids.has(id)) return invalid('duplicate return identity.'); ids.add(id);
    const influences = list(returned['influences']);
    for (const item of influences) {
      const influence = object(item, ['id', 'kind', ...(typeof item === 'object' && item !== null && Object.hasOwn(item, 'queryId') ? ['queryId'] : [])]); text(influence['id']);
      if (!['query-existence', 'query-cardinality', 'query-membership', 'query-order', 'absent-reference'].includes(text(influence['kind']))) {
        return invalid('unknown return influence.');
      }
    }
    checkQueryProjection(returned, queries);
    const local = new Set<string>();
    for (const item of list(returned['dependencies'])) {
      const dependency = object(item, ['id', 'source', 'role', 'model', 'field', 'type',
        ...(typeof item === 'object' && item !== null && Object.hasOwn(item, 'queryId') ? ['queryId'] : [])]);
      origin(dependency['source']);
      const depId = text(dependency['id']); text(dependency['model']);
      if (dependency['role'] !== 'data' && dependency['role'] !== 'control') return invalid('unknown dependency role.');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['field']))) return invalid('only declared direct stored fields or reserved row metadata are supported.');
      dependencyType(dependency['type']);
      if (Object.hasOwn(dependency, 'queryId')) {
        const queryId = text(dependency['queryId']);
        const query = queries.find(query => query.id === queryId);
        if (query === undefined || !influences.some(item => (item as Record<string, unknown>)['queryId'] === queryId) ||
            stableStringify(query.source) !== stableStringify(dependency['source'])) {
          return invalid('candidate-only dependency requires its same source query consumed by this return.');
        }
      }
      const encoded = stableStringify(dependency);
      if (local.has(depId) || (dependencies.has(depId) && dependencies.get(depId) !== encoded)) return invalid('dependency identity drifts.');
      local.add(depId); dependencies.set(depId, encoded);
    }
    for (const item of list(Object.hasOwn(returned, 'intrinsics') ? returned['intrinsics'] : [])) {
      const kind = (item as Record<string, unknown>)?.['kind'];
      const dependency = object(item, ['id', 'source', 'role', 'type', 'kind',
        ...(kind === 'created-model-version'?['created']:kind === 'admitted-reference-version' ? ['parameter', 'model'] : kind === 'admitted-input' ? ['parameter'] : [])]);
      origin(dependency['source']); const depId = text(dependency['id']);
      if (dependency['role'] !== 'data' && dependency['role'] !== 'control') return invalid('unknown intrinsic role.');
      if (kind === 'operation-id') {
        if (dependency['type'] !== 'text') return invalid('operation identity requires text wire.');
      } else if (kind === 'admitted-input') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(text(dependency['parameter'])) || !primitiveInputType(dependency['type']) && !(plan['eventNoticeAudit']!==undefined && dependency['parameter']==='eventKind' && dependency['type']==='enum(confirmation,change,cancellation)')) {
          return invalid('admitted input requires a declared singular parameter path and supported primitive type.');
        }
      } else if (kind === 'admitted-reference-version') {
        text(dependency['model']);
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(text(dependency['parameter'])) || dependency['type'] !== 'int') {
          return invalid('original reference version requires a declared singular parameter path and int wire.');
        }
      } else return invalid('unsupported intrinsic dependency.');
      const encoded = stableStringify(dependency);
      if (local.has(depId) || (dependencies.has(depId) && dependencies.get(depId) !== encoded)) return invalid('dependency identity drifts.');
      local.add(depId); dependencies.set(depId, encoded);
    }
  }
  if (dependencies.size > MAX_ITEMS) return invalid('dependency closure exceeds its finite budget.');
  return deepFreeze(plan as unknown as ScenarioResultDisclosurePlan);
      } else if(kind==='created-model-version'){
        const created=object(dependency['created'],['id','node','stage','binding','model','parentParameter','parentModel']);
        const node=object(created['node'],['start','end']);
        if(dependency['type']!=='int'||!/^[a-f0-9]{64}$/.test(text(created['id']))
            ||!Number.isSafeInteger(created['stage'])||Number(created['stage'])<0||Number(created['stage'])>=MAX_ITEMS
            ||!Number.isSafeInteger(node['start'])||!Number.isSafeInteger(node['end'])||Number(node['start'])<0||Number(node['end'])<=Number(node['start']))return invalid('created version requires its exact original CREATE stage and int wire.');
        for(const key of ['binding','model','parentParameter','parentModel'])text(created[key]);
}

const PRIMITIVE_INPUT_KINDS: Readonly<Record<string, string>> = Object.freeze({
  text: 'string', email: 'string', date: 'string', currency: 'string',
  bool: 'boolean', int: 'integer', datetime: 'datetime', decimal: 'decimal',
  money: 'money', duration: 'duration', user: 'user',
});

export function primitiveInputType(type: unknown, kind?: string): type is CanTypeId {
  return typeof type === 'string' && Object.hasOwn(PRIMITIVE_INPUT_KINDS, type)
    && (kind === undefined || PRIMITIVE_INPUT_KINDS[type] === kind);
}

interface PurchaseAllPlan {
  readonly version: 1; readonly owner: 'purchase.receive' | 'CanPurchase.receive';
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly node: { readonly start: number; readonly end: number };
  readonly statement: { readonly start: number; readonly end: number };
  readonly stage: 3; readonly parameter: 'line'; readonly order: string;
  readonly line: string; readonly receipt: string; readonly amendment: string;
}
export function checkPurchaseAllPlan(value: unknown, source: unknown): PurchaseAllPlan {
  const input = object(value, ['version', 'owner', 'source', 'node', 'statement', 'stage', 'parameter', 'order', 'line', 'receipt', 'amendment']);
  const node = object(input['node'], ['start', 'end']), statement = object(input['statement'], ['start', 'end']);
  const namespace = input['owner'] === 'purchase.receive' ? 'purchase' : input['owner'] === 'CanPurchase.receive' ? 'CanPurchase' : undefined;
  if (input['version'] !== 1 || namespace === undefined || input['stage'] !== 3 || input['parameter'] !== 'line' ||
      input['order'] !== `${namespace}.Order` || input['line'] !== `${namespace}.Line` || input['receipt'] !== `${namespace}.Receipt` ||
      input['amendment'] !== `${namespace}.Amendment` || stableStringify(input['source']) !== stableStringify(source) ||
      !Number.isSafeInteger(node['start']) || !Number.isSafeInteger(node['end']) ||
      !Number.isSafeInteger(statement['start']) || !Number.isSafeInteger(statement['end']) ||
      (node['start'] as number) < (statement['start'] as number) || (node['end'] as number) > (statement['end'] as number) ||
      (node['start'] as number) >= (node['end'] as number)) return invalid('Purchase ALL requires its exact checked post-write source profile.');
  origin(input['source']);
  return deepFreeze(input) as unknown as PurchaseAllPlan;
}

export interface EventNoticeAuditPlan {
  readonly version: 1; readonly owner: 'events.attendee_notice';
  readonly source: ScenarioResultDisclosurePlan['source']; readonly event: 'events.AttendeeNotice';
  readonly fields: readonly { readonly name: string; readonly type: string }[];
  readonly model: 'events.Notice'; readonly stage: 0;
  readonly create: { readonly start: number; readonly end: number };
  readonly auditFields: readonly ['subject', 'body'];
  readonly formats: readonly { readonly field: 'subject' | 'body'; readonly node: { readonly start: number; readonly end: number };
    readonly source: string; readonly sourceLang: string; readonly variants: Readonly<Record<string, string | null>>;
    readonly parameters: readonly { readonly name: string; readonly type: string; readonly presentation: string }[] }[];
}
export function checkEventNoticeAuditPlan(value: unknown, source: unknown): EventNoticeAuditPlan {
  const plan=object(value,['version','owner','source','event','fields','model','stage','create','auditFields','formats']);
  origin(plan['source']);
  const interval=(value:unknown) => {const node=object(value,['start','end']);
    if (!Number.isSafeInteger(node['start']) || !Number.isSafeInteger(node['end']) ||
        (node['start'] as number)<0 || (node['end'] as number)<=(node['start'] as number)) invalid('Event audit requires original source intervals.');};
  interval(plan['create']);
  if (plan['version']!==1 || plan['owner']!=='events.attendee_notice' || plan['event']!=='events.AttendeeNotice' ||
      plan['model']!=='events.Notice' || plan['stage']!==0 || stableStringify(plan['source'])!==stableStringify(source) ||
      stableStringify(plan['fields'])!==stableStringify([{name:'registration',type:'events.Registration'},
        {name:'kind',type:'events.Notice.kind'},{name:'revision',type:'int'},{name:'body',type:'text'}]) ||
      stableStringify(plan['auditFields'])!==stableStringify(['subject','body'])) return invalid('Event audit needs its exact declared event and Notice sink.');
  const formats=list(plan['formats']);
  if (formats.length!==2) return invalid('Event audit needs both original ordered formatters.');
  for (const [index,value] of formats.entries()) {
    const format=object(value,['field','node','source','sourceLang','variants','parameters']); interval(format['node']);
    if (format['field']!==['subject','body'][index] || typeof format['source']!=='string' ||
        canonicalLocale(text(format['sourceLang']))!==format['sourceLang']) return invalid('Event audit formatter differs from its source message.');
    const variants=format['variants'];
    if (typeof variants!=='object' || variants===null || Array.isArray(variants) ||
        Object.entries(variants).some(([locale,value])=>canonicalLocale(locale)!==locale || value!==null && typeof value!=='string')) return invalid('Event audit needs canonical message variants.');
    const parameters=list(format['parameters']).map(value=>object(value,['name','type','presentation']));
    const expected=index===0 ? [['kind','events.Notice.kind','enum']] :
      [['name','text','text'],['location','text','text'],['from','datetime','datetime'],['until','datetime','datetime'],
       ['zone','timezone','text'],['reason','text','text'],['ticket','text','text'],['revision','int','int'],['url','url','text']];
    if (stableStringify(parameters.map(p=>[p['name'],p['type'],p['presentation']]))!==stableStringify(expected)) return invalid('Event audit needs the original ordered typed formatter inputs.');
  }
  return value as EventNoticeAuditPlan;
}
