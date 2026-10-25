/** Compiler's proposed v1 transport. Shape checking grants no execution;
 * source/callee/type closure and literal native captures belong to its loader. */
import type { ScenarioReceiptSourceOrigin } from '@canlang/contracts';
import { parseTypeId, printTypeId } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { stableStringify } from './replay.js';

/** Private expression-only Values type; it declares no public value or row capability. */
export type ScenarioReceiptMembershipValueShape =
  | { readonly kind: 'type'; readonly type: string }
  | { readonly kind: 'array'; readonly element: ScenarioReceiptMembershipValueShape; readonly ordered: boolean; readonly nonempty: boolean }
  | { readonly kind: 'object'; readonly fields: readonly {readonly name:string; readonly shape:ScenarioReceiptMembershipValueShape}[] };
export interface ScenarioReceiptMembershipNode { readonly start: number; readonly end: number }
export interface ScenarioReceiptMembershipSite {
  readonly version: 1;
  readonly source: ScenarioReceiptSourceOrigin;
  readonly owner: string;
  readonly node: ScenarioReceiptMembershipNode;
  readonly statement: ScenarioReceiptMembershipNode;
  readonly stage: 'leading-require' | 'body-require' | 'body-condition' | 'send-dispatch' | 'read-policy' | 'read-predicate';
  readonly position: readonly (
    { readonly kind: 'guard' | 'body' | 'then' | 'else' | 'loop'; readonly index: number } |
    { readonly kind: 'match'; readonly arm: number; readonly statement: number }
  )[];
  readonly calls: readonly {
    readonly source: ScenarioReceiptSourceOrigin;
    readonly node: ScenarioReceiptMembershipNode;
    readonly target: { readonly kind: 'builtin'; readonly id: string; readonly overload: number } |
      { readonly kind: 'derive' | 'role'; readonly name: string };
    readonly arguments: readonly { readonly node: ScenarioReceiptMembershipNode; readonly type?: string;
      readonly valueShape?: ScenarioReceiptMembershipValueShape }[];
    readonly slots: readonly (number | null)[];
    readonly defaults: readonly { readonly parameter: string; readonly source: ScenarioReceiptSourceOrigin;
      readonly node: ScenarioReceiptMembershipNode; readonly type: string }[];
    readonly chain: readonly { readonly source: ScenarioReceiptSourceOrigin;
      readonly node: ScenarioReceiptMembershipNode; readonly derive: string }[];
  }[];
}

const fail = (message: string): never => { throw new StateError('validation', `Membership recipe: ${message}`); };
const text = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 4096
  ? value : fail('bounded identity required.');
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => { const entry = Object.getOwnPropertyDescriptor(value, key);
        return entry === undefined || !('value' in entry) || !entry.enumerable; })) fail('closed own data required.');
  return value as Record<string, unknown>;
}
/** Shared finite-transport budget (one proposed plan). */
interface TransportBudget {
  count: number;
  readonly seen: Set<object>;
}

/** One member in key order: own-enumerable data or dense-array index. */
function visitTransportEntries(
  out: unknown[] | Record<string, unknown>,
  value: object,
  array: boolean,
  depth: number,
  budget: TransportBudget,
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (array && key === 'length') continue;
    const member = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in member) || !member.enumerable ||
        array && !/^(0|[1-9]\d*)$/.test(key)) return fail('own enumerable data required.');
    Object.defineProperty(out, key, { value: visitTransportValue(member.value, depth + 1, budget), enumerable: true });
  }
}

