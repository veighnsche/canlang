/**
 * T34-F7/C1 emitted-cohort consumer (colocated): the actual
 * Cloudflare consumer of the F6 `appDefinition.cohorts` emission —
 * resolution of emitted descriptors + trigger context into runtime
 * specs, staged through the REAL `stageFanoutTriggerJoin`.
 * MEMORY-ONLY proofs (no persist channel), following the
 * `t34-f7-fanout.test.ts` world/fixture conventions.
 *
 * Fixture emission mirrors the F6 byte-exact golden
 * (`compiler/tests/codegen.rs` `f6_emit_both_cohorts`: model +
 * anchored-collection + bind:null spellings) and annotates with
 * `EmittedAppDefinitionCohorts`, so the honest emission shape is a
 * compile-time constraint.
 *
 * Run from dist: root build, then
 * `node --test dist/runtime/t34-f7-emitted-cohorts.test.js`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RecordId, StoragePort } from "@canlang/contracts";
import { createMemoryStorage } from "../../../state/dist/state/src/storage/memory.js";
import {
  FIXED_NOW,
  asId,
  asModel,
  createMemoryIdentityStore,
  makeBatch,
  makeRow,
  seedMember,
} from "../../../state/dist/state/test/invocation/fixtures.js";
import {
  T34F7_FANOUT_CHILD_MODEL,
  T34F7_FANOUT_INTENT_MODEL,
  loadFanoutStateProducers,
  readFanoutSchedulerProgress,
  resolveEmittedFanoutCohort,
  stageEmittedFanoutTriggerJoin,
} from "./invoke.js";
import type {
  EmittedAppDefinitionCohorts,
  EmittedAppDefinitionModels,
  FanoutStateProducers,
} from "./invoke.js";

const TODO = "Acme.Todo";
const SIGNUP = "Acme.Signup";
const OPP = "Acme.Opportunity";
const SWEEP = "Acme.sweep";
const CANCEL_EACH = "Acme.cancel_each";
const PLAIN = "Acme.plain";
const SOURCE = "occ-emitted-1";
const ACTOR = "t34-f7-emitted-test";
const NOW = FIXED_NOW;

const producers: FanoutStateProducers = await loadFanoutStateProducers();

/* -- World setup (memory store + fixture memberships/identity). -- */

interface World {
  readonly store: StoragePort;
  readonly owner: string;
}

async function setupWorld(): Promise<World> {
  const store = createMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, owner: alice.team.team_id as string };
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

async function seedAnchored(
  store: StoragePort,
  anchorId: string,
  childIds: ReadonlyArray<string>,
  decoyId: string,
): Promise<void> {
  const revision = await store.readRevision();
  const parentOf = (parentId: string) => ({ model: asModel(OPP), id: asId(parentId) });
  await store.commit(
    makeBatch(revision as number, {
      writes: [
        { kind: "insert", model: asModel(OPP), row: makeRow({ id: anchorId, data: {} }) },
        ...childIds.map((id) => ({
          kind: "insert" as const,
          model: asModel(SIGNUP),
          row: { ...makeRow({ id, data: {} }), parent: parentOf(anchorId) },
        })),
        {
          kind: "insert" as const,
          model: asModel(SIGNUP),
          row: { ...makeRow({ id: decoyId, data: {} }), parent: parentOf("opp-decoy") },
        },
      ],
    }),
  );
}

/* -- Emitted fixtures (F6 byte-shape; see header). -- */

const COHORTS: EmittedAppDefinitionCohorts = {
  [SWEEP]: { kind: "model", model: TODO, bind: "todo" },
  [CANCEL_EACH]: { kind: "anchored-collection", model: SIGNUP, parent: "event.opportunity", bind: "signup" },
  [PLAIN]: { kind: "model", model: TODO, bind: null },
};

const MODELS: EmittedAppDefinitionModels = {
  [TODO]: {},
  [SIGNUP]: { parent: OPP },
  [OPP]: {},
};

const SERVABLE = (model: string): boolean => model === TODO || model === SIGNUP || model === OPP;

function emittedJoin(
  world: World,
  args: {
    readonly handler?: string;
    readonly cohorts?: unknown;
    readonly models?: unknown;
    readonly event?: unknown;
    readonly bounds?: { readonly pageLimit: number; readonly chunkSize: number };
    readonly hasModel?: (model: string) => boolean;
  } = {},
) {
  return stageEmittedFanoutTriggerJoin({
    store: world.store,
    cutoff: { sourceOccurrence: SOURCE, handler: args.handler ?? SWEEP },
    cohorts: args.cohorts ?? COHORTS,
    models: args.models ?? MODELS,
    event: args.event ?? {},
    owner: world.owner,
    bounds: args.bounds ?? { pageLimit: 10, chunkSize: 10 },
    meta: { nowMs: NOW, actor: ACTOR },
    stageSource: () => ({
      writes: [],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    }),
    hasModel: args.hasModel ?? SERVABLE,
    producers,
  });
}

