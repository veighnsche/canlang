/** Private State row-subject binding; only validated owning policies register fields. */
import type { ModelName, StoredRow } from '@canlang/contracts';
import type { ByContext, InterimModelPolicy } from './grants.js';

type UserFields = ReadonlyMap<string, 'user' | 'user?'>;
const policyFields = new WeakMap<InterimModelPolicy, UserFields>();
const rowBindings = new WeakMap<ByContext, {
  readonly model: ModelName;
  readonly row: StoredRow;
  readonly fields: UserFields;
}>();

/** Internal registration called after buildPolicyTable has checked source declarations. */
export function registerPolicyRowFields(policy: InterimModelPolicy, fields: UserFields): void {
  policyFields.set(policy, new Map(fields));
}

/** Bind identity facts to a row without inspecting subjects ahead of lazy evaluation. */
export function bindPolicyRowContext(policy: InterimModelPolicy, ctx: ByContext, row: StoredRow): ByContext {
  const fields = policyFields.get(policy);
  const bound = Object.freeze({ ...ctx });
  // An unvalidated policy cannot inherit another policy's row binding.
  if (fields === undefined) return bound;
  rowBindings.set(bound, { model: policy.model, row, fields });
  return bound;
}

function ownData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid row role subject: expected own stored data.');
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    throw new Error(`Invalid row role subject: ${JSON.stringify(key)} must be own data.`);
  }
  return descriptor.value;
}

/** Resolve exact wire user {id}; absence/malformed values refuse even beneath NOT. */
export function resolvePolicyRowSubject(ctx: ByContext, subject: { model: ModelName; field: string }): string | null {
  const binding = rowBindings.get(ctx);
  const model = ownData(subject, 'model');
  const field = ownData(subject, 'field');
  if (binding === undefined || binding.model !== model || typeof field !== 'string' ||
    field === '' || field.includes('.') || !binding.fields.has(field)) {
    throw new Error('Invalid row role subject: missing validated owning model/field binding.');
  }
  const value = ownData(ownData(binding.row, 'data'), field);
  if (value === null && binding.fields.get(field) === 'user?') return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).length !== 1) {
    throw new Error('Invalid row role subject: expected canonical user {id}.');
  }
  const id = ownData(value, 'id');
  if (typeof id !== 'string' || id === '') {
    throw new Error('Invalid row role subject: user id must be non-empty text.');
  }
  return id;
}
