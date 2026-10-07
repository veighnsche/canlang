import type { DerivedWritableInput } from '@canlang/contracts';
import type { PreparedBindingEntry, PreparedDeferral } from '../envelope/prepared.js';

function deferralFor(input: DerivedWritableInput): PreparedDeferral {
  if (input.kind === 'string') return 'string-values';
  if (input.kind === 'boolean') return 'boolean-values';
  if (input.kind === 'money') return 'currency-code';
  return 'bound';
}

export function toBindingEntry(input: DerivedWritableInput): PreparedBindingEntry {
  return Object.freeze({
    name: input.name,
    kind: input.kind,
    required: input.required,
    nullable: input.nullable === true,
    array: input.array !== undefined,
    versioned: input.versioned === true,
    enumValues: input.enumValues === undefined ? null : Object.freeze([...input.enumValues]),
    deferral: deferralFor(input),
  });
}
