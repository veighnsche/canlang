/**
 * T37 basic pilot, direct legs (LG03): ONE unchanged original app —
 * `draft/CanDo.can` plus its minimal shared closure
 * (`draft/shared/Locations.can`, `draft/shared/Employees.can`) — proves
 * generated operations, two actors, denied read, persistence, stale
 * update, replay, `complete`/`reopen` scenarios, and genuine executed
 * examples. No reduced source projection: every input is hashed committed
 * bytes and the pilot stays first so `sources[0]` identity binds CanDo.
 *
 * Journeys invoke the REAL canonical invoker against REAL miniflare D1
 * (the T21 island); identity is the REAL L6 memory store (same
 * durable-claim scope as T21). Served legs (browser page GETs + MCP
 * tools/call over the C1 deploy bundle) ride a follow-up slice: worker
 * identity/env provisioning cannot be built blind and needs the same
 * runtime the T02 blockers gate.
 *
 * Presence-shaped assertions (own rows only): the island D1 is per
 * Playwright *worker*, shared across compiled specs in that worker.
 */
import { expect } from "@playwright/test";
import type {
  FqOperationName,
  ModelName,
  MutationResult,
  OperationId,
  OperationName,
  RecordId,
} from "@canlang/contracts";
import { compiledTest as base } from "../fixtures/e2e-test.js";
import {
  COMPILED_LABEL_PREFIX,
  createCompiledInvoker,
  disposeCompiledAssembly,
  loadCompiledArtifact,
} from "../fixtures/artifact-loader.js";
import { freshOperationId } from "../fixtures/compiled-seed.js";
import { seedPilotActors, seedPilotStaff, stageSuiteModule } from "../fixtures/pilot-seed.js";
import { PilotExamples } from "../fixtures/pilot-examples.js";

export const PILOT_SOURCE = "draft/CanDo.can";
export const PILOT_EXTRA_SOURCES = ["draft/shared/Locations.can", "draft/shared/Employees.can"];

const TASK = "todo.Task";
const CREATE = "todo.Task.create";
const READ = "todo.Task.read";
const UPDATE = "todo.Task.update";
const COMPLETE = "todo.complete";
const REOPEN = "todo.reopen";

const EXPECTED_TODO_OPS = [
  "todo.Task.read",
  "todo.Comment.read",
  "todo.Template.read",
  "todo.TemplateTask.read",
  "todo.Generation.read",
  "todo.WorkView.read",
  "todo.Task.create",
  "todo.Task.update",
  "todo.Task.delete",
  "todo.Comment.create",
  "todo.Template.create",
  "todo.Template.update",
  "todo.Template.delete",
  "todo.TemplateTask.create",
  "todo.TemplateTask.update",
  "todo.TemplateTask.delete",
  COMPLETE,
  REOPEN,
  "todo.generate",
  "todo.refresh",
];

const EXPECTED_TODO_MODELS = [
  "todo.Task",
  "todo.Comment",
  "todo.Template",
  "todo.TemplateTask",
  "todo.Generation",
  "todo.WorkView",
];

const EXPECTED_PAGE_PATHS = ["/tasks", "/tasks/my-work", "/tasks/checklists"];

/** Pilot `compiled` fixture: CanDo + minimal closure (island inherited). */
export const pilotTest = base.extend({
  compiled: [
    async ({}, use) => {
      const compiled = await loadCompiledArtifact({
        kind: "compiled",
        source: PILOT_SOURCE,
        extraSources: PILOT_EXTRA_SOURCES,
      });
      try {
        await use(compiled);
      } finally {
        disposeCompiledAssembly(compiled);
      }
    },
    { scope: "worker" },
  ],
});

interface TaskRow {
  readonly id: string;
  readonly version: number;
  readonly data: Record<string, unknown>;
}

function createdRow(result: MutationResult): TaskRow {
  const row = result.result as { id?: unknown; version?: unknown; data?: unknown };
  if (typeof row.id !== "string" || typeof row.version !== "number") {
    throw new Error(`pilot: bad create result ${JSON.stringify(result.result).slice(0, 300)}`);
  }
  if (typeof row.data !== "object" || row.data === null || Array.isArray(row.data)) {
    throw new Error(`pilot: bad create data ${JSON.stringify(result.result).slice(0, 300)}`);
  }
  return { id: row.id, version: row.version, data: row.data as Record<string, unknown> };
}

