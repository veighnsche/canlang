import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalRowScope } from "../src/dev/row-scope.js";

describe("isolated example row snapshots", () => {
  it("rejects aliases and detects writes in every configured physical database", async () => {
    const primaryId = randomUUID();
    const options = {
      workerName: `example-multi-snapshot-${randomUUID()}`,
      compatibilityDate: "2026-07-15",
      mainModule: "worker.mjs",
      modules: { "worker.mjs": "export default { fetch() { return new Response(null, {status: 404}); } };" },
      d1Binding: "IDENTITY_DB",
    };
    await expect(createLocalRowScope(primaryId, { ...options,
      additionalD1Databases: [{ binding: "STATE_DB", id: primaryId }],
    })).rejects.toThrow("distinct and nonempty");
    await expect(createLocalRowScope(primaryId, { ...options,
      additionalD1Databases: [{ binding: "IDENTITY_DB", id: randomUUID() }],
    })).rejects.toThrow("distinct and nonempty");
    const scope = await createLocalRowScope(primaryId, { ...options,
      additionalD1Databases: [
        { binding: "STATE_CURRENT", id: randomUUID() },
        { binding: "STATE_OTHER", id: randomUUID() },
      ],
    });
    try {
      const identity = await scope.dev.getD1Database("IDENTITY_DB");
      const current = await scope.dev.getD1Database("STATE_CURRENT");
      const other = await scope.dev.getD1Database("STATE_OTHER");
      await Promise.all([identity.exec("CREATE TABLE fact (value INTEGER)"),
        current.exec("CREATE TABLE fact (value INTEGER)"), other.exec("CREATE TABLE fact (value INTEGER)")]);
      const before = await scope.snapshot();
      expect(Object.keys(before as object)).toEqual(["IDENTITY_DB", "STATE_CURRENT", "STATE_OTHER"]);
      for (const database of [identity, current, other]) {
        await database.exec("INSERT INTO fact VALUES (1)");
        expect(await scope.snapshot()).not.toEqual(before);
        await database.exec("DELETE FROM fact");
        expect(await scope.snapshot()).toEqual(before);
      }
      await current.exec("INSERT INTO fact VALUES (2)");
      const selected = await other.prepare("SELECT * FROM fact").all();
      expect(selected.results).toEqual([]);
    } finally {
      await scope.dispose();
    }
  }, 120000);

  it("ignores rejection bookkeeping but catches domain writes and committed receipts", async () => {
    const scope = await createLocalRowScope(randomUUID(), {
      workerName: `example-snapshot-${randomUUID()}`,
      compatibilityDate: "2026-07-15",
      mainModule: "worker.mjs",
      modules: { "worker.mjs": "export default { fetch() { return new Response(null, {status: 404}); } };" },
      d1Binding: "DB",
    });
    try {
      const db = await scope.dev.getD1Database("DB");
      await db.exec("CREATE TABLE fence (value INTEGER); CREATE TABLE fence_log (value INTEGER); CREATE TABLE receipts (outcome TEXT); CREATE TABLE records (value INTEGER);");
      const insertReceipt = async (outcome: unknown) => {
        await db.prepare("INSERT INTO receipts(outcome) VALUES (?)").bind(JSON.stringify(outcome)).run();
      };
      const before = await scope.snapshot();
      await db.exec("INSERT INTO fence VALUES (1); INSERT INTO fence_log VALUES (2);");
      await insertReceipt({ status: "rejected", code: "forbidden", message: "denied" });
      expect(await scope.snapshot()).toEqual(before);
      await insertReceipt({ status: "committed", result: null });
      expect(await scope.snapshot()).not.toEqual(before);
      await db.exec("DELETE FROM receipts WHERE outcome LIKE '%committed%'");
      await insertReceipt({ status: "rejected", code: "forbidden", message: "denied", effect: "hidden effect" });
      await expect(scope.snapshot()).rejects.toThrow("rejection receipt is not canonical");
      await db.exec("DELETE FROM receipts WHERE outcome LIKE '%hidden effect%'");
      await insertReceipt({ status: "rejected", code: "invented_code", message: "denied" });
      await expect(scope.snapshot()).rejects.toThrow("rejection receipt is not canonical");
      await db.exec("DELETE FROM receipts WHERE outcome LIKE '%invented_code%'");
      expect(await scope.snapshot()).toEqual(before);
      await db.exec("INSERT INTO records VALUES (4)");
      expect(await scope.snapshot()).not.toEqual(before);
    } finally {
      await scope.dispose();
    }
  }, 120000);
});
