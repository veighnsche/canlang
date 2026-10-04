import {
  any,
  addDuration,
  subtractDuration,
  count,
  collect,
  cancel,
  require as check,
  compareInstant,
  create,
  date,
  delivery,
  first,
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
/* Desired, unimplemented @canlang/ui contracts. Every factory below is proposed;
 * none is an installed export and this file never runs. See file header. */
import {
  badge,
  breadcrumbs,
  button,
  card,
  checkbox,
  collapse,
  edit,
  file_input,
  form,
  history,
  input,
  join,
  list,
  message,
  modal,
  pagination,
  renderPage,
  slot,
  status,
  table,
  text,
  textarea,
} from "@canlang/ui";
import { Employee, can_work } from "./employee.mjs";
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
 * UI sections mirror the replanned CanApprove.can Then: breadcrumbs, typed
 * intake/submit/decide/assign controls, version-history collapses, state
 * badges, overdue statuses, withdraw/decision/assignment buttons and modals,
 * and paginated collections. collapse replaces details under their shared
 * disclosure contract; actions() has no remaining use. Lowercase UI factories
 * take one props object; slots are prop arrays. All UI imports and calls are
 * desired/unimplemented. This file passes node --check (syntax only) and
 * never runs.
 */

export const Document = "approve.Document";
export const Submission = "approve.Submission";

const reviewerCaption = message("Reviewer", { nl: "Beoordelaar" });

const noteCaption = message("Note", { nl: "Notitie" });

const emailCaption = message("Reviewer email", { nl: "E-mail beoordelaar" });

const documentsPageDescriptor = {
  owner: "approve",
  path: "/documents",
  title: message("My submissions", { nl: "Mijn inzendingen" }),
  description: message("Submit and follow your own exact document versions.", {
    nl: "Dien je eigen exacte documentversies in en volg ze.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: documentsPage,
};

const reviewPageDescriptor = {
  owner: "approve",
  path: "/documents/review",
  title: message("Review queue", { nl: "Beoordelingswachtrij" }),
  description: message("Review assigned submissions or coordinate permitted assignments.", {
    nl: "Beoordeel toegewezen inzendingen of coördineer toegestane toewijzingen.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "approve.reviewer") || hasRole(c, "approve.coordinator"), "forbidden");
    return {};
  },
  render: reviewPage,
};

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
      locks: ["Submission.lock.1", "Submission.lock.2", "Submission.lock.3"],
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
      derived: {overdue: {type:"bool", handler:"Submission.overdue", label:message("Overdue",{nl:"Te laat"})}},
    },
    "approve.Notice": {
      parent: "approve.Submission",
      label: message("Review notice", { nl: "Beoordelingsbericht" }),
      readGrants: [{ rule: "Notice.read.1", fields: ["parent", "kind", "assignment", "recipient", "subject", "body", "state", "delivery.id", "delivery.status", "created_by", "created", "updated_by", "updated", "archived_at"] }],
      locks: ["Notice.lock.1", "Notice.lock.2"],
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
          type: "delivery",
          operation: "approve.Mail.send",
          nullable: true,
          label: message("Delivery reference", { nl: "Verzendingsreferentie" }),
        },
      },
      derived: {state: {type:"std.DeliveryResult.status",nullable:true,handler:"Notice.state",label:message("Delivery state",{nl:"Verzendstatus"})}},
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
    "approve.reviewer_choices": {
      handler:"reviewer_choices",by:"members",read:true,result:"employee.Employee[]",
      label:message("Choose reviewer",{nl:"Beoordelaar kiezen"}),
      description:message("Read eligible reviewers through current work-field grants.",{nl:"Lees geschikte beoordelaars via actuele werkveldtoegang."}),
      inputs:{document:{type:"approve.Document"}},
    },
    "approve.submit": {
      handler: "submit",
      by: "members",
      read: false,
      description: message(
        "Submit a fresh immutable file revision, withdrawing pending reviews and retaining earlier decisions.",
        {
          nl: "Dien een nieuwe onveranderlijke bestandsrevisie in, trek wachtende beoordelingen in en behoud eerdere besluiten.",
        },
      ),
      inputs: {
        document: { type: "approve.Document" },
        file: { type: "file" },
        note: { type: "text", label: noteCaption },
        assignee: { type: "user", label: reviewerCaption },
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
        assignee: { type: "user", label: reviewerCaption },
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
    "approve.notify": { handler: "notify", on: "approve.Notice.created" },
  },
  pages: [
    documentsPageDescriptor,
    reviewPageDescriptor,
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
    derives: {"Notice.state": async(c,row) => (await delivery(c,{record:row,field:"delivery"},["status"]))?.status ?? null, "Submission.overdue": (c,row) => row.state === "pending" && compareInstant(row.due,c.now) < 0},
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
      "Notice.read.1": async (c, row) =>
        (hasRole(c, "members") && same(row.parent.parent.submitter, c.actor)) ||
        (hasRole(c, "approve.coordinator") &&
          (row.parent.parent.location === null || await can_work(c, c.actor, row.parent.parent.location))) ||
        (hasRole(c, "approve.reviewer") && same(row.parent.reviewer, c.actor) &&
          row.parent.state !== "withdrawn" &&
          (row.parent.parent.location === null || await can_work(c, c.actor, row.parent.parent.location))),
    },
    locks: {
      "Notice.lock.2": {fields: ["delivery"], when: (c, row) => row.delivery !== null},
      "Submission.lock.3": {fields: ["reviewer", "reviewer_email", "assignment"], when: (c, row) => row.state !== "pending"},
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
    async reviewer_choices(c, { document }) {
      check(hasRole(c,"members"),"forbidden");
      check((same(document.submitter,c.actor) || hasRole(c,"approve.coordinator")) &&
        (document.location===null || await can_work(c,c.actor,document.location)));
      return collect(records(c,Employee,{
        where:async candidate => candidate.active && !same(candidate.user,c.actor) && !same(candidate.user,document.submitter) &&
          hasRole(c,"approve.reviewer",candidate.user) &&
          (document.location===null || await can_work(c,candidate.user,document.location)),
      }));
    },
    async submit(c, { document, file, note, assignee, reviewer_email, due }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(document.submitter, c.actor) &&
          (document.location === null || await can_work(c, c.actor, document.location)) &&
          !same(assignee, c.actor) &&
          hasRole(c, "approve.reviewer", assignee) &&
          (document.location === null || (await can_work(c, assignee, document.location))) &&
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
        reviewer: assignee,
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
    async assign(c, { submission, assignee, email }) {
      check(hasRole(c, "approve.coordinator"), "forbidden");
      check(
        (submission.parent.location === null ||
          (await can_work(c, c.actor, submission.parent.location))) &&
          submission.state === "pending" &&
          submission.revision === submission.parent.current &&
          !same(assignee, submission.parent.submitter) &&
          hasRole(c, "approve.reviewer", assignee) &&
          (submission.parent.location === null ||
            (await can_work(c, assignee, submission.parent.location))),
      );
      await set(c, submission, {
        reviewer: assignee,
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
          compareInstant(c.now, submission.due) >= 0 &&
          hasRole(c, "approve.reviewer", submission.reviewer) &&
          (submission.parent.location === null || await can_work(c, submission.reviewer, submission.parent.location)),
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
      const notice = await first(records(c,"approve.Notice",{where:row=>row.id===event.id,order:["id"]}));
      if (notice===null || notice.delivery!==null) return;
      const attempt = await send(
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
              hasRole(c, "approve.reviewer", notice.parent.reviewer) &&
              (notice.parent.parent.location === null ||
                (await can_work(c, notice.parent.reviewer, notice.parent.parent.location)))),
        },
      );
      await set(c, notice, { delivery: attempt });
    },
  };
}

export async function documentsPage(c, bindings) {
  return renderPage(
    c,
    documentsPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs derives current declared ancestry. */
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Document intake", { nl: "Document aanmaken" }),
        children: [
          form({
            context: c,
            operation: "approve.Document.create",
            /* desired-unimplemented: placed inputs move the generated controls. */
            children: [
              input({ context: c, field: "title" }),
              input({ context: c, field: "category" }),
              input({ context: c, field: "subject" }),
              input({ context: c, field: "email" }),
            ],
          }),
        ],
      }),
      list({
        context: c,
        model: "approve.Document",
        where: (document) => same(document.submitter, c.actor),
        columns: ["title", "location", "category", "current"],
        filter: ["location", "category"],
        search: ["title"],
        display: "split",
        renderRow: (document, view) => [
          /* desired-unimplemented: pagination consumes this collection cursor. */
          pagination({ context: view }),
          card({
            context: view,
            title: message("Current document", { nl: "Huidig document" }),
            children: [
              edit({ context: view, operation: "approve.Document.update", record: document }),
              form({
                context: view,
                operation: "approve.submit",
                arguments: { document },
                /* desired-unimplemented: placed controls move the generated controls. */
                children: [
                  file_input({ context: view, field: "file" }),
                  textarea({ context: view, field: "note" }),
                  input({ context: view, field: "reviewer_email" }),
                ],
              }),
              form({context:view,operation:"approve.reviewer_choices",arguments:{document},
                renderResult:(result,resultView)=>[
                  list({context:resultView,rows:result,columns:["name","user","role","home"],
                    renderRow:(candidate,candidateView)=>[
                      /* desired-unimplemented: pagination consumes this collection cursor. */
                      pagination({ context: candidateView }),
                      form({context:candidateView,operation:"approve.submit",arguments:{document,assignee:candidate.user}}),
                    ],
                  }),
                ],
              }),
            ],
          }),
          collapse({
            context: view,
            caption: message("Submitted version history", { nl: "Ingediende versiehistorie" }),
            open: c.preferences.approve.versions_open,
            children: [
              table({
                context: view,
                model: "approve.Submission",
                parent: document,
                columns: ["revision", "file", "note", "reviewer", "due", "overdue", "state", "reason"],
                order: ["-revision"],
                filter: ["state", "reviewer", "overdue"],
                renderRow: (submission, rowView) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: rowView }),
                  /* desired-unimplemented: badge/status present readable typed values. */
                  badge({ context: rowView, value: submission.state }),
                  status({ context: rowView, value: submission.overdue }),
                  /* desired-unimplemented: button action lowers to the canonical binding. */
                  button({ context: rowView, action: "approve.withdraw", arguments: { submission } }),
                  collapse({
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
                    columns: ["assignment", "kind", "recipient", "state", "created_by", "created"],
                    order: ["created"],
                    renderRow: (notice, w) => [
                      /* desired-unimplemented: pagination consumes this collection cursor. */
                      pagination({ context: w }),
                    ],
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

export async function reviewPage(c, bindings) {
  return renderPage(
    c,
    reviewPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs derives current declared ancestry. */
      breadcrumbs({ context: c }),
      table({
        context: c,
        model: "approve.Submission",
        columns: ["parent", "revision", "file", "note", "reviewer", "due", "overdue", "state"],
        order: ["due"],
        filter: ["state", "reviewer", "parent.location", "parent.category", "overdue"],
        defaults: { state: c.preferences.approve.review_state },
        display: "split",
        renderRow: (submission, view) => [
          /* desired-unimplemented: pagination consumes this collection cursor. */
          pagination({ context: view }),
          card({
            context: view,
            title: message("Exact submitted version", { nl: "Exact ingediende versie" }),
            children: [
              /* desired-unimplemented: badge/status present readable typed values. */
              badge({ context: view, value: submission.state }),
              status({ context: view, value: submission.overdue }),
              text({
                context: view,
                values: [
                  submission.revision,
                  submission.file,
                  submission.note,
                  submission.due,
                  submission.reason,
                ],
              }),
              /* desired-unimplemented: join groups the dialog openers. */
              join({
                context: view,
                children: [
                  /* desired-unimplemented: button opens activates the local modal. */
                  button({ context: view, opens: "decide_dialog" }),
                  button({ context: view, opens: "assign_dialog" }),
                ],
              }),
              /* desired-unimplemented: modal declares the local activation identity. */
              modal({
                context: view,
                caption: message("Record decision", { nl: "Besluit vastleggen" }),
                id: "decide_dialog",
                children: [
                  slot({
                    context: view,
                    name: "content",
                    children: [
                      form({
                        context: view,
                        operation: "approve.decide",
                        arguments: { submission },
                        display: "inline",
                        /* desired-unimplemented: placed controls move the generated controls. */
                        children: [
                          checkbox({ context: view, field: "approve" }),
                          textarea({ context: view, field: "reason" }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              modal({
                context: view,
                caption: message("Assign", { nl: "Toewijzen" }),
                id: "assign_dialog",
                children: [
                  slot({
                    context: view,
                    name: "content",
                    children: [
                      form({
                        context: view,
                        operation: "approve.assign",
                        arguments: { submission },
                        display: "inline",
                        /* desired-unimplemented: placed input moves the generated control. */
                        children: [input({ context: view, field: "email" })],
                      }),
                    ],
                  }),
                ],
              }),
              form({context:view,operation:"approve.reviewer_choices",arguments:{document:submission.parent},
                renderResult:(result,resultView)=>[
                  list({context:resultView,rows:result,columns:["name","user","role","home"],
                    renderRow:(candidate,candidateView)=>[
                      /* desired-unimplemented: pagination consumes this collection cursor. */
                      pagination({ context: candidateView }),
                      form({context:candidateView,operation:"approve.assign",arguments:{submission,assignee:candidate.user}}),
                    ],
                  }),
                ],
              }),
            ],
          }),
          collapse({
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
            columns: ["assignment", "kind", "recipient", "state", "created_by", "created"],
            order: ["created"],
            renderRow: (notice, w) => [
              /* desired-unimplemented: pagination consumes this collection cursor. */
              pagination({ context: w }),
            ],
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
  const reviewer_user={dependencies:[],user:async(c,s)=>({roles:["approve.reviewer"]})};
  const replacement_user={dependencies:[],user:async(c,s)=>({roles:["approve.reviewer"]})};
  const coordinator_user={dependencies:[],user:async(c,s)=>({roles:["approve.coordinator"]})};
  const ordinary_user={dependencies:[],user:async(c,s)=>({roles:[]})};
  const hr_user={dependencies:[],user:async(c,s)=>({roles:["employee.hr"]})};
  const reviewer_worker={model:"employee.Employee",dependencies:[test_site,reviewer_user],value:async(c,s)=>({user:s.reviewer_user,name:"Alex",home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Reviewer"})};
  const replacement_worker={model:"employee.Employee",dependencies:[test_site,replacement_user],value:async(c,s)=>({user:s.replacement_user,name:"Alex",home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Replacement reviewer"})};
  const coordinator_worker={model:"employee.Employee",dependencies:[test_site,coordinator_user],value:async(c,s)=>({user:s.coordinator_user,home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Coordinator"})};
  const ordinary_worker={model:"employee.Employee",dependencies:[test_site,ordinary_user],value:async(c,s)=>({user:s.ordinary_user,home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Reviewer"})};
  const document = {
    model: "approve.Document",
    dependencies: [test_site],
    value: async (c, s) => ({
      location: s.test_site,
      title: "Plan",
      current: 1n,
      category: "Signage",
      submitter: s.self,
      email: "submitter@example.test",
    }),
  };
  const original = { dependencies: [], file: async (c, s) => ({}) };
  const replacement = { dependencies: [], file: async (c, s) => ({}) };
  const pending_version = {
    model: "approve.Submission",
    dependencies: [document, original, reviewer_user],
    value: async (c, s) => ({
      parent: s.document,
      revision: 1n,
      file: s.original,
      note: "Signage",
      reviewer: s.reviewer_user,
      reviewer_email: "reviewer@example.test",
      due: addDuration(c.now, 86400000n),
    }),
  };
  const attempt={dependencies:[],delivery:"approve.Mail.send",values:async(c,s)=>({request:{to:"reviewer@example.test",subject:"Review",body:"Plan"}})};
  const detached_delivery={dependencies:[],delivery:"approve.Mail.send",values:async(c,s)=>({request:{to:"reviewer@example.test",subject:"Review",body:"Plan"},status:"failed",error:{code:"provider",message:"Delivery rejected"}})};
  const decision_attempt={dependencies:[],delivery:"approve.Mail.send",values:async(c,s)=>({request:{to:"submitter@example.test",subject:"Review",body:"Approved with conditions"}})};
  const pending_notice = {
    model: "approve.Notice",
    dependencies: [pending_version, attempt],
    value: async (c, s) => ({
      parent: s.pending_version,
      kind: "request",
      assignment: 1n,
      recipient: "reviewer@example.test",
      subject: "Review",
      body: "Plan",
      delivery: s.attempt,
    }),
  };
  const accepted = {
    model: "approve.Submission",
    dependencies: [document, original, reviewer_user],
    value: async (c, s) => ({
      parent: s.document,
      revision: 1n,
      file: s.original,
      note: "Original",
      reviewer: s.reviewer_user,
      reviewer_email: "reviewer@example.test",
      due: addDuration(c.now, 86400000n),
      state: "approved",
      decided_by: s.reviewer_user,
      decided_at: c.now,
    }),
  };
  return {
    document,
    original,
    replacement,
    pending_version,
    accepted,
    pending_notice, attempt, detached_delivery, decision_attempt,
    reviewer_user, replacement_user, coordinator_user, ordinary_user, hr_user, reviewer_worker, replacement_worker, coordinator_worker, ordinary_worker,
    examples: [
      {
        operation:"approve.reviewer_choices",seed:[test_worker,reviewer_worker,replacement_worker,ordinary_worker,coordinator_worker],
        dependencies:[document],inputs:async(c,s)=>({document:s.document}),
        selectors:["as","document.submitter","document.location","reviewer_worker.active","reviewer_worker.name","test_worker.active"],
        observations:[async(c,s)=>await count(s.result),async(c,s)=>await count(s.result.filter(candidate=>candidate.name==="Alex")),async(c,s)=>await any(s.result,candidate=>same(candidate.user,s.ordinary_user))],
        rows:[
          {dependencies:[],values:async(c,s)=>[s.self, s.self, s.test_site, true, "Alex", true],expected:async(c,s)=>[2n,2n,false]},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, s.test_site, false, "Alex", true],expected:async(c,s)=>[1n,1n,false]},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, null, false, "Alex", true],expected:async(c,s)=>[1n,1n,false]},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, s.test_site, true, null, true],expected:async(c,s)=>[2n,1n,false]},
          {dependencies:[],values:async(c,s)=>[s.coordinator_user, s.self, s.test_site, true, "Alex", true],expected:async(c,s)=>[2n,2n,false]},
          {dependencies:[],values:async(c,s)=>[s.reviewer_user, s.reviewer_user, s.test_site, true, "Alex", true],expected:async(c,s)=>[1n,1n,false]},
          {dependencies:[],values:async(c,s)=>[s.reviewer_user, s.self, s.test_site, true, "Alex", true],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, s.test_site, true, "Alex", false],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, null, true, "Alex", false],expected:async(c,s)=>[0n,0n,false]},
          {dependencies:[],values:async(c,s)=>[s.outsider, s.self, s.test_site, true, "Alex", true],error:"forbidden"},
          {dependencies:[],values:async(c,s)=>["public", s.self, s.test_site, true, "Alex", true],error:"forbidden"},
        ],
      },
      {
        operation:"approve.reviewer_choices",seed:[pending_notice,test_worker,detached_delivery],
        dependencies:[document],inputs:async(c,s)=>({document:s.document}),selectors:["pending_notice.delivery", "attempt.status", "attempt.result", "attempt.error"],
        observations:[async(c,s)=>(await delivery(c,{record:s.pending_notice,field:"delivery"},["status"]))?.status ?? null,async(c,s)=>s.pending_version.state],
        rows:[
          {dependencies:[attempt],values:async(c,s)=>[s.attempt, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["succeeded", "pending"]},
          {dependencies:[attempt],values:async(c,s)=>[s.attempt, "unknown", null, null],expected:async(c,s)=>["unknown", "pending"]},
          {dependencies:[attempt],values:async(c,s)=>[s.attempt, "skipped", null, null],expected:async(c,s)=>["skipped", "pending"]},
          {dependencies:[attempt],values:async(c,s)=>[s.attempt, "failed", null, {code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["failed", "pending"]},
          {dependencies:[attempt],values:async(c,s)=>[s.attempt, "pending", null, null],expected:async(c,s)=>["pending", "pending"]},
          {dependencies:[],values:async(c,s)=>[null, "pending", null, null],expected:async(c,s)=>[null, "pending"]}
        ],
      },
      {
        operation:"approve.reviewer_choices",seed:[pending_notice,test_worker,decision_attempt],dependencies:[document,reviewer_user,decision_attempt],
        inputs:async(c,s)=>({document:s.document}),
        selectors:["pending_notice.kind", "pending_notice.recipient", "pending_notice.body", "pending_version.state", "pending_version.reason", "pending_version.decided_by", "pending_version.decided_at", "pending_notice.delivery", "decision_attempt.status", "decision_attempt.result", "decision_attempt.error"],
        observations:[async(c,s)=>(await delivery(c,{record:s.pending_notice,field:"delivery"},["status"]))?.status ?? null,async(c,s)=>s.pending_version.state,async(c,s)=>s.pending_version.file,async(c,s)=>s.pending_version.reason,async(c,s)=>s.pending_version.decided_by,async(c,s)=>s.pending_version.decided_at],
        rows:[
          {dependencies:[decision_attempt,original,reviewer_user],values:async(c,s)=>["decision", "submitter@example.test", "Approved with conditions", "approved", "Approved with conditions", s.reviewer_user, c.now, s.decision_attempt, "failed", null, {code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["failed", "approved", s.original, "Approved with conditions", s.reviewer_user, c.now]},
          {dependencies:[original,reviewer_user],values:async(c,s)=>["decision", "submitter@example.test", "Approved with conditions", "approved", "Approved with conditions", s.reviewer_user, c.now, null, "pending", null, null],expected:async(c,s)=>[null, "approved", s.original, "Approved with conditions", s.reviewer_user, c.now]}
        ],
      },
      // Proposed causal sequences: no implicit call or trusted-handler invocation.
      {operation:"approve.submit",dependencies:[test_worker, reviewer_worker, coordinator_worker, replacement_worker, original, replacement],sequence:[
        {
          operation:"approve.Document.create",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({location:s.test_site,title:"Signage plan",category:"Signage",subject:null,email:c.actor.email}),
        },
        {
          let:"document_record",
          value:async(c,s,b)=>await first(records(c,"approve.Document",{where:row=>same(row.submitter,s.self),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.document_record!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({document:b.document_record,file:s.original,note:"Submitted plan",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:addDuration(c.now,86400000n)}),
        },
        {
          let:"first_pending",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.first_pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({submission:b.first_pending,approve:false,reason:"Replace page two"}),
        },
        {
          let:"first_rejected",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.first_rejected!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.assign",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({submission:b.first_rejected,assignee:s.replacement_user,email:"new-reviewer@example.test"}),
          error:"rule_failed",
        },
        {
          let:"replacement_document",
          value:async(c,s,b)=>await first(records(c,"approve.Document",{where:row=>same(row.submitter,s.self),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.replacement_document!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({document:b.replacement_document,file:s.replacement,note:"Corrected page two",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:addDuration(c.now,86400000n)}),
        },
        {
          let:"second_pending",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===2n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.second_pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({submission:b.second_pending,approve:true,reason:"Approved with conditions"}),
        },
        {
          let:"second_approved",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===2n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.second_approved!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          let:"retained_rejection",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.retained_rejection!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[b.retained_rejection.file, b.retained_rejection.state, b.retained_rejection.reason, b.retained_rejection.decided_by, b.second_approved.file, b.second_approved.state, b.second_approved.reason, b.second_approved.decided_by, await any(records(c,"approve.Notice",{parent:b.retained_rejection}),notice=>notice.kind==="decision"&&notice.body==="Replace page two"&&notice.assignment===1n), await any(records(c,"approve.Notice",{parent:b.second_approved}),notice=>notice.kind==="decision"&&notice.body==="Approved with conditions"&&notice.assignment===1n)],
          expected:async(c,s,b)=>[s.original, "rejected", "Replace page two", s.reviewer_user, s.replacement, "approved", "Approved with conditions", s.reviewer_user, true, true],
          types:["file", "approve.Submission.state", "text?", "user?", "file", "approve.Submission.state", "text?", "user?", "bool", "bool"],
        },
      ]},
      {operation:"approve.submit",dependencies:[test_worker, reviewer_worker, coordinator_worker, replacement_worker, ordinary_user, original, replacement],sequence:[
        {
          operation:"approve.Document.create",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({location:s.test_site,title:"Signage plan",category:"Signage",subject:null,email:c.actor.email}),
        },
        {
          let:"document_record",
          value:async(c,s,b)=>await first(records(c,"approve.Document",{where:row=>same(row.submitter,s.self),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.document_record!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({document:b.document_record,file:s.original,note:"Submitted plan",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:addDuration(c.now,86400000n)}),
        },
        {
          let:"old_pending",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.old_pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          let:"current_document",
          value:async(c,s,b)=>await first(records(c,"approve.Document",{where:row=>same(row.submitter,s.self),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.current_document!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({document:b.current_document,file:s.replacement,note:"Invalid due attempt",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:c.now}),
          error:"rule_failed",
        },
        {
          let:"preserved_pending",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.preserved_pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[b.preserved_pending.file, b.preserved_pending.state, await count(records(c,"approve.Submission",{parent:b.document_record}))],
          expected:async(c,s,b)=>[s.original, "pending", 1n],
          types:["file", "approve.Submission.state", "int"],
        },
        {
          operation:"approve.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({document:b.current_document,file:s.replacement,note:"Submitted plan",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:addDuration(c.now,86400000n)}),
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({submission:b.old_pending,approve:true,reason:"Stale open review"}),
          error:"conflict",
        },
        {
          let:"new_pending",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===2n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.new_pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[await count(records(c,"approve.Submission",{parent:b.document_record}))],
          expected:async(c,s,b)=>[1n],
          types:["int"],
        },
        {
          operation:"approve.assign",
          by:async(c,s,b)=>s.ordinary_user,
          inputs:async(c,s,b)=>({submission:b.new_pending,assignee:s.replacement_user,email:"new-reviewer@example.test"}),
          error:"forbidden",
        },
        {
          observations:async(c,s,b)=>[await count(records(c,"approve.Document")), await count(records(c,"approve.Submission"))],
          expected:async(c,s,b)=>[0n, 0n],
          types:["int", "int"],
        },
        {
          operation:"approve.assign",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({submission:b.new_pending,assignee:s.replacement_user,email:"new-reviewer@example.test"}),
        },
        {
          let:"reassigned",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===2n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.reassigned!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({submission:b.new_pending,approve:true,reason:"Stale assignment"}),
          error:"conflict",
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({submission:b.reassigned,approve:true,reason:"Former assignee"}),
          error:"rule_failed",
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.replacement_user,
          inputs:async(c,s,b)=>({submission:b.reassigned,approve:true,reason:"Replacement reviewer checked"}),
        },
        {
          let:"approved_reassignment",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===2n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.approved_reassignment!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[b.approved_reassignment.file, b.approved_reassignment.reviewer, b.approved_reassignment.assignment, b.approved_reassignment.state, b.approved_reassignment.decided_by, await any(records(c,"approve.Notice",{parent:b.approved_reassignment}),notice=>notice.kind==="request"&&notice.assignment===1n&&notice.recipient==="reviewer@example.test"), await any(records(c,"approve.Notice",{parent:b.approved_reassignment}),notice=>notice.kind==="request"&&notice.assignment===2n&&notice.recipient==="new-reviewer@example.test"&&same(notice.created_by,s.coordinator_user))],
          expected:async(c,s,b)=>[s.replacement, s.replacement_user, 2n, "approved", s.replacement_user, true, true],
          types:["file", "user", "int", "approve.Submission.state", "user?", "bool", "bool"],
        },
      ]},
      {operation:"approve.submit",dependencies:[test_worker, reviewer_worker, replacement_worker, coordinator_worker, hr_user, original],sequence:[
        {
          operation:"approve.Document.create",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({location:s.test_site,title:"Signage plan",category:"Signage",subject:null,email:c.actor.email}),
        },
        {
          let:"document_record",
          value:async(c,s,b)=>await first(records(c,"approve.Document",{where:row=>same(row.submitter,s.self),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.document_record!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({document:b.document_record,file:s.original,note:"Submitted plan",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:addDuration(c.now,86400000n)}),
        },
        {
          let:"pending_review",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.pending_review!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          let:"review_version",
          value:async(c,s,b)=>b.pending_review.version,
        },
        {let:"review_document",value:async(c,s,b)=>await first(records(c,"approve.Document",{where:row=>same(row.submitter,s.self),order:["id"]}))},
        {observations:async(c,s,b)=>[b.review_document!==null],expected:async()=>[true],types:["bool"]},
        {operation:"approve.reviewer_choices",by:async(c,s,b)=>s.self,inputs:async(c,s,b)=>({document:b.review_document}),bind:"before_reviewers"},
        {observations:async(c,s,b)=>[await any(b.before_reviewers,candidate=>same(candidate.user,s.reviewer_user))],expected:async()=>[true],types:["bool"]},
        {
          operation:"employee.deactivate",
          by:async(c,s,b)=>s.hr_user,
          inputs:async(c,s,b)=>({employee:s.reviewer_worker,ended:date("2026-10-02")}),
        },
        {operation:"approve.reviewer_choices",by:async(c,s,b)=>s.self,inputs:async(c,s,b)=>({document:b.review_document}),bind:"after_reviewers"},
        {observations:async(c,s,b)=>[await any(b.after_reviewers,candidate=>same(candidate.user,s.reviewer_user)),await any(b.after_reviewers,candidate=>same(candidate.user,s.replacement_user))],expected:async()=>[false,true],types:["bool","bool"]},
        {
          observations:async(c,s,b)=>[s.reviewer_worker.active, hasRole(c,"approve.reviewer",s.reviewer_user), await can_work(c,s.reviewer_user,s.test_site)],
          expected:async(c,s,b)=>[false, true, false],
          types:["bool", "bool", "bool"],
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({submission:b.pending_review,approve:true,reason:"Unavailable reviewer"}),
          error:"rule_failed",
        },
        {
          operation:"approve.assign",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({submission:b.pending_review,assignee:s.replacement_user,email:"new-reviewer@example.test"}),
        },
        {
          let:"recovered_review",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.recovered_review!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"approve.assign",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({submission:b.recovered_review,assignee:s.replacement_user,email:"new-reviewer@example.test"}),
          request:async(c,s,b)=>({submission:{version:b.review_version}}),
          error:"conflict",
        },
        {
          operation:"approve.decide",
          by:async(c,s,b)=>s.replacement_user,
          inputs:async(c,s,b)=>({submission:b.recovered_review,approve:true,reason:"Recovery checked"}),
        },
        {
          let:"recovered_approval",
          value:async(c,s,b)=>await first(records(c,"approve.Submission",{parent:b.document_record,where:row=>row.revision===1n,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.recovered_approval!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[b.recovered_approval.revision, b.recovered_approval.file, b.recovered_approval.note, b.recovered_approval.due, b.recovered_approval.reviewer, b.recovered_approval.assignment, b.recovered_approval.state, b.recovered_approval.decided_by, await count(records(c,"approve.Notice",{parent:b.recovered_approval}))],
          expected:async(c,s,b)=>[1n, s.original, "Submitted plan", addDuration(c.now,86400000n), s.replacement_user, 2n, "approved", s.replacement_user, 3n],
          types:["int", "file", "text", "datetime", "user", "int", "approve.Submission.state", "user?", "int"],
        },
      ]},
      {
        operation:"approve.Document.update",
        kind:"update",
        seed:[test_worker],
        dependencies:[document, test_worker],
        inputs:async(c,s)=>({record:s.document}),
        selectors:["as", "changes.title"],
        observations:[async(c,s)=>s.document.title],
        rows:[
          {dependencies:[],values:async(c,s)=>["members", "New title"],expected:async(c,s)=>["New title"]},
          {dependencies:[],values:async(c,s)=>["outsider", "New title"],error:"not_found"},
        ],
      },
      {
        operation:"approve.submit",
        seed:[pending_version, reviewer_worker, ordinary_worker, test_worker],
        dependencies:[document, replacement, reviewer_user, pending_version, reviewer_worker, ordinary_worker, test_worker],
        inputs:async(c,s)=>({document:s.document,file:s.replacement,note:"Updated",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:addDuration(c.now,86400000n)}),
        selectors:["as", "document.location", "document.current", "assignee", "reviewer_worker.active", "test_worker.active", "due", "request.document.version"],
        observations:[async(c,s)=>s.document.current, async(c,s)=>s.pending_version.state, async(c,s)=>s.pending_version.file, async(c,s)=>await count(records(c,"approve.Submission",{parent:s.document}))],
        rows:[
          {dependencies:[reviewer_user, original],values:async(c,s)=>[s.self, null, 1n, s.reviewer_user, true, true, addDuration(c.now,86400000n), 1n],expected:async(c,s)=>[2n, "withdrawn", s.original, 2n]},
          {dependencies:[reviewer_user],values:async(c,s)=>["public", null, 1n, s.reviewer_user, true, true, addDuration(c.now,86400000n), 1n],error:"forbidden"},
          {dependencies:[ordinary_user],values:async(c,s)=>[s.self, null, 1n, s.ordinary_user, true, true, addDuration(c.now,86400000n), 1n],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>[s.self, null, 1n, s.self, true, true, addDuration(c.now,86400000n), 1n],error:"rule_failed"},
          {dependencies:[test_site, reviewer_user],values:async(c,s)=>[s.self, s.test_site, 1n, s.reviewer_user, false, true, addDuration(c.now,86400000n), 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, null, 1n, s.reviewer_user, true, true, subtractDuration(c.now,60000n), 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, null, 1n, s.reviewer_user, true, true, addDuration(c.now,86400000n), 2n],error:"conflict"},
          {dependencies:[test_site, reviewer_user],values:async(c,s)=>[s.self, s.test_site, 1n, s.reviewer_user, true, true, addDuration(c.now,86400000n), 1n],expected:async(c,s)=>[2n, "withdrawn", s.original, 2n]},
          {dependencies:[test_site, reviewer_user],values:async(c,s)=>[s.self, s.test_site, 1n, s.reviewer_user, true, false, addDuration(c.now,86400000n), 1n],error:"rule_failed"},
        ],
      },
      {
        operation:"approve.submit",
        seed:[accepted],
        dependencies:[document, replacement, reviewer_user, accepted],
        inputs:async(c,s)=>({document:s.document,file:s.replacement,note:"Updated",assignee:s.reviewer_user,reviewer_email:"reviewer@example.test",due:addDuration(c.now,86400000n)}),
        selectors:["as", "document.location", "document.current"],
        observations:[async(c,s)=>s.accepted.state, async(c,s)=>s.accepted.file, async(c,s)=>await count(records(c,"approve.Submission",{parent:s.document}))],
        rows:[
          {dependencies:[original],values:async(c,s)=>[s.self, null, 1n],expected:async(c,s)=>["approved", s.original, 2n]},
        ],
      },
      {
        operation:"approve.assign",
        seed:[reviewer_worker, replacement_worker, coordinator_worker, ordinary_worker],
        dependencies:[pending_version, replacement_user, reviewer_worker, replacement_worker, coordinator_worker, ordinary_worker],
        inputs:async(c,s)=>({submission:s.pending_version,assignee:s.replacement_user,email:"new-reviewer@example.test"}),
        selectors:["as", "submission.parent.location", "submission.parent.current", "submission.state", "assignee", "replacement_worker.active", "coordinator_worker.active", "request.submission.version"],
        observations:[async(c,s)=>s.submission.assignment, async(c,s)=>s.submission.reviewer, async(c,s)=>s.submission.reviewer_email, async(c,s)=>await count(records(c,"approve.Notice",{parent:s.submission})), async(c,s)=>s.submission.file],
        rows:[
          {dependencies:[coordinator_user, replacement_user, original],values:async(c,s)=>[s.coordinator_user, null, 1n, "pending", s.replacement_user, true, true, 1n],expected:async(c,s)=>[2n, s.replacement_user, "new-reviewer@example.test", 1n, s.original]},
          {dependencies:[replacement_user],values:async(c,s)=>["members", null, 1n, "pending", s.replacement_user, true, true, 1n],error:"forbidden"},
          {dependencies:[coordinator_user, replacement_user],values:async(c,s)=>[s.coordinator_user, null, 2n, "pending", s.replacement_user, true, true, 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, ordinary_user],values:async(c,s)=>[s.coordinator_user, null, 1n, "pending", s.ordinary_user, true, true, 1n],error:"rule_failed"},
          {dependencies:[coordinator_user],values:async(c,s)=>[s.coordinator_user, null, 1n, "pending", s.self, true, true, 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, test_site, replacement_user],values:async(c,s)=>[s.coordinator_user, s.test_site, 1n, "pending", s.replacement_user, false, true, 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, test_site, replacement_user],values:async(c,s)=>[s.coordinator_user, s.test_site, 1n, "pending", s.replacement_user, true, false, 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, replacement_user],values:async(c,s)=>[s.coordinator_user, null, 1n, "approved", s.replacement_user, true, true, 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, replacement_user],values:async(c,s)=>[s.coordinator_user, null, 1n, "pending", s.replacement_user, true, true, 2n],error:"conflict"},
        ],
      },
      {
        operation:"approve.assign",
        seed:[replacement_worker, coordinator_worker],
        dependencies:[pending_version, replacement_user, replacement_worker, coordinator_worker],
        inputs:async(c,s)=>({submission:s.pending_version,assignee:s.replacement_user,email:"new-reviewer@example.test"}),
        selectors:["as", "submission.due"],
        observations:[async(c,s)=>s.submission.assignment, async(c,s)=>s.submission.due, async(c,s)=>s.submission.overdue],
        rows:[
          {dependencies:[coordinator_user],values:async(c,s)=>[s.coordinator_user, subtractDuration(c.now,60000n)],expected:async(c,s)=>[2n, subtractDuration(c.now,60000n), true]},
        ],
      },
      {
        operation:"approve.decide",
        seed:[reviewer_worker],
        dependencies:[pending_version, reviewer_worker],
        inputs:async(c,s)=>({submission:s.pending_version,reason:"Approved with conditions"}),
        selectors:["as", "submission.parent.location", "submission.parent.current", "submission.reviewer", "submission.parent.submitter", "approve", "reviewer_worker.active", "request.submission.version"],
        observations:[async(c,s)=>s.submission.state, async(c,s)=>s.submission.decided_by, async(c,s)=>s.submission.file, async(c,s)=>await count(records(c,"approve.Notice",{parent:s.submission}))],
        rows:[
          {dependencies:[reviewer_user, original],values:async(c,s)=>[s.reviewer_user, null, 1n, s.reviewer_user, s.self, true, true, 1n],expected:async(c,s)=>["approved", s.reviewer_user, s.original, 1n]},
          {dependencies:[original],values:async(c,s)=>["approve.reviewer", null, 1n, s.self, s.other, true, true, 1n],expected:async(c,s)=>["approved", s.self, s.original, 1n]},
          {dependencies:[],values:async(c,s)=>["approve.reviewer", null, 2n, s.self, s.other, true, true, 1n],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>["approve.reviewer", null, 1n, s.self, s.self, true, true, 1n],error:"rule_failed"},
          {dependencies:[ordinary_user, reviewer_user],values:async(c,s)=>[s.ordinary_user, null, 1n, s.reviewer_user, s.self, true, true, 1n],error:"forbidden"},
          {dependencies:[reviewer_user, test_site],values:async(c,s)=>[s.reviewer_user, s.test_site, 1n, s.reviewer_user, s.self, true, false, 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.reviewer_user, null, 1n, s.reviewer_user, s.self, true, true, 2n],error:"conflict"},
        ],
      },
      {
        operation:"approve.decide",
        seed:[],
        dependencies:[pending_version],
        inputs:async(c,s)=>({submission:s.pending_version,approve:false}),
        selectors:["as", "submission.parent.location", "submission.parent.current", "submission.reviewer", "submission.parent.submitter", "reason"],
        observations:[async(c,s)=>s.submission.state, async(c,s)=>s.submission.reason],
        rows:[
          {dependencies:[],values:async(c,s)=>["approve.reviewer", null, 1n, s.self, s.other, "Replace page two"],expected:async(c,s)=>["rejected", "Replace page two"]},
          {dependencies:[],values:async(c,s)=>["approve.reviewer", null, 1n, s.self, s.other, ""],error:"rule_failed"},
        ],
      },
      {
        operation:"approve.withdraw",
        seed:[],
        dependencies:[pending_version],
        inputs:async(c,s)=>({submission:s.pending_version}),
        selectors:["as", "submission.state"],
        observations:[async(c,s)=>s.submission.state, async(c,s)=>s.submission.file],
        rows:[
          {dependencies:[original],values:async(c,s)=>[s.self, "pending"],expected:async(c,s)=>["withdrawn", s.original]},
          {dependencies:[ordinary_user],values:async(c,s)=>[s.ordinary_user, "pending"],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>[s.self, "approved"],error:"rule_failed"},
        ],
      },
      {
        operation:"approve.remind",
        seed:[reviewer_worker, ordinary_worker],
        dependencies:[pending_version, reviewer_worker, ordinary_worker],
        inputs:async(c,s)=>({event:{submission:s.pending_version,assignment:1n}}),
        selectors:["pending_version.parent.current", "pending_version.due", "pending_version.assignment", "pending_version.state", "pending_version.reviewer", "pending_version.parent.location", "reviewer_worker.active"],
        observations:[async(c,s)=>await count(records(c,"approve.Notice",{parent:s.pending_version}))],
        rows:[
          {dependencies:[reviewer_user],values:async(c,s)=>[1n, subtractDuration(c.now,60000n), 1n, "pending", s.reviewer_user, null, true],expected:async(c,s)=>[1n]},
          {dependencies:[reviewer_user],values:async(c,s)=>[1n, subtractDuration(c.now,60000n), 2n, "pending", s.reviewer_user, null, true],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[1n, subtractDuration(c.now,60000n), 1n, "withdrawn", s.reviewer_user, null, true],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[1n, addDuration(c.now,60000n), 1n, "pending", s.reviewer_user, null, true],error:"rule_failed"},
          {dependencies:[ordinary_user],values:async(c,s)=>[1n, subtractDuration(c.now,60000n), 1n, "pending", s.ordinary_user, null, true],error:"rule_failed"},
          {dependencies:[reviewer_user, test_site],values:async(c,s)=>[1n, subtractDuration(c.now,60000n), 1n, "pending", s.reviewer_user, s.test_site, false],error:"rule_failed"},
        ],
      },

    ],
  };
}