function readRows(result: unknown): TaskRow[] {
  const root = result as { records?: TaskRow[] };
  if (!Array.isArray(root.records)) {
    throw new Error(`pilot: read result has no records[]: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return root.records;
}

pilotTest.describe("challenge pilot", () => {
  pilotTest("carries the source-bound pilot identity and generated surface", async ({ compiled }) => {
    expect(compiled.label).toBe(`${COMPILED_LABEL_PREFIX}${compiled.sourceSha256}`);
    expect(compiled.sourcePath).toBe(PILOT_SOURCE);
    expect(compiled.artifact.sources[0]?.path).toBe(PILOT_SOURCE);
    expect(compiled.artifact.sources[0]?.sha256).toBe(compiled.sourceSha256);
    expect(compiled.toolchain).toMatch(/^can \S+ \(commit [^;]+; language \S+; schema \S+\)$/);
    // Minimal closure evidence: every provider input was hashed bytes.
    expect(compiled.extraSources.map((ref) => ref.path)).toEqual(PILOT_EXTRA_SOURCES);
    for (const ref of compiled.extraSources) {
      expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // Generated operations: the CanDo surface the journeys exercise.
    // Provider-closure ops (employee.*, rent_catalog.*) ride along by
    // design; the pilot pins its own subset.
    const opNames = compiled.artifact.operations?.map((op) => op.name) ?? [];
    for (const expected of EXPECTED_TODO_OPS) {
      expect(opNames, `missing operation ${expected} (emitted: ${opNames.join(",")})`).toContain(expected);
    }
    const modelNames = compiled.artifact.models?.map((model) => model.name) ?? [];
    for (const expected of EXPECTED_TODO_MODELS) {
      expect(modelNames, `missing model ${expected}`).toContain(expected);
    }
    const pagePaths = compiled.artifact.pages?.map((page) => page.path) ?? [];
    for (const expected of EXPECTED_PAGE_PATHS) {
      expect(pagePaths, `missing page ${expected}`).toContain(expected);
    }
  });

  pilotTest("two actors share tasks with persistence across handles", async ({ compiled, island }) => {
    const actors = await seedPilotActors();
    await seedPilotStaff(island.store, actors, `persist-${actors.now}`);
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: actors.store,
      now: () => actors.now,
    });

    const title = `persist ${actors.manager.userId.slice(0, 8)}`;
    const created = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { title },
      },
      actors.manager.identity,
    );
    if (!("result" in created)) {
      throw new Error(`pilot: create failed ${JSON.stringify(created)}`);
    }
    expect(created.result.status).toBe("committed");
    const row = createdRow(created.result);
    expect(row.version).toBe(1);
    expect(row.data["title"]).toBe(title);
    expect(row.data["done"]).toBe(false);

    // Second actor reads the first actor's task (shared team scope).
    const readBack = await invoker.invokeRead(
      { operation: READ as FqOperationName, inputs: {} },
      actors.member.identity,
    );
    if (!("result" in readBack)) {
      throw new Error(`pilot: member read failed ${JSON.stringify(readBack)}`);
    }
    const found = readRows(readBack.result).find((entry) => entry.id === row.id);
    expect(found?.data["title"]).toBe(title);

    // Persistence: a FRESH handle serves the same row.
    const fresh = island.freshStore();
    const stored = await fresh.load(TASK as ModelName, row.id as RecordId);
    expect(stored?.version).toBe(1);
    expect((stored?.data as Record<string, unknown>)["title"]).toBe(title);
  });

  pilotTest("denied reads answer forbidden, never rows", async ({ compiled, island }) => {
    const actors = await seedPilotActors();
    await seedPilotStaff(island.store, actors, `denied-${actors.now}`);
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: actors.store,
      now: () => actors.now,
    });

    const title = `denied ${actors.manager.userId.slice(0, 8)}`;
    const created = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { title },
      },
      actors.manager.identity,
    );
    if (!("result" in created)) {
      throw new Error(`pilot: seed create failed ${JSON.stringify(created)}`);
    }
    // Outsider (no membership): `read=members` denies.
    const denied = await invoker.invokeRead(
      { operation: READ as FqOperationName, inputs: {} },
      actors.outsider.identity,
    );
    if (!("error" in denied)) {
      throw new Error(`pilot: outsider read served rows, want forbidden`);
    }
    expect(denied.error.code).toBe("forbidden");
  });

  pilotTest("stale updates conflict without touching the stored row", async ({ compiled, island }) => {
    const actors = await seedPilotActors();
    await seedPilotStaff(island.store, actors, `stale-${actors.now}`);
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: actors.store,
      now: () => actors.now,
    });

    const title = `stale ${actors.member.userId.slice(0, 8)}`;
    const created = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { title },
      },
      actors.member.identity,
    );
    if (!("result" in created)) {
      throw new Error(`pilot: create failed ${JSON.stringify(created)}`);
    }
    const id = createdRow(created.result).id;

    const updated = await invoker.invokeMutation(
      {
        operation: UPDATE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { record: { id, version: "1" }, title: `${title} v2` },
      },
      actors.manager.identity,
    );
    if (!("result" in updated)) {
      throw new Error(`pilot: update failed ${JSON.stringify(updated)}`);
    }
    expect(createdRow(updated.result).version).toBe(2);

    const revisionBeforeStale = await island.store.readRevision();
    const stale = await invoker.invokeMutation(
      {
        operation: UPDATE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { record: { id, version: "1" }, title: `${title} stale` },
      },
      actors.member.identity,
    );
    if (!("error" in stale)) {
      throw new Error(`pilot: stale update committed, want conflict`);
    }
    expect(stale.error.code).toBe("conflict");
    expect(await island.store.readRevision()).toBe(revisionBeforeStale);
    const row = await island.store.load(TASK as ModelName, id as RecordId);
    expect(row?.version).toBe(2);
    expect((row?.data as Record<string, unknown>)["title"]).toBe(`${title} v2`);
  });

  pilotTest("duplicate deliveries replay without re-executing", async ({ compiled, island }) => {
    const actors = await seedPilotActors();
    await seedPilotStaff(island.store, actors, `replay-${actors.now}`);
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: actors.store,
      now: () => actors.now,
    });

    const title = `replay ${actors.manager.userId.slice(0, 8)}`;
    const operationId = freshOperationId(actors.now);
    const first = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: operationId as OperationId,
        inputs: { title },
      },
      actors.manager.identity,
    );
    if (!("result" in first)) {
      throw new Error(`pilot: create failed ${JSON.stringify(first)}`);
    }
    expect(first.result.status).toBe("committed");
    const id = createdRow(first.result).id;

    const replayed = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: operationId as OperationId,
        inputs: { title },
      },
      actors.manager.identity,
    );
    if (!("result" in replayed)) {
      throw new Error(`pilot: replay failed ${JSON.stringify(replayed)}`);
    }
    expect(replayed.result.status).toBe("replayed");
    expect(createdRow(replayed.result).id).toBe(id);
  });

  pilotTest("complete and reopen run the authored scenarios", async ({ compiled, island }) => {
    const actors = await seedPilotActors();
    await seedPilotStaff(island.store, actors, `scenarios-${actors.now}`);
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: actors.store,
      now: () => actors.now,
    });

    const title = `scenarios ${actors.member.userId.slice(0, 8)}`;
    const created = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { title },
      },
      actors.member.identity,
    );
    if (!("result" in created)) {
      throw new Error(`pilot: create failed ${JSON.stringify(created)}`);
    }
    const id = createdRow(created.result).id;

    const completed = await invoker.invokeMutation(
      {
        operation: COMPLETE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { task: { id, version: "1" } },
      },
      actors.member.identity,
    );
    if (!("result" in completed)) {
      throw new Error(`pilot: complete failed ${JSON.stringify(completed)}`);
    }
    expect(completed.result.status).toBe("committed");
    const doneRow = await island.store.load(TASK as ModelName, id as RecordId);
    if (doneRow === null) {
      throw new Error(`pilot: completed row ${id} not readable`);
    }
    const doneData = doneRow.data as Record<string, unknown>;
    expect(doneData["done"]).toBe(true);
    expect(doneData["completed_by"]).not.toBeNull();

    // Completing a done task rejects the authored guard.
    const again = await invoker.invokeMutation(
      {
        operation: COMPLETE as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { task: { id, version: String(doneRow.version) } },
      },
      actors.member.identity,
    );
    if (!("error" in again)) {
      throw new Error(`pilot: double complete committed, want rule_failed`);
    }
    expect(again.error.code).toBe("rule_failed");

    const reopened = await invoker.invokeMutation(
      {
        operation: REOPEN as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { task: { id, version: String(doneRow.version) } },
      },
      actors.member.identity,
    );
    if (!("result" in reopened)) {
      throw new Error(`pilot: reopen failed ${JSON.stringify(reopened)}`);
    }
    expect(reopened.result.status).toBe("committed");
    const openRow = await island.store.load(TASK as ModelName, id as RecordId);
    const openData = openRow?.data as Record<string, unknown>;
    expect(openData["done"]).toBe(false);
    expect(openData["completed_by"]).toBeNull();
  });

  pilotTest("genuine examples execute green against the live pilot", async ({ compiled, island }) => {
    const actors = await seedPilotActors();
    await seedPilotStaff(island.store, actors, `examples-${actors.now}`);
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: actors.store,
      now: () => actors.now,
    });
    const tests = compiled.artifact.tests ?? [];
    const suite = tests.find((entry) => entry.scope === COMPLETE);
    if (suite === undefined) {
      throw new Error(
        `pilot: artifact has no BDD suite for ${COMPLETE} (scopes: ${tests.map((entry) => entry.scope).join(",") || "none"})`,
      );
    }
    const runner = new PilotExamples({
      artifact: compiled.artifact,
      invoker,
      store: island.store,
      caller: actors.member.identity,
      userId: actors.member.userId,
      now: () => actors.now,
      operationId: () => freshOperationId(actors.now),
    });
    const report = await runner.runSuite(stageSuiteModule(compiled.workDir, suite), COMPLETE);
    expect(report.rows.length).toBeGreaterThan(0);
    for (const row of report.rows) {
      expect(
        row.outcome === "passed",
        `pilot: example row ${row.rowIndex} ${row.outcome}: ${row.detail ?? JSON.stringify(row.mismatches ?? row.rejection)}`,
      ).toBe(true);
    }
  });
});
