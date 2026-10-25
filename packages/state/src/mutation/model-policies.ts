/** Checked owning native bindings for the single State owner transaction. */
import type {
  CanonicalOwnerModelPolicies, InvocationContext, ModelName, QuerySpec, RecordId, StoredRow,
} from '@canlang/contracts';
import { OWNER_MODEL_POLICY_BINDINGS_MEMBER } from '@canlang/contracts';
import { decodeValue, equalValue, parseTypeId, validateValue } from '@canlang/values';
import type { LoadedArtifactDescriptors } from '../invocation/registry.js';
import { StateError } from '../errors.js';
import { deepFreeze, getDataPath } from '../internal/own-data.js';
import { getModelFieldValueSchema, type InterimHook, type InterimHookContext, type InterimModelDef, type ModelTable } from './models.js';
import type { MembershipReader } from '../policy/roles.js';
import type { InstalledSourceReadPredicate } from '../receipt/read-policy-membership.js';
import { assertOwnerMutationHookContext, type OwnerMutationHookContext } from './pipeline.js';

export interface OwnerModelChange {
  readonly model: ModelName;
  readonly id: RecordId;
  readonly before: StoredRow | null;
  readonly after: StoredRow | null;
}
export interface OwnerModelReadView {
  get(model: ModelName, id: RecordId): Promise<StoredRow | null>;
  query(spec: QuerySpec & { readonly limit: number; readonly authority: 'owner' }): Promise<readonly StoredRow[]>;
}
export interface OwnerModelPolicyViews {
  readonly context: InvocationContext;
  readonly entry: OwnerModelReadView;
  readonly final: OwnerModelReadView;
  readonly maxRows: number;
  consumeWork(amount?: number): void;
}
export interface OwnerRuleContext {
  readonly context: InvocationContext;
  /** Existing owning transaction completeness bound; no separate rule budget. */
  readonly maxRows: number;
  /** Entry-only for locks; final-only for invariants. Decision reads confer no grant. */
  readonly read: OwnerModelReadView;
}
type OwnerPolicyReadObservation = (input: {
  readonly context: InvocationContext; readonly row: StoredRow; readonly ownerRows: OwnerModelReadView;
  readonly read: InstalledSourceReadPredicate; readonly memberships: MembershipReader;
}) => Promise<{ readonly value: boolean; readonly revalidate: () => Promise<void> }>;
const ownerPolicyReadObservers = new WeakMap<OwnerModelPolicyViews, OwnerPolicyReadObservation>();
const ownerRuleReads = new WeakMap<object, { active: boolean; used: boolean;
  readonly observe: (read: InstalledSourceReadPredicate, memberships: MembershipReader) => ReturnType<OwnerPolicyReadObservation> }>();
