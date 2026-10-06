/**
 * T34-F7 fanout join (colocated): atomic trigger/intent staging, the
 * fair resumable scheduler, and the DURABLE fenced claim/record
 * replacements for F3's TEST-ONLY store — MEMORY-ONLY proofs (no
 * persist channel); the D1/DO durable proofs (claim races across
 * handles, real restart, durable horizon) live in
 * `t34-f7-fanout-durable.test.ts`. Process-restart survival is
 * explicitly UNCLAIMED here.
 *
 * Real producers throughout: fanout tables/cohort/membership/
 * outcome/lifecycle/progress, staging, child-join assertion,
 * `invokeFanoutChild`, and storage error classes from state dist
 * (loaded by the runtime's `loadFanoutStateProducers`); F2/F3/F4
 * cross-checks against the REAL work sources via NON-LITERAL dynamic
 * import (tsc-blind — the T24b precedent); memory store; fixture
 * registry/memberships/identity.
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/t34-f7-fanout.test.js`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  DomainWrite,
  FanoutChildId,
  FanoutChildOutcome,
  ModelName,
  RecordId,
  ResolvedIdentity,
  RetryPolicy,
  Revision,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { createMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import { FenceConflictError } from "../../../state/dist/state/src/storage/port.js";
import type { OperationRegistry } from "../../../state/dist/state/src/invocation/registry.js";
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  createMemoryIdentityStore,
  makeBatch,
  makeDef,
  makeIdentity,
  makeRow,
  seedMember,
  uuidv7,
} from "../../../state/dist/state/test/invocation/fixtures.js";
import type { TestMembershipStore } from "../../../state/dist/state/test/invocation/fixtures.js";
import { StateError } from "../../../state/dist/state/src/errors.js";
import { assembleFanoutServingSurface } from "../worker/assembly.js";
import {
  T34F7_FANOUT_CHILD_MODEL,
  T34F7_FANOUT_CHECKPOINT_MODEL,
  T34F7_FANOUT_INTENT_MODEL,
  claimFanoutChild,
  fanoutChildOutcomeFromData,
  fanoutFirstAttemptAnchor,
  isFanoutRowClaimStale,
  loadFanoutStateProducers,
  readFanoutSchedulerProgress,
  recordFanoutChildAttempt,
  releaseStaleFanoutClaims,
  requestFanoutProviderCancel,
  runFanoutSchedulerTurn,
  stageFanoutTriggerJoin,
} from "./invoke.js";
import type {
  FanoutChildAttemptResult,
  FanoutSchedulerBodyPort,
  FanoutSchedulerTurnBounds,
  FanoutStateProducers,
  RunFanoutSchedulerTurnOpts,
} from "./invoke.js";

const MODEL = "Acme.Commitment";
const HANDLER = "Shift.review_commitment";
const SOURCE = "occ-f7-1";
const APP = "acme-app";
const CHILD_OP = "Acme.review_child";
const ACTOR = "t34-f7-test";
const NOW = FIXED_NOW;
const POLICY: RetryPolicy = { maxAttempts: 3, horizonMs: 60_000 };
const MAX_AGE = 60_000;

const producers: FanoutStateProducers = await loadFanoutStateProducers();

/* -- Real work sources (non-literal dynamic import, tsc-blind). -- */

function workSpecifier(path: string): string {
  return ["..", "..", "..", "work", "src", path].join("/");
}

function requireWorkFn(mod: Record<string, unknown>, name: string): (...args: never[]) => unknown {
  const value: unknown = mod[name];
  if (typeof value !== "function") {
    throw new Error(`t34-f7 tests: work export ${name} is not a function.`);
  }
  return value as (...args: never[]) => unknown;
}

function requireWorkString(mod: Record<string, unknown>, name: string): string {
  const value: unknown = mod[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`t34-f7 tests: work export ${name} is not a non-empty string.`);
  }
  return value;
}

/** Structural view of the F3 test-only store (cross-check oracle only). */
interface F3Store {
  insert(row: StoredRow): void;
  claim(
    evaluateGuard: (predicate: string, frozenInputs: unknown, snapshot: unknown) => boolean,
    input: {
      readonly child: FanoutChildId;
      readonly snapshotVersion: number | null;
      readonly guard: { readonly predicate: string | null };
      readonly frozenInputs: unknown;
      readonly readCurrentSnapshot: () => unknown;
      readonly fence?: {
        readonly checkpoint: { readonly revision: number; readonly owner: string };
        readonly triggerRevision?: { readonly revision: number };
        readonly revalidateAuthority?: () => boolean;
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
    readonly result: FanoutChildAttemptResult;
    readonly nowMs: number;
    readonly firstAttemptAtMs: number;
    readonly policy: RetryPolicy;
  }): { readonly status: string; readonly row: StoredRow; readonly outcome?: FanoutChildOutcome };
}

interface WorkFns {
  readonly WORK_FANOUT_INTENT_MODEL: string;
  readonly WORK_FANOUT_CHECKPOINT_MODEL: string;
  readonly WORK_FANOUT_CHILD_MODEL: string;
  readonly FANOUT_T32_REFUSAL_REASON: string;
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
    meta: { readonly nowMs: number; readonly actor: string },
  ) => StoredRow;
  readonly readFanoutChildRow: (row: StoredRow) => {
    readonly fanoutId: string;
    readonly parentOccurrence: string;
    readonly handler: string;
    readonly recordId: string;
    readonly childId: string;
    readonly state: string;
    readonly attempts: number;
    readonly causeKind: string | null;
    readonly causeReason: string | null;
  };
  readonly fanoutChildOutcomeFromRow: (data: {
    readonly parentOccurrence: string;
    readonly handler: string;
    readonly recordId: string;
    readonly state: string;
    readonly attempts: number;
    readonly causeKind: string | null;
    readonly causeReason: string | null;
  }) => FanoutChildOutcome | null;
  readonly summarizeFanoutChildren: (
    fanoutId: string,
    rows: ReadonlyArray<StoredRow>,
  ) => {
    readonly pending: number;
    readonly running: number;
    readonly completed: number;
    readonly skipped: number;
    readonly failed: number;
    readonly terminal: boolean;
    readonly attention: boolean;
  };
  readonly isFanoutClaimStale: (claimedAtMs: number, nowMs: number, maxClaimAgeMs: number) => boolean;
  readonly TestOnlyMemoryFanoutChildStore: new (clock: { nowMs(): number }) => F3Store;
}

async function loadWorkFns(): Promise<WorkFns> {
  const tables = (await import(workSpecifier("kernel/tables.ts"))) as Record<string, unknown>;
  const dispatch = (await import(workSpecifier("dispatch/index.ts"))) as Record<string, unknown>;
  const recovery = (await import(workSpecifier("recovery/index.ts"))) as Record<string, unknown>;
  return {
    WORK_FANOUT_INTENT_MODEL: requireWorkString(tables, "WORK_FANOUT_INTENT_MODEL"),
    WORK_FANOUT_CHECKPOINT_MODEL: requireWorkString(tables, "WORK_FANOUT_CHECKPOINT_MODEL"),
    WORK_FANOUT_CHILD_MODEL: requireWorkString(tables, "WORK_FANOUT_CHILD_MODEL"),
    FANOUT_T32_REFUSAL_REASON: requireWorkString(dispatch, "FANOUT_T32_REFUSAL_REASON"),
    newFanoutChildRow: requireWorkFn(tables, "newFanoutChildRow") as unknown as WorkFns["newFanoutChildRow"],
    readFanoutChildRow: requireWorkFn(tables, "readFanoutChildRow") as unknown as WorkFns["readFanoutChildRow"],
    fanoutChildOutcomeFromRow: requireWorkFn(dispatch, "fanoutChildOutcomeFromRow") as unknown as WorkFns["fanoutChildOutcomeFromRow"],
    summarizeFanoutChildren: requireWorkFn(dispatch, "summarizeFanoutChildren") as unknown as WorkFns["summarizeFanoutChildren"],
    isFanoutClaimStale: requireWorkFn(recovery, "isFanoutClaimStale") as unknown as WorkFns["isFanoutClaimStale"],
    TestOnlyMemoryFanoutChildStore: requireWorkFn(dispatch, "TestOnlyMemoryFanoutChildStore") as unknown as WorkFns["TestOnlyMemoryFanoutChildStore"],
  };
}

const work: WorkFns = await loadWorkFns();

/* -- World setup (memory store + fixture registry/memberships/identity). -- */

