import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresentationContext } from "../../contracts/src/presentation.js";
import {
  isReadableSelector,
  policyDumpSections,
  policyPage,
  resolveReadableSelector,
  selectReadableLeaves,
  type PolicyDump,
  type ReadableModelSchema,
} from "../src/policyPage.js";

function makeContext(overrides: Partial<PresentationContext> = {}): PresentationContext {
  return {
    preferredLocales: [],
    appDefaultLocale: "en",
    theme: { mode: "system", accent: "blue", density: "comfortable" },
    path: "/policy",
    isPartial: false,
    csrfToken: "csrf-123",
    principal: null,
    invocation: null,
    query: async () => ({ rows: [], columns: [] }),
    ...overrides,
  };
}

function makeDump(): PolicyDump {
  return {
    version: 1,
    roles: [
      {
        package: "expenses",
        name: "reviewer",
        canonical: "expenses.reviewer",
        label: "Chief Auditor",
      },
    ],
    models: [
      {
        canonical: "expenses.Invoice",
        policies: [
          {
            kind: "read",
            grantee: "members",
            where: "row.owner==actor",
            source: "policy Invoice read=members where=row.owner==actor",
          },
        ],
        invariants: [
          {
            predicate: "row.total.minor>0",
            source: "invariant Invoice: row.total.minor>0",
          },
        ],
      },
    ],
    operations: [
      {
        canonical: "expenses.approve",
        kind: "scenario",
        by: "reviewer",
        requires: ["expense.status==submitted"],
        source: "scenario approve(expense:Invoice) by=reviewer",
      },
    ],
  };
}

describe("policyDumpSections", () => {
  it("maps every dump entry to review() policy props with zero invented text", () => {
    const sections = policyDumpSections(makeDump());
    assert.equal(sections.length, 3);
    assert.deepEqual(
      sections.map((s) => s.heading),
      ["expenses.Invoice", "expenses.approve", "expenses.reviewer"],
    );
    assert.deepEqual(sections[0]?.policies, [
      {
        text: "policy Invoice read=members where=row.owner==actor",
        decision: "read=members",
        rationale: "row.owner==actor",
        actor: null,
        time: null,
      },
      {
        text: "invariant Invoice: row.total.minor>0",
        decision: null,
        rationale: "row.total.minor>0",
        actor: null,
        time: null,
      },
    ]);
    assert.deepEqual(sections[1]?.policies, [
      {
        text: "scenario approve(expense:Invoice) by=reviewer",
        decision: "reviewer",
        rationale: "expense.status==submitted",
        actor: null,
        time: null,
      },
    ]);
    assert.deepEqual(sections[2]?.policies, [
      {
        text: "Chief Auditor",
        decision: "expenses.reviewer",
        rationale: null,
        actor: null,
        time: null,
      },
    ]);
  });

  it("emits one entry per require so multi-require ops need no glue strings", () => {
    const dump = makeDump();
    const op = dump.operations[0];
    assert.ok(op);
    const sections = policyDumpSections({
      ...dump,
      models: [],
      roles: [],
      operations: [{ ...op, requires: ["a==1", "b==2"] }],
    });
    assert.equal(sections.length, 1);
    assert.equal(sections[0]?.policies.length, 2);
    assert.equal(sections[0]?.policies[0]?.rationale, "a==1");
    assert.equal(sections[0]?.policies[1]?.rationale, "b==2");
  });

  it("rejects malformed dumps instead of rendering guesses", () => {
    assert.throws(
      () => policyDumpSections({ version: 2, roles: [], models: [], operations: [] } as unknown as PolicyDump),
      /version/,
    );
    assert.throws(
      () => policyDumpSections({ version: 1, roles: [], models: [], operations: "nope" } as unknown as PolicyDump),
      /operations/,
    );
    assert.throws(() => policyDumpSections(null as unknown as PolicyDump), /dump/);
  });
});

