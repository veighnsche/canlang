import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  ColumnMeta,
  ListQueryArgs,
  ListQueryResult,
  PresentationContext,
  RowQueryRunner,
  RowView,
} from "../../contracts/src/presentation.js";
import { list, table } from "../src/collections.js";
import { renderState, rowHeading } from "../src/components.js";
import { escapeAttr } from "../src/escape.js";
import { message } from "../src/messages.js";

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
      empty: "No todos",
      renderRow: () => [],
    });
    assert.deepEqual(seen[0]?.args, {
      parent: { id: "p-1" },
      where,
      limit: 10,
      cursor: "c-1",
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
    assert.ok(html.includes("<thead><tr><th>Title</th><th>Count</th></tr></thead>"));
    assert.ok(html.includes("<tbody><tr><td>Buy milk</td><td>1,234,567</td></tr></tbody>"));
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
    assert.ok(en.includes("<th>Title</th>"));
    const nl = await table({
      context: tableContext(seen, result, { preferredLocales: ["nl"] }),
      model: "TeamTasks.Todo",
      columns: ["title"],
      empty: "No todos",
    });
    assert.ok(nl.includes("<th>Titel</th>"));
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
    assert.ok(html.includes("<td>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</td>"));
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
    assert.ok(html.includes("<th>&lt;b&gt;Hi&lt;/b&gt;</th>"));
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
    assert.ok(html.includes("<td>$123.45</td>"));
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
    assert.ok(html.includes(`<td>${expected}</td>`));
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
    assert.ok(html.includes(`<td>${rowHeading(nested, ownerLabel, context)}</td>`));
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
    assert.ok(html.includes(`<td>${rowHeading(nested, ownerLabel, context)}</td>`));
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
    assert.ok(html.includes("<td>&lt;doc-1&gt;</td>"));
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
      columns: ["title"],
      empty: "No todos",
    });
    assert.strictEqual(seen[0]?.invocation, invocation);
    assert.equal(seen[0]?.model, "TeamTasks.Todo");
    assert.deepEqual(seen[0]?.args, { parent: { id: "p-2" }, where, limit: 5, cursor: "c-2" });
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
