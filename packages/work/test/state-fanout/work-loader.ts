/** Test-only work/state conformance bridge over built owning work modules. */
import type {
  ModelName,
  QuerySpec,
  RecordId,
  RecordVersion,
  StoredRow,
} from '@canlang/contracts';
import type {
  FanoutChildId,
  FanoutChildOutcome,
  FanoutCohortKind,
  FanoutFailedReason,
  FanoutId,
  FanoutProgress,
  FanoutSkippedReason,
  OccurrenceId,
  RetryPolicy,
} from '@canlang/contracts';

/** Structural mirror of F2 `FanoutIntentRowData`. */
export interface WorkFanoutIntentData {
  readonly fanoutId: FanoutId;
  readonly sourceOccurrence: OccurrenceId;
  readonly handler: string;
  readonly cohort: FanoutCohortKind;
  readonly members: ReadonlyArray<string>;
  readonly memberCount: number;
}

/** Structural mirror of F2 `FanoutCheckpointRowData`. */
export interface WorkFanoutCheckpointData {
  readonly fanoutId: FanoutId;
  readonly completed: ReadonlyArray<string>;
  readonly cursor: string | null;
}

/** Structural mirror of F2 `FanoutChildRowData`. */
export interface WorkFanoutChildData {
  readonly fanoutId: FanoutId;
  readonly parentOccurrence: OccurrenceId;
  readonly handler: string;
  readonly recordId: string;
  readonly childId: string;
  readonly state: string;
  readonly attempts: number;
  readonly causeKind: string | null;
  readonly causeReason: string | null;
}

/** Structural mirror of F2 `NewRowMeta`. */
export interface WorkRowMeta {
  readonly nowMs: number;
  readonly actor: string;
}

/** Structural mirror of F2 `FanoutChildPage`. */
export interface WorkFanoutChildPage {
  readonly rows: ReadonlyArray<StoredRow>;
  readonly done: boolean;
  readonly cursor: string | null;
}

/** Structural mirror of F3's test-only fanout child store. */
export interface WorkFanoutChildStore {
  insert(row: StoredRow): void;
  get(child: FanoutChildId): StoredRow | null;
  claim(
    evaluateGuard: (predicate: unknown, frozenInputs: unknown, snapshot: unknown) => boolean,
    input: {
      readonly child: FanoutChildId;
      readonly snapshotVersion: number | null;
      readonly guard: { readonly predicate: unknown };
      readonly frozenInputs: unknown;
      readonly readCurrentSnapshot: () => unknown;
      readonly fence?: {
        readonly checkpoint: { readonly revision: number };
        readonly triggerRevision?: { readonly revision: number };
      };
    },
  ): {
    readonly status: string;
    readonly row?: StoredRow;
    readonly child?: FanoutChildId;
    readonly outcome?: FanoutChildOutcome;
  };
  record(input: {
    readonly child: FanoutChildId;
    readonly result:
      | { readonly kind: 'completed' }
      | { readonly kind: 'skipped'; readonly reason: FanoutSkippedReason }
      | { readonly kind: 'failed'; readonly reason: Exclude<FanoutFailedReason, 'exhausted'> }
      | { readonly kind: 'transient' };
    readonly nowMs: number;
    readonly firstAttemptAtMs: number;
    readonly policy: RetryPolicy;
  }): {
    readonly status: string;
    readonly row: StoredRow;
    readonly outcome?: FanoutChildOutcome;
  };
}

/** Structural mirror of F4 `FanoutChildLifecycle`. */
export type WorkFanoutChildLifecycle =
  | { readonly status: 'present' }
  | { readonly status: 'deleted' }
  | { readonly status: 'moved' }
  | {
      readonly status: 'unknown';
      readonly reason: 'missing-record' | 'inaccessible-record' | 'infra-read-failure';
    };

/** Structural mirror of F4 `FanoutRecoverableRow` (child data passed through). */
export interface WorkFanoutRecoverableRow {
  readonly child: WorkFanoutChildData;
  readonly claimedAtMs: number | null;
  readonly guardVerdict: boolean | null;
  readonly firstAttemptAtMs: number | null;
  readonly lifecycle: WorkFanoutChildLifecycle;
}

