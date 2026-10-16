/**
 * C2 text-equality toolbar controls (CAN18-v1 C2/C3 rule batch).
 *
 * A `text` filter column renders a free-text input carrying the current
 * exact value (DESIGN 975 scalar + operator table). Text is not
 * finite-choice, so the control offers no option inventory: unlike the
 * enum/bool `<select>`, there are no `<option>` spellings, and unlike
 * the reference opaque entry it submits the raw string instead of an
 * `{id}` identity.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ColumnMeta,
  PresentationContext,
  RowView,
} from "@canlang/contracts";
import { list } from "../src/collections.js";

function makeContext(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    invocation: { request: "req-1" },
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

describe("text filter controls", () => {
  it("renders a free-text input with the current exact value and no options", async () => {
    const filter: readonly ColumnMeta[] = [{ field: "category", type: "text",
      label: "Category", valueLabels: {} }];
    const defaults = { category: "ops" };
    const first: RowView = { id: "todo-1", version: "1", fields: { title: "First", category: "ops" } };
    let queries = 0, preparations = 0;
    const context = makeContext({
      path: "/todos",
      prepareCollectionFilters: (occurrence, fields, actualDefaults) => {
        preparations++;
        assert.equal(occurrence, "todos-list");
        assert.equal(fields, filter);
        assert.equal(actualDefaults, defaults);
        return [{ field: "category", op: "eq", value: "ops" }];
      },
      query: async (invocation, model, args) => {
        queries++;
        assert.equal(invocation, context.invocation);
        assert.equal(model, "TeamTasks.Todo");
        assert.deepEqual(args, { where: { op: "eq", field: "category", value: "ops" },
          occurrence: "todos-list" });
        return { rows: [first], columns: [{ field: "title", label: "Title", type: "text" }, ...filter] };
      },
    });
    const html = await list({ context, model: "TeamTasks.Todo", columns: ["title"], filter, defaults,
      occurrence: "todos-list",
      renderRow: (record: RowView) => [`<p>body-${record.id}</p>`] });
    assert.ok(html.includes("data-can-list-filters"), html);
    assert.ok(html.includes('<input type="text"'), html);
    assert.ok(html.includes('value="ops"'), html);
    assert.ok(!html.includes("<option"), 'text controls offer no option inventory');
    assert.equal(queries, 1); assert.equal(preparations, 1);
  });

  it("escapes the current text value in the control", async () => {
    const filter: readonly ColumnMeta[] = [{ field: "category", type: "text",
      label: "Category", valueLabels: {} }];
    const context = makeContext({
      path: "/todos",
      prepareCollectionFilters: () => [{ field: "category", op: "eq", value: 'a"b<c&d' }],
      query: async () => ({ rows: [{ id: "r1", version: "1", fields: { category: 'a"b<c&d' } }],
        columns: [...filter] }),
    });
    const html = await list({ context, model: "TeamTasks.Todo", columns: [], filter,
      occurrence: "todos-list",
      renderRow: (record: RowView) => [`<p>body-${record.id}</p>`] });
    assert.ok(html.includes('value="a&quot;b&lt;c&amp;d"'), html);
    assert.ok(!html.includes('value="a"b'), html);
  });
});
