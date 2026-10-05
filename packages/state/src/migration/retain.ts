/**
 * Lane 03 B3: retained-work carry-over through the migration flip.
 *
 * In-flight and unpinned undispatched intents no longer block activation
 * unconditionally: the deployer (L7) computes a `RetainedSet` with
 * `computeRetainedCarryover` before activation, and the inventory gate
 * exempts exactly those ids. Retained intents ride through the flip still
 * `pending` (the flip only skips `invalidate` dispositions) and dispatch
 * normally post-migration.
 *
 * RE-VALIDATION + RE-PINNING (what "carry-over" proves per intent):
 * - still pending in the outbox at compute time (missing evidence blocks);
 * - re-pinned: when the stored outbox row carries `handlerContract`, the
 *   caller attestation MUST equal it (a mismatch blocks — the B3 fix for
 *   the S7 trust boundary); rows without a stored contract (pre-B3)
 *   attest loudly, exactly as S7 did.
 * The gate re-verifies retained ids are still pending at activation time,
 * so evidence that changed between compute and flip still blocks.
 *
 * STILL BLOCKING (no disposition, fail closed):
 * - `accepted`/`uncertain` items: drain/reconcile first (unchanged).
 * - undispatched items with a pinned contract are INVALIDATED, not
 *   retained (returned alongside as the flip disposition).
 */

import type {
  MigrationOutcome,
  OutboxIntent,
  WorkInventoryItem,
} from '../../../contracts/src/state.js';
import { StateError } from '../errors.js';
import type { ValidatedMigrationPlan } from './transition.js';

/** One intent carried through the flip: id, re-pinned contract, state. */
export interface RetainedIntent {
  readonly intentId: string;
  readonly handlerContract: string;
  readonly state: 'undispatched' | 'inflight';
}

/** Frozen retained set: intents plus their id lookup for the gate. */
export interface RetainedSet {
  readonly intents: ReadonlyArray<RetainedIntent>;
  readonly ids: ReadonlySet<string>;
}

/** Carry-over input: plan, caller inventory, and stored pending outbox. */
export interface CarryoverInput {
  readonly plan: ValidatedMigrationPlan;
  readonly inventory: ReadonlyArray<WorkInventoryItem>;
  readonly pending: ReadonlyArray<OutboxIntent>;
}

/**
 * Carry-over result: the retained set plus the flip's invalidate
 * disposition (undispatched items with pinned contracts).
 */
export interface CarryoverResult {
  readonly retained: RetainedSet;
  readonly invalidatedIntentIds: ReadonlyArray<string>;
  readonly outcomes: ReadonlyArray<MigrationOutcome>;
}

/**
 * Partition one inventory against stored outbox evidence: pinned
 * undispatched items invalidate, unpinned undispatched plus in-flight
 * items retain (re-pinned to the stored contract when present),
 * accepted/uncertain items block. Pure (no I/O): the caller supplies the
 * pending outbox it read.
 */
export function computeRetainedCarryover(input: CarryoverInput): CarryoverResult {
  const { plan, inventory, pending } = input;
  if (!Array.isArray(inventory)) {
    throw new StateError('validation', 'Migration inventory must be an array.');
  }
  if (!Array.isArray(pending)) {
    throw new StateError('validation', 'Migration pending outbox must be an array.');
  }
  const pinned = new Set(plan.invalidates);
  const pendingById = new Map<string, OutboxIntent>();
  for (const intent of pending) {
    if (typeof intent !== 'object' || intent === null || Array.isArray(intent)) {
      throw new StateError('validation', 'Migration pending intents must be objects.');
    }
    if (typeof intent.intentId !== 'string' || intent.intentId === '') {
      throw new StateError('validation', 'Migration pending intent ids must be non-empty.');
    }
    pendingById.set(intent.intentId, intent);
  }
  const blocked: string[] = [];
  const retained: RetainedIntent[] = [];
  const invalidated: Array<{ intentId: string; handlerContract: string }> = [];
  const seen = new Set<string>();
  for (const item of inventory) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new StateError('validation', 'Migration inventory items must be objects.');
    }
    const intentId = item.intentId;
    const handlerContract = item.handlerContract;
    const state = item.state;
    if (typeof intentId !== 'string' || intentId === '') {
      throw new StateError('validation', 'Migration inventory intent ids must be non-empty.');
    }
    if (typeof handlerContract !== 'string' || handlerContract === '') {
      throw new StateError('validation', 'Migration inventory handler contracts must be non-empty.');
    }
    if (state !== 'undispatched' && state !== 'inflight' && state !== 'accepted' && state !== 'uncertain') {
      throw new StateError(
        'validation',
        `Migration inventory item ${JSON.stringify(intentId)} has unknown state.`,
      );
    }
    if (state === 'accepted' || state === 'uncertain') {
      blocked.push(intentId);
      continue;
    }
    const stored = pendingById.get(intentId) ?? null;
    if (stored === null) {
      throw new StateError(
        'validation',
        `Migration carry-over evidence changed under us (not pending): ${JSON.stringify(intentId)}.`,
      );
    }
    // Re-pin: a stored contract overrules attestation on mismatch.
    if (stored.handlerContract !== undefined && stored.handlerContract !== handlerContract) {
      throw new StateError(
        'validation',
        `Migration inventory contract mismatch for ${JSON.stringify(intentId)}: ` +
          `attested ${JSON.stringify(handlerContract)} but the outbox stores ` +
          `${JSON.stringify(stored.handlerContract)}.`,
      );
    }
    const effective = stored.handlerContract ?? handlerContract;
    if (state === 'undispatched' && pinned.has(effective)) {
      if (!seen.has(intentId)) {
        seen.add(intentId);
        invalidated.push({ intentId, handlerContract: effective });
      }
      continue;
    }
    if (!seen.has(intentId)) {
      seen.add(intentId);
      retained.push({ intentId, handlerContract: effective, state });
    }
  }
  if (blocked.length > 0) {
    blocked.sort();
    throw new StateError(
      'validation',
      `Migration cannot retain accepted or uncertain work ` +
        `(drain/reconcile first): ${blocked.map((id) => JSON.stringify(id)).join(', ')}.`,
    );
  }
  retained.sort((a, b) => (a.intentId < b.intentId ? -1 : a.intentId > b.intentId ? 1 : 0));
  return {
    retained: Object.freeze({
      intents: Object.freeze([...retained]),
      ids: Object.freeze(new Set(retained.map((entry) => entry.intentId))),
    }),
    invalidatedIntentIds: invalidated.map((entry) => entry.intentId),
    outcomes: invalidated.map((entry) => ({
      migrationId: plan.migrationId,
      kind: 'invalidated',
      intentId: entry.intentId,
      handlerContract: entry.handlerContract,
    })),
  };
}

/** Empty retained set (no exemptions — the gate behaves exactly as S7). */
export function emptyRetainedSet(): RetainedSet {
  const intents: ReadonlyArray<RetainedIntent> = Object.freeze([]);
  const ids: ReadonlySet<string> = Object.freeze(new Set<string>());
  return Object.freeze({ intents, ids });
}
