/**
 * Portable staged-intent primitives. Identity uses the existing v1 recipe;
 * the async entry point hashes with the host's native WebCrypto primitive.
 * Staging has no commit or transport port.
 */
import type { OccurrenceId, OutboxId, OutboxItem } from '@canlang/contracts';

/** Validated, byte-stable input shared by sync and native async hashing. */
export function outboxIdentityPreimage(
  operationId: string,
  source: string,
  occurrenceIndex: number,
): string {
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw new RangeError('deriveOutboxId: operationId must be a non-empty string');
  }
  if (typeof source !== 'string' || source.length === 0) {
    throw new RangeError('deriveOutboxId: source must be a non-empty string');
  }
  if (!Number.isInteger(occurrenceIndex) || occurrenceIndex < 0) {
    throw new RangeError('deriveOutboxId: occurrenceIndex must be a non-negative integer');
  }
  return `can-work/outbox-id/v1\0${operationId}\0${source}\0${occurrenceIndex}`;
}

/** The existing outbox identity, derived without a Node runtime import. */
export async function deriveOutboxIdAsync(
  operationId: string,
  source: string,
  occurrenceIndex: number,
): Promise<OutboxId> {
  const bytes = new TextEncoder().encode(outboxIdentityPreimage(operationId, source, occurrenceIndex));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `obx_${hex}`;
}

/**
 * Build the frozen provider request captured at commit: versions and inputs
 * are cloned (so later caller mutation cannot leak in) and deep-frozen (so
 * later dispatch-time reads cannot mutate them either). Cycle-safe.
 *
 * Only plain JSON records are accepted: the staged request is the lane-3
 * `OutboxIntent.arguments` shape, so arrays, primitives, null and
 * uncloneable inputs (functions, symbols) throw instead of staging a row
 * the fence cannot carry.
 */
export function freezeRequest(
  request: unknown,
): Readonly<Record<string, unknown>> {
  const clone: unknown = structuredClone(request);
  if (typeof clone !== 'object' || clone === null || Array.isArray(clone)) {
    throw new TypeError('freezeRequest: request must be a plain JSON record');
  }
  const record = clone as Record<string, unknown>;
  deepFreezeInPlace(record, new Set());
  return record;
}

function deepFreezeInPlace(value: unknown, seen: Set<object>): void {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return;
  }
  const target = value as object;
  if (seen.has(target)) {
    return;
  }
  seen.add(target);
  for (const key of Reflect.ownKeys(target)) {
    deepFreezeInPlace((target as Record<PropertyKey, unknown>)[key], seen);
  }
  Object.freeze(target);
}

/** An intent staged during evaluation; not yet dispatchable. */
export interface StagedOutboxIntent {
  item: OutboxItem;
  commit: null;
}

export interface StageOutboxIntentInput {
  operationId: string;
  source: string;
  occurrenceIndex: number;
  /** Provider inputs; must be a plain JSON record (non-records rejected). */
  request: unknown;
  /**
   * Originating occurrence stamped by the runtime when staging during an
   * occurrence execution; null for direct business-operation sends.
   */
  originOccurrence: OccurrenceId | null;
}

/** Build one frozen staged intent after its identity has been derived. */
export function buildStagedOutboxIntent(
  input: StageOutboxIntentInput,
  id: OutboxId,
): StagedOutboxIntent {
  return assembleStagedOutboxIntent(input, id, freezeRequest(input.request));
}

/** Both entry points supply a request captured once before any await. */
function assembleStagedOutboxIntent(
  input: StageOutboxIntentInput,
  id: OutboxId,
  request: Readonly<Record<string, unknown>>,
): StagedOutboxIntent {
  const item: OutboxItem = {
    id,
    operationId: input.operationId,
    source: input.source,
    occurrenceIndex: input.occurrenceIndex,
    request,
    originOccurrence: input.originOccurrence,
    attempts: 0,
    state: 'pending',
  };
  return { item, commit: null };
}

/** Native async counterpart; retains the frozen request and absent commit marker. */
export async function stageOutboxIntentAsync(input: StageOutboxIntentInput): Promise<StagedOutboxIntent> {
  // Capture before awaiting the host digest so caller mutations during hashing
  // cannot alter the request or identity retained by this evaluation pass.
  outboxIdentityPreimage(input.operationId, input.source, input.occurrenceIndex);
  const captured = { ...input, request: freezeRequest(input.request) };
  const id = await deriveOutboxIdAsync(captured.operationId, captured.source, captured.occurrenceIndex);
  return assembleStagedOutboxIntent(captured, id, captured.request);
}