/** Structural mirror of F4 `FanoutRecoveryPlan`. */
export interface WorkFanoutRecoveryPlan {
  readonly resume: string[];
  readonly skipped: ReadonlyArray<{ readonly childId: string; readonly reason: string }>;
  readonly dead: string[];
  readonly failed: ReadonlyArray<{ readonly childId: string; readonly reason: string }>;
  readonly admit: string[];
  readonly uncertain: string[];
  readonly phantoms: string[];
  readonly checkpointGaps: string[];
  readonly finishEnumeration: boolean;
}

export interface WorkFanoutFns {
  readonly WORK_FANOUT_INTENT_MODEL: string;
  readonly WORK_FANOUT_CHECKPOINT_MODEL: string;
  readonly WORK_FANOUT_CHILD_MODEL: string;
  readonly FANOUT_T32_REFUSAL_REASON: FanoutFailedReason;
  readonly fanoutIntentRowId: (
    sourceOccurrence: string,
    handler: string,
    cohort: FanoutCohortKind,
  ) => string;
  readonly fanoutChildRowId: (
    parentOccurrence: string,
    handler: string,
    recordId: string,
  ) => string;
  readonly newFanoutIntentRow: (
    input: {
      readonly sourceOccurrence: string;
      readonly handler: string;
      readonly cohort: FanoutCohortKind;
      readonly members: ReadonlyArray<string>;
    },
    meta: WorkRowMeta,
  ) => StoredRow;
  readonly newFanoutCheckpointRow: (
    input: {
      readonly fanoutId: string;
      readonly completed?: ReadonlyArray<string>;
      readonly cursor?: string | null;
    },
    meta: WorkRowMeta,
  ) => StoredRow;
  readonly newFanoutChildRow: (
    input: {
      readonly fanoutId: string;
      readonly parentOccurrence: string;
      readonly handler: string;
      readonly recordId: string;
      readonly state?: string;
      readonly attempts?: number;
      readonly causeKind?: string | null;
      readonly causeReason?: string | null;
    },
    meta: WorkRowMeta,
  ) => StoredRow;
  readonly withRowData: (
    row: StoredRow,
    data: Readonly<Record<string, unknown>>,
    meta: WorkRowMeta,
    what: string,
  ) => StoredRow;
  readonly readFanoutIntentRow: (row: StoredRow) => WorkFanoutIntentData;
  readonly readFanoutCheckpointRow: (row: StoredRow) => WorkFanoutCheckpointData;
  readonly readFanoutChildRow: (row: StoredRow) => WorkFanoutChildData;
  readonly nextFanoutCheckpointData: (
    current: WorkFanoutCheckpointData,
    addCompleted: ReadonlyArray<string>,
    cursor: string | null,
  ) => WorkFanoutCheckpointData;
  readonly fanoutChildPageQuery: (
    fanoutId: string,
    opts: { readonly cursor: string | null; readonly limit: number },
  ) => QuerySpec;
  readonly fanoutChildPageResult: (
    rows: ReadonlyArray<StoredRow>,
    limit: number,
  ) => WorkFanoutChildPage;
  readonly fanoutChildOutcomeFromRow: (data: WorkFanoutChildData) => FanoutChildOutcome | null;
  readonly summarizeFanoutChildren: (
    fanoutId: string,
    rows: ReadonlyArray<StoredRow>,
  ) => FanoutProgress;
  readonly TestOnlyMemoryFanoutChildStore: new (clock: { nowMs(): number }) => WorkFanoutChildStore;
  readonly planFanoutRecoveryScan: (input: {
    readonly fanoutId: string;
    readonly intent: WorkFanoutIntentData;
    readonly checkpoint: WorkFanoutCheckpointData;
    readonly rows: ReadonlyArray<WorkFanoutRecoverableRow>;
    readonly nowMs: number;
    readonly maxClaimAgeMs: number;
    readonly policy?: RetryPolicy;
  }) => WorkFanoutRecoveryPlan;
}

export type { ModelName, RecordId, RecordVersion };

function requireFn(value: unknown, name: string): (...args: never[]) => unknown {
  if (typeof value !== 'function') {
    throw new Error(`fanout join tests: work export ${name} is not a function.`);
  }
  return value as (...args: never[]) => unknown;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`fanout join tests: work export ${name} is not a non-empty string.`);
  }
  return value;
}

