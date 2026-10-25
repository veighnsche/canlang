/**
 * T37 basic-pilot legs, shared by the pristine witness
 * (`challenge-pilot.spec.ts`, `draft/apps/CanDo/CanDo.can` + minimal closure) and the
 * patched live runs (`challenge-pilot-patched.spec.ts`, suite-3 fixtures
 * in `../fixtures/patched-pilot/`). Leg bodies are source-agnostic except
 * the identity leg, which takes the expected `{ source, extraSources }`
 * per spec. One home for all legs: no pristine/patched drift.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { loadExampleBindings } from "@canlang/cloudflare/runtime/example-bindings";
import { startLocalDev } from "../../fixtures/raw-worker.js";
import type {
  FqOperationName,
  ModelName,
  OperationId,
  OperationName,
  RecordId,
} from "@canlang/contracts";
import {
  COMPILED_LABEL_PREFIX,
  E2E_COMPATIBILITY_DATE,
  createCompiledInvoker,
  type CompiledAssembly,
} from "../fixtures/artifact-loader.js";
import type { CompiledD1Island } from "../fixtures/e2e-test.js";
import { changedRow as createdRow, freshOperationId } from "../fixtures/compiled-seed.js";
import { seedPilotActors, seedPilotStaff } from "../fixtures/pilot-seed.js";

/** Durable effect channels, excluding the legitimate rejected receipt itself. */
async function storedEffects(island: CompiledD1Island) {
  const db = await island.dev.getD1Database(island.binding);
  return Promise.all([
    db.prepare("SELECT * FROM records ORDER BY model, id").all(),
    db.prepare("SELECT * FROM history ORDER BY seq").all(),
    db.prepare("SELECT * FROM outbox ORDER BY intent_id").all(),
  ]).then(tables => tables.map(table => table.results));
}

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

/** Fixtures every leg receives (worker-scoped `compiled`, shared island). */
export interface PilotLegFixtures {
  readonly compiled: CompiledAssembly;
  readonly island: CompiledD1Island;
}

/** Expected closure paths, per spec (pristine draft vs patched fixtures). */
export interface PilotLegSources {
  readonly source: string;
  readonly extraSources: readonly string[];
}

export interface PilotLeg {
  readonly name: string;
  readonly timeoutMs?: number;
  readonly run: (fixtures: PilotLegFixtures, sources: PilotLegSources) => Promise<void>;
}

interface TaskRow {
  readonly id: string;
  readonly version: number;
  readonly data: Record<string, unknown>;
}


