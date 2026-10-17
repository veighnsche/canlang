import {
  any,
  require as check,
  count,
  compareDate,
  add_days,
  local_date,
  create,
  date,
  datetime,
  equalMoney,
  hasRole,
  int64,
  money,
  records,
  same,
  set,
} from "@canlang/stdlib";
import {
  actions,
  card,
  edit,
  form,
  history,
  list,
  message,
  renderPage,
  tab,
  table,
  tabs,
  text,
} from "@canlang/ui";
import { can_work, Employee } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";

/* Handwritten desired target; every import is a proposed, unimplemented contract.
 * See DESIGN §13. The registry is linked once. Trusted c carries invocation data
 * and inherited query authority; records(c,model,{parent?,where?,order?,limit?,archived?})
 * preserves owner/team bounds, expiry and work limits. Viewer grants apply before
 * filtering and aggregation; pure derives inherit caller mode. Limits reject excess.
 * CRUD when callbacks inspect a normalized candidate before this write is staged;
 * final invariants see staged state. Shared admission owns versions, locks, replay
 * and atomic effects. UI factories own daisyUI/HTMX, schemas, escaping and grants.
 * No compiler, stdlib, renderer, adapter or example runner is implemented here.
 */

const reviewerCaption = message("Reviewer", { nl: "Beoordelaar" });

const receiptCaption = message("Receipt", { nl: "Bon" });

const approvedCaption = message("Approved", { nl: "Goedgekeurd" });

const submissionCaption = message("Submission revision", { nl: "Ingediende revisie" });

const decisionTimeCaption = message("Decision time", { nl: "Beslist op" });

const paidCaption = message("Payment date", { nl: "Betaaldatum" });

const reimbursementCaption = message("Evidenced reimbursement", { nl: "Onderbouwde vergoeding" });

