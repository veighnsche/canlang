import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLocalRowScope } from "../src/dev/row-scope.js";

describe("isolated example row snapshots", () => {
  it("ignores admission bookkeeping but catches domain writes", async () => {
    const scope = await createLocalRowScope(randomUUID(), {
      workerName: `example-snapshot-${randomUUID()}`,
      compatibilityDate: "2026-07-15",
      mainModule: "worker.mjs",
      modules: { "worker.mjs": "export default { fetch() { return new Response(null, {status: 404}); } };" },
      d1Binding: "DB",
    });
    try {
      const db = await scope.dev.getD1Database("DB");
      await db.exec("CREATE TABLE fence (value INTEGER); CREATE TABLE fence_log (value INTEGER); CREATE TABLE receipts (value INTEGER); CREATE TABLE records (value INTEGER);");
      const before = await scope.snapshot();
      await db.exec("INSERT INTO fence VALUES (1); INSERT INTO fence_log VALUES (2); INSERT INTO receipts VALUES (3);");
      expect(await scope.snapshot()).toEqual(before);
      await db.exec("INSERT INTO records VALUES (4)");
      expect(await scope.snapshot()).not.toEqual(before);
    } finally {
      await scope.dispose();
    }
  }, 120000);
});