/** Load the real F2/F3/F4 functions from this package's emitted modules. */
export async function loadWorkFanoutFns(): Promise<WorkFanoutFns> {
  const tables = await import('../../src/kernel/tables.js');
  const dispatch = await import('../../src/dispatch/index.js');
  const recovery = await import('../../src/recovery/index.js');
  return {
    WORK_FANOUT_INTENT_MODEL: requireString(
      tables['WORK_FANOUT_INTENT_MODEL'],
      'WORK_FANOUT_INTENT_MODEL',
    ),
    WORK_FANOUT_CHECKPOINT_MODEL: requireString(
      tables['WORK_FANOUT_CHECKPOINT_MODEL'],
      'WORK_FANOUT_CHECKPOINT_MODEL',
    ),
    WORK_FANOUT_CHILD_MODEL: requireString(
      tables['WORK_FANOUT_CHILD_MODEL'],
      'WORK_FANOUT_CHILD_MODEL',
    ),
    FANOUT_T32_REFUSAL_REASON: requireString(
      dispatch['FANOUT_T32_REFUSAL_REASON'],
      'FANOUT_T32_REFUSAL_REASON',
    ) as FanoutFailedReason,
    fanoutIntentRowId: requireFn(tables['fanoutIntentRowId'], 'fanoutIntentRowId') as unknown as WorkFanoutFns['fanoutIntentRowId'],
    fanoutChildRowId: requireFn(tables['fanoutChildRowId'], 'fanoutChildRowId') as unknown as WorkFanoutFns['fanoutChildRowId'],
    newFanoutIntentRow: requireFn(tables['newFanoutIntentRow'], 'newFanoutIntentRow') as unknown as WorkFanoutFns['newFanoutIntentRow'],
    newFanoutCheckpointRow: requireFn(
      tables['newFanoutCheckpointRow'],
      'newFanoutCheckpointRow',
    ) as unknown as WorkFanoutFns['newFanoutCheckpointRow'],
    newFanoutChildRow: requireFn(tables['newFanoutChildRow'], 'newFanoutChildRow') as unknown as WorkFanoutFns['newFanoutChildRow'],
    withRowData: requireFn(tables['withRowData'], 'withRowData') as unknown as WorkFanoutFns['withRowData'],
    readFanoutIntentRow: requireFn(
      tables['readFanoutIntentRow'],
      'readFanoutIntentRow',
    ) as unknown as WorkFanoutFns['readFanoutIntentRow'],
    readFanoutCheckpointRow: requireFn(
      tables['readFanoutCheckpointRow'],
      'readFanoutCheckpointRow',
    ) as unknown as WorkFanoutFns['readFanoutCheckpointRow'],
    readFanoutChildRow: requireFn(
      tables['readFanoutChildRow'],
      'readFanoutChildRow',
    ) as unknown as WorkFanoutFns['readFanoutChildRow'],
    nextFanoutCheckpointData: requireFn(
      tables['nextFanoutCheckpointData'],
      'nextFanoutCheckpointData',
    ) as unknown as WorkFanoutFns['nextFanoutCheckpointData'],
    fanoutChildPageQuery: requireFn(
      tables['fanoutChildPageQuery'],
      'fanoutChildPageQuery',
    ) as unknown as WorkFanoutFns['fanoutChildPageQuery'],
    fanoutChildPageResult: requireFn(
      tables['fanoutChildPageResult'],
      'fanoutChildPageResult',
    ) as unknown as WorkFanoutFns['fanoutChildPageResult'],
    fanoutChildOutcomeFromRow: requireFn(
      dispatch['fanoutChildOutcomeFromRow'],
      'fanoutChildOutcomeFromRow',
    ) as unknown as WorkFanoutFns['fanoutChildOutcomeFromRow'],
    summarizeFanoutChildren: requireFn(
      dispatch['summarizeFanoutChildren'],
      'summarizeFanoutChildren',
    ) as unknown as WorkFanoutFns['summarizeFanoutChildren'],
    TestOnlyMemoryFanoutChildStore: requireFn(
      dispatch['TestOnlyMemoryFanoutChildStore'],
      'TestOnlyMemoryFanoutChildStore',
    ) as unknown as WorkFanoutFns['TestOnlyMemoryFanoutChildStore'],
    planFanoutRecoveryScan: requireFn(
      recovery['planFanoutRecoveryScan'],
      'planFanoutRecoveryScan',
    ) as unknown as WorkFanoutFns['planFanoutRecoveryScan'],
  };
}
