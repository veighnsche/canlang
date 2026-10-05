import { describe, expect, it } from "vitest";
import type {
  ArtifactCallable,
  CommitBatch,
  CommitResult,
  CompileArtifact,
  ModelName,
  OutboxIntent,
  QuerySpec,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import { createContext, type HandlerContext } from "../src/runtime/context.js";
import {
  invokeCallableInOccurrence,
  type AssembledModules,
} from "../src/runtime/invoke.js";
import {
  buildDispatchWrites,
  commitWithDispatchRows,
  executeDirect,
  executeOccurrence,
  withDispatchProducer,
  withOriginOccurrence,
  WORK_DISPATCH_MODEL,
} from "../src/runtime/executors.js";

const NOW = 1700000000000;

function artifactWith(callables: ArtifactCallable[]): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: "0".repeat(64) }],
    modules: [
      {
        path: "main.js",
        js: "",
        map: {
          version: 3,
          file: "main.js",
          sources: [],
          sourcesContent: [],
          names: [],
          mappings: "",
        },
      },
    ],
    callables,
    pages: [],
    requires: [],
    tests: [],
  };
}

function callable(id: string, member: string[] = ["run"]): ArtifactCallable {
  return { id, kind: "operation", module: "main.js", export: "entry", member };
}

function asmWith(moduleUrls: Record<string, string>): AssembledModules {
  return { dir: "/tmp/executors-test", entryUrl: "data:text/javascript,", moduleUrls };
}

