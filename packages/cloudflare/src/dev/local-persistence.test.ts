import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLocalDev } from "./local-run.js";

test("private provisioning persists Identity while distinct serving owner databases stay isolated", async () => {
  const persistence = await mkdtemp(join(tmpdir(), "can-owner-handoff-"));
  const identityId = randomUUID();
  const base = { compatibilityDate: "2026-07-30", mainModule: "main.js",
    modules: { "main.js": "export default { fetch() { return new Response(null,{status:404}); } };" },
    d1Persist: persistence };
  const provisioner = await startLocalDev({ ...base, workerName: `provision-${randomUUID()}`,
    d1Databases: [{ binding: "DB", id: identityId }] });
  try {
    const db = await provisioner.getD1Database("DB");
    await db.exec("CREATE TABLE identity_marker (id TEXT PRIMARY KEY); INSERT INTO identity_marker VALUES ('seeded');");
  } finally { await provisioner.dispose(); }
  let serving;
  try {
    serving = await startLocalDev({ ...base, workerName: `serving-${randomUUID()}`,
      d1Databases: [{ binding: "DB", id: identityId }, { binding: "CEDAR", id: randomUUID() },
        { binding: "OAK", id: randomUUID() }] });
    assert.deepEqual(await (await serving.getD1Database("DB")).prepare("SELECT id FROM identity_marker").first(), { id: "seeded" });
    const cedar = await serving.getD1Database("CEDAR");
    const oak = await serving.getD1Database("OAK");
    await cedar.exec("CREATE TABLE supplies (name TEXT); INSERT INTO supplies VALUES ('Paper');");
    await oak.exec("CREATE TABLE supplies (name TEXT);");
    assert.equal((await oak.prepare("SELECT COUNT(*) AS count FROM supplies").first<{ count: number }>())?.count, 0);
    assert.equal((await cedar.prepare("SELECT COUNT(*) AS count FROM supplies").first<{ count: number }>())?.count, 1);
  } finally {
    try { await serving?.dispose(); } finally { await rm(persistence, { recursive: true, force: true }); }
  }
});