interface World {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly registry: OperationRegistry;
  readonly identity: ResolvedIdentity;
  readonly owner: string;
  readonly clock: { nowMs(): number };
  readonly membershipId: string;
}

async function setupWorld(nowMs: number = NOW): Promise<World> {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const registry: OperationRegistry = new Map();
  (registry as Map<string, unknown>).set(
    CHILD_OP,
    makeDef({
      name: asOperation(CHILD_OP),
      by: "members",
      inputs: {
        record: { type: "record", model: asModel(MODEL), versioned: false, required: true },
      },
    }),
  );
  return {
    store,
    memberships,
    registry,
    identity: makeIdentity({ membership: alice.membership }),
    owner: alice.team.team_id as string,
    clock: { nowMs: () => nowMs },
    membershipId: alice.membership.membership_id as string,
  };
}

async function seedDomain(store: StoragePort, model: string, ids: ReadonlyArray<string>): Promise<void> {
  if (ids.length === 0) return;
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: ids.map((id) => ({
        kind: "insert",
        model: asModel(model),
        row: makeRow({ id, data: { label: id } }),
      })),
    }),
  );
}

let opSeq = 0;
function nextOpId(): string {
  opSeq += 1;
  return uuidv7(NOW, opSeq);
}

interface TriggerJoinArgs {
  readonly cutoff?: { readonly sourceOccurrence: string; readonly handler: string };
  readonly cohortModel?: string;
  readonly cohortKind?: "model" | "anchored-collection";
  readonly parent?: { readonly model: string; readonly id: string };
  readonly owner?: string;
  readonly opOwner?: string;
  readonly bounds?: { readonly pageLimit: number; readonly chunkSize: number };
  readonly meta?: { readonly nowMs: number; readonly actor: string };
  readonly hasModel?: (model: string) => boolean;
  readonly stageSource?: (fanout: { readonly fanoutId: string }) => {
    readonly writes: ReadonlyArray<DomainWrite>;
    readonly history: never[];
    readonly receipt: null;
    readonly outbox: never[];
    readonly schedules: never[];
    readonly uniqueClaims: never[];
    readonly uniqueReleases: never[];
  };
}

async function triggerJoin(world: World, args: TriggerJoinArgs = {}) {
  const cohort =
    args.cohortKind === "anchored-collection"
      ? {
          kind: "anchored-collection" as const,
          owner: args.owner ?? world.owner,
          model: args.cohortModel ?? MODEL,
          parent: args.parent ?? { model: "Acme.Opportunity", id: "opp-1" },
        }
      : { kind: "model" as const, owner: args.owner ?? world.owner, model: args.cohortModel ?? MODEL };
  return stageFanoutTriggerJoin({
    store: world.store,
    cutoff: args.cutoff ?? { sourceOccurrence: SOURCE, handler: HANDLER },
    cohort,
    owner: args.opOwner ?? world.owner,
    bounds: args.bounds ?? { pageLimit: 10, chunkSize: 10 },
    meta: args.meta ?? { nowMs: NOW, actor: ACTOR },
    stageSource: args.stageSource ?? (() => ({
      writes: [],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    })),
    hasModel: args.hasModel ?? ((model: string) => model === MODEL || model === "Acme.Opportunity"),
    producers,
  });
}

/** Mark-only completing body (domain mark + completed; body-call counting). */
function completedBody(calls: Map<string, number>): FanoutSchedulerBodyPort {
  return async (child, domainRow) => {
    calls.set(child.recordId, (calls.get(child.recordId) ?? 0) + 1);
    const next: StoredRow = {
      ...domainRow,
      version: (domainRow.version + 1) as StoredRow["version"],
      updated: NOW,
      updatedBy: ACTOR,
      data: { ...(domainRow.data as Record<string, unknown>), reviewed: true },
    };
    return {
      writes: [
        {
          kind: "update",
          model: asModel(MODEL),
          id: domainRow.id,
          expectedVersion: domainRow.version,
          row: next,
        },
      ],
      history: [],
      outbox: [],
      schedules: [],
      result: { kind: "completed" },
    };
  };
}

function turnOpts(
  world: World,
  fanoutId: string,
  cursor: string | null,
  bounds: FanoutSchedulerTurnBounds,
  body: FanoutSchedulerBodyPort,
  over: Partial<RunFanoutSchedulerTurnOpts> = {},
): RunFanoutSchedulerTurnOpts {
  return {
    store: world.store,
    fanoutId,
    cursor,
    bounds,
    policy: POLICY,
    meta: { nowMs: NOW, actor: ACTOR },
    maxClaimAgeMs: MAX_AGE,
    cohort: { model: MODEL },
    guard: { predicate: null, frozenInputs: null },
    evaluateGuard: () => true,
    readSnapshot: () => ({}),
    fenceFor: () => ({ owner: world.owner, revalidateAuthority: () => true }),
    body,
    invoke: {
      registry: world.registry,
      memberships: world.memberships,
      clock: world.clock,
      identity: world.identity,
      app: APP,
      source: "test",
      childOperation: CHILD_OP,
      refInput: "record",
      operationIdFor: () => nextOpId(),
    },
    producers,
    ...over,
  };
}

/** Chain turns within a sweep; re-sweep at null while work remains. */
async function sweepToTerminal(
  makeTurn: (cursor: string | null) => Promise<RunFanoutSchedulerTurnOpts>,
): Promise<{ readonly turns: number; readonly sweeps: number }> {
  let cursor: string | null = null;
  let turns = 0;
  let sweeps = 1;
  for (;;) {
    const result = await runFanoutSchedulerTurn(await makeTurn(cursor));
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    turns += 1;
    if (turns > 100) throw new Error("sweep did not terminate (100 turns).");
    if (result.done) {
      if (result.progress.terminal) return { turns, sweeps };
      cursor = null;
      sweeps += 1;
    } else {
      cursor = result.cursor;
    }
  }
}

async function drainChildren(store: StoragePort, fanoutId: string): Promise<StoredRow[]> {
  const rows: StoredRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = producers.tables.fanoutChildPageResult(
      await store.query(producers.tables.fanoutChildPageQuery(fanoutId, { cursor, limit: 50 })),
      50,
    );
    rows.push(...page.rows);
    if (page.done) return rows;
    cursor = page.cursor;
  }
}

/** Comparable child-row projection (excludes *By actor stamps). */
function pickChildData(row: StoredRow): Record<string, unknown> {
  const d = work.readFanoutChildRow(row);
  return {
    fanoutId: d.fanoutId,
    parentOccurrence: d.parentOccurrence,
    handler: d.handler,
    recordId: d.recordId,
    childId: d.childId,
    state: d.state,
    attempts: d.attempts,
    causeKind: d.causeKind,
    causeReason: d.causeReason,
    version: row.version,
    created: row.created,
    updated: row.updated,
  };
}

function childIdOf(recordId: string, parentOccurrence: string = SOURCE): FanoutChildId {
  return { parentOccurrence, handler: HANDLER, recordId };
}

/* -- Drift pins: literals, refusal reason, mirrors vs REAL work sources. -- */

