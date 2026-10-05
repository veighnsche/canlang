import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PresentationContext } from "../../contracts/src/presentation.js";
import {
  policyDumpSections,
  policyPage,
  type PolicyDump,
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
