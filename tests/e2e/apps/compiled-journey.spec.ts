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
  OperationId,
  OperationName,
  RecordId,
} from "@canlang/contracts";
import { COMPILED_JOURNEY_SOURCE, compiledTest as test } from "../fixtures/e2e-test.js";
import { COMPILED_LABEL_PREFIX, createCompiledInvoker } from "../fixtures/artifact-loader.js";
import { changedRow, freshOperationId, seedCompiledMember } from "../fixtures/compiled-seed.js";

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
      "Store.CurrentView.read",
      CREATE,
      UPDATE,
      DELETE,
      "Store.CurrentView.create",
      "Store.CurrentView.update",
      "Store.CurrentView.delete",
    ]);
    expect(compiled.artifact.models?.map((model) => model.name)).toEqual(["Lobby.Notice", MODEL, "Store.CurrentView"]);
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
    const row = changedRow(created.result);
    expect(row.id).toBe(createOpId);
    expect(row.version).toBe(1);
    expect(row.data).toEqual({ title });
    const createReceiptIdentity = {
      app: appDefinition.id, owner: seed.teamId, principal: seed.memberId,
      operation: CREATE as OperationName, operationId: createOpId as OperationId,
    };
    const createRevision = await island.store.readRevision();
    const savedCreate = await island.store.readReceipt(createReceiptIdentity);
    const savedRow = await island.store.load(MODEL as ModelName, row.id as RecordId);
    const createHistory = await island.store.historyFor(MODEL as ModelName, row.id as RecordId);
    expect(savedCreate?.outcome.status).toBe("committed");

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
    expect(changedRow(replayed.result)).toEqual(row);
    expect(replayed.result.records).toEqual(created.result.records);
    expect(await island.store.readRevision()).toBe(createRevision);
    expect(await island.store.load(MODEL as ModelName, row.id as RecordId)).toEqual(savedRow);
    expect(await island.store.historyFor(MODEL as ModelName, row.id as RecordId)).toEqual(createHistory);
    expect(await island.store.readReceipt(createReceiptIdentity)).toEqual(savedCreate);

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
    const updatedRow = changedRow(updated.result);
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
        inputs: { record: { id: updatedRow.id, version: String(updatedRow.version) } },
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
    expect(await fresh.readReceipt(createReceiptIdentity)).toEqual(savedCreate);
    const archived = await fresh.load(MODEL as ModelName, row.id as RecordId);
    expect(archived?.version).toBe(3);
    expect(archived?.archivedAt).toBe(seed.now);
    expect(archived?.data).toEqual({ title: updatedTitle });
    const trail = await fresh.historyFor(MODEL as ModelName, row.id as RecordId);
    expect(trail.map((entry) => [entry.change, entry.version, entry.operationId])).toEqual([
      ["create", 1, createOpId],
      ["update", 2, updateOpId],
      ["archive", 3, deleteOpId],
    ]);
  });

  test("conditional user keys reject duplicate current rows and release inactive claims in D1", async ({ compiled, island }) => {
    const seed = await seedCompiledMember();
    const invoker = await createCompiledInvoker(compiled, island.store, {
      memberships: seed.store,
      now: () => seed.now,
    });
    const model = "Store.CurrentView" as ModelName;
    const create = (account: unknown, current: boolean) => invoker.invokeMutation({
      operation: "Store.CurrentView.create" as OperationName,
      operation_id: freshOperationId(seed.now) as OperationId,
      inputs: { account, current },
    }, seed.identity);
    const first = await create({ id: seed.memberId }, true);
    if (!("result" in first)) throw new Error(`conditional unique: initial create failed ${JSON.stringify(first)}`);
    const current = changedRow(first.result);
    const saved = await island.store.load(model, current.id as RecordId);
    const history = await island.store.historyFor(model, current.id as RecordId);

    const duplicate = await create({ id: seed.memberId }, true);
    expect(duplicate).toMatchObject({ error: { code: "conflict" } });
    // User identity is the canonical opaque wire, not an arbitrary string or
    // a versioned model reference with the same id.
    for (const invalid of [seed.memberId, { id: seed.memberId, version: "1" }]) {
      expect(await create(invalid, false)).toMatchObject({ error: { code: "validation" } });
    }
    expect(await island.store.load(model, current.id as RecordId)).toEqual(saved);
    expect(await island.store.historyFor(model, current.id as RecordId)).toEqual(history);

    const inactive = await create({ id: seed.memberId }, false);
    if (!("result" in inactive)) throw new Error(`conditional unique: inactive row failed ${JSON.stringify(inactive)}`);
    expect(inactive.result.status).toBe("committed");
    const deactivated = await invoker.invokeMutation({
      operation: "Store.CurrentView.update" as OperationName,
      operation_id: freshOperationId(seed.now) as OperationId,
      inputs: { record: { id: current.id, version: String(current.version) }, current: false },
    }, seed.identity);
    if (!("result" in deactivated)) throw new Error(`conditional unique: release failed ${JSON.stringify(deactivated)}`);
    expect(deactivated.result.status).toBe("committed");
    const replacement = await create({ id: seed.memberId }, true);
    if (!("result" in replacement)) throw new Error(`conditional unique: replacement failed ${JSON.stringify(replacement)}`);
    expect(replacement.result.status).toBe("committed");

    const fresh = island.freshStore();
    expect((await fresh.load(model, current.id as RecordId))?.data["current"]).toBe(false);
    expect((await fresh.load(model, changedRow(inactive.result).id as RecordId))?.data["current"]).toBe(false);
    expect((await fresh.load(model, changedRow(replacement.result).id as RecordId))?.data["current"]).toBe(true);
  });

});