/** One transported node: primitives pass through, plain objects/arrays recurse. */
function visitTransportValue(value: unknown, depth: number, budget: TransportBudget): unknown {
  if (++budget.count > 20000 || depth > 32) return fail('finite transport budget exceeded.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || budget.seen.has(value) ||
      !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('own JSON required.');
  budget.seen.add(value);
  const array = Array.isArray(value);
  const out: unknown[] | Record<string, unknown> = array ? [] : {};
  visitTransportEntries(out, value, array, depth, budget);
  if (array && Object.keys(out).length !== (value as unknown[]).length) return fail('dense arrays required.');
  budget.seen.delete(value); return out;
}

function copy(value: unknown): unknown {
  return visitTransportValue(value, 0, { count: 0, seen: new Set<object>() });
}
function list(value: unknown, maximum = 200): unknown[] {
  return Array.isArray(value) && value.length <= maximum ? value : fail('bounded array required.');
}
function index(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail('nonnegative source/index integer required.');
}
function node(value: unknown): void {
  const item = object(value, ['start', 'end']); index(item.start); index(item.end);
  if ((item.end as number) <= (item.start as number)) fail('nonempty source interval required.');
}
function source(value: unknown): void {
  const item = object(value, ['path', 'sha256', 'module']); text(item.path); text(item.module);
  if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('exact source digest required.');
}
function type(value: unknown, argument = false): void {
  text(value);
  // Compiler serializes arguments from actual expression types, but defaults
  // from their owning Param.ty (scenario_decisions::serialize_sites).
  if (value === 'null') {
    if (argument) return;
    return fail('declared defining default type required.');
  }
  // Collection projections such as flatten([[instant]]) have nested array
  // expression types even though stored/declaration type ids are one-layer.
  if (argument && /(?:\[\]){2,}$/.test(value as string)) {
    let element = value as string, dimensions = 0;
    while (element.endsWith('[]')) { element = element.slice(0, -2); dimensions++; }
    if (dimensions > 16) return fail('bounded actual collection argument type required.');
    type(element);
    return;
  }
  try { if (printTypeId(parseTypeId(value as string)) !== value || value === 'void') fail('canonical owning type required.'); }
  catch (error) { if (error instanceof StateError) throw error; fail('canonical owning type required.'); }
}

/** Only the frozen Compiler v1 vocabulary is consumed. Full checked source and
 * executable correspondence is deliberately a trusted-loader obligation. */
/** Authored position vocabulary for one decision site. */
function checkMembershipPosition(site: Record<string, unknown>): void {
  const position = list(site.position);
  if ((site.stage === 'read-policy' || site.stage === 'read-predicate') && position.length !== 0) fail('current reads require their empty authored position.');
  for (const value of position) {
    const kind = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).kind : undefined;
    const part = object(value, kind === 'match' ? ['kind', 'arm', 'statement'] : ['kind', 'index']);
    if (kind === 'match') { index(part.arm); index(part.statement); }
    else { if (!['guard', 'body', 'then', 'else', 'loop'].includes(String(kind))) fail('closed authored position required.'); index(part.index); }
  }
}

/** One site head through its duplicate-identity enrollment; returns its calls. */
function checkMembershipSiteHead(site: Record<string, unknown>, identities: Set<string>, maximumCalls = 200): unknown[] {
  if (site.version !== 1 || typeof site.stage !== 'string' ||
      !['leading-require', 'body-require', 'body-condition', 'send-dispatch', 'read-policy', 'read-predicate'].includes(site.stage)) fail('closed v1 stage required.');
  source(site.source); text(site.owner); node(site.node); node(site.statement);
  const guard = site.node as ScenarioReceiptMembershipNode, statement = site.statement as ScenarioReceiptMembershipNode;
  if (guard.start < statement.start || guard.end > statement.end) fail('guard must belong to its authored statement.');
  checkMembershipPosition(site);
  const identity = stableStringify({ source: site.source, owner: site.owner, node: site.node, statement: site.statement,
    stage: site.stage, position: site.position });
  if (identities.has(identity)) fail('duplicate authored decision site.'); identities.add(identity);
  return list(site.calls, maximumCalls);
}

