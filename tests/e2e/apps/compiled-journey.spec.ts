/**
 * T21 compiled journey: REAL `can compile` output for the Shop fixture,
 * invoked through the canonical invoker (verified-context admission via
 * the real registry, canonical transaction/history/replay/projection)
 * against REAL miniflare D1. No hand-built artifact substitution exists
 * on this path: the loader runs the toolchain on every worker boot, and
 * this spec asserts the `compiled/<sha256>` identity before journeying.
 *
 * Presence-shaped assertions (own rows only): the island D1 is per
 * Playwright *worker*, shared across compiled specs in that worker.
 */
import { expect } from "@playwright/test";
import type {
  ModelName,
  MutationResult,
  OperationId,
  OperationName,
  RecordId,
} from "@canlang/contracts";
import { COMPILED_JOURNEY_SOURCE, compiledTest as test } from "../fixtures/e2e-test.js";
import { COMPILED_LABEL_PREFIX, createCompiledInvoker } from "../fixtures/artifact-loader.js";
import { freshOperationId, seedCompiledMember } from "../fixtures/compiled-seed.js";

const CREATE = "Store.Gadget.create";
const READ = "Store.Gadget.read";
const UPDATE = "Store.Gadget.update";
const DELETE = "Store.Gadget.delete";
const MODEL = "Store.Gadget";
// Receipt `app` pin: the worker assembly derives the app id from the
// artifact source stem (`interimAppInfo`), so the compiled-shop fixture
// receipts under "compiled-shop" (same rule the T17b harness pins as
// "TeamTasks" for its fixture).
const RECEIPT_APP = "compiled-shop";

interface ReadRow {
  readonly id: string;
  readonly version: number;
  readonly data: Record<string, unknown>;
}

function readRows(result: unknown): ReadRow[] {
  const root = result as { records: ReadRow[] };
  if (!Array.isArray(root.records)) throw new Error("compiled journey: read result has no records[]");
  return root.records;
}

function createdRow(result: MutationResult): { id: string; version: number; data: Record<string, unknown> } {
  const row = result.result as { id: unknown; version: unknown; data: unknown };
  if (typeof row.id !== "string" || typeof row.version !== "number") {
    throw new Error(`compiled journey: bad create result ${JSON.stringify(result.result)}`);
  }
  if (typeof row.data !== "object" || row.data === null || Array.isArray(row.data)) {
    throw new Error(`compiled journey: bad create data ${JSON.stringify(result.result)}`);
  }
  return { id: row.id, version: row.version, data: row.data as Record<string, unknown> };
}