describe("t34-f7/c1 emitted cohort resolution", () => {
  const base = {
    cohorts: COHORTS,
    handler: SWEEP,
    owner: "owner-1",
    event: {},
    models: MODELS,
  };

  it("resolves the model spelling to an owner-attested whole-model spec", () => {
    assert.deepEqual(resolveEmittedFanoutCohort(base), { kind: "model", owner: "owner-1", model: TODO });
    assert.deepEqual(resolveEmittedFanoutCohort({ ...base, handler: PLAIN }), {
      kind: "model",
      owner: "owner-1",
      model: TODO,
    });
  });

  it("resolves the anchored spelling: event id + emitted containment model", () => {
    assert.deepEqual(
      resolveEmittedFanoutCohort({ ...base, handler: CANCEL_EACH, event: { opportunity: "opp-9" } }),
      {
        kind: "anchored-collection",
        owner: "owner-1",
        model: SIGNUP,
        parent: { model: OPP, id: "opp-9" },
      },
    );
  });

  it("walks multi-segment event paths", () => {
    const cohorts: EmittedAppDefinitionCohorts = {
      deep: { kind: "anchored-collection", model: SIGNUP, parent: "event.a.b", bind: null },
    };
    assert.deepEqual(resolveEmittedFanoutCohort({ ...base, cohorts, handler: "deep", event: { a: { b: "opp-2" } } }), {
      kind: "anchored-collection",
      owner: "owner-1",
      model: SIGNUP,
      parent: { model: OPP, id: "opp-2" },
    });
  });

  it("ignores richer emitted members (only the read edges matter)", () => {
    const cohorts = {
      rich: { kind: "model", model: TODO, bind: "todo", future: { nested: [1, 2] } },
    } as unknown as EmittedAppDefinitionCohorts;
    const models = {
      [TODO]: { parent: undefined, owner: "team", label: "x", fields: {} },
    } as unknown as EmittedAppDefinitionModels;
    assert.deepEqual(resolveEmittedFanoutCohort({ ...base, cohorts, models, handler: "rich" }), {
      kind: "model",
      owner: "owner-1",
      model: TODO,
    });
  });

  it("throws loud on empty handler/owner", () => {
    assert.throws(() => resolveEmittedFanoutCohort({ ...base, handler: "" }), /non-empty handler/);
    assert.throws(() => resolveEmittedFanoutCohort({ ...base, owner: "" }), /non-empty operating owner/);
  });

  it("throws loud on a non-object cohorts member", () => {
    for (const cohorts of [null, 42, "x", []]) {
      assert.throws(
        () => resolveEmittedFanoutCohort({ ...base, cohorts }),
        /appDefinition\.cohorts.*must be an object/,
      );
    }
  });

  it("throws loud when the handler names no emitted cohort", () => {
    assert.throws(
      () => resolveEmittedFanoutCohort({ ...base, handler: "Acme.nofanout" }),
      /"Acme\.nofanout" names no emitted fanout cohort/,
    );
  });

  it("throws loud on malformed descriptors", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ kind: "quorum", model: TODO, bind: null }, /has kind "quorum"/],
      [{ kind: "model", model: "", bind: null }, /cohort model.*non-empty string/],
      [{ kind: "model", model: TODO, bind: 5 }, /non-string non-null "as" binding/],
      [{ kind: "model", model: TODO }, /non-string non-null "as" binding/],
      [{ kind: "anchored-collection", model: SIGNUP, bind: null }, /cohort parent path.*non-empty string/],
      [
        { kind: "anchored-collection", model: SIGNUP, parent: "opportunity", bind: null },
        /non-event-rooted parent path/,
      ],
      [{ kind: "anchored-collection", model: SIGNUP, parent: "event.", bind: null }, /non-event-rooted/],
      [{ kind: "anchored-collection", model: SIGNUP, parent: "event", bind: null }, /non-event-rooted/],
      [42, /cohort descriptor.*must be an object/],
    ];
    for (const [descriptor, pattern] of cases) {
      assert.throws(
        () =>
          resolveEmittedFanoutCohort({
            ...base,
            cohorts: { bad: descriptor } as unknown as EmittedAppDefinitionCohorts,
            handler: "bad",
          }),
        pattern,
      );
    }
  });

  it("throws loud when the child has no contained parent in models", () => {
    const event = { opportunity: "opp-1" };
    assert.throws(
      () => resolveEmittedFanoutCohort({ ...base, handler: CANCEL_EACH, event, models: null }),
      /appDefinition\.models.*must be an object/,
    );
    assert.throws(
      () => resolveEmittedFanoutCohort({ ...base, handler: CANCEL_EACH, event, models: {} }),
      /model "Acme\.Signup".*must be an object/,
    );
    assert.throws(
      () =>
        resolveEmittedFanoutCohort({
          ...base,
          handler: CANCEL_EACH,
          event,
          models: { [SIGNUP]: {} } as unknown as EmittedAppDefinitionModels,
        }),
      /contained parent of model "Acme\.Signup".*non-empty string/,
    );
  });

  it("throws loud when the parent path does not resolve to a string id", () => {
    const run = (event: unknown): unknown =>
      resolveEmittedFanoutCohort({ ...base, handler: CANCEL_EACH, event });
    assert.throws(() => run({}), /non-string id/);
    assert.throws(() => run({ opportunity: "" }), /non-string id/);
    assert.throws(() => run({ opportunity: 42 }), /non-string id/);
    assert.throws(() => run(null), /event segment "opportunity".*must be an object/);
  });
});

