/**
 * Receipt observation: authorized immutable reads of a stored delivery receipt.
 *
 * Pure projection kernel. The caller supplies the already-loaded stored
 * receipt: a text id alone grants no lookup, so this module has no store port
 * and performs no fetch — observed values flow only from the input object,
 * and withheld content is never reconstructed, redelivered or rerun.
 *
 * Leaf projection rules:
 *
 * - `id` is always the stored delivery id. The stored-receipt input embodies
 *   the containing record/field authorization, so the association is readable
 *   by construction whenever this function is called.
 * - `revision` always echoes the enrolled owner checkpoint revision, so the
 *   read fence can invalidate on intervening updates (`held.revision !==
 *   current.revision` retries evaluation; the comparison itself is the
 *   runtime fence's job, not this kernel's).
 * - `status` is always the true stored status: gating result/error never
 *   changes it. The contract type cannot represent a withheld status
 *   (`ReceiptStatus` is non-nullable) and fabricating a different status is
 *   forbidden, so readers without the status grant are handled by the
 *   projection layer above (S8/runtime), which omits the field for
 *   unauthorized readers.
 * - `result` discloses the stored payload only when the leaf is requested
 *   AND granted AND its content is available; otherwise null. A null
 *   `contentRef` marks inline content retained with the summary (always
 *   available, policy not consulted); a non-null ref is checked against the
 *   injected content policy at the injected `nowMs`.
 * - `error` discloses the stored closed error only when requested AND
 *   granted; otherwise null. Withholding beyond grants is out of scope here:
 *   the store supplies the disclosable closed error or null.
 *
 * Observed (status, result, error) triples (requested + granted leaves):
 *
 * - `(pending, null, null)`: no outcome yet.
 * - `(succeeded, R, null)` with R non-null: succeeded, result disclosed.
 * - `(succeeded, null, null)`: succeeded with NO disclosed result. Covers
 *   three intentionally indistinguishable cases: (a) withheld/expired result
 *   content, (b) result leaf ungranted or unrequested, (c) an operation whose
 *   declared result is genuinely null. Distinguishing (a)/(b) would disclose
 *   the withholding reason or hidden-value existence; all three present as
 *   succeeded with the shared null caption. Always distinguishable from
 *   pending/failed/skipped via status.
 * - `(failed, null, E)` with E non-null: failed, closed error disclosed.
 * - `(failed, null, null)`: failed with undisclosed error (leaf ungranted or
 *   unrequested); a stored error may exist but is not disclosed.
 * - `(unknown, null, E|null)`: uncertain acceptance; diagnostic error or null.
 * - `(skipped, null, null)`: never dispatched; nothing to disclose.
 *
 * Port-consultation contract (pinned by tests): `GrantPort` is consulted
 * exactly once per unique requested leaf in {`result`, `error`} — never for
 * unrequested leaves and never for `id`/`status`. `ContentPolicyPort` is
 * consulted exactly once iff the result leaf is requested and granted, the
 * stored result is non-null, and `contentRef` is non-null.
 */
import type {
  AssociatedReceipt,
  ReceiptAssociation,
  ReceiptError,
  ReceiptObservation,
  ReceiptProperty,
  ReceiptStatus,
  SelectedReceiptProjection,
} from '../../../contracts/src/work.js';
import type {
  ContentPolicyPort,
  GrantPort,
  SelectedGrantContext,
  SelectedGrantPort,
} from './ports.ts';
import { assertKnownProgressRelation, resolveAssociationLocator } from './association.ts';

/**
 * Stored receipt as loaded by the owning record read: the retained
 * `AssociatedReceipt` row plus the opaque result-content handle. All fields
 * are trusted store output; only the shapes the kernel depends on are
 * validated.
 */
export interface StoredReceipt extends AssociatedReceipt {
  /**
   * Opaque result-content handle for expiry/withholding checks, or null when
   * no separately-retained content exists (inline/genuinely-null result).
   */
  contentRef: string | null;
}

