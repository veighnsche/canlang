import {
  any,
  addDuration,
  subtractDuration,
  count,
  cancel,
  require as check,
  compareInstant,
  create,
  format,
  hasRole,
  int64,
  max,
  records,
  same,
  schedule,
  send,
  set,
} from "@canlang/stdlib";
import {
  actions,
  card,
  details,
  edit,
  form,
  history,
  list,
  message,
  renderPage,
  table,
  text,
} from "@canlang/ui";
import { can_work } from "./employee.mjs";
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

export const Document = "approve.Document";
export const Submission = "approve.Submission";

const reviewerCaption = message("Reviewer", { nl: "Beoordelaar" });

const noteCaption = message("Note", { nl: "Notitie" });

const emailCaption = message("Reviewer email", { nl: "E-mail beoordelaar" });

export const appDefinition = {
  id: "CanApprove",
  uses: ["approve"],
  description: message(
    "Help workspace managers review fit-out plans, signage, supplier documents, and operating procedures before they are used at a location.",
    {
      nl: "Help werkplekbeheerders verbouwingsplannen, bewegwijzering, leveranciersdocumenten en werkprocedures beoordelen voordat ze op een locatie worden gebruikt.",
    },
  ),
  packages: {
    approve: {
      label: message("Document review", { nl: "Documentbeoordeling" }),
      description: message(
        "Review immutable submitted document versions with current reviewer and no self-approval.",
        {
          nl: "Beoordeel onveranderlijke ingediende documentversies met de huidige beoordelaar en zonder zelfgoedkeuring.",
        },
      ),
      roles: {
        coordinator: {
          id: "approve.coordinator",
          label: message("Coordinator", { nl: "Coördinator" }),
        },
        reviewer: { id: "approve.reviewer", label: reviewerCaption },
      },
    },
  },
  bindings: { "approve.Mail": { capability: "std.EmailV1", from: "deployment.mail" } },
  models: {
    "approve.Document": {
      exported: true,
      label: message("Document", { nl: "Document" }),
      readGrants: [
        { rule: "Document.read.1" },
        { rule: "Document.read.2" },
        { rule: "Document.read.3" },
      ],
      fields: {
        location: { type: Location, nullable: true },
        title: { type: "text" },
        category: { type: "text", label: message("Category", { nl: "Categorie" }) },
        subject: { type: "text", nullable: true },
        submitter: {
          type: "user",
          server: "actor",
          label: message("Submitter", { nl: "Indiener" }),
        },
        email: { type: "email" },
        current: {
          type: "int",
          default: 0n,
          label: message("Current revision", { nl: "Huidige revisie" }),
        },
      },
    },
    "approve.Submission": {
      exported: true,
      parent: "approve.Document",
      label: message("Submitted version", { nl: "Ingediende versie" }),
      readGrants: [
        { rule: "Submission.read.1" },
        { rule: "Submission.read.2" },
        { rule: "Submission.read.3" },
      ],
      unique: [{ fields: ["revision"] }],
      locks: ["Submission.lock.1", "Submission.lock.2"],
      fields: {
        assignment: {
          type: "int",
          default: 1n,
          label: message("Assignment revision", { nl: "Toewijzingsrevisie" }),
        },
        revision: { type: "int" },
        file: { type: "file" },
        note: { type: "text", label: noteCaption },
        reviewer: { type: "user", label: reviewerCaption },
        reviewer_email: { type: "email", label: emailCaption },
        due: { type: "datetime" },
        state: {
          type: "enum",
          cases: ["pending", "approved", "rejected", "withdrawn"],
          default: "pending",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              pending: message("Pending", { nl: "In behandeling" }),
              approved: message("Approved", { nl: "Goedgekeurd" }),
              rejected: message("Rejected", { nl: "Afgewezen" }),
              withdrawn: message("Withdrawn", { nl: "Ingetrokken" }),
            },
          },
        },
        reason: { type: "text", nullable: true },
        decided_by: {
          type: "user",
          nullable: true,
          label: message("Decision maker", { nl: "Beslist door" }),
        },
        decided_at: {
          type: "datetime",
          nullable: true,
          label: message("Decision time", { nl: "Beslist op" }),
        },
      },
    },
    "approve.Notice": {
      parent: "approve.Submission",
      label: message("Review notice", { nl: "Beoordelingsbericht" }),
      readGrants: [{ rule: "Notice.read.1" }, { rule: "Notice.read.2" }, { rule: "Notice.read.3" }],
      locks: ["Notice.lock.1"],
      fields: {
        kind: {
          type: "enum",
          cases: ["request", "decision", "reminder"],
          label: {
            text: message("Notice kind", { nl: "Soort bericht" }),
            values: {
              request: message("Review request", { nl: "Beoordelingsverzoek" }),
              decision: message("Decision", { nl: "Besluit" }),
              reminder: message("Reminder", { nl: "Herinnering" }),
            },
          },
        },
        assignment: { type: "approve.Submission.assignment" },
        recipient: { type: "email", label: message("Recipient", { nl: "Ontvanger" }) },
        subject: { type: "text" },
        body: { type: "text" },
        delivery: {
          type: "text",
          nullable: true,
          label: message("Delivery reference", { nl: "Verzendingsreferentie" }),
        },
        state: { type: "std.DeliveryResult.status", default: "pending" },
      },
    },
  },
  events: {
    "approve.Due": {
      fields: { submission: { type: "approve.Submission" }, assignment: { type: "int" } },
    },
  },
  preferences: {
    approve: {
      fields: {
        review_state: {
          type: "approve.Submission.state",
          nullable: true,
          default: null,
          label: message("Initial review state filter", { nl: "Eerste filter beoordelingsstatus" }),
        },
        versions_open: {
          type: "bool",
          default: false,
          label: message("Expand submitted version history", {
            nl: "Ingediende versiehistorie uitklappen",
          }),
        },
      },
    },
  },
  operations: {
    "approve.Document.create": {
      handler: "createDocument",
      kind: "create",
      model: "approve.Document",
      by: "members",
      read: false,
      inputs: { fields: ["location", "title", "category", "subject", "email"] },
      when: "Document",
    },
    "approve.Document.update": {
      handler: "updateDocument",
      kind: "update",
      model: "approve.Document",
      by: "members",
      read: false,
      inputs: {
        record: { type: "approve.Document" },
        changes: { fields: ["title", "category", "subject"] },
      },
      when: "Document",
    },
    "approve.submit": {
      handler: "submit",
      by: "members",
      read: false,
      description: message(
        "Replace a pending file with a new submitted revision and invalidate its old decision.",
        {
          nl: "Vervang een wachtend bestand door een nieuwe ingediende revisie en maak het oude besluit ongeldig.",
        },
      ),
      inputs: {
        document: { type: "approve.Document" },
        file: { type: "file" },
        note: { type: "text", label: noteCaption },
        reviewer: { type: "user", label: reviewerCaption },
        reviewer_email: { type: "email", label: emailCaption },
        due: { type: "datetime" },
      },
    },
    "approve.assign": {
      handler: "assign",
      by: "approve.coordinator",
      read: false,
      description: message("Reassign the current pending review, retaining assignment history.", {
        nl: "Wijs de huidige wachtende beoordeling opnieuw toe en behoud de toewijzingshistorie.",
      }),
      inputs: {
        submission: { type: "approve.Submission" },
        reviewer: { type: "user", label: reviewerCaption },
        email: { type: "email" },
      },
    },
    "approve.decide": {
      handler: "decide",
      by: "approve.reviewer",
      read: false,
      label: message("Record decision", { nl: "Besluit vastleggen" }),
      description: message(
        "Decide exactly the current pending file version with rejection reason or approval conditions.",
        {
          nl: "Beslis over precies de huidige ingediende bestandsversie met afwijzingsreden of goedkeuringsvoorwaarden.",
        },
      ),
      inputs: {
        submission: { type: "approve.Submission" },
        approve: { type: "bool", label: message("Approve", { nl: "Goedkeuren" }) },
        reason: { type: "text" },
      },
    },
    "approve.withdraw": {
      handler: "withdraw",
      by: "members",
      read: false,
      label: message("Withdraw", { nl: "Intrekken" }),
      description: message("Withdraw your pending version without erasing prior decisions.", {
        nl: "Trek je wachtende versie in zonder eerdere besluiten te wissen.",
      }),
      inputs: { submission: { type: "approve.Submission" } },
    },
  },
  handlers: {
    "approve.remind": { handler: "remind", on: "approve.Due" },
    "approve.notify": { handler: "notify", on: "approve.Notice.create" },
    "approve.delivered": { handler: "delivered", on: "approve.Mail.send.completed" },
  },
  pages: [
    { path: "/documents", render: documentsPage },
    { path: "/documents/review", render: reviewPage },
  ],
  disabled: [
    "approve.Document.delete",
    "approve.Submission.create",
    "approve.Submission.update",
    "approve.Submission.delete",
    "approve.Notice.create",
    "approve.Notice.update",
    "approve.Notice.delete",
  ],
};

