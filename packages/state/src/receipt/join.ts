/**
 * T25-L3 receipt join: the selected-receipt read through the real store.
 *
 * The L3 half of the T25a contract: persists associations/receipts (via
 * `tables.ts`), resolves `{record, field}` locators to stored records,
 * binds record/actor grant closures plus the retention port, calls the
 * injected T25a `observeSelectedReceipt`, and enrolls `fenceRevision`
 * in the owner read fence.
 *
 * The owning work producer is injected through the structural observation
 * port. State stays independent of work; cross-producer join proofs live in
 * work's test suite and supply its real compiled observation mechanism.
 *
 * Evaluation order: locator resolution (throws) → selected-shape
 * validation (throws) → declared-delivery-field check (throws) →
 * fence-join read (conflicts when the checkpoint moved) → owner load
 * (not_found) → leaf-grant resolution (record + actor + policy, never presence)
 * → denial → current-field agreement + association/receipt loads →
 * the injected observation (deny-before-presence, null-means-null) →
 * fence enrollment (receipt row iff observed with a non-null
 * fenceRevision; id-only, denied and null reads enroll nothing).
 */
import type {
  ReceiptAssociation,
  ReceiptError,
  ReceiptProperty,
  ReceiptStatus,
  SelectedReceiptProjection,
} from '@canlang/contracts';
import type {
  ModelName,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { FenceScope } from '../invocation/admission.js';
import { StateError } from '../errors.js';
import type { MembershipReader } from '../policy/roles.js';
import type { PolicyTable } from '../policy/grants.js';
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  associationRowId,
  readAssociationRow,
  readReceiptRow,
} from './tables.js';
import {
  assertDeliveryField,
  createRetentionContentPolicy,
  createSelectedGrants,
  resolveLeafGrantPaths,
  type DeliveryFieldSchema,
  type JoinCaller,
  type JoinContentPolicyPort,
  type JoinGrantPort,
} from './grants.js';

/**
 * Structural mirror of the work-side `StoredReceipt`: the retained
 * receipt plus the opaque result-content handle (null when no
 * separately-retained content exists).
 */
export interface JoinStoredReceipt {
  readonly deliveryId: string;
  readonly revision: number;
  readonly status: ReceiptStatus;
  readonly result: unknown;
  readonly error: ReceiptError | null;
  readonly contentRef: string | null;
}

/**
 * Structural mirror of the work-side `SelectedReceiptInput`: the
 * locator (resolved and validated inside the mechanism), the
 * statically resolved selected leaves, the store-supplied association
 * and receipt (null exactly together), and the injected ports.
 */
export interface JoinObserverInput {
  readonly locator: unknown;
  readonly selected: readonly ReceiptProperty[];
  readonly association: ReceiptAssociation | null;
  readonly receipt: JoinStoredReceipt | null;
  readonly grants: JoinGrantPort;
  readonly content: JoinContentPolicyPort;
  readonly nowMs: number;
}

/**
 * Structural mirror of the work-side `SelectedReceiptOutcome`:
 * authorized observation (the projection carries exactly the selected
 * leaves; `fenceRevision` is the owner revision to enroll, null for
 * id-only reads), authorized null association, or leaf denial.
 */
export type JoinObserverOutcome =
  | {
      readonly outcome: 'observed';
      readonly projection: SelectedReceiptProjection;
      readonly fenceRevision: number | null;
    }
  | { readonly outcome: 'null-association' }
  | { readonly outcome: 'denied'; readonly denied: readonly ReceiptProperty[] };

/**
 * The injected T25a selected-receipt entry (structural mirror of
 * `observeSelectedReceipt`). Production wiring binds the real
 * function; see the module header.
 */
export type SelectedReceiptObserver = (input: JoinObserverInput) => JoinObserverOutcome;

/** Resolved join locator: the owning record's store id plus the delivery field. */
export interface JoinLocator {
  readonly recordId: string;
  readonly field: string;
}

const LOCATOR_KEYS: ReadonlySet<string> = new Set(['record', 'field']);

/**
 * Resolve the `{record, field}` locator shape. An exact mirror of the
 * work-side locator rules — exactly `{record, field}` (extra keys
 * rejected, never ignored), `record` the non-null owning-record
 * object (a text id is the forbidden raw-ID cast), `field` a plain
 * declared name (traversal rejected, never resolved) — plus the L3
 * record-identity rule: the record object carries its store identity
 * as a string `id`, which is the ONLY lookup key (no caller-supplied
 * model/ID/traversal string is ever trusted). The injected mechanism
 * re-validates the original locator authoritatively; this mirror only
 * loads rows, so any divergence still fails closed inside.
 */
