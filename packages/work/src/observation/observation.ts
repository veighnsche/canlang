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
  ReceiptError,
  ReceiptObservation,
  ReceiptProperty,
  ReceiptStatus,
} from '../../../contracts/src/work.js';
import type { ContentPolicyPort, GrantPort } from './ports.ts';

/**
 * Stored receipt as loaded by the owning record read. All fields are trusted
 * store output; only the shapes the kernel depends on are validated.
 */
export interface StoredReceipt {
  /** Delivery association id (completion envelopes carry it as `delivery_id`). */
  deliveryId: string;
  /** Owner checkpoint revision enrolling the observation in the read fence. */
  revision: number;
  /** Retained status summary. */
  status: ReceiptStatus;
  /** Declared typed result payload, or null when none is stored. */
  result: unknown;
  /** Stored closed error, or null when not failed / undisclosable. */
  error: ReceiptError | null;
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