export function canApp() {
  const crudWhen = {
    Document: async (c, row) =>
      same(row.submitter, c.actor) &&
      (row.location === null || (await can_work(c, c.actor, row.location))),
  };
  return {
    crudWhen,

    read: {
      "Document.read.1": (c, row) => hasRole(c, "members") && same(row.submitter, c.actor),
      "Document.read.2": async (c, row) =>
        hasRole(c, "approve.coordinator") &&
        (row.location === null || (await can_work(c, c.actor, row.location))),
      "Document.read.3": async (c, row) =>
        hasRole(c, "approve.reviewer") &&
        (row.location === null || (await can_work(c, c.actor, row.location))) &&
        (await any(
          records(c, "approve.Submission", { parent: row }),
          (submission) => same(submission.reviewer, c.actor) && submission.state !== "withdrawn",
        )),
      "Submission.read.1": (c, row) => hasRole(c, "members") && same(row.parent.submitter, c.actor),
      "Submission.read.2": async (c, row) =>
        hasRole(c, "approve.coordinator") &&
        (row.parent.location === null || (await can_work(c, c.actor, row.parent.location))),
      "Submission.read.3": async (c, row) =>
        hasRole(c, "approve.reviewer") &&
        same(row.reviewer, c.actor) &&
        row.state !== "withdrawn" &&
        (row.parent.location === null || (await can_work(c, c.actor, row.parent.location))),
      "Notice.read.1": (c, row) =>
        hasRole(c, "members") && same(row.parent.parent.submitter, c.actor),
      "Notice.read.2": async (c, row) =>
        hasRole(c, "approve.coordinator") &&
        (row.parent.parent.location === null ||
          (await can_work(c, c.actor, row.parent.parent.location))),
      "Notice.read.3": async (c, row) =>
        hasRole(c, "approve.reviewer") &&
        same(row.parent.reviewer, c.actor) &&
        row.parent.state !== "withdrawn" &&
        (row.parent.parent.location === null ||
          (await can_work(c, c.actor, row.parent.parent.location))),
    },
    locks: {
      "Notice.lock.1": { fields: ["kind", "assignment", "recipient", "subject", "body"] },
      "Submission.lock.1": { fields: ["revision", "file", "note", "due"] },
      "Submission.lock.2": {
        fields: ["state", "reason", "decided_by", "decided_at"],
        when: (c, row) => ["approved", "rejected", "withdrawn"].includes(row.state),
      },
    },
    async createDocument(c, input) {
      check(hasRole(c, "members"), "forbidden");
      await create(c, "approve.Document", input, { when: crudWhen.Document });
    },
    async updateDocument(c, { record, changes }) {
      check(hasRole(c, "members"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Document });
    },
    async submit(c, { document, file, note, reviewer, reviewer_email, due }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(document.submitter, c.actor) &&
          !same(reviewer, c.actor) &&
          (document.location === null || (await can_work(c, reviewer, document.location))) &&
          compareInstant(c.now, due) < 0,
      );
      const revision = int64(document.current + 1n);
      for await (const old of records(c, "approve.Submission", {
        parent: document,
        where: (submission) => submission.state === "pending",
        limit: 100n,
      })) {
        await set(c, old, { state: "withdrawn" });
        await cancel(c, old.id);
      }
      const submission = await create(c, "approve.Submission", {
        parent: document,
        revision,
        file,
        note,
        reviewer,
        reviewer_email,
        due,
        state: "pending",
        reason: null,
        decided_by: null,
        decided_at: null,
      });
      await set(c, document, { current: revision });
      await create(c, "approve.Notice", {
        parent: submission,
        kind: "request",
        assignment: submission.assignment,
        recipient: reviewer_email,
        subject: format(
          c,
          message("Document review requested", { nl: "Documentbeoordeling aangevraagd" }),
          { locale: null },
        ),
        body: document.title,
      });
      await schedule(c, submission.id, due, "approve.Due", {
        submission,
        assignment: submission.assignment,
      });
    },
    async assign(c, { submission, reviewer, email }) {
      check(hasRole(c, "approve.coordinator"), "forbidden");
      check(
        (submission.parent.location === null ||
          (await can_work(c, c.actor, submission.parent.location))) &&
          submission.state === "pending" &&
          !same(reviewer, submission.parent.submitter) &&
          (submission.parent.location === null ||
            (await can_work(c, reviewer, submission.parent.location))),
      );
      await set(c, submission, {
        reviewer,
        reviewer_email: email,
        assignment: int64(submission.assignment + 1n),
      });
      await create(c, "approve.Notice", {
        parent: submission,
        kind: "request",
        assignment: submission.assignment,
        recipient: email,
        subject: format(
          c,
          message("Document review requested", { nl: "Documentbeoordeling aangevraagd" }),
          { locale: null },
        ),
        body: submission.parent.title,
      });
      await schedule(c, submission.id, await max([c.now, submission.due]), "approve.Due", {
        submission,
        assignment: submission.assignment,
      });
    },
    async decide(c, { submission, approve, reason }) {
      check(hasRole(c, "approve.reviewer"), "forbidden");
      check(
        same(submission.reviewer, c.actor) &&
          !same(submission.parent.submitter, c.actor) &&
          submission.state === "pending" &&
          submission.revision === submission.parent.current &&
          (submission.parent.location === null ||
            (await can_work(c, c.actor, submission.parent.location))) &&
          (approve || reason.trim() !== ""),
      );
      await set(c, submission, {
        state: approve ? "approved" : "rejected",
        reason,
        decided_by: c.actor,
        decided_at: c.now,
      });
      await cancel(c, submission.id);
      await create(c, "approve.Notice", {
        parent: submission,
        kind: "decision",
        assignment: submission.assignment,
        recipient: submission.parent.email,
        subject: format(
          c,
          message("Document review decision", { nl: "Besluit documentbeoordeling" }),
          { locale: null },
        ),
        body: reason,
      });
    },
    async withdraw(c, { submission }) {
      check(hasRole(c, "members"), "forbidden");
      check(same(submission.parent.submitter, c.actor) && submission.state === "pending");
      await set(c, submission, { state: "withdrawn" });
      await cancel(c, submission.id);
    },
    async remind(c, { event }) {
      const submission = event.submission;
      check(
        submission.state === "pending" &&
          submission.assignment === event.assignment &&
          submission.revision === submission.parent.current &&
          compareInstant(c.now, submission.due) >= 0,
      );
      await create(c, "approve.Notice", {
        parent: submission,
        kind: "reminder",
        assignment: event.assignment,
        recipient: submission.reviewer_email,
        subject: format(c, message("Document review due", { nl: "Deadline documentbeoordeling" }), {
          locale: null,
        }),
        body: submission.parent.title,
      });
    },
    async notify(c, { event }) {
      const notice = event.after;
      const delivery = await send(
        c,
        "approve.Mail.send",
        { to: notice.recipient, subject: notice.subject, body: notice.body },
        {
          when: async () =>
            notice.kind === "decision" ||
            (notice.parent.state === "pending" &&
              notice.parent.revision === notice.parent.parent.current &&
              notice.parent.assignment === notice.assignment &&
              notice.parent.reviewer_email === notice.recipient &&
              (notice.parent.parent.location === null ||
                (await can_work(c, notice.parent.reviewer, notice.parent.parent.location)))),
        },
      );
      await set(c, notice, { delivery: delivery.id });
    },
    async delivered(c, { event }) {
      for await (const notice of records(c, "approve.Notice", {
        where: (row) => row.delivery === event.delivery_id,
        limit: 1n,
      }))
        await set(c, notice, { state: event.status });
    },
  };
}

