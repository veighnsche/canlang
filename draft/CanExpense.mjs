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
  first,
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

const minePageDescriptor = {
  owner: "expense",
  path: "/expenses/mine",
  title: message("My expenses", { nl: "Mijn onkosten" }),
  description: message("Submit your receipts and see their private decision history.", {
    nl: "Dien je bonnen in en bekijk hun privébesluithistorie.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: minePage,
};

const reviewPageDescriptor = {
  owner: "expense",
  path: "/expenses/review",
  title: message("Expense review", { nl: "Onkostenbeoordeling" }),
  description: message(
    "Review assigned claims and record evidenced reimbursement under finance grants.",
    {
      nl: "Beoordeel toegewezen declaraties en leg onderbouwde vergoeding vast binnen financiële bevoegdheden.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "expense.reviewer") || hasRole(c, "expense.finance"), "forbidden");
    return {};
  },
  render: reviewPage,
};

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
          cases: ["draft", "submitted", "approved", "rejected", "withdrawn", "reimbursed"],
          default: "draft",
          label: {
            text: message("Status", { nl: "Status" }),
            values: {
              draft: message("Draft", { nl: "Concept" }),
              submitted: message("Submitted", { nl: "Ingediend" }),
              approved: approvedCaption,
              rejected: message("Rejected", { nl: "Afgewezen" }),
              withdrawn: message("Withdrawn", { nl: "Ingetrokken" }),
              reimbursed: message("Reimbursed", { nl: "Vergoed" }),
            },
          },
        },
        submission: { type: "int", default: 0n, label: submissionCaption },
        withdrawal: {
          type: "text",
          nullable: true,
          label: message("Withdrawal reason", { nl: "Reden voor intrekking" }),
        },
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
    "expense.withdraw": {
      handler: "withdraw",
      by: "members",
      read: false,
      inputs: { expense: { type: "expense.Expense" }, reason: { type: "text" } },
      label: message("Withdraw unavailable review", { nl: "Onbeschikbare beoordeling intrekken" }),
      description: message(
        "Withdraw an unavailable review without changing its frozen evidence or recording a reviewer decision.",
        { nl: "Trek een onbeschikbare beoordeling in zonder vastgelegd bewijs te wijzigen of een beoordelaarsbesluit te registreren." },
      ),
    },
    "expense.correct": {
      handler: "correct",
      by: "members",
      read: false,
      inputs: { expense: { type: "expense.Expense" } },
      label: message("Create correction draft", { nl: "Correctieconcept maken" }),
      description: message(
        "Create one corrected draft while preserving the rejected or withdrawn claim and its evidence.",
        {
          nl: "Maak één gecorrigeerd concept met behoud van de afgewezen of ingetrokken declaratie en het bewijs.",
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
    minePageDescriptor,
    reviewPageDescriptor,
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
        (same(row.corrects.parent, row.parent) && ["rejected", "withdrawn"].includes(row.corrects.status)),
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
          (await can_work(c, c.actor, expense.location)) &&
          !same(expense.reviewer, c.actor) &&
          hasRole(c, "expense.reviewer", expense.reviewer) &&
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
    async withdraw(c, { expense, reason }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(expense.parent.user, c.actor) &&
          expense.parent.active &&
          (await can_work(c, c.actor, expense.location)) &&
          expense.status === "submitted" &&
          reason.trim() !== "" &&
          (!hasRole(c, "expense.reviewer", expense.reviewer) ||
            !(await can_work(c, expense.reviewer, expense.location))),
      );
      await set(c, expense, { status: "withdrawn", withdrawal: reason.trim() });
    },
    async correct(c, { expense }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(expense.parent.user, c.actor) &&
          ["rejected", "withdrawn"].includes(expense.status) &&
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

export async function minePage(c, bindings) {
  return renderPage(
    c,
    minePageDescriptor,
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
                  expense.withdrawal,
                ],
              }),
              edit({ context: view, operation: "expense.Expense.update", record: expense }),
              actions({
                context: view,
                operations: ["expense.submit", "expense.withdraw", "expense.correct"],
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

export async function reviewPage(c, bindings) {
  return renderPage(
    c,
    reviewPageDescriptor,
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
 * Sequences retain enclosing operation metadata, explicit canonical call identities,
 * genuine named callers and immutable bindings; stored fixtures reload per statement.
 * No runner, provisioning implementation or Can-expression interpreter is added.
 */
export const exampleImports = [
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_site, test_worker } = imported;
  const receipt = { dependencies: [], file: async (c, s) => ({}) };
  const corrected_receipt = { dependencies: [], file: async (c, s) => ({}) };
  const hr_user = { dependencies: [], user: async (c, s) => ({ roles: ["employee.hr"] }) };
  const replacement_user = { dependencies: [], user: async (c, s) => ({ roles: ["expense.reviewer"] }) };
  const replacement_worker = {
    model: "employee.Employee", dependencies: [test_site, replacement_user],
    value: async (c, s) => ({ user: s.replacement_user, home: s.test_site, locations: [s.test_site], start: date("2026-10-01"), role: "Replacement reviewer" }),
  };
  const reviewer_user = { dependencies: [], user: async (c, s) => ({ roles: ["expense.reviewer"] }) };
  const finance_user = { dependencies: [], user: async (c, s) => ({ roles: ["expense.finance"] }) };
  const ordinary_user = { dependencies: [], user: async (c, s) => ({}) };
  const reviewer_worker = {
    model: "employee.Employee",
    dependencies: [test_site, reviewer_user],
    value: async (c, s) => ({
      user: s.reviewer_user, home: s.test_site, locations: [s.test_site],
      start: date("2026-10-01"), role: "Reviewer",
    }),
  };
  const finance_worker = {
    model: "employee.Employee",
    dependencies: [test_site, finance_user],
    value: async (c, s) => ({
      user: s.finance_user, home: s.test_site, locations: [s.test_site],
      start: date("2026-10-01"), role: "Finance",
    }),
  };
  const ordinary_worker = {
    model: "employee.Employee",
    dependencies: [test_site, ordinary_user],
    value: async (c, s) => ({
      user: s.ordinary_user, home: s.test_site, locations: [s.test_site],
      start: date("2026-10-01"), role: "Operator",
    }),
  };
  const claim = {
    model: "expense.Expense",
    dependencies: [receipt, test_site, test_worker, reviewer_user],
    value: async (c, s) => ({
      parent: s.test_worker, location: s.test_site, purpose: "Travel between sites", category: "Travel",
      amount: money(25n, "EUR"), business_date: date("2026-10-01"), receipt: s.receipt,
      reviewer: s.reviewer_user,
    }),
  };
  const previous_claim = {
    model: "expense.Expense",
    dependencies: [receipt, test_site, test_worker, reviewer_user],
    value: async (c, s) => ({
      parent: s.test_worker, location: s.test_site, purpose: "Earlier supplies", category: "Supplies",
      amount: money(25n, "EUR"), business_date: date("2026-10-01"), receipt: s.receipt,
      reviewer: s.reviewer_user, status: "reimbursed",
    }),
  };
  const other_site = {
    model: "rent_catalog.Location", dependencies: [],
    value: async (c, s) => ({ name: "Elsewhere", address: "2 Example Road", timezone: "Europe/Brussels", currency: "EUR", hours: "09:00–18:00", arrival: "Report to reception" }),
  };
  const previous_payment = {
    model: "expense.Reimbursement", dependencies: [previous_claim],
    value: async (c, s) => ({ parent: s.previous_claim, amount: money(25n, "EUR"), reference: "bank-previous", paid: date("2026-10-01"), reason: "Statement evidence" }),
  };
  const rejected_decision = {
    model: "expense.Decision", dependencies: [claim, receipt, reviewer_user],
    value: async (c, s) => ({ parent: s.claim, submission: 1n, amount: money(25n, "EUR"), receipt: s.receipt, reviewer: s.reviewer_user, approved: false, reason: "Clarify the journey", decided_at: datetime("2026-10-02T09:00:00Z") }),
  };
  return {
    receipt, corrected_receipt, hr_user, replacement_user, replacement_worker, reviewer_user, finance_user, ordinary_user, reviewer_worker, finance_worker, ordinary_worker,
    claim, previous_claim, previous_payment, rejected_decision, other_site,
    examples: [
      {
        operation: "expense.submit",
        seed: [reviewer_worker, ordinary_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["as", "expense.reviewer", "reviewer_worker.active", "test_worker.active", "request.expense.version"],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => s.expense.submission,
          async (c, s) => s.expense.receipt,
          async (c, s) => s.expense.reviewer,
        ],
        rows: [
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.self, s.reviewer_user, true, true, 1n],
            expected: async (c, s) => ["submitted", 1n, s.receipt, s.reviewer_user],
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, true, true, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [s.self, s.self, true, true, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.self, s.reviewer_user, false, true, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.self, s.reviewer_user, true, false, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user, reviewer_user],
            values: async (c, s) => [s.ordinary_user, s.reviewer_user, true, true, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.self, s.reviewer_user, true, true, 2n],
            error: "conflict",
          },
        ],
      },
      {
        operation: "expense.submit",
        seed: [reviewer_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["expense.location"],
        observations: [
          async (c, s) => s.expense.status,
        ],
        rows: [
          {
            dependencies: [other_site],
            values: async (c, s) => [s.other_site],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "expense.submit",
        dependencies: [claim, reviewer_worker, finance_worker, ordinary_user],
        sequence: [
          {
            operation: "expense.submit",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim }),
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              s.claim.submission,
              s.claim.receipt,
            ],
            expected: async (c, s, b) => [
              "submitted",
              1n,
              s.receipt,
            ],
            types: ["expense.Expense.status", "int", "file"],
          },
          {
            operation: "expense.decide",
            by: async (c, s, b) => s.ordinary_user,
            inputs: async (c, s, b) => ({ expense: s.claim, approve: true, reason: "Checked the journey" }),
            error: "forbidden",
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              await count(records(c, "expense.Decision", { parent: s.claim })),
            ],
            expected: async (c, s, b) => [
              "submitted",
              0n,
            ],
            types: ["expense.Expense.status", "int"],
          },
          {
            operation: "expense.decide",
            by: async (c, s, b) => s.reviewer_user,
            inputs: async (c, s, b) => ({ expense: s.claim, approve: true, reason: "Checked the journey" }),
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              s.claim.decided_by,
              await count(records(c, "expense.Decision", { parent: s.claim })),
            ],
            expected: async (c, s, b) => [
              "approved",
              s.reviewer_user,
              1n,
            ],
            types: ["expense.Expense.status", "user?", "int"],
          },
          {
            operation: "expense.reimburse",
            by: async (c, s, b) => s.reviewer_user,
            inputs: async (c, s, b) => ({ expense: s.claim, amount: money(25n, "EUR"), reference: "bank-journey", paid: local_date(c.now, s.test_site.timezone), reason: "Bank statement" }),
            error: "forbidden",
          },
          {
            operation: "expense.reimburse",
            by: async (c, s, b) => s.finance_user,
            inputs: async (c, s, b) => ({ expense: s.claim, amount: money(25n, "EUR"), reference: "bank-journey", paid: local_date(c.now, s.test_site.timezone), reason: "Bank statement" }),
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              await count(records(c, "expense.Reimbursement", { parent: s.claim })),
              await any(records(c, "expense.Reimbursement", { parent: s.claim }), (payment) => same(payment.recorded_by, s.finance_user) && equalMoney(payment.amount, money(25n, "EUR"))),
            ],
            expected: async (c, s, b) => [
              "reimbursed",
              1n,
              true,
            ],
            types: ["expense.Expense.status", "int", "bool"],
          },
          {
            operation: "expense.reimburse",
            by: async (c, s, b) => s.finance_user,
            inputs: async (c, s, b) => ({ expense: s.claim, amount: money(25n, "EUR"), reference: "bank-repeat", paid: local_date(c.now, s.test_site.timezone), reason: "Bank statement" }),
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "expense.submit",
        dependencies: [claim, reviewer_worker, finance_worker, corrected_receipt],
        sequence: [
          {
            operation: "expense.submit",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim }),
          },
          {
            operation: "expense.decide",
            by: async (c, s, b) => s.reviewer_user,
            inputs: async (c, s, b) => ({ expense: s.claim, approve: false, reason: "Clarify the journey" }),
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              s.claim.receipt,
              await count(records(c, "expense.Decision", { parent: s.claim })),
            ],
            expected: async (c, s, b) => [
              "rejected",
              s.receipt,
              1n,
            ],
            types: ["expense.Expense.status", "file", "int"],
          },
          {
            operation: "expense.Expense.update",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ record: s.claim, changes: { receipt: s.corrected_receipt } }),
            error: "rule_failed",
          },
          {
            operation: "expense.correct",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim }),
          },
          {
            let: "replacement",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.replacement !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.Expense.update",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ record: b.replacement, changes: { purpose: "Journey evidence corrected", receipt: s.corrected_receipt, reviewer: s.reviewer_user } }),
          },
          {
            let: "ready",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.ready !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.submit",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: b.ready }),
          },
          {
            let: "submitted_replacement",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.submitted_replacement !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.decide",
            by: async (c, s, b) => s.reviewer_user,
            inputs: async (c, s, b) => ({ expense: b.submitted_replacement, approve: true, reason: "Corrected receipt checked" }),
          },
          {
            let: "approved_replacement",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.approved_replacement !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.reimburse",
            by: async (c, s, b) => s.finance_user,
            inputs: async (c, s, b) => ({ expense: b.approved_replacement, amount: money(25n, "EUR"), reference: "bank-correction", paid: local_date(c.now, s.test_site.timezone), reason: "Bank statement" }),
          },
          {
            let: "paid_replacement",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.paid_replacement !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              s.claim.receipt,
              s.claim.decision,
              b.paid_replacement.status,
              b.paid_replacement.submission,
              b.paid_replacement.receipt,
              await any(records(c, "expense.Decision", { parent: s.claim }), (decision) => !decision.approved && same(decision.receipt, s.receipt) && decision.reason === "Clarify the journey"),
              await any(records(c, "expense.Decision", { parent: b.paid_replacement }), (decision) => decision.approved && decision.submission === 2n && same(decision.receipt, s.corrected_receipt)),
              await count(records(c, "expense.Reimbursement", { parent: b.paid_replacement })),
            ],
            expected: async (c, s, b) => [
              "rejected",
              s.receipt,
              "Clarify the journey",
              "reimbursed",
              2n,
              s.corrected_receipt,
              true,
              true,
              1n,
            ],
            types: ["expense.Expense.status", "file", "text?", "expense.Expense.status", "int", "file", "bool", "bool", "int"],
          },
        ],
      },
      {
        operation: "expense.submit",
        dependencies: [claim, reviewer_worker, replacement_worker, finance_worker, hr_user, corrected_receipt],
        sequence: [
          {
            operation: "expense.submit",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim }),
          },
          {
            let: "submitted_version",
            value: async (c, s, b) => s.claim.version,
          },
          {
            operation: "employee.deactivate",
            by: async (c, s, b) => s.hr_user,
            inputs: async (c, s, b) => ({ employee: s.reviewer_worker, ended: date("2026-10-02") }),
          },
          {
            observations: async (c, s, b) => [
              s.reviewer_worker.active,
              hasRole(c, "expense.reviewer", s.reviewer_user),
              await can_work(c, s.reviewer_user, s.test_site),
              s.claim.status,
            ],
            expected: async (c, s, b) => [
              false,
              true,
              false,
              "submitted",
            ],
            types: ["bool", "bool", "bool", "expense.Expense.status"],
          },
          {
            operation: "expense.decide",
            by: async (c, s, b) => s.reviewer_user,
            inputs: async (c, s, b) => ({ expense: s.claim, approve: true, reason: "Checked" }),
            error: "rule_failed",
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              await count(records(c, "expense.Decision", { parent: s.claim })),
            ],
            expected: async (c, s, b) => [
              "submitted",
              0n,
            ],
            types: ["expense.Expense.status", "int"],
          },
          {
            operation: "expense.withdraw",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim, reason: " Reviewer unavailable " }),
          },
          {
            operation: "expense.withdraw",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim, reason: "Repeated recovery" }),
            request: async (c, s, b) => ({ expense: { version: b.submitted_version } }),
            error: "conflict",
          },
          {
            operation: "expense.withdraw",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim, reason: "Repeated recovery" }),
            error: "rule_failed",
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              s.claim.withdrawal,
              s.claim.reviewer,
              s.claim.receipt,
              s.claim.amount,
              await count(records(c, "expense.Decision", { parent: s.claim })),
            ],
            expected: async (c, s, b) => [
              "withdrawn",
              "Reviewer unavailable",
              s.reviewer_user,
              s.receipt,
              money(25n, "EUR"),
              0n,
            ],
            types: ["expense.Expense.status", "text?", "user", "file", "money", "int"],
          },
          {
            operation: "expense.correct",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim }),
          },
          {
            operation: "expense.correct",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: s.claim }),
            error: "rule_failed",
          },
          {
            let: "recovery_draft",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.recovery_draft !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.Expense.update",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ record: b.recovery_draft, changes: { receipt: s.corrected_receipt, reviewer: s.replacement_user } }),
          },
          {
            let: "recovery_ready",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.recovery_ready !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.submit",
            by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ expense: b.recovery_ready }),
          },
          {
            let: "recovery_submitted",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.recovery_submitted !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.decide",
            by: async (c, s, b) => s.replacement_user,
            inputs: async (c, s, b) => ({ expense: b.recovery_submitted, approve: true, reason: "Replacement review checked" }),
          },
          {
            let: "recovery_approved",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.recovery_approved !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            operation: "expense.reimburse",
            by: async (c, s, b) => s.finance_user,
            inputs: async (c, s, b) => ({ expense: b.recovery_approved, amount: money(25n, "EUR"), reference: "bank-recovery", paid: local_date(c.now, s.test_site.timezone), reason: "Bank statement" }),
          },
          {
            let: "recovery_paid",
            value: async (c, s, b) => await first(records(c, "expense.Expense", { parent: s.claim.parent, where: (row) => same(row.corrects, s.claim), order: ["id"] })),
          },
          {
            observations: async (c, s, b) => [
              b.recovery_paid !== null,
            ],
            expected: async (c, s, b) => [
              true,
            ],
            types: ["bool"],
          },
          {
            observations: async (c, s, b) => [
              s.claim.status,
              s.claim.reviewer,
              s.claim.receipt,
              await count(records(c, "expense.Decision", { parent: s.claim })),
              b.recovery_paid.status,
              b.recovery_paid.reviewer,
              b.recovery_paid.receipt,
              b.recovery_paid.submission,
              await count(records(c, "expense.Decision", { parent: b.recovery_paid })),
              await count(records(c, "expense.Reimbursement", { parent: b.recovery_paid })),
            ],
            expected: async (c, s, b) => [
              "withdrawn",
              s.reviewer_user,
              s.receipt,
              0n,
              "reimbursed",
              s.replacement_user,
              s.corrected_receipt,
              2n,
              1n,
              1n,
            ],
            types: ["expense.Expense.status", "user", "file", "int", "expense.Expense.status", "user", "file", "int", "int", "int"],
          },
        ],
      },
      {
        operation: "expense.decide",
        seed: [reviewer_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["as", "expense.status", "expense.reviewer", "expense.submission", "reviewer_worker.active", "approve", "reason", "request.expense.version"],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => s.expense.receipt,
          async (c, s) => s.expense.decided_by,
          async (c, s) => await count(records(c, "expense.Decision", { parent: s.expense })),
          async (c, s) => await any(records(c, "expense.Decision", { parent: s.expense }), (decision) => decision.submission === 1n && equalMoney(decision.amount, money(25n, "EUR")) && same(decision.receipt, s.receipt) && same(decision.reviewer, s.expense.reviewer) && decision.approved === s.approve && decision.reason === s.reason),
        ],
        rows: [
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.reviewer_user, "submitted", s.reviewer_user, 1n, true, true, "Checked the journey", 1n],
            expected: async (c, s) => ["approved", s.receipt, s.reviewer_user, 1n, true],
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.reviewer_user, "submitted", s.reviewer_user, 1n, true, false, "Clarify the journey", 1n],
            expected: async (c, s) => ["rejected", s.receipt, s.reviewer_user, 1n, true],
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.reviewer_user, "submitted", s.reviewer_user, 1n, true, false, "", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["expense.reviewer", "submitted", s.self, 1n, true, true, "Checked the journey", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user, reviewer_user],
            values: async (c, s) => [s.ordinary_user, "submitted", s.reviewer_user, 1n, true, true, "Checked the journey", 1n],
            error: "forbidden",
          },
          {
            dependencies: [finance_user, reviewer_user],
            values: async (c, s) => [s.finance_user, "submitted", s.reviewer_user, 1n, true, true, "Checked the journey", 1n],
            error: "forbidden",
          },
          {
            dependencies: [reviewer_user, finance_user],
            values: async (c, s) => [s.reviewer_user, "submitted", s.finance_user, 1n, true, true, "Checked the journey", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.reviewer_user, "approved", s.reviewer_user, 1n, true, true, "Checked the journey", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.reviewer_user, "submitted", s.reviewer_user, 1n, false, true, "Checked the journey", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.reviewer_user, "submitted", s.reviewer_user, 1n, true, true, "Checked the journey", 2n],
            error: "conflict",
          },
        ],
      },
      {
        operation: "expense.withdraw",
        seed: [reviewer_worker, ordinary_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["as", "expense.reviewer", "expense.status", "expense.submission", "reviewer_worker.active", "test_worker.active", "reason", "request.expense.version"],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => s.expense.withdrawal,
          async (c, s) => s.expense.receipt,
          async (c, s) => s.expense.amount,
          async (c, s) => s.expense.reviewer,
          async (c, s) => await count(records(c, "expense.Decision", { parent: s.expense })),
          async (c, s) => s.expense.submission,
        ],
        rows: [
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, "submitted", 1n, true, true, " Review unavailable ", 1n],
            expected: async (c, s) => ["withdrawn", "Review unavailable", s.receipt, money(25n, "EUR"), s.ordinary_user, 0n, 1n],
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.self, s.reviewer_user, "submitted", 1n, false, true, "Review unavailable", 1n],
            expected: async (c, s) => ["withdrawn", "Review unavailable", s.receipt, money(25n, "EUR"), s.reviewer_user, 0n, 1n],
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.self, s.reviewer_user, "submitted", 1n, true, true, "Review unavailable", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, "submitted", 1n, true, true, " ", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, "approved", 1n, true, true, "Review unavailable", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, "reimbursed", 1n, true, true, "Review unavailable", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, "withdrawn", 1n, true, true, "Review unavailable", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, "submitted", 1n, true, false, "Review unavailable", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.ordinary_user, s.ordinary_user, "submitted", 1n, true, true, "Review unavailable", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.self, s.ordinary_user, "submitted", 1n, true, true, "Review unavailable", 2n],
            error: "conflict",
          },
        ],
      },
      {
        operation: "expense.withdraw",
        seed: [reviewer_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["expense.location", "expense.status", "reason"],
        observations: [
          async (c, s) => s.expense.status,
        ],
        rows: [
          {
            dependencies: [other_site],
            values: async (c, s) => [s.other_site, "submitted", "Review unavailable"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "expense.correct",
        seed: [rejected_decision, reviewer_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["expense.status", "expense.submission", "expense.decision", "expense.decided_by", "expense.decided_at", "request.expense.version"],
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
          async (c, s) => await any(records(c, "expense.Expense", { parent: s.expense.parent }), (replacement) => same(replacement.corrects, s.expense) && replacement.status === "draft" && same(replacement.receipt, s.receipt) && equalMoney(replacement.amount, money(25n, "EUR")) && replacement.submission === 1n && same(replacement.reviewer, s.expense.reviewer)),
        ],
        rows: [
          {
            dependencies: [reviewer_user],
            values: async (c, s) => ["rejected", 1n, "Clarify the journey", s.reviewer_user, datetime("2026-10-02T09:00:00Z"), 1n],
            expected: async (c, s) => ["rejected", s.receipt, "Clarify the journey", s.reviewer_user, datetime("2026-10-02T09:00:00Z"), 1n, s.receipt, "Clarify the journey", 2n, true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["submitted", 1n, null, null, null, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["approved", 1n, null, null, null, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => ["rejected", 1n, "Clarify the journey", s.reviewer_user, datetime("2026-10-02T09:00:00Z"), 2n],
            error: "conflict",
          },
        ],
      },
      {
        operation: "expense.correct",
        seed: [reviewer_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["expense.status", "expense.submission", "expense.withdrawal", "test_worker.active"],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => s.expense.withdrawal,
          async (c, s) => s.expense.receipt,
          async (c, s) => await count(records(c, "expense.Decision", { parent: s.expense })),
          async (c, s) => await count(records(c, "expense.Expense", { parent: s.expense.parent })),
          async (c, s) => await any(records(c, "expense.Expense", { parent: s.expense.parent }), (replacement) => same(replacement.corrects, s.expense) && replacement.status === "draft" && same(replacement.receipt, s.receipt) && equalMoney(replacement.amount, money(25n, "EUR")) && replacement.submission === 1n && same(replacement.reviewer, s.expense.reviewer)),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["withdrawn", 1n, "Review unavailable", true],
            expected: async (c, s) => ["withdrawn", "Review unavailable", s.receipt, 0n, 2n, true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["withdrawn", 1n, "Review unavailable", false],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "expense.correct",
        seed: [],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["expense.location", "expense.status"],
        observations: [
          async (c, s) => s.expense.status,
        ],
        rows: [
          {
            dependencies: [other_site],
            values: async (c, s) => [s.other_site, "withdrawn"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "expense.reimburse",
        seed: [previous_payment, finance_worker],
        dependencies: [claim],
        inputs: async (c, s) => ({ expense: s.claim }),
        selectors: ["as", "expense.status", "finance_worker.active", "amount", "reference", "paid", "reason", "request.expense.version"],
        observations: [
          async (c, s) => s.expense.status,
          async (c, s) => await count(records(c, "expense.Reimbursement", { parent: s.expense })),
          async (c, s) => await any(records(c, "expense.Reimbursement", { parent: s.expense }), (payment) => payment.reference === "bank-new" && equalMoney(payment.amount, money(25n, "EUR")) && same(payment.recorded_by, s.finance_user)),
        ],
        rows: [
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(25n, "EUR"), " bank-new ", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            expected: async (c, s) => ["reimbursed", 1n, true],
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(25n, "EUR"), "bank-previous", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(20n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(25n, "USD"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(25n, "EUR"), "bank-new", add_days(local_date(c.now, s.test_site.timezone), 1n), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "submitted", true, money(25n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "reimbursed", true, money(25n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [ordinary_user],
            values: async (c, s) => [s.ordinary_user, "approved", true, money(25n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "forbidden",
          },
          {
            dependencies: [reviewer_user],
            values: async (c, s) => [s.reviewer_user, "approved", true, money(25n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "forbidden",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", false, money(25n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(25n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), "Bank statement", 2n],
            error: "conflict",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(25n, "EUR"), " ", local_date(c.now, s.test_site.timezone), "Bank statement", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [finance_user],
            values: async (c, s) => [s.finance_user, "approved", true, money(25n, "EUR"), "bank-new", local_date(c.now, s.test_site.timezone), " ", 1n],
            error: "rule_failed",
          },
        ],
      },
    ],
  };
}
