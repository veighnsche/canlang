/**
 * Lane 03 S3: stable input hashing for receipt identity and replay.
 *
 * Key presence distinguishes omission from null, so JSON-unsafe values fail
 * closed instead of collapsing distinct inputs onto one hash.
 */

import type { ClosedInputs } from '@canlang/contracts';
import { StateError } from '../errors.js';

function failClosed(what: string): never {
  throw new StateError('validation', `Invalid operation inputs: ${what} is not supported.`);
}

/** Admission-local profile; public canonicalization callers keep their protocol. */
const MAX_VISITS = 20_000;
const MAX_DEPTH = 32;
const MAX_TEXT = 2_000_000;
const MAX_BYTES = 6 * MAX_TEXT + 32 * MAX_VISITS;
type InputBudget = { visits: number; text: number; bytes: number };

function inputLimit(): never {
  throw new StateError('limit', 'Operation inputs exceed the admission limit.', null, { retryable: false });
}

function visit(budget: InputBudget | undefined, depth: number): void {
  if (budget === undefined) return;
  if (depth > MAX_DEPTH || budget.visits === MAX_VISITS) inputLimit();
  budget.visits += 1;
  // Finite f64 spelling, container/member punctuation and string quotes fit
  // 32 bytes per expanded value; escaped text fits six per UTF16 unit.
  budget.bytes += 32;
  if (budget.bytes > MAX_BYTES) inputLimit();
}

function text(budget: InputBudget | undefined, value: string): void {
  if (budget === undefined) return;
  if (value.length > MAX_TEXT - budget.text) inputLimit();
  budget.text += value.length;
  budget.bytes += 6 * value.length;
  if (budget.bytes > MAX_BYTES) inputLimit();
}

function children(budget: InputBudget | undefined, count: number): void {
  if (budget !== undefined && count > MAX_VISITS - budget.visits) inputLimit();
}

/**
 * Canonical JSON serialization with recursively sorted keys. Throws a
 * `validation` StateError on BigInt, undefined values, functions, symbols,
 * NaN, and Infinity.
 */
export function stableStringify(value: unknown): string {
  return serialize(value);
}

/** One existing evaluation pass: no preflight of getters or toJSON. */
function serialize(value: unknown, budget?: InputBudget, depth = 0): string {
  visit(budget, depth);
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      text(budget, value);
      return JSON.stringify(value) as string;
    case 'number':
      if (!Number.isFinite(value)) failClosed('non-finite number');
      return JSON.stringify(value) as string;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return failClosed('bigint');
    case 'undefined':
      return failClosed('undefined');
    case 'function':
      return failClosed('function');
    case 'symbol':
      return failClosed('symbol');
    case 'object':
      return serializeObject(value, budget, depth);
  }
  return failClosed('value');
}

/** Array elements in the original length-read/index-read order. */
function serializeArrayElements(value: unknown[], budget: InputBudget | undefined, depth: number): string {
  const parts: string[] = [];
  for (let index = 0; ; index += 1) {
    // Preserve the original length-read/index-read order, including
    // dynamic arrays; use that same read for the remaining-entry bound.
    const length = value.length;
    if (!(index < length)) break;
    if (budget !== undefined) children(budget, typeof length === 'number' ? length - index : 1);
    parts.push(serialize(value[index], budget, depth + 1));
  }
  return `[${parts.join(',')}]`;
}

/** Object bodies after the toJSON check, in the original key-read order. */
function serializeObject(value: object, budget: InputBudget | undefined, depth: number): string {
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return serialize((value as { toJSON: () => unknown }).toJSON(), budget, depth + 1);
  }
  if (Array.isArray(value)) return serializeArrayElements(value, budget, depth);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return failClosed('symbol key');
  }
  const parts: string[] = [];
  const keys = Object.keys(value);
  children(budget, keys.length);
  for (const key of keys) text(budget, key);
  for (const key of keys.sort()) {
    parts.push(
      `${JSON.stringify(key) as string}:${serialize((value as Record<string, unknown>)[key], budget, depth + 1)}`,
    );
  }
  return `{${parts.join(',')}}`;
}

/** SHA-256 over the stable encoding, as lowercase hex. */
export async function hashInputs(inputs: ClosedInputs): Promise<string> {
  return hashEncoding(stableStringify(inputs));
}

/** Raw mutation inputs only, after the revision/fence and before receipts. */
export async function hashAdmittedInputs(inputs: ClosedInputs): Promise<string> {
  const budget: InputBudget = { visits: 0, text: 0, bytes: 0 };
  const encoded = serialize(inputs, budget);
  // Every escape/join above was bounded before allocation. This ceiling
  // also bounds the following UTF8 encoding and digest, without a second walk.
  if (budget.bytes > MAX_BYTES) inputLimit();
  return hashEncoding(encoded);
}

async function hashEncoding(encoded: string): Promise<string> {
  const bytes = new TextEncoder().encode(encoded);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
