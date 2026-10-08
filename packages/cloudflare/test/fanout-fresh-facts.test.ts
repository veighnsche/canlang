import { describe, expect, it } from "vitest";
import type { DomainWrite, OperationId, RecordId, StoredRow } from "@canlang/contracts";
import { createMemoryStorage } from "@canlang/state/storage/memory";
import {
  FIXED_NOW, asModel, asOperation, createMemoryIdentityStore, makeBatch,
  makeDef, makeIdentity, makeRow, seedMember, uuidv7,
} from "@canlang/state/testing/invocation/fixtures";
import { assembleFanoutServingSurface } from "../src/worker/assembly.js";
import {
  T34F7_FANOUT_CHILD_MODEL as CHILD,
  claimFanoutChild, loadFanoutStateProducers, readFanoutSchedulerProgress,
  recordFanoutChildAttempt, releaseStaleFanoutClaims, requestFanoutProviderCancel,
  runFanoutSchedulerTurn, stageFanoutTriggerJoin,
} from "../src/runtime/invoke.js";
import type {
  FanoutSchedulerBodyPort, FanoutSchedulerTurnResult, RunFanoutSchedulerTurnOpts,
} from "../src/runtime/invoke.js";

const MODEL = "FreshFacts.Record";
const EFFECT = "FreshFacts.Effect";
const HANDLER = "FreshFacts.each";
const OP = "FreshFacts.child";
const SOURCE = "fresh-facts-occurrence";
const NOW = FIXED_NOW;
const AGE = 60_000;
const META = { nowMs: NOW, actor: "fanout-fresh-facts" };
const POLICY = { maxAttempts: 3, horizonMs: 60_000 };
const producers = await loadFanoutStateProducers();
// Exercise the exposed assembly join, preserving the real entry types.
const surface = assembleFanoutServingSurface({
  stageTriggerJoin: stageFanoutTriggerJoin, claimChild: claimFanoutChild,
  recordAttempt: recordFanoutChildAttempt, runSchedulerTurn: runFanoutSchedulerTurn,
  readProgress: readFanoutSchedulerProgress, requestCancel: requestFanoutProviderCancel,
});

async function world(ids: string[], versioned = false) {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const owner = member.team.team_id as string;
  const registry = new Map([[OP, makeDef({ name: asOperation(OP), by: "members",
    inputs: { record: { type: "record", model: asModel(MODEL), versioned, required: true } },
  })]]);
  await store.commit(makeBatch(await store.readRevision(), { writes: ids.map(id => ({
    kind: "insert", model: asModel(MODEL), row: makeRow({ id, data: { flag: "A" } }),
  })) }));
  const joined = await surface.stageTriggerJoin({ store,
    cutoff: { sourceOccurrence: SOURCE, handler: HANDLER },
    cohort: { kind: "model", model: MODEL, owner }, owner,
    bounds: { pageLimit: 10, chunkSize: 10 }, meta: META,
    hasModel: model => model === MODEL,
    stageSource: () => ({ writes: [], history: [], receipt: null, outbox: [],
      schedules: [], uniqueClaims: [], uniqueReleases: [] }), producers,
  });
  if (!joined.ok) throw new Error(`fixture trigger refused: ${JSON.stringify(joined)}`);
  let sequence = 0;
  return { store, memberships, member, owner, registry, fanoutId: joined.fanoutId,
    identity: makeIdentity({ membership: member.membership }),
    nextOperationId: () => uuidv7(NOW, ++sequence) };
}
type World = Awaited<ReturnType<typeof world>>;
const childId = (id: string) => ({ parentOccurrence: SOURCE, handler: HANDLER, recordId: id });
const rowId = (id: string) => producers.tables.fanoutChildRowId(SOURCE, HANDLER, id) as RecordId;