/** Builtin versus derive target vocabulary for one call. */
function checkMembershipCallTarget(call: Record<string, unknown>): { kind: unknown; target: Record<string, unknown> } {
  const kind = typeof call.target === 'object' && call.target !== null ? (call.target as Record<string, unknown>).kind : undefined;
  const target = object(call.target, kind === 'builtin' ? ['kind', 'id', 'overload'] : ['kind', 'name']);
  if (kind === 'builtin') { text(target.id); index(target.overload); }
  else if (kind === 'derive' || kind === 'role') text(target.name); else fail('checked builtin, canonical derive or role required.');
  return { kind, target };
}

/** Full original structural expression shape; public type IDs stay unchanged. */
function valueShape(value: unknown, depth = 0): void {
  if (depth >= 16 || typeof value !== 'object' || value === null) fail('bounded Values expression shape required.');
  const kind = (value as Record<string, unknown>).kind;
  if (kind === 'type') {
    const leaf = object(value,['kind','type']); type(leaf.type,true);
    const parsed = parseTypeId(leaf.type as string);
    if (['file','secret','action','delivery','invocation','member','json','union'].includes(parsed.base.kind)) fail('structural expression cannot carry opaque authority.');
  } else if (kind === 'array') {
    const array = object(value,['kind','element','ordered','nonempty']);
    if (array.ordered !== true || typeof array.nonempty !== 'boolean') fail('exact ordered Values array required.');
    valueShape(array.element,depth+1);
  } else if (kind === 'object') {
    const record = object(value,['kind','fields']), names = new Set<string>();
    const fields = list(record.fields); if (fields.length === 0) fail('nonempty structural fields required.');
    for (const value of fields) {
      const field = object(value,['name','shape']), name = text(field.name);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) fail('unique original ordered field names required.');
      names.add(name); valueShape(field.shape,depth+1);
    }
  } else fail('closed structural Values expression type required.');
}
/** Authored arguments with their actual canonical types. */
function checkMembershipCallArgs(call: Record<string, unknown>): unknown[] {
  const args = list(call.arguments);
  for (const value of args) {
    const structural = typeof value === 'object' && value !== null && Object.hasOwn(value,'valueShape');
    const argument = object(value, structural ? ['node','valueShape'] : ['node','type']); node(argument.node);
    if (structural) valueShape(argument.valueShape); else type(argument.type,true);
  }
  return args;
}

/** Canonical slots select distinct authored arguments, covering every one. */
function checkMembershipCallSlots(call: Record<string, unknown>, args: unknown[]): unknown[] {
  const slots = list(call.slots), used = new Set<number>();
  for (const slot of slots) {
    if (slot === null) continue;
    index(slot);
    if ((slot as number) >= args.length || used.has(slot as number)) fail('canonical slots must select distinct authored arguments.');
    used.add(slot as number);
  }
  if (used.size !== args.length) fail('every authored argument requires its canonical slot.');
  return slots;
}

/** Defining defaults cover exactly the omitted slots, once per parameter. */
function checkMembershipCallDefaults(call: Record<string, unknown>, slots: unknown[]): void {
  const defaults = list(call.defaults), parameters = new Set<string>();
  for (const value of defaults) {
    const item = object(value, ['parameter', 'source', 'node', 'type']); const parameter = text(item.parameter);
    source(item.source); node(item.node); type(item.type);
    if (parameters.has(parameter)) fail('unique defining default required.'); parameters.add(parameter);
  }
  if (defaults.length !== slots.filter(slot => slot === null).length) fail('every omitted slot requires its defining default.');
}

/** Bounded nonrecursive invocation chain plus the call-occurrence identity. */
function checkMembershipCallChain(
  call: Record<string, unknown>,
  kind: unknown,
  target: Record<string, unknown>,
  local: Set<string>,
): void {
  const chain = list(call.chain), derives = new Set<string>();
  if (chain.length > 16) fail('bounded nonrecursive invocation chain required.');
  for (const value of chain) {
    const item = object(value, ['source', 'node', 'derive']); source(item.source); node(item.node); const name = text(item.derive);
    if (derives.has(name)) fail('recursive derive chain is unsupported.'); derives.add(name);
  }
  if (kind === 'derive' && derives.has(target.name as string)) fail('recursive derive occurrence is unsupported.');
  const identity = stableStringify({ source: call.source, node: call.node, chain: call.chain });
  if (local.has(identity)) fail('duplicate checked call occurrence.'); local.add(identity);
}