export const appDefinition = {
  id: "CanExpense",
  uses: ["expense"],
  description: message(
    "Help workspace employees claim approved travel between locations, emergency supplies, and other out-of-pocket operating expenses.",
    {
      nl: "Help werkplekmedewerkers goedgekeurde reizen tussen locaties, noodbenodigdheden en andere voorgeschoten bedrijfskosten declareren.",
    },
  ),
  packages: {
    expense: {
      label: message("Expenses", { nl: "Onkosten" }),
      description: message(
        "Keep private employee claims, review revisions and reimbursement evidence separate.",
        { nl: "Houd privédeclaraties, beoordelingsrevisies en vergoedingsbewijs gescheiden." },
      ),
      roles: {
        reviewer: { id: "expense.reviewer", label: reviewerCaption },
        finance: { id: "expense.finance", label: message("Finance", { nl: "Financiën" }) },
      },
    },
  },
  models: {
    "expense.Expense": {
      parent: Employee,
      label: message("Expense claim", { nl: "Onkostendeclaratie" }),
      fields: {
        location: { type: Location },
        corrects: {
          type: "expense.Expense",
          nullable: true,
          label: message("Corrected claim", { nl: "Gecorrigeerde declaratie" }),
        },
        authorization: {
          type: "text",
          nullable: true,
          label: message("Job or purchase authorization reference", {
            nl: "Werk- of inkoopautorisatiereferentie",
          }),
        },
        purpose: { type: "text", trim: true, min: 1n, label: message("Purpose", { nl: "Doel" }) },
        category: { type: "text", label: message("Category", { nl: "Categorie" }) },
        amount: { type: "money" },
        business_date: { type: "date", label: message("Business date", { nl: "Kostendatum" }) },
        receipt: { type: "file", label: receiptCaption },
        reviewer: { type: "user", label: reviewerCaption },
        status: {
          type: "enum",
          cases: ["draft", "submitted", "approved", "rejected", "reimbursed"],
          default: "draft",
          label: {
            text: message("Status", { nl: "Status" }),
            values: {
              draft: message("Draft", { nl: "Concept" }),
              submitted: message("Submitted", { nl: "Ingediend" }),
              approved: approvedCaption,
              rejected: message("Rejected", { nl: "Afgewezen" }),
              reimbursed: message("Reimbursed", { nl: "Vergoed" }),
            },
          },
        },
        submission: { type: "int", default: 0n, label: submissionCaption },
        decision: { type: "text", nullable: true, label: message("Decision", { nl: "Besluit" }) },
        decided_by: {
          type: "user",
          nullable: true,
          label: message("Decision maker", { nl: "Beslist door" }),
        },
        decided_at: { type: "datetime", nullable: true, label: decisionTimeCaption },
      },
      readGrants: [
        { rule: "Expense.read.1" },
        { rule: "Expense.read.2" },
        { rule: "Expense.read.3" },
      ],
      invariants: ["Expense.require.1", "Expense.require.2"],
      locks: ["Expense.lock.1", "Expense.lock.2"],
    },
    "expense.Decision": {
      parent: "expense.Expense",
      label: message("Expense decision", { nl: "Onkostenbesluit" }),
      fields: {
        submission: { type: "int", label: submissionCaption },
        amount: { type: "money" },
        receipt: { type: "file", label: receiptCaption },
        reviewer: { type: "user", label: reviewerCaption },
        approved: { type: "bool", label: approvedCaption },
        reason: { type: "text" },
        decided_at: { type: "datetime", label: decisionTimeCaption },
      },
      readGrants: [{ rule: "Decision.read.1" }],
      locks: ["Decision.lock.1"],
    },
    "expense.Reimbursement": {
      parent: "expense.Expense",
      label: reimbursementCaption,
      fields: {
        amount: { type: "money" },
        reference: { type: "text", trim: true, min: 1n },
        paid: { type: "date", label: paidCaption },
        reason: { type: "text" },
        recorded_by: {
          type: "user",
          server: "actor",
          label: message("Recorded by", { nl: "Vastgelegd door" }),
        },
      },
      readGrants: [{ rule: "Reimbursement.read.1" }],
      locks: ["Reimbursement.lock.1"],
    },
  },
  preferences: {
    expense: {
      fields: { status: { type: "expense.Expense.status", nullable: true, default: null } },
    },
  },
  operations: {
    "expense.Expense.create": {
      handler: "createExpense",
      kind: "create",
      model: "expense.Expense",
      by: "members",
      read: false,
      inputs: {
        parent: { type: Employee },
        fields: [
          "location",
          "authorization",
          "purpose",
          "category",
          "amount",
          "business_date",
          "receipt",
          "reviewer",
        ],
      },
      when: "Expense",
    },
    "expense.Expense.update": {
      handler: "updateExpense",
      kind: "update",
      model: "expense.Expense",
      by: "members",
      read: false,
      inputs: {
        record: { type: "expense.Expense" },
        changes: {
          fields: [
            "location",
            "authorization",
            "purpose",
            "category",
            "amount",
            "business_date",
            "receipt",
            "reviewer",
          ],
        },
      },
      when: "Expense",
    },
    "expense.submit": {
      handler: "submit",
      by: "members",
      read: false,
      inputs: { expense: { type: "expense.Expense" } },
      description: message("Submit your draft after checking the active, distinct reviewer.", {
        nl: "Dien je concept in na controle van een actieve, andere beoordelaar.",
      }),
    },
    "expense.decide": {
      handler: "decide",
      by: "expense.reviewer",
      read: false,
      inputs: {
        expense: { type: "expense.Expense" },
        approve: { type: "bool", label: approvedCaption },
        reason: { type: "text" },
      },
      label: message("Record decision", { nl: "Besluit vastleggen" }),
      description: message(
        "Decide exactly the submitted amount and receipt; rejection needs a reason.",
        { nl: "Beslis over precies het ingediende bedrag en de bon; afwijzing vereist een reden." },
      ),
    },
    "expense.correct": {
      handler: "correct",
      by: "members",
      read: false,
      inputs: { expense: { type: "expense.Expense" } },
      label: message("Create correction draft", { nl: "Correctieconcept maken" }),
      description: message(
        "Create a corrected draft while preserving the rejected claim and its decision.",
        {
          nl: "Maak een gecorrigeerd concept met behoud van de afgewezen declaratie en het besluit.",
        },
      ),
    },
    "expense.reimburse": {
      handler: "reimburse",
      by: "expense.finance",
      read: false,
      inputs: {
        expense: { type: "expense.Expense" },
        amount: { type: "money" },
        reference: { type: "text" },
        paid: { type: "date", label: paidCaption },
        reason: { type: "text" },
      },
      label: message("Record reimbursement", { nl: "Vergoeding vastleggen" }),
      description: message(
        "Record one full same-currency reimbursement with external payment evidence.",
        { nl: "Leg één volledige vergoeding in dezelfde valuta vast met extern betalingsbewijs." },
      ),
    },
  },
  pages: [
    { path: "/expenses/mine", render: minePage },
    { path: "/expenses/review", render: reviewPage },
  ],
  disabled: ["expense.Expense.delete"],
};