test.describe("compiled journey", () => {
  test("carries the source-bound compiled identity", async ({ compiled }) => {
    expect(compiled.label).toBe(`${COMPILED_LABEL_PREFIX}${compiled.sourceSha256}`);
    expect(compiled.sourcePath).toBe(COMPILED_JOURNEY_SOURCE);
    expect(compiled.artifact.sources[0]?.sha256).toBe(compiled.sourceSha256);
    expect(compiled.toolchain).toMatch(/^can \S+ \(commit [^;]+; language \S+; schema \S+\)$/);
    // Descriptors really emitted (generated-artifact shape: the invoker
    // refuses descriptor-less artifacts, so this also proves servability).
    expect(compiled.artifact.operations?.map((op) => op.name)).toEqual([
      "Lobby.Notice.read",
      READ,
      CREATE,
      UPDATE,
      DELETE,
    ]);
    expect(compiled.artifact.models?.map((model) => model.name)).toEqual(["Lobby.Notice", MODEL]);
  });

  test("create→read→update→delete with receipt/history verification", async ({ compiled, island }) => {
    expect(compiled.label.startsWith(COMPILED_LABEL_PREFIX)).toBe(true);
    const seed = await seedCompiledMember();
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: seed.store,
      now: () => seed.now,
    });

    const title = `wrench ${seed.memberId.slice(0, 8)}`;
    const createOpId = freshOperationId(seed.now);

    // -- create ------------------------------------------------------
    const created = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: createOpId as OperationId,
        inputs: { title },
      },
      seed.identity,
    );
    if (!("result" in created)) throw new Error(`compiled journey: create failed ${JSON.stringify(created)}`);
    expect(created.result.status).toBe("committed");
    const row = createdRow(created.result);
    expect(row.version).toBe(1);
    expect(row.data).toEqual({ title });

    // -- duplicate create replays without re-executing ----------------
    const replayed = await invoker.invokeMutation(
      {
        operation: CREATE as OperationName,
        operation_id: createOpId as OperationId,
        inputs: { title },
      },
      seed.identity,
    );
    if (!("result" in replayed)) throw new Error(`compiled journey: replay failed ${JSON.stringify(replayed)}`);
    expect(replayed.result.status).toBe("replayed");
    expect(createdRow(replayed.result).id).toBe(row.id);

    // -- read serves the created row ----------------------------------
    const readBack = await invoker.invokeRead({ operation: READ, inputs: {} }, seed.identity);
    if (!("result" in readBack)) throw new Error(`compiled journey: read failed ${JSON.stringify(readBack)}`);
    const found = readRows(readBack.result).find((entry) => entry.id === row.id);
    expect(found?.data).toEqual({ title });

    // -- update --------------------------------------------------------
    const updatedTitle = `${title} v2`;
    const updateOpId = freshOperationId(seed.now);
    const updated = await invoker.invokeMutation(
      {
        operation: UPDATE as OperationName,
        operation_id: updateOpId as OperationId,
        inputs: { record: { id: row.id, version: "1" }, title: updatedTitle },
      },
      seed.identity,
    );
    if (!("result" in updated)) throw new Error(`compiled journey: update failed ${JSON.stringify(updated)}`);
    expect(updated.result.status).toBe("committed");
    const updatedRow = createdRow(updated.result);
    expect(updatedRow.version).toBe(2);
    expect(updatedRow.data).toEqual({ title: updatedTitle });

    const readUpdated = await invoker.invokeRead({ operation: READ, inputs: {} }, seed.identity);
    if (!("result" in readUpdated)) {
      throw new Error(`compiled journey: re-read failed ${JSON.stringify(readUpdated)}`);
    }
    expect(readRows(readUpdated.result).find((entry) => entry.id === row.id)?.data).toEqual({
      title: updatedTitle,
    });

    // -- delete (archive mode) ------------------------------------------
    const deleteOpId = freshOperationId(seed.now);
    const deleted = await invoker.invokeMutation(
      {
        operation: DELETE as OperationName,
        operation_id: deleteOpId as OperationId,
        inputs: { record: { id: row.id, version: "2" } },
      },
      seed.identity,
    );
    if (!("result" in deleted)) throw new Error(`compiled journey: delete failed ${JSON.stringify(deleted)}`);
    expect(deleted.result.status).toBe("committed");

    const readDeleted = await invoker.invokeRead({ operation: READ, inputs: {} }, seed.identity);
    if (!("result" in readDeleted)) {
      throw new Error(`compiled journey: post-delete read failed ${JSON.stringify(readDeleted)}`);
    }
    expect(readRows(readDeleted.result).some((entry) => entry.id === row.id)).toBe(false);

    // -- receipts + history via a FRESH handle (persist proof) ----------
    const fresh = island.freshStore();
    for (const [operation, operationId] of [
      [CREATE, createOpId],
      [UPDATE, updateOpId],
      [DELETE, deleteOpId],
    ] as const) {
      const receipt = await fresh.readReceipt({
        app: RECEIPT_APP,
        owner: seed.teamId,
        principal: seed.memberId,
        operation: operation as OperationName,
        operationId: operationId as OperationId,
      });
      expect(receipt, `receipt for ${operation}`).not.toBeNull();
      expect(receipt?.outcome.status).toBe("committed");
    }
    const trail = await fresh.historyFor(MODEL as ModelName, row.id as RecordId);
    expect(trail.map((entry) => [entry.change, entry.version, entry.operationId])).toEqual([
      ["create", 1, createOpId],
      ["update", 2, updateOpId],
      ["archive", 3, deleteOpId],
    ]);
  });
});
