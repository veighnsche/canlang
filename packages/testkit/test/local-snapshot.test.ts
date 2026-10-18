import { randomUUID } from "node:crypto";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { snapshotLocalDatabases } from "../src/scopes/local.js";

describe("isolated example row snapshots", () => {
  it("rejects aliases and detects writes in every configured physical database", async () => {
    const primaryId = randomUUID();
    const dev = new Miniflare({
      name: `example-multi-snapshot-${randomUUID()}`,
      compatibilityDate: "2026-07-15",
      modules: true,
      script: "export default { fetch() { return new Response(null, {status: 404}); } };",
      d1Databases: { IDENTITY_DB: primaryId, STATE_CURRENT: randomUUID(), STATE_OTHER: randomUUID() },
    });
    const scope = { dev, snapshot: () => snapshotLocalDatabases(dev, ["IDENTITY_DB", "STATE_CURRENT", "STATE_OTHER"]), dispose: () => dev.dispose() };
    try {
      await expect(snapshotLocalDatabases(dev, ["IDENTITY_DB", "IDENTITY_DB"])).rejects.toThrow("distinct and nonempty");
      await expect(snapshotLocalDatabases(dev, [""])).rejects.toThrow("distinct and nonempty");
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
    const dev = new Miniflare({
      name: `example-snapshot-${randomUUID()}`,
      compatibilityDate: "2026-07-15",
      modules: true,
      script: "export default { fetch() { return new Response(null, {status: 404}); } };",
      d1Databases: { DB: randomUUID() },
    });
    const scope = { dev, snapshot: () => snapshotLocalDatabases(dev, ["DB"]), dispose: () => dev.dispose() };
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