export function canApp() {
  const crudWhen = {
    Expense: async (c, row) =>
      same(row.parent.user, c.actor) &&
      row.parent.active &&
      row.status === "draft" &&
      (await can_work(c, c.actor, row.location)),
  };
  return {
    crudWhen,

    read: {
      "Expense.read.1": (c, row) => hasRole(c, "authenticated") && same(row.parent.user, c.actor),
      "Expense.read.2": async (c, row) =>
        hasRole(c, "expense.reviewer") &&
        same(row.reviewer, c.actor) &&
        (await can_work(c, c.actor, row.location)) &&
        row.status !== "draft",
      "Expense.read.3": async (c, row) =>
        hasRole(c, "expense.finance") && (await can_work(c, c.actor, row.location)),
      "Decision.read.1": async (c, row) =>
        hasRole(c, "authenticated") &&
        (same(row.parent.parent.user, c.actor) ||
          (hasRole(c, "expense.reviewer") &&
            same(row.parent.reviewer, c.actor) &&
            (await can_work(c, c.actor, row.parent.location))) ||
          (hasRole(c, "expense.finance") && (await can_work(c, c.actor, row.parent.location)))),
      "Reimbursement.read.1": async (c, row) =>
        hasRole(c, "authenticated") &&
        (same(row.parent.parent.user, c.actor) ||
          (hasRole(c, "expense.finance") && (await can_work(c, c.actor, row.parent.location)))),
    },
    invariants: {
      "Expense.require.2": (c, row) =>
        row.corrects === null ||
        (same(row.corrects.parent, row.parent) && row.corrects.status === "rejected"),
      "Expense.require.1": (c, row) =>
        row.amount.minor > 0n && row.amount.currency === row.location.currency,
    },
    locks: {
      "Expense.lock.2": { fields: ["corrects"] },
      "Expense.lock.1": {
        fields: [
          "location",
          "authorization",
          "purpose",
          "category",
          "amount",
          "business_date",
          "receipt",
          "reviewer",
        ],
        when: (c, row) => row.status !== "draft",
      },
      "Decision.lock.1": {
        fields: ["submission", "amount", "receipt", "reviewer", "approved", "reason", "decided_at"],
      },
      "Reimbursement.lock.1": { fields: ["amount", "reference", "paid", "reason", "recorded_by"] },
    },
    async createExpense(c, input) {
      check(hasRole(c, "members"), "forbidden");
      await create(c, "expense.Expense", input, { when: crudWhen.Expense });
    },
    async updateExpense(c, { record, changes }) {
      check(hasRole(c, "members"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Expense });
    },
    async submit(c, { expense }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(expense.parent.user, c.actor) &&
          expense.parent.active &&
          expense.status === "draft" &&
          !same(expense.reviewer, c.actor) &&
          (await can_work(c, expense.reviewer, expense.location)),
      );
      await set(c, expense, { status: "submitted", submission: int64(expense.submission + 1n) });
    },
    async decide(c, { expense, approve, reason }) {
      check(hasRole(c, "expense.reviewer"), "forbidden");
      check(
        expense.status === "submitted" &&
          same(expense.reviewer, c.actor) &&
          !same(expense.parent.user, c.actor) &&
          (await can_work(c, c.actor, expense.location)) &&
          (approve || reason.trim() !== ""),
      );
      await create(c, "expense.Decision", {
        parent: expense,
        submission: expense.submission,
        amount: expense.amount,
        receipt: expense.receipt,
        reviewer: c.actor,
        approved: approve,
        reason,
        decided_at: c.now,
      });
      if (approve)
        await set(c, expense, {
          status: "approved",
          decision: reason,
          decided_by: c.actor,
          decided_at: c.now,
        });
      else
        await set(c, expense, {
          status: "rejected",
          decision: reason,
          decided_by: c.actor,
          decided_at: c.now,
        });
    },
    async correct(c, { expense }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(expense.parent.user, c.actor) &&
          expense.status === "rejected" &&
          expense.parent.active &&
          (await can_work(c, c.actor, expense.location)) &&
          !(await any(records(c, "expense.Expense"), (replacement) =>
            same(replacement.corrects, expense),
          )),
      );
      await create(c, "expense.Expense", {
        parent: expense.parent,
        corrects: expense,
        authorization: expense.authorization,
        location: expense.location,
        purpose: expense.purpose,
        category: expense.category,
        amount: expense.amount,
        business_date: expense.business_date,
        receipt: expense.receipt,
        reviewer: expense.reviewer,
        submission: expense.submission,
      });
    },
    async reimburse(c, { expense, amount, reference, paid, reason }) {
      check(hasRole(c, "expense.finance"), "forbidden");
      check(
        (await can_work(c, c.actor, expense.location)) &&
          expense.status === "approved" &&
          equalMoney(amount, expense.amount) &&
          reference.trim() !== "" &&
          reason.trim() !== "" &&
          compareDate(paid, local_date(c.now, expense.location.timezone)) <= 0 &&
          (await count(records(c, "expense.Reimbursement", { parent: expense }))) === 0n &&
          !(await any(
            records(c, "expense.Reimbursement"),
            (payment) => payment.reference === reference.trim(),
          )),
      );
      await create(c, "expense.Reimbursement", {
        parent: expense,
        amount,
        reference: reference.trim(),
        paid,
        reason,
      });
      await set(c, expense, { status: "reimbursed" });
    },
  };
}

