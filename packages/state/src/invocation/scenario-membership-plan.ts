/** Compiler's proposed v1 transport. Shape checking grants no execution;
 * source/callee/type closure and literal native captures belong to its loader. */
import type { ScenarioReceiptSourceOrigin } from '@canlang/contracts';
import { parseTypeId, printTypeId } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { stableStringify } from './replay.js';

export interface ScenarioReceiptMembershipNode { readonly start: number; readonly end: number }
export interface ScenarioReceiptMembershipSite {
  readonly version: 1;
  readonly source: ScenarioReceiptSourceOrigin;
  readonly owner: string;
  readonly node: ScenarioReceiptMembershipNode;
  readonly statement: ScenarioReceiptMembershipNode;
  readonly stage: 'leading-require' | 'body-require' | 'body-condition' | 'send-dispatch' | 'read-policy';
  readonly position: readonly (
    { readonly kind: 'guard' | 'body' | 'then' | 'else' | 'loop'; readonly index: number } |
    { readonly kind: 'match'; readonly arm: number; readonly statement: number }
  )[];
  readonly calls: readonly {
    readonly source: ScenarioReceiptSourceOrigin;
    readonly node: ScenarioReceiptMembershipNode;
    readonly target: { readonly kind: 'builtin'; readonly id: string; readonly overload: number } |
      { readonly kind: 'derive'; readonly name: string };
    readonly arguments: readonly { readonly node: ScenarioReceiptMembershipNode; readonly type: string }[];
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
function copy(value: unknown): unknown {
  const seen = new Set<object>(); let budget = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++budget > 20000 || depth > 32) return fail('finite transport budget exceeded.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null || seen.has(value) ||
        !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('own JSON required.');
    seen.add(value);
    const out: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const member = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !('value' in member) || !member.enumerable ||
          Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) return fail('own enumerable data required.');
      Object.defineProperty(out, key, { value: visit(member.value, depth + 1), enumerable: true });
    }
    if (Array.isArray(value) && Object.keys(out).length !== value.length) return fail('dense arrays required.');
    seen.delete(value); return out;
  };
  return visit(value, 0);
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) && value.length <= 200 ? value : fail('bounded array required.');
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
function type(value: unknown): void {
  text(value);
  try { if (printTypeId(parseTypeId(value as string)) !== value || value === 'void') fail('canonical owning type required.'); }
  catch (error) { if (error instanceof StateError) throw error; fail('canonical owning type required.'); }
}

/** Only the frozen Compiler v1 vocabulary is consumed. Full checked source and
 * executable correspondence is deliberately a trusted-loader obligation. */
export function checkScenarioReceiptMembershipSites(value: unknown): readonly ScenarioReceiptMembershipSite[] {
  const sites = list(copy(value)); const identities = new Set<string>(); let occurrences = 0;
  for (const value of sites) {
    const site = object(value, ['version', 'source', 'owner', 'node', 'statement', 'stage', 'position', 'calls']);
    if (site.version !== 1 || typeof site.stage !== 'string' ||
        !['leading-require', 'body-require', 'body-condition', 'send-dispatch', 'read-policy'].includes(site.stage)) fail('closed v1 stage required.');
    source(site.source); text(site.owner); node(site.node); node(site.statement);
    const guard = site.node as ScenarioReceiptMembershipNode, statement = site.statement as ScenarioReceiptMembershipNode;
    if (guard.start < statement.start || guard.end > statement.end) fail('guard must belong to its authored statement.');
    const position = list(site.position);
    if (site.stage === 'read-policy' && position.length !== 0) fail('read-policy requires its empty authored position.');
    for (const value of position) {
      const kind = typeof value === 'object' && value !== null ? (value as Record<string, unknown>).kind : undefined;
      const part = object(value, kind === 'match' ? ['kind', 'arm', 'statement'] : ['kind', 'index']);
      if (kind === 'match') { index(part.arm); index(part.statement); }
      else { if (!['guard', 'body', 'then', 'else', 'loop'].includes(String(kind))) fail('closed authored position required.'); index(part.index); }
    }
    const identity = stableStringify({ source: site.source, owner: site.owner, node: site.node, statement: site.statement,
      stage: site.stage, position: site.position });
    if (identities.has(identity)) fail('duplicate authored decision site.'); identities.add(identity);
    const calls = list(site.calls); occurrences += calls.length;
    if (occurrences > 200) fail('bounded complete call inventory required.');
    const local = new Set<string>();
    for (const value of calls) {
      const call = object(value, ['source', 'node', 'target', 'arguments', 'slots', 'defaults', 'chain']);
      source(call.source); node(call.node);
      const kind = typeof call.target === 'object' && call.target !== null ? (call.target as Record<string, unknown>).kind : undefined;
      const target = object(call.target, kind === 'builtin' ? ['kind', 'id', 'overload'] : ['kind', 'name']);
      if (kind === 'builtin') { text(target.id); index(target.overload); }
      else if (kind === 'derive') text(target.name); else fail('checked builtin or canonical derive required.');
      const args = list(call.arguments);
      for (const value of args) { const argument = object(value, ['node', 'type']); node(argument.node); type(argument.type); }
      const slots = list(call.slots), used = new Set<number>();
      for (const slot of slots) {
        if (slot === null) continue;
        index(slot);
        if ((slot as number) >= args.length || used.has(slot as number)) fail('canonical slots must select distinct authored arguments.');
        used.add(slot as number);
      }
      if (used.size !== args.length) fail('every authored argument requires its canonical slot.');
      const defaults = list(call.defaults), parameters = new Set<string>();
      for (const value of defaults) {
        const item = object(value, ['parameter', 'source', 'node', 'type']); const parameter = text(item.parameter);
        source(item.source); node(item.node); type(item.type);
        if (parameters.has(parameter)) fail('unique defining default required.'); parameters.add(parameter);
      }
      if (defaults.length !== slots.filter(slot => slot === null).length) fail('every omitted slot requires its defining default.');
      const chain = list(call.chain), derives = new Set<string>();
      if (chain.length > 16) fail('bounded nonrecursive invocation chain required.');
      for (const value of chain) {
        const item = object(value, ['source', 'node', 'derive']); source(item.source); node(item.node); const name = text(item.derive);
        if (derives.has(name)) fail('recursive derive chain is unsupported.'); derives.add(name);
      }
      if (kind === 'derive' && derives.has(target.name as string)) fail('recursive derive occurrence is unsupported.');
      const identity = stableStringify({ source: call.source, node: call.node, chain: call.chain });
      if (local.has(identity)) fail('duplicate checked call occurrence.'); local.add(identity);
      if (kind === 'builtin' && target.id === 'active_member' && (target.overload !== 0 || slots.length !== 2 || args.length !== 2 ||
          slots[0] === null || slots[1] === null ||
          (args[slots[0] as number] as Record<string, unknown>).type !== 'user' ||
          (args[slots[1] as number] as Record<string, unknown>).type !== 'Team')) fail('active_member requires its owning user/team overload and actual canonical slots.');
    }
  }
  return deepFreeze(sites as unknown as ScenarioReceiptMembershipSite[]);
}