export interface ObserveReceiptInput {
  /** Already-loaded stored receipt. Never fetched by id inside this kernel. */
  receipt: StoredReceipt;
  /** Projection request: leaves the caller wants disclosed. */
  requested: readonly ReceiptProperty[];
  /** Injected leaf-grant decisions. */
  grants: GrantPort;
  /** Injected result-content availability. */
  content: ContentPolicyPort;
  /** Injected current time as UTC epoch ms (expiry checks only). */
  nowMs: number;
}

const KNOWN_PROPERTIES: ReadonlySet<string> = new Set(['id', 'status', 'result', 'error']);

function assertStoredReceipt(receipt: StoredReceipt): void {
  if (typeof receipt.deliveryId !== 'string' || receipt.deliveryId.length === 0) {
    throw new RangeError('observeReceipt: receipt.deliveryId must be a non-empty string');
  }
  if (!Number.isInteger(receipt.revision) || receipt.revision < 0) {
    throw new RangeError('observeReceipt: receipt.revision must be a non-negative integer');
  }
}

/**
 * Project one immutable authorized receipt observation from a stored receipt.
 * Pure: no fetch, no refill, no clock read — all authority arrives via the
 * input and the injected ports.
 */
export function observeReceipt(input: ObserveReceiptInput): ReceiptObservation {
  assertStoredReceipt(input.receipt);
  if (!Number.isFinite(input.nowMs) || input.nowMs < 0) {
    throw new RangeError('observeReceipt: nowMs must be finite and >= 0');
  }
  for (const property of input.requested) {
    if (!KNOWN_PROPERTIES.has(property)) {
      throw new RangeError(`observeReceipt: unknown requested property ${String(property)}`);
    }
  }
  const requested = new Set<ReceiptProperty>(input.requested);
  const context = { deliveryId: input.receipt.deliveryId, revision: input.receipt.revision };

  let result: unknown = null;
  if (requested.has('result') && input.grants.mayObserve('result', context)) {
    const stored: unknown = input.receipt.result ?? null;
    if (stored !== null) {
      if (input.receipt.contentRef === null) {
        result = stored;
      } else {
        if (
          typeof input.receipt.contentRef !== 'string' ||
          input.receipt.contentRef.length === 0
        ) {
          throw new RangeError('observeReceipt: receipt.contentRef must be a non-empty string');
        }
        result = input.content.isResultAvailable(input.receipt.contentRef, input.nowMs)
          ? stored
          : null;
      }
    }
  }

  const error: ReceiptError | null =
    requested.has('error') && input.grants.mayObserve('error', context)
      ? input.receipt.error
      : null;

  return {
    id: input.receipt.deliveryId,
    revision: input.receipt.revision,
    status: input.receipt.status,
    result,
    error,
  };
}

/* -- T25a selected receipt reads: authorize every leaf, project exactly it. -- */

/**
 * Selected-leaf authorization verdict. Authorization is all-or-nothing:
 * every selected leaf must be granted before the read succeeds, and a
 * denied read never returns a successful object silently missing a
 * requested property.
 */
export type SelectedLeavesVerdict =
  /** Every unique selected leaf granted, in first-selected order. */
  | { authorized: true; leaves: readonly ReceiptProperty[] }
  /** At least one selected leaf denied, in first-selected order. */
  | { authorized: false; denied: readonly ReceiptProperty[] };

function assertSelectedLeaves(selected: readonly ReceiptProperty[]): ReceiptProperty[] {
  if (!Array.isArray(selected)) {
    throw new TypeError('selected leaves must be an array');
  }
  if (selected.length === 0) {
    // No default "return every property" exists: an empty selection is a
    // generator bug, never an implicit full disclosure.
    throw new RangeError('selected leaves must not be empty');
  }
  const leaves: ReceiptProperty[] = [];
  const seen = new Set<ReceiptProperty>();
  for (const property of selected) {
    if (!KNOWN_PROPERTIES.has(property)) {
      throw new RangeError(`unknown selected property ${String(property)}`);
    }
    if (!seen.has(property)) {
      seen.add(property);
      leaves.push(property);
    }
  }
  return leaves;
}

/**
 * Authorize one selected-leaf set against the field-scoped grant port.
 * Consults the port exactly once per unique selected leaf — including `id`
 * and `status` — in first-selected order.
 */