export async function minePage(c) {
  check(hasRole(c, "members"), "forbidden");
  return renderPage(
    c,
    {
      owner: "expense",
      path: "/expenses/mine",
      title: message("My expenses", { nl: "Mijn onkosten" }),
      description: message("Submit your receipts and see their private decision history.", {
        nl: "Dien je bonnen in en bekijk hun privébesluithistorie.",
      }),
    },
    () => [
      card({
        context: c,
        title: message("Claim intake", { nl: "Declaratie aanmaken" }),
        children: [form({ context: c, operation: "expense.Expense.create" })],
      }),
      list({
        context: c,
        model: "expense.Expense",
        where: (row) => same(row.parent.user, c.actor),
        order: ["-business_date"],
        filter: ["status", "location", "category", "business_date"],
        defaults: { status: c.preferences.expense.status },
        display: "split",
        renderRow: (expense, view) => [
          card({
            context: view,
            title: message("Own claim and receipt", { nl: "Eigen declaratie en bon" }),
            children: [
              text({
                context: view,
                values: [
                  expense.purpose,
                  expense.authorization,
                  expense.corrects,
                  expense.business_date,
                  expense.amount,
                  expense.receipt,
                  expense.status,
                  expense.submission,
                  expense.decision,
                ],
              }),
              edit({ context: view, operation: "expense.Expense.update", record: expense }),
              actions({
                context: view,
                operations: ["expense.submit", "expense.correct"],
                boundArgs: { expense },
              }),
            ],
          }),
          list({
            context: view,
            model: "expense.Decision",
            parent: expense,
            renderRow: (row, v) =>
              text({
                context: v,
                values: [
                  row.submission,
                  row.amount,
                  row.receipt,
                  row.approved,
                  row.reason,
                  row.decided_at,
                ],
              }),
          }),
          list({
            context: view,
            model: "expense.Reimbursement",
            parent: expense,
            renderRow: (row, v) =>
              text({ context: v, values: [row.reference, row.amount, row.paid, row.reason] }),
          }),
          history({ context: view, record: expense }),
        ],
      }),
    ],
  );
}