export function resolveJoinLocator(locator: unknown): JoinLocator {
  if (typeof locator !== 'object' || locator === null || Array.isArray(locator)) {
    throw new TypeError('resolveJoinLocator: locator must be a {record, field} object');
  }
  const input = locator as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!LOCATOR_KEYS.has(key)) {
      throw new RangeError(`resolveJoinLocator: unknown locator key ${JSON.stringify(key)}`);
    }
  }
  const record: unknown = input['record'];
  if (typeof record === 'string') {
    throw new TypeError(
      'resolveJoinLocator: record must be the owning record object, never a text id',
    );
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new TypeError('resolveJoinLocator: record must be a non-null object');
  }
  const field: unknown = input['field'];
  if (typeof field !== 'string') {
    throw new TypeError('resolveJoinLocator: field must be a string');
  }
  if (field.length === 0) {
    throw new RangeError('resolveJoinLocator: field must be non-empty');
  }
  if (field.includes('.') || field.includes('[') || field.includes(']')) {
    throw new RangeError('resolveJoinLocator: field must be a plain name, never traversal');
  }
  const recordId: unknown = (record as Record<string, unknown>)['id'];
  if (typeof recordId !== 'string' || recordId === '') {
    throw new TypeError(
      'resolveJoinLocator: record must carry its store identity as a string id',
    );
  }
  return { recordId, field };
}

const KNOWN_PROPERTIES: ReadonlySet<string> = new Set(['id', 'status', 'result', 'error']);

/**
 * Validate the selected-leaf shape up front (mirror of the mechanism's
 * rule: an array, non-empty — no default "return every property" —
 * known leaves only), so misshapen selections throw before any store
 * read. The mechanism re-validates authoritatively.
 */
function assertJoinSelected(selected: readonly ReceiptProperty[]): void {
  if (!Array.isArray(selected)) {
    throw new TypeError('selected leaves must be an array');
  }
  if (selected.length === 0) {
    throw new RangeError('selected leaves must not be empty');
  }
  for (const property of selected) {
    if (!KNOWN_PROPERTIES.has(property)) {
      throw new RangeError(`unknown selected property ${String(property)}`);
    }
  }
}

/** One selected-receipt join read. */
export interface SelectedReceiptJoinInput {
  /** Locator input (`{record, field}`), resolved and validated inside. */
  readonly locator: unknown;
  /** Statically resolved selected leaves; must be non-empty. */
  readonly selected: readonly ReceiptProperty[];
  /**
   * Owning model, statically resolved by the caller against the
   * record's canonical schema (never taken from the locator, which
   * carries no model string).
   */
  readonly model: ModelName;
  /** Declared delivery fields per model (the canonical-schema source). */
  readonly schema: DeliveryFieldSchema;
  /** Capability.operation from the same checked owning delivery declaration. */
  readonly declaredSource: string;
  /** Grant source: the declared per-model policy table. */
  readonly policy: PolicyTable;
  readonly caller: JoinCaller;
  readonly memberships: MembershipReader;
  readonly store: StoragePort;
  /** Owner read fence to enroll the receipt observation in, if any. */
  readonly fence?: FenceScope;
  /** Current time as UTC epoch ms (expiry checks only). */
  readonly nowMs: number;
  /** Injected T25a entry (the real `observeSelectedReceipt` in prod). */
  readonly observeSelected: SelectedReceiptObserver;
}

export type SelectedReceiptJoinOutcome =
  /**
   * Authorized observation: the projection carries exactly the selected
   * leaves, and `fenceRevision` is the enrolled owner revision (null
   * for id-only reads, which enroll nothing).
   */
  | {
      readonly outcome: 'observed';
      readonly projection: SelectedReceiptProjection;
      readonly fenceRevision: number | null;
      readonly readRevision: Revision;
    }
  /** Authorized null association: no receipt, no fence enrollment. */
  | { readonly outcome: 'null-association'; readonly readRevision: Revision }
  /** At least one selected leaf denied; reveals nothing else. */
  | {
      readonly outcome: 'denied';
      readonly denied: readonly ReceiptProperty[];
      readonly readRevision: Revision;
    };

/**
 * Observe one selected receipt through its record/field locator on the
 * real store. Resolves the locator to the CURRENT stored owner row
 * and requires its canonical delivery value to agree with the stored
 * association and checked owning declaration after authorization,
 * resolves leaf grants over record + actor + policy, and runs the
 * injected T25a observation — so deny-before-presence, null-means-null
 * and exact-leaf projection hold exactly as the mechanism pins them.
 *
 * Fence: a read whose checkpoint already moved conflicts before any
 * row is consulted (the engine precedent); an observed read with a
 * non-null `fenceRevision` enrolls the CURRENT receipt row in the
 * owner read fence, so receipt progress (which never touches the owner
 * row) still voids concurrent observations at commit time. Id-only,
 * denied and null reads enroll nothing.
 *
 * Loud plain `Error`s mark store disagreement (missing receipt for a
 * stored association, locator drift) or the mechanism's own trusted
 * agreement failures; caller errors are `StateError`s.
 */