function options(w: World, body: FanoutSchedulerBodyPort, cursor: string | null = null,
  pageLimit = 1): RunFanoutSchedulerTurnOpts {
  return { store: w.store, fanoutId: w.fanoutId, cursor,
    bounds: { pageLimit, maxDrives: pageLimit }, policy: POLICY, meta: META,
    maxClaimAgeMs: AGE, cohort: { model: MODEL },
    guard: { predicate: null, frozenInputs: null }, evaluateGuard: () => true,
    readSnapshot: (_child, row) => row.data, fenceFor: () => ({ owner: w.owner,
      revalidateAuthority: () => true }), body,
    invoke: { registry: w.registry, memberships: w.memberships,
      clock: { nowMs: () => NOW }, identity: w.identity, app: "fresh-facts-app",
      source: "test", childOperation: OP, refInput: "record",
      operationIdFor: () => w.nextOperationId() }, producers };
}
function turn(result: FanoutSchedulerTurnResult) {
  if (result.status !== "turn") throw new Error(`unexpected diagnosis: ${JSON.stringify(result)}`);
  return result;
}
async function claim(w: World, id: string, nowMs: number) {
  const result = await surface.claimChild({ store: w.store, child: childId(id),
    snapshotVersion: null, guard: { predicate: null }, frozenInputs: null,
    readCurrentSnapshot: () => ({}), evaluateGuard: () => true, policy: POLICY,
    meta: { ...META, nowMs }, producers });
  expect(result.status).toBe("claimed");
}
async function terminalPrefix() {
  const w = await world(["a", "b"]);
  await claim(w, "a", NOW);
  await surface.recordAttempt({ store: w.store, child: childId("a"),
    result: { kind: "completed" }, nowMs: NOW,
    policy: POLICY, meta: META, producers });
  await claim(w, "b", NOW - AGE - 1);
  expect(rowId("a") < rowId("b")).toBe(true);
  return w;
}
function effectBody(seen: string[], before?: (row: StoredRow) => Promise<void>): FanoutSchedulerBodyPort {
  return async (child, row, attempt) => {
    seen.push(row.data["flag"] as string);
    await before?.(row);
    // Independent output row/outbox/schedule: no expectedVersion on the source A.
    const effectRow = makeRow({ id: `effect-${child.recordId}`,
      data: { flag: row.data["flag"], operationId: attempt.operationId } });
    return { writes: [{ kind: "insert", model: asModel(EFFECT), row: effectRow }],
      history: [], outbox: [{ intentId: `${attempt.operationId}#0`,
        operation: asOperation(OP), operationId: attempt.operationId as OperationId,
        target: "FreshFacts.deliver", arguments: { flag: row.data["flag"] }, occurrenceIndex: 0 }],
      schedules: [{ op: "replace", key: `effect-${child.recordId}`, at: NOW,
        event: asOperation("FreshFacts.due"), payload: { flag: row.data["flag"] } }],
      result: { kind: "completed" } };
  };
}
async function changeToB(w: World) {
  const a = (await w.store.load(asModel(MODEL), "a" as RecordId))!;
  const row: StoredRow = { ...a, version: (a.version + 1) as StoredRow["version"], data: { flag: "B" } };
  const write: DomainWrite = { kind: "update", model: asModel(MODEL), id: a.id,
    expectedVersion: a.version, row };
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [write] }));
}
async function effectFlags(w: World) {
  return { row: (await w.store.load(asModel(EFFECT), "effect-a" as RecordId))?.data["flag"],
    outbox: (await w.store.outboxPending()).map(x => x.arguments["flag"]),
    schedule: (await w.store.scheduleGet("effect-a"))?.payload["flag"] };
}