/** active_member keeps its owning user/team overload and canonical slots. */
function checkActiveMemberCall(kind: unknown, target: Record<string, unknown>, slots: unknown[], args: unknown[]): void {
  if (kind === 'builtin' && target.id === 'active_member' && (target.overload !== 0 || slots.length !== 2 || args.length !== 2 ||
      slots[0] === null || slots[1] === null ||
      (args[slots[0] as number] as Record<string, unknown>).type !== 'user' ||
      (args[slots[1] as number] as Record<string, unknown>).type !== 'Team')) fail('active_member requires its owning user/team overload and actual canonical slots.');
}

/** One checked call occurrence in site order. */
function checkOneMembershipCall(value: unknown, local: Set<string>): void {
  const call = object(value, ['source', 'node', 'target', 'arguments', 'slots', 'defaults', 'chain']);
  source(call.source); node(call.node);
  const { kind, target } = checkMembershipCallTarget(call);
  const args = checkMembershipCallArgs(call);
  const slots = checkMembershipCallSlots(call, args);
  checkMembershipCallDefaults(call, slots);
  checkMembershipCallChain(call, kind, target, local);
  checkActiveMemberCall(kind, target, slots, args);
  if(kind==='role'&&(slots.length!==1||args.length!==1||slots[0]!==0||!['user','user?'].includes(String((args[0] as Record<string,unknown>).type)))){
    fail('subject role requires its one original user slot.');
  }
}

/** Only arrays returned here may reuse their completed structural validation. */
const normalizedSites = new WeakSet<object>();
const normalizedSiteObjects = new WeakSet<object>();
type MembershipCall = ScenarioReceiptMembershipSite['calls'][number];
type MembershipChain = MembershipCall['chain'];

/** Filtering an issued inventory preserves its immutable sites, not its array.
 * Snapshot only closed own data, then recheck the combined inventory bounds. */
function issuedSiteSelection(value: unknown): readonly ScenarioReceiptMembershipSite[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > 200) return undefined;
  const snapshot: ScenarioReceiptMembershipSite[] = [];
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1) return undefined;
  for (let index = 0; index < length.value; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !('value' in entry) || !entry.enumerable || typeof entry.value !== 'object' ||
        entry.value === null || !normalizedSiteObjects.has(entry.value)) return undefined;
    snapshot.push(entry.value as ScenarioReceiptMembershipSite);
  }
  const identities = new Set<string>(), callsites = new Set<string>();
  let occurrences = 0, weight = 0;
  for (const site of snapshot) {
    checkMembershipSiteHead(site as unknown as Record<string, unknown>, identities, 16384);
    occurrences += site.calls.length;
    if (occurrences > 16384) fail('bounded complete selected call inventory required.');
    for (const call of site.calls) {
      weight += call.arguments.length + call.slots.length + call.defaults.length + call.chain.length + 1;
      if (weight > 20000) fail('expanded call inventory budget exceeded.');
      callsites.add(stableStringify({source:call.source,node:call.node}));
      if (callsites.size > 200) fail('bounded selected source call sites required.');
    }
  }
  return Object.freeze(snapshot);
}
function rememberSites(sites: readonly ScenarioReceiptMembershipSite[]): readonly ScenarioReceiptMembershipSite[] {
  for (const site of sites) normalizedSiteObjects.add(site);
  normalizedSites.add(sites);
  return sites;
}