export async function observeSelectedReceiptJoin(
  input: SelectedReceiptJoinInput,
): Promise<SelectedReceiptJoinOutcome> {
  const { recordId, field } = resolveJoinLocator(input.locator);
  assertJoinSelected(input.selected);
  assertDeliveryField(input.schema, input.model, field);
  // Fence revision FIRST: every row below is read at or after this
  // checkpoint, and a moved checkpoint conflicts rather than silently
  // reading newer than the operation's other reads.
  const readRevision = await input.store.readRevision();
  if (input.fence !== undefined && input.fence.revision !== readRevision) {
    throw new StateError(
      'conflict',
      `Fence checkpoint moved before this read (enrolled at revision ${input.fence.revision}, ` +
        `now at ${readRevision}); re-fence the operation.`,
    );
  }
  const owner = await input.store.load(input.model, recordId as RecordId);
  if (owner === null) {
    throw new StateError('not_found', 'Receipt owner record not found.');
  }
  const paths = await resolveLeafGrantPaths({
    policy: input.policy,
    model: input.model,
    caller: input.caller,
    memberships: input.memberships,
    row: owner,
  });
  const policyGrants = createSelectedGrants({ field, paths });
  const selectedVerdicts = new Map<ReceiptProperty, boolean>();
  for (const property of new Set(input.selected)) {
    selectedVerdicts.set(property,
      policyGrants.mayObserve(property, { field, deliveryId: null, revision: null }));
  }
  const denied = [...selectedVerdicts].filter(([, allowed]) => !allowed).map(([property]) => property);
  const grants: JoinGrantPort = {
    mayObserve: (property, context) => context.field === field && selectedVerdicts.get(property) === true,
  };
  if (denied.length !== 0) {
    return { outcome: 'denied', denied, readRevision };
  }
  if (typeof input.declaredSource !== 'string' || input.declaredSource.length === 0) {
    throw new Error('receipt join: missing declared delivery source');
  }
  const current: unknown = (owner.data as Record<string, unknown>)[field];
  let delivery: { id: string; operation: string } | null = null;
  if (current !== null && current !== undefined) {
    if (
      typeof current !== 'object' || Array.isArray(current) ||
      (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) ||
      Reflect.ownKeys(current).length !== 2 ||
      !Object.hasOwn(current, 'id') || !Object.hasOwn(current, 'operation') ||
      typeof (current as Record<string, unknown>)['id'] !== 'string' ||
      (current as Record<string, unknown>)['id'] === '' ||
      typeof (current as Record<string, unknown>)['operation'] !== 'string' ||
      (current as Record<string, unknown>)['operation'] === ''
    ) {
      throw new Error('receipt join: malformed current owner delivery field');
    }
    delivery = current as { id: string; operation: string };
    if (delivery.operation !== input.declaredSource) {
      throw new Error('receipt join: current owner delivery source disagrees with its declaration');
    }
  }
  const associationId = associationRowId(input.model as string, recordId, field);
  const associationRow = await input.store.load(
    RECEIPT_ASSOCIATION_MODEL as ModelName,
    associationId as RecordId,
  );
  let association: ReceiptAssociation | null = null;
  let receipt: JoinStoredReceipt | null = null;
  let receiptRow: StoredRow | null = null;
  let contentRef: string | null = null;
  let resultExpiresAtMs: number | null = null;
  if (associationRow !== null) {
    const stored = readAssociationRow(associationRow);
    if (stored.locator.recordId !== recordId || stored.locator.field !== field) {
      // Unreachable by construction (the row id IS the locator
      // derivation and the reader checks it): loud, never guessed.
      throw new Error('receipt join: association locator disagrees with the resolved locator');
    }
    if (delivery === null || delivery.id !== stored.deliveryId ||
        delivery.operation !== stored.source || stored.source !== input.declaredSource) {
      throw new Error('receipt join: current owner delivery disagrees with the stored association');
    }
    const row = await input.store.load(RECEIPT_MODEL as ModelName, stored.deliveryId as RecordId);
    if (row === null) {
      throw new Error('receipt join: missing receipt row for the stored association');
    }
    const retained = readReceiptRow(row);
    association = stored;
    receipt = { ...retained.receipt, contentRef: retained.contentRef };
    receiptRow = row;
    contentRef = retained.contentRef;
    resultExpiresAtMs = retained.resultExpiresAtMs;
  }
  if (associationRow === null && delivery !== null) {
    throw new Error('receipt join: missing association for the current owner delivery');
  }
  const outcome = input.observeSelected({
    // The ORIGINAL locator: the mechanism re-validates it
    // authoritatively; the mirror above only loaded rows.
    locator: input.locator,
    selected: input.selected,
    association,
    receipt,
    grants,
    content: createRetentionContentPolicy({ contentRef, resultExpiresAtMs }),
    nowMs: input.nowMs,
  });
  if (
    outcome.outcome === 'observed' &&
    outcome.fenceRevision !== null &&
    input.fence !== undefined &&
    receiptRow !== null
  ) {
    input.fence.enroll({
      kind: 'record',
      model: RECEIPT_MODEL as ModelName,
      id: receiptRow.id,
      version: receiptRow.version,
    });
  }
  return { ...outcome, readRevision };
}
