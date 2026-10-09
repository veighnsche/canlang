/**
 * B2 occurrence/dispatch executors: run occurrence handlers through the
 * runner as the INTERIM dispatch-row producer (L3 S9b addendum), threading
 * `originOccurrence` from the admitted occurrence through to the fenced
 * commit.
 *
 * Addendum settlement (`implementation/status/lane-07.md:215`): sibling
 * `work.dispatch` rows ride the existing same-batch `effects.writes`
 * channel; the permanent producer is L1 codegen, the interim producer is
 * these runner executors; `originOccurrence` is runtime-stamped (null
 * direct).
 *
 * INTERIM — handoff to L1. When codegen emits dispatch-row writes, this
 * module is replaced outright: `executeOccurrence`/`executeDirect` collapse
 * back to plain `invokeCallable`, and the store decorator + row builder are
 * deleted. What L1 must formalize: the emitted `work.dispatch` write shape
 * (field mapping incl. `source`), the stamp source (admission context vs
 * occurrence record), and the `dispatchGuard` predicate registry wiring.
 *
 * Workerd-safe: type-only producer imports plus relative runtime imports;
 * no `node:` or runtime producer dependencies.
 */
import type {
  CommitBatch,
  CommitResult,
  CompileArtifact,
  DomainWrite,
  ModelName,
  OccurrenceId,
  OutboxIntent,
  RecordId,
  RecordVersion,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import type { HandlerContext } from "./context.js";
import {
  invokeCallableInOccurrence,
  type AssembledModules,
  type InvokeResult,
  type OccurrenceContext,
} from "./invoke.js";

/**
 * Lane-04-owned dispatch table model. Structural mirror of `@canlang/work`
 * `WORK_DISPATCH_MODEL` (no work import: this package depends on
 * `@canlang/contracts` only). Drift is pinned by the row-shape tests, not
 * by a shared import.
 */
export const WORK_DISPATCH_MODEL = "work.dispatch" as ModelName;

/** One admitted occurrence to execute: occurrence id + handler callable. */
export interface OccurrenceRequest {
  /** Admitted occurrence id; must be a non-empty string (fail-loud). */
  readonly occurrenceId: string;
  /** Artifact callable id, resolved through `canApp()` + member. */
  readonly callableId: string;
  /** Handler args after `ctx`. */
  readonly args?: ReadonlyArray<unknown>;
}

/** Direct (non-occurrence) business-operation call: stamped null. */
export interface DirectRequest {
  /** Artifact callable id, resolved through `canApp()` + member. */
  readonly callableId: string;
  /** Handler args after `ctx`. */
  readonly args?: ReadonlyArray<unknown>;
}

/** Row-envelope meta for produced dispatch rows. */
export interface DispatchProducerMeta {
  /** Clock for row created/updated; called once per commit. */
  readonly clock: () => number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
}

function invalid(what: string): never {
  throw new Error(what);
}

function requireText(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${where}: ${field} must be a non-empty string`);
  }
  return value;
}

function requireIndex(value: unknown, field: string, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${where}: ${field} must be a non-negative integer`);
  }
  return value;
}

/**
 * Build one `work.dispatch` insert write per staged outbox intent, stamping
 * `originOccurrence` on every row. Pure; throws fail-closed on any
 * malformed intent or stamp (never silently skips an intent).
 *
 * Field mapping (lane-3 intent -> lane-4 dispatch row): `intentId`,
 * `operationId`, and `occurrenceIndex` carry over; `source` carries the
 * intent `target` (the declaring operation path); claim-lifecycle fields
 * start at their pending defaults (`state: "pending"`, `attempts: 0`,
 * everything else null). The frozen provider `arguments` stay on the
 * intent itself (persisted by the L3 fence from `batch.outbox`); the
 * dispatch row is the sibling claim-lifecycle row only.
 */
export function buildDispatchWrites(
  outbox: ReadonlyArray<OutboxIntent>,
  originOccurrence: OccurrenceId | null,
  meta: { readonly nowMs: number; readonly actor: string },
): DomainWrite[] {
  if (originOccurrence !== null) {
    requireText(originOccurrence, "originOccurrence", "buildDispatchWrites");
  }
  requireText(meta.actor, "actor", "buildDispatchWrites");
  if (typeof meta.nowMs !== "number" || !Number.isFinite(meta.nowMs)) {
    invalid("buildDispatchWrites: nowMs must be a finite number");
  }
  return outbox.map((intent, index) => {
    const where = `buildDispatchWrites: outbox[${index}]`;
    const intentId = requireText(intent.intentId, "intentId", where);
    const operationId = requireText(intent.operationId, "operationId", where);
    const source = requireText(intent.target, "target (dispatch source)", where);
    const occurrenceIndex = requireIndex(intent.occurrenceIndex, "occurrenceIndex", where);
    const row: StoredRow = {
      id: intentId as RecordId,
      version: 1 as RecordVersion,
      created: meta.nowMs,
      updated: meta.nowMs,
      createdBy: meta.actor,
      updatedBy: meta.actor,
      archivedAt: null,
      data: {
        intentId,
        operationId,
        source,
        occurrenceIndex,
        originOccurrence,
        state: "pending",
        attempts: 0,
        claimId: null,
        claimedAtMs: null,
        guardVerdict: null,
        deliveryId: null,
        errorCode: null,
        errorMessage: null,
        availableAtMs: null,
        firstAttemptAtMs: null,
        retryClass: null,
      },
    };
    return { kind: "insert", model: WORK_DISPATCH_MODEL, row };
  });
}