/** Internal owner pipeline issuer; this installer is absent from public barrels. */
export function bindOwnerPolicyReadObserver(views: OwnerModelPolicyViews, observe: OwnerPolicyReadObservation): void {
  if (ownerPolicyReadObservers.has(views) || !Object.isFrozen(views)) {
    throw new StateError('validation', 'Owner policy observation requires one original frozen owner view.');
  }
  ownerPolicyReadObservers.set(views, observe);
}
/** Only the live State-issued rule context can open its original source read. */
export async function evaluateOwnerRuleReadPolicy(context: OwnerRuleContext, read: InstalledSourceReadPredicate,
  memberships: MembershipReader): ReturnType<OwnerPolicyReadObservation> {
  const owner = ownerRuleReads.get(context);
  if (owner?.active !== true || owner.used) throw new StateError('validation', 'Original live owner rule observation required.');
  owner.used = true;
  const result = await owner.observe(read, memberships);
  if (!owner.active) throw new StateError('validation', 'Owner rule observation outlived its predicate.');
  return result;
}
/** Internal pipeline lease for one actual candidate callback; never publicly issued. */
export function bindOwnerCandidateReadObserver(views: OwnerModelPolicyViews, row: StoredRow): () => void {
  const observe = ownerPolicyReadObservers.get(views);
  if (observe === undefined || ownerRuleReads.has(views)) throw new StateError('validation', 'Original candidate owner view required.');
  const lifetime = { active: true, used: false,
    observe: (read: InstalledSourceReadPredicate, memberships: MembershipReader) =>
      observe({ context: views.context, row, ownerRows: views.final, read, memberships }) };
  ownerRuleReads.set(views, lifetime);
  return () => { lifetime.active = false; };
}
/** Only the current State-issued candidate view can observe its source predicate. */
export async function evaluateOwnerCandidateReadPolicy(views: OwnerModelPolicyViews, read: InstalledSourceReadPredicate,
  memberships: MembershipReader): ReturnType<OwnerPolicyReadObservation> {
  const owner = ownerRuleReads.get(views);
  if (owner?.active !== true || owner.used) throw new StateError('validation', 'Original live candidate observation required.');
  owner.used = true;
  const result = await owner.observe(read, memberships);
  if (!owner.active) throw new StateError('validation', 'Candidate observation outlived its predicate.');
  return result;
}
interface BindingIdentity {
  readonly id: string;
  readonly module: string;
  readonly ownerPackage: string;
  readonly model: ModelName;
}
export type OwnerModelPolicyBinding = BindingIdentity & (
  | { readonly kind: 'invariant' | 'lock'; readonly evaluate: (context: OwnerRuleContext, row: StoredRow) => boolean | Promise<boolean> }
  | { readonly kind: 'dependency'; readonly select: (views: OwnerModelPolicyViews, change: OwnerModelChange) => readonly { readonly model: ModelName; readonly id: RecordId }[] | Promise<readonly { readonly model: ModelName; readonly id: RecordId }[]> }
  // Native hook runners bind `($candidate, $hookCtx, c)`: the third argument
  // carries the owning invocation context (actor/clock) that ambient-context
  // lowering (`c.now`, derive calls, queries) consumes. It stays optional so
  // existing two-argument test bindings keep compiling.
  | { readonly kind: 'hook'; readonly run: (candidate: Record<string, unknown>, context: OwnerMutationHookContext, c?: InvocationContext) => Record<string, unknown> | Promise<Record<string, unknown>> }
);

export interface CheckedOwnerModelPolicies {
  beforeStage(change: OwnerModelChange, views: OwnerModelPolicyViews): Promise<void>;
  finalize(changes: readonly OwnerModelChange[], views: OwnerModelPolicyViews): Promise<void>;
  /** Source-ordered hooks; only genuine CRUD causes run these. */
  readonly hooks: ReadonlyMap<ModelName, readonly InterimHook[]>;
}

/**
 * Scope-2 transitive projection over one served parent read: served fields
 * keep their values while withheld fields read through a throwing getter
 * with the exact navigation denial (`forbidden`), never a null-mask. The
 * served set is the loader row minus its withheld baseline, so a
 * fail-closed baseline — no caller grant authority in a direct State frame
 * — refuses every value read precisely while decision reads serve whole.
 */
