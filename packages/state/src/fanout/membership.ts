/**
 * T34-F5 authoritative membership: freeze the complete sorted canonical
 * identity set at an explicit source-occurrence/handler cutoff in the
 * OWNING store, for both cohort spellings.
 *
 * Mechanism (Q4: retained frozen identity set): bounded id-sorted
 * enumeration pages under one fence revision, committed with the intent
 * + checkpoint rows in a single owner transaction fenced at the
 * enumeration revision. Any concurrent write between the first page and
 * the commit moves the revision and voids the commit (fence conflict →
 * bounded retry from scratch); only a revision-stable enumeration
 * freezes. Late inserts land after the cutoff revision and are excluded
 * from the occurrence structurally — membership is the frozen intent
 * set, never a live directory read.
 *
 * Admission shape: the intent + checkpoint rows commit first (fenced at
 * the enumeration revision); admitted child rows materialize in bounded
 * chunks; the final chunk nulls the enumeration cursor. A crash between
 * chunks leaves a non-null cursor with missing rows, which re-freezing
 * (same cutoff+cohort) resumes idempotently: the intent insert collides,
 * the existing frozen set replays, missing rows admit, and the cursor
 * nulls only when fully admitted. Re-freezing NEVER re-enumerates.
 *
 * Failure posture: every failure here is a capability/admission failure
 * (`FanoutCohortDiagnosis`), never partial enumeration. Unknown anchors,
 * unknown models, infra failures, and exhausted fence contention all
 * diagnose; nothing freezes half a set.
 */