export async function reviewPage(c) {
  check(hasRole(c, "expense.reviewer") || hasRole(c, "expense.finance"), "forbidden");
  return renderPage(
    c,
    {
      owner: "expense",
      path: "/expenses/review",
      title: message("Expense review", { nl: "Onkostenbeoordeling" }),
      description: message(
        "Review assigned claims and record evidenced reimbursement under finance grants.",
        {
          nl: "Beoordeel toegewezen declaraties en leg onderbouwde vergoeding vast binnen financiële bevoegdheden.",
        },
      ),
    },
    () => [
      table({
        context: c,
        model: "expense.Expense",
        columns: ["parent", "location", "purpose", "business_date", "amount", "receipt", "status"],
        order: ["business_date"],
        filter: ["status", "location", "category", "business_date"],
        defaults: { status: c.preferences.expense.status },
        display: "split",
        renderRow: (expense, view) => [
          card({
            context: view,
            title: message("Frozen claim review", { nl: "Vastgelegde declaratie beoordelen" }),
            children: [
              text({
                context: view,
                values: [
                  expense.authorization,
                  expense.corrects,
                  expense.submission,
                  expense.reviewer,
                  expense.decision,
                  expense.decided_by,
                  expense.decided_at,
                ],
              }),
              actions({
                context: view,
                operations: ["expense.decide", "expense.reimburse"],
                boundArgs: { expense },
              }),
            ],
          }),
          tabs({
            context: view,
            children: [
              tab({
                context: view,
                caption: message("Recorded decisions", { nl: "Vastgelegde besluiten" }),
                children: [
                  list({
                    context: view,
                    model: "expense.Decision",
                    parent: expense,
                    renderRow: (row, v) =>
                      text({
                        context: v,
                        values: [
                          row.submission,
                          row.amount,
                          row.receipt,
                          row.reviewer,
                          row.approved,
                          row.reason,
                          row.decided_at,
                        ],
                      }),
                  }),
                ],
              }),
              tab({
                context: view,
                caption: reimbursementCaption,
                children: [
                  list({
                    context: view,
                    model: "expense.Reimbursement",
                    parent: expense,
                    renderRow: (row, v) =>
                      text({
                        context: v,
                        values: [row.reference, row.amount, row.paid, row.reason, row.recorded_by],
                      }),
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Awaiting reimbursement", { nl: "Wacht op vergoeding" }),
        children: [
          table({
            context: c,
            model: "expense.Expense",
            where: (expense) => expense.status === "approved",
            columns: ["parent", "location", "purpose", "amount", "receipt", "status"],
            filter: ["parent", "location", "category", "business_date"],
            display: "split",
            renderRow: (expense, view) =>
              actions({ context: view, operations: ["expense.reimburse"], boundArgs: { expense } }),
          }),
        ],
      }),
      card({
        context: c,
        title: message("Accounting evidence", { nl: "Boekhoudbewijs" }),
        children: [
          table({
            context: c,
            model: "expense.Reimbursement",
            columns: ["parent", "reference", "amount", "paid", "reason", "recorded_by"],
            order: ["-paid"],
            filter: ["paid"],
          }),
        ],
      }),
    ],
  );
}

/* Test-only fixture recipes and inline behavior examples. The future compiler
 * extracts these declarations and erases fixture-only imports from production.
 * Recipes retain identity; dependencies resolve before deferred value callbacks.
 * Each row provisions only seed/common-input/row dependencies and their closure.
 * Common bindings establish the baseline. Inputs, cells and expected values read
 * untouched seeded scope s; overrides apply together, observations use fresh scope.
 * No runner, provisioning implementation or Can-expression interpreter is added.
 */
export const exampleImports = [
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_site, test_worker } = imported;
  const receipt = { dependencies: [], file: async (c, s) => ({}) };
  const other_worker = {
    model: "employee.Employee",
    dependencies: [test_site],
    value: async (c, s) => ({
      user: s.other,
      home: s.test_site,
      locations: [s.test_site],
      start: date("2026-10-01"),
      role: "Reviewer",
    }),
  };
  const claim = {
    model: "expense.Expense",
    dependencies: [receipt, test_site, test_worker],
    value: async (c, s) => ({
      parent: s.test_worker,
      location: s.test_site,
      purpose: "Travel between sites",
      category: "Travel",
      amount: money(25n, "EUR"),
      business_date: date("2026-10-01"),
      receipt: s.receipt,
      reviewer: s.other,
    }),
  };
  const previous_claim = {
    model: "expense.Expense",
    dependencies: [test_worker, test_site, receipt],
    value: async (c, s) => ({
      parent: s.test_worker,
      location: s.test_site,
      purpose: "Earlier supplies",
      category: "Supplies",
      amount: money(25n, "EUR"),
      business_date: date("2026-10-01"),
      receipt: s.receipt,
      reviewer: s.other,
      status: "reimbursed",
    }),
  };
  const previous_payment = {
    model: "expense.Reimbursement",
    dependencies: [previous_claim],
    value: async (c, s) => ({
      parent: s.previous_claim,
      amount: money(25n, "EUR"),
      reference: "bank-previous",
      paid: date("2026-10-01"),
      reason: "Statement evidence",
    }),
  };
  const rejected_decision = {
    model: "expense.Decision",
    dependencies: [claim, receipt],
    value: async (c, s) => ({
      parent: s.claim,
      submission: 1n,
      amount: money(25n, "EUR"),
      receipt: s.receipt,
      reviewer: s.other,
      approved: false,
      reason: "Clarify the journey",
      decided_at: datetime("2026-10-02T09:00:00Z"),
    }),
  };
  return {
    claim,
    other_worker,
    receipt,
    rejected_decision,
    previous_claim,
    previous_payment,
    examples: [
      {
        operation: "expense.submit",
        seed: [other_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["expense.reviewer"],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => s.expense.submission,
          async (c, s) => s.expense.receipt,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [s.other],
            expected: async (c, s) => ["submitted", 1n, s.receipt],
          },
          { dependencies: [], values: async (c, s) => [s.self], error: "rule_failed" },
        ],
      },
      {
        operation: "expense.decide",
        seed: [other_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: [
          "as",
          "expense.parent",
          "expense.status",
          "expense.reviewer",
          "expense.submission",
          "approve",
          "reason",
        ],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => s.expense.receipt,
          async (c, s) => s.expense.decided_by,
          async (c, s) => await count(records(c, "expense.Decision", { parent: s.expense })),
          async (c, s) =>
            await any(
              records(c, "expense.Decision", { parent: s.expense }),
              (decision) =>
                decision.submission === 1n &&
                equalMoney(decision.amount, money(25n, "EUR")) &&
                same(decision.receipt, s.receipt) &&
                same(decision.reviewer, s.self) &&
                decision.approved === s.approve &&
                decision.reason === s.reason,
            ),
        ],
        rows: [
          {
            dependencies: [other_worker],
            values: async (c, s) => [
              "expense.reviewer",
              s.other_worker,
              "submitted",
              s.self,
              1n,
              true,
              "Checked the journey",
            ],
            expected: async (c, s) => ["approved", s.receipt, s.self, 1n, true],
          },
          {
            dependencies: [other_worker],
            values: async (c, s) => [
              "expense.reviewer",
              s.other_worker,
              "submitted",
              s.self,
              1n,
              false,
              "Clarify the journey",
            ],
            expected: async (c, s) => ["rejected", s.receipt, s.self, 1n, true],
          },
          {
            dependencies: [other_worker],
            values: async (c, s) => [
              "expense.reviewer",
              s.other_worker,
              "submitted",
              s.self,
              1n,
              false,
              "",
            ],
            error: "rule_failed",
          },
          {
            dependencies: [test_worker],
            values: async (c, s) => [
              "expense.reviewer",
              s.test_worker,
              "submitted",
              s.self,
              1n,
              true,
              "Checked the journey",
            ],
            error: "rule_failed",
          },
          {
            dependencies: [test_worker],
            values: async (c, s) => [
              "members",
              s.test_worker,
              "submitted",
              s.self,
              1n,
              true,
              "Checked the journey",
            ],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "expense.correct",
        seed: [other_worker, rejected_decision],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: [
          "expense.status",
          "expense.submission",
          "expense.decision",
          "expense.decided_by",
          "expense.decided_at",
        ],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => s.expense.receipt,
          async (c, s) => s.expense.decision,
          async (c, s) => s.expense.decided_by,
          async (c, s) => s.expense.decided_at,
          async (c, s) => await count(records(c, "expense.Decision", { parent: s.expense })),
          async (c, s) => s.rejected_decision.receipt,
          async (c, s) => s.rejected_decision.reason,
          async (c, s) => await count(records(c, "expense.Expense", { parent: s.expense.parent })),
          async (c, s) =>
            await any(
              records(c, "expense.Expense", { parent: s.expense.parent }),
              (replacement) =>
                same(replacement.corrects, s.expense) &&
                replacement.status === "draft" &&
                same(replacement.receipt, s.receipt) &&
                equalMoney(replacement.amount, money(25n, "EUR")) &&
                replacement.submission === 1n &&
                same(replacement.reviewer, s.other),
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "rejected",
              1n,
              "Clarify the journey",
              s.other,
              datetime("2026-10-02T09:00:00Z"),
            ],
            expected: async (c, s) => [
              "rejected",
              s.receipt,
              "Clarify the journey",
              s.other,
              datetime("2026-10-02T09:00:00Z"),
              1n,
              s.receipt,
              "Clarify the journey",
              2n,
              true,
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["submitted", 1n, null, null, null],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "expense.reimburse",
        seed: [previous_payment],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim, reason: "Bank statement" }),
        selectors: ["as", "expense.status", "amount", "reference", "paid"],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => await count(records(c, "expense.Reimbursement", { parent: s.expense })),
          async (c, s) =>
            await any(
              records(c, "expense.Reimbursement", { parent: s.expense }),
              (payment) =>
                payment.reference === "bank-new" && equalMoney(payment.amount, money(25n, "EUR")),
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "expense.finance",
              "approved",
              money(25n, "EUR"),
              " bank-new ",
              local_date(c.now, s.test_site.timezone),
            ],
            expected: async (c, s) => ["reimbursed", 1n, true],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "expense.finance",
              "approved",
              money(25n, "EUR"),
              "bank-previous",
              local_date(c.now, s.test_site.timezone),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "expense.finance",
              "approved",
              money(20n, "EUR"),
              "bank-new",
              local_date(c.now, s.test_site.timezone),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "expense.finance",
              "approved",
              money(25n, "USD"),
              "bank-new",
              local_date(c.now, s.test_site.timezone),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "expense.finance",
              "approved",
              money(25n, "EUR"),
              "bank-new",
              add_days(local_date(c.now, s.test_site.timezone), 1n),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "expense.finance",
              "submitted",
              money(25n, "EUR"),
              "bank-new",
              local_date(c.now, s.test_site.timezone),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "members",
              "approved",
              money(25n, "EUR"),
              "bank-new",
              local_date(c.now, s.test_site.timezone),
            ],
            error: "forbidden",
          },
        ],
      },
    ],
  };
}
