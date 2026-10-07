import { describe, expect, it } from "vitest";
import type { ReportValue } from "@canlang/contracts";
import { runTable, type RowScope, type TableRowSpec } from "../src/runner/table.js";

function row(overrides: Partial<TableRowSpec<RowScope>> = {}): TableRowSpec<RowScope> {
  return {
    rowIndex: 0,
    caller: { kind: "self" },
    seed: [],
    setup: async () => {},
    invoke: async () => ({ ok: true }),
    expected: { values: [], observations: [] },
    observe: async () => [],
    ...overrides,
  };
}

describe("owned row scope disposal", () => {
  for (const comparison of ["observations", "rejection state"] as const) {
    for (const thrown of [new Error("comparison failed"), "scalar comparison failure"]) {
      for (const disposalFails of [false, true]) {
        it(`preserves ${typeof thrown} thrown by ${comparison} with disposal failure=${disposalFails}`, async () => {
          const events: string[] = [];
          const value: ReportValue = Object.defineProperty({}, "value", {
            enumerable: true,
            get() {
              events.push("compare");
              throw thrown;
            },
          });
          let snapshots = 0;
          const scope: RowScope = {
            snapshot: async () => {
              snapshots += 1;
              return comparison === "rejection state" && snapshots === 2 ? value : { value: 1 };
            },
            dispose: async () => {
              events.push("dispose");
              if (disposalFails) throw new Error("cleanup failed");
            },
          };
          const spec = row(comparison === "observations" ? {
            expected: { values: [{ value: 1 }], observations: ["value"] },
            observe: async () => [value],
          } : {
            invoke: async () => ({ ok: false, error: "denied" }),
            expected: { error: "denied" },
          });
          await expect(runTable({
            operation: "owned-scope",
            createScope: async () => scope,
            rows: [spec, row({ rowIndex: 1, setup: async () => { events.push("next-row"); } })],
          })).rejects.toBe(thrown);
          expect(events).toEqual(["compare", "dispose"]);
        });
      }
    }
  }

  for (const disposalFails of [false, true]) {
    it(`retains invocation failure reporting with disposal failure=${disposalFails}`, async () => {
      let disposals = 0;
      const result = await runTable({
        operation: "owned-scope",
        createScope: async () => ({
          snapshot: async () => null,
          dispose: async () => {
            disposals += 1;
            if (disposalFails) throw new Error("cleanup failed");
          },
        }),
        rows: [row({ invoke: async () => { throw new Error("invocation failed"); } })],
      });
      expect(disposals).toBe(1);
      expect(result.rows[0]?.outcome).toBe("failed");
      expect(result.rows[0]?.detail).toBe(disposalFails
        ? "scope disposal failed, isolation unproven: cleanup failed (row was failed: unexpected invocation failure: invocation failed)"
        : "unexpected invocation failure: invocation failed");
    });
  }

  it("reports creation failure without disposing an unowned scope", async () => {
    let setups = 0;
    const result = await runTable({
      operation: "owned-scope",
      createScope: async () => { throw new Error("creation failed"); },
      rows: [row({ setup: async () => { setups += 1; } })],
    });
    expect(setups).toBe(0);
    expect(result.rows[0]?.outcome).toBe("setup-failed");
    expect(result.rows[0]?.detail).toBe("scope creation failed: creation failed");
  });

  it("rejects duplicate rows before creating any scope", async () => {
    let creations = 0;
    await expect(runTable({
      operation: "owned-scope",
      createScope: async () => {
        creations += 1;
        return { snapshot: async () => null, dispose: async () => {} };
      },
      rows: [row(), row()],
    })).rejects.toThrow("duplicate rowIndex 0 in table owned-scope");
    expect(creations).toBe(0);
  });
});