import type {
  CommitBatch,
  ModelName,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import type {
  FanoutCohortDiagnosis,
  FanoutId,
} from '../../../contracts/src/work.js';
import { StateError } from '../errors.js';
import { FenceConflictError, StorageConstraintError } from '../storage/port.js';
import { stageFanoutMembership } from '../effects/staging.js';
import {
  FANOUT_CHECKPOINT_MODEL,
  FANOUT_CHILD_MODEL,
  FANOUT_INTENT_MODEL,
  fanoutIntentRowId,
  newFanoutCheckpointRow,
  newFanoutChildRow,
  newFanoutIntentRow,
  readFanoutCheckpointRow,
  readFanoutChildRow,
  readFanoutIntentRow,
  withFanoutRowData,
  type FanoutRowMeta,
} from './tables.js';
import {
  checkCohortSpec,
  checkCutoffSpec,
  diagnoseCohort,
  type FanoutCohortSpec,
  type FanoutCutoffSpec,
} from './cohort.js';

/**
 * Explicit freeze bounds (no defaults, no quota field): page transport
 * bound, child-admission chunk bound, and freeze-attempt bound. Chunk
 * size is not cohort size (§C9): varying these never changes which
 * identities freeze.
 */
export interface FanoutFreezeBounds {
  readonly pageLimit: number;
  readonly chunkSize: number;
  readonly maxAttempts: number;
}

function checkBounds(bounds: FanoutFreezeBounds): void {
  if (typeof bounds !== 'object' || bounds === null || Array.isArray(bounds)) {
    throw new StateError('validation', 'Fanout freeze bounds must be an object.');
  }
  for (const field of ['pageLimit', 'chunkSize', 'maxAttempts'] as const) {
    const value = bounds[field];
    if (!Number.isInteger(value) || value < 1) {
      throw new StateError('validation', `Fanout freeze ${field} must be an integer >= 1.`);
    }
  }
}

/** One membership freeze request against the owning store. */
export interface FreezeMembershipInput {
  readonly store: StoragePort;
  readonly cutoff: FanoutCutoffSpec;
  readonly cohort: FanoutCohortSpec;
  /** Operating owner (the checkpoint owner); specs naming another owner diagnose. */
  readonly owner: string;
  readonly bounds: FanoutFreezeBounds;
  readonly meta: FanoutRowMeta;
  /**
   * Known-model guard (injected by the caller; production wires the
   * model table, tests wire a test set). When present and the cohort
   * model is unknown, the freeze diagnoses `unsupported-cohort` instead
   * of silently freezing an empty set over a mis-specified model. When
   * absent the guard is skipped (documented at the call site).
   */
  readonly hasModel?: (model: string) => boolean;
}

/** Frozen membership: the committed intent identity plus its frozen set. */
export interface FrozenMembership {
  readonly fanoutId: FanoutId;
  /** Frozen canonical admitted record identities (sorted canonical order). */
  readonly members: ReadonlyArray<string>;
  /**
   * Fence revision the freeze committed under (fresh freeze), or the
   * revision at which the existing intent was observed (replay).
   */
  readonly cutoffRevision: Revision;
  /** True when an existing intent replayed instead of a fresh freeze. */
  readonly replayed: boolean;
}

export type FreezeMembershipOutcome =
  | { readonly ok: true; readonly frozen: FrozenMembership }
  | { readonly ok: false; readonly diagnosis: FanoutCohortDiagnosis };

/** Opaque enumeration cursor while admission chunks remain. */
function admitCursor(nextChunkIndex: number): string {
  return `admit/${nextChunkIndex}`;
}

interface AnchorVerdict {
  /** The anchor demonstrably exists, existed, or is archived — freeze proceeds. */
  readonly known: boolean;
}

/**
 * Classify the anchored-collection anchor within the fenced window.
 * Present (even archived — archive is not delete) or tombstoned
 * (history records its disposal) anchors are KNOWN: the enumerated set
 * — possibly empty — is exact. A missing anchor with no disposal
 * history is UNKNOWN: freezing empty would bless a mis-specified cohort
 * as a complete sweep, so the freeze diagnoses instead. Infra failures
 * propagate to the unavailable diagnosis.
 */
async function classifyAnchor(
  store: StoragePort,
  parent: { readonly model: string; readonly id: string },
): Promise<AnchorVerdict> {
  const row = await store.load(parent.model as ModelName, parent.id as RecordId);
  if (row !== null) {
    return { known: true };
  }
  const history = await store.historyFor(parent.model as ModelName, parent.id as RecordId);
  for (const entry of history) {
    if (entry.change === 'remove' || entry.change === 'archive') {
      return { known: true };
    }
  }
  return { known: false };
}

/**
 * Drain one cohort's member identities in bounded id-sorted pages.
 * Whole-model cohorts scan the model; anchored-collection cohorts scope
 * to the pinned parent's linkage. Archived rows INCLUDE: they freeze as
 * members and record skipped/deleted when their child executes, so every
 * stored identity gets one accounted outcome.
 */
async function drainCohortIdentities(
  store: StoragePort,
  cohort: FanoutCohortSpec,
  pageLimit: number,
): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = await store.query({
      model: cohort.model as ModelName,
      ...(cohort.kind === 'anchored-collection'
        ? {
            parent: {
              model: cohort.parent.model as ModelName,
              id: cohort.parent.id as RecordId,
            },
          }
        : {}),
      ...(cursor === null
        ? {}
        : { where: { op: 'gt', field: 'id', value: cursor } as const }),
      order: [{ field: 'id', direction: 'asc' }],
      limit: pageLimit,
      archived: 'include',
      authority: 'owner',
    });
    if (rows.length > pageLimit) {
      throw new StateError(
        'validation',
        `Fanout enumeration returned ${rows.length} rows past limit ${pageLimit}.`,
      );
    }
    for (const row of rows) {
      members.push(row.id as string);
    }
    if (rows.length < pageLimit) {
      return members;
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      throw new StateError('validation', 'Fanout enumeration hit an unreachable empty full page.');
    }
    cursor = last.id as string;
  }
}

/** Drain admitted child record ids for one fanout in bounded pages. */
async function drainAdmittedRecordIds(
  store: StoragePort,
  fanoutId: FanoutId,
  pageLimit: number,
): Promise<Set<string>> {
  const admitted = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const rows = await store.query({
      model: FANOUT_CHILD_MODEL as ModelName,
      where:
        cursor === null
          ? { op: 'eq', field: 'fanoutId', value: fanoutId }
          : {
              op: 'and',
              args: [
                { op: 'eq', field: 'fanoutId', value: fanoutId },
                { op: 'gt', field: 'id', value: cursor },
              ],
            },
      order: [{ field: 'id', direction: 'asc' }],
      limit: pageLimit,
      authority: 'owner',
    });
    if (rows.length > pageLimit) {
      throw new StateError(
        'validation',
        `Fanout child drain returned ${rows.length} rows past limit ${pageLimit}.`,
      );
    }
    for (const row of rows) {
      admitted.add(readFanoutChildRow(row).recordId);
    }
    if (rows.length < pageLimit) {
      return admitted;
    }
    const last = rows[rows.length - 1];
    if (last === undefined) {
      throw new StateError('validation', 'Fanout child drain hit an unreachable empty full page.');
    }
    cursor = last.id as string;
  }
}

