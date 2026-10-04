import { describe, expect, it } from "vitest";
import type { ReportValue } from "@canlang/contracts";
import {
  runTable,
  unsupportedInvoker,
  type CallOutcome,
  type RowScope,
  type TableRowSpec,
} from "../src/runner/table.js";

/** TEST-ONLY in-memory scope. Exercises runner classification, not storage. */
class MemoryScope implements RowScope {
  state = new Map<string, ReportValue>();
  disposed = false;

  async snapshot(): Promise<ReportValue> {
    return Object.fromEntries([...this.state.entries()].sort());
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function row(
  partial: Partial<TableRowSpec<MemoryScope>> & { rowIndex: number },
): TableRowSpec<MemoryScope> {
  return {
    caller: { kind: "self" },
    seed: [],
    setup: async () => {},
    invoke: async () => ({ ok: true }) as CallOutcome,
    expected: { values: [], observations: [] },
    observe: async () => [],
    ...partial,
  };
}

describe("runTable classification", () => {
  it("passes matching values and expected rejections with clean snapshots", async () => {
    const result = await runTable({
      operation: "Todo.update",
      createScope: async () => new MemoryScope(),
      rows: [
        row({
          rowIndex: 0,
          setup: async (scope) => {
            scope.state.set("done", false);
          },
          invoke: async (scope) => {
            scope.state.set("done", true);
            return { ok: true };
          },
          expected: { values: [true], observations: ["record.done"] },
          observe: async (scope) => [scope.state.get("done") ?? null],
        }),
        row({
          rowIndex: 1,
          caller: { kind: "public" },
          invoke: async () => ({ ok: false, error: "forbidden" }),
          expected: { error: "forbidden" },
        }),
      ],
    });
    expect(result.rows.map((entry) => entry.outcome)).toEqual(["passed", "passed"]);
    expect(result.rows[1]?.rejection).toEqual({ error: "forbidden", sideEffectsAbsent: true });
  });

  it("never lets setup failures satisfy expected rejections", async () => {
    const result = await runTable({
      operation: "Todo.update",
      createScope: async () => new MemoryScope(),
      rows: [
        row({
          rowIndex: 0,
          setup: async () => {
            throw new Error("invalid fixture");
          },
          expected: { error: "forbidden" },
        }),
      ],
    });
    expect(result.rows[0]?.outcome).toBe("setup-failed");
    expect(result.rows[0]?.rejection).toBeUndefined();
  });

  it("fails mismatches, wrong codes, leaked writes, and surprises", async () => {
    const result = await runTable({
      operation: "Todo.update",
      createScope: async () => new MemoryScope(),
      rows: [
        row({
          rowIndex: 0,
          expected: { values: [true], observations: ["record.done"] },
          observe: async () => [false],
        }),
        row({
          rowIndex: 1,
          invoke: async () => ({ ok: false, error: "forbidden" }),
          expected: { error: "conflict" },
        }),
        row({
          rowIndex: 2,
          invoke: async (scope) => {
            scope.state.set("leaked", 1);
            return { ok: false, error: "forbidden" };
          },
          expected: { error: "forbidden" },
        }),
        row({
          rowIndex: 3,
          invoke: async () => {
            throw new Error("boom");
          },
          expected: { error: "forbidden" },
        }),
        row({
          rowIndex: 4,
          expected: { error: "forbidden" },
        }),
      ],
    });
    expect(result.rows.map((entry) => entry.outcome)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(result.rows[0]?.mismatches).toEqual([
      { observation: "record.done", expected: true, actual: false },
    ]);
    expect(result.rows[2]?.rejection?.sideEffectsAbsent).toBe(false);
  });

  it("reports unsupported paths as unsupported", async () => {
    const result = await runTable({
      operation: "Todo.update",
      createScope: async () => new MemoryScope(),
      rows: [row({ rowIndex: 0, invoke: unsupportedInvoker, expected: { error: "forbidden" } })],
    });
    expect(result.rows[0]?.outcome).toBe("unsupported");
  });

  it("creates and disposes one scope per row", async () => {
    const scopes: MemoryScope[] = [];
    await runTable({
      operation: "Todo.update",
      createScope: async () => {
        const scope = new MemoryScope();
        scopes.push(scope);
        return scope;
      },
      rows: [row({ rowIndex: 0 }), row({ rowIndex: 1 })],
    });
    expect(scopes).toHaveLength(2);
    expect(scopes[0]).not.toBe(scopes[1]);
    expect(scopes.every((scope) => scope.disposed)).toBe(true);
  });
});
