/**
 * CAN18-v1 B20: bound timeline collection contract (CanCRM:374,
 * CanExpense:416/421, CanStock:266).
 *
 * A bound `timeline row.Sequence` emits collection query props
 * (model/parent/order/page/occurrence + renderRow), never prebuilt items.
 * The real factory serves them here: source query rows drive the item
 * template once per admitted row, preserving parent scope, row order, the
 * shared empty state, failure propagation, and page cursor binding. No
 * handwritten items array stands in for the query path.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  PresentationContext,
  RowView,
} from "@canlang/contracts";
import { timeline } from "../src/groups.js";

function makeContext(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    invocation: null,
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

/** Test query double: parent scoping, signed order, and page passthrough. */
type StubRow = RowView & { parent?: string };

function makeQuery(rows: StubRow[]) {
  const calls: { model: string; args: Record<string, unknown> }[] = [];
  const query = async (invocation: unknown, model: string, args: Record<string, unknown>) => {
    calls.push({ model, args });
    const parent = args.parent as { id: string } | undefined;
    let out = rows.filter((row) => {
      const rowParent = row.parent;
      return parent === undefined || rowParent === parent.id;
    });
    const order = args.order as readonly string[] | undefined;
    if (order !== undefined) {
      for (const term of [...order].reverse()) {
        const descending = term.startsWith("-");
        const field = descending ? term.slice(1) : term;
        out = [...out].sort((a, b) => {
          const av = a.fields[field] as unknown;
          const bv = b.fields[field] as unknown;
          const compared = av! < bv! ? -1 : av! > bv! ? 1 : 0;
          return descending ? -compared : compared;
        });
      }
    }
    return { rows: out, columns: [], nextCursor: undefined };
  };
  return { query, calls };
}

describe("timeline collection", () => {
  it("renders one entry per parent-scoped row in authored order", async () => {
    const rows: StubRow[] = [
      { id: "m2", fields: { quantity: 1, reason: "Second" }, parent: "acc-1" } as StubRow,
      { id: "m1", fields: { quantity: 5, reason: "First" }, parent: "acc-1" } as StubRow,
      { id: "m9", fields: { quantity: 9, reason: "Foreign" }, parent: "acc-2" } as StubRow,
    ];
    const { query, calls } = makeQuery(rows);
    const html = await timeline({
      context: makeContext({ query: query as never }),
      model: "Probe.Movement",
      parent: { id: "acc-1" },
      order: ["-quantity"],
      renderRow: async (row) => [`<span>${String(row.fields.reason)}:${String(row.fields.quantity)}</span>`],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.model, "Probe.Movement");
    assert.deepEqual((calls[0]!.args.parent as { id: string }).id, "acc-1");
    assert.deepEqual(calls[0]!.args.order, ["-quantity"]);
    assert.ok(html.startsWith(`<ul class="timeline">`), html);
    assert.ok(html.includes(`<div class="timeline-end"><span>First:5</span></div>`), html);
    assert.ok(html.includes(`<div class="timeline-end"><span>Second:1</span></div>`), html);
    assert.ok(html.indexOf("First:5") < html.indexOf("Second:1"), html);
    assert.ok(!html.includes("Foreign"), html);
  });

  it("renders the shared empty state when no rows are admitted", async () => {
    const { query } = makeQuery([]);
    const html = await timeline({
      context: makeContext({ query: query as never }),
      model: "Probe.Movement",
      renderRow: async () => ["unreached"],
    });
    assert.match(html, /[Nn]o records/);
  });

  it("binds the page cursor from the occurrence and links the next page", async () => {
    const seen: Record<string, unknown>[] = [];
    const query = (async (_invocation: unknown, _model: string, args: Record<string, unknown>) => {
      seen.push(args);
      return { rows: [{ id: "d1", fields: {} }], columns: [], nextCursor: "cur-2" };
    }) as never;
    const html = await timeline({
      context: makeContext({ query, pollUrl: "/expenses?can-cursor%3Aocc-1=cur-1" }),
      model: "Probe.Decision",
      page: true,
      occurrence: "occ-1",
      renderRow: async (row) => [`<span>${row.id}</span>`],
    });
    assert.equal(seen[0]!["cursor"], "cur-1");
    assert.equal(seen[0]!["page"], true);
    assert.equal(seen[0]!["occurrence"], "occ-1");
    assert.ok(html.includes("d1"), html);
    assert.ok(html.includes('rel="next"'), html);
    assert.ok(html.includes("cur-2"), html);
  });

  it("propagates row-body failures instead of rendering placeholders", async () => {
    const { query } = makeQuery([{ id: "m1", fields: {} }]);
    await assert.rejects(() =>
      timeline({
        context: makeContext({ query: query as never }),
        model: "Probe.Movement",
        renderRow: async () => {
          throw new Error("body boom");
        },
      }),
      /body boom/,
    );
  });

  it("propagates query failures such as revoked sessions", async () => {
    const query = (async () => {
      throw Object.assign(new Error("forbidden"), { code: "forbidden" });
    }) as never;
    await assert.rejects(() =>
      timeline({
        context: makeContext({ query }),
        model: "Probe.Movement",
        renderRow: async () => ["unreached"],
      }),
      /forbidden/,
    );
  });

  it("refuses combined items with model and sequences without renderRow", async () => {
    const { query } = makeQuery([]);
    await assert.rejects(() =>
      timeline({
        context: makeContext({ query: query as never }),
        model: "Probe.Movement",
        items: [{ end: "x" }],
        renderRow: async () => ["x"],
      }),
    );
    await assert.rejects(() =>
      timeline({
        context: makeContext({ query: query as never }),
        model: "Probe.Movement",
      } as never),
    );
  });
});