describe("t34-f7 drift pins", () => {
  it("model literals match state dist AND real F2 constants", () => {
    assert.equal(T34F7_FANOUT_INTENT_MODEL, producers.tables.FANOUT_INTENT_MODEL);
    assert.equal(T34F7_FANOUT_CHECKPOINT_MODEL, producers.tables.FANOUT_CHECKPOINT_MODEL);
    assert.equal(T34F7_FANOUT_CHILD_MODEL, producers.tables.FANOUT_CHILD_MODEL);
    assert.equal(T34F7_FANOUT_INTENT_MODEL, work.WORK_FANOUT_INTENT_MODEL);
    assert.equal(T34F7_FANOUT_CHECKPOINT_MODEL, work.WORK_FANOUT_CHECKPOINT_MODEL);
    assert.equal(T34F7_FANOUT_CHILD_MODEL, work.WORK_FANOUT_CHILD_MODEL);
  });

  it("T32 refusal reason matches F3 and F5 (inaccessible-record, never deletion)", () => {
    assert.equal(producers.outcome.FANOUT_T32_REFUSAL_REASON, "inaccessible-record");
    assert.equal(work.FANOUT_T32_REFUSAL_REASON, "inaccessible-record");
  });

  it("outcome projection matches REAL F3 over every terminal shape", () => {
    const shapes: ReadonlyArray<{
      readonly state: string;
      readonly causeKind: string | null;
      readonly causeReason: string | null;
      readonly attempts: number;
    }> = [
      { state: "completed", causeKind: "completed", causeReason: null, attempts: 1 },
      { state: "skipped", causeKind: "skipped", causeReason: "deleted", attempts: 0 },
      { state: "skipped", causeKind: "skipped", causeReason: "non-applicable", attempts: 0 },
      { state: "failed", causeKind: "failed", causeReason: "business-rejection", attempts: 1 },
      { state: "failed", causeKind: "failed", causeReason: "terminal", attempts: 2 },
      { state: "failed", causeKind: "failed", causeReason: "exhausted", attempts: 3 },
      { state: "failed", causeKind: "failed", causeReason: "missing-record", attempts: 0 },
      { state: "failed", causeKind: "failed", causeReason: "inaccessible-record", attempts: 0 },
      { state: "failed", causeKind: "failed", causeReason: "infra-read-failure", attempts: 1 },
      { state: "pending", causeKind: null, causeReason: null, attempts: 0 },
      { state: "running", causeKind: null, causeReason: null, attempts: 1 },
    ];
    for (const shape of shapes) {
      const row = work.newFanoutChildRow(
        {
          fanoutId: "fanout/v1/occ/h/model",
          parentOccurrence: "occ",
          handler: "h",
          recordId: "r1",
          state: shape.state,
          attempts: shape.attempts,
          causeKind: shape.causeKind,
          causeReason: shape.causeReason,
        },
        { nowMs: NOW, actor: ACTOR },
      );
      const f2data = work.readFanoutChildRow(row);
      const expected = work.fanoutChildOutcomeFromRow(f2data);
      const actual = fanoutChildOutcomeFromData(
        producers.tables.readFanoutChildRow(row),
      );
      assert.deepEqual(actual, expected);
    }
  });

  it("staleness matches REAL F4 at the boundary (inclusive) and on negatives", () => {
    const cases: ReadonlyArray<readonly [number, number, number]> = [
      [1000, 2000, 1000],
      [1000, 1999, 1000],
      [1000, 2001, 1000],
      [0, 0, 0],
      [500, 500, 0],
    ];
    for (const [claimedAt, now, maxAge] of cases) {
      assert.equal(
        isFanoutRowClaimStale(claimedAt, now, maxAge),
        work.isFanoutClaimStale(claimedAt, now, maxAge),
      );
    }
    assert.throws(() => isFanoutRowClaimStale(-1, 0, 0), RangeError);
    assert.throws(() => isFanoutRowClaimStale(0, -1, 0), RangeError);
    assert.throws(() => isFanoutRowClaimStale(0, 0, -1), RangeError);
    assert.throws(() => work.isFanoutClaimStale(-1, 0, 0), RangeError);
  });
});

/* -- Atomic trigger/intent staging (M2/C2). -- */

describe("t34-f7 atomic trigger join", () => {
  it("commits source truth + intent + checkpoint + first chunk in ONE batch", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2", "c3"]);
    const before = await world.store.readRevision();
    const sourceRow = makeRow({ id: "src-1", data: { done: true } });
    const joined = await triggerJoin(world, {
      bounds: { pageLimit: 2, chunkSize: 2 },
      stageSource: () => ({
        writes: [{ kind: "insert", model: asModel(MODEL), row: sourceRow }],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      }),
    });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    assert.deepEqual(joined.members, ["c1", "c2", "c3"]);
    assert.equal(joined.chunksTotal, 2);
    assert.equal(joined.cursor, "admit/1");
    assert.equal(joined.cutoffRevision, before);
    assert.equal(joined.commitRevision, (before as number) + 1);
    assert.equal(await world.store.readRevision(), (before as number) + 1);
    // Both halves durable at the same revision.
    assert.ok((await world.store.load(asModel(MODEL), asId("src-1"))) !== null);
    const intentRow = await world.store.load(T34F7_FANOUT_INTENT_MODEL, joined.fanoutId as RecordId);
    assert.ok(intentRow !== null);
    assert.deepEqual(producers.tables.readFanoutIntentRow(intentRow).members, ["c1", "c2", "c3"]);
    const checkpointRow = await world.store.load(
      T34F7_FANOUT_CHECKPOINT_MODEL,
      joined.fanoutId as RecordId,
    );
    assert.ok(checkpointRow !== null);
    assert.deepEqual(producers.tables.readFanoutCheckpointRow(checkpointRow).completed, []);
    assert.equal(producers.tables.readFanoutCheckpointRow(checkpointRow).cursor, "admit/1");
    assert.equal((await drainChildren(world.store, joined.fanoutId)).length, 2);
  });

  it("trigger rejection voids BOTH halves (nothing staged, nothing committed)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const before = await world.store.readRevision();
    await assert.rejects(
      stageFanoutTriggerJoin({
        store: world.store,
        cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
        cohort: { kind: "model", owner: world.owner, model: MODEL },
        owner: world.owner,
        bounds: { pageLimit: 10, chunkSize: 10 },
        meta: { nowMs: NOW, actor: ACTOR },
        stageSource: () => {
          throw new StateError("rule_failed", "trigger body rejected");
        },
        producers,
      }),
      /trigger body rejected/,
    );
    assert.equal(await world.store.readRevision(), before);
    const fanoutId = producers.tables.fanoutIntentRowId(SOURCE, HANDLER, "model");
    assert.equal(await world.store.load(T34F7_FANOUT_INTENT_MODEL, fanoutId as RecordId), null);
    assert.equal(
      await world.store.load(T34F7_FANOUT_CHECKPOINT_MODEL, fanoutId as RecordId),
      null,
    );
  });

  it("fence conflict voids BOTH halves with an explicit retryable diagnosis", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const before = await world.store.readRevision();
    const failing: StoragePort = {
      ...world.store,
      commit: async () => {
        throw new FenceConflictError(before, ((before as number) + 1) as Revision);
      },
    };
    const joined = await stageFanoutTriggerJoin({
      store: failing,
      cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
      cohort: { kind: "model", owner: world.owner, model: MODEL },
      owner: world.owner,
      bounds: { pageLimit: 10, chunkSize: 10 },
      meta: { nowMs: NOW, actor: ACTOR },
      stageSource: () => ({
        writes: [
          {
            kind: "insert",
            model: asModel(MODEL),
            row: makeRow({ id: "src-lost", data: {} }),
          },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      }),
      producers,
    });
    assert.equal(joined.ok, false);
    if (joined.ok) throw new Error("unreachable");
    assert.equal(joined.diagnosis.kind, "membership-unavailable");
    assert.match(joined.diagnosis.message, /lost the fence/);
    assert.equal(await world.store.readRevision(), before);
    assert.equal(await world.store.load(asModel(MODEL), asId("src-lost")), null);
    const fanoutId = producers.tables.fanoutIntentRowId(SOURCE, HANDLER, "model");
    assert.equal(await world.store.load(T34F7_FANOUT_INTENT_MODEL, fanoutId as RecordId), null);
  });

  it("duplicate trigger diagnoses honestly; NEITHER half commits twice", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const first = await triggerJoin(world);
    assert.equal(first.ok, true);
    if (!first.ok) throw new Error("unreachable");
    const before = await world.store.readRevision();
    const second = await triggerJoin(world, {
      stageSource: () => ({
        writes: [
          { kind: "insert", model: asModel(MODEL), row: makeRow({ id: "src-dup", data: {} }) },
        ],
        history: [],
        receipt: null,
        outbox: [],
        schedules: [],
        uniqueClaims: [],
        uniqueReleases: [],
      }),
    });
    assert.equal(second.ok, false);
    if (second.ok) throw new Error("unreachable");
    assert.equal(second.diagnosis.kind, "membership-unavailable");
    assert.match(second.diagnosis.message, /already frozen/);
    assert.equal(await world.store.readRevision(), before);
    assert.equal(await world.store.load(asModel(MODEL), asId("src-dup")), null);
    const intentRow = await world.store.load(T34F7_FANOUT_INTENT_MODEL, first.fanoutId as RecordId);
    assert.ok(intentRow !== null);
    assert.deepEqual(producers.tables.readFanoutIntentRow(intentRow).members, ["c1"]);
  });

  it("pre-admission diagnoses before ANY write (cross-owner/model/anchor/bounds)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const before = await world.store.readRevision();
    const cross = await triggerJoin(world, { opOwner: "team-stranger" });
    assert.equal(cross.ok, false);
    if (cross.ok) throw new Error("unreachable");
    assert.equal(cross.diagnosis.kind, "cross-owner-cohort");
    const unknownModel = await triggerJoin(world, {
      cohortModel: "Acme.Nope",
      hasModel: () => false,
    });
    assert.equal(unknownModel.ok, false);
    if (unknownModel.ok) throw new Error("unreachable");
    assert.equal(unknownModel.diagnosis.kind, "unsupported-cohort");
    const unknownAnchor = await triggerJoin(world, {
      cohortKind: "anchored-collection",
      parent: { model: "Acme.Opportunity", id: "opp-ghost" },
    });
    assert.equal(unknownAnchor.ok, false);
    if (unknownAnchor.ok) throw new Error("unreachable");
    assert.equal(unknownAnchor.diagnosis.kind, "membership-unavailable");
    await assert.rejects(triggerJoin(world, { bounds: { pageLimit: 0, chunkSize: 10 } }), /pageLimit/);
    await assert.rejects(triggerJoin(world, { bounds: { pageLimit: 10, chunkSize: 0 } }), /chunkSize/);
    assert.equal(await world.store.readRevision(), before);
    assert.equal((await world.store.query({ model: T34F7_FANOUT_INTENT_MODEL, authority: "owner" })).length, 0);
    assert.equal((await world.store.query({ model: T34F7_FANOUT_CHILD_MODEL, authority: "owner" })).length, 0);
  });

  it("anchored cohort freezes exactly the pinned parent's children", async () => {
    const world = await setupWorld();
    const parentOf = (parentId: string) => ({ model: asModel("Acme.Opportunity"), id: asId(parentId) });
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          { kind: "insert", model: asModel("Acme.Opportunity"), row: makeRow({ id: "opp-1", data: {} }) },
          {
            kind: "insert",
            model: asModel(MODEL),
            row: { ...makeRow({ id: "s1", data: {} }), parent: parentOf("opp-1") },
          },
          {
            kind: "insert",
            model: asModel(MODEL),
            row: { ...makeRow({ id: "s2", data: {} }), parent: parentOf("opp-1") },
          },
          {
            kind: "insert",
            model: asModel(MODEL),
            row: { ...makeRow({ id: "decoy", data: {} }), parent: parentOf("opp-2") },
          },
        ],
      }),
    );
    const joined = await triggerJoin(world, {
      cohortKind: "anchored-collection",
      parent: { model: "Acme.Opportunity", id: "opp-1" },
    });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    assert.deepEqual(joined.members, ["s1", "s2"]);
  });
});