/** Compact plans retain every occurrence; sharing only avoids repeated wire templates. */
function expandMembershipSites(value: unknown): readonly ScenarioReceiptMembershipSite[] {
  const plan = object(value, ['version', 'definitions', 'frames', 'sites']);
  if (plan.version !== 2) fail('closed compact version required.');
  const definitions = list(plan.definitions).map(value => {
    checkOneMembershipCall(value, new Set<string>());
    const call = value as unknown as MembershipCall;
    if (call.chain.length !== 0) fail('compact definitions require empty chains.');
    return deepFreeze(call);
  });
  const frames: MembershipChain[] = [];
  for (const value of list(plan.frames, 16384)) {
    const pair = list(value);
    if (pair.length !== 2) fail('exact compact frame pair required.');
    const [definition, parent] = pair;
    index(definition);
    const call = definitions[definition as number] ?? fail('frame requires its original derive definition.');
    if (call.target.kind !== 'derive') return fail('frame requires its original derive definition.');
    const derive = call.target.name;
    let chain: MembershipChain = [];
    if (parent !== null) {
      index(parent);
      chain = frames[parent as number] ?? fail('frame parent must precede its child.');
    }
    if (chain.length >= 16 || chain.some(frame => frame.derive === derive)) fail('bounded nonrecursive frame chain required.');
    frames.push(Object.freeze([...chain, Object.freeze({source:call.source,node:call.node,derive})]));
  }
  const identities = new Set<string>();
  let occurrences = 0, weight = 0;
  const sites = list(plan.sites).map(value => {
    const site = object(value, ['version', 'source', 'owner', 'node', 'statement', 'stage', 'position', 'calls']);
    const calls = checkMembershipSiteHead(site, identities, 16384);
    occurrences += calls.length;
    if (occurrences > 16384) fail('bounded complete compact call inventory required.');
    const local = new Set<string>();
    const expanded = calls.map(value => {
      const pair = list(value);
      if (pair.length !== 2) fail('exact compact occurrence pair required.');
      const [definition, frame] = pair;
      index(definition);
      const template = definitions[definition as number] ?? fail('known compact call definition required.');
      let chain: MembershipChain = [];
      if (frame !== null) {
        index(frame);
        chain = frames[frame as number] ?? fail('known compact frame required.');
      }
      weight += template.arguments.length + template.slots.length + template.defaults.length + chain.length + 1;
      if (weight > 20000) fail('expanded call inventory budget exceeded.');
      const call = {...template,chain};
      checkMembershipCallChain(call, template.target.kind, template.target, local);
      return Object.freeze(call);
    });
    // Freeze each original head once; call templates/chains already own frozen
    // nested data, so never rewalk their expanded shared graph.
    const head = deepFreeze({...site,calls:[]});
    return Object.freeze({...head,calls:Object.freeze(expanded)}) as unknown as ScenarioReceiptMembershipSite;
  });
  return Object.freeze(sites);
}

export function checkScenarioReceiptMembershipSites(value: unknown): readonly ScenarioReceiptMembershipSite[] {
  if (typeof value === 'object' && value !== null && normalizedSites.has(value)) return value as readonly ScenarioReceiptMembershipSite[];
  const selected = issuedSiteSelection(value);
  if (selected) return rememberSites(selected);
  const copied = copy(value);
  if (!Array.isArray(copied)) {
    const sites = expandMembershipSites(copied);
    return rememberSites(sites);
  }
  const sites = list(copied); const identities = new Set<string>(); let occurrences = 0;
  for (const value of sites) {
    const site = object(value, ['version', 'source', 'owner', 'node', 'statement', 'stage', 'position', 'calls']);
    const calls = checkMembershipSiteHead(site, identities);
    occurrences += calls.length;
    if (occurrences > 200) fail('bounded complete call inventory required.');
    const local = new Set<string>();
    for (const value of calls) {
      checkOneMembershipCall(value, local);
    }
  }
  const frozen = deepFreeze(sites as unknown as ScenarioReceiptMembershipSite[]);
  return rememberSites(frozen);
}