describe("t34-f7/c1 emitted trigger staging through the real join", () => {
  it("stages a model cohort: frozen members + intent + first-chunk children", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, TODO, ["t1", "t2", "t3"]);
    const joined = await emittedJoin(world, { handler: SWEEP });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    assert.deepEqual([...joined.members], ["t1", "t2", "t3"]);
    assert.equal(joined.chunksTotal, 1);
    assert.equal(joined.cursor, null);
    const intentRow = await world.store.load(T34F7_FANOUT_INTENT_MODEL, joined.fanoutId as RecordId);
    assert.ok(intentRow !== null);
    const intent = producers.tables.readFanoutIntentRow(intentRow);
    assert.equal(intent.handler, SWEEP);
    assert.deepEqual([...intent.members], ["t1", "t2", "t3"]);
    for (const id of ["t1", "t2", "t3"]) {
      const rowId = producers.tables.fanoutChildRowId(SOURCE, SWEEP, id);
      const row = await world.store.load(T34F7_FANOUT_CHILD_MODEL, rowId as RecordId);
      assert.ok(row !== null);
      assert.equal(producers.tables.readFanoutChildRow(row).state, "pending");
    }
  });

  it("stages an anchored cohort: exactly the event parent's children", async () => {
    const world = await setupWorld();
    await seedAnchored(world.store, "opp-1", ["s1", "s2"], "decoy");
    const joined = await emittedJoin(world, { handler: CANCEL_EACH, event: { opportunity: "opp-1" } });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    assert.deepEqual([...joined.members], ["s1", "s2"]);
  });

  it("admission diagnoses flow through: unknown anchor + unservable model", async () => {
    const ghost = await setupWorld();
    const unknown = await emittedJoin(ghost, { handler: CANCEL_EACH, event: { opportunity: "opp-ghost" } });
    assert.equal(unknown.ok, false);
    if (unknown.ok) throw new Error("unreachable");
    assert.equal(unknown.diagnosis.kind, "membership-unavailable");

    const world = await setupWorld();
    await seedDomain(world.store, TODO, ["t1"]);
    const unsupported = await emittedJoin(world, { handler: SWEEP, hasModel: () => false });
    assert.equal(unsupported.ok, false);
    if (unsupported.ok) throw new Error("unreachable");
    assert.equal(unsupported.diagnosis.kind, "unsupported-cohort");
  });

  it("resolution failure commits nothing", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, TODO, ["t1"]);
    const before = await world.store.readRevision();
    await assert.rejects(emittedJoin(world, { handler: "Acme.nofanout" }), /names no emitted fanout cohort/);
    assert.equal(await world.store.readRevision(), before);
  });

  it("emitted-staged fanouts read through operator progress", async () => {
    const world = await setupWorld();
    await seedDomain(world.store, TODO, ["t1", "t2", "t3"]);
    const joined = await emittedJoin(world, { handler: PLAIN });
    assert.equal(joined.ok, true);
    if (!joined.ok) throw new Error("unreachable");
    const progress = await readFanoutSchedulerProgress({
      store: world.store,
      fanoutId: joined.fanoutId,
      pageLimit: 10,
      producers,
    });
    assert.deepEqual(
      [progress.pending, progress.running, progress.completed, progress.terminal, progress.attention],
      [3, 0, 0, false, false],
    );
  });
});