/* -- Durable claim/record vs REAL F3 (same F1 outcomes, same F2 rows). -- */

describe("t34-f7 durable claim matches REAL F3", () => {
  interface ClaimCase {
    readonly name: string;
    readonly snapshotVersion: number | null;
    readonly guardVerdict: boolean | null;
    readonly fence: "none" | "revoked" | "inherited" | "ok";
    readonly expectedStatus: string;
  }

  const CASES: ReadonlyArray<ClaimCase> = [
    { name: "unconditional claim wins", snapshotVersion: null, guardVerdict: null, fence: "none", expectedStatus: "claimed" },
    { name: "version-matched claim wins", snapshotVersion: 1, guardVerdict: null, fence: "none", expectedStatus: "claimed" },
    { name: "stale snapshot refuses", snapshotVersion: 999, guardVerdict: null, fence: "none", expectedStatus: "refused-stale" },
    { name: "guard-true claims", snapshotVersion: null, guardVerdict: true, fence: "none", expectedStatus: "claimed" },
    { name: "guard-false skips", snapshotVersion: null, guardVerdict: false, fence: "none", expectedStatus: "skipped" },
    { name: "revoked authority refuses", snapshotVersion: null, guardVerdict: null, fence: "revoked", expectedStatus: "refused-revoked" },
    { name: "inherited scope refuses before the guard", snapshotVersion: null, guardVerdict: false, fence: "inherited", expectedStatus: "refused-inherited-scope" },
    { name: "fresh fence claims", snapshotVersion: null, guardVerdict: true, fence: "ok", expectedStatus: "claimed" },
  ];

  for (const claimCase of CASES) {
    it(`${claimCase.name} (F1 outcome + F2 row identical)`, async () => {
      const world = await setupWorld();
      await seedDomain(world.store, MODEL, ["c1"]);
      const joined = await triggerJoin(world);
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("unreachable");
      const child = childIdOf("c1");
      // F3 oracle over the identical admitted row.
      const f3 = new work.TestOnlyMemoryFanoutChildStore({ nowMs: () => NOW });
      const admitted = await world.store.load(
        T34F7_FANOUT_CHILD_MODEL,
        producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c1") as RecordId,
      );
      assert.ok(admitted !== null);
      f3.insert(admitted);
      const predicate = claimCase.guardVerdict === null ? null : "g1";
      // Inherited-scope refuses BEFORE the guard: the evaluator must
      // never run there (it throws if it does, on BOTH paths).
      const evaluateGuard =
        claimCase.fence === "inherited"
          ? () => {
              throw new Error("guard must not run before inherited-scope refusal");
            }
          : () => claimCase.guardVerdict ?? true;
      const f3Fence =
        claimCase.fence === "none"
          ? undefined
          : claimCase.fence === "inherited"
            ? {
                checkpoint: { revision: 7, owner: world.owner },
                triggerRevision: { revision: 7 },
                revalidateAuthority: () => true,
              }
            : {
                checkpoint: { revision: 7, owner: world.owner },
                revalidateAuthority: () => claimCase.fence !== "revoked",
              };
      const f3Outcome = f3.claim(evaluateGuard, {
        child,
        snapshotVersion: claimCase.snapshotVersion,
        guard: { predicate },
        frozenInputs: null,
        readCurrentSnapshot: () => ({}),
        ...(f3Fence === undefined ? {} : { fence: f3Fence }),
      });
      assert.equal(f3Outcome.status, claimCase.expectedStatus);
      // Runtime durable claim over the real substrate.
      const fence =
        claimCase.fence === "none"
          ? undefined
          : claimCase.fence === "inherited"
            ? {
                owner: world.owner,
                triggerRevision: { revision: (await world.store.readRevision()) as number },
                revalidateAuthority: () => true,
              }
            : {
                owner: world.owner,
                revalidateAuthority: () => claimCase.fence !== "revoked",
              };
      const rtOutcome = await claimFanoutChild({
        store: world.store,
        child,
        snapshotVersion: claimCase.snapshotVersion,
        guard: { predicate },
        frozenInputs: null,
        readCurrentSnapshot: () => ({}),
        evaluateGuard,
        ...(fence === undefined ? {} : { fence }),
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      });
      assert.equal(rtOutcome.status, claimCase.expectedStatus);
      assert.ok(f3Outcome.row !== undefined && "row" in rtOutcome);
      assert.deepEqual(pickChildData(rtOutcome.row), pickChildData(f3Outcome.row));
      if ("outcome" in rtOutcome && "outcome" in f3Outcome) {
        assert.deepEqual(rtOutcome.outcome, f3Outcome.outcome);
      } else {
        assert.equal("outcome" in rtOutcome, "outcome" in f3Outcome);
      }
      // Pins carry the checkpoint cover in the same batch (durable-only
      // assertion; refused-stale pins nothing — the row never moved).
      if (
        rtOutcome.status === "skipped" ||
        rtOutcome.status === "refused-revoked" ||
        rtOutcome.status === "refused-inherited-scope"
      ) {
        const checkpoint = await world.store.load(
          T34F7_FANOUT_CHECKPOINT_MODEL,
          joined.fanoutId as RecordId,
        );
        assert.ok(checkpoint !== null);
        assert.ok(producers.tables.readFanoutCheckpointRow(checkpoint).completed.includes("c1"));
      }
      if (rtOutcome.status === "refused-stale") {
        const checkpoint = await world.store.load(
          T34F7_FANOUT_CHECKPOINT_MODEL,
          joined.fanoutId as RecordId,
        );
        assert.ok(checkpoint !== null);
        assert.deepEqual(producers.tables.readFanoutCheckpointRow(checkpoint).completed, []);
      }
    });
  }

  it("held + replayed match F3 (no duplicate, mint nothing)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const base = {
      store: world.store,
      snapshotVersion: null as number | null,
      guard: { predicate: null as string | null },
      frozenInputs: null,
      readCurrentSnapshot: () => ({}),
      evaluateGuard: () => true,
      policy: POLICY,
      meta: { nowMs: NOW, actor: ACTOR },
      producers,
    };
    const first = await claimFanoutChild({ ...base, child: childIdOf("c1") });
    assert.equal(first.status, "claimed");
    const held = await claimFanoutChild({ ...base, child: childIdOf("c1") });
    assert.equal(held.status, "held");
    if (first.status !== "claimed" || held.status !== "held") throw new Error("unreachable");
    assert.equal(held.row.version, first.row.version);
    const terminal = await recordFanoutChildAttempt({
      store: world.store,
      child: childIdOf("c1"),
      result: { kind: "completed" },
      nowMs: NOW,
      policy: POLICY,
      meta: { nowMs: NOW, actor: ACTOR },
      producers,
    });
    assert.equal(terminal.status, "recorded");
    const replayed = await claimFanoutChild({ ...base, child: childIdOf("c1") });
    assert.equal(replayed.status, "replayed");
    // F3 oracle agrees on held + replayed.
    const f3 = new work.TestOnlyMemoryFanoutChildStore({ nowMs: () => NOW });
    const admitted = await world.store.load(
      T34F7_FANOUT_CHILD_MODEL,
      producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c2") as RecordId,
    );
    assert.ok(admitted !== null);
    f3.insert(admitted);
    const f3First = f3.claim(() => true, {
      child: childIdOf("c2"),
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: null,
      readCurrentSnapshot: () => ({}),
    });
    assert.equal(f3First.status, "claimed");
    const f3Held = f3.claim(() => true, {
      child: childIdOf("c2"),
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: null,
      readCurrentSnapshot: () => ({}),
    });
    assert.equal(f3Held.status, "held");
    assert.ok(f3First.row !== undefined && f3Held.row !== undefined);
    assert.equal(f3Held.row.version, f3First.row.version);
  });

  it("missing child row throws (producer write missing, F3-exact)", async () => {
    const world = await setupWorld();
    await assert.rejects(
      claimFanoutChild({
        store: world.store,
        child: childIdOf("ghost"),
        snapshotVersion: null,
        guard: { predicate: null },
        frozenInputs: null,
        readCurrentSnapshot: () => ({}),
        evaluateGuard: () => true,
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      }),
      /producer write missing/,
    );
  });

  it("evaluator throw propagates with nothing committed", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const before = await world.store.readRevision();
    await assert.rejects(
      claimFanoutChild({
        store: world.store,
        child: childIdOf("c1"),
        snapshotVersion: null,
        guard: { predicate: "boom" },
        frozenInputs: null,
        readCurrentSnapshot: () => ({}),
        evaluateGuard: () => {
          throw new Error("evaluator exploded");
        },
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      }),
      /evaluator exploded/,
    );
    assert.equal(await world.store.readRevision(), before);
    const row = await world.store.load(
      T34F7_FANOUT_CHILD_MODEL,
      producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c1") as RecordId,
    );
    assert.ok(row !== null);
    assert.equal(producers.tables.readFanoutChildRow(row).state, "pending");
  });
});

