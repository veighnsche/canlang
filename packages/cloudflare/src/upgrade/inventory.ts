/**
 * B25 pending-work inventory producer: State outbox rows become engine
 * `WorkInventoryItem`s through Work's `buildWorkInventory`.
 *
 * MAPPING (the attested deployment vocabulary): an item's handler contract
 * is its declaring capability operation path (`OutboxIntent.operation`,
 * e.g. `acme.worker`) — the same dotted vocabulary transition authors pin
 * with `{ kind: 'invalidate', handlerContract }` directives. An empty
 * operation maps to null, and the builder throws: activation blocks
 * rather than guessing a contract.
 *
 * SCOPE (loud): `outboxPending()` yields status-pending rows only, so the
 * produced inventory covers undispatched work exactly. Dispatch-layer
 * in-flight/uncertain rows (claimed but unacked) are invisible here; the
 * due-scan supplier join that drains them is a follow-up. Until it lands,
 * upgrades must quiesce dispatch out of band; the engine still fails loud
 * on anything inventoried but unsettled.
 */
import type { OutboxIntent, OutboxItem, StoragePort, WorkInventoryItem } from '@canlang/contracts';
import { buildWorkInventory } from '@canlang/work';

/**
 * Deployment-vocabulary mapping owed by L4/L7 attestation: the declaring
 * operation path, or null when the item carries none (fail closed).
 */
export function handlerContractForOutboxItem(item: OutboxItem): string | null {
  return typeof item.source === 'string' && item.source !== '' ? item.source : null;
}

/**
 * Adapt committed status-pending outbox rows to pending dispatch items.
 * Occurrence/attempt evidence is absent at the State boundary (null/0:
 * unstaged here); lifecycle beyond pending needs the dispatch supplier.
 */
export function outboxItemsFromPending(pending: ReadonlyArray<OutboxIntent>): OutboxItem[] {
  return pending.map((intent) => ({
    id: intent.intentId,
    operationId: intent.operationId,
    source: intent.operation,
    occurrenceIndex: intent.occurrenceIndex,
    request: intent.arguments,
    originOccurrence: null,
    attempts: 0,
    state: 'pending',
  }));
}

/**
 * Build the activation inventory from a store's live pending outbox.
 * Throws on unmappable rows (activation must block, never guess).
 */
export async function buildUpgradeInventory(
  store: StoragePort,
  handlerContractFor: (item: OutboxItem) => string | null = handlerContractForOutboxItem,
): Promise<WorkInventoryItem[]> {
  const pending = await store.outboxPending();
  return buildWorkInventory({ outboxItems: outboxItemsFromPending(pending), handlerContractFor });
}