export function authorizeSelectedLeaves(
  selected: readonly ReceiptProperty[],
  grants: SelectedGrantPort,
  context: SelectedGrantContext,
): SelectedLeavesVerdict {
  const leaves = assertSelectedLeaves(selected);
  const denied: ReceiptProperty[] = [];
  for (const property of leaves) {
    if (grants.mayObserve(property, context) !== true) {
      denied.push(property);
    }
  }
  return denied.length === 0
    ? { authorized: true, leaves }
    : { authorized: false, denied };
}

/**
 * Project exactly the selected leaves from one full observation. The output
 * carries precisely the unique selected keys: unselected leaves are absent
 * keys, never null placeholders. Unknown leaves throw; an empty selection
 * projects to an empty object (the strict entry rejects it earlier).
 */
export function projectSelectedLeaves(
  observation: ReceiptObservation,
  selected: readonly ReceiptProperty[],
): SelectedReceiptProjection {
  if (!Array.isArray(selected)) {
    throw new TypeError('projectSelectedLeaves: selected must be an array');
  }
  const projection: SelectedReceiptProjection = {};
  const seen = new Set<ReceiptProperty>();
  for (const property of selected) {
    if (!KNOWN_PROPERTIES.has(property)) {
      throw new RangeError(`projectSelectedLeaves: unknown selected property ${String(property)}`);
    }
    if (seen.has(property)) {
      continue;
    }
    seen.add(property);
    if (property === 'id') {
      projection.id = observation.id;
    } else if (property === 'status') {
      projection.status = observation.status;
    } else if (property === 'result') {
      projection.result = observation.result;
    } else {
      projection.error = observation.error;
    }
  }
  return projection;
}

/**
 * Mutable selected properties (`status`/`result`/`error`) enroll the
 * receipt revision in the owner read fence; an id-only lookup needs no
 * mutable-status precondition and enrolls nothing.
 */
export function selectedRequiresFence(selected: readonly ReceiptProperty[]): boolean {
  if (!Array.isArray(selected)) {
    throw new TypeError('selectedRequiresFence: selected must be an array');
  }
  for (const property of selected) {
    if (!KNOWN_PROPERTIES.has(property)) {
      throw new RangeError(`selectedRequiresFence: unknown selected property ${String(property)}`);
    }
    if (property === 'status' || property === 'result' || property === 'error') {
      return true;
    }
  }
  return false;
}

export interface SelectedReceiptInput {
  /** Locator input (`{record, field}`), resolved and validated inside. */
  locator: unknown;
  /** Statically resolved selected leaves; must be non-empty. */
  selected: readonly ReceiptProperty[];
  /** Store-supplied current association, or null when unassociated. */
  association: ReceiptAssociation | null;
  /** Store-supplied receipt row; null exactly when unassociated. */
  receipt: StoredReceipt | null;
  /** Injected field-scoped leaf-grant decisions. */
  grants: SelectedGrantPort;
  /** Injected result-content availability. */
  content: ContentPolicyPort;
  /** Injected current time as UTC epoch ms (expiry checks only). */
  nowMs: number;
}

export type SelectedReceiptOutcome =
  /**
   * Authorized observation: the projection carries exactly the selected
   * leaves, and `fenceRevision` is the owner revision to enroll in the
   * read fence (null for id-only reads, which enroll nothing).
   */
  | { outcome: 'observed'; projection: SelectedReceiptProjection; fenceRevision: number | null }
  /** Authorized null association: no receipt, no fence enrollment. */
  | { outcome: 'null-association' }
  /** At least one selected leaf denied; reveals nothing else. */
  | { outcome: 'denied'; denied: readonly ReceiptProperty[] };

/**
 * Pre-authorized mechanics for the selected entry: leaf grants were already
 * decided by `authorizeSelectedLeaves`, so the shared `observeReceipt`
 * projection runs with grants that accept. Module-private and never a
 * policy decision point — never export it, never consult it directly.
 */
const PRE_AUTHORIZED_GRANTS: GrantPort = {
  mayObserve: () => true,
};