describe("t34-f7 durable record matches REAL F3", () => {
  interface RecordCase {
    readonly name: string;
    readonly result: FanoutChildAttemptResult;
    readonly startAttempts: number;
    readonly nowMs: number;
    readonly expectedStatus: string;
  }

  const CASES: ReadonlyArray<RecordCase> = [
    { name: "completed records", result: { kind: "completed" }, startAttempts: 0, nowMs: NOW, expectedStatus: "recorded" },
    { name: "skipped/deleted records attempts-unchanged", result: { kind: "skipped", reason: "deleted" }, startAttempts: 1, nowMs: NOW, expectedStatus: "recorded" },
    { name: "failed/terminal records", result: { kind: "failed", reason: "terminal" }, startAttempts: 0, nowMs: NOW, expectedStatus: "recorded" },
    { name: "transient retries within budget", result: { kind: "transient" }, startAttempts: 0, nowMs: NOW, expectedStatus: "retried" },
    { name: "transient exhausts at the attempt cap", result: { kind: "transient" }, startAttempts: 2, nowMs: NOW, expectedStatus: "recorded" },
    { name: "transient exhausts past the horizon", result: { kind: "transient" }, startAttempts: 0, nowMs: NOW + POLICY.horizonMs, expectedStatus: "recorded" },
  ];

  for (const recordCase of CASES) {
    it(`${recordCase.name} (F1 outcome + F2 row identical)`, async () => {
      const world = await setupWorld();
      await seedDomain(world.store, MODEL, ["c1"]);
      const joined = await triggerJoin(world);
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("unreachable");
      const child = childIdOf("c1");
      // F3 oracle: claim then record from the identical admitted row.
      const f3 = new work.TestOnlyMemoryFanoutChildStore({ nowMs: () => NOW });
      const key = producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c1") as RecordId;
      const admitted = await world.store.load(T34F7_FANOUT_CHILD_MODEL, key);
      assert.ok(admitted !== null);
      // Attempts pre-staging: record transient (startAttempts) times first.
      f3.insert(admitted);
      const f3claim = f3.claim(() => true, {
        child,
        snapshotVersion: null,
        guard: { predicate: null },
        frozenInputs: null,
        readCurrentSnapshot: () => ({}),
      });
      assert.equal(f3claim.status, "claimed");
      for (let i = 0; i < recordCase.startAttempts; i += 1) {
        const pre = f3.record({
          child,
          result: { kind: "transient" },
          nowMs: NOW,
          firstAttemptAtMs: NOW,
          policy: POLICY,
        });
        assert.equal(pre.status, "retried");
        const reclaim = f3.claim(() => true, {
          child,
          snapshotVersion: null,
          guard: { predicate: null },
          frozenInputs: null,
          readCurrentSnapshot: () => ({}),
        });
        assert.equal(reclaim.status, "claimed");
      }
      const f3Outcome = f3.record({
        child,
        result: recordCase.result,
        nowMs: recordCase.nowMs,
        firstAttemptAtMs: NOW,
        policy: POLICY,
      });
      assert.equal(f3Outcome.status, recordCase.expectedStatus);
      // Runtime durable path: claim then matching pre-records then record.
      const rtClaim = await claimFanoutChild({
        store: world.store,
        child,
        snapshotVersion: null,
        guard: { predicate: null },
        frozenInputs: null,
        readCurrentSnapshot: () => ({}),
        evaluateGuard: () => true,
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      });
      assert.equal(rtClaim.status, "claimed");
      for (let i = 0; i < recordCase.startAttempts; i += 1) {
        const pre = await recordFanoutChildAttempt({
          store: world.store,
          child,
          result: { kind: "transient" },
          nowMs: NOW,
          policy: POLICY,
          meta: { nowMs: NOW, actor: ACTOR },
          producers,
        });
        assert.equal(pre.status, "retried");
        const reclaim = await claimFanoutChild({
          store: world.store,
          child,
          snapshotVersion: null,
          guard: { predicate: null },
          frozenInputs: null,
          readCurrentSnapshot: () => ({}),
          evaluateGuard: () => true,
          policy: POLICY,
          meta: { nowMs: NOW, actor: ACTOR },
          producers,
        });
        assert.equal(reclaim.status, "claimed");
      }
      const rtOutcome = await recordFanoutChildAttempt({
        store: world.store,
        child,
        result: recordCase.result,
        nowMs: recordCase.nowMs,
        policy: POLICY,
        // F3 stamps records at input.nowMs; mirror the stamp for row identity.
        meta: { nowMs: recordCase.nowMs, actor: ACTOR },
        producers,
      });
      assert.equal(rtOutcome.status, recordCase.expectedStatus);
      assert.deepEqual(pickChildData(rtOutcome.row), pickChildData(f3Outcome.row));
      assert.deepEqual(
        "outcome" in rtOutcome ? rtOutcome.outcome : null,
        f3Outcome.outcome ?? null,
      );
      if (recordCase.expectedStatus === "recorded") {
        const checkpoint = await world.store.load(
          T34F7_FANOUT_CHECKPOINT_MODEL,
          joined.fanoutId as RecordId,
        );
        assert.ok(checkpoint !== null);
        assert.ok(producers.tables.readFanoutCheckpointRow(checkpoint).completed.includes("c1"));
      }
      if (recordCase.name.includes("exhausts")) {
        assert.equal("outcome" in rtOutcome, true);
        if (!("outcome" in rtOutcome)) throw new Error("unreachable");
        assert.deepEqual(rtOutcome.outcome.cause, { kind: "failed", reason: "exhausted" });
      }
    });
  }

  it("record against pending throws; supplied exhausted throws (F3-exact)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    await assert.rejects(
      recordFanoutChildAttempt({
        store: world.store,
        child: childIdOf("c1"),
        result: { kind: "completed" },
        nowMs: NOW,
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      }),
      /running children only/,
    );
    const claimed = await claimFanoutChild({
      store: world.store,
      child: childIdOf("c1"),
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: null,
      readCurrentSnapshot: () => ({}),
      evaluateGuard: () => true,
      policy: POLICY,
      meta: { nowMs: NOW, actor: ACTOR },
      producers,
    });
    assert.equal(claimed.status, "claimed");
    await assert.rejects(
      recordFanoutChildAttempt({
        store: world.store,
        child: childIdOf("c1"),
        result: { kind: "failed", reason: "exhausted" as never },
        nowMs: NOW,
        policy: POLICY,
        meta: { nowMs: NOW, actor: ACTOR },
        producers,
      }),
      /never supplied/,
    );
  });

  it("first-attempt anchor is created, stable across transitions", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world, { meta: { nowMs: NOW - 5000, actor: ACTOR } });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const key = producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c1") as RecordId;
    const admitted = await world.store.load(T34F7_FANOUT_CHILD_MODEL, key);
    assert.ok(admitted !== null);
    assert.equal(fanoutFirstAttemptAnchor(admitted), NOW - 5000);
    const claimed = await claimFanoutChild({
      store: world.store,
      child: childIdOf("c1"),
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: null,
      readCurrentSnapshot: () => ({}),
      evaluateGuard: () => true,
      policy: POLICY,
      meta: { nowMs: NOW, actor: ACTOR },
      producers,
    });
    assert.equal(claimed.status, "claimed");
    if (claimed.status !== "claimed") throw new Error("unreachable");
    assert.equal(claimed.row.created, NOW - 5000);
    assert.equal(fanoutFirstAttemptAnchor(claimed.row), NOW - 5000);
    const retried = await recordFanoutChildAttempt({
      store: world.store,
      child: childIdOf("c1"),
      result: { kind: "transient" },
      nowMs: NOW,
      policy: POLICY,
      meta: { nowMs: NOW, actor: ACTOR },
      producers,
    });
    assert.equal(retried.status, "retried");
    if (retried.status !== "retried") throw new Error("unreachable");
    assert.equal(retried.row.created, NOW - 5000);
  });
});