export async function documentsPage(c) {
  check(hasRole(c, "members"), "forbidden");
  return renderPage(
    c,
    {
      owner: "approve",
      path: "/documents",
      title: message("My submissions", { nl: "Mijn inzendingen" }),
      description: message("Submit and follow your own exact document versions.", {
        nl: "Dien je eigen exacte documentversies in en volg ze.",
      }),
    },
    () => [
      card({
        context: c,
        title: message("Document intake", { nl: "Document aanmaken" }),
        children: [form({ context: c, operation: "approve.Document.create" })],
      }),
      list({
        context: c,
        model: "approve.Document",
        columns: ["title", "location", "category", "current"],
        filter: ["location", "category"],
        search: ["title"],
        display: "split",
        renderRow: (document, view) => [
          card({
            context: view,
            title: message("Current document", { nl: "Huidig document" }),
            children: [
              edit({ context: view, operation: "approve.Document.update", record: document }),
              form({ context: view, operation: "approve.submit", arguments: { document } }),
            ],
          }),
          details({
            context: view,
            caption: message("Submitted version history", { nl: "Ingediende versiehistorie" }),
            open: c.preferences.approve.versions_open,
            children: [
              table({
                context: view,
                model: "approve.Submission",
                parent: document,
                columns: ["revision", "file", "note", "reviewer", "due", "state", "reason"],
                order: ["-revision"],
                renderRow: (submission, rowView) => [
                  actions({
                    context: rowView,
                    operations: ["approve.withdraw"],
                    boundArgs: { submission },
                  }),
                  details({
                    context: rowView,
                    caption: message("Version decision history", { nl: "Besluithistorie versies" }),
                    children: [
                      text({
                        context: rowView,
                        values: [submission.decided_by, submission.decided_at],
                      }),
                      history({ context: rowView, record: submission }),
                    ],
                  }),
                  table({
                    context: rowView,
                    model: "approve.Notice",
                    parent: submission,
                    columns: ["kind", "recipient", "state", "created"],
                    order: ["created"],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function reviewPage(c) {
  check(hasRole(c, "approve.reviewer") || hasRole(c, "approve.coordinator"), "forbidden");
  return renderPage(
    c,
    {
      owner: "approve",
      path: "/documents/review",
      title: message("Review queue", { nl: "Beoordelingswachtrij" }),
      description: message("Review assigned submissions or coordinate permitted assignments.", {
        nl: "Beoordeel toegewezen inzendingen of coördineer toegestane toewijzingen.",
      }),
    },
    () => [
      table({
        context: c,
        model: "approve.Submission",
        columns: ["parent", "revision", "file", "note", "reviewer", "due", "state"],
        order: ["due"],
        filter: ["state"],
        defaults: { state: c.preferences.approve.review_state },
        display: "split",
        renderRow: (submission, view) => [
          card({
            context: view,
            title: message("Exact submitted version", { nl: "Exact ingediende versie" }),
            children: [
              text({
                context: view,
                values: [
                  submission.revision,
                  submission.file,
                  submission.note,
                  submission.due,
                  submission.state,
                  submission.reason,
                ],
              }),
              actions({
                context: view,
                operations: ["approve.decide", "approve.assign"],
                boundArgs: { submission },
              }),
            ],
          }),
          details({
            context: view,
            caption: message("Review history", { nl: "Beoordelingshistorie" }),
            children: [
              text({ context: view, values: [submission.decided_by, submission.decided_at] }),
              history({ context: view, record: submission }),
            ],
          }),
          table({
            context: view,
            model: "approve.Notice",
            parent: submission,
            columns: ["kind", "recipient", "state", "created"],
            order: ["created"],
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
  const document = {
    model: "approve.Document",
    dependencies: [test_site],
    value: async (c, s) => ({
      location: s.test_site,
      title: "Plan",
      category: "Signage",
      submitter: s.self,
      email: "submitter@example.test",
    }),
  };
  const original = { dependencies: [], file: async (c, s) => ({}) };
  const replacement = { dependencies: [], file: async (c, s) => ({}) };
  const pending_version = {
    model: "approve.Submission",
    dependencies: [document, original],
    value: async (c, s) => ({
      parent: s.document,
      revision: 1n,
      file: s.original,
      note: "Signage",
      reviewer: s.other,
      reviewer_email: "reviewer@example.test",
      due: addDuration(c.now, 86400000n),
    }),
  };
  const pending_notice = {
    model: "approve.Notice",
    dependencies: [pending_version],
    value: async (c, s) => ({
      parent: s.pending_version,
      kind: "request",
      assignment: 1n,
      recipient: "reviewer@example.test",
      subject: "Review",
      body: "Plan",
      delivery: "notice",
    }),
  };
  const accepted = {
    model: "approve.Submission",
    dependencies: [document, original],
    value: async (c, s) => ({
      parent: s.document,
      revision: 1n,
      file: s.original,
      note: "Original",
      reviewer: s.other,
      reviewer_email: "reviewer@example.test",
      due: addDuration(c.now, 86400000n),
      state: "approved",
      decided_by: s.other,
      decided_at: c.now,
    }),
  };
  return {
    document,
    original,
    replacement,
    pending_version,
    accepted,
    pending_notice,
    examples: [
      {
        operation: "approve.Document.update",
        seed: [test_worker],
        dependencies: [document],
        inputs: async (c, s) => ({ record: s.document }),
        selectors: ["as", "changes.title"],
        observations: [async (c, s) => s.document.title],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "New title"],
            expected: async (c, s) => ["New title"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["outsider", "New title"],
            error: "not_found",
          },
        ],
      },
      {
        operation: "approve.submit",
        seed: [pending_version],
        dependencies: [document, replacement],
        inputs: async (c, s) => ({
          document: s.document,
          file: s.replacement,
          note: "Updated",
          reviewer: s.other,
          reviewer_email: "reviewer@example.test",
          due: addDuration(c.now, 86400000n),
        }),
        selectors: ["as", "document.location", "document.current"],
        observations: [
          async (c, s) => s.document.current,
          async (c, s) => s.pending_version.state,
          async (c, s) => count(records(c, "approve.Submission", { parent: s.document })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", null, 1n],
            expected: async (c, s) => [2n, "withdrawn", 2n],
          },
          { dependencies: [], values: async (c, s) => ["public", null, 1n], error: "forbidden" },
        ],
      },
      {
        operation: "approve.submit",
        seed: [accepted],
        dependencies: [document, replacement],
        inputs: async (c, s) => ({
          document: s.document,
          file: s.replacement,
          note: "Updated",
          reviewer: s.other,
          reviewer_email: "reviewer@example.test",
          due: addDuration(c.now, 86400000n),
        }),
        selectors: ["as", "document.location", "document.current"],
        observations: [
          async (c, s) => s.accepted.state,
          async (c, s) => s.accepted.file,
          async (c, s) => count(records(c, "approve.Submission", { parent: s.document })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", null, 1n],
            expected: async (c, s) => ["approved", s.original, 2n],
          },
        ],
      },
      {
        operation: "approve.decide",
        dependencies: [pending_version],
        inputs: async (c, s) => ({
          submission: s.pending_version,
          reason: "Approved with conditions",
        }),
        selectors: [
          "as",
          "submission.parent.location",
          "submission.parent.current",
          "submission.reviewer",
          "submission.parent.submitter",
          "approve",
        ],
        observations: [
          async (c, s) => s.pending_version.state,
          async (c, s) => s.pending_version.decided_by,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["reviewer", null, 1n, s.self, s.other, true],
            expected: async (c, s) => ["approved", s.self],
          },
          {
            dependencies: [],
            values: async (c, s) => ["reviewer", null, 2n, s.self, s.other, true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["reviewer", null, 1n, s.self, s.self, true],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "approve.decide",
        dependencies: [pending_version],
        inputs: async (c, s) => ({ submission: s.pending_version, approve: false }),
        selectors: [
          "as",
          "submission.parent.location",
          "submission.parent.current",
          "submission.reviewer",
          "submission.parent.submitter",
          "reason",
        ],
        observations: [
          async (c, s) => s.pending_version.state,
          async (c, s) => s.pending_version.reason,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["reviewer", null, 1n, s.self, s.other, "Replace page two"],
            expected: async (c, s) => ["rejected", "Replace page two"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["reviewer", null, 1n, s.self, s.other, ""],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "approve.assign",
        dependencies: [pending_version],
        inputs: async (c, s) => ({
          submission: s.pending_version,
          reviewer: s.other,
          email: "new-reviewer@example.test",
        }),
        selectors: ["as", "submission.parent.location", "submission.parent.current"],
        observations: [
          async (c, s) => s.pending_version.assignment,
          async (c, s) => s.pending_version.reviewer_email,
          async (c, s) => count(records(c, "approve.Notice", { parent: s.pending_version })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["coordinator", null, 1n],
            expected: async (c, s) => [2n, "new-reviewer@example.test", 1n],
          },
          { dependencies: [], values: async (c, s) => ["members", null, 1n], error: "forbidden" },
        ],
      },
      {
        operation: "approve.remind",
        dependencies: [pending_version],
        inputs: async (c, s) => ({ event: { submission: s.pending_version, assignment: 1n } }),
        selectors: [
          "pending_version.parent.current",
          "pending_version.due",
          "pending_version.assignment",
          "pending_version.state",
        ],
        observations: [
          async (c, s) => count(records(c, "approve.Notice", { parent: s.pending_version })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [1n, subtractDuration(c.now, 60000n), 1n, "pending"],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => [1n, subtractDuration(c.now, 60000n), 2n, "pending"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [1n, subtractDuration(c.now, 60000n), 1n, "withdrawn"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [1n, addDuration(c.now, 60000n), 1n, "pending"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "approve.delivered",
        seed: [pending_notice],
        dependencies: [],
        inputs: async (c, s) => ({
          event: { delivery_id: "notice", status: "unknown", result: null, error: null },
        }),
        selectors: ["event.status", "event.result"],
        observations: [
          async (c, s) => s.pending_notice.state,
          async (c, s) => s.pending_version.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["succeeded", { reference: "accepted-mail" }],
            expected: async (c, s) => ["succeeded", "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["unknown", null],
            expected: async (c, s) => ["unknown", "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["skipped", null],
            expected: async (c, s) => ["skipped", "pending"],
          },
        ],
      },
    ],
  };
}