describe("policyPage", () => {
  it("renders every dump string through review() sections", async () => {
    const html = await policyPage({ context: makeContext(), dump: makeDump() });
    for (const marker of [
      "expenses.Invoice",
      "expenses.approve",
      "expenses.reviewer",
      "Chief Auditor",
      "policy Invoice read=members where=row.owner==actor",
      "read=members",
      "row.owner==actor",
      "invariant Invoice: row.total.minor&gt;0",
      "row.total.minor&gt;0",
      "scenario approve(expense:Invoice) by=reviewer",
      "expense.status==submitted",
    ]) {
      assert.ok(html.includes(marker), `missing marker: ${marker}`);
    }
    // review() chrome per entry (3 entries + 1 invariant = 4 reviews).
    assert.equal((html.match(/<dl>/g) ?? []).length, 4);
  });

  it("renders an empty dump with sections but no policy strings", async () => {
    const html = await policyPage({
      context: makeContext(),
      dump: { version: 1, roles: [], models: [], operations: [] },
    });
    assert.ok(html.startsWith("<section"), "section shell");
    assert.ok(!html.includes("<dl>"), "no review entries");
  });

  it("escapes dump-controlled headings", async () => {
    const dump = makeDump();
    const model = dump.models[0];
    assert.ok(model);
    const html = await policyPage({
      context: makeContext(),
      dump: { ...dump, models: [{ ...model, canonical: 'x"><script>alert(1)</script>' }] },
    });
    assert.ok(!html.includes("<script>"), "no raw script");
    assert.ok(html.includes("x&quot;&gt;&lt;script&gt;"), "escaped heading");
  });
});

const PARITY_MODEL: ReadableModelSchema = {
  fields: {
    title: { kind: "scalar" },
    owner: { kind: "reference" },
    amount: { kind: "money" },
    request: { kind: "delivery" },
    shipment: { kind: "delivery", opaque: true },
  },
  parent: "Program",
};