export function projectOwnerHookParentRow(input: {
  readonly row: StoredRow;
  readonly withheld: ReadonlySet<string>;
}): StoredRow {
  const data: Record<string, unknown> = Object.create(null);
  for (const field of Object.keys(input.row.data)) {
    if (!input.withheld.has(field)) {
      data[field] = (input.row.data as Record<string, unknown>)[field];
    } else {
      Object.defineProperty(data, field, { enumerable: true,
        get: (): never => {
          throw new StateError('forbidden', 'Record field is not readable.');
        },
      });
    }
  }
  return Object.freeze({ ...input.row, data });
}
const checkedPolicies = new WeakSet<object>();
export function assertCheckedOwnerModelPolicies(value: CheckedOwnerModelPolicies): void {
  if (!checkedPolicies.has(value)) throw new StateError('validation', 'Unverified owning model-policy bindings.');
}
function fail(message: string): never { throw new StateError('validation', message); }
function object(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`Invalid ${what}.`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail(`Invalid ${what} prototype.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) return fail(`Unknown ${what} member.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!('value' in descriptor)) return fail(`Invalid ${what} accessor.`);
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, what: string): string {
  return typeof value === 'string' && value !== '' ? value : fail(`Invalid ${what}.`);
}
function list(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail(`Invalid ${what}.`);
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (descriptor === undefined || !('value' in descriptor)) return fail(`Invalid ${what} element.`);
  }
  if (Reflect.ownKeys(value).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return fail(`Invalid ${what} member.`);
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
  const ak = Object.keys(a), bk = Object.keys(b);
  return ak.length === bk.length && ak.every(key => Object.hasOwn(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function equalLockedField(def: InterimModelDef, name: string, a: unknown, b: unknown): boolean {
  // Omitted fields retain the existing absence semantics; they are not defaults.
  if (a === undefined || b === undefined) return a === b;
  const field = def.fields[name]!;
  const reference = def.refs.find(ref => ref.field === name);
  const type = field.valueType ?? (reference === undefined ? undefined :
    `${reference.model}${field.array === undefined ? '' : '[]'}${field.nullable === true ? '?' : ''}`);
  if (type === undefined) return equal(a, b);
  const schema = getModelFieldValueSchema(field);
  const parsed = parseTypeId(type);
  const contract = schema !== undefined && parsed.base.kind === 'nominal' && Object.hasOwn(schema.contracts, parsed.base.path);
  // The optional codec's legacy scalar wire path is unchanged. Only declared
  // references and schema-owned Contracts need canonical reference identity.
  if (reference === undefined && !contract) return equal(a, b);
  const decode = (value: unknown) => schema === undefined
    ? decodeValue(type, value) : validateValue(schema, type, value, 'create');
  return equalValue(type, decode(a), decode(b), undefined, schema);
}
function frozen<T>(value: T): T { return deepFreeze(structuredClone(value)); }

/** Metadata-only validation shared by artifact loading and native binding.
 * No callback executes and no missing dependency plan is inferred. */
export function checkOwnerModelPolicyDescriptors(input: {
  readonly descriptors: unknown;
  readonly models: ReadonlyMap<ModelName, { readonly fields: Readonly<Record<string, unknown>> }>;
  /** Exact emitted production module inventory, required by an artifact claim. */
  readonly modules?: readonly string[];
}): readonly CanonicalOwnerModelPolicies[] {
  const modulePaths = input.modules === undefined ? undefined : new Set<string>();
  if (modulePaths !== undefined) for (const path of list(input.modules, 'policy module inventory')) {
    const name = text(path, 'policy module path');
    if (modulePaths.has(name)) return fail('Duplicate policy module path.');
    modulePaths.add(name);
  }
  const models = new Set<string>(), links = new Set<string>();
  const link = (value: unknown, what: string): string => {
    const id = text(value, what);
    if (links.has(id)) return fail('Duplicate model-policy link.');
    links.add(id); return id;
  };
  const descriptors = list(input.descriptors, 'model policies').map(raw => {
    const d = object(raw, ['abi', 'model', 'ownerPackage', 'module', 'rules', 'hooks'], 'model policy');
    if (d.abi !== 'state.owner-model-policies@1') return fail('Unsupported model-policy ABI.');
    const model = text(d.model, 'policy model') as ModelName;
    const def = input.models.get(model);
    if (def === undefined || models.has(model)) return fail('Unknown or duplicate policy model.');
    models.add(model);
    const module = text(d.module, 'policy module'), ownerPackage = text(d.ownerPackage, 'policy package');
    if (model.slice(0, model.lastIndexOf('.')) !== ownerPackage) return fail('Policy package disagrees with its canonical owning model.');
    if (modulePaths !== undefined && !modulePaths.has(module)) return fail('Policy module is not an emitted production module.');
    const rules: CanonicalOwnerModelPolicies['rules'][number][] = list(d.rules, 'policy rules').map(rawRule => {
      const r = object(rawRule, ['kind', 'id', 'fields', 'dependencies'], 'policy rule');
      const id = link(r.id, 'policy rule id');
      if (r.kind === 'lock') {
        if (Object.hasOwn(r, 'dependencies')) return fail('Lock carries invariant dependencies.');
        const fields = list(r.fields, 'locked fields').map(field => text(field, 'locked field'));
        if (fields.length === 0 || new Set(fields).size !== fields.length || fields.some(field => !Object.hasOwn(def.fields, field))) return fail('Unknown or duplicate locked field.');
        return { kind: 'lock', id, fields };
      }
      if (r.kind !== 'invariant') return fail('Unknown model-policy rule.');
      if (Object.hasOwn(r, 'fields')) return fail('Invariant carries locked fields.');
      const dependencies = list(r.dependencies, 'rule dependencies').map(rawDependency => {
        const dep = object(rawDependency, ['id', 'model', 'maxTargets'], 'rule dependency');
        const dependencyModel = text(dep.model, 'dependency model') as ModelName;
        if (!input.models.has(dependencyModel)) return fail('Unknown dependency model.');
        if (!Number.isSafeInteger(dep.maxTargets) || (dep.maxTargets as number) < 1) return fail('Invalid dependency work bound.');
        return { id: link(dep.id, 'dependency selector id'), model: dependencyModel, maxTargets: dep.maxTargets as number };
      });
      return { kind: 'invariant', id, dependencies };
    });
    const hooks: CanonicalOwnerModelPolicies['hooks'][number][] = list(d.hooks, 'model hooks').map(rawHook => {
      const h = object(rawHook, ['id', 'op', 'operation'], 'model hook');
      const id = link(h.id, 'hook id');
      if (h.op !== 'create' && h.op !== 'update' && h.op !== 'remove') return fail('Unknown CRUD hook trigger.');
      const operation = text(h.operation, 'CRUD hook operation');
      if (operation !== `${model}.${h.op === 'remove' ? 'delete' : h.op}`) return fail('Hook disagrees with its canonical CRUD trigger.');
      return { id, op: h.op, operation: operation as CanonicalOwnerModelPolicies['hooks'][number]['operation'] };
    });
    return { abi: 'state.owner-model-policies@1' as const, model, ownerPackage, module, rules, hooks };
  });
  return frozen(descriptors);
}

/** Dev's existing loader verifies source and module-byte correspondence before
 * supplying a canApp() registry, including its existing native adaptation of
 * verified invocation context and hydrated rows. OwnerRuleContext/StoredRow are
 * not generated Can(c,row) arguments. State checks this transport, not loaded bytes;
 * lookup grants neither callback nor row authority. Unrelated modules are allowed. */
export interface SourceVerifiedOwnerModelPolicyModule {
  readonly path: string;
  readonly registry: unknown;
}

function bindPolicyModuleBindings(
  carrier: PropertyDescriptor,
  path: string,
  bindings: OwnerModelPolicyBinding[],
): void {
  if (!('value' in carrier)) return fail('Invalid native model-policy bindings accessor.');
  for (const rawBinding of list(carrier.value, 'native model-policy bindings')) {
    const binding = object(rawBinding, ['id', 'module', 'ownerPackage', 'model', 'kind', 'evaluate', 'select', 'run'], 'native binding');
    if (binding.module !== path) return fail('Native binding disagrees with its emitted module path.');
    bindings.push(binding as unknown as OwnerModelPolicyBinding);
  }
}

function bindPolicyModule(
  raw: unknown,
  paths: Set<string>,
  bindings: OwnerModelPolicyBinding[],
): void {
  const module = object(raw, ['path', 'registry'], 'source-verified policy module');
  const path = text(module.path, 'source-verified module path');
  if (paths.has(path)) return fail('Duplicate source-verified module path.');
  paths.add(path);
  const registry = module.registry;
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)
    || (Object.getPrototypeOf(registry) !== Object.prototype && Object.getPrototypeOf(registry) !== null)) return fail('Invalid source-verified canApp registry.');
  const carrier = Object.getOwnPropertyDescriptor(registry, OWNER_MODEL_POLICY_BINDINGS_MEMBER);
  if (carrier === undefined) {
    if (OWNER_MODEL_POLICY_BINDINGS_MEMBER in registry) return fail('Inherited native model-policy bindings.');
    return;
  }
  bindPolicyModuleBindings(carrier, path, bindings);
}

/** Join loaded immutable JSON claims to their exact module-local native ABI. */
export function bindArtifactOwnerModelPolicies(input: {
  readonly artifact: LoadedArtifactDescriptors;
  readonly table: ModelTable;
  readonly modules: readonly SourceVerifiedOwnerModelPolicyModule[];
}): CheckedOwnerModelPolicies | undefined {
  object(input, ['artifact', 'table', 'modules'], 'model-policy transport');
  if (typeof input.artifact !== 'object' || input.artifact === null || Array.isArray(input.artifact)) return fail('Invalid loaded model-policy artifact.');
  const claim = Object.getOwnPropertyDescriptor(input.artifact, 'modelPolicies');
  if (claim === undefined && 'modelPolicies' in input.artifact) return fail('Inherited model-policy claim.');
  if (claim !== undefined && !('value' in claim)) return fail('Invalid model-policy claim accessor.');
  const descriptors = claim === undefined ? undefined : checkOwnerModelPolicyDescriptors({ descriptors: claim.value, models: input.table });
  const paths = new Set<string>(), bindings: OwnerModelPolicyBinding[] = [];
  for (const raw of list(input.modules, 'source-verified policy modules')) {
    bindPolicyModule(raw, paths, bindings);
  }
  if (descriptors === undefined) {
    if (bindings.length !== 0) return fail('Unclaimed native model-policy binding.');
    return undefined;
  }
  checkOwnerModelPolicyDescriptors({ descriptors, models: input.table, modules: [...paths] });
  return bindOwnerModelPolicies({ table: input.table, descriptors, bindings });
}

/**
 * Loader boundary: metadata and owning callbacks must correspond exactly.
 * The host binds only compiler-checked pure exports; this loader neither
 * imports modules nor grants authority to a callback or returned row.
 */
export function bindOwnerModelPolicies(input: {
  readonly table: ModelTable;
  readonly descriptors: readonly CanonicalOwnerModelPolicies[];
  readonly bindings: readonly OwnerModelPolicyBinding[];
}): CheckedOwnerModelPolicies {
  object(input, ['table', 'descriptors', 'bindings'], 'model-policy binding input');
  const bindingMap = new Map<string, OwnerModelPolicyBinding>();
  for (const raw of list(input.bindings, 'native bindings')) {
    const b = object(raw, ['id', 'module', 'ownerPackage', 'model', 'kind', 'evaluate', 'select', 'run'], 'native binding');
    const id = text(b.id, 'native binding id');
    if (bindingMap.has(id)) return fail('Duplicate native binding id.');
    text(b.module, 'native binding module'); text(b.ownerPackage, 'native binding package'); text(b.model, 'native binding model');
    const member = b.kind === 'dependency' ? 'select' : b.kind === 'hook' ? 'run' : b.kind === 'invariant' || b.kind === 'lock' ? 'evaluate' : fail('Unknown native binding kind.');
    if (typeof b[member] !== 'function' || ['evaluate', 'select', 'run'].some(key => key !== member && Object.hasOwn(b, key))) return fail('Invalid native binding function.');
    bindingMap.set(id, Object.freeze({ ...b }) as unknown as OwnerModelPolicyBinding);
  }
  const descriptors = checkOwnerModelPolicyDescriptors({ descriptors: input.descriptors, models: input.table });
  const used = new Set<string>();
  const hooks = new Map<ModelName, readonly InterimHook[]>();
  const link = (id: string, kind: OwnerModelPolicyBinding['kind'], descriptor: CanonicalOwnerModelPolicies): OwnerModelPolicyBinding => {
    const binding = bindingMap.get(id);
    if (binding === undefined || binding.kind !== kind || binding.module !== descriptor.module || binding.ownerPackage !== descriptor.ownerPackage || binding.model !== descriptor.model) return fail('Model-policy link disagrees with its owning native binding.');
    used.add(id); return binding;
  };
  for (const descriptor of descriptors) {
    for (const rule of descriptor.rules) {
      link(rule.id, rule.kind, descriptor);
      if (rule.kind === 'invariant') for (const dependency of rule.dependencies) link(dependency.id, 'dependency', descriptor);
    }
    const modelHooks = descriptor.hooks.map(hook => {
      const binding = link(hook.id, 'hook', descriptor);
      if (binding.kind !== 'hook') return fail('Invalid CRUD hook binding.');
      return Object.freeze({ name: hook.id, ops: Object.freeze([hook.op]), run: (candidate: Record<string, unknown>, context: InterimHookContext) => {
        assertOwnerMutationHookContext(context);
        // Forward the owning invocation context as the native runner's
        // ambient `c`: hook queries, `now` and derive calls read the same
        // author/clock as their triggering operation. The `c.transitive`
        // path serves record-typed helper linkage through the defining
        // owner loader at the inheriting site (same arity as the host
        // bridge; only the projection baseline differs — with no caller
        // grant authority in a direct State frame, value reads stay
        // precisely refused while decision reads serve whole).
        const transitive = Object.freeze({
          openScope: (site: unknown): object => {
            if (site !== 'decision' && site !== 'value') {
              throw new StateError('validation', 'Hook parent read requires its decision or value site.');
            }
            return Object.freeze({ mode: site });
          },
          load: async (scope: unknown, model: unknown, id: unknown): Promise<StoredRow> => {
            if (typeof scope !== 'object' || scope === null ||
              ((scope as { readonly mode: unknown }).mode !== 'decision' &&
                (scope as { readonly mode: unknown }).mode !== 'value')) {
              throw new StateError('validation', 'Hook parent scope is closed or foreign.');
            }
            const read = await context.loadParent(model as ModelName, id as RecordId,
              (scope as { readonly mode: 'decision' | 'value' }).mode);
            return projectOwnerHookParentRow(read);
          },
          loadReference: async (scope: unknown, model: unknown, id: unknown): Promise<StoredRow> => {
            if (typeof scope !== 'object' || scope === null ||
              ((scope as { readonly mode: unknown }).mode !== 'decision' &&
                (scope as { readonly mode: unknown }).mode !== 'value')) {
              throw new StateError('validation', 'Hook parent scope is closed or foreign.');
            }
            const read = await context.loadReference(model as ModelName, id as RecordId,
              (scope as { readonly mode: 'decision' | 'value' }).mode);
            return projectOwnerHookParentRow(read);
          },
        });
        return binding.run(candidate, context, Object.freeze({ ...context.context, transitive }));
      } });
    });
    hooks.set(descriptor.model, Object.freeze(modelHooks));
  }
  if (used.size !== bindingMap.size) return fail('Unlinked native model-policy binding.');
  const predicate = async (id: string, row: StoredRow, views: OwnerModelPolicyViews, mode: 'entry' | 'final'): Promise<boolean> => {
    views.consumeWork();
    const binding = bindingMap.get(id)!;
    if (binding.kind !== 'invariant' && binding.kind !== 'lock') return fail('Invalid predicate binding.');
    const actualRow = frozen(row);
    const context = Object.freeze({ context: views.context, maxRows: views.maxRows, read: views[mode] });
    const observe = ownerPolicyReadObservers.get(views);
    const lifetime = observe === undefined ? undefined : { active: true, used: false,
      observe: (read: InstalledSourceReadPredicate, memberships: MembershipReader) => observe({
        context: views.context, row: actualRow, ownerRows: views[mode], read, memberships }) };
    if (lifetime !== undefined) ownerRuleReads.set(context, lifetime);
    try {
      const answer = await binding.evaluate(context, actualRow);
      if (typeof answer !== 'boolean') return fail('Native model predicate did not return bool.');
      return answer;
    } finally { if (lifetime !== undefined) lifetime.active = false; }
  };
  const policies: CheckedOwnerModelPolicies = Object.freeze({
    // Return fresh maps: mutating a public Map cannot replace installed hooks.
    get hooks() { return new Map(hooks); },
    async beforeStage(change: OwnerModelChange, views: OwnerModelPolicyViews) {
      if (change.before === null) return;
      for (const d of descriptors) {
        if (d.model !== change.model) continue;
        for (const rule of d.rules) {
          if (rule.kind !== 'lock' || !await predicate(rule.id, change.before, views, 'entry')) continue;
          if (change.after === null || rule.fields.some(field => !equalLockedField(input.table.get(d.model)!, field,
            getDataPath(change.before!.data, field), getDataPath(change.after!.data, field)))) {
            throw new StateError('rule_failed', 'Locked fields cannot change and locked records cannot be removed.');
          }
        }
      }
    },
    async finalize(changes: readonly OwnerModelChange[], views: OwnerModelPolicyViews) {
      for (const d of descriptors) {
        for (const rule of d.rules) {
          if (rule.kind !== 'invariant') continue;
          const targets = new Map<string, RecordId>();
          for (const change of changes) if (change.model === d.model && change.after !== null) targets.set(change.id, change.id);
          for (const dependency of rule.dependencies) {
            const binding = bindingMap.get(dependency.id)!;
            if (binding.kind !== 'dependency') return fail('Invalid dependency binding.');
            for (const change of changes) {
              if (change.model !== dependency.model) continue;
              views.consumeWork();
              const selected = list(await binding.select(views, frozen(change)), 'affected rows');
              if (selected.length > dependency.maxTargets || selected.length > views.maxRows) throw new StateError('validation', 'Model-rule dependency work exceeds its bound.');
              views.consumeWork(selected.length);
              for (const raw of selected) {
                const target = object(raw, ['model', 'id'], 'affected row');
                if (target.model !== d.model) return fail('Affected row does not belong to the declaring model.');
                const id = text(target.id, 'affected row id') as RecordId;
                targets.set(id, id);
              }
            }
          }
          if (targets.size > views.maxRows) throw new StateError('validation', 'Model-rule affected rows exceed their bound.');
          for (const id of [...targets.values()].sort()) {
            const row = await views.final.get(d.model, id);
            if (row === null) continue;
            if (row.id !== id) return fail('Affected row identity disagrees with its owning view.');
            if (!await predicate(rule.id, row, views, 'final')) throw new StateError('rule_failed', 'Model invariant failed.');
          }
        }
      }
    },
  });
  checkedPolicies.add(policies); return policies;
}