function readRows(result: unknown): TaskRow[] {
  const root = result as { records?: TaskRow[] };
  if (!Array.isArray(root.records)) {
    throw new Error(`pilot: read result has no records[]: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return root.records;
}

export const pilotLegs: readonly PilotLeg[] = [
  {
    name: "carries the source-bound pilot identity and generated surface",
    run: async ({ compiled }, sources) => {
      expect(compiled.label).toBe(`${COMPILED_LABEL_PREFIX}${compiled.sourceSha256}`);
      expect(compiled.sourcePath).toBe(sources.source);
      expect(compiled.artifact.sources[0]?.path).toBe(sources.source);
      expect(compiled.artifact.sources[0]?.sha256).toBe(compiled.sourceSha256);
      expect(compiled.toolchain).toMatch(/^can \S+ \(commit [^;]+; language \S+; schema \S+\)$/);
      // Minimal closure evidence: every provider input was hashed bytes.
      expect(compiled.extraSources.map((ref) => ref.path)).toEqual(sources.extraSources);
      for (const ref of compiled.extraSources) {
        expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
      // Generated operations: the CanDo surface the journeys exercise.
      // Provider-closure ops (employee.*, rent_catalog.*) ride along by
      // design; the pilot pins its own subset.
      const opNames = compiled.artifact.operations?.map((op) => op.name) ?? [];
      for (const expected of EXPECTED_TODO_OPS) {
        expect(opNames, `missing operation ${expected} (emitted: ${opNames.join(",")})`).toContain(
          expected,
        );
      }
      const modelNames = compiled.artifact.models?.map((model) => model.name) ?? [];
      for (const expected of EXPECTED_TODO_MODELS) {
        expect(modelNames, `missing model ${expected}`).toContain(expected);
      }
      const pagePaths = compiled.artifact.pages?.map((page) => page.path) ?? [];
      for (const expected of EXPECTED_PAGE_PATHS) {
        expect(pagePaths, `missing page ${expected}`).toContain(expected);
      }
    },
  },
  {
    name: "two actors share tasks with persistence across handles",
    run: async ({ compiled, island }) => {
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
    },
  },
  {
    name: "assignment invariant observes membership revocation before commit",
    run: async ({ compiled, island }) => {
      for (const race of [false, true]) {
        const actors = await seedPilotActors();
        await seedPilotStaff(island.store, actors, `membership-${race}-${actors.now}`);
        const membership = actors.member.identity.membership;
        if (membership === null) throw new Error("pilot: assignment witness has no member");
        let removed = false;
        const memberships = {
          ...actors.store,
          findMembership: async (team: string, user: string) => {
            const fact = await actors.store.findMembership(team, user);
            if (race && !removed && user === actors.member.userId) {
              removed = true;
              await actors.store.removeMembership(membership.membership_id);
            }
            return fact;
          },
        };
        const invoker = await createCompiledInvoker(compiled, island.store, {
          memberships, now: () => actors.now,
        });
        if (!race) {
          const allowed = await invoker.invokeMutation({
            operation: CREATE as OperationName,
            operation_id: freshOperationId(actors.now) as OperationId,
            inputs: { title: "Current member assignment", assignee: { id: actors.member.userId } },
          }, actors.manager.identity);
          if (!("result" in allowed)) throw new Error(`pilot: active assignment failed ${JSON.stringify(allowed)}`);
          expect(allowed.result.status).toBe("committed");
          await actors.store.removeMembership(membership.membership_id);
        }
        const before = await storedEffects(island);
        const operation = freshOperationId(actors.now) as OperationId;
        const denied = await invoker.invokeMutation({
          operation: CREATE as OperationName, operation_id: operation,
          inputs: { title: "Revoked assignment must not persist", assignee: { id: actors.member.userId } },
        }, actors.manager.identity);
        expect(denied, `revocation race=${race}`).toHaveProperty("error");
        if (!("error" in denied)) throw new Error("pilot: revoked assignment committed");
        expect(["rule_failed", "forbidden", "conflict"]).toContain(denied.error.code);
        if (race) expect(removed).toBe(true);
        expect(await storedEffects(island)).toEqual(before);
      }
    },
  },
  {
    name: "unsupported guarded work refresh refuses before changing rows or publishing work",
    run: async ({ compiled, island }) => {
      const actors = await seedPilotActors();
      await seedPilotStaff(island.store, actors, `unsupported-${actors.now}`);
      const invoker = await createCompiledInvoker(compiled, island.store, {
        memberships: actors.store, now: () => actors.now,
      });
      const before = await storedEffects(island);
      const refused = await invoker.invokeMutation({
        operation: "todo.refresh" as OperationName,
        operation_id: freshOperationId(actors.now) as OperationId,
        inputs: { locations: [] },
      }, actors.member.identity);
      expect(refused).toHaveProperty("error");
      if (!("error" in refused)) throw new Error("pilot: unsupported guarded refresh executed");
      expect(refused.error.code).toBe("validation");
      expect(refused.error.message).toBe('Guarded owner "todo.refresh" lacks its original checked execution source.');
      expect(await storedEffects(island)).toEqual(before);
    },
  },
  {
    name: "public reads withhold every task from outsiders",
    run: async ({ compiled, island }) => {
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
      // Task.read admits public viewers; its authored members/staff row
      // predicate withholds every row and all record metadata from outsiders.
      const denied = await invoker.invokeRead(
        { operation: READ as FqOperationName, inputs: {} },
        actors.outsider.identity,
      );
      if (!("result" in denied)) {
        throw new Error(`pilot: public outsider read failed ${JSON.stringify(denied)}`);
      }
      expect(denied).toEqual({
        result: { records: [], revision: await island.store.readRevision() },
      });
    },
  },
  {
    name: "stale updates conflict without touching the stored row",
    run: async ({ compiled, island }) => {
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
    },
  },
  {
    name: "duplicate deliveries replay without re-executing",
    run: async ({ compiled, island }) => {
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
    },
  },
  {
    name: "complete and reopen run the authored scenarios",
    run: async ({ compiled, island }) => {
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
    },
  },
  {
    name: "genuine examples execute green against the live pilot",
    // Each authored row provisions isolated Identity + two State databases.
    timeoutMs: 90_000,
    run: async ({ compiled }) => {
      const moduleIndex = compiled.artifact.tests.findIndex((entry) => entry.scope === COMPLETE);
      expect(moduleIndex, "authored complete example suite").toBeGreaterThanOrEqual(0);
      const workDir = await mkdtemp(join(tmpdir(), "can-pilot-examples-"));
      try {
        const suite = await loadExampleBindings({
          applicationRoot: process.cwd(),
          artifactBytes: new TextEncoder().encode(JSON.stringify(compiled.artifact)),
          artifactLabel: compiled.sourcePath,
          sourceRevision: compiled.sourceSha256,
          workDir,
        }, moduleIndex);
        expect(suite.metadata.rows.length).toBeGreaterThan(0);
        for (const authored of suite.metadata.rows) {
          const d1Id = randomUUID(), currentStateId = randomUUID(), otherStateId = randomUUID();
          const dev = await startLocalDev({
            workerName: "can-pilot-example", compatibilityDate: E2E_COMPATIBILITY_DATE,
            mainModule: "vehicle.mjs",
            modules: { "vehicle.mjs": "export default {fetch(){return new Response('example resources')}}" },
            d1Databases: [
              { binding: "DB", id: d1Id },
              { binding: "CAN_EXAMPLE_STATE_CURRENT", id: currentStateId },
              { binding: "CAN_EXAMPLE_STATE_OTHER", id: otherStateId },
            ],
          });
          try {
            const report = await suite.row(authored.rowIndex, dev, { d1Id, currentStateId, otherStateId, d1Binding: "DB" });
            expect(report.rows).toHaveLength(1);
            for (const row of report.rows) {
              expect(row.outcome, `pilot: example row ${row.rowIndex}: ${row.detail ?? JSON.stringify(row.mismatches ?? row.rejection)}`).toBe("passed");
            }
          } finally { await dev.dispose(); }
        }
      } finally { await rm(workDir, { recursive: true, force: true }); }
    },
  },
];