/**
 * Observe one selected receipt through its record/field locator. Pure: no
 * fetch, no refill, no clock read — the store supplies the association and
 * receipt, and all authority arrives via the injected ports.
 *
 * Evaluation order (pinned by tests): locator resolution (throws) →
 * selected-shape validation (throws) → trusted store agreement (throws) →
 * leaf authorization (verdict) → presence branch → projection. Grants are
 * consulted before presence branches, so a denied read reveals nothing
 * about whether an association exists; null means an actually null
 * association, never denied access.
 *
 * The L3 join persists associations/receipts, resolves locators to stored
 * records, binds record/actor grant closures and enrolls `fenceRevision`
 * in the owner read fence; the L1 join checks selected leaves against
 * declared observation schemas. Both ride after T18.
 */
export function observeSelectedReceipt(input: SelectedReceiptInput): SelectedReceiptOutcome {
  const resolved = resolveAssociationLocator(input.locator);
  const leaves = assertSelectedLeaves(input.selected);
  const { association, receipt } = input;
  if ((association === null) !== (receipt === null)) {
    throw new Error(
      'observeSelectedReceipt: association and receipt must agree on null presence',
    );
  }
  if (association !== null && receipt !== null) {
    assertStoredReceipt(receipt);
    if (typeof association.deliveryId !== 'string' || association.deliveryId.length === 0) {
      throw new RangeError('observeSelectedReceipt: association.deliveryId must be non-empty');
    }
    if (!Number.isInteger(association.revision) || association.revision < 0) {
      throw new RangeError(
        'observeSelectedReceipt: association.revision must be a non-negative integer',
      );
    }
    if (receipt.deliveryId !== association.deliveryId) {
      throw new Error('observeSelectedReceipt: receipt does not belong to the association');
    }
    if (receipt.revision !== association.revision) {
      throw new Error('observeSelectedReceipt: receipt revision disagrees with the association');
    }
  }
  const context: SelectedGrantContext = {
    field: resolved.field,
    deliveryId: association === null ? null : association.deliveryId,
    revision: association === null ? null : association.revision,
  };
  const verdict = authorizeSelectedLeaves(leaves, input.grants, context);
  if (!verdict.authorized) {
    return { outcome: 'denied', denied: verdict.denied };
  }
  if (association === null || receipt === null) {
    return { outcome: 'null-association' };
  }
  const observed = observeReceipt({
    receipt,
    requested: leaves,
    grants: PRE_AUTHORIZED_GRANTS,
    content: input.content,
    nowMs: input.nowMs,
  });
  return {
    outcome: 'observed',
    projection: projectSelectedLeaves(observed, leaves),
    fenceRevision: selectedRequiresFence(leaves) ? association.revision : null,
  };
}

/* -- T26 correlated progress reads: every observation names its relation. -- */

export interface RelatedProgressReadInput extends SelectedReceiptInput {
  /** Trusted relation binding for the association under observation. */
  relation: string;
}

export type RelatedProgressReadOutcome =
  /** Authorized observation; late reads after terminal see retained truth. */
  | {
      outcome: 'observed';
      relation: string;
      projection: SelectedReceiptProjection;
      fenceRevision: number | null;
    }
  /** Authorized null association: no receipt, no fence enrollment. */
  | { outcome: 'null-association'; relation: string }
  /** At least one selected leaf denied; reveals nothing else. */
  | { outcome: 'denied'; relation: string; denied: readonly ReceiptProperty[] };

/**
 * Observe one relation's selected receipt progress through its
 * record/field locator. The trusted relation binding is validated
 * (unknown relations throw as a declaration bug) and echoed on every
 * outcome, so each observation correlates to exactly one matching T13
 * declaration; all authorization, projection and fence mechanics are
 * the existing selected-receipt read, unchanged.
 */
export function observeRelatedProgress(
  input: RelatedProgressReadInput,
): RelatedProgressReadOutcome {
  const bound = assertKnownProgressRelation(input.relation, 'observeRelatedProgress');
  const outcome = observeSelectedReceipt(input);
  if (outcome.outcome === 'observed') {
    return {
      outcome: 'observed',
      relation: bound,
      projection: outcome.projection,
      fenceRevision: outcome.fenceRevision,
    };
  }
  if (outcome.outcome === 'null-association') {
    return { outcome: 'null-association', relation: bound };
  }
  return { outcome: 'denied', relation: bound, denied: outcome.denied };
}
