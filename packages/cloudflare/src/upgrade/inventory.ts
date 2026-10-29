/**
 * B25 pending-work inventory producer: State outbox rows plus dispatch
 * recovery-window rows become engine `WorkInventoryItem`s through Work's
 * `buildWorkInventory`.
 *
 * MAPPING (the attested deployment vocabulary): an item's handler contract
 * is its declaring capability operation path (`OutboxIntent.operation`,
 * e.g. `acme.worker`) — the same dotted vocabulary transition authors pin
 * with `{ kind: 'invalidate', handlerContract }` directives. An empty
 * operation maps to null, and the builder throws: activation blocks
 * rather than guessing a contract.
 *
 * JOIN (dispatch authoritative): producers insert the `work.dispatch` row
 * in the same fenced batch as the outbox intent, but only the dispatch
 * row advances through claimed/uncertain — the outbox row stays pending
 * until acked. So a claimed-but-unacked intent appears in `outboxPending`
 * with a stale undispatched view. The join reads the recovery window
 * (claimed + uncertain dispatch rows, paged to exhaustion) plus the
 * settled states (delivered/failed/dead) and merges by intent id:
 * dispatch lifecycle wins, so in-flight work inventories as inflight (and
 * blocks activation until drained) instead of passing as undispatched,
 * and settled-but-unacked work omits (a crash between delivery and ack
 * must not block upgrades forever, nor record false invalidate outcomes
 * for completed work). Dispatch-pending mirrors stay unread: outboxPending
 * covers live ones, and migration-skipped outbox rows keep stale pending
 * mirrors that must never re-inventory as undispatched.
 */
import type { OutboxIntent, OutboxItem, StoragePort, WorkInventoryItem } from '@canlang/contracts';
import { WORK_DISPATCH_MODEL, buildWorkInventory, dispatchRecoveryPageQuery, readDispatchLifecycleRow } from '@canlang/work';

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

/** Bounded recovery-window page; walked to exhaustion per state. */
const DISPATCH_SCAN_LIMIT = 100;
/** Livelock backstop: a supplier that never exhausts fails instead of looping. */
const DISPATCH_SCAN_MAX_PAGES = 10000;

/** Dispatch states that overlay the pending view with live lifecycle. */
const DISPATCH_OVERLAY_STATES = ['claimed', 'uncertain'] as const;

interface DispatchLifecycle {
  readonly intentId: string;
  readonly operationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  readonly originOccurrence: string | null;
  readonly attempts: number;
  readonly state: string;
}

async function scanDispatchPages(
  store: StoragePort,
  specFor: (after: string | null) => Parameters<StoragePort['query']>[0],
  want: (state: string) => boolean,
  pageLimit: number,
): Promise<DispatchLifecycle[]> {
  const rows: DispatchLifecycle[] = [];
  let after: string | null = null;
  for (let pages = 0; ; pages++) {
    if (pages >= DISPATCH_SCAN_MAX_PAGES) throw new Error('Upgrade inventory dispatch scan never exhausted its supplier.');
    const page = await store.query(specFor(after));
    for (const row of page) {
      const lifecycle = readDispatchLifecycleRow(row);
      if (want(lifecycle.state)) rows.push(lifecycle as DispatchLifecycle);
    }
    if (page.length < pageLimit) break;
    after = page[page.length - 1]!.id as string;
  }
  return rows;
}

async function scanRecoveryState(
  store: StoragePort,
  state: 'claimed' | 'uncertain',
  pageLimit: number,
): Promise<DispatchLifecycle[]> {
  return scanDispatchPages(store, after => dispatchRecoveryPageQuery(state, pageLimit, after),
    found => found === state, pageLimit);
}

/** Settled census: one id-paged scan over delivered/failed/dead. */
async function scanSettledStates(store: StoragePort, pageLimit: number): Promise<DispatchLifecycle[]> {
  const settled = new Set(['delivered', 'failed', 'dead']);
  return scanDispatchPages(store, after => ({
    model: WORK_DISPATCH_MODEL,
    where: { op: 'and', args: [
      { op: 'or', args: [...settled].map(state => ({ op: 'eq' as const, field: 'state', value: state })) },
      ...(after === null ? [] : [{ op: 'gt' as const, field: 'id', value: after }]),
    ] },
    order: [{ field: 'id', direction: 'asc' }],
    limit: pageLimit,
    authority: 'owner',
  }), found => settled.has(found), pageLimit);
}

/**
 * Dispatch lifecycle join rows: overlay items (claimed/uncertain) plus
 * settled intent ids (delivered/failed/dead). Arguments are absent at
 * this boundary (empty record, never reconstructed); the builder only
 * reads id/state/contract. Rows re-filter exactly on state: the query is
 * a performance window, the row is the truth.
 */
export async function dispatchItemsFromRecoveryWindow(
  store: StoragePort,
  pageLimit: number = DISPATCH_SCAN_LIMIT,
): Promise<{ readonly overlay: ReadonlyArray<OutboxItem>; readonly settled: ReadonlySet<string> }> {
  if (!Number.isInteger(pageLimit) || pageLimit < 1) throw new Error('Upgrade inventory scans dispatch with a positive integer page.');
  const overlay: OutboxItem[] = [];
  for (const state of DISPATCH_OVERLAY_STATES) {
    for (const lifecycle of await scanRecoveryState(store, state, pageLimit)) {
      overlay.push({
        id: lifecycle.intentId,
        operationId: lifecycle.operationId,
        source: lifecycle.source,
        occurrenceIndex: lifecycle.occurrenceIndex,
        request: {},
        originOccurrence: lifecycle.originOccurrence,
        attempts: lifecycle.attempts,
        state,
      });
    }
  }
  const settled = new Set<string>();
  for (const lifecycle of await scanSettledStates(store, pageLimit)) settled.add(lifecycle.intentId);
  return { overlay, settled };
}

/**
 * Build the activation inventory from a store's live pending outbox
 * joined with dispatch lifecycle (dispatch authoritative, settled omits).
 * Throws on unmappable rows (activation must block, never guess).
 */
export async function buildUpgradeInventory(
  store: StoragePort,
  handlerContractFor: (item: OutboxItem) => string | null = handlerContractForOutboxItem,
  options: { readonly dispatchPageLimit?: number } = {},
): Promise<WorkInventoryItem[]> {
  const byId = new Map<string, OutboxItem>();
  for (const item of outboxItemsFromPending(await store.outboxPending())) byId.set(item.id, item);
  const { overlay, settled } = await dispatchItemsFromRecoveryWindow(store, options.dispatchPageLimit ?? DISPATCH_SCAN_LIMIT);
  for (const id of settled) byId.delete(id);
  for (const item of overlay) byId.set(item.id, item);
  return buildWorkInventory({ outboxItems: [...byId.values()], handlerContractFor });
}