describe("t34-f7 fair scheduler turns", () => {
  it("bounded turns progress ALL children in id order to terminal", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2", "c3", "c4", "c5", "c6"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const calls = new Map<string, number>();
    const bounds = { pageLimit: 2, maxDrives: 2 };
    const seen: string[] = [];
    let cursor: string | null = null;
    let turns = 0;
    for (;;) {
      const result = await runFanoutSchedulerTurn(
        turnOpts(world, joined.fanoutId, cursor, bounds, completedBody(calls)),
      );
      assert.equal(result.status, "turn");
      if (result.status !== "turn") throw new Error("unreachable");
      turns += 1;
      seen.push(...result.driven.map((d) => d.recordId));
      assert.ok(result.driven.length <= 2);
      for (const driven of result.driven) {
        assert.equal(driven.status, "recorded");
        assert.equal(driven.detail, "completed");
      }
      if (result.done) break;
      cursor = result.cursor;
    }
    assert.equal(turns, 4);
    assert.deepEqual(seen, ["c1", "c2", "c3", "c4", "c5", "c6"]);
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6"]) {
      assert.equal(calls.get(id), 1);
      const domain = await world.store.load(asModel(MODEL), asId(id));
      assert.ok(domain !== null);
      assert.equal((domain.data as Record<string, unknown>)["reviewed"], true);
    }
    const progress = await readFanoutSchedulerProgress({
      store: world.store,
      fanoutId: joined.fanoutId,
      pageLimit: 10,
      producers,
    });
    assert.deepEqual(
      [progress.pending, progress.running, progress.completed, progress.terminal, progress.attention],
      [0, 0, 6, true, false],
    );
    const checkpoint = await world.store.load(
      T34F7_FANOUT_CHECKPOINT_MODEL,
      joined.fanoutId as RecordId,
    );
    assert.ok(checkpoint !== null);
    assert.deepEqual(producers.tables.readFanoutCheckpointRow(checkpoint).completed, [
      "c1",
      "c2",
      "c3",
      "c4",
      "c5",
      "c6",
    ]);
  });

  it("no stalled child starves others (transient-twice rejoins later sweeps)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2", "c3"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const calls = new Map<string, number>();
    const flaky: FanoutSchedulerBodyPort = async (child, domainRow) => {
      const count = (calls.get(child.recordId) ?? 0) + 1;
      calls.set(child.recordId, count);
      const next: StoredRow = {
        ...domainRow,
        version: (domainRow.version + 1) as StoredRow["version"],
        updated: NOW,
        updatedBy: ACTOR,
        data: { ...(domainRow.data as Record<string, unknown>), reviewed: true },
      };
      return {
        writes: [
          {
            kind: "update",
            model: asModel(MODEL),
            id: domainRow.id,
            expectedVersion: domainRow.version,
            row: next,
          },
        ],
        history: [],
        outbox: [],
        schedules: [],
        result: child.recordId === "c2" && count < 3 ? { kind: "transient" } : { kind: "completed" },
      };
    };
    const stats = await sweepToTerminal(async (cursor) =>
      turnOpts(world, joined.fanoutId, cursor, { pageLimit: 1, maxDrives: 1 }, flaky),
    );
    assert.equal(stats.sweeps, 3);
    // Siblings finished on sweep 1 while c2 stalled: no starvation.
    assert.equal(calls.get("c1"), 1);
    assert.equal(calls.get("c3"), 1);
    assert.equal(calls.get("c2"), 3);
    const c2 = await world.store.load(
      T34F7_FANOUT_CHILD_MODEL,
      producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c2") as RecordId,
    );
    assert.ok(c2 !== null);
    const c2data = producers.tables.readFanoutChildRow(c2);
    assert.equal(c2data.state, "completed");
    assert.equal(c2data.attempts, 3);
  });

  it("chunk != cohort: varying bounds visit identical sets with identical outcomes", async () => {
    const boundSets: ReadonlyArray<FanoutSchedulerTurnBounds> = [
      { pageLimit: 1, maxDrives: 1 },
      { pageLimit: 2, maxDrives: 3 },
      { pageLimit: 100, maxDrives: 100 },
    ];
    const finals: string[] = [];
    for (const bounds of boundSets) {
      const world = await setupWorld();
      await seedDomain(world.store, MODEL, ["c1", "c2", "c3", "c4", "c5"]);
      const joined = await triggerJoin(world, { bounds: { pageLimit: 2, chunkSize: 2 } });
      assert.equal(joined.ok, true);
      if (!joined.ok) throw new Error("unreachable");
      const calls = new Map<string, number>();
      await sweepToTerminal(async (cursor) =>
        turnOpts(world, joined.fanoutId, cursor, bounds, completedBody(calls), {
          freeze: {
            cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
            cohort: { kind: "model", owner: world.owner, model: MODEL },
            owner: world.owner,
            bounds: { pageLimit: 2, chunkSize: 2, maxAttempts: 3 },
          },
        }),
      );
      const rows = await drainChildren(world.store, joined.fanoutId);
      const summary = rows
        .map((row) => {
          const d = producers.tables.readFanoutChildRow(row);
          return `${d.recordId}:${d.state}:${d.attempts}:${d.causeKind ?? ""}:${d.causeReason ?? ""}`;
        })
        .sort()
        .join("|");
      finals.push(summary);
      // Admission completed through freeze replay despite the small trigger chunk.
      assert.equal(rows.length, 5);
      const checkpoint = await world.store.load(
        T34F7_FANOUT_CHECKPOINT_MODEL,
        joined.fanoutId as RecordId,
      );
      assert.ok(checkpoint !== null);
      assert.equal(producers.tables.readFanoutCheckpointRow(checkpoint).cursor, null);
      assert.deepEqual(producers.tables.readFanoutCheckpointRow(checkpoint).completed, [
        "c1",
        "c2",
        "c3",
        "c4",
        "c5",
      ]);
    }
    assert.equal(finals[0], finals[1]);
    assert.equal(finals[1], finals[2]);
  });

  it("mid-sweep resume from cursor completes identically (new scheduler state)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2", "c3", "c4"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const calls = new Map<string, number>();
    const bounds = { pageLimit: 2, maxDrives: 2 };
    const first = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, bounds, completedBody(calls)),
    );
    assert.equal(first.status, "turn");
    if (first.status !== "turn") throw new Error("unreachable");
    assert.equal(first.done, false);
    assert.ok(first.cursor !== null);
    assert.equal(first.progress.terminal, false);
    // Drop ALL scheduler state; resume purely from the durable cursor.
    const resumedCursor: string | null = first.cursor;
    let cursor: string | null = resumedCursor;
    for (;;) {
      const result = await runFanoutSchedulerTurn(
        turnOpts(world, joined.fanoutId, cursor, bounds, completedBody(calls)),
      );
      assert.equal(result.status, "turn");
      if (result.status !== "turn") throw new Error("unreachable");
      if (result.done) {
        assert.equal(result.progress.terminal, true);
        break;
      }
      cursor = result.cursor;
    }
    for (const id of ["c1", "c2", "c3", "c4"]) assert.equal(calls.get(id), 1);
  });

  it("stale claims release and re-drive; terminal children replay without re-invoke", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    // Simulate a crashed worker: c1 claimed long ago and never recorded.
    const stale = await claimFanoutChild({
      store: world.store,
      child: childIdOf("c1"),
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: null,
      readCurrentSnapshot: () => ({}),
      evaluateGuard: () => true,
      policy: POLICY,
      meta: { nowMs: NOW - MAX_AGE - 1, actor: ACTOR },
      producers,
    });
    assert.equal(stale.status, "claimed");
    const calls = new Map<string, number>();
    await sweepToTerminal(async (cursor) =>
      turnOpts(world, joined.fanoutId, cursor, { pageLimit: 10, maxDrives: 10 }, completedBody(calls)),
    );
    assert.equal(calls.get("c1"), 1);
    assert.equal(calls.get("c2"), 1);
    // Re-sweep after terminal: every child replays, bodies never re-run.
    const replay = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, completedBody(calls)),
    );
    assert.equal(replay.status, "turn");
    if (replay.status !== "turn") throw new Error("unreachable");
    for (const driven of replay.driven) assert.equal(driven.status, "replayed");
    assert.equal(calls.get("c1"), 1);
    assert.equal(calls.get("c2"), 1);
  });

  it("fresh claims hold (live worker may hold them; never touched)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const held = await claimFanoutChild({
      store: world.store,
      child: childIdOf("c1"),
      snapshotVersion: null,
      guard: { predicate: null },
      frozenInputs: null,
      readCurrentSnapshot: () => ({}),
      evaluateGuard: () => true,
      policy: POLICY,
      meta: { nowMs: NOW, actor: ACTOR },
      producers,
    });
    assert.equal(held.status, "claimed");
    const calls = new Map<string, number>();
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, completedBody(calls)),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    assert.deepEqual(result.released, []);
    assert.equal(result.driven.length, 1);
    const only = result.driven[0];
    assert.ok(only !== undefined);
    assert.equal(only.status, "held");
    assert.equal(calls.get("c1"), undefined);
    assert.equal(result.progress.terminal, false);
  });
});