function js(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

interface Fake {
  port: StoragePort;
  batches: CommitBatch[];
  revisions: number;
  loads: Array<{ model: string; id: string }>;
  specs: QuerySpec[];
}

function fakeStore(): Fake {
  const fake: Fake = {
    port: null as unknown as StoragePort,
    batches: [],
    revisions: 0,
    loads: [],
    specs: [],
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
      return null;
    },
    query: async (spec: QuerySpec): Promise<ReadonlyArray<StoredRow>> => {
      fake.specs.push(spec);
      return [];
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

function baseCtx(fake: Fake): HandlerContext {
  return createContext({
    caller: { userId: "u1", roles: ["member"] },
    store: fake.port,
    clock: () => NOW,
    memberships: ["member"],
    preferences: { ExpenseFlow: { theme: "dark" } },
  });
}

function intent(overrides: Partial<OutboxIntent> = {}): OutboxIntent {
  return {
    intentId: "obx_1",
    operation: "mail.send" as OutboxIntent["operation"],
    operationId: "op-1" as OutboxIntent["operationId"],
    target: "mail.send",
    arguments: { to: "a@b.c" },
    occurrenceIndex: 0,
    ...overrides,
  };
}

function batch(overrides: Partial<CommitBatch> = {}): CommitBatch {
  return {
    expectedRevision: 7 as Revision,
    writes: [],
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
    ...overrides,
  };
}

/** Handler source: commits one domain write + one outbox intent, echoes the stamp. */
const COMMITTING_HANDLER = `export function canApp(){ return { run: async (ctx) => {
  await ctx.store.commit({
    expectedRevision: 7,
    writes: [{ kind: "insert", model: "Todo", row: {
      id: "t1", version: 1, created: 1, updated: 1,
      createdBy: "u1", updatedBy: "u1", archivedAt: null, data: { title: "x" } } }],
    history: [],
    receipt: null,
    outbox: [{ intentId: "obx_1", operation: "mail.send", operationId: "op-1",
      target: "mail.send", arguments: { to: "a@b.c" }, occurrenceIndex: 0 }],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: []
  });
  return { origin: ctx.originOccurrence };
} }; }`;

describe("executeOccurrence (occurrence executor)", () => {
  it("runs the handler with the stamped occurrence visible on ctx", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const asm = asmWith({
      "main.js": js(
        "export function canApp(){ return { run: async (ctx, ...args) => " +
          "({ origin: ctx.originOccurrence, caller: ctx.caller.userId, args }) }; }",
      ),
    });
    const fake = fakeStore();
    const result = await executeOccurrence(
      asm,
      artifact,
      { occurrenceId: "occ-1", callableId: "app.Expense.submit", args: [1, "two"] },
      baseCtx(fake),
    );
    expect(result).toEqual({
      ok: true,
      value: { origin: "occ-1", caller: "u1", args: [1, "two"] },
    });
  });

  it("threads originOccurrence into sibling dispatch rows in the same fenced commit", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const asm = asmWith({ "main.js": js(COMMITTING_HANDLER) });
    const fake = fakeStore();
    const result = await executeOccurrence(
      asm,
      artifact,
      { occurrenceId: "occ-1", callableId: "app.Expense.submit" },
      baseCtx(fake),
    );
    expect(result).toEqual({ ok: true, value: { origin: "occ-1" } });
    expect(fake.batches.length).toBe(1);
    const committed = fake.batches[0]!;
    expect(committed.writes.length).toBe(2);
    expect(committed.writes[0]).toMatchObject({ kind: "insert", model: "Todo" });
    expect(committed.writes[1]).toEqual({
      kind: "insert",
      model: "work.dispatch",
      row: {
        id: "obx_1",
        version: 1,
        created: NOW,
        updated: NOW,
        createdBy: "u1",
        updatedBy: "u1",
        archivedAt: null,
        data: {
          intentId: "obx_1",
          operationId: "op-1",
          source: "mail.send",
          occurrenceIndex: 0,
          originOccurrence: "occ-1",
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
      },
    });
    // The outbox intent itself still rides the batch for the L3 fence.
    expect(committed.outbox.length).toBe(1);
  });

  it("rejects an empty occurrenceId without invoking the handler", async () => {
    // No module URL assembled: any invocation attempt would fail with a
    // module error instead, so the occurrenceId error proves no invocation.
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const fake = fakeStore();
    const result = await executeOccurrence(
      asmWith({}),
      artifact,
      { occurrenceId: "", callableId: "app.Expense.submit" },
      baseCtx(fake),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("occurrenceId must be a non-empty string");
    expect(result.error ?? "").toContain("not invoked");
    expect(fake.batches.length).toBe(0);
  });

  it("rejects a non-string occurrenceId without invoking the handler", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const fake = fakeStore();
    const result = await executeOccurrence(
      asmWith({}),
      artifact,
      {
        occurrenceId: 42 as unknown as string,
        callableId: "app.Expense.submit",
      },
      baseCtx(fake),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("occurrenceId must be a non-empty string");
    expect(fake.batches.length).toBe(0);
  });

  it("rejects an empty callableId without invoking the handler", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const fake = fakeStore();
    const result = await executeOccurrence(
      asmWith({}),
      artifact,
      { occurrenceId: "occ-1", callableId: "" },
      baseCtx(fake),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("callableId must be a non-empty string");
    expect(fake.batches.length).toBe(0);
  });

  it("propagates handler throws as { ok: false }", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const asm = asmWith({
      "main.js": js(
        'export function canApp(){ return { run: () => { throw new Error("boom"); } }; }',
      ),
    });
    const result = await executeOccurrence(
      asm,
      artifact,
      { occurrenceId: "occ-1", callableId: "app.Expense.submit" },
      baseCtx(fakeStore()),
    );
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("propagates unknown-callable resolution errors", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const result = await executeOccurrence(
      asmWith({}),
      artifact,
      { occurrenceId: "occ-1", callableId: "nope.Missing" },
      baseCtx(fakeStore()),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("unknown callable");
    expect(result.error ?? "").toContain("nope.Missing");
  });
});

describe("invokeCallableInOccurrence (occurrence-aware entry)", () => {
  it("rejects an invalid stamp without invoking", async () => {
    const artifact = artifactWith([callable("a.b")]);
    const fake = fakeStore();
    const result = await invokeCallableInOccurrence(asmWith({}), artifact, "a.b", {
      ...baseCtx(fake),
      originOccurrence: "",
    });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("a.b");
    expect(result.error ?? "").toContain("originOccurrence");
    expect(fake.batches.length).toBe(0);
  });

  it("accepts a null stamp (direct) and passes ctx through untouched", async () => {
    const artifact = artifactWith([callable("a.b")]);
    const asm = asmWith({
      "main.js": js(
        "export function canApp(){ return { run: (ctx, ...args) => ({ ctx, args }) }; }",
      ),
    });
    const ctx = { ...baseCtx(fakeStore()), originOccurrence: null };
    const result = await invokeCallableInOccurrence(asm, artifact, "a.b", ctx, [1]);
    expect(result.ok).toBe(true);
    const value = result.value as { ctx: unknown; args: unknown[] };
    expect(value.ctx).toBe(ctx);
    expect(value.args).toEqual([1]);
  });
});

describe("executeDirect (null direct stamp)", () => {
  it("stamps null on produced dispatch rows", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const asm = asmWith({ "main.js": js(COMMITTING_HANDLER) });
    const fake = fakeStore();
    const result = await executeDirect(
      asm,
      artifact,
      { callableId: "app.Expense.submit" },
      baseCtx(fake),
    );
    expect(result).toEqual({ ok: true, value: { origin: null } });
    expect(fake.batches.length).toBe(1);
    const dispatch = fake.batches[0]!.writes[1] as { row: StoredRow };
    expect((dispatch.row.data as Record<string, unknown>)["originOccurrence"]).toBe(null);
  });

  it("rejects an empty callableId without invoking", async () => {
    const artifact = artifactWith([callable("app.Expense.submit")]);
    const fake = fakeStore();
    const result = await executeDirect(asmWith({}), artifact, { callableId: "" }, baseCtx(fake));
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("callableId must be a non-empty string");
    expect(fake.batches.length).toBe(0);
  });
});

describe("commitWithDispatchRows / withDispatchProducer (dispatch executor)", () => {
  it("delegates batches without outbox intents untouched (same reference)", async () => {
    const fake = fakeStore();
    const store = withDispatchProducer(fake.port, "occ-1", {
      clock: () => NOW,
      actor: "u1",
    });
    const original = batch({
      writes: [{ kind: "remove", model: "Todo" as ModelName, id: "t1" as RecordId, expectedVersion: 1 as StoredRow["version"] }],
    });
    const result = await store.commit(original);
    expect(result).toEqual({ revision: 8 as Revision });
    expect(fake.batches.length).toBe(1);
    expect(fake.batches[0]).toBe(original);
  });

  it("appends one sibling row per intent after the domain writes, preserving the batch tail", async () => {
    const fake = fakeStore();
    const history = [{ model: "Todo", recordId: "t1", version: 2, at: NOW, by: "u1", change: "set" }];
    const original = batch({
      writes: [{ kind: "remove", model: "Todo" as ModelName, id: "t1" as RecordId, expectedVersion: 1 as StoredRow["version"] }],
      history: history as unknown as CommitBatch["history"],
      receipt: { id: "r1" } as unknown as CommitBatch["receipt"],
      outbox: [intent(), intent({ intentId: "obx_2", occurrenceIndex: 1 })],
      schedules: [{ op: "cancel", key: "k" }],
      uniqueClaims: [
        {
          model: "Todo" as ModelName,
          keyName: "slug",
          keyValue: "a",
          recordId: "t1" as RecordId,
        },
      ],
      outboxAck: ["obx_0"],
    });
    await commitWithDispatchRows(fake.port, original, "occ-9", {
      clock: () => NOW,
      actor: "u1",
    });
    expect(fake.batches.length).toBe(1);
    const committed = fake.batches[0]!;
    expect(committed.writes.length).toBe(3);
    expect(committed.writes[0]).toBe(original.writes[0]);
    const first = committed.writes[1] as { row: StoredRow };
    const second = committed.writes[2] as { row: StoredRow };
    expect(first.row.id).toBe("obx_1");
    expect(second.row.id).toBe("obx_2");
    expect((second.row.data as Record<string, unknown>)["occurrenceIndex"]).toBe(1);
    // Batch tail passes through untouched.
    expect(committed.expectedRevision).toBe(original.expectedRevision);
    expect(committed.history).toBe(original.history);
    expect(committed.receipt).toBe(original.receipt);
    expect(committed.outbox).toBe(original.outbox);
    expect(committed.schedules).toBe(original.schedules);
    expect(committed.uniqueClaims).toBe(original.uniqueClaims);
    expect(committed.uniqueReleases).toBe(original.uniqueReleases);
    expect(committed.outboxAck).toBe(original.outboxAck);
  });

  it("produces the kernel dispatch-row shape on the lane-04 model", () => {
    const writes = buildDispatchWrites([intent()], "occ-1", { nowMs: NOW, actor: "u1" });
    expect(writes.length).toBe(1);
    expect(writes[0]).toEqual({
      kind: "insert",
      model: WORK_DISPATCH_MODEL,
      row: expect.objectContaining({
        id: "obx_1",
        version: 1,
        created: NOW,
        updated: NOW,
        createdBy: "u1",
        updatedBy: "u1",
        archivedAt: null,
      }),
    });
    expect(WORK_DISPATCH_MODEL as string).toBe("work.dispatch");
  });

  it("fails closed on malformed intents with no partial commit", async () => {
    const fake = fakeStore();
    const store = withDispatchProducer(fake.port, "occ-1", {
      clock: () => NOW,
      actor: "u1",
    });
    await expect(
      store.commit(batch({ outbox: [intent({ intentId: "" })] })),
    ).rejects.toThrow("outbox[0]");
    await expect(
      store.commit(batch({ outbox: [intent({ occurrenceIndex: -1 })] })),
    ).rejects.toThrow("occurrenceIndex");
    await expect(
      store.commit(batch({ outbox: [intent({ target: "" })] })),
    ).rejects.toThrow("target");
    expect(fake.batches.length).toBe(0);
  });

  it("fails closed on an invalid stamp", async () => {
    const fake = fakeStore();
    await expect(
      commitWithDispatchRows(fake.port, batch({ outbox: [intent()] }), "", {
        clock: () => NOW,
        actor: "u1",
      }),
    ).rejects.toThrow("originOccurrence");
    expect(fake.batches.length).toBe(0);
  });

  it("delegates non-commit port methods to the inner store", async () => {
    const fake = fakeStore();
    const store = withDispatchProducer(fake.port, "occ-1", {
      clock: () => NOW,
      actor: "u1",
    });
    await expect(store.readRevision()).resolves.toBe(7 as Revision);
    await expect(store.load("Todo" as ModelName, "t1" as RecordId)).resolves.toBe(null);
    const spec: QuerySpec = { model: "Todo" as ModelName, authority: "owner" };
    await expect(store.query(spec)).resolves.toEqual([]);
    expect(fake.revisions).toBe(1);
    expect(fake.loads).toEqual([{ model: "Todo", id: "t1" }]);
    expect(fake.specs).toEqual([spec]);
    expect(fake.batches.length).toBe(0);
  });
});

describe("withOriginOccurrence (ctx threading)", () => {
  it("preserves the base context and installs the producing store", async () => {
    const fake = fakeStore();
    const base = baseCtx(fake);
    const ctx = withOriginOccurrence(base, "occ-1");
    expect(ctx.caller).toBe(base.caller);
    expect(ctx.clock).toBe(base.clock);
    expect(ctx.memberships).toBe(base.memberships);
    expect(ctx.preferences).toBe(base.preferences);
    expect(ctx.originOccurrence).toBe("occ-1");
    expect(ctx.store).not.toBe(base.store);
    await ctx.store.commit(batch({ outbox: [intent()] }));
    expect(fake.batches.length).toBe(1);
    const dispatch = fake.batches[0]!.writes[0] as { row: StoredRow };
    expect(dispatch.row.data).toMatchObject({ intentId: "obx_1", originOccurrence: "occ-1" });
    expect(dispatch.row.createdBy).toBe("u1");
  });
});
