import { afterEach, describe, expect, it } from "vitest";
import { startLocalDev, type LocalDev } from "../src/dev/local-run.js";
import { buildProductionDeps } from "../src/runtime/env-assembly.js";

const devs: LocalDev[] = [];
afterEach(async () => {
  await Promise.all(devs.splice(0).map(dev => dev.dispose()));
});

async function bindings() {
  const dev = await startLocalDev({
    workerName: `owners-${crypto.randomUUID()}`,
    compatibilityDate: "2026-07-15",
    mainModule: "main.mjs",
    modules: { "main.mjs": "export default { fetch() { return new Response(null, { status: 404 }); } };" },
    d1Databases: [
      { binding: "DB", id: crypto.randomUUID() },
      { binding: "CEDAR_DB", id: crypto.randomUUID() },
      { binding: "OAK_DB", id: crypto.randomUUID() },
    ],
  });
  devs.push(dev);
  return { DB: await dev.getD1Database("DB"), CEDAR_DB: await dev.getD1Database("CEDAR_DB"),
    OAK_DB: await dev.getD1Database("OAK_DB") };
}

const configured = { version: 1, owners: [
  { owner: "cedar-team", binding: "CEDAR_DB", initializeFresh: true },
  { owner: "oak-team", binding: "OAK_DB", initializeFresh: true },
] };

describe("trusted multi-owner environment", () => {
  it("keeps Identity global, returns two actual owner D1 handles and disables global State", async () => {
    const env = await bindings();
    const deps = await buildProductionDeps({ ...env, CAN_STATE_OWNERS: configured });
    expect(deps.stateTeam).toBeUndefined();
    expect(deps.stateTeams).toEqual([
      { owner: "cedar-team", db: env.CEDAR_DB, initializeFresh: true },
      { owner: "oak-team", db: env.OAK_DB, initializeFresh: true },
    ]);
    await expect(deps.store.readRevision()).rejects.toThrow("owner boundary");
    const globalTables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>();
    expect(globalTables.results.some(row => row.name === "records")).toBe(false);
    expect(globalTables.results.some(row => row.name === "identity_teams")).toBe(true);
    expect(await env.CEDAR_DB.prepare("SELECT name FROM sqlite_master WHERE name = 'records'").first()).toBeNull();
    expect(await env.OAK_DB.prepare("SELECT name FROM sqlite_master WHERE name = 'records'").first()).toBeNull();
  });

  it("refuses malformed, mixed and aliased routes before any D1 read or DDL", async () => {
    const db = { prepare: () => { throw new Error("D1 touched"); }, exec: async () => { throw new Error("D1 touched"); },
      batch: async () => { throw new Error("D1 touched"); } };
    const base = { DB: db, CEDAR_DB: { ...db }, OAK_DB: { ...db } };
    const invalid = [
      { CAN_STATE_OWNERS: { version: 2, owners: configured.owners } },
      { CAN_STATE_OWNERS: { version: 1, owners: [] } },
      { CAN_STATE_OWNERS: { ...configured, extra: true } },
      { CAN_STATE_OWNERS: { version: 1, owners: [{ ...configured.owners[0], extra: true }] } },
      { CAN_STATE_OWNERS: { version: 1, owners: [{ owner: "cedar-team", binding: "DB" }] } },
      { CAN_STATE_OWNERS: { version: 1, owners: [{ owner: "cedar-team", binding: "missing" }] } },
      { CAN_STATE_OWNERS: { version: 1, owners: [{ owner: "cedar-team", binding: "CEDAR_DB", initializeFresh: false }] } },
      { CAN_STATE_OWNERS: { version: 1, owners: Array(17).fill({ owner: "x", binding: "CEDAR_DB" }) } },
      { CAN_STATE_OWNERS: { version: 1, owners: [configured.owners[0], { owner: "cedar-team", binding: "OAK_DB" }] } },
      { CAN_STATE_OWNERS: { version: 1, owners: [configured.owners[0], { owner: "oak-team", binding: "CEDAR_DB" }] } },
      { CAN_STATE_OWNERS: configured, CAN_STATE_OWNER: "cedar-team" },
      { CAN_STATE_OWNERS: configured, STATE_DB: base.CEDAR_DB },
      { CAN_STATE_OWNERS: configured, CAN_STATE_INITIALIZE_FRESH: true },
    ];
    for (const entry of invalid) {
      await expect(buildProductionDeps({ ...base, ...entry })).rejects.toThrow("owner-storage:");
    }
    await expect(buildProductionDeps({ ...base, OAK_DB: base.CEDAR_DB, CAN_STATE_OWNERS: configured }))
      .rejects.toThrow("distinct owners, bindings and actual D1 databases");
    await expect(buildProductionDeps({ ...base, CEDAR_DB: db, CAN_STATE_OWNERS: configured }))
      .rejects.toThrow("distinct owners, bindings and actual D1 databases");
  });
});