describe("fanout exposed consumer current facts", () => {
  it("GAP-L01: terminal prefix does not permanently strand a later stale claim at pageLimit1", async () => {
    const w = await terminalPrefix(), seen: string[] = [], trace: unknown[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const result = turn(await surface.runSchedulerTurn(options(w, effectBody(seen), cursor)));
      trace.push({ cursor, next: result.cursor, done: result.done, released: result.released,
        driven: result.driven, terminal: result.progress.terminal });
      if (result.progress.terminal) break;
      cursor = result.done ? null : result.cursor;
    }
    const b = producers.tables.readFanoutChildRow((await w.store.load(CHILD, rowId("b")))!);
    expect({ state: b.state, attempts: b.attempts, bodyCalls: seen.length }, JSON.stringify(trace))
      .toEqual({ state: "completed", attempts: 1, bodyCalls: 1 });
  });
  it("release helper continuation already reaches the stale row beyond a terminal prefix", async () => {
    const w = await terminalPrefix();
    const first = await releaseStaleFanoutClaims({ store: w.store, fanoutId: w.fanoutId,
      cursor: null, limit: 1, nowMs: NOW, maxClaimAgeMs: AGE, meta: META, producers });
    expect(first.released).toEqual([]);
    expect(first.done).toBe(false);
    const next = await releaseStaleFanoutClaims({ store: w.store, fanoutId: w.fanoutId,
      cursor: first.cursor, limit: 1, nowMs: NOW, maxClaimAgeMs: AGE, meta: META, producers });
    expect(next.released).toEqual([rowId("b")]);
    expect(producers.tables.readFanoutChildRow((await w.store.load(CHILD, rowId("b")))!).attempts).toBe(0);
  });
  it("larger drive/release page completes the same fixture without replaying terminal a", async () => {
    const w = await terminalPrefix(), seen: string[] = [];
    const result = turn(await surface.runSchedulerTurn(options(w, effectBody(seen), null, 2)));
    expect(result.released).toEqual([rowId("b")]);
    expect(result.progress.terminal).toBe(true);
    expect(seen).toEqual(["A"]);
  });
  it("fresh claims remain held and terminal replay does not repeat effects", async () => {
    const w = await world(["a"]), seen: string[] = [];
    await claim(w, "a", NOW);
    const held = turn(await surface.runSchedulerTurn(options(w, effectBody(seen))));
    expect(held.released).toEqual([]);
    expect(held.driven[0]?.status).toBe("held");
    expect(seen).toEqual([]);
    const live = await world(["a"]);
    await surface.runSchedulerTurn(options(live, effectBody(seen)));
    const revision = await live.store.readRevision();
    const replay = turn(await surface.runSchedulerTurn(options(live, effectBody(seen))));
    expect(replay.driven[0]?.status).toBe("replayed");
    expect(await live.store.readRevision()).toBe(revision);
    expect(seen).toEqual(["A"]);
  });
  it("GAP-L03: pre-admission A to B change produces effects from admitted B", async () => {
    const w = await world(["a"]), seen: string[] = [], reads: string[] = [];
    const load = w.store.load;
    w.store.load = async (model, id) => { const row = await load(model, id);
      if (model === MODEL && row) reads.push(row.data["flag"] as string); return row; };
    const readRevision = w.store.readRevision;
    let armed = false, changed = false;
    w.store.readRevision = async () => {
      if (armed && !changed) { changed = true; await changeToB(w); }
      return readRevision();
    };
    const opts = options(w, effectBody(seen));
    await surface.runSchedulerTurn({ ...opts, invoke: { ...opts.invoke,
      operationIdFor: () => { armed = true; return w.nextOperationId(); } } });
    expect(changed).toBe(true);
    expect(reads).toContain("B");
    expect({ seen, effects: await effectFlags(w) }, JSON.stringify({ reads }))
      .toEqual({ seen: ["B"], effects: { row: "B", outbox: ["B"], schedule: "B" } });
  });
  it("GAP-L03: a fence retry re-executes with the newly admitted B row", async () => {
    const w = await world(["a"]), seen: string[] = [];
    const result = turn(await surface.runSchedulerTurn(options(w, effectBody(seen,
      async () => { if (seen.length === 1) await changeToB(w); }))));
    expect(result.driven[0]?.status).toBe("recorded");
    expect({ seen, effects: await effectFlags(w) }).toEqual({ seen: ["A", "B"],
      effects: { row: "B", outbox: ["B"], schedule: "B" } });
  });
  it("GAP-L03: claim guard reads B at its fresh checkpoint instead of the earlier A copy", async () => {
    const w = await world(["a"]), seen: string[] = [], guardFacts: unknown[] = [];
    const readRevision = w.store.readRevision;
    let armed = false, changed = false;
    w.store.readRevision = async () => {
      if (armed && !changed) { changed = true; await changeToB(w); }
      return readRevision();
    };
    const opts = options(w, effectBody(seen));
    const result = turn(await surface.runSchedulerTurn({ ...opts,
      fenceFor: () => { armed = true; return { owner: w.owner, revalidateAuthority: () => true }; },
      guard: { predicate: "eligible", frozenInputs: null },
      evaluateGuard: (_predicate, _frozen, snapshot) => {
        guardFacts.push(snapshot); return (snapshot as { flag: string }).flag === "B";
      } }));
    expect(changed).toBe(true);
    expect({ guardFacts, seen, status: result.driven[0]?.status, effects: await effectFlags(w) })
      .toEqual({ guardFacts: [{ flag: "B" }], seen: ["B"], status: "recorded",
        effects: { row: "B", outbox: ["B"], schedule: "B" } });
  });
  it("the versioned-ref profile submits the current required version", async () => {
    const w = await world(["a"], true), seen: string[] = [];
    const result = turn(await surface.runSchedulerTurn(options(w, effectBody(seen))));
    expect(result.driven[0]?.status).toBe("recorded");
    expect(seen).toEqual(["A"]);
    expect((await w.store.load(asModel(EFFECT), "effect-a" as RecordId))?.data["flag"]).toBe("A");
  });
  it("canonical current membership refusal pins inaccessible without body effects", async () => {
    const w = await world(["a"]), seen: string[] = [];
    const find = w.memberships.findMembership;
    let revoked = false;
    w.memberships.findMembership = async (...args) => {
      if (!revoked) { revoked = true; await w.memberships.removeMembership(w.member.membership.membership_id); }
      return find(...args);
    };
    const result = turn(await surface.runSchedulerTurn(options(w, effectBody(seen))));
    expect(result.driven[0]?.status).toBe("refused");
    expect(result.driven[0]?.detail).toBe("failed/inaccessible-record");
    expect(seen).toEqual([]);
    expect(await w.store.load(asModel(EFFECT), "effect-a" as RecordId)).toBeNull();
  });
  it("an infrastructure lifecycle read failure stays unknown and never executes the body", async () => {
    const w = await world(["a"]), seen: string[] = [], load = w.store.load;
    w.store.load = async (model, id) => {
      if (model === MODEL) throw new Error("controlled owner read failure");
      return load(model, id);
    };
    const result = turn(await surface.runSchedulerTurn(options(w, effectBody(seen))));
    expect(result.driven[0]?.status).toBe("pinned");
    expect(result.driven[0]?.detail).toBe("failed/infra-read-failure");
    expect(seen).toEqual([]);
    expect(await w.store.load(asModel(EFFECT), "effect-a" as RecordId)).toBeNull();
  });
});

