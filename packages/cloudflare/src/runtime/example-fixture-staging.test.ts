/** Preview fixture staging: a clean closure materializes its fixture
 * providers into caller-supplied D1s under existing preview identity,
 * with no operation invoked or observed. A second test pins the
 * CanTable clean-emission contract (reserve/seat present); staging the
 * CanTable rows themselves waits on native receipts for nested/helper
 * require shapes (recorded with the remaining work).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Log, LogLevel, Miniflare } from "miniflare";
import type { CompileArtifact } from "@canlang/contracts";
import { distribution as valuesDistribution } from "@canlang/values/distribution";
import { decodeValue } from "@canlang/values";
import { createD1IdentityStore, ensureIdentitySchema } from "@canlang/identity";
import { createD1OwnerRouter } from "@canlang/state/storage/owner-router";
import { ensureSchema as ensureStateSchema } from "@canlang/state/storage/d1";
import type { D1Database } from "@cloudflare/workers-types";
import {
  loadInstalledExampleTestkit,
  stageClosureFixtures,
} from "./example-bindings.js";

const compiler = join(process.cwd(), "compiler/target/debug/can");
const catalog = fileURLToPath(valuesDistribution.catalog);
// Anchor draft sources to this file, not the process working directory.
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

const STAGE_APP = `app StageProbe
Given
 Site {name:text}
 Room in Site {name:text,seats:int}
 role host
 policy Site read=host
 policy Room read=host
 fixture site=Site {name="Main"}
 fixture room=Room {parent=site,name="1",seats=4}
 fixture spare=Room {parent=site,name="2",seats=2}
When
 crud Room by=host fields=name,seats
  examples update seed=[spare] record=room changes={seats=5}
   as -> record.seats
   host -> 5
Then
`;

function compileSource(source: string): CompileArtifact {
  const dir = mkdtempSync(join(tmpdir(), "can-fixture-staging-src-"));
  try {
    const file = join(dir, "app.can");
    writeFileSync(file, source);
    return JSON.parse(
      execFileSync(compiler, ["compile", "--format=json", `--catalog=${catalog}`, file], {
        encoding: "utf8",
      }),
    ) as CompileArtifact;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compileCanTable(): CompileArtifact {
  const files = [
    join(root, "draft/apps/CanTable/CanTable.can"),
    join(root, "draft/shared/Employees.can"),
    join(root, "draft/shared/Locations.can"),
  ];
  return JSON.parse(
    execFileSync(compiler, ["compile", "--format=json", `--catalog=${catalog}`, ...files], {
      encoding: "utf8",
    }),
  ) as CompileArtifact;
}

async function databases() {
  const mf = new Miniflare({
    cf: false,
    host: "127.0.0.1",
    port: 0,
    log: new Log(LogLevel.ERROR),
    name: `fixture-staging-${randomUUID()}`,
    compatibilityDate: "2026-07-15",
    modules: [
      {
        path: "main.mjs",
        type: "ESModule",
        contents: "export default {fetch(){return new Response(null,{status:404})}};",
      },
    ],
    d1Databases: { DB: randomUUID(), CEDAR: randomUUID(), OAK: randomUUID() },
  });
  await mf.ready;
  return mf;
}

async function seedIdentity(mf: Miniflare) {
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await ensureIdentitySchema(db);
  const identities = createD1IdentityStore(db);
  const cedar = (await identities.createTeam({})).team_id;
  const oak = (await identities.createTeam({})).team_id;
  const user = async (email: string, team: string, owner: boolean) => {
    const created = await identities.createUser({
      email,
      password_hash: "example-only-unusable",
      email_verified: true,
    });
    await identities.createMembership({
      team_id: team,
      user_id: created.user_id,
      is_owner: owner,
      roles: [],
    });
    return created.user_id;
  };
  const ava = await user("ava@preview.can.test", cedar, true);
  const ben = await user("ben@preview.can.test", cedar, false);
  const cal = await user("cal@preview.can.test", oak, true);
  // Mirror preview activation: pin each owner database before staging may use it.
  for (const [binding, team] of [["CEDAR", cedar], ["OAK", oak]] as const) {
    const ownerDb = (await mf.getD1Database(binding)) as unknown as D1Database;
    await ensureStateSchema(ownerDb);
    const router = createD1OwnerRouter({
      resolveBinding: (requested) =>
        requested.app === "StageProbe" && requested.owner === team
          ? { app: "StageProbe", owner: team, db: ownerDb, initializeFresh: true }
          : null,
    });
    await router.ownerScopedStoragePort({ app: "StageProbe", owner: team });
  }
  return { cedar, oak, ava, ben, cal };
}

async function stage(
  mf: Miniflare,
  artifact: CompileArtifact,
  ids: { cedar: string; oak: string; ava: string; ben: string; cal: string },
) {
  const workDir = await mkdtemp(join(tmpdir(), "can-fixture-staging-"));
  try {
    return await stageClosureFixtures(
      {
        applicationRoot: process.cwd(),
        artifactBytes: Buffer.from(JSON.stringify(artifact)),
        artifactLabel: "StageProbe.artifact.json",
        sourceRevision: "fixture-staging-test",
        workDir,
        bindings: {
          self: decodeValue("user", { id: ids.ava }),
          other: decodeValue("user", { id: ids.ben }),
          outsider: decodeValue("user", { id: ids.cal }),
        },
        identity: {
          currentTeamId: ids.cedar,
          otherTeamId: ids.oak,
          selfUserId: ids.ava,
          otherUserId: ids.ben,
          outsiderUserId: ids.cal,
        },
        testkit: await loadInstalledExampleTestkit(process.cwd()),
      },
      mf,
      { d1Id: "stage-test", identityBinding: "DB", currentOwnerBinding: "CEDAR", otherOwnerBinding: "OAK" },
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

test("closure stages its fixture providers under preview identity", async () => {
  const artifact = compileSource(STAGE_APP);
  const mf = await databases();
  try {
    const ids = await seedIdentity(mf);
    const staged = await stage(mf, artifact, ids);
    for (const name of ["StageProbe.site", "StageProbe.room", "StageProbe.spare"]) {
      assert.ok(staged.materialized.includes(name), `staged ${name}, got ${staged.materialized}`);
    }
    const cedar = (await mf.getD1Database("CEDAR")) as unknown as D1Database;
    const result = await cedar
      .prepare("SELECT model, id, owner, parent_model, parent_id, data FROM records")
      .all();
    const rows = (
      result.results as Array<{
        model: string;
        id: string;
        owner: string;
        parent_model: string | null;
        parent_id: string | null;
        data: string;
      }>
    ).map((row) => ({ ...row, fields: JSON.parse(row.data) as Record<string, unknown> }));
    assert.equal(rows.length, 3);
    const byName = new Map(rows.map((row) => [row.fields["name"], row]));
    assert.equal(byName.get("Main")!.model, "StageProbe.Site");
    assert.equal(byName.get("1")!.model, "StageProbe.Room");
    assert.equal(byName.get("2")!.model, "StageProbe.Room");
    assert.equal(Number(byName.get("1")!.fields["seats"]), 4);
    assert.equal(Number(byName.get("2")!.fields["seats"]), 2);
    assert.equal(byName.get("1")!.parent_id, byName.get("Main")!.id);
    assert.equal(byName.get("2")!.parent_id, byName.get("Main")!.id);
    const oak = (await mf.getD1Database("OAK")) as unknown as D1Database;
    const other = await oak.prepare("SELECT id FROM records").all();
    assert.equal(other.results.length, 0, "other team database stays empty");
  } finally {
    await mf.dispose();
  }
});

test("staging refuses a closure with a missing fixture provider", async () => {
  const artifact = compileSource(STAGE_APP);
  const broken = JSON.parse(JSON.stringify(artifact)) as CompileArtifact;
  broken.tests = broken.tests.filter((t) => t.scope !== "StageProbe.site");
  const mf = await databases();
  try {
    const ids = await seedIdentity(mf);
    await assert.rejects(
      stage(mf, broken, ids),
      /expected one provider for StageProbe\.site/,
    );
  } finally {
    await mf.dispose();
  }
});

test("cantable closure emits clean with reserve and seat", async () => {
  const artifact = compileCanTable();
  const names = (artifact.operations ?? []).map((op) => op.name);
  for (const name of ["cafe.reserve", "cafe.seat"]) {
    assert.ok(names.includes(name), `closure emits ${name}`);
  }
});