function chunkOf<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

async function commitBatch(store: StoragePort, batch: CommitBatch): Promise<void> {
  await store.commit(batch);
}

/**
 * Freeze one cohort's membership. See the module header for the
 * mechanism, resume, and failure posture.
 *
 * Freeze commits flow through the PLAIN store port (inserts + cursor
 * maintenance carry no terminal outcomes); outcome-bearing child units
 * commit through the linkage-asserted child-join port instead.
 */
export async function freezeFanoutMembership(
  input: FreezeMembershipInput,
): Promise<FreezeMembershipOutcome> {
  checkCutoffSpec(input.cutoff);
  const cohortKind = checkCohortSpec(input.cohort);
  checkBounds(input.bounds);
  if (typeof input.owner !== 'string' || input.owner === '') {
    throw new StateError('validation', 'Fanout freeze needs a non-empty operating owner.');
  }
  if (input.cohort.owner !== input.owner) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'cross-owner-cohort',
        `Fanout cohort owner ${JSON.stringify(input.cohort.owner)} is outside operating owner ` +
          `${JSON.stringify(input.owner)}; the child transaction cannot cross owners.`,
      ),
    };
  }
  if (input.hasModel !== undefined && !input.hasModel(input.cohort.model)) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'unsupported-cohort',
        `Fanout cohort model ${JSON.stringify(input.cohort.model)} is not a servable model.`,
      ),
    };
  }
  const fanoutId = fanoutIntentRowId(
    input.cutoff.sourceOccurrence,
    input.cutoff.handler,
    cohortKind,
  );

  for (let attempt = 1; attempt <= input.bounds.maxAttempts; attempt += 1) {
    let revision: Revision;
    let enumerated: string[];
    try {
      revision = await input.store.readRevision();
      enumerated = await drainCohortIdentities(input.store, input.cohort, input.bounds.pageLimit);
      if (input.cohort.kind === 'anchored-collection') {
        const anchor = await classifyAnchor(input.store, input.cohort.parent);
        if (!anchor.known) {
          return {
            ok: false,
            diagnosis: diagnoseCohort(
              'membership-unavailable',
              `Fanout anchor ${JSON.stringify(input.cohort.parent.model)}/` +
                `${JSON.stringify(input.cohort.parent.id)} is unknown; refusing to freeze ` +
                'an empty sweep over an unknowable collection.',
            ),
          };
        }
      }
    } catch (error) {
      if (error instanceof StateError) {
        throw error;
      }
      return {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout enumeration failed: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      };
    }
    let members: ReadonlyArray<string>;
    try {
      members = stageFanoutMembership(enumerated, 'work.fanout_intent.members');
    } catch (error) {
      // Duplicates under a stable revision are store disagreement —
      // an unavailable producer, never a half set.
      return {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout enumeration disagrees with the store: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      };
    }
    const chunks = chunkOf(members, input.bounds.chunkSize);
    const firstChunk = chunks[0] ?? [];
    const singleCommit = chunks.length <= 1;
    const intentRow = newFanoutIntentRow(
      {
        sourceOccurrence: input.cutoff.sourceOccurrence,
        handler: input.cutoff.handler,
        cohort: cohortKind,
        members,
      },
      input.meta,
    );
    const checkpointRow = newFanoutCheckpointRow(
      {
        fanoutId,
        completed: [],
        cursor: singleCommit ? null : admitCursor(1),
      },
      input.meta,
    );
    try {
      await commitBatch(input.store, {
        expectedRevision: revision,
        writes: [
          { kind: 'insert', model: FANOUT_INTENT_MODEL as ModelName, row: intentRow },
          { kind: 'insert', model: FANOUT_CHECKPOINT_MODEL as ModelName, row: checkpointRow },
          ...firstChunk.map((recordId) => ({
            kind: 'insert' as const,
            model: FANOUT_CHILD_MODEL as ModelName,
            row: newFanoutChildRow(
              {
                fanoutId,
                parentOccurrence: input.cutoff.sourceOccurrence,
                handler: input.cutoff.handler,
                recordId,
              },
              input.meta,
            ),
          })),
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
    } catch (error) {
      if (error instanceof FenceConflictError) {
        continue;
      }
      if (error instanceof StorageConstraintError) {
        return replayFreeze(input, fanoutId);
      }
      if (error instanceof StateError) {
        throw error;
      }
      return {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout intent commit failed: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      };
    }
    // Intent + checkpoint + first chunk are durable. Admit the
    // remaining chunks; each chunk commit is atomic, and a crash
    // between chunks resumes via re-freezing (replay path below).
    for (let index = 1; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        continue;
      }
      const last = index === chunks.length - 1;
      const admitted = await admitChunk(input, fanoutId, chunk, last);
      if (!admitted.ok) {
        return admitted;
      }
    }
    return {
      ok: true,
      frozen: { fanoutId, members, cutoffRevision: revision, replayed: false },
    };
  }
  return {
    ok: false,
    diagnosis: diagnoseCohort(
      'membership-unavailable',
      `Fanout freeze lost the fence ${input.bounds.maxAttempts} time(s); ` +
        'concurrent writes never freeze a partial set.',
    ),
  };
}

/**
 * Admit one admission chunk (fresh fence per chunk: only the frozen set
 * materializes here, so later revisions are safe). On a constraint
 * collision (crash-retry overlap), re-reads the admitted set and inserts
 * only the missing rows. The final chunk nulls the cursor atomically
 * with its inserts.
 */
async function admitChunk(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
  chunk: ReadonlyArray<string>,
  last: boolean,
): Promise<FreezeMembershipOutcome> {
  const checkpointRow = last
    ? await input.store.load(FANOUT_CHECKPOINT_MODEL as ModelName, fanoutId as RecordId)
    : null;
  const checkpointData = checkpointRow === null ? null : readFanoutCheckpointRow(checkpointRow);
  const insertRows = (ids: ReadonlyArray<string>): StoredRow[] =>
    ids.map((recordId) =>
      newFanoutChildRow(
        {
          fanoutId,
          parentOccurrence: input.cutoff.sourceOccurrence,
          handler: input.cutoff.handler,
          recordId,
        },
        input.meta,
      ),
    );
  const checkpointUpdate =
    last && checkpointRow !== null && checkpointData !== null
      ? withFanoutRowData(
          checkpointRow,
          { ...checkpointData, cursor: null },
          input.meta,
        )
      : null;
  try {
    await commitBatch(input.store, {
      expectedRevision: await input.store.readRevision(),
      writes: [
        ...insertRows(chunk).map((row) => ({
          kind: 'insert' as const,
          model: FANOUT_CHILD_MODEL as ModelName,
          row,
        })),
        ...(checkpointUpdate !== null && checkpointRow !== null
          ? [
              {
                kind: 'update' as const,
                model: FANOUT_CHECKPOINT_MODEL as ModelName,
                id: fanoutId as RecordId,
                expectedVersion: checkpointRow.version,
                row: checkpointUpdate,
              },
            ]
          : []),
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    return {
      ok: true,
      frozen: {
        fanoutId,
        members: [],
        cutoffRevision: (await input.store.readRevision()) as Revision,
        replayed: true,
      },
    };
  } catch (error) {
    if (error instanceof FenceConflictError) {
      // Chunk chunks are idempotent: re-read and insert only missing.
      return admitMissing(input, fanoutId, last);
    }
    if (error instanceof StorageConstraintError) {
      return admitMissing(input, fanoutId, last);
    }
    if (error instanceof StateError) {
      throw error;
    }
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        `Fanout admission failed: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
}

/**
 * Crash-retry admission: re-read the frozen intent (NEVER re-enumerate),
 * insert only the missing member rows in bounded chunks, and null the
 * cursor only when fully admitted.
 */
async function admitMissing(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
  finishCursor: boolean,
): Promise<FreezeMembershipOutcome> {
  let intentRow: StoredRow | null;
  try {
    intentRow = await input.store.load(FANOUT_INTENT_MODEL as ModelName, fanoutId as RecordId);
  } catch (error) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        `Fanout admission re-read failed: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
  if (intentRow === null) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        'Fanout intent is missing during admission; refusing to invent membership.',
      ),
    };
  }
  const intent = readFanoutIntentRow(intentRow);
  if (
    intent.sourceOccurrence !== input.cutoff.sourceOccurrence ||
    intent.handler !== input.cutoff.handler
  ) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        'Fanout intent disagrees with the cutoff; refusing to invent membership.',
      ),
    };
  }
  const admitted = await drainAdmittedRecordIds(input.store, fanoutId, input.bounds.pageLimit);
  const missing = intent.members.filter((recordId) => !admitted.has(recordId));
  for (const chunk of chunkOf(missing, input.bounds.chunkSize)) {
    try {
      await commitBatch(input.store, {
        expectedRevision: await input.store.readRevision(),
        writes: chunk.map((recordId) => ({
          kind: 'insert' as const,
          model: FANOUT_CHILD_MODEL as ModelName,
          row: newFanoutChildRow(
            {
              fanoutId,
              parentOccurrence: input.cutoff.sourceOccurrence,
              handler: input.cutoff.handler,
              recordId,
            },
            input.meta,
          ),
        })),
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      });
    } catch (error) {
      if (error instanceof FenceConflictError || error instanceof StorageConstraintError) {
        // A rival admitter won the race; re-drain and continue.
        return admitMissing(input, fanoutId, finishCursor);
      }
      if (error instanceof StateError) {
        throw error;
      }
      return {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          `Fanout admission failed: ${error instanceof Error ? error.message : String(error)}.`,
        ),
      };
    }
    for (const recordId of chunk) {
      admitted.add(recordId);
    }
  }
  if (finishCursor) {
    const finish = await finishEnumerationCursor(input, fanoutId, intent.members, admitted);
    if (!finish.ok) {
      return finish;
    }
  }
  const cutoffRevision = await input.store.readRevision();
  return {
    ok: true,
    frozen: { fanoutId, members: intent.members, cutoffRevision, replayed: true },
  };
}

