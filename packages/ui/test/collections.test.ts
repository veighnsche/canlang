import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  CollectionControls,
  ColumnMeta,
  FilterCondition,
  ListQueryArgs,
  ListQueryResult,
  OrderSelector,
  PresentationContext,
  RowQueryRunner,
  RowView,
} from "@canlang/contracts";
import {
  board,
  collectionExportLink,
  collectionPagination,
  collectionPrintLink,
  collectionShareControls,
  collectionToolbar,
  controlHref,
  csvImport,
  list,
  table,
} from "../src/collections.js";
import { renderState, rowHeading } from "../src/components.js";
import { escapeAttr, isolate } from "../src/escape.js";
import { message } from "../src/messages.js";
import { loadHtml } from "./harness.js";

interface SeenCall {
  readonly invocation: unknown;
  readonly model: string;
  readonly args: ListQueryArgs;
}

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

function stubRunner(seen: SeenCall[], result: ListQueryResult | Error): RowQueryRunner {
  return async (invocation, model, args) => {
    seen.push({ invocation, model, args });
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };
}

function row(id: string, fields: Record<string, unknown> = {}): RowView {
  return { id, fields };
}

async function rejectsWith(fn: () => Promise<unknown>, ...needles: string[]): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
    for (const needle of needles) {
      assert.ok(
        error.message.includes(needle),
        `expected ${JSON.stringify(error.message)} to include ${JSON.stringify(needle)}`,
      );
    }
    return;
  }
  assert.fail("expected rejection, but the call succeeded");
}

describe("list", () => {
  it("renders one item per row inside ul.list", async () => {
    const seen: SeenCall[] = [];
    const context = makeContext({
      query: stubRunner(seen, {
        rows: [row("a", { title: "A" }), row("b", { title: "B" })],
        columns: [],
      }),
    });
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: (item) => [`<span>${item.id}</span>`],
    });
    assert.ok(html.startsWith("<ul class=\"list\">"));
    assert.ok(html.includes("<li class=\"list-row\"><span>a</span></li>"));
    assert.ok(html.includes("<li class=\"list-row\"><span>b</span></li>"));
    assert.equal(html.match(/<li class="list-row">/g)?.length, 2);
  });

  it("passes the context object through as the renderRow view", async () => {
    const seen: SeenCall[] = [];
    const context = makeContext({
      query: stubRunner(seen, { rows: [row("a"), row("b")], columns: [] }),
    });
    const views: PresentationContext[] = [];
    await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: (item, view) => {
        views.push(view);
        return [item.id];
      },
    });
    assert.equal(views.length, 2);
    assert.strictEqual(views[0], context);
    assert.strictEqual(views[1], context);
  });

  it("joins thunk and promise children", async () => {
    const seen: SeenCall[] = [];
    const context = makeContext({
      query: stubRunner(seen, { rows: [row("a")], columns: [] }),
    });
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: () => () => ["<b>", Promise.resolve("x</b>")],
    });
    assert.ok(html.includes("<li class=\"list-row\"><b>x</b></li>"));
  });

  it("awaits each row renderer once and resolves its children before the next row", async () => {
    const seen: SeenCall[] = [];
    const context = makeContext({
      query: stubRunner(seen, { rows: [row("a"), row("b")], columns: [] }),
    });
    const events: string[] = [];
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: async (item) => {
        events.push(`render:${item.id}`);
        await Promise.resolve();
        events.push(`ready:${item.id}`);
        return () => {
          events.push(`children:${item.id}`);
          return [Promise.resolve().then(() => {
            events.push(`resolved:${item.id}`);
            return `<span>${item.id}</span>`;
          })];
        };
      },
    });
    assert.deepEqual(events, [
      "render:a", "ready:a", "children:a", "resolved:a",
      "render:b", "ready:b", "children:b", "resolved:b",
    ]);
    assert.equal(html, '<ul class="list"><li class="list-row"><span>a</span></li><li class="list-row"><span>b</span></li></ul>');
  });

  it("renders the empty state when rows are empty", async () => {
    const seen: SeenCall[] = [];
    const empty = message("Nothing here", { nl: "Niets hier" });
    const context = makeContext({
      query: stubRunner(seen, { rows: [], columns: [] }),
    });
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty,
      renderRow: () => ["unused"],
    });
    assert.equal(html, await renderState({ context, kind: "empty", message: empty }));
    assert.equal(seen.length, 1);
  });

  it("passes S3 args through and omits undefined optionals", async () => {
    const seen: SeenCall[] = [];
    const where = { status: "open" };
    const context = makeContext({
      query: stubRunner(seen, { rows: [row("a")], columns: [] }),
    });
    await list({
      context,
      model: "TeamTasks.Todo",
      parent: { id: "p-1" },
      where,
      limit: 10,
      cursor: "c-1",
      page: true,
      occurrence: "page:/todos/list:1",
      empty: "No todos",
      renderRow: () => [],
    });
    assert.deepEqual(seen[0]?.args, {
      parent: { id: "p-1" },
      where,
      limit: 10,
      cursor: "c-1",
      page: true,
      occurrence: "page:/todos/list:1",
    });
    await list({ context, model: "TeamTasks.Todo", empty: "No todos", renderRow: () => [] });
    assert.deepEqual(seen[1]?.args, {});
  });

  it("passes invocation and model through to the runner", async () => {
    const seen: SeenCall[] = [];
    const invocation = { request: "req-9" };
    const context = makeContext({
      invocation,
      query: stubRunner(seen, { rows: [], columns: [] }),
    });
    await list({ context, model: "TeamTasks.Todo", empty: "No todos", renderRow: () => [] });
    assert.strictEqual(seen[0]?.invocation, invocation);
    assert.equal(seen[0]?.model, "TeamTasks.Todo");
  });

  it("appends a more-note after the list when nextCursor is present", async () => {
    const seen: SeenCall[] = [];
    const context = makeContext({
      query: stubRunner(seen, { rows: [row("a")], columns: [], nextCursor: "next-1" }),
    });
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: (item) => [item.id],
    });
    assert.ok(html.includes("<p class=\"can-more\" data-cursor=\"next-1\">More rows available.</p>"));
    assert.ok(html.indexOf("</ul>") < html.indexOf("can-more"));
  });

  it("localizes the more-note", async () => {
    const seen: SeenCall[] = [];
    const context = makeContext({
      preferredLocales: ["nl"],
      query: stubRunner(seen, { rows: [row("a")], columns: [], nextCursor: "next-1" }),
    });
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: () => [],
    });
    assert.ok(html.includes(">Meer rijen beschikbaar.</p>"));
  });

  it("omits the more-note without nextCursor", async () => {
    const seen: SeenCall[] = [];
    const context = makeContext({
      query: stubRunner(seen, { rows: [row("a")], columns: [] }),
    });
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: () => [],
    });
    assert.ok(!html.includes("can-more"));
  });

  it("propagates query failures untouched", async () => {
    const seen: SeenCall[] = [];
    const failure = new Error("records() down");
    const context = makeContext({ query: stubRunner(seen, failure) });
    try {
      await list({ context, model: "TeamTasks.Todo", empty: "No todos", renderRow: () => [] });
    } catch (error) {
      assert.strictEqual(error, failure);
      return;
    }
    assert.fail("expected the query failure to propagate");
  });

  it("escapes the cursor in the more-note", async () => {
    const cursor = '"><img src=x onerror=alert(1)>';
    const seen: SeenCall[] = [];
    const context = makeContext({
      query: stubRunner(seen, { rows: [row("a")], columns: [], nextCursor: cursor }),
    });
    const html = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: () => [],
    });
    assert.ok(!html.includes(cursor));
    assert.ok(html.includes(`data-cursor="${escapeAttr(cursor)}"`));
  });
});

