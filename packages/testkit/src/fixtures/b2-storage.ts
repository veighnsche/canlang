/**
 * B2 storage-journey fixtures (L7): fenced-batch builders and storage
 * error guards for the D1 rollback/fence-conflict spec. Pure data
 * helpers over the owned `state.ts` contract types; no producer
 * imports, so this module stays in the testkit emit.
 */

import type {
  CommitBatch,
  HistoryEntry,
  ModelName,
  OperationId,
  OperationName,
  Receipt,
  ReceiptIdentity,
  ReceiptOutcome,
  RecordId,
  RecordVersion,
  Revision,
  StoredRow,
} from "@canlang/contracts";

/** Brand a revision without inventing a constructor. */
export function b2Revision(value: number): Revision {
  return value as Revision;
}

/** One stored row literal for journey batches (D1 asserts the shape). */
export function b2StoredRow(input: {
  id: string;
  version: number;
  actor: string;
  at: number;
  data: Readonly<Record<string, unknown>>;
}): StoredRow {
  return {
    id: input.id as RecordId,
    version: input.version as RecordVersion,
    created: input.at,
    updated: input.at,
    createdBy: input.actor,
    updatedBy: input.actor,
    archivedAt: null,
    data: { ...input.data },
  };
}

/** One history entry literal staged with its originating write. */
export function b2HistoryEntry(input: {
  model: string;
  recordId: string;
  version: number;
  operation: string;
  operationId: string;
  actor: string;
  at: number;
  change: HistoryEntry["change"];
  before: Readonly<Record<string, unknown>> | null;
  after: Readonly<Record<string, unknown>> | null;
}): HistoryEntry {
  return {
    model: input.model as ModelName,
    recordId: input.recordId as RecordId,
    version: input.version as RecordVersion,
    operation: input.operation as OperationName,
    operationId: input.operationId as OperationId,
    actor: input.actor,
    at: input.at,
    change: input.change,
    before: input.before === null ? null : { ...input.before },
    after: input.after === null ? null : { ...input.after },
  };
}

/** A committed-outcome receipt literal for replay-identity rows. */
export function b2Receipt(input: {
  app: string;
  owner: string;
  principal: string;
  operation: string;
  operationId: string;
  inputHash: string;
  revision: number;
  at: number;
}): Receipt {
  const identity: ReceiptIdentity = {
    app: input.app,
    owner: input.owner,
    principal: input.principal,
    operation: input.operation as OperationName,
    operationId: input.operationId as OperationId,
  };
  const outcome: ReceiptOutcome = { status: "committed", result: null, recordVersions: [] };
  return {
    identity,
    inputHash: input.inputHash,
    resolvedDefaults: {},
    outcome,
    committedRevision: b2Revision(input.revision),
    createdAt: input.at,
  };
}

/**
 * A blank fenced batch: every collection empty, no receipt. The spec
 * spreads this and overrides the staged writes/claims per row, so a
 * contract-shape drift fails at typecheck, not silently at runtime.
 */
export function b2BlankBatch(expectedRevision: Revision): CommitBatch {
  return {
    expectedRevision,
    writes: [],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads a `FenceConflictError` structurally (L3 `storage/port.ts`):
 * name + numeric expected/actual, where actual is null only when the
 * revision could not be reread after the abort. Throws otherwise.
 */
export function readB2FenceConflict(
  error: unknown,
  what: string,
): { expected: number; actual: number | null } {
  if (!isRecord(error) || error["name"] !== "FenceConflictError") {
    const name = isRecord(error) ? String(error["name"] ?? typeof error) : String(error);
    throw new Error(`${what}: expected FenceConflictError, got ${name}`);
  }
  const expected = error["expected"];
  const actual = error["actual"];
  if (typeof expected !== "number" || (typeof actual !== "number" && actual !== null)) {
    throw new Error(`${what}: FenceConflictError carries non-numeric revisions`);
  }
  return { expected, actual };
}

/**
 * Reads a `StorageConstraintError` structurally (L3 `storage/port.ts`):
 * name + closed kind vocabulary. Throws otherwise.
 */
export function readB2Constraint(
  error: unknown,
  what: string,
): { kind: string; detail: string } {
  if (!isRecord(error) || error["name"] !== "StorageConstraintError") {
    const name = isRecord(error) ? String(error["name"] ?? typeof error) : String(error);
    throw new Error(`${what}: expected StorageConstraintError, got ${name}`);
  }
  const kind = error["kind"];
  if (
    kind !== "unique" &&
    kind !== "reference" &&
    kind !== "version" &&
    kind !== "receipt_reuse" &&
    kind !== "unknown"
  ) {
    throw new Error(`${what}: StorageConstraintError kind ${JSON.stringify(kind)} is outside the closed vocabulary`);
  }
  return { kind, detail: typeof error["detail"] === "string" ? error["detail"] : "" };
}
