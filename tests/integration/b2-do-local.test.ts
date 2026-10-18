/** Real B2 DO SQLite fence, atomicity and history, with the same D1 fence vector. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import type { CommitBatch, HistoryEntry, ModelName, RecordId, StoredRow } from "@canlang/contracts";
import { createD1Storage, ensureSchema } from "@canlang/state/storage/d1";
import { b2BlankBatch, b2HistoryEntry, b2Revision, b2StoredRow } from "@canlang/testkit/fixtures/b2-storage";
import { startLocalDev } from "../fixtures/raw-worker.js";

const model = "B2.Document" as ModelName, at = 1_758_000_000_000;
function insert(revision: number, id: string): CommitBatch {
  return { ...b2BlankBatch(b2Revision(revision)),
    writes: [{ kind: "insert", model, row: b2StoredRow({ id, version: 1, actor: "b2-do-owner", at, data: { total: "10.00" } }) }],
    history: [b2HistoryEntry({ model, recordId: id, version: 1, operation: "B2.Document.create", operationId: `op-${id}`,
      actor: "b2-do-owner", at, change: "create", before: null, after: { total: "10.00" } })] };
}

it("runs real DO fence/rollback/history through direct raw Worker allocation and agrees with D1", async () => {
  const require = createRequire(import.meta.url);
  // State publishes the self-contained actual adapter test worker; no mock storage or copied SQL.
  const worker = await readFile(require.resolve("@canlang/state/testing/storage/do-test-worker"), "utf8");
  const dev = await startLocalDev({ workerName: "b2-do-native", compatibilityDate: "2026-07-15",
    mainModule: "state-do.js", modules: { "state-do.js": worker },
    durableObjects: [{ binding: "TEST_DO", className: "TestDO", useSQLite: true }],
    d1Databases: [{ binding: "DB", id: "b2-d1-parity" }] });
  try {
    const namespace = await dev.getDurableObjectNamespace("TEST_DO");
    expect(namespace.get(namespace.idFromName("test"))).toBeDefined();
    async function post(path: string, input: unknown): Promise<any> {
      const response = await dev.dispatch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      expect(response.status).toBe(200); return response.json();
    }
    async function call<T>(method: string, ...args: unknown[]): Promise<T> {
      const reply = await post("/call", { method, args });
      if (!reply.ok) throw Object.assign(new Error(reply.error.message), reply.error);
      return reply.value as T;
    }
    expect((await post("/reset", {})).ok).toBe(true);
    const first = insert(0, "first");
    expect(await call("commit", first)).toMatchObject({ revision: 1 });
    const fence = await post("/call", { method: "commit", args: [insert(0, "stale")] });
    expect(fence).toMatchObject({ ok: false, error: { name: "FenceConflictError", expected: 0, actual: 1 } });
    expect(await call("readRevision")).toBe(1);
    expect(await call("load", model, "stale")).toBeNull();
    const history = await call<HistoryEntry[]>("historyFor", model, "first");
    expect(history).toEqual(first.history);
    (history[0]!.after as Record<string, unknown>).total = "MUTATED";
    expect(await call("historyFor", model, "first")).toEqual(first.history);

    // A violation after a staged insert must roll back row, history and fence together.
    const rollbackBase = insert(1, "duplicate");
    const rollback = { ...rollbackBase, writes: [...rollbackBase.writes, ...rollbackBase.writes] };
    const failed = await post("/call", { method: "commit", args: [rollback] });
    expect(failed).toMatchObject({ ok: false, error: { name: "StorageConstraintError" } });
    expect(await call("readRevision")).toBe(1);
    expect(await call<StoredRow | null>("load", model, "duplicate")).toBeNull();
    expect(await call("historyFor", model, "duplicate")).toEqual([]);
    expect(await call("historyFor", model, "first")).toEqual(first.history);

    const db = await dev.getD1Database("DB");
    await ensureSchema(db);
    const d1 = createD1Storage(db);
    expect(await d1.commit(first)).toMatchObject({ revision: 1 });
    await expect(d1.commit(insert(0, "stale"))).rejects.toMatchObject({ name: "FenceConflictError", expected: 0, actual: 1 });
    expect(await d1.readRevision()).toBe(await call("readRevision"));
    expect(await d1.load(model, "stale" as RecordId)).toBeNull();
    expect(await d1.historyFor(model, "first" as RecordId)).toEqual(await call("historyFor", model, "first"));
  } finally { await dev.dispose(); }
}, 60_000);