describe("readable selectors (A5 T08 parity)", () => {
  it("S1: accepts bare id/version roots as terminal metadata (A pin a5_s1_ui_columns_accept_id_version)", () => {
    const selection = selectReadableLeaves(PARITY_MODEL, ["id", "version", "title", "created"]);
    assert.deepEqual(
      selection.resolved.map((entry) => [entry.selector, entry.leaf]),
      [
        ["id", "metadata"],
        ["version", "metadata"],
        ["title", "field"],
        ["created", "metadata"],
      ],
    );
    assert.deepEqual(selection.failed, []);
    for (const entry of selection.resolved) {
      assert.equal(entry.fact, null);
      assert.equal(entry.permission, null);
      assert.equal(entry.writable, false);
    }
  });

  it("S1: rejects id/version descent (A pin a5_s1_id_version_descent_rejected)", () => {
    for (const selector of ["id.tag", "version.n"]) {
      const result = resolveReadableSelector(PARITY_MODEL, selector);
      assert.equal(result.ok, false);
      assert.ok(result.ok === false && result.reason.includes("descends past terminal metadata"));
    }
  });

  it("S2: accepts delivery leaves in projections, rejects them in predicates", () => {
    const projected = resolveReadableSelector(PARITY_MODEL, "request.status", "projection");
    assert.equal(projected.ok, true);
    assert.ok(projected.ok && projected.leaf === "delivery");
    const defaulted = resolveReadableSelector(PARITY_MODEL, "request.status");
    assert.equal(defaulted.ok, true);
    const predicated = resolveReadableSelector(PARITY_MODEL, "request.status", "predicate");
    assert.equal(predicated.ok, false);
    assert.deepEqual(
      predicated.ok === false ? predicated.reason : null,
      `selector "request.status" addresses delivery 'request' in a predicate: ` +
        `delivery leaves resolve only in projections, never in filter=/search=`,
    );
  });

  it("S2: helpers thread the predicate context; bare delivery roots stay readable", () => {
    assert.equal(isReadableSelector(PARITY_MODEL, "request.result", "predicate"), false);
    assert.equal(isReadableSelector(PARITY_MODEL, "request.result"), true);
    assert.equal(isReadableSelector(PARITY_MODEL, "request", "predicate"), true);
    const selection = selectReadableLeaves(PARITY_MODEL, ["request.error", "title"], "predicate");
    assert.deepEqual(
      selection.resolved.map((entry) => entry.selector),
      ["title"],
    );
    assert.deepEqual(
      selection.failed.map((entry) => entry.selector),
      ["request.error"],
    );
  });

  it("S2: rejects unknown contexts with a TypeError", () => {
    assert.throws(
      () => resolveReadableSelector(PARITY_MODEL, "title", "filter" as never),
      new TypeError("resolveReadableSelector: context must be 'projection' or 'predicate'"),
    );
  });

  it("S3: opaque delivery fields defer progress and unknown interiors (CanChat:28 shape)", () => {
    for (const selector of ["shipment.progress.state", "shipment.progress.detail", "shipment.bogus"]) {
      const result = resolveReadableSelector(PARITY_MODEL, selector);
      assert.equal(result.ok, true, selector);
      assert.ok(result.ok && result.leaf === "deferred", selector);
      assert.ok(result.ok && result.fact === null && result.writable === false, selector);
    }
  });

  it("S3/N1: opaque delivery known leaves stay terminal (mirrors A E2013 pin)", () => {
    for (const leaf of ["id", "status", "error", "result"]) {
      const terminal = resolveReadableSelector(PARITY_MODEL, `shipment.${leaf}`);
      assert.equal(terminal.ok, true, leaf);
      assert.ok(terminal.ok && terminal.leaf === "deferred", leaf);
      const past = resolveReadableSelector(PARITY_MODEL, `shipment.${leaf}.x`);
      assert.equal(past.ok, false, leaf);
      assert.deepEqual(
        past.ok === false ? past.reason : null,
        `selector "shipment.${leaf}.x" descends past terminal delivery leaf '${leaf}'`,
        leaf,
      );
    }
  });

  it("S3: declared delivery fields still reject progress and unknown members", () => {
    const progress = resolveReadableSelector(PARITY_MODEL, "request.progress.state");
    assert.equal(progress.ok, false);
    assert.ok(
      progress.ok === false && progress.reason.includes("nested progress needs receipt-observation"),
    );
    const unknown = resolveReadableSelector(PARITY_MODEL, "request.bogus");
    assert.equal(unknown.ok, false);
    assert.ok(unknown.ok === false && unknown.reason.includes("unknown member 'bogus'"));
  });

  it("S3: opaque models defer unknown roots but resolve declared paths normally", () => {
    const opaque: ReadableModelSchema = { ...PARITY_MODEL, opaque: true };
    const deferred = resolveReadableSelector(opaque, "whatever.deep.path");
    assert.equal(deferred.ok, true);
    assert.ok(deferred.ok && deferred.leaf === "deferred");
    const plain = resolveReadableSelector(PARITY_MODEL, "whatever");
    assert.equal(plain.ok, false);
    assert.deepEqual(plain.ok === false ? plain.reason : null, "unknown member 'whatever'");
    assert.equal(isReadableSelector(opaque, "title"), true);
    assert.equal(isReadableSelector(opaque, "parent"), true);
    assert.equal(isReadableSelector(opaque, "created"), true);
  });

  it("S4 pin: reference interiors stay rejected in projections and predicates (A a5_s4_ui_columns_reference_interior_e4012)", () => {
    for (const context of ["projection", "predicate"] as const) {
      const declared = resolveReadableSelector(PARITY_MODEL, "owner.id", context);
      assert.equal(declared.ok, false, context);
      assert.deepEqual(
        declared.ok === false ? declared.reason : null,
        `selector "owner.id" traverses reference 'owner': ` +
          `selectors cannot grant another record's fields`,
        context,
      );
    }
  });

  it("S4 pin: reserved-root reference interiors stay rejected, created_by.id (A a5_s4_ui_filter_reserved_reference_e4012)", () => {
    for (const context of ["projection", "predicate"] as const) {
      const reserved = resolveReadableSelector(PARITY_MODEL, "created_by.id", context);
      assert.equal(reserved.ok, false, context);
      assert.deepEqual(
        reserved.ok === false ? reserved.reason : null,
        `selector "created_by.id" descends past terminal metadata 'created_by'`,
        context,
      );
    }
  });
});
