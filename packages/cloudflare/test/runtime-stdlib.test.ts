import { describe, expect, it } from "vitest";
import type {
  CommitBatch,
  CommitResult,
  ModelName,
  QuerySpec,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { createContext, type HandlerContext } from "../src/runtime/context.js";
import {
  cancel,
  check,
  count,
  create,
  deleteRecord,
  delivery,
  emit,
  hasRole,
  records,
  require as guardRequire,
  schedule,
  secretEqual,
  send,
  set,
} from "../src/runtime/stdlib.js";

const NOW = 1700000000000;

function row(id: string, version: number, data: Record<string, unknown>): StoredRow {
  return {
    id: id as RecordId,
    version: version as StoredRow["version"],
    created: NOW - 1000,
    updated: NOW - 1000,
    createdBy: "seed",
    updatedBy: "seed",
    archivedAt: null,
    data,
  };
}

interface Fake {
  port: StoragePort;
  revisions: number;
  loads: Array<{ model: string; id: string }>;
  specs: QuerySpec[];
  batches: CommitBatch[];
  rows: Map<string, StoredRow>;
}

function fakeStore(seed: StoredRow[] = []): Fake {
  const fake: Fake = {
    port: null as unknown as StoragePort,
    revisions: 0,
    loads: [],
    specs: [],
    batches: [],
    rows: new Map(seed.map((r) => [`${"Todo"}${r.id as string}`, r])),
  };
  const unused = (): Promise<never> => {
    throw new Error("unused StoragePort method");
  };
  fake.port = {
    readRevision: async (): Promise<Revision> => {
      fake.revisions += 1;
      return 7 as Revision;
    },
    load: async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
      fake.loads.push({ model: model as string, id: id as string });
      return fake.rows.get(`${model as string}${id as string}`) ?? null;
    },
    query: async (spec: QuerySpec): Promise<ReadonlyArray<StoredRow>> => {
      fake.specs.push(spec);
      return [...fake.rows.values()];
    },
    commit: async (batch: CommitBatch): Promise<CommitResult> => {
      fake.batches.push(batch);
      return { revision: 8 as Revision };
    },
    readReceipt: unused,
    outboxPending: unused,
    scheduleGet: unused,
    schedulesDue: unused,
    historyFor: unused,
    readInstalledSnapshot: unused,
    readMigrationProgress: unused,
    readStagedRows: unused,
    stageMigrationRows: unused,
    publishMigrationChunk: unused,
    flipInstalledSnapshot: unused,
    readMigrationOutcomes: unused,
  };
  return fake;
}

function contextFor(fake: Fake): HandlerContext {
  return createContext({
    caller: { userId: "u1", roles: ["member"] },
    store: fake.port,
    clock: () => NOW,
  });
}

describe("create", () => {
  it("commits an insert write fenced at the store revision", async () => {
    const fake = fakeStore();
    const committed = await create(contextFor(fake), "Todo", {
      id: "t1",
      data: { title: "write tests" },
    });
    expect(fake.revisions).toBe(1);
    expect(fake.batches.length).toBe(1);
    const batch = fake.batches[0]!;
    expect(batch.expectedRevision).toBe(7 as Revision);
    expect(batch.receipt).toBe(null);
    expect(batch.history).toEqual([]);
    expect(batch.writes.length).toBe(1);
    const write = batch.writes[0]!;
    expect(write).toEqual({
      kind: "insert",
      model: "Todo",
      row: {
        id: "t1",
        version: 1,
        created: NOW,
        updated: NOW,
        createdBy: "u1",
        updatedBy: "u1",
        archivedAt: null,
        data: { title: "write tests" },
      },
    });
    expect(committed).toEqual((write as { row: StoredRow }).row);
  });

  it("passes a parent link through to the inserted row", async () => {
    const fake = fakeStore();
    await create(contextFor(fake), "Todo", {
      id: "t2",
      data: {},
      parent: { model: "Todo" as ModelName, id: "t1" as RecordId },
    });
    const write = fake.batches[0]!.writes[0]!;
    expect(write).toMatchObject({
      kind: "insert",
      row: { parent: { model: "Todo", id: "t1" } },
    });
  });
});