/**
 * Null the enumeration cursor only when every frozen member has a child
 * row (F4 `finishEnumeration` agreement: nothing to admit, no gaps —
 * gaps force false). A partial checkpoint never reads complete.
 */
async function finishEnumerationCursor(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
  members: ReadonlyArray<string>,
  admitted: ReadonlySet<string>,
): Promise<FreezeMembershipOutcome> {
  for (const recordId of members) {
    if (!admitted.has(recordId)) {
      return {
        ok: false,
        diagnosis: diagnoseCohort(
          'membership-unavailable',
          'Fanout admission is incomplete; the cursor stays non-null (resume, never complete).',
        ),
      };
    }
  }
  const checkpointRow = await input.store.load(
    FANOUT_CHECKPOINT_MODEL as ModelName,
    fanoutId as RecordId,
  );
  if (checkpointRow === null) {
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        'Fanout checkpoint is missing; refusing to invent completion.',
      ),
    };
  }
  const checkpoint = readFanoutCheckpointRow(checkpointRow);
  if (checkpoint.cursor === null) {
    const cutoffRevision = await input.store.readRevision();
    return { ok: true, frozen: { fanoutId, members, cutoffRevision, replayed: true } };
  }
  try {
    await commitBatch(input.store, {
      expectedRevision: await input.store.readRevision(),
      writes: [
        {
          kind: 'update',
          model: FANOUT_CHECKPOINT_MODEL as ModelName,
          id: fanoutId as RecordId,
          expectedVersion: checkpointRow.version,
          row: withFanoutRowData(checkpointRow, { ...checkpoint, cursor: null }, input.meta),
        },
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
  } catch (error) {
    if (error instanceof FenceConflictError || error instanceof StorageConstraintError) {
      const redrain = await drainAdmittedRecordIds(input.store, fanoutId, input.bounds.pageLimit);
      return finishEnumerationCursor(input, fanoutId, members, redrain);
    }
    if (error instanceof StateError) {
      throw error;
    }
    return {
      ok: false,
      diagnosis: diagnoseCohort(
        'membership-unavailable',
        `Fanout cursor finish failed: ${error instanceof Error ? error.message : String(error)}.`,
      ),
    };
  }
  const cutoffRevision = await input.store.readRevision();
  return { ok: true, frozen: { fanoutId, members, cutoffRevision, replayed: true } };
}

/**
 * Intent-collision replay: another freeze (or a pre-crash attempt) won
 * the intent insert. The existing frozen set replays — members are the
 * STORED set, never re-enumerated — missing rows admit, and the cursor
 * nulls only when fully admitted.
 */
async function replayFreeze(
  input: FreezeMembershipInput,
  fanoutId: FanoutId,
): Promise<FreezeMembershipOutcome> {
  return admitMissing(input, fanoutId, true);
}