describe("t34-f7 scheduler pins, guards, revocation, exhaustion", () => {
  it("guard-false pins skipped without invoking; others complete", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const calls = new Map<string, number>();
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, completedBody(calls), {
        guard: { predicate: "eligible", frozenInputs: null },
        evaluateGuard: (predicate, frozen, snapshot) => {
          assert.equal(predicate, "eligible");
          void frozen;
          return (snapshot as { readonly id: string }).id !== "c2";
        },
        readSnapshot: (child) => ({ id: child.recordId }),
      }),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    const byId = new Map(result.driven.map((d) => [d.recordId, d]));
    assert.equal(byId.get("c1")?.status, "recorded");
    assert.equal(byId.get("c2")?.status, "pinned");
    assert.equal(byId.get("c2")?.detail, "skipped/non-applicable");
    assert.equal(calls.get("c1"), 1);
    assert.equal(calls.get("c2"), undefined);
    const c2 = await world.store.load(
      T34F7_FANOUT_CHILD_MODEL,
      producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c2") as RecordId,
    );
    assert.ok(c2 !== null);
    assert.equal(producers.tables.readFanoutChildRow(c2).attempts, 0);
  });

  it("archived member pins skipped/deleted; missing/infra pin failed (never deleted)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2", "c3"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    // Archive c1 post-freeze: demonstrable deletion.
    const c1row = await world.store.load(asModel(MODEL), asId("c1"));
    assert.ok(c1row !== null);
    const tombstoned: StoredRow = {
      ...c1row,
      version: (c1row.version + 1) as StoredRow["version"],
      archivedAt: NOW,
      updated: NOW,
      updatedBy: ACTOR,
    };
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: "update",
            model: asModel(MODEL),
            id: c1row.id,
            expectedVersion: c1row.version,
            row: tombstoned,
          },
        ],
      }),
    );
    // c2: null load + empty history (missing-record). c3: throwing load (infra).
    const wrapped: StoragePort = {
      ...world.store,
      load: async (model: ModelName, id: RecordId) => {
        if ((model as string) === MODEL && (id as string) === "c2") return null;
        if ((model as string) === MODEL && (id as string) === "c3") {
          throw new Error("disk exploded");
        }
        return world.store.load(model, id);
      },
      historyFor: async (model: ModelName, recordId: RecordId) => {
        if ((model as string) === MODEL && (recordId as string) === "c2") return [];
        return world.store.historyFor(model, recordId);
      },
    };
    const calls = new Map<string, number>();
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, completedBody(calls), {
        store: wrapped,
      }),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    const byId = new Map(result.driven.map((d) => [d.recordId, d]));
    assert.equal(byId.get("c1")?.status, "pinned");
    assert.equal(byId.get("c1")?.detail, "skipped/deleted");
    assert.equal(byId.get("c2")?.status, "pinned");
    assert.equal(byId.get("c2")?.detail, "failed/missing-record");
    assert.equal(byId.get("c3")?.status, "pinned");
    assert.equal(byId.get("c3")?.detail, "failed/infra-read-failure");
    assert.equal(calls.size, 0);
  });

  it("claim-time revocation refuses (failed/inaccessible-record, attempts 0); siblings continue", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const calls = new Map<string, number>();
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, completedBody(calls), {
        fenceFor: (child) => ({
          owner: world.owner,
          revalidateAuthority: () => child.recordId !== "c2",
        }),
      }),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    const byId = new Map(result.driven.map((d) => [d.recordId, d]));
    assert.equal(byId.get("c1")?.status, "recorded");
    assert.equal(byId.get("c2")?.status, "refused");
    assert.equal(byId.get("c2")?.detail, "failed/inaccessible-record");
    assert.equal(calls.get("c2"), undefined);
    const c2 = await world.store.load(
      T34F7_FANOUT_CHILD_MODEL,
      producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c2") as RecordId,
    );
    assert.ok(c2 !== null);
    assert.equal(producers.tables.readFanoutChildRow(c2).attempts, 0);
  });

  it("invoke-level revocation refuses via the forbidden path (live authority wins)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    await world.memberships.removeMembership(world.membershipId);
    const calls = new Map<string, number>();
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, completedBody(calls)),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    assert.equal(result.driven.length, 1);
    const only = result.driven[0];
    assert.ok(only !== undefined);
    assert.equal(only.status, "refused");
    assert.equal(only.detail, "failed/inaccessible-record");
    assert.equal(result.progress.attention, true);
    const c1 = await world.store.load(
      T34F7_FANOUT_CHILD_MODEL,
      producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c1") as RecordId,
    );
    assert.ok(c1 !== null);
    assert.equal(producers.tables.readFanoutChildRow(c1).attempts, 0);
  });

  it("business rejection pins failed/business-rejection (attempt counts)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const rejecting: FanoutSchedulerBodyPort = () => {
      throw new StateError("rule_failed", "child body rejected");
    };
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, rejecting),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    assert.equal(result.driven.length, 1);
    const only = result.driven[0];
    assert.ok(only !== undefined);
    assert.equal(only.status, "pinned");
    assert.equal(only.detail, "failed/business-rejection");
    const c1 = await world.store.load(
      T34F7_FANOUT_CHILD_MODEL,
      producers.tables.fanoutChildRowId(SOURCE, HANDLER, "c1") as RecordId,
    );
    assert.ok(c1 !== null);
    assert.equal(producers.tables.readFanoutChildRow(c1).attempts, 1);
  });

  it("attempt-cap exhaustion dead-letters with honest attention (never success)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1", "c2"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const transient: FanoutSchedulerBodyPort = async () => ({
      writes: [],
      history: [],
      outbox: [],
      schedules: [],
      result: { kind: "transient" },
    });
    const policy: RetryPolicy = { maxAttempts: 2, horizonMs: 3_600_000 };
    await sweepToTerminal(async (cursor) =>
      turnOpts(world, joined.fanoutId, cursor, { pageLimit: 10, maxDrives: 10 }, transient, { policy }),
    );
    const progress = await readFanoutSchedulerProgress({
      store: world.store,
      fanoutId: joined.fanoutId,
      pageLimit: 10,
      producers,
    });
    assert.deepEqual(
      [progress.failed, progress.terminal, progress.attention],
      [2, true, true],
    );
    const rows = await drainChildren(world.store, joined.fanoutId);
    for (const row of rows) {
      const d = producers.tables.readFanoutChildRow(row);
      assert.equal(d.state, "failed");
      assert.equal(d.causeReason, "exhausted");
      assert.equal(d.attempts, 2);
    }
    // Progress counts agree with REAL F3 summarizeFanoutChildren.
    const real = work.summarizeFanoutChildren(joined.fanoutId, rows);
    assert.deepEqual(
      [real.pending, real.running, real.completed, real.skipped, real.failed, real.terminal, real.attention],
      [progress.pending, progress.running, progress.completed, progress.skipped, progress.failed, progress.terminal, progress.attention],
    );
  });

  it("horizon enforces from the durable anchor (backdated admission exhausts)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world, { meta: { nowMs: NOW - POLICY.horizonMs - 1, actor: ACTOR } });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const transient: FanoutSchedulerBodyPort = async () => ({
      writes: [],
      history: [],
      outbox: [],
      schedules: [],
      result: { kind: "transient" },
    });
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, transient),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    assert.equal(result.driven.length, 1);
    const only = result.driven[0];
    assert.ok(only !== undefined);
    assert.equal(only.status, "recorded");
    assert.equal(only.detail, "failed/exhausted");
  });

  it("child unit commits atomically (domain + history + outbox + schedule + outcome + checkpoint)", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const full: FanoutSchedulerBodyPort = async (child, domainRow) => {
      const next: StoredRow = {
        ...domainRow,
        version: (domainRow.version + 1) as StoredRow["version"],
        updated: NOW,
        updatedBy: ACTOR,
        data: { ...(domainRow.data as Record<string, unknown>), reviewed: true },
      };
      return {
        writes: [
          {
            kind: "update",
            model: asModel(MODEL),
            id: domainRow.id,
            expectedVersion: domainRow.version,
            row: next,
          },
        ],
        history: [
          {
            model: asModel(MODEL),
            recordId: domainRow.id,
            version: next.version,
            operation: asOperation(CHILD_OP),
            operationId: nextOpId() as never,
            actor: ACTOR,
            at: NOW,
            change: "update",
            before: domainRow.data as Record<string, unknown>,
            after: next.data as Record<string, unknown>,
          },
        ],
        outbox: [
          {
            intentId: `obx_${child.recordId}`,
            operation: asOperation(CHILD_OP),
            operationId: nextOpId() as never,
            target: "Acme.notify",
            arguments: { record: child.recordId },
            occurrenceIndex: 0,
          },
        ],
        schedules: [
          {
            op: "replace",
            key: `review-${child.recordId}`,
            at: NOW + 1000,
            event: asOperation("Acme.remind"),
            payload: { record: child.recordId },
          },
        ],
        result: { kind: "completed" },
      };
    };
    const before = await world.store.readRevision();
    const result = await runFanoutSchedulerTurn(
      turnOpts(world, joined.fanoutId, null, { pageLimit: 10, maxDrives: 10 }, full),
    );
    assert.equal(result.status, "turn");
    if (result.status !== "turn") throw new Error("unreachable");
    // Claim + unit commit: exactly two revisions for one executed child.
    assert.equal(await world.store.readRevision(), (before as number) + 2);
    const domain = await world.store.load(asModel(MODEL), asId("c1"));
    assert.ok(domain !== null);
    assert.equal((domain.data as Record<string, unknown>)["reviewed"], true);
    assert.ok((await world.store.historyFor(asModel(MODEL), asId("c1"))).length > 0);
    const pending = await world.store.outboxPending();
    assert.ok(pending.some((intent) => intent.intentId === "obx_c1"));
    const schedule = await world.store.scheduleGet("review-c1");
    assert.ok(schedule !== null);
    const checkpoint = await world.store.load(
      T34F7_FANOUT_CHECKPOINT_MODEL,
      joined.fanoutId as RecordId,
    );
    assert.ok(checkpoint !== null);
    assert.ok(producers.tables.readFanoutCheckpointRow(checkpoint).completed.includes("c1"));
  });
});

