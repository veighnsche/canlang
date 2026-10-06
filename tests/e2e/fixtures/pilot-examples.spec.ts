/**
 * Pilot examples runner spec (page-less, engine-free): `PilotExamples`
 * provisions fixture values into live records (MutationRef substitution
 * via stashed baselines), establishes server-owned fields through fenced
 * commits with version-carrying refs, and observes live rows — all
 * against doubles. Needs built dists (`@canlang/testkit`); the genuine
 * live run rides the pilot go-ahead with the T02 blockers cleared.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import type {
  CompileArtifact,
  ModelName,
  MutationEnvelope,
  OperationId,
  RecordId,
  RecordVersion,
  ResolvedIdentity,
  Revision,
  StoragePort,
  StoredRow,
} from "@canlang/contracts";
import type { OperationInvoker } from "../../../packages/cloudflare/src/worker/assembly.js";
import { PilotExamples } from "./pilot-examples.js";

const SUITE_MODULE = `const test_worker = { model: "employee.Employee", dependencies: [], value: async (c, s) => ({ role: "operator" }) };
const open_task = { model: "todo.Task", dependencies: [], value: async (c, s) => ({ title: "Opening checks", assignee: c.self, done: false }) };
export function exampleFixtures({ self, other, imported }) {
  void self; void other; void imported;
  return {
    fixtures: { test_worker, open_task },
    examples: [{
      operation: "todo.complete",
      dependencies: [test_worker, open_task],
      inputs: async (c, s) => ({ task: s.open_task }),
      selectors: ["task.done"],
      observations: [async (c, s) => s.open_task.done, async (c, s) => s.open_task.completed_by],
      rows: [
        { dependencies: [], values: async (c, s) => [s.open_task.done], expected: async (c, s) => [true, c.self] },
        { dependencies: [], values: async (c, s) => [true], error: "rule_failed" },
      ],
    }],
  };
}
`;

const ARTIFACT = {
  operations: [
    {
      name: "todo.complete",
      kind: "scenario",
      description: "",
      inputs: { fields: [{ name: "task", field: { kind: "ref", model: "todo.Task" }, required: true }] },
    },
    {
      name: "todo.Task.create",
      kind: "create",
      description: "",
      inputs: {
        fields: [
          { name: "title", field: { kind: "string" }, required: true },
          { name: "assignee", field: { kind: "user" }, required: false },
        ],
      },
    },
  ],
} as unknown as CompileArtifact;

interface Doubles {
  readonly invoker: OperationInvoker;
  readonly store: StoragePort;
  readonly calls: MutationEnvelope[];
}

function makeDoubles(): Doubles {
  const rows = new Map<string, StoredRow>();
  let revision = 0;
  let next = 0;
  const calls: MutationEnvelope[] = [];
  const store = {
    async load(model: ModelName, id: RecordId): Promise<StoredRow | null> {
      return rows.get(`${model}:${id}`) ?? null;
    },
    async readRevision(): Promise<Revision> {
      return revision as Revision;
    },
    async commit(batch: {
      expectedRevision: number;
      writes: Array<
        | { kind: "insert"; model: ModelName; row: StoredRow }
        | { kind: "update"; model: ModelName; id: RecordId; expectedVersion: number; row: StoredRow }
      >;
    }): Promise<unknown> {
      if (batch.expectedRevision !== revision) throw new Error("revision fence");
      for (const write of batch.writes) {
        if (write.kind === "insert") {
          rows.set(`${write.model}:${write.row.id}`, { ...write.row });
        } else {
          const current = rows.get(`${write.model}:${write.id}`);
          if (current === undefined || current.version !== write.expectedVersion) {
            throw new Error("version fence");
          }
          rows.set(`${write.model}:${write.id}`, { ...write.row });
        }
      }
      revision += 1;
      return {};
    },
  } as unknown as StoragePort;
  const invoker = {
    async invokeMutation(envelope: MutationEnvelope) {
      calls.push(envelope);
      if (envelope.operation === "todo.Task.create") {
        next += 1;
        const id = `t${next}`;
        const row: StoredRow = {
          id: id as RecordId,
          version: 1 as RecordVersion,
          created: 0,
          updated: 0,
          createdBy: "doubles",
          updatedBy: "doubles",
          archivedAt: null,
          data: { done: false, ...(envelope.inputs as Record<string, unknown>) },
        };
        rows.set(`todo.Task:${id}`, row);
        revision += 1;
        return {
          result: {
            status: "committed",
            operation_id: envelope.operation_id,
            result: { id, version: 1, data: row.data },
          },
        };
      }
      if (envelope.operation === "todo.complete") {
        const ref = (envelope.inputs as Record<string, unknown>)["task"] as { id: string; version: string };
        const row = rows.get(`todo.Task:${ref.id}`);
        if (row === undefined || String(row.version) !== String(ref.version)) {
          return { error: { code: "conflict" } };
        }
        if ((row.data as Record<string, unknown>)["done"] === true) {
          return { error: { code: "rule_failed" } };
        }
        const nextRow: StoredRow = {
          ...row,
          version: (row.version + 1) as RecordVersion,
          data: {
            ...(row.data as Record<string, unknown>),
            done: true,
            completed_by: { kind: "user", id: "u-member" },
          },
        };
        rows.set(`todo.Task:${ref.id}`, nextRow);
        revision += 1;
        return {
          result: {
            status: "committed",
            operation_id: envelope.operation_id,
            result: { id: ref.id, version: nextRow.version, data: nextRow.data },
          },
        };
      }
      throw new Error(`unexpected operation ${envelope.operation}`);
    },
    async invokeRead() {
      throw new Error("no reads in doubles");
    },
  } as unknown as OperationInvoker;
  return { invoker, store, calls };
}

test("provisions fixtures live with baseline matching and establishment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilot-examples-spec-"));
  const file = join(dir, "suite.mjs");
  await writeFile(file, SUITE_MODULE);
  const { invoker, store, calls } = makeDoubles();
  let op = 0;
  const runner = new PilotExamples({
    artifact: ARTIFACT,
    invoker,
    store,
    caller: { actor: { user_id: "u-member" } } as unknown as ResolvedIdentity,
    userId: "u-member",
    now: () => 0,
    operationId: () => `op-${++op}` as OperationId,
  });
  const report = await runner.runSuite(pathToFileURL(file).href, "todo.complete");
  expect(report.rows.map((row) => row.outcome)).toEqual(["passed", "passed"]);
  expect(report.rows[1]?.rejection).toEqual({ error: "rule_failed", sideEffectsAbsent: true });

  const creates = calls.filter((call) => call.operation === "todo.Task.create");
  const completes = calls.filter((call) => call.operation === "todo.complete");
  expect(creates).toHaveLength(2);
  // Tagged user refs pass through verbatim (canonical stored form);
  // server-owned `done` never reaches the create.
  expect(creates[0]?.inputs).toEqual({
    title: "Opening checks",
    assignee: { kind: "user", id: "u-member" },
  });
  expect(completes[0]?.inputs).toEqual({ task: { id: "t1", version: "2" } });
  expect(completes[1]?.inputs).toEqual({ task: { id: "t2", version: "2" } });
});