describe("table", () => {
  const titleCol: ColumnMeta = { field: "title", label: "Title", type: "text" };
  const countCol: ColumnMeta = { field: "count", label: "Count", type: "int" };

  function tableContext(
    seen: SeenCall[],
    result: ListQueryResult,
    overrides: Partial<PresentationContext> = {},
  ): PresentationContext {
    return makeContext({ query: stubRunner(seen, result), ...overrides });
  }

  it("renders head labels and scalar cells", async () => {
    const seen: SeenCall[] = [];
    const context = tableContext(seen, {
      rows: [row("a", { title: "Buy milk", count: 1234567 })],
      columns: [titleCol, countCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title", "count"], empty: "No todos" });
    assert.ok(html.startsWith("<table class=\"table\">"));
    assert.ok(html.includes("<thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Count</th></tr></thead>"));
    assert.ok(
      html.includes(
        `<tbody><tr><td>${isolate("Buy milk")}</td><td>${isolate("1,234,567")}</td></tr></tbody>`,
      ),
    );
  });

  it("resolves descriptor labels per viewer locale", async () => {
    const seen: SeenCall[] = [];
    const labelCol: ColumnMeta = {
      field: "title",
      label: message("Title", { nl: "Titel" }),
      type: "text",
    };
    const result: ListQueryResult = { rows: [row("a", { title: "x" })], columns: [labelCol] };
    const en = await table({
      context: tableContext(seen, result),
      model: "TeamTasks.Todo",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(en.includes("<th scope=\"col\">Title</th>"));
    const nl = await table({
      context: tableContext(seen, result, { preferredLocales: ["nl"] }),
      model: "TeamTasks.Todo",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(nl.includes("<th scope=\"col\">Titel</th>"));
  });

  it("renders bool badges from valueLabels", async () => {
    const seen: SeenCall[] = [];
    const doneCol: ColumnMeta = {
      field: "done",
      label: "Done",
      type: "bool",
      valueLabels: { true: message("Yes", { nl: "Ja" }), false: message("No", { nl: "Nee" }) },
    };
    const result: ListQueryResult = {
      rows: [row("a", { done: true }), row("b", { done: false })],
      columns: [doneCol],
    };
    const en = await table({
      context: tableContext(seen, result),
      model: "TeamTasks.Todo",
      columns: ["done"],
      empty: "No todos",
    });
    assert.ok(en.includes('<span class="badge">Yes</span>'));
    assert.ok(en.includes('<span class="badge">No</span>'));
    const nl = await table({
      context: tableContext(seen, result, { preferredLocales: ["nl"] }),
      model: "TeamTasks.Todo",
      columns: ["done"],
      empty: "No todos",
    });
    assert.ok(nl.includes('<span class="badge">Ja</span>'));
    assert.ok(nl.includes('<span class="badge">Nee</span>'));
  });

  it("renders bool badges as raw keys without valueLabels", async () => {
    const seen: SeenCall[] = [];
    const doneCol: ColumnMeta = { field: "done", label: "Done", type: "bool" };
    const context = tableContext(seen, {
      rows: [row("a", { done: false }), row("b", { done: true })],
      columns: [doneCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["done"], empty: "No todos" });
    assert.ok(html.includes('<span class="badge">false</span>'));
    assert.ok(html.includes('<span class="badge">true</span>'));
  });

  it("renders enum badges from valueLabels", async () => {
    const seen: SeenCall[] = [];
    const stateCol: ColumnMeta = {
      field: "state",
      label: "State",
      type: "enum",
      valueLabels: { open: message("Open", { nl: "Open-nl" }) },
    };
    const context = tableContext(seen, {
      rows: [row("a", { state: "open" })],
      columns: [stateCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["state"], empty: "No todos" });
    assert.ok(html.includes('<span class="badge">Open</span>'));
  });

  it("renders dotted enum ids as raw keys without valueLabels", async () => {
    const seen: SeenCall[] = [];
    const stateCol: ColumnMeta = { field: "state", label: "State", type: "expense.Expense.status" };
    const context = tableContext(seen, {
      rows: [row("a", { state: "archived" })],
      columns: [stateCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["state"], empty: "No todos" });
    assert.ok(html.includes('<span class="badge">archived</span>'));
  });

  it("throws naming the model and every missing column", async () => {
    const seen: SeenCall[] = [];
    const context = tableContext(seen, {
      rows: [row("a", { title: "x" })],
      columns: [titleCol],
    });
    await rejectsWith(
      () =>
        table({
          context,
          model: "TeamTasks.Todo",
          columns: ["title", "nope", "missing-too"],
          empty: "No todos",
        }),
      "TeamTasks.Todo",
      "nope",
      "missing-too",
    );
  });

  it("throws on missing columns even when rows are empty", async () => {
    const seen: SeenCall[] = [];
    const context = tableContext(seen, { rows: [], columns: [titleCol] });
    await rejectsWith(
      () =>
        table({ context, model: "TeamTasks.Todo", columns: ["gone"], empty: "No todos" }),
      "TeamTasks.Todo",
      "gone",
    );
  });

  it("renders the empty state when rows are empty", async () => {
    const seen: SeenCall[] = [];
    const empty = message("Nothing here", { nl: "Niets hier" });
    const context = tableContext(seen, { rows: [], columns: [titleCol] });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty });
    assert.equal(html, await renderState({ context, kind: "empty", message: empty }));
  });

  it("escapes cell text", async () => {
    const seen: SeenCall[] = [];
    const payload = "<script>alert(\"x\")</script>";
    const context = tableContext(seen, {
      rows: [row("a", { title: payload })],
      columns: [titleCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos" });
    assert.ok(!html.includes(payload));
    assert.ok(html.includes(`<td>${isolate("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")}</td>`));
  });

  it("isolates cell text with explicit bidi marks", async () => {
    const titleCol: ColumnMeta = { field: "title", label: message("Title"), type: "text" };
    const seen: SeenCall[] = [];
    const context = tableContext(seen, {
      rows: [row("a", { title: "Buy milk" })],
      columns: [titleCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos" });
    // Pinned with escapes, not via the isolate() helper under test.
    assert.ok(html.includes("<td>\u2068Buy milk\u2069</td>"));
  });

  it("escapes labels", async () => {
    const seen: SeenCall[] = [];
    const evilCol: ColumnMeta = { field: "title", label: "<b>Hi</b>", type: "text" };
    const context = tableContext(seen, {
      rows: [row("a", { title: "x" })],
      columns: [evilCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos" });
    assert.ok(!html.includes("<b>Hi</b>"));
    assert.ok(html.includes("<th scope=\"col\">&lt;b&gt;Hi&lt;/b&gt;</th>"));
  });

  it("formats money with currency scales", async () => {
    const seen: SeenCall[] = [];
    const totalCol: ColumnMeta = { field: "total", label: "Total", type: "money" };
    const context = tableContext(
      seen,
      {
        rows: [row("a", { total: { minor: 12345n, currency: "USD" } })],
        columns: [totalCol],
      },
      { currencyScales: { USD: 2 } },
    );
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["total"], empty: "No todos" });
    assert.ok(html.includes(`<td>${isolate("$123.45")}</td>`));
  });

  it("throws a column error for money without scales", async () => {
    const seen: SeenCall[] = [];
    const totalCol: ColumnMeta = { field: "total", label: "Total", type: "money" };
    const context = tableContext(seen, {
      rows: [row("a", { total: { minor: "12345", currency: "USD" } })],
      columns: [totalCol],
    });
    await rejectsWith(
      () => table({ context, model: "TeamTasks.Todo", columns: ["total"], empty: "No todos" }),
      "column total",
      "currencyScales",
    );
  });

  it("renders dates in UTC", async () => {
    const seen: SeenCall[] = [];
    const dueCol: ColumnMeta = { field: "due", label: "Due", type: "date" };
    const context = tableContext(seen, {
      rows: [row("a", { due: "2026-03-14" })],
      columns: [dueCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["due"], empty: "No todos" });
    const expected = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date("2026-03-14T00:00:00Z"),
    );
    assert.ok(html.includes(`<td>${isolate(expected)}</td>`));
  });

  it("renders nested RowView values via rowHeading", async () => {
    const seen: SeenCall[] = [];
    const ownerLabel = message("Owner", { nl: "Eigenaar" });
    const ownerCol: ColumnMeta = { field: "owner", label: ownerLabel, type: "ref" };
    const nested = row("u-1", { name: "Vince" });
    const context = tableContext(seen, {
      rows: [row("a", { owner: nested })],
      columns: [ownerCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["owner"], empty: "No todos" });
    assert.ok(html.includes(`<td>${isolate(rowHeading(nested, ownerLabel, context))}</td>`));
  });

  it("renders dotted model-ref columns with nested rows structurally, not as badges", async () => {
    const seen: SeenCall[] = [];
    const ownerLabel = message("Owner", { nl: "Eigenaar" });
    const ownerCol: ColumnMeta = { field: "owner", label: ownerLabel, type: "TeamTasks.Member" };
    const nested = row("u-1", { name: "Vince" });
    const context = tableContext(seen, {
      rows: [row("a", { owner: nested })],
      columns: [ownerCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["owner"], empty: "No todos" });
    assert.ok(html.includes(`<td>${isolate(rowHeading(nested, ownerLabel, context))}</td>`));
    assert.ok(!html.includes("badge"));
  });

  it("renders {id}-shaped values as escaped ids", async () => {
    const seen: SeenCall[] = [];
    const docCol: ColumnMeta = { field: "doc", label: "Doc", type: "file" };
    const context = tableContext(seen, {
      rows: [row("a", { doc: { kind: "file", id: "<doc-1>" } })],
      columns: [docCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["doc"], empty: "No todos" });
    assert.ok(!html.includes("<doc-1>"));
    assert.ok(html.includes(`<td>${isolate("&lt;doc-1&gt;")}</td>`));
  });

  it("throws naming field and type for unsupported structural values", async () => {
    const seen: SeenCall[] = [];
    const docCol: ColumnMeta = { field: "doc", label: "Doc", type: "file" };
    const context = tableContext(seen, {
      rows: [row("a", { doc: 42 })],
      columns: [docCol],
    });
    await rejectsWith(
      () => table({ context, model: "TeamTasks.Todo", columns: ["doc"], empty: "No todos" }),
      "column doc",
      '"file"',
    );
  });

  it("wraps scalar mismatches as column errors", async () => {
    const seen: SeenCall[] = [];
    const context = tableContext(seen, {
      rows: [row("a", { count: "nope" })],
      columns: [countCol],
    });
    await rejectsWith(
      () => table({ context, model: "TeamTasks.Todo", columns: ["count"], empty: "No todos" }),
      "column count",
    );
  });

  it("throws column errors for badge type mismatches", async () => {
    const seen: SeenCall[] = [];
    const doneCol: ColumnMeta = { field: "done", label: "Done", type: "bool" };
    const boolContext = tableContext(seen, {
      rows: [row("a", { done: "yes" })],
      columns: [doneCol],
    });
    await rejectsWith(
      () => table({ context: boolContext, model: "TeamTasks.Todo", columns: ["done"], empty: "No todos" }),
      "column done",
    );
    const stateCol: ColumnMeta = { field: "state", label: "State", type: "enum" };
    const enumContext = tableContext(seen, {
      rows: [row("a", { state: 7 })],
      columns: [stateCol],
    });
    await rejectsWith(
      () => table({ context: enumContext, model: "TeamTasks.Todo", columns: ["state"], empty: "No todos" }),
      "column state",
    );
  });

  it("renders nullish cells empty", async () => {
    const seen: SeenCall[] = [];
    const context = tableContext(seen, {
      rows: [row("a", { title: null, count: undefined })],
      columns: [titleCol, countCol],
    });
    const html = await table({
      context,
      model: "TeamTasks.Todo",
      columns: ["title", "count"],
      empty: "No todos",
    });
    assert.ok(html.includes("<tr><td></td><td></td></tr>"));
  });

  it("never renders unselected fields, even when the runner returns extras", async () => {
    const seen: SeenCall[] = [];
    const secret = "forbidden-secret-value";
    const context = tableContext(seen, {
      rows: [row("a", { title: "Buy milk", secret })],
      columns: [titleCol],
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos" });
    assert.ok(html.includes(isolate("Buy milk")));
    assert.ok(!html.includes(secret));
  });

  it("badges enum:-prefixed column types like other enum spellings", async () => {
    const seen: SeenCall[] = [];
    const stateCol: ColumnMeta = {
      field: "state",
      label: "State",
      type: "enum:Expense.state",
      valueLabels: { open: message("Open") },
    };
    const context = tableContext(seen, {
      rows: [row("a", { state: "open" })],
      columns: [stateCol],
    });
    const html = await table({ context, model: "Expense", columns: ["state"], empty: "No rows" });
    assert.ok(html.includes('<span class="badge">Open</span>'));
  });

  it("rejects out-of-range limits without querying", async () => {
    const seen: SeenCall[] = [];
    const context = tableContext(seen, { rows: [], columns: [titleCol] });
    for (const limit of [0, -1, 101, 1.5, Number.NaN]) {
      await rejectsWith(
        () => table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos", limit }),
        "table: limit must be an integer 1..100",
      );
      await rejectsWith(
        () =>
          list({
            context,
            model: "TeamTasks.Todo",
            empty: "No todos",
            limit,
            renderRow: () => [],
          }),
        "list: limit must be an integer 1..100",
      );
    }
    assert.equal(seen.length, 0);
    await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos", limit: 100 });
    assert.equal(seen.length, 1);
  });

  it("passes query args, invocation and model through", async () => {
    const seen: SeenCall[] = [];
    const invocation = { request: "req-7" };
    const where = { done: false };
    const context = makeContext({
      invocation,
      query: stubRunner(seen, { rows: [], columns: [titleCol] }),
    });
    await table({
      context,
      model: "TeamTasks.Todo",
      parent: { id: "p-2" },
      where,
      limit: 5,
      cursor: "c-2",
      page: true,
      occurrence: "page:/todos/table:1",
      columns: ["title"],
      empty: "No todos",
    });
    assert.strictEqual(seen[0]?.invocation, invocation);
    assert.equal(seen[0]?.model, "TeamTasks.Todo");
    assert.deepEqual(seen[0]?.args, { parent: { id: "p-2" }, where, limit: 5, cursor: "c-2", page: true, occurrence: "page:/todos/table:1" });
  });

  it("appends a more-note after the table when nextCursor is present", async () => {
    const seen: SeenCall[] = [];
    const context = tableContext(seen, {
      rows: [row("a", { title: "x" })],
      columns: [titleCol],
      nextCursor: "t-9",
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos" });
    assert.ok(html.includes("<p class=\"can-more\" data-cursor=\"t-9\">More rows available.</p>"));
    assert.ok(html.indexOf("</table>") < html.indexOf("can-more"));
    const plainSeen: SeenCall[] = [];
    const plain = await table({
      context: tableContext(plainSeen, { rows: [row("a", { title: "x" })], columns: [titleCol] }),
      model: "TeamTasks.Todo",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(!plain.includes("can-more"));
  });

  it("escapes the cursor in the table more-note", async () => {
    const cursor = '" autofocus onfocus=alert(1) x="';
    const seen: SeenCall[] = [];
    const context = tableContext(seen, {
      rows: [row("a", { title: "x" })],
      columns: [titleCol],
      nextCursor: cursor,
    });
    const html = await table({ context, model: "TeamTasks.Todo", columns: ["title"], empty: "No todos" });
    assert.ok(!html.includes(cursor));
    assert.ok(html.includes(`data-cursor="${escapeAttr(cursor)}"`));
  });
});

// ---------------------------------------------------------------------------
// S5 collection controls (additive; all S3 suites above stay untouched).
// ---------------------------------------------------------------------------

function makeControls(overrides: Partial<CollectionControls> = {}): CollectionControls {
  return {
    context: makeContext(),
    regionId: "todo-rows",
    baseHref: "/todos",
    ...overrides,
  };
}

/** Parse a control href back into query params for wiring assertions. */
function controlParams(href: string): URLSearchParams {
  return new URL(href, "http://localhost").searchParams;
}

describe("controlHref", () => {
  it("returns the bare baseHref without state", () => {
    assert.equal(controlHref("/todos"), "/todos");
    assert.equal(controlHref("/todos", {}), "/todos");
  });

  it("serializes q, filters, order and cursor exactly", () => {
    const href = controlHref("/todos", {
      q: "x",
      filters: [
        { field: "status", op: "eq", value: "open" },
        { field: "amount", op: "between", value: 1, upper: 5 },
        { field: "done", op: "is_null" },
      ],
      order: [{ field: "due", direction: "asc" }],
      cursor: "c1",
    });
    assert.equal(
      href,
      "/todos?q=x" +
        "&f%5B0%5D%5Bfield%5D=status&f%5B0%5D%5Bop%5D=eq&f%5B0%5D%5Bvalue%5D=open" +
        "&f%5B1%5D%5Bfield%5D=amount&f%5B1%5D%5Bop%5D=between" +
        "&f%5B1%5D%5Bvalue%5D=1&f%5B1%5D%5Bupper%5D=5" +
        "&f%5B2%5D%5Bfield%5D=done&f%5B2%5D%5Bop%5D=is_null" +
        "&o%5B0%5D%5Bfield%5D=due&o%5B0%5D%5Bdir%5D=asc" +
        "&cursor=c1",
    );
  });

  it("percent-encodes hostile characters in every value", () => {
    const href = controlHref("/todos", {
      q: `&<>"'`,
      filters: [{ field: "title", op: "eq", value: `&<>"'` }],
      cursor: `&<>"'`,
    });
    assert.ok(!href.includes("&<"), `leaked raw markup: ${href}`);
    const params = controlParams(href);
    assert.equal(params.get("q"), `&<>"'`);
    assert.equal(params.get("f[0][value]"), `&<>"'`);
    assert.equal(params.get("cursor"), `&<>"'`);
    assert.ok(href.includes("q=%26%3C%3E%22%27"), `unexpected q encoding: ${href}`);
  });

  it("serializes number, boolean and bigint bounds as text", () => {
    const href = controlHref("/todos", {
      filters: [
        { field: "count", op: "gte", value: 42 },
        { field: "done", op: "eq", value: true },
        { field: "total", op: "lte", value: 10n },
      ],
    });
    const params = controlParams(href);
    assert.equal(params.get("f[0][value]"), "42");
    assert.equal(params.get("f[1][value]"), "true");
    assert.equal(params.get("f[2][value]"), "10");
  });

  it("omits empty q and cursor, preserves existing query and fragment", () => {
    assert.equal(controlHref("/todos", { q: "", cursor: "" }), "/todos");
    assert.equal(controlHref("/todos?page=1", { q: "a" }), "/todos?page=1&q=a");
    assert.equal(controlHref("/todos#list", { q: "a" }), "/todos?q=a#list");
  });

  it("falls back to # for a hostile baseHref", () => {
    for (const base of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<b>x</b>", ""]) {
      assert.equal(controlHref(base, { q: "a" }), "#");
    }
  });

  it("throws on unknown operators and malformed conditions", () => {
    const badOp = { field: "a", op: "like", value: "x" } as unknown as FilterCondition;
    assert.throws(() => controlHref("/x", { filters: [badOp] }), /not a known filter operator/);
    assert.throws(
      () => controlHref("/x", { filters: [{ field: "a", op: "between", value: 1 }] }),
      /between needs a value and an upper bound/,
    );
    assert.throws(
      () => controlHref("/x", { filters: [42] as unknown as FilterCondition[] }),
      /must be an object/,
    );
    assert.throws(
      () => controlHref("/x", null as unknown as never),
      /state must be an object/,
    );
    assert.throws(
      () => controlHref("/x", { filters: [{ field: "a", op: "is_null", value: "x" }] }),
      /takes no value/,
    );
    assert.throws(
      () => controlHref("/x", { filters: [{ field: "a", op: "eq" }] }),
      /needs a value/,
    );
    assert.throws(
      () => controlHref("/x", { filters: [{ field: "a", op: "eq", value: "x", upper: "y" }] }),
      /takes no upper bound/,
    );
    assert.throws(
      () => controlHref("/x", { filters: [{ field: "", op: "eq", value: "x" }] }),
      /nonempty string/,
    );
    const badDir = { field: "a", direction: "sideways" } as unknown as OrderSelector;
    assert.throws(() => controlHref("/x", { order: [badDir] }), /must be "asc" or "desc"/);
    assert.throws(
      () => controlHref("/x", { filters: [{ field: "a", op: "eq", value: { nested: 1 } }] }),
      /must be a string, number, boolean or bigint/,
    );
    assert.throws(
      () => controlHref("/x", { filters: [{ field: "a", op: "eq", value: Number.NaN }] }),
      /must be a finite number/,
    );
    assert.throws(() => controlHref("/x", { q: 7 as unknown as string }), /q must be a string/);
    assert.throws(
      () => controlHref("/x", { cursor: 7 as unknown as string }),
      /cursor must be a string/,
    );
  });
});

describe("collectionToolbar", () => {
  const filters: FilterCondition[] = [
    { field: "status", op: "eq", value: "open" },
    { field: "amount", op: "between", value: 1, upper: 5 },
  ];
  const order: OrderSelector[] = [
    { field: "due", direction: "asc" },
    { field: "title", direction: "desc" },
  ];

  it("renders a debounced search input bound to the region", async () => {
    const controls = makeControls({ search: { query: "milk" }, filters, order });
    const page = await loadHtml(await collectionToolbar(controls));
    try {
      assert.ok(page.document.querySelector("[data-toolbar]") !== null);
      const input = page.document.querySelector('input[name="q"]') as unknown as {
        value: string;
        getAttribute(name: string): string | null;
      } | null;
      assert.ok(input !== null);
      assert.equal(input.value, "milk");
      assert.equal(
        input.getAttribute("hx-get"),
        controlHref("/todos", { filters, order }),
      );
      assert.equal(input.getAttribute("hx-target"), "#todo-rows");
      assert.equal(input.getAttribute("hx-swap"), "outerMorph");
      assert.equal(
        input.getAttribute("hx-trigger"),
        "input changed delay:500ms, keyup[key=='Enter']",
      );
      assert.equal(input.getAttribute("hx-include"), "this");
    } finally {
      await page.close();
    }
  });

  it("renders one removable chip per filter with exact drop-one hrefs", async () => {
    const controls = makeControls({ search: { query: "milk" }, filters, order });
    const page = await loadHtml(await collectionToolbar(controls));
    try {
      const chips = page.document.querySelectorAll("[data-chip]");
      assert.equal(chips.length, 2);
      const links = page.document.querySelectorAll("[data-chip] a");
      assert.equal(links.length, 2);
      const first = links.item(0);
      const second = links.item(1);
      assert.ok(first !== null && second !== null);
      // Dropping chip 0 leaves the between filter reindexed at [0].
      const rest0 = controlParams(first.getAttribute("href") ?? "");
      assert.equal(rest0.get("q"), "milk");
      assert.equal(rest0.get("f[0][field]"), "amount");
      assert.equal(rest0.get("f[0][op]"), "between");
      assert.equal(rest0.get("f[0][value]"), "1");
      assert.equal(rest0.get("f[0][upper]"), "5");
      assert.equal(rest0.get("f[1][field]"), null);
      assert.equal(rest0.get("o[0][field]"), "due");
      assert.equal(rest0.get("cursor"), null);
      // Dropping chip 1 leaves the equality filter.
      const rest1 = controlParams(second.getAttribute("href") ?? "");
      assert.equal(rest1.get("f[0][field]"), "status");
      assert.equal(rest1.get("f[0][value]"), "open");
      assert.equal(rest1.get("f[1][field]"), null);
      assert.equal(first.getAttribute("hx-target"), "#todo-rows");
      assert.equal(first.getAttribute("hx-swap"), "outerMorph");
    } finally {
      await page.close();
    }
  });

  it("shows chip text as `field op value` and escapes hostile values", async () => {
    const hostile = `<script>alert("x")</script>`;
    const controls = makeControls({
      filters: [
        { field: "status", op: "eq", value: "open" },
        { field: "amount", op: "between", value: 1, upper: 5 },
        { field: "done", op: "is_null" },
        { field: "title", op: "eq", value: hostile },
      ],
    });
    const html = await collectionToolbar(controls);
    assert.ok(!html.includes(hostile));
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelectorAll("[data-chip]").length, 4);
      assert.equal(page.document.querySelector("script"), null);
      const chips = page.document.querySelectorAll("[data-chip]");
      assert.ok((chips.item(0)?.textContent ?? "").includes("status eq open"));
      assert.ok((chips.item(1)?.textContent ?? "").includes("amount between 1 and 5"));
      assert.ok((chips.item(2)?.textContent ?? "").includes("done is_null"));
      assert.ok((chips.item(3)?.textContent ?? "").includes(`title eq ${hostile}`));
    } finally {
      await page.close();
    }
  });

  it("renders order links rotating the chosen selector first", async () => {
    const controls = makeControls({ search: { query: "milk" }, filters, order });
    const page = await loadHtml(await collectionToolbar(controls));
    try {
      assert.equal(page.document.querySelector("select[name='order']"), null);
      const chips = page.document.querySelectorAll("[data-order-chip]");
      assert.equal(chips.length, 2);
      const first = chips.item(0);
      const second = chips.item(1);
      assert.equal(first?.tagName, "A");
      assert.equal(second?.tagName, "A");
      assert.ok((first?.textContent ?? "").includes("due asc"));
      assert.ok((second?.textContent ?? "").includes("title desc"));
      assert.equal(first?.getAttribute("hx-target"), "#todo-rows");
      assert.equal(first?.getAttribute("hx-swap"), "outerMorph");
      const firstParams = controlParams(first?.getAttribute("href") ?? "");
      assert.equal(firstParams.get("o[0][field]"), "due");
      assert.equal(firstParams.get("o[0][dir]"), "asc");
      assert.equal(firstParams.get("o[1][field]"), "title");
      assert.equal(firstParams.get("q"), "milk");
      assert.equal(firstParams.get("f[0][field]"), "status");
      const secondParams = controlParams(second?.getAttribute("href") ?? "");
      assert.equal(secondParams.get("o[0][field]"), "title");
      assert.equal(secondParams.get("o[0][dir]"), "desc");
      assert.equal(secondParams.get("o[1][field]"), "due");
      assert.equal(secondParams.get("o[1][dir]"), "asc");
    } finally {
      await page.close();
    }
  });

  it("renders a lone selector as a static chip, not a self-link", async () => {
    const controls = makeControls({ order: [{ field: "due", direction: "asc" }] });
    const page = await loadHtml(await collectionToolbar(controls));
    try {
      const chips = page.document.querySelectorAll("[data-order-chip]");
      assert.equal(chips.length, 1);
      assert.equal(chips.item(0)?.tagName, "SPAN");
    } finally {
      await page.close();
    }
  });

  it("omits chips and order links when that state is absent", async () => {
    const page = await loadHtml(await collectionToolbar(makeControls()));
    try {
      assert.equal(page.document.querySelectorAll("[data-chip]").length, 0);
      assert.equal(page.document.querySelectorAll("[data-order-chip]").length, 0);
      assert.equal(page.document.querySelector("select[name='order']"), null);
      const input = page.document.querySelector('input[name="q"]') as unknown as {
        value: string;
      } | null;
      assert.equal(input?.value, "");
    } finally {
      await page.close();
    }
  });

  it("keeps a hostile query inert in the search input", async () => {
    const hostile = `"><img src=x onerror=alert(1)>`;
    const html = await collectionToolbar(makeControls({ search: { query: hostile } }));
    assert.ok(!html.includes(hostile));
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img"), null);
      const input = page.document.querySelector('input[name="q"]') as unknown as {
        value: string;
      } | null;
      assert.equal(input?.value, hostile);
    } finally {
      await page.close();
    }
  });

  it("falls back to # under a hostile baseHref", async () => {
    const controls = makeControls({ baseHref: "javascript:alert(1)", filters });
    const page = await loadHtml(await collectionToolbar(controls));
    try {
      const input = page.document.querySelector('input[name="q"]');
      assert.equal(input?.getAttribute("hx-get"), "#");
      const link = page.document.querySelector("[data-chip] a");
      assert.equal(link?.getAttribute("href"), "#");
      assert.equal(link?.getAttribute("hx-get"), "#");
    } finally {
      await page.close();
    }
  });

  it("rejects invalid region ids and malformed controls", async () => {
    await rejectsWith(
      () => collectionToolbar(makeControls({ regionId: "Bad Id" })),
      "invalid regionId",
    );
    const badOp = { field: "a", op: "like", value: "x" } as unknown as FilterCondition;
    await rejectsWith(
      () => collectionToolbar(makeControls({ filters: [badOp] })),
      "not a known filter operator",
    );
  });
});

describe("collectionPagination", () => {
  it("renders prev/next links carrying the opaque cursors plus state", async () => {
    const filters: FilterCondition[] = [{ field: "status", op: "eq", value: "open" }];
    const order: OrderSelector[] = [{ field: "due", direction: "desc" }];
    const controls = makeControls({
      search: { query: "milk" },
      filters,
      order,
      pagination: { prevCursor: "prev-1", nextCursor: "next-2" },
    });
    const page = await loadHtml(await collectionPagination(controls));
    try {
      assert.ok(page.document.querySelector("[data-pagination]") !== null);
      const links = page.document.querySelectorAll("[data-pagination] a");
      assert.equal(links.length, 2);
      const prev = controlParams(links.item(0)?.getAttribute("href") ?? "");
      const next = controlParams(links.item(1)?.getAttribute("href") ?? "");
      assert.equal(prev.get("cursor"), "prev-1");
      assert.equal(next.get("cursor"), "next-2");
      for (const params of [prev, next]) {
        assert.equal(params.get("q"), "milk");
        assert.equal(params.get("f[0][value]"), "open");
        assert.equal(params.get("o[0][dir]"), "desc");
      }
      assert.equal(links.item(0)?.getAttribute("hx-target"), "#todo-rows");
      assert.equal(links.item(0)?.getAttribute("hx-swap"), "outerMorph");
      assert.ok((links.item(0)?.textContent ?? "").includes("Previous"));
      assert.ok((links.item(1)?.textContent ?? "").includes("Next"));
    } finally {
      await page.close();
    }
  });

  it("disables the button whose cursor is absent", async () => {
    const page = await loadHtml(
      await collectionPagination(makeControls({ pagination: { nextCursor: "n" } })),
    );
    try {
      const buttons = page.document.querySelectorAll("[data-pagination] button");
      assert.equal(buttons.length, 1);
      assert.ok((buttons.item(0)?.textContent ?? "").includes("Previous"));
      assert.equal(buttons.item(0)?.hasAttribute("disabled"), true);
      assert.equal(page.document.querySelectorAll("[data-pagination] a").length, 1);
    } finally {
      await page.close();
    }
    const both = await loadHtml(
      await collectionPagination(makeControls({ pagination: {} })),
    );
    try {
      assert.equal(both.document.querySelectorAll("[data-pagination] button").length, 2);
      assert.equal(both.document.querySelectorAll("[data-pagination] a").length, 0);
    } finally {
      await both.close();
    }
  });

  it("renders nothing without pagination state", async () => {
    assert.equal(await collectionPagination(makeControls()), "");
  });

  it("keeps hostile cursors opaque, encoded and inert", async () => {
    const hostile = `"><svg onload=alert(1)>`;
    const html = await collectionPagination(
      makeControls({ pagination: { nextCursor: hostile } }),
    );
    assert.ok(!html.includes(hostile));
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("svg"), null);
      const link = page.document.querySelector("[data-pagination] a");
      assert.equal(controlParams(link?.getAttribute("href") ?? "").get("cursor"), hostile);
    } finally {
      await page.close();
    }
  });

  it("localizes prev/next labels", async () => {
    const controls = makeControls({
      context: makeContext({ preferredLocales: ["nl"] }),
      pagination: { prevCursor: "p", nextCursor: "n" },
    });
    const page = await loadHtml(await collectionPagination(controls));
    try {
      const links = page.document.querySelectorAll("[data-pagination] a");
      assert.ok((links.item(0)?.textContent ?? "").includes("Vorige"));
      assert.ok((links.item(1)?.textContent ?? "").includes("Volgende"));
    } finally {
      await page.close();
    }
  });
});

describe("collectionShareControls", () => {
  it("renders plain navigation links without download or hx behavior", async () => {
    const controls = makeControls({ exportHref: "/todos/export", printHref: "/todos/print" });
    const page = await loadHtml(await collectionShareControls(controls));
    try {
      const exp = page.document.querySelector("[data-export]");
      const print = page.document.querySelector("[data-print]");
      assert.ok(exp !== null && print !== null);
      assert.equal(exp.getAttribute("href"), "/todos/export");
      assert.equal(print.getAttribute("href"), "/todos/print");
      assert.equal(exp.getAttribute("download"), null);
      assert.equal(exp.getAttribute("hx-get"), null);
      assert.equal(print.getAttribute("hx-get"), null);
      assert.ok((exp.textContent ?? "").includes("Export"));
    } finally {
      await page.close();
    }
  });

  it("omits absent hrefs and renders nothing when both are absent", async () => {
    assert.equal(await collectionExportLink(makeControls()), "");
    assert.equal(await collectionPrintLink(makeControls()), "");
    assert.equal(await collectionShareControls(makeControls()), "");
    const page = await loadHtml(
      await collectionShareControls(makeControls({ exportHref: "/todos/export" })),
    );
    try {
      assert.ok(page.document.querySelector("[data-export]") !== null);
      assert.equal(page.document.querySelector("[data-print]"), null);
    } finally {
      await page.close();
    }
  });

  it("neutralizes hostile export/print hrefs to #", async () => {
    const page = await loadHtml(
      await collectionShareControls(
        makeControls({ exportHref: "javascript:steal()", printHref: "javascript:print()" }),
      ),
    );
    try {
      assert.equal(page.document.querySelector("[data-export]")?.getAttribute("href"), "#");
      assert.equal(page.document.querySelector("[data-print]")?.getAttribute("href"), "#");
    } finally {
      await page.close();
    }
  });
});

describe("list/table with controls", () => {
  const titleCol: ColumnMeta = { field: "title", label: "Title", type: "text" };

  function rowsContext(seen: SeenCall[], result: ListQueryResult): PresentationContext {
    return makeContext({ query: stubRunner(seen, result) });
  }

  function controlled(
    seen: SeenCall[],
    result: ListQueryResult,
    overrides: Partial<CollectionControls> = {},
  ): CollectionControls {
    return makeControls({ context: rowsContext(seen, result), ...overrides });
  }

  it("list wraps rows in the region with toolbar, pagination and share", async () => {
    const seen: SeenCall[] = [];
    const controls = controlled(seen, { rows: [row("a")], columns: [] }, {
      search: { query: "milk" },
      filters: [{ field: "status", op: "eq", value: "open" }],
      pagination: { nextCursor: "n" },
      exportHref: "/todos/export",
      printHref: "/todos/print",
    });
    const html = await list({
      context: controls.context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: (item) => [item.id],
      controls,
    });
    const page = await loadHtml(html);
    try {
      const section = page.document.querySelector("section#todo-rows");
      assert.ok(section !== null);
      assert.equal(section.getAttribute("data-region"), "todo-rows");
      assert.ok(page.document.querySelector("[data-toolbar]") !== null);
      assert.ok(page.document.querySelector("[data-pagination]") !== null);
      assert.ok(page.document.querySelector("[data-share]") !== null);
      assert.equal(page.document.querySelectorAll("li.list-row").length, 1);
      assert.ok(!html.includes("can-more"));
    } finally {
      await page.close();
    }
  });

  it("collection regions match fragment parity: morph default, hook, label", async () => {
    const seen: SeenCall[] = [];
    const controls = controlled(seen, { rows: [row("a")], columns: [] });
    const html = await list({
      context: controls.context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: (item) => [item.id],
      controls,
    });
    const page = await loadHtml(html);
    try {
      const section = page.document.querySelector("section#todo-rows");
      assert.ok(section !== null);
      assert.equal(section.getAttribute("hx-swap"), "outerMorph");
      assert.ok((section.getAttribute("class") ?? "").split(" ").includes("can-region"));
      assert.equal(section.getAttribute("aria-label"), "TeamTasks.Todo");
    } finally {
      await page.close();
    }
    const labeled = controlled(seen, { rows: [row("a")], columns: [] }, { label: "My todos" });
    const labeledHtml = await list({
      context: labeled.context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: (item) => [item.id],
      controls: labeled,
    });
    const labeledPage = await loadHtml(labeledHtml);
    try {
      assert.equal(
        labeledPage.document.querySelector("section#todo-rows")?.getAttribute("aria-label"),
        "My todos",
      );
    } finally {
      await labeledPage.close();
    }
  });

  it("rejects a controls context that diverges from the collection context", async () => {
    const seen: SeenCall[] = [];
    const controls = controlled(seen, { rows: [row("a")], columns: [] });
    const other = makeContext({ query: stubRunner(seen, { rows: [], columns: [] }) });
    await assert.rejects(
      () =>
        list({
          context: { ...other, appDefaultLocale: "nl" },
          model: "TeamTasks.Todo",
          empty: "No todos",
          renderRow: (item) => [item.id],
          controls,
        }),
      /diverges/,
    );
  });

  it("renders empty-string cursors as disabled buttons", async () => {
    const controls = makeControls({ pagination: { prevCursor: "", nextCursor: "" } });
    const page = await loadHtml(await collectionPagination(controls));
    try {
      assert.equal(page.document.querySelectorAll("[data-pagination] a").length, 0);
      assert.equal(page.document.querySelectorAll("[data-pagination] button[disabled]").length, 2);
    } finally {
      await page.close();
    }
  });

  it("table wraps rows in the region with toolbar and rows intact", async () => {
    const seen: SeenCall[] = [];
    const controls = controlled(seen, {
      rows: [row("a", { title: "Buy milk" })],
      columns: [titleCol],
    });
    const html = await table({
      context: controls.context,
      model: "TeamTasks.Todo",
      columns: ["title"],
      empty: "No todos",
      controls,
    });
    const page = await loadHtml(html);
    try {
      assert.ok(page.document.querySelector("section#todo-rows") !== null);
      assert.ok(page.document.querySelector("[data-toolbar]") !== null);
      assert.ok((page.document.querySelector("tbody")?.textContent ?? "").includes("Buy milk"));
    } finally {
      await page.close();
    }
  });

  it("without controls output carries no toolbar markers", async () => {
    const seen: SeenCall[] = [];
    const context = rowsContext(seen, { rows: [row("a")], columns: [] });
    const listHtml = await list({
      context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: (item) => [item.id],
    });
    assert.ok(!listHtml.includes("data-toolbar"));
    assert.ok(!listHtml.includes("data-region"));
    assert.ok(!listHtml.includes("data-no-match"));
    const tableHtml = await table({
      context: rowsContext(seen, { rows: [row("a", { title: "x" })], columns: [titleCol] }),
      model: "TeamTasks.Todo",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(!tableHtml.includes("data-toolbar"));
    assert.ok(!tableHtml.includes("data-region"));
  });

  it("active search plus zero rows renders no-match with a clear link", async () => {
    for (const factory of ["list", "table"] as const) {
      const seen: SeenCall[] = [];
      const controls = controlled(seen, { rows: [], columns: [titleCol] }, {
        search: { query: "milk" },
      });
      const html =
        factory === "list"
          ? await list({
              context: controls.context,
              model: "TeamTasks.Todo",
              empty: "No todos",
              renderRow: () => [],
              controls,
            })
          : await table({
              context: controls.context,
              model: "TeamTasks.Todo",
              columns: ["title"],
              empty: "No todos",
              controls,
            });
      const page = await loadHtml(html);
      try {
        const block = page.document.querySelector("[data-no-match]");
        assert.ok(block !== null, `${factory} must render the no-match block`);
        assert.ok((block.textContent ?? "").includes("No matching results."));
        const clear = page.document.querySelector("[data-no-match] a");
        assert.equal(clear?.getAttribute("href"), "/todos");
        assert.equal(clear?.getAttribute("hx-get"), "/todos");
        assert.equal(clear?.getAttribute("hx-target"), "#todo-rows");
        assert.ok((clear?.textContent ?? "").includes("Clear search and filters"));
        assert.ok(page.document.querySelector("section#todo-rows") !== null);
      } finally {
        await page.close();
      }
    }
  });

  it("active filters without search also render no-match", async () => {
    const seen: SeenCall[] = [];
    const controls = controlled(seen, { rows: [], columns: [] }, {
      filters: [{ field: "status", op: "eq", value: "open" }],
    });
    const html = await list({
      context: controls.context,
      model: "TeamTasks.Todo",
      empty: "No todos",
      renderRow: () => [],
      controls,
    });
    const page = await loadHtml(html);
    try {
      assert.ok(page.document.querySelector("[data-no-match]") !== null);
    } finally {
      await page.close();
    }
  });

  it("controls without an active query keep the empty state, wrapped", async () => {
    const seen: SeenCall[] = [];
    const empty = message("Nothing here", { nl: "Niets hier" });
    const controls = controlled(seen, { rows: [], columns: [] }, {
      search: { query: "" },
      order: [{ field: "due", direction: "asc" }],
    });
    const html = await list({
      context: controls.context,
      model: "TeamTasks.Todo",
      empty,
      renderRow: () => [],
      controls,
    });
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("[data-no-match]"), null);
      assert.ok(page.document.querySelector("section#todo-rows") !== null);
      assert.ok((page.document.querySelector("section#todo-rows")?.textContent ?? "").includes("Nothing here"));
    } finally {
      await page.close();
    }
  });

  it("without controls zero rows render bare empty as before", async () => {
    const seen: SeenCall[] = [];
    const empty = message("Nothing here", { nl: "Niets hier" });
    const context = rowsContext(seen, { rows: [], columns: [] });
    const html = await list({ context, model: "TeamTasks.Todo", empty, renderRow: () => [] });
    assert.equal(html, await renderState({ context, kind: "empty", message: empty }));
    assert.ok(!html.includes("data-no-match"));
  });

  it("rejects invalid controls without querying", async () => {
    const seen: SeenCall[] = [];
    const context = rowsContext(seen, { rows: [row("a")], columns: [] });
    await rejectsWith(
      () =>
        list({
          context,
          model: "TeamTasks.Todo",
          empty: "No todos",
          renderRow: () => [],
          controls: makeControls({ context, regionId: "nope!" }),
        }),
      "invalid regionId",
    );
    const badOp = { field: "a", op: "like", value: "x" } as unknown as FilterCondition;
    await rejectsWith(
      () =>
        table({
          context,
          model: "TeamTasks.Todo",
          columns: ["title"],
          empty: "No todos",
          controls: makeControls({ context, filters: [badOp] }),
        }),
      "not a known filter operator",
    );
    assert.equal(seen.length, 0);
  });
});

describe("collection controls XSS sweep", () => {
  it("rejects every invalid regionId shape", async () => {
    for (const regionId of [
      "",
      "Rows",
      "has space",
      "a_b",
      "-lead",
      "trail-",
      "a--b",
      `"><script>`,
      "../x",
      "#rows",
    ]) {
      await rejectsWith(() => collectionToolbar(makeControls({ regionId })), "invalid regionId");
      await rejectsWith(
        () => collectionPagination(makeControls({ regionId, pagination: {} })),
        "invalid regionId",
      );
    }
    // Sanity: kebab shapes pass validation.
    await collectionToolbar(makeControls({ regionId: "r2-d2" }));
    await collectionToolbar(makeControls({ regionId: "a" }));
  });

  it("escapes hostile fields, values and labels as text", async () => {
    const hostileField = `t"><b>tle`;
    const hostileValue = `open" onmouseover="alert(1)`;
    const html = await collectionToolbar(
      makeControls({
        filters: [{ field: hostileField, op: "eq", value: hostileValue }],
        order: [{ field: hostileField, direction: "asc" }],
      }),
    );
    assert.ok(!html.includes(hostileField));
    assert.ok(!html.includes(hostileValue));
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("b"), null);
      const chip = page.document.querySelector("[data-chip]");
      assert.ok((chip?.textContent ?? "").includes(hostileField));
      assert.ok((chip?.textContent ?? "").includes(hostileValue));
      const orderChip = page.document.querySelector("[data-order-chip]");
      assert.ok((orderChip?.textContent ?? "").includes(hostileField));
    } finally {
      await page.close();
    }
  });

  it("never emits an unknown operator as markup", async () => {
    const evil = { field: "a", op: `eq"><script>alert(1)</script>`, value: "x" };
    await rejectsWith(
      () =>
        collectionToolbar(
          makeControls({ filters: [evil as unknown as FilterCondition] }),
        ),
      "not a known filter operator",
    );
  });
});

// ---------------------------------------------------------------------------
// C7 board (additive; all suites above stay untouched).
// ---------------------------------------------------------------------------

describe("board", () => {
  const titleCol: ColumnMeta = { field: "title", label: "Title", type: "text" };
  const stateCol: ColumnMeta = {
    field: "state",
    label: "State",
    type: "enum",
    valueLabels: {
      open: message("Open", { nl: "Open-nl" }),
      closed: message("Closed", { nl: "Gesloten" }),
    },
  };

  function boardContext(
    seen: SeenCall[],
    result: ListQueryResult,
    overrides: Partial<PresentationContext> = {},
  ): PresentationContext {
    return makeContext({ query: stubRunner(seen, result), ...overrides });
  }

  it("groups rows into one section per enum case with one card per row", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, {
      rows: [
        row("a", { title: "First", state: "open" }),
        row("b", { title: "Second", state: "closed" }),
        row("c", { title: "Third", state: "open" }),
      ],
      columns: [titleCol, stateCol],
    });
    const page = await loadHtml(
      await board({ context, model: "TeamTasks.Todo", by: "state", columns: ["title"], empty: "No todos" }),
    );
    try {
      const groups = page.document.querySelectorAll("section[data-group]");
      assert.equal(groups.length, 2);
      assert.equal(groups.item(0)?.getAttribute("data-group"), "open");
      assert.ok((groups.item(0)?.querySelector("h2")?.textContent ?? "").includes("Open"));
      assert.equal(groups.item(0)?.querySelectorAll("ul > li").length, 2);
      assert.equal(groups.item(1)?.querySelectorAll("ul > li").length, 1);
      const cards = page.document.querySelectorAll("li > section.card");
      assert.equal(cards.length, 3);
      assert.ok((cards.item(0)?.querySelector("h3.card-title")?.textContent ?? "").includes("First"));
      assert.ok((cards.item(0)?.textContent ?? "").includes("Title"));
      assert.equal(page.document.querySelector("li[data-row='a']"), cards.item(0)?.parentElement);
    } finally {
      await page.close();
    }
  });

  it("falls back to the model caption plus id without title/name", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, {
      rows: [row("a", { state: "open" })],
      columns: [titleCol, stateCol],
    });
    const html = await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(html.includes(`\u2068TeamTasks.Todo a\u2069`));
  });

  it("orders groups by valueLabels declaration order, not row order", async () => {
    const seen: SeenCall[] = [];
    const flipped: ColumnMeta = {
      field: "state",
      label: "State",
      type: "enum",
      valueLabels: { closed: "Closed", open: "Open" },
    };
    const context = boardContext(seen, {
      rows: [row("a", { title: "x", state: "open" }), row("b", { title: "y", state: "closed" })],
      columns: [titleCol, flipped],
    });
    const html = await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(html.indexOf('data-group="closed"') < html.indexOf('data-group="open"'));
  });

  it("uses first-seen row order without valueLabels", async () => {
    const seen: SeenCall[] = [];
    const bare: ColumnMeta = { field: "state", label: "State", type: "enum" };
    const context = boardContext(seen, {
      rows: [
        row("a", { title: "x", state: "zebra" }),
        row("b", { title: "y", state: "apple" }),
        row("c", { title: "z", state: "zebra" }),
      ],
      columns: [titleCol, bare],
    });
    const html = await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(html.indexOf('data-group="zebra"') < html.indexOf('data-group="apple"'));
    assert.ok(html.includes("<h2>zebra</h2>"));
  });

  it("renders declared-but-empty groups with an empty list", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, {
      rows: [row("a", { title: "x", state: "open" })],
      columns: [titleCol, stateCol],
    });
    const page = await loadHtml(
      await board({ context, model: "TeamTasks.Todo", by: "state", columns: ["title"], empty: "No todos" }),
    );
    try {
      assert.equal(page.document.querySelectorAll("section[data-group]").length, 2);
      const closed = page.document.querySelector('section[data-group="closed"]');
      assert.ok(closed !== null);
      assert.ok((closed.querySelector("h2")?.textContent ?? "").includes("Closed"));
      assert.equal(closed.querySelectorAll("li").length, 0);
      assert.ok(closed.querySelector("ul") !== null);
    } finally {
      await page.close();
    }
  });

  it("resolves group labels per viewer locale", async () => {
    const seen: SeenCall[] = [];
    const result: ListQueryResult = {
      rows: [row("a", { title: "x", state: "closed" })],
      columns: [titleCol, stateCol],
    };
    const en = await board({
      context: boardContext(seen, result),
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(en.includes("<h2>Closed</h2>"));
    const nl = await board({
      context: boardContext(seen, result, { preferredLocales: ["nl"] }),
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(nl.includes("<h2>Gesloten</h2>"));
  });

  it("escapes hostile titles, cells, ids and group keys", async () => {
    const hostile = `<script>alert("x")</script>`;
    const seen: SeenCall[] = [];
    const bare: ColumnMeta = { field: "state", label: "State", type: "enum" };
    const html = await board({
      context: boardContext(seen, {
        rows: [row(`"><b>${hostile}`, { title: hostile, state: hostile })],
        columns: [titleCol, bare],
      }),
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(!html.includes(hostile));
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("script"), null);
      assert.equal(page.document.querySelector("b"), null);
    } finally {
      await page.close();
    }
  });

  it("emits no drag/drop affordances", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, {
      rows: [row("a", { title: "x", state: "open" })],
      columns: [titleCol, stateCol],
    });
    const html = await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(!html.includes("draggable"));
    assert.ok(!html.includes("ondrag"));
    assert.ok(!html.includes("ondrop"));
  });

  it("renders the empty state when rows are empty", async () => {
    const seen: SeenCall[] = [];
    const empty = message("Nothing here", { nl: "Niets hier" });
    const context = boardContext(seen, { rows: [], columns: [titleCol, stateCol] });
    const html = await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty,
    });
    assert.equal(html, await renderState({ context, kind: "empty", message: empty }));
  });

  it("wraps rows in the region with toolbar when controlled", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, {
      rows: [row("a", { title: "x", state: "open" })],
      columns: [titleCol, stateCol],
    });
    const controls = makeControls({ context });
    const page = await loadHtml(
      await board({
        context,
        model: "TeamTasks.Todo",
        by: "state",
        columns: ["title"],
        empty: "No todos",
        controls,
      }),
    );
    try {
      assert.ok(page.document.querySelector("section#todo-rows") !== null);
      assert.ok(page.document.querySelector("[data-toolbar]") !== null);
      assert.ok(page.document.querySelector("section[data-group]") !== null);
    } finally {
      await page.close();
    }
  });

  it("renders no-match under controls with an active query and zero rows", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, { rows: [], columns: [titleCol, stateCol] });
    const controls = makeControls({ context, search: { query: "milk" } });
    const html = await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
      controls,
    });
    assert.ok(html.includes("data-no-match"));
  });

  it("appends a more-note after the board when nextCursor is present", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, {
      rows: [row("a", { title: "x", state: "open" })],
      columns: [titleCol, stateCol],
      nextCursor: "b-1",
    });
    const html = await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(html.includes("<p class=\"can-more\" data-cursor=\"b-1\">More rows available.</p>"));
  });

  it("passes query args, invocation and model through", async () => {
    const seen: SeenCall[] = [];
    const invocation = { request: "req-b" };
    const where = { state: "open" };
    const context = makeContext({
      invocation,
      query: stubRunner(seen, { rows: [], columns: [titleCol, stateCol] }),
    });
    await board({
      context,
      model: "TeamTasks.Todo",
      by: "state",
      parent: { id: "p-3" },
      where,
      limit: 5,
      cursor: "c-3",
      columns: ["title"],
      empty: "No todos",
    });
    assert.strictEqual(seen[0]?.invocation, invocation);
    assert.equal(seen[0]?.model, "TeamTasks.Todo");
    assert.deepEqual(seen[0]?.args, { parent: { id: "p-3" }, where, limit: 5, cursor: "c-3" });
  });

  it("propagates query failures untouched", async () => {
    const seen: SeenCall[] = [];
    const failure = new Error("records() down");
    const context = makeContext({ query: stubRunner(seen, failure) });
    try {
      await board({
        context,
        model: "TeamTasks.Todo",
        by: "state",
        columns: ["title"],
        empty: "No todos",
      });
    } catch (error) {
      assert.strictEqual(error, failure);
      return;
    }
    assert.fail("expected the query failure to propagate");
  });

  it("rejects invalid input without grouping", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, {
      rows: [row("a", { title: "x", state: "open" })],
      columns: [titleCol, stateCol],
    });
    const base = {
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"] as readonly string[],
      empty: "No todos" as const,
    };
    await rejectsWith(() => board({ ...base, by: "" }), "board: by must be a nonempty field name");
    await rejectsWith(
      () => board({ ...base, by: "missing" }),
      "TeamTasks.Todo",
      "missing group field",
    );
    const textCtx = boardContext(seen, {
      rows: [row("a", { title: "x", state: "open" })],
      columns: [titleCol, { field: "state", label: "State", type: "text" }],
    });
    await rejectsWith(
      () => board({ ...base, context: textCtx }),
      "needs an enum type",
      '"text"',
    );
    await rejectsWith(
      () => board({ ...base, columns: ["gone"] }),
      "TeamTasks.Todo",
      "missing columns",
      "gone",
    );
    await rejectsWith(() => board({ ...base, limit: 0 }), "board: limit must be an integer 1..100");
    // by:"" and limit:0 throw before querying; the other three query first.
    assert.equal(seen.length, 3);
  });

  it("throws on missing group-field metadata even when rows are empty", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, { rows: [], columns: [titleCol] });
    await rejectsWith(
      () =>
        board({ context, model: "TeamTasks.Todo", by: "state", columns: ["title"], empty: "No todos" }),
      "TeamTasks.Todo",
      "missing group field",
    );
  });

  it("throws on missing and unknown group values", async () => {
    const seen: SeenCall[] = [];
    const missingCtx = boardContext(seen, {
      rows: [row("a", { title: "x" })],
      columns: [titleCol, stateCol],
    });
    await rejectsWith(
      () =>
        board({
          context: missingCtx,
          model: "TeamTasks.Todo",
          by: "state",
          columns: ["title"],
          empty: "No todos",
        }),
      "TeamTasks.Todo",
      'row "a"',
      'needs a group value for "state"',
    );
    const nullCtx = boardContext(seen, {
      rows: [row("b", { title: "x", state: null })],
      columns: [titleCol, stateCol],
    });
    await rejectsWith(
      () =>
        board({
          context: nullCtx,
          model: "TeamTasks.Todo",
          by: "state",
          columns: ["title"],
          empty: "No todos",
        }),
      'row "b"',
      "needs a group value",
    );
    const unknownCtx = boardContext(seen, {
      rows: [row("c", { title: "x", state: "archived" })],
      columns: [titleCol, stateCol],
    });
    await rejectsWith(
      () =>
        board({
          context: unknownCtx,
          model: "TeamTasks.Todo",
          by: "state",
          columns: ["title"],
          empty: "No todos",
        }),
      'row "c"',
      "unknown group",
      '"archived"',
    );
  });

  it("rejects every appearance token", async () => {
    const seen: SeenCall[] = [];
    const context = boardContext(seen, { rows: [], columns: [titleCol, stateCol] });
    const base = {
      context,
      model: "TeamTasks.Todo",
      by: "state",
      columns: ["title"] as readonly string[],
      empty: "No todos" as const,
    };
    for (const extra of [
      { tone: "primary" },
      { size: "lg" },
      { variant: "soft" },
      { orientation: "vertical" },
    ]) {
      await rejectsWith(
        () => board({ ...base, ...extra } as unknown as Parameters<typeof board>[0]),
        "admits no appearance",
      );
    }
    assert.equal(seen.length, 0);
  });
});

