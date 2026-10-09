/** Checked owning native bindings for the single State owner transaction. */
import type {
  CanonicalOwnerModelPolicies, InvocationContext, ModelName, QuerySpec, RecordId, StoredRow,
} from '@canlang/contracts';
import { StateError } from '../errors.js';
import { deepFreeze, getDataPath } from '../internal/own-data.js';
import type { InterimHook, InterimHookContext, ModelTable } from './models.js';
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
  /** Entry-only for locks; final-only for invariants. Decision reads confer no grant. */
  readonly read: OwnerModelReadView;
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
  | { readonly kind: 'hook'; readonly run: (candidate: Record<string, unknown>, context: OwnerMutationHookContext) => Record<string, unknown> | Promise<Record<string, unknown>> }
);

export interface CheckedOwnerModelPolicies {
  beforeStage(change: OwnerModelChange, views: OwnerModelPolicyViews): Promise<void>;
  finalize(changes: readonly OwnerModelChange[], views: OwnerModelPolicyViews): Promise<void>;
  /** Source-ordered hooks; only genuine CRUD causes run these. */
  readonly hooks: ReadonlyMap<ModelName, readonly InterimHook[]>;
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
  if (!Array.isArray(value)) return fail(`Invalid ${what}.`);
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
function frozen<T>(value: T): T { return deepFreeze(structuredClone(value)); }

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
  const used = new Set<string>(), models = new Set<string>();
  const descriptors: CanonicalOwnerModelPolicies[] = [];
  const hooks = new Map<ModelName, readonly InterimHook[]>();
  const link = (id: string, kind: OwnerModelPolicyBinding['kind'], descriptor: CanonicalOwnerModelPolicies): OwnerModelPolicyBinding => {
    if (used.has(id)) return fail('Duplicate model-policy link.');
    const binding = bindingMap.get(id);
    if (binding === undefined || binding.kind !== kind || binding.module !== descriptor.module || binding.ownerPackage !== descriptor.ownerPackage || binding.model !== descriptor.model) return fail('Model-policy link disagrees with its owning native binding.');
    used.add(id); return binding;
  };
  for (const raw of list(input.descriptors, 'model policies')) {
    const d = object(raw, ['abi', 'model', 'ownerPackage', 'module', 'rules', 'hooks'], 'model policy');
    if (d.abi !== 'state.owner-model-policies@1') return fail('Unsupported model-policy ABI.');
    const model = text(d.model, 'policy model') as ModelName;
    const def = input.table.get(model);
    if (def === undefined || models.has(model)) return fail('Unknown or duplicate policy model.');
    models.add(model);
    text(d.module, 'policy module'); text(d.ownerPackage, 'policy package');
    // Validate data before copying it, so accessors never execute at load.
    const descriptor = { abi: d.abi, model, ownerPackage: d.ownerPackage, module: d.module, rules: [], hooks: [] } as unknown as CanonicalOwnerModelPolicies;
    const rules: CanonicalOwnerModelPolicies['rules'][number][] = [];
    for (const rawRule of list(d.rules, 'policy rules')) {
      const r = object(rawRule, ['kind', 'id', 'fields', 'dependencies'], 'policy rule');
      const id = text(r.id, 'policy rule id');
      if (r.kind === 'lock') {
        if (Object.hasOwn(r, 'dependencies')) return fail('Lock carries invariant dependencies.');
        const fields = list(r.fields, 'locked fields').map(field => text(field, 'locked field'));
        if (fields.length === 0 || new Set(fields).size !== fields.length || fields.some(field => !Object.hasOwn(def.fields, field))) return fail('Unknown or duplicate locked field.');
        link(id, 'lock', descriptor); rules.push({ kind: 'lock', id, fields });
      } else if (r.kind === 'invariant') {
        if (Object.hasOwn(r, 'fields')) return fail('Invariant carries locked fields.');
        link(id, 'invariant', descriptor);
        const dependencies = list(r.dependencies, 'rule dependencies').map(rawDependency => {
          const dep = object(rawDependency, ['id', 'model', 'maxTargets'], 'rule dependency');
          const dependencyModel = text(dep.model, 'dependency model') as ModelName;
          if (!input.table.has(dependencyModel)) return fail('Unknown dependency model.');
          if (!Number.isSafeInteger(dep.maxTargets) || (dep.maxTargets as number) < 1) return fail('Invalid dependency work bound.');
          const dependencyId = text(dep.id, 'dependency selector id');
          link(dependencyId, 'dependency', descriptor);
          return { id: dependencyId, model: dependencyModel, maxTargets: dep.maxTargets as number };
        });
        rules.push({ kind: 'invariant', id, dependencies });
      } else return fail('Unknown model-policy rule.');
    }
    const modelHooks: InterimHook[] = [];
    const hookDescriptors: CanonicalOwnerModelPolicies['hooks'][number][] = [];
    for (const rawHook of list(d.hooks, 'model hooks')) {
      const h = object(rawHook, ['id', 'op', 'operation'], 'model hook');
      const id = text(h.id, 'hook id');
      if (h.op !== 'create' && h.op !== 'update' && h.op !== 'remove') return fail('Unknown CRUD hook trigger.');
      const operation = text(h.operation, 'CRUD hook operation');
      const expected = `${model}.${h.op === 'remove' ? 'delete' : h.op}`;
      if (operation !== expected) return fail('Hook disagrees with its canonical CRUD trigger.');
      const binding = link(id, 'hook', descriptor);
      if (binding.kind !== 'hook') return fail('Invalid CRUD hook binding.');
      modelHooks.push(Object.freeze({ name: id, ops: Object.freeze([h.op] as const), run: (candidate: Record<string, unknown>, context: InterimHookContext) => {
        assertOwnerMutationHookContext(context);
        return binding.run(candidate, context);
      } }));
      hookDescriptors.push({ id, op: h.op, operation: operation as CanonicalOwnerModelPolicies['hooks'][number]['operation'] });
    }
    descriptors.push(frozen({ ...descriptor, rules, hooks: hookDescriptors }));
    hooks.set(model, Object.freeze(modelHooks));
  }
  if (used.size !== bindingMap.size) return fail('Unlinked native model-policy binding.');
  const predicate = async (id: string, row: StoredRow, views: OwnerModelPolicyViews, mode: 'entry' | 'final'): Promise<boolean> => {
    views.consumeWork();
    const binding = bindingMap.get(id)!;
    if (binding.kind !== 'invariant' && binding.kind !== 'lock') return fail('Invalid predicate binding.');
    const answer = await binding.evaluate(Object.freeze({ context: views.context, read: views[mode] }), frozen(row));
    if (typeof answer !== 'boolean') return fail('Native model predicate did not return bool.');
    return answer;
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
          if (change.after === null || rule.fields.some(field => !equal(getDataPath(change.before!.data, field), getDataPath(change.after!.data, field)))) {
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