/**
 * Dispatch executor: append sibling `work.dispatch` inserts for every intent
 * in `batch.outbox` to the SAME batch's writes, then run one fenced commit.
 * History, receipt, outbox, schedules, uniques, and `outboxAck` pass through
 * untouched. Batches without outbox intents delegate untouched (same batch
 * reference reaches the inner store).
 */
export async function commitWithDispatchRows(
  inner: StoragePort,
  batch: CommitBatch,
  originOccurrence: OccurrenceId | null,
  meta: DispatchProducerMeta,
): Promise<CommitResult> {
  if (batch.outbox.length === 0) {
    return inner.commit(batch);
  }
  const writes = buildDispatchWrites(batch.outbox, originOccurrence, {
    nowMs: meta.clock(),
    actor: meta.actor,
  });
  return inner.commit({ ...batch, writes: [...batch.writes, ...writes] });
}

/**
 * Wrap `inner` so every fenced commit also produces sibling dispatch rows
 * stamped with `originOccurrence` (the interim dispatch-row producer). All
 * non-commit port methods delegate untouched.
 */
export function withDispatchProducer(
  inner: StoragePort,
  originOccurrence: OccurrenceId | null,
  meta: DispatchProducerMeta,
): StoragePort {
  return {
    readRevision: () => inner.readRevision(),
    load: (model, id) => inner.load(model, id),
    query: (spec) => inner.query(spec),
    commit: (batch) => commitWithDispatchRows(inner, batch, originOccurrence, meta),
    readReceipt: (identity) => inner.readReceipt(identity),
    outboxPending: () => inner.outboxPending(),
    outboxGet: (intentId) => inner.outboxGet(intentId),
    scheduleGet: (key) => inner.scheduleGet(key),
    schedulesDue: (now, limit) => inner.schedulesDue(now, limit),
    historyFor: (model, recordId) => inner.historyFor(model, recordId),
    readInstalledSnapshot: (owner) => inner.readInstalledSnapshot(owner),
    readMigrationProgress: (migrationId) => inner.readMigrationProgress(migrationId),
    readStagedRows: (migrationId, cursor, limit) => inner.readStagedRows(migrationId, cursor, limit),
    stageMigrationRows: (input) => inner.stageMigrationRows(input),
    publishMigrationChunk: (input) => inner.publishMigrationChunk(input),
    flipInstalledSnapshot: (input) => inner.flipInstalledSnapshot(input),
    readMigrationOutcomes: (migrationId) => inner.readMigrationOutcomes(migrationId),
    recordMigrationFailure: (input) => inner.recordMigrationFailure(input),
    discardStagedRows: (input) => inner.discardStagedRows(input),
    readMigrationFailure: (migrationId) => inner.readMigrationFailure(migrationId),
  };
}

/**
 * Thread `originOccurrence` onto a base context: installs the
 * dispatch-producing store (clock/actor derived from the base context) and
 * carries the stamp for the occurrence-aware invoke entry.
 */
export function withOriginOccurrence(
  base: HandlerContext,
  originOccurrence: OccurrenceId | null,
): OccurrenceContext {
  return {
    ...base,
    store: withDispatchProducer(base.store, originOccurrence, {
      clock: base.clock,
      actor: base.caller.userId,
    }),
    originOccurrence,
  };
}

/**
 * Occurrence executor: run one admitted occurrence's handler through the
 * occurrence-aware invoke entry, threading `request.occurrenceId` as the
 * `originOccurrence` stamp through to every fenced commit the handler
 * makes. Never throws: invalid requests fail loud without invoking the
 * handler, and resolution/handler/commit failures return `{ ok: false }`
 * through the invoke entry's never-throws contract.
 */
export async function executeOccurrence(
  asm: AssembledModules,
  artifact: CompileArtifact,
  request: OccurrenceRequest,
  base: HandlerContext,
): Promise<InvokeResult> {
  if (typeof request.occurrenceId !== "string" || request.occurrenceId.length === 0) {
    return {
      ok: false,
      error:
        `executeOccurrence: occurrenceId must be a non-empty string ` +
        `(callable ${JSON.stringify(request.callableId)} not invoked)`,
    };
  }
  if (typeof request.callableId !== "string" || request.callableId.length === 0) {
    return {
      ok: false,
      error: `executeOccurrence: callableId must be a non-empty string`,
    };
  }
  return invokeCallableInOccurrence(
    asm,
    artifact,
    request.callableId,
    withOriginOccurrence(base, request.occurrenceId),
    request.args === undefined ? undefined : [...request.args],
  );
}

/**
 * Direct executor: run a business-operation handler outside any occurrence,
 * stamping `originOccurrence: null` on produced dispatch rows (the "null
 * direct" half of the addendum). Same never-throws contract as
 * `executeOccurrence`.
 */
export async function executeDirect(
  asm: AssembledModules,
  artifact: CompileArtifact,
  request: DirectRequest,
  base: HandlerContext,
): Promise<InvokeResult> {
  if (typeof request.callableId !== "string" || request.callableId.length === 0) {
    return {
      ok: false,
      error: `executeDirect: callableId must be a non-empty string`,
    };
  }
  return invokeCallableInOccurrence(
    asm,
    artifact,
    request.callableId,
    withOriginOccurrence(base, null),
    request.args === undefined ? undefined : [...request.args],
  );
}