describe("set", () => {
  it("loads, merges the patch, and commits an update at the stored version", async () => {
    const fake = fakeStore([row("t1", 3, { title: "old", done: false })]);
    const updated = await set(contextFor(fake), "Todo", "t1", { done: true });
    expect(fake.loads).toEqual([{ model: "Todo", id: "t1" }]);
    const batch = fake.batches[0]!;
    expect(batch.expectedRevision).toBe(7 as Revision);
    expect(batch.writes.length).toBe(1);
    expect(batch.writes[0]).toEqual({
      kind: "update",
      model: "Todo",
      id: "t1",
      expectedVersion: 3,
      row: {
        id: "t1",
        version: 4,
        created: NOW - 1000,
        updated: NOW,
        createdBy: "seed",
        updatedBy: "u1",
        archivedAt: null,
        data: { title: "old", done: true },
      },
    });
    expect(updated.version).toBe(4 as StoredRow["version"]);
  });

  it("throws when the record does not exist", async () => {
    const fake = fakeStore();
    await expect(set(contextFor(fake), "Todo", "missing", {})).rejects.toThrow(
      /record not found/,
    );
    expect(fake.batches).toEqual([]);
  });
});

describe("deleteRecord", () => {
  it("commits a version-fenced remove write", async () => {
    const fake = fakeStore([row("t1", 2, {})]);
    await deleteRecord(contextFor(fake), "Todo", "t1");
    expect(fake.loads).toEqual([{ model: "Todo", id: "t1" }]);
    expect(fake.batches[0]).toEqual({
      expectedRevision: 7,
      writes: [{ kind: "remove", model: "Todo", id: "t1", expectedVersion: 2 }],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
  });

  it("throws when the record does not exist", async () => {
    const fake = fakeStore();
    await expect(deleteRecord(contextFor(fake), "Todo", "missing")).rejects.toThrow(
      /record not found/,
    );
    expect(fake.batches).toEqual([]);
  });
});

describe("records", () => {
  it("passes the query spec through to the store", async () => {
    const fake = fakeStore([row("t1", 1, { title: "a" }), row("t2", 1, { title: "b" })]);
    const out = await records(contextFor(fake), "Todo", {
      where: { op: "eq", field: "done", value: false },
      order: [{ field: "created", direction: "asc" }],
      limit: 10,
      archived: "exclude",
    });
    expect(out.length).toBe(2);
    expect(fake.specs.length).toBe(1);
    expect(fake.specs[0]).toEqual({
      model: "Todo",
      authority: "owner",
      where: { op: "eq", field: "done", value: false },
      order: [{ field: "created", direction: "asc" }],
      limit: 10,
      archived: "exclude",
    });
  });

  it("defaults to a bare owner-authority spec", async () => {
    const fake = fakeStore();
    await records(contextFor(fake), "Todo");
    expect(fake.specs[0]).toEqual({ model: "Todo", authority: "owner" });
  });
});

describe("stubs", () => {
  const c = contextFor(fakeStore());
  const cases: Array<[string, (ctx: HandlerContext) => unknown]> = [
    ["send", (ctx) => send(ctx)],
    ["emit", (ctx) => emit(ctx)],
    ["schedule", (ctx) => schedule(ctx)],
    ["cancel", (ctx) => cancel(ctx)],
    ["check", (ctx) => check(ctx)],
    ["delivery", (ctx) => delivery(ctx)],
    ["secretEqual", (ctx) => secretEqual(ctx)],
  ];
  for (const [name, call] of cases) {
    it(`${name} throws unsupported(${name})`, () => {
      expect(() => call(c)).toThrow(new RegExp(`unsupported\\(${name}\\)`));
    });
  }
});

describe("guards", () => {
  it("require passes truthy, throws the emitted code otherwise", () => {
    expect(() => guardRequire(true, "forbidden")).not.toThrow();
    expect(() => guardRequire(false, "forbidden")).toThrow("forbidden");
    expect(() => guardRequire(0)).toThrow("forbidden");
  });

  it("hasRole tests the context memberships (anonymous denies)", () => {
    const member = createContext({
      caller: { userId: "u1", roles: ["member"] },
      store: fakeStore().port,
      memberships: ["members"],
    });
    expect(hasRole(member, "members")).toBe(true);
    expect(hasRole(member, "admins")).toBe(false);
    expect(hasRole(contextFor(fakeStore()), "members")).toBe(false);
  });

  it("hasRole with a subject throws instead of widening the guard", () => {
    const member = createContext({
      caller: { userId: "u1", roles: ["member"] },
      store: fakeStore().port,
      memberships: ["members"],
    });
    expect(() => hasRole(member, "members", { userId: "u2" })).toThrow(
      /unsupported\(hasRole-subject\)/,
    );
  });
});

describe("count", () => {
  it("mirrors values count (bigint length, loud on non-array)", () => {
    expect(count([1, 2, 3])).toBe(3n);
    expect(count([])).toBe(0n);
    expect(() => count("nope" as unknown as ReadonlyArray<unknown>)).toThrow(
      "count: domain must be an array",
    );
  });
});
