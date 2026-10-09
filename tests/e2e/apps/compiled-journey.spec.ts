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

function disclosedRow(result: MutationResult): ReadRow {
  expect(result.result).toBeNull();
  expect(result.records).toHaveLength(1);
  const row = result.records![0] as { id: unknown; version: unknown; data: unknown };
  if (typeof row.id !== "string" || typeof row.version !== "number") {
    throw new Error(`compiled journey: bad disclosed record ${JSON.stringify(result.records)}`);
  }
  if (typeof row.data !== "object" || row.data === null || Array.isArray(row.data)) {
    throw new Error(`compiled journey: bad disclosed data ${JSON.stringify(result.records)}`);
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
    const entry = compiled.artifact.modules[0];
    if (entry === undefined) throw new Error("compiled journey: defining app entry is missing");
    const entryUrl = compiled.asm.moduleUrls[entry.path];
    if (entryUrl === undefined) throw new Error("compiled journey: defining app entry is not assembled");
    const { appDefinition } = await import(entryUrl) as { appDefinition: { id: string } };
    expect(appDefinition.id).toBe("Lobby");
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
    expect(created.result.operation_id).toBe(createOpId);
    const row = disclosedRow(created.result);
    expect(row.version).toBe(1);
    expect(row.data).toEqual({ title });
    const revisionAfterCreate = await island.store.readRevision();

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
    expect(replayed.result.operation_id).toBe(createOpId);
    expect(disclosedRow(replayed.result)).toEqual(row);
    expect(replayed.result.records).toEqual(created.result.records);
    expect(await island.store.readRevision()).toBe(revisionAfterCreate);

    // -- read serves the created row ----------------------------------
    const readBack = await invoker.invokeRead({ operation: READ, inputs: {} }, seed.identity);
    if (!("result" in readBack)) throw new Error(`compiled journey: read failed ${JSON.stringify(readBack)}`);
    const found = readRows(readBack.result).find((entry) => entry.id === row.id);
    expect(found?.version).toBe(row.version);
    expect(found?.data).toEqual({ title });

    // -- update --------------------------------------------------------
    const updatedTitle = `${title} v2`;
    const updateOpId = freshOperationId(seed.now);
    const updated = await invoker.invokeMutation(
      {
        operation: UPDATE as OperationName,
        operation_id: updateOpId as OperationId,
        inputs: { record: { id: row.id, version: String(row.version) }, title: updatedTitle },
      },
      seed.identity,
    );
    if (!("result" in updated)) throw new Error(`compiled journey: update failed ${JSON.stringify(updated)}`);
    expect(updated.result.status).toBe("committed");
    expect(updated.result.operation_id).toBe(updateOpId);
    const updatedRow = disclosedRow(updated.result);
    expect(updatedRow.id).toBe(row.id);
    expect(updatedRow.version).toBe(2);
    expect(updatedRow.data).toEqual({ title: updatedTitle });

    const readUpdated = await invoker.invokeRead({ operation: READ, inputs: {} }, seed.identity);
    if (!("result" in readUpdated)) {
      throw new Error(`compiled journey: re-read failed ${JSON.stringify(readUpdated)}`);
    }
    const foundUpdated = readRows(readUpdated.result).find((entry) => entry.id === row.id);
    expect(foundUpdated?.version).toBe(updatedRow.version);
    expect(foundUpdated?.data).toEqual({
      title: updatedTitle,
    });

    // -- delete (archive mode) ------------------------------------------
    const deleteOpId = freshOperationId(seed.now);
    const deleted = await invoker.invokeMutation(
      {
        operation: DELETE as OperationName,
        operation_id: deleteOpId as OperationId,
        inputs: { record: { id: row.id, version: String(updatedRow.version) } },
      },
      seed.identity,
    );
    if (!("result" in deleted)) throw new Error(`compiled journey: delete failed ${JSON.stringify(deleted)}`);
    expect(deleted.result.status).toBe("committed");
    expect(deleted.result.operation_id).toBe(deleteOpId);
    expect(deleted.result.result).toBeNull();
    expect(deleted.result.records).toEqual([]);

    const readDeleted = await invoker.invokeRead({ operation: READ, inputs: {} }, seed.identity);
    if (!("result" in readDeleted)) {
      throw new Error(`compiled journey: post-delete read failed ${JSON.stringify(readDeleted)}`);
    }
    expect(readRows(readDeleted.result).some((entry) => entry.id === row.id)).toBe(false);

    // -- receipts + history via a FRESH handle (persist proof) ----------
    const fresh = island.freshStore();
    const archived = await fresh.load(MODEL as ModelName, row.id as RecordId);
    expect(archived?.version).toBe(3);
    expect(archived?.data).toEqual({ title: updatedTitle });
    expect(typeof archived?.archivedAt).toBe("number");
    for (const [operation, operationId, version] of [
      [CREATE, createOpId, 1],
      [UPDATE, updateOpId, 2],
      [DELETE, deleteOpId, 3],
    ] as const) {
      const receipt = await fresh.readReceipt({
        app: appDefinition.id,
        owner: seed.teamId,
        principal: seed.memberId,
        operation: operation as OperationName,
        operationId: operationId as OperationId,
      });
      expect(receipt, `receipt for ${operation}`).not.toBeNull();
      expect(receipt?.identity).toEqual({ app: appDefinition.id, owner: seed.teamId, principal: seed.memberId,
        operation, operationId });
      expect(receipt?.outcome.status).toBe("committed");
      if (receipt?.outcome.status === "committed") {
        expect(receipt.outcome.recordVersions).toEqual([{ model: MODEL, id: row.id, version }]);
      }
    }
    const trail = await fresh.historyFor(MODEL as ModelName, row.id as RecordId);
    expect(trail.map((entry) => [entry.change, entry.version, entry.operationId])).toEqual([
      ["create", 1, createOpId],
      ["update", 2, updateOpId],
      ["archive", 3, deleteOpId],
    ]);
  });
});