// ---------------------------------------------------------------------------
// C7 csvImport (additive; all suites above stay untouched).
// ---------------------------------------------------------------------------

describe("csvImport", () => {
  it("renders a multipart upload panel posting to the caller path", async () => {
    const context = makeContext();
    const page = await loadHtml(
      await csvImport({ context, postTo: "/todos/import", label: "Import todos" }),
    );
    try {
      const heading = page.document.querySelector("section > h2");
      assert.ok((heading?.textContent ?? "").includes("Import todos"));
      const form = page.document.querySelector("form");
      assert.ok(form !== null);
      assert.equal(form.getAttribute("action"), "/todos/import");
      assert.equal(form.getAttribute("method"), "post");
      assert.equal(form.getAttribute("enctype"), "multipart/form-data");
      const csrf = form.querySelector('input[type="hidden"][name="_csrf"]') as unknown as {
        value: string;
      } | null;
      assert.equal(csrf?.value, "csrf-123");
      const file = form.querySelector('input[type="file"][name="file"]');
      assert.ok(file !== null);
      assert.ok((file.getAttribute("accept") ?? "").includes(".csv"));
      const submit = form.querySelector('button[type="submit"]');
      assert.ok((submit?.textContent ?? "").includes("Upload"));
      assert.equal(page.document.querySelector("table"), null);
    } finally {
      await page.close();
    }
  });

  it("never invents an endpoint: hostile postTo falls back to #", async () => {
    const context = makeContext();
    const page = await loadHtml(
      await csvImport({ context, postTo: "javascript:steal()", label: "Import" }),
    );
    try {
      assert.equal(page.document.querySelector("form")?.getAttribute("action"), "#");
    } finally {
      await page.close();
    }
  });

  it("renders the review table with formula-armored cells", async () => {
    const context = makeContext();
    const page = await loadHtml(
      await csvImport({
        context,
        postTo: "/todos/import",
        label: "Import todos",
        review: {
          columns: ["Name", "Note"],
          rows: [
            ["=SUM(A1:A2)", "plain"],
            ["+5", "-3"],
            ["@mention", " leading space"],
          ],
        },
      }),
    );
    try {
      const section = page.document.querySelectorAll("section").item(1);
      assert.ok(section !== null);
      assert.ok((section.querySelector("h3")?.textContent ?? "").includes("Preview"));
      const heads = section.querySelectorAll("thead th");
      assert.equal(heads.length, 2);
      assert.equal(heads.item(0)?.getAttribute("scope"), "col");
      const cells = section.querySelectorAll("tbody td");
      assert.equal(cells.length, 6);
      assert.equal(cells.item(0)?.textContent, `\u2068'=SUM(A1:A2)\u2069`);
      assert.equal(cells.item(1)?.textContent, `\u2068plain\u2069`);
      assert.equal(cells.item(2)?.textContent, `\u2068'+5\u2069`);
      assert.equal(cells.item(3)?.textContent, `\u2068'-3\u2069`);
      assert.equal(cells.item(4)?.textContent, `\u2068'@mention\u2069`);
      assert.equal(cells.item(5)?.textContent, `\u2068' leading space\u2069`);
    } finally {
      await page.close();
    }
  });

  it("escapes hostile labels, headers and armored cells", async () => {
    const hostile = `<img src=x onerror=alert(1)>`;
    const context = makeContext();
    const html = await csvImport({
      context,
      postTo: "/todos/import",
      label: hostile,
      review: { columns: [hostile], rows: [[`=${hostile}`]] },
    });
    assert.ok(!html.includes(hostile));
    assert.ok(html.includes(`\u2068&#39;=&lt;img`));
    const page = await loadHtml(html);
    try {
      assert.equal(page.document.querySelector("img"), null);
    } finally {
      await page.close();
    }
  });

  it("localizes chrome and captions in order", async () => {
    const context = makeContext({ preferredLocales: ["nl"] });
    const html = await csvImport({
      context,
      postTo: "/todos/import",
      label: message("Import todos", { nl: "Todo's importeren" }),
      review: { columns: [message("Name", { nl: "Naam" })], rows: [["x"]] },
    });
    assert.ok(html.includes("Todo&#39;s importeren"));
    assert.ok(html.includes("CSV-bestand"));
    assert.ok(html.includes(">Uploaden</button>"));
    assert.ok(html.includes("<th scope=\"col\">Naam</th>"));
    const en = await csvImport({
      context: makeContext(),
      postTo: "/todos/import",
      label: message("Import todos", { nl: "Todo's importeren" }),
    });
    assert.ok(en.includes("CSV file"));
    assert.ok(en.includes(">Upload</button>"));
  });

  it("rejects a missing postTo", async () => {
    const context = makeContext();
    for (const postTo of ["", "   ", 7, null, undefined]) {
      await rejectsWith(
        () => csvImport({ context, postTo: postTo as unknown as string, label: "Import" }),
        "csvImport needs a non-empty postTo",
      );
    }
  });

  it("rejects an empty label", async () => {
    const context = makeContext();
    await rejectsWith(
      () => csvImport({ context, postTo: "/todos/import", label: "" }),
      "csvImport label must not be empty",
    );
    await rejectsWith(
      () =>
        csvImport({
          context,
          postTo: "/todos/import",
          label: message("", { nl: "" }),
        }),
      "csvImport label must not be empty",
    );
  });

  it("fails closed on an empty preview", async () => {
    const context = makeContext();
    await rejectsWith(
      () =>
        csvImport({
          context,
          postTo: "/todos/import",
          label: "Import",
          review: { columns: ["Name"], rows: [] },
        }),
      "csvImport review needs a nonempty preview",
    );
    await rejectsWith(
      () =>
        csvImport({
          context,
          postTo: "/todos/import",
          label: "Import",
          review: { columns: [], rows: [["x"]] },
        }),
      "csvImport review needs nonempty columns",
    );
  });

  it("rejects ragged and non-string preview rows", async () => {
    const context = makeContext();
    await rejectsWith(
      () =>
        csvImport({
          context,
          postTo: "/todos/import",
          label: "Import",
          review: { columns: ["A", "B"], rows: [["only-one"]] },
        }),
      "csvImport review row 0 needs exactly 2 cells",
    );
    await rejectsWith(
      () =>
        csvImport({
          context,
          postTo: "/todos/import",
          label: "Import",
          review: { columns: ["A"], rows: [[42] as unknown as string[]] },
        }),
      "csvImport review row 0 cells must be strings",
    );
    await rejectsWith(
      () =>
        csvImport({
          context,
          postTo: "/todos/import",
          label: "Import",
          review: 7 as unknown as never,
        }),
      "csvImport review must be an object",
    );
  });

  it("rejects every appearance token", async () => {
    const context = makeContext();
    for (const extra of [
      { tone: "primary" },
      { size: "lg" },
      { variant: "soft" },
      { orientation: "horizontal" },
    ]) {
      await rejectsWith(
        () =>
          csvImport({
            context,
            postTo: "/x",
            label: "Import",
            ...extra,
          } as unknown as Parameters<typeof csvImport>[0]),
        "admits no appearance",
      );
    }
  });
});
