/**
 * Provenance binding for finalized files (DESIGN section 8).
 *
 * Request provenance binds the receiving app/team/storage owner, the
 * verified originating principal, the adapter, the delivery and the result
 * path; event provenance binds the configured source/adapter, the
 * authenticated event occurrence, the schema field path and the ordered
 * item position. Provenance is bound at receiving-app finalization and is
 * immutable afterwards: finalized records are frozen, and attachment/byte
 * reads re-check the caller against the bound owner, failing closed.
 */
import type {
  EventProvenance,
  FinalizedFile,
  RequestProvenance,
} from '../../../contracts/src/files.js';

/**
 * Resolved receiving identity: the app/team/owner/principal tuple the
 * runtime authenticated for this call. Real binding: the L6 identity
 * context (S8 join); tests resolve it through `TestOnlyFixedPrincipal`.
 * This shape is typed resolution, not invented auth: no tokens, passwords
 * or caller-supplied identity strings flow through it.
 */
export interface ReceivingContext {
  readonly app: string;
  readonly team: string;
  readonly owner: string;
  readonly principal: string;
}

/** Adapter/delivery/result-path binding for request provenance. */
export interface RequestProvenanceBinding {
  readonly adapter: string;
  readonly deliveryId: string;
  readonly resultPath: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** True when every receiving-identity field matches. */
export function isSameReceiver(a: ReceivingContext, b: ReceivingContext): boolean {
  return (
    a.app === b.app &&
    a.team === b.team &&
    a.owner === b.owner &&
    a.principal === b.principal
  );
}

/**
 * Bind request provenance for the receiving app. Returns null (fail
 * closed) when any identity or binding field is missing.
 */
export function bindRequestProvenance(
  receiver: ReceivingContext,
  binding: RequestProvenanceBinding,
): RequestProvenance | null {
  if (
    !isNonEmptyString(receiver.app) ||
    !isNonEmptyString(receiver.team) ||
    !isNonEmptyString(receiver.owner) ||
    !isNonEmptyString(receiver.principal) ||
    !isNonEmptyString(binding.adapter) ||
    !isNonEmptyString(binding.deliveryId) ||
    !isNonEmptyString(binding.resultPath)
  ) {
    return null;
  }
  return {
    kind: 'request',
    app: receiver.app,
    team: receiver.team,
    owner: receiver.owner,
    principal: receiver.principal,
    adapter: binding.adapter,
    deliveryId: binding.deliveryId,
    resultPath: binding.resultPath,
  };
}

/** True when the caller is the provenance-bound receiver. */
export function requestProvenanceMatches(
  provenance: RequestProvenance,
  caller: ReceivingContext,
): boolean {
  return (
    provenance.app === caller.app &&
    provenance.team === caller.team &&
    provenance.owner === caller.owner &&
    provenance.principal === caller.principal
  );
}

/**
 * Strict event-provenance validation for the verified-ingress path.
 * Returns null (fail closed) for any malformed shape; occurrence and
 * field identities are opaque strings that are never dereferenced here.
 */
export function validateEventProvenance(value: unknown): EventProvenance | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'event') {
    return null;
  }
  const source = record['source'];
  const adapter = record['adapter'];
  const occurrenceId = record['occurrenceId'];
  const fieldPath = record['fieldPath'];
  const itemIndex = record['itemIndex'];
  if (
    !isNonEmptyString(source) ||
    !isNonEmptyString(adapter) ||
    !isNonEmptyString(occurrenceId) ||
    !isNonEmptyString(fieldPath) ||
    typeof itemIndex !== 'number' ||
    !Number.isSafeInteger(itemIndex) ||
    itemIndex < 0
  ) {
    return null;
  }
  return {
    kind: 'event',
    source,
    adapter,
    occurrenceId,
    fieldPath,
    itemIndex,
  };
}

/**
 * Freeze a finalized record: provenance first, then the record itself.
 * The same object is returned for convenience; it must never be mutated
 * afterwards. Content is never overwritten and replacing a reference
 * never overwrites bytes.
 */
export function freezeFinalized(file: FinalizedFile): FinalizedFile {
  Object.freeze(file.provenance);
  Object.freeze(file);
  return file;
}