describe('fanout demand and admitted-reference controls', () => {
  for (const mode of ['read-error', 'missing', 'archived', 'history-error', 'transient-null'] as const) {
    it(`claim-demand ${mode} retains the owning lifecycle outcome before guard/body effects`, async () => {
      const w = await world(['a']), seen: string[] = [], snapshots: unknown[] = [];
      const load = w.store.load, revision = w.store.readRevision;
      let armed = false, changed = false;
      w.store.load = async (model, id) => {
        if (model === MODEL && armed && !changed) {
          changed = true;
          if (mode === 'read-error') throw new Error('demand-time owner read failure');
          if (mode === 'transient-null') return null;
          const row = (await load(model, id))!;
          const write: DomainWrite = mode === 'archived'
            ? { kind: 'update', model: asModel(MODEL), id: row.id, expectedVersion: row.version,
                row: { ...row, version: (row.version + 1) as StoredRow['version'], archivedAt: NOW } }
            : { kind: 'remove', model: asModel(MODEL), id: row.id, expectedVersion: row.version };
          await w.store.commit(makeBatch(await revision(), { writes: [write] }));
        }
        return load(model, id);
      };
      if (mode === 'history-error') w.store.historyFor = async () => { throw new Error('demand-time history failure'); };
      const opts = options(w, effectBody(seen));
      const result = turn(await surface.runSchedulerTurn({ ...opts,
        fenceFor: () => { armed = true; return { owner: w.owner, revalidateAuthority: () => true }; },
        guard: { predicate: 'eligible', frozenInputs: null },
        readSnapshot: (_child, row) => { snapshots.push(row.data); return row.data; },
      }));
      expect(changed).toBe(true);
      expect(snapshots).toEqual([]);
      expect(seen).toEqual([]);
      expect(await w.store.load(asModel(EFFECT), 'effect-a' as RecordId)).toBeNull();
      const expected = mode === 'archived' ? 'skipped/deleted' : mode === 'missing' ? 'failed/missing-record'
        : mode === 'transient-null' ? 'lifecycle-race' : 'failed/infra-read-failure';
      expect(result.driven[0]?.detail).toBe(expected);
      expect(result.driven[0]?.status).toBe(mode === 'transient-null' ? 'retry' : 'pinned');
      const child = producers.tables.readFanoutChildRow((await w.store.load(CHILD, rowId('a')))!);
      expect(child.attempts).toBe(0);
      expect(child.state).toBe(mode === 'transient-null' ? 'pending' : mode === 'archived' ? 'skipped' : 'failed');
    });
  }
  for (const stage of ['snapshot', 'guard'] as const) {
    it(`a throwing ${stage} keeps its original error and leaves the claim pending`, async () => {
      const w = await world(['a']), seen: string[] = [], original = new Error(stage);
      const opts = options(w, effectBody(seen));
      await expect(surface.runSchedulerTurn({ ...opts, guard: { predicate: 'eligible', frozenInputs: null },
        readSnapshot: (_child, row) => { if (stage === 'snapshot') throw original; return row.data; },
        evaluateGuard: () => { if (stage === 'guard') throw original; return true; },
      })).rejects.toBe(original);
      expect(seen).toEqual([]);
      const child = producers.tables.readFanoutChildRow((await w.store.load(CHILD, rowId('a')))!);
      expect({ state: child.state, attempts: child.attempts }).toEqual({ state: 'pending', attempts: 0 });
    });
  }
  it('each actual admitted cohort member reaches the body with its own record identity', async () => {
    const w = await world(['a', 'b']);
    const b = (await w.store.load(asModel(MODEL), 'b' as RecordId))!;
    await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update',
      model: asModel(MODEL), id: b.id, expectedVersion: b.version,
      row: { ...b, version: (b.version + 1) as StoredRow['version'], data: { flag: 'B' } },
    }] }));
    const seen: Array<[string, string, unknown]> = [];
    const body: FanoutSchedulerBodyPort = (child, row) => {
      seen.push([child.recordId, row.id as string, row.data['flag']]);
      return { writes: [], history: [], outbox: [], schedules: [], result: { kind: 'completed' } };
    };
    const first = turn(await surface.runSchedulerTurn(options(w, body)));
    const next = turn(await surface.runSchedulerTurn(options(w, body, first.cursor)));
    expect(seen).toEqual([['a', 'a', 'A'], ['b', 'b', 'B']]);
    expect(next.progress.terminal).toBe(true);
  });
  it('a truncated drive resumes after its last processed child while release follows that continuation', async () => {
    const w = await world(['a', 'b', 'c']), seen: string[] = [];
    await claim(w, 'a', NOW);
    await surface.recordAttempt({ store: w.store, child: childId('a'), result: { kind: 'completed' },
      nowMs: NOW, policy: POLICY, meta: META, producers });
    await claim(w, 'b', NOW - AGE - 1);
    await claim(w, 'c', NOW - AGE - 1);
    let cursor: string | null = null;
    const driven: string[] = [];
    const released: string[] = [];
    for (let i = 0; i < 4; i++) {
      const opts = options(w, effectBody(seen), cursor, 2);
      const result = turn(await surface.runSchedulerTurn({ ...opts, bounds: { pageLimit: 2, maxDrives: 1 } }));
      driven.push(...result.driven.map(child => child.recordId));
      released.push(...result.released);
      if (result.progress.terminal) break;
      expect(result.done).toBe(false);
      expect(result.cursor).toBe(rowId(result.driven[0]!.recordId));
      cursor = result.cursor;
    }
    expect(driven).toEqual(['a', 'b', 'c']);
    expect(released.sort()).toEqual([rowId('b'), rowId('c')]);
    expect(seen).toEqual(['A', 'A']);
    for (const id of ['b', 'c']) expect(producers.tables.readFanoutChildRow((await w.store.load(CHILD, rowId(id)))!))
      .toMatchObject({ state: 'completed', attempts: 1 });
  });
  for (const skew of ['missing', 'param', 'model', 'id', 'row-id', 'duplicate'] as const) {
    it(`an admitted producer ${skew} association skew refuses before body effects`, async () => {
      const w = await world(['a']), seen: string[] = [];
      const opts = options(w, effectBody(seen));
      // Declared producer-skew profile around the actual canonical admission/retry path.
      const skewed = { ...producers, invoke: {
        async invokeFanoutChild(input: Parameters<typeof producers.invoke.invokeFanoutChild>[0]) {
          return producers.invoke.invokeFanoutChild({ ...input, execute: call => {
            const ref = call.recordRefs[0]!;
            const changed = { ...ref,
              ...(skew === 'param' ? { param: 'other' } : {}),
              ...(skew === 'model' ? { model: asModel('Other.Model') } : {}),
              ...(skew === 'id' ? { id: 'other' as RecordId } : {}),
              ...(skew === 'row-id' ? { row: { ...ref.row, id: 'other' as RecordId } } : {}),
            };
            return input.execute({ ...call, recordRefs: skew === 'missing' ? [] : skew === 'duplicate' ? [ref, ref] : [changed] });
          } });
        },
      } };
      await expect(surface.runSchedulerTurn({ ...opts, producers: skewed }))
        .rejects.toThrow('execution needs exactly one admitted child record ref');
      expect(seen).toEqual([]);
      expect(await w.store.load(asModel(EFFECT), 'effect-a' as RecordId)).toBeNull();
      expect(await w.store.outboxPending()).toEqual([]);
      expect(await w.store.scheduleGet('effect-a')).toBeNull();
      expect(producers.tables.readFanoutChildRow((await w.store.load(CHILD, rowId('a')))!)).toMatchObject({ state: 'running', attempts: 0 });
    });
  }
});