describe("t34-f7 provider cancellation contract", () => {
  it("refuses explicitly without an accepted contract; rows untouched", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const before = JSON.stringify((await drainChildren(world.store, joined.fanoutId)).map(pickChildData));
    const revision = await world.store.readRevision();
    const outcome = await requestFanoutProviderCancel({});
    assert.deepEqual(outcome, {
      status: "refused",
      reason: "no-cancel-contract: the provider accepted no cancellation contract.",
    });
    assert.equal(await world.store.readRevision(), revision);
    assert.equal(
      JSON.stringify((await drainChildren(world.store, joined.fanoutId)).map(pickChildData)),
      before,
    );
  });

  it("routes the provider verdict with a contract; never writes rows", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, MODEL, ["c1"]);
    const joined = await triggerJoin(world);
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const before = JSON.stringify((await drainChildren(world.store, joined.fanoutId)).map(pickChildData));
    const revision = await world.store.readRevision();
    const seen: unknown[] = [];
    const cancelled = await requestFanoutProviderCancel({
      cancel: async (token: unknown) => {
        seen.push(token);
        return { cancelled: true };
      },
      token: { attempt: "a1" },
    });
    assert.deepEqual(cancelled, { status: "cancelled" });
    assert.deepEqual(seen, [{ attempt: "a1" }]);
    const failed = await requestFanoutProviderCancel({
      cancel: () => ({ cancelled: false, reason: "already-delivered" }),
    });
    assert.deepEqual(failed, { status: "cancel-failed", reason: "already-delivered" });
    await assert.rejects(requestFanoutProviderCancel({ cancel: () => ({ nope: 1 }) }), /boolean cancelled/);
    await assert.rejects(
      requestFanoutProviderCancel({ cancel: () => ({ cancelled: false, reason: "" }) }),
      /non-empty reason/,
    );
    assert.equal(await world.store.readRevision(), revision);
    assert.equal(
      JSON.stringify((await drainChildren(world.store, joined.fanoutId)).map(pickChildData)),
      before,
    );
  });
});

describe("t34-f7 assembly serving surface", () => {
  it("composes the six runtime entries frozen and callable", async () => {
    const surface = assembleFanoutServingSurface({
      stageTriggerJoin,
      claimChild: claimFanoutChild,
      recordAttempt: recordFanoutChildAttempt,
      runSchedulerTurn: runFanoutSchedulerTurn,
      readProgress: readFanoutSchedulerProgress,
      requestCancel: requestFanoutProviderCancel,
    });
    assert.ok(Object.isFrozen(surface));
    assert.equal(surface.stageTriggerJoin, stageFanoutTriggerJoin);
    assert.equal(surface.claimChild, claimFanoutChild);
    const refused = await (
      surface.requestCancel as typeof requestFanoutProviderCancel
    )({});
    assert.equal(refused.status, "refused");
  });

  it("fails loud on missing or non-function segments, naming the segment", () => {
    const full = {
      stageTriggerJoin,
      claimChild: claimFanoutChild,
      recordAttempt: recordFanoutChildAttempt,
      runSchedulerTurn: runFanoutSchedulerTurn,
      readProgress: readFanoutSchedulerProgress,
      requestCancel: requestFanoutProviderCancel,
    };
    for (const key of Object.keys(full) as (keyof typeof full)[]) {
      assert.throws(
        () => assembleFanoutServingSurface({ ...full, [key]: undefined }),
        new RegExp(`segment "${key}"`),
      );
      assert.throws(
        () => assembleFanoutServingSurface({ ...full, [key]: 42 }),
        new RegExp(`segment "${key}"`),
      );
    }
  });
});
