import {
  delivery,
  require as check,
  all,
  any,
  group,
  call,
  collect,
  first,
  date,
  compareInstant,
  compareMoney,
  count,
  create,
  datetime,
  format,
  hasRole,
  money,
  records,
  same,
  send,
  set,
  subtractMoney,
  addDuration,
  subtractDuration,
  equalValue,
  sum,
} from "@canlang/stdlib";
import {
  actions,
  card,
  edit,
  form,
  history,
  list,
  message,
  metrics,
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

const budgetCaption = message("Program budget", { nl: "Programmabudget" });

const reviewerCaption = message("Reviewer", { nl: "Beoordelaar" });

const receivedCaption = message("Received at", { nl: "Ontvangen op" });

const overrideCaption = message("Deadline override reason", { nl: "Reden deadline-uitzondering" });

const awardsPageDescriptor = {
  owner: "grant",
  path: "/awards",
  title: message("Funded programs", { nl: "Financieringsprogramma's" }),
  description: message("Discover the published cash-award terms and use private applicant intake.", {
    nl: "Bekijk de gepubliceerde subsidievoorwaarden en gebruik de private aanvraagprocedure.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    return {};
  },
  render: awardsPage,
};

const reviewPageDescriptor = {
  owner: "grant",
  path: "/awards/review",
  title: message("Award review", { nl: "Aanvragen beoordelen" }),
  description: message("Review assigned applications and visible monetary commitments.", {
    nl: "Beoordeel toegewezen aanvragen en zichtbare financiële toezeggingen.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "grant.reviewer") || hasRole(c, "grant.coordinator"), "forbidden");
    return {};
  },
  render: reviewPage,
};

export const appDefinition = {
  id: "CanGrant",
  uses: ["grant"],
  description: message(
    "Optionally help a workspace operator run a funded startup or community program that awards monetary support to selected applicants.",
    {
      nl: "Help een werkplekbeheerder desgewenst een gefinancierd startup- of gemeenschapsprogramma te organiseren dat geselecteerde aanvragers financiële steun toekent.",
    },
  ),
  packages: {
    grant: {
      description: message(
        "Keep applicant records private and reserve only affordable monetary award commitments.",
        { nl: "Houd aanvragen privé en leg alleen betaalbare financiële toezeggingen vast." },
      ),
      roles: {
        coordinator: {
          id: "grant.coordinator",
          label: message("Program coordinator", { nl: "Programmacoördinator" }),
        },
        reviewer: { id: "grant.reviewer", label: reviewerCaption },
      },
    },
  },
  bindings: { "grant.Mail": { capability: "std.EmailV1", from: "deployment.mail" } },
  contracts: {
    "grant.Question": {
      label: message("Eligibility question", { nl: "Toelatingsvraag" }),
      fields: {
        key: { type: "text", trim: true, min: 1n },
        prompt: { type: "text", trim: true, min: 1n },
      },
    },
    "grant.Answer": {
      label: message("Recorded answer", { nl: "Vastgelegd antwoord" }),
      fields: {
        question: { type: "text", trim: true, min: 1n },
        value: { type: "text", trim: true, min: 1n },
      },
    },
    "grant.AwardItem": {
      fields: {
        application: { type: "text" },
        title: { type: "text" },
        amount: { type: "money" },
        decided_at: { type: "datetime" },
      },
    },
    "grant.AwardBatch": {
      fields: { items: { type: "grant.AwardItem", array: true, requiredArray: true } },
    },
  },
  pure: {
    "grant.complete_answers": {
      handler: "complete_answers",
      inputs: {
        questions: { type: "grant.Question", array: true },
        answers: { type: "grant.Answer", array: true },
      },
      result: "bool",
    },
  },
  models: {
    "grant.Grant": {
      label: message("Funded program", { nl: "Financieringsprogramma" }),
      readGrants: [
        {
          rule: "Grant.read.1",
          fields: ["location", "name", "terms", "questions", "criteria", "closes", "timezone", "published"],
        },
        { rule: "Grant.read.2" },
        {
          rule: "Grant.read.3",
          fields: ["location", "name", "terms", "questions", "criteria", "closes", "timezone", "published"],
        },
      ],
      invariants: ["Grant.require.1"],
      fields: {
        location: { type: Location },
        name: { type: "text" },
        terms: { type: "text", label: message("Terms", { nl: "Voorwaarden" }) },
        questions: {
          type: "grant.Question",
          array: true,
          requiredArray: true,
          label: message("Questions", { nl: "Vragen" }),
        },
        criteria: {
          type: "text",
          label: message("Selection criteria", { nl: "Selectiecriteria" }),
        },
        budget: { type: "money", label: message("Budget", { nl: "Budget" }) },
        closes: { type: "datetime", label: message("Closing deadline", { nl: "Sluitingsdatum" }) },
        timezone: { type: "timezone" },
        published: {
          type: "bool",
          default: false,
          label: message("Published", { nl: "Gepubliceerd" }),
        },
      },
      derived: {
        requested: {
          type: "money",
          handler: "Grant.requested",
          label: message("Requested amount", { nl: "Aangevraagd bedrag" }),
        },
        withdrawn: {
          type: "money",
          handler: "Grant.withdrawn",
          label: message("Withdrawn amount", { nl: "Ingetrokken bedrag" }),
        },
        committed: {
          type: "money",
          handler: "Grant.committed",
          label: message("Committed amount", { nl: "Vastgelegd bedrag" }),
        },
        remaining: {
          type: "money",
          handler: "Grant.remaining",
          label: message("Remaining", { nl: "Resterend" }),
        },
      },
    },
    "grant.Application": {
      parent: "grant.Grant",
      label: message("Application", { nl: "Aanvraag" }),
      readGrants: [
        { rule: "Application.read.1" },
        { rule: "Application.read.2" },
        { rule: "Application.read.3" },
      ],
      invariants: ["Application.require.1"],
      locks: ["Application.lock.1", "Application.lock.2", "Application.lock.3", "Application.lock.4", "Application.lock.5"],
      unique: [{ fields: ["correction"], where: (c, row) => row.state === "draft" }],
      fields: {
        account: { type: "user", label: message("Account", { nl: "Account" }) },
        email: { type: "email" },
        title: { type: "text", trim: true, min: 1n },
        description: { type: "text", trim: true, min: 1n },
        terms: {type: "text", label: message("Frozen terms", {nl: "Vastgelegde voorwaarden"})},
        criteria: {type: "text", label: message("Frozen criteria", {nl: "Vastgelegde criteria"})},
        questions: {
          type: "grant.Question",
          array: true,
          requiredArray: true,
          label: message("Frozen questions", { nl: "Vastgelegde vragen" }),
        },
        correction: {
          type: "grant.Application",
          nullable: true,
          label: message("Corrects application", { nl: "Corrigeert aanvraag" }),
        },
        answers: {
          type: "grant.Answer",
          array: true,
          label: message("Answers", { nl: "Antwoorden" }),
        },
        amount: { type: "money" },
        reviewer: { type: "user", label: reviewerCaption },
        received: { type: "datetime", nullable: true, label: receivedCaption },
        receipt_evidence: {
          type: "text",
          nullable: true,
          label: message("Receipt evidence", { nl: "Ontvangstbewijs" }),
        },
        override_reason: { type: "text", nullable: true, label: overrideCaption },
        state: {
          type: "enum",
          cases: ["draft", "submitted", "approved", "rejected", "withdrawn", "superseded"],
          default: "draft",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              draft: message("Draft", { nl: "Concept" }),
              submitted: message("Submitted", { nl: "Ingediend" }),
              approved: message("Approved", { nl: "Goedgekeurd" }),
              rejected: message("Rejected", { nl: "Afgewezen" }),
              withdrawn: message("Withdrawn", { nl: "Ingetrokken" }),
              superseded: message("Superseded", { nl: "Vervangen" }),
            },
          },
        },
        decision: { type: "text", nullable: true, label: message("Decision", { nl: "Besluit" }) },
        decided_by: {
          type: "user",
          nullable: true,
          label: message("Decided by", { nl: "Besloten door" }),
        },
        decided_at: {
          type: "datetime",
          nullable: true,
          label: message("Decided at", { nl: "Besloten op" }),
        },
        notice: {type: "delivery", operation: "grant.Mail.send", nullable: true},
      },
      derived: { notice_state: {type:"std.DeliveryResult.status",nullable:true,handler:"Application.notice_state",label:message("Decision notice delivery",{nl:"Bezorging besluitbericht"})} },
    },
    "grant.Comment": {
      parent: "grant.Application",
      label: message("Private reviewer comment", { nl: "Privéopmerking beoordelaar" }),
      readGrants: [{ rule: "Comment.read.1" }, { rule: "Comment.read.2" }],
      locks: ["Comment.lock.1"],
      fields: {
        body: { type: "text", trim: true, min: 1n },
        author: { type: "user", server: "actor" },
        recorded: { type: "datetime", server: "now" },
      },
    },
    "grant.Withdrawal": {
      parent: "grant.Application",
      label: message("Award withdrawal", { nl: "Intrekking toezegging" }),
      readGrants: [{ rule: "Withdrawal.read.1" }],
      locks: ["Withdrawal.lock.1"],
      fields: {
        reason: { type: "text", trim: true, min: 1n },
        author: { type: "user", server: "actor" },
        recorded: { type: "datetime", server: "now" },
      },
    },
    "grant.Recovery": {
      parent: "grant.Application", label: message("Reviewer recovery", {nl: "Herstel beoordelaar"}),
      readGrants: [{rule: "Recovery.read.1"}, {rule: "Recovery.read.2"}], locks: ["Recovery.lock.1"],
      fields: {previous: {type: "user", label: message("Previous reviewer", {nl:"Vorige beoordelaar"})}, reviewer: {type: "user", label: reviewerCaption}, reason: {type: "text", trim: true, min: 1n}, author: {type: "user", server: "actor"}, recorded: {type: "datetime", server: "now"}},
    },
  },
  preferences: {
    grant: {
      fields: {
        location: { type: Location, nullable: true, default: null },
        application_state: {
          type: "grant.Application.state",
          nullable: true,
          default: null,
          label: message("Application state", { nl: "Aanvraagstatus" }),
        },
      },
    },
  },
  operations: {
    "grant.Grant.create": {
      handler: "createGrant",
      kind: "create",
      model: "grant.Grant",
      by: "grant.coordinator",
      read: false,
      inputs: {
        fields: [
          "location",
          "name",
          "terms",
          "questions",
          "criteria",
          "budget",
          "closes",
          "timezone",
        ],
      },
      when: "Grant",
    },
    "grant.Grant.update": {
      handler: "updateGrant",
      kind: "update",
      model: "grant.Grant",
      by: "grant.coordinator",
      read: false,
      inputs: {
        record: { type: "grant.Grant" },
        changes: {
          fields: ["name", "terms", "questions", "criteria", "budget", "closes", "published"],
        },
      },
      when: "Grant",
    },
    "grant.Application.update": {
      handler: "updateApplication",
      kind: "update",
      model: "grant.Application",
      by: "authenticated",
      read: false,
      inputs: {
        record: { type: "grant.Application" },
        changes: { fields: ["email", "title", "description", "answers", "amount", "reviewer"] },
      },
      when: "Application",
    },
    "grant.Comment.create": {
      handler: "createComment",
      kind: "create",
      model: "grant.Comment",
      by: "grant.reviewer",
      read: false,
      when: "Comment",
      inputs: { parent: { type: "grant.Application" }, fields: ["body"] },
    },
    "grant.apply": {
      handler: "apply",
      read: false,
      by: "authenticated",
      label: message("Start application", { nl: "Aanvraag beginnen" }),
      description: message(
        "Start your private draft with the program's frozen question definitions.",
        { nl: "Begin je privéconcept met de vastgelegde vraagdefinities van het programma." },
      ),
      inputs: {
        grant: { type: "grant.Grant" },
        email: { type: "email" },
        title: { type: "grant.Application.title" },
        description: { type: "grant.Application.description" },
        amount: { type: "money" },
        assignee: { type: "user", label: reviewerCaption },
      },
    },
    "grant.correct": {
      handler: "correct",
      read: false,
      by: "authenticated",
      label: message("Create correction draft", { nl: "Correctieconcept maken" }),
      description: message(
        "Make a private correction without reopening or deleting the previous intake.",
        {
          nl: "Maak een privécorrectie zonder de eerdere aanvraag te heropenen of te verwijderen.",
        },
      ),
      inputs: { application: { type: "grant.Application" } },
    },
    "grant.intake": {
      handler: "intake",
      read: false,
      by: "grant.coordinator",
      label: message("External applicant intake", { nl: "Externe aanvraag invoeren" }),
      description: message(
        "Enter an externally received application for its actual applicant before recording receipt evidence.",
        {
          nl: "Voer een extern ontvangen aanvraag in voor de echte aanvrager en leg het ontvangstbewijs vast.",
        },
      ),
      inputs: {
        grant: { type: "grant.Grant" },
        applicant: { type: "user" },
        email: { type: "email" },
        title: { type: "grant.Application.title" },
        description: { type: "grant.Application.description" },
        answers: { type: "grant.Answer", array: true },
        amount: { type: "money" },
        assignee: { type: "user", label: reviewerCaption },
        received: { type: "datetime", label: receivedCaption },
        evidence: { type: "text" },
        override_reason: { type: "text", nullable: true, default: null, label: overrideCaption },
      },
    },
    "grant.award_export": {
      handler: "award_export",
      read: true,
      by: "grant.coordinator",
      result: "grant.AwardBatch",
      label: message("Export awards", { nl: "Toezeggingen exporteren" }),
      description: message(
        "Export authorized approved commitments with exact currency and decision time.",
        { nl: "Exporteer toegestane goedgekeurde toezeggingen met exacte valuta en besluittijd." },
      ),
      inputs: { grant: { type: "grant.Grant" } },
    },
    "grant.submit": {
      read: false,
      handler: "submit",
      by: "authenticated",
      inputs: { application: { type: "grant.Application" } },
      description: message(
        "Submit your application at authoritative receipt time with the required recorded answers.",
        {
          nl: "Dien je aanvraag in met het gezaghebbende ontvangsttijdstip en de vereiste vastgelegde antwoorden.",
        },
      ),
    },
    "grant.external": {
      read: false,
      handler: "external",
      by: "grant.coordinator",
      inputs: {
        application: { type: "grant.Application" },
        received: { type: "datetime", label: receivedCaption },
        evidence: { type: "text" },
        override_reason: { type: "text", nullable: true, default: null, label: overrideCaption },
      },
      label: message("Record external receipt", { nl: "Externe ontvangst registreren" }),
      description: message(
        "Record an evidenced external receipt with an explicit late override where needed.",
        {
          nl: "Registreer een bewezen externe ontvangst, indien nodig met een expliciete uitzondering op de deadline.",
        },
      ),
    },
    "grant.decide": {
      read: false,
      handler: "decide",
      by: "grant.reviewer",
      inputs: {
        application: { type: "grant.Application" },
        approve: { type: "bool", label: message("Approve", { nl: "Goedkeuren" }) },
        reason: { type: "text" },
      },
      label: message("Record decision", { nl: "Besluit vastleggen" }),
      description: message(
        "Decide exactly a submitted application without self-review or overspending.",
        {
          nl: "Beoordeel uitsluitend een ingediende aanvraag, zonder zelfbeoordeling of budgetoverschrijding.",
        },
      ),
    },
    "grant.recover": {handler: "recover", read: false, by: "grant.coordinator", label: message("Restore review", {nl: "Beoordeling herstellen"}), inputs: {application: {type: "grant.Application"}, assignee: {type: "user", label: reviewerCaption}, reason: {type: "text"}}},
    "grant.withdraw": {
      read: false,
      handler: "withdraw",
      by: "grant.coordinator",
      inputs: { application: { type: "grant.Application" }, reason: { type: "text" } },
      label: message("Withdraw", { nl: "Intrekken" }),
      description: message(
        "Withdraw an approved commitment by a reasoned coordinator decision; this is not a disbursement.",
        {
          nl: "Trek een goedgekeurde toezegging in met een gemotiveerd coördinatorbesluit; dit is geen uitbetaling.",
        },
      ),
    },
  },
  handlers: {
  },
  pages: [awardsPageDescriptor, reviewPageDescriptor],
  disabled: [
    "grant.Grant.delete",
    "grant.Application.create",
    "grant.Application.delete",
    "grant.Comment.update",
    "grant.Comment.delete",
  ],
};

async function complete_answers(c, questions, answers) {
  return (
    (await count(questions)) === (await count(answers)) &&
    (await all(
      questions,
      async (question) =>
        (await count(answers.filter((answer) => answer.question === question.key))) === 1n,
    ))
  );
}

export function canApp() {
  const crudWhen = {
    Grant: async (c, row) => await can_work(c, c.actor, row.location),
    Comment: async (c, row) =>
      same(row.parent.reviewer, c.actor) &&
      row.parent.state === "submitted" &&
      !same(row.parent.account, c.actor) &&
      (await can_work(c, c.actor, row.parent.parent.location)),
    Application: (c, row) =>
      same(row.account, c.actor) &&
      row.state === "draft" &&
      row.parent.published &&
      compareInstant(c.now, row.parent.closes) <= 0,
  };
  return {
    complete_answers,
    read: {
      "Grant.read.1": (c, row) => hasRole(c, "public") && row.published,
      "Grant.read.2": async (c, row) =>
        hasRole(c, "grant.coordinator") && (await can_work(c, c.actor, row.location)),
      "Grant.read.3": async (c, row) =>
        hasRole(c, "grant.reviewer") &&
        (await can_work(c, c.actor, row.location)) &&
        (await any(
          records(c, "grant.Application", { parent: row }),
          (application) => same(application.reviewer, c.actor) && application.state === "submitted",
        )),
      "Comment.read.1": async (c, row) =>
        hasRole(c, "grant.reviewer") &&
        same(row.parent.reviewer, c.actor) &&
        row.parent.state === "submitted" &&
        !same(row.parent.account, c.actor) &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Comment.read.2": async (c, row) =>
        hasRole(c, "grant.coordinator") && (await can_work(c, c.actor, row.parent.parent.location)),
      "Recovery.read.1": async (c, row) => hasRole(c, "grant.reviewer") && same(row.parent.reviewer, c.actor) && row.parent.state === "submitted" && await can_work(c, c.actor, row.parent.parent.location),
      "Recovery.read.2": async (c, row) => hasRole(c, "authenticated") && (same(row.parent.account, c.actor) || (hasRole(c, "grant.coordinator") && await can_work(c, c.actor, row.parent.parent.location))),
      "Withdrawal.read.1": async (c, row) =>
        hasRole(c, "authenticated") &&
        (same(row.parent.account, c.actor) ||
          (hasRole(c, "grant.coordinator") &&
            (await can_work(c, c.actor, row.parent.parent.location)))),
      "Application.read.1": (c, row) => hasRole(c, "authenticated") && same(row.account, c.actor),
      "Application.read.2": async (c, row) =>
        hasRole(c, "grant.reviewer") &&
        same(row.reviewer, c.actor) &&
        row.state === "submitted" &&
        (await can_work(c, c.actor, row.parent.location)),
      "Application.read.3": async (c, row) =>
        hasRole(c, "grant.coordinator") && (await can_work(c, c.actor, row.parent.location)),
    },
    derives: {
      "Application.notice_state": async(c,row) => (await delivery(c,{record:row,field:"notice"},["status"]))?.status ?? null,
      "Grant.requested": async (c, row) =>
        await sum(
          records(c, "grant.Application", {
            parent: row,
            where: (application) =>
              ["submitted", "approved", "rejected", "withdrawn"].includes(application.state),
          }),
          (application) => application.amount,
          row.budget.currency,
        ),
      "Grant.withdrawn": async (c, row) =>
        await sum(
          records(c, "grant.Application", {
            parent: row,
            where: (application) => application.state === "withdrawn",
          }),
          (application) => application.amount,
          row.budget.currency,
        ),
      "Grant.committed": async (c, row) =>
        await sum(
          records(c, "grant.Application", {
            parent: row,
            where: (application) => application.state === "approved",
          }),
          (application) => application.amount,
          row.budget.currency,
        ),
      "Grant.remaining": async (c, row) => subtractMoney(row.budget, row.committed),
    },
    invariants: {
      "Grant.require.1": async (c, row) =>
        (await count(row.questions)) > 0n &&
        (await count(await group(row.questions, (question) => question.key))) ===
          (await count(row.questions)) &&
        row.budget.minor >= 0n &&
        row.remaining.minor >= 0n,
      "Application.require.1": (c, row) =>
        row.amount.currency === row.parent.budget.currency &&
        row.amount.minor > 0n &&
        (row.correction === null ||
          (same(row.correction.parent, row.parent) && same(row.correction.account, row.account))),
    },
    locks: {
      "Application.lock.1": { fields: ["account", "terms", "criteria", "questions", "correction"] },
      "Application.lock.2": {
        fields: ["decision", "decided_by", "decided_at"],
        when: (c, row) => row.decided_at !== null,
      },
      "Application.lock.3": {
        fields: [
          "email",
          "title",
          "description",
          "answers",
          "amount",
          "received",
          "receipt_evidence",
          "override_reason",
        ],
        when: (c, row) => row.state !== "draft",
      },
      "Application.lock.4": {fields: ["reviewer"], when: async (c, row) => row.state !== "draft" && (row.state !== "submitted" || (hasRole(c, "grant.reviewer", row.reviewer) && await can_work(c, row.reviewer, row.parent.location)))},
      "Application.lock.5": {fields: ["notice"], when: (c, row) => row.notice !== null},
      "Recovery.lock.1": {fields: ["previous", "reviewer", "reason", "author", "recorded"]},
      "Comment.lock.1": { fields: ["body", "author", "recorded"] },
      "Withdrawal.lock.1": { fields: ["reason", "author", "recorded"] },
    },
    crudWhen,
    async createComment(c, input) {
      check(hasRole(c, "grant.reviewer"), "forbidden");
      await create(c, "grant.Comment", input, { when: crudWhen.Comment });
    },
    async createGrant(c, input) {
      check(hasRole(c, "grant.coordinator"), "forbidden");
      await create(c, "grant.Grant", input, { when: crudWhen.Grant });
    },
    async updateGrant(c, { record, changes }) {
      check(hasRole(c, "grant.coordinator"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Grant });
    },
    async apply(c, { grant, email, title, description, amount, assignee }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        grant.published &&
          compareInstant(c.now, grant.closes) <= 0 &&
          !same(assignee, c.actor) &&
          hasRole(c, "grant.reviewer", assignee) &&
          (await can_work(c, assignee, grant.location)),
      );
      await create(c, "grant.Application", {
        parent: grant,
        account: c.actor,
        email,
        title,
        description,
        terms: grant.terms,
        criteria: grant.criteria,
        questions: grant.questions,
        amount,
        reviewer: assignee,
      });
    },
    async correct(c, { application }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(application.account, c.actor) &&
          ["submitted", "rejected"].includes(application.state) &&
          application.parent.published &&
          compareInstant(c.now, application.parent.closes) <= 0,
      );
      check(
        !(await any(
          records(c, "grant.Application", { parent: application.parent }),
          (replacement) =>
            same(replacement.correction, application) &&
            ["draft", "submitted", "approved"].includes(replacement.state),
        )),
      );
      await create(c, "grant.Application", {
        parent: application.parent,
        account: c.actor,
        correction: application,
        email: application.email,
        title: application.title,
        description: application.description,
        terms: application.terms,
        criteria: application.criteria,
        questions: application.questions,
        answers: application.answers,
        amount: application.amount,
        reviewer: application.reviewer,
      });
    },
    async intake(
      c,
      {
        grant,
        applicant,
        email,
        title,
        description,
        answers,
        amount,
        assignee,
        received,
        evidence,
        override_reason = null,
      },
    ) {
      check(hasRole(c, "grant.coordinator"), "forbidden");
      check(await can_work(c, c.actor, grant.location));
      const application = await create(c, "grant.Application", {
        parent: grant,
        account: applicant,
        email,
        title,
        description,
        terms: grant.terms,
        criteria: grant.criteria,
        questions: grant.questions,
        answers,
        amount,
        reviewer: assignee,
      });
      await call(c, "grant.external", { application, received, evidence, override_reason });
    },
    async award_export(c, { grant }) {
      check(hasRole(c, "grant.coordinator"), "forbidden");
      check(await can_work(c, c.actor, grant.location));
      return {
        items: (
          await collect(records(c, "grant.Application", {
            parent: grant,
            where: (application) =>
              application.state === "approved" && application.decided_at !== null,
          }))
        ).map((application) => ({
          application: application.id,
          title: application.title,
          amount: application.amount,
          decided_at: application.decided_at,
        })),
      };
    },
    async updateApplication(c, { record, changes }) {
      check(hasRole(c, "authenticated"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Application });
    },
    async submit(c, { application }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(application.account, c.actor) &&
          application.state === "draft" &&
          compareInstant(c.now, application.parent.closes) <= 0 &&
          application.parent.published &&
          !same(application.reviewer, c.actor) &&
          hasRole(c, "grant.reviewer", application.reviewer) &&
          (await can_work(c, application.reviewer, application.parent.location)) &&
          (await complete_answers(c, application.questions, application.answers)),
      );
      if (application.correction !== null) {
        check(["submitted", "rejected"].includes(application.correction.state));
        if (application.correction.state === "submitted")
          await set(c, application.correction, { state: "superseded" });
      }
      await set(c, application, { state: "submitted", received: c.now });
    },
    async external(c, { application, received, evidence, override_reason = null }) {
      check(hasRole(c, "grant.coordinator"), "forbidden");
      check(
        (await can_work(c, c.actor, application.parent.location)) &&
          application.state === "draft" &&
          evidence.trim() !== "" &&
          compareInstant(received, c.now) <= 0 &&
          (compareInstant(received, application.parent.closes) <= 0 ||
            (override_reason !== null && override_reason.trim() !== "")),
      );
      check(
        !same(application.reviewer, application.account) &&
          hasRole(c, "grant.reviewer", application.reviewer) &&
          (await can_work(c, application.reviewer, application.parent.location)) &&
          (await complete_answers(c, application.questions, application.answers)),
      );
      if (application.correction !== null) {
        check(["submitted", "rejected"].includes(application.correction.state));
        if (application.correction.state === "submitted")
          await set(c, application.correction, { state: "superseded" });
      }
      await set(c, application, {
        state: "submitted",
        received,
        receipt_evidence: evidence,
        override_reason,
      });
    },
    async decide(c, { application, approve, reason }) {
      check(hasRole(c, "grant.reviewer"), "forbidden");
      check(
        same(application.reviewer, c.actor) &&
          !same(application.account, c.actor) &&
          application.state === "submitted" &&
          (await can_work(c, c.actor, application.parent.location)) &&
          reason.trim() !== "",
      );
      if (approve) {
        check(compareMoney(application.amount, application.parent.remaining) <= 0);
        await set(c, application, {
          state: "approved",
          decision: reason,
          decided_by: c.actor,
          decided_at: c.now,
        });
      } else
        await set(c, application, {
          state: "rejected",
          decision: reason,
          decided_by: c.actor,
          decided_at: c.now,
        });
      const notice = await send(c, "grant.Mail.send", {
        to: application.email,
        subject: format(c, message("Award decision", { nl: "Besluit over aanvraag" }), {
          locale: null,
        }),
        body: reason,
      });
      await set(c, application, {notice});
    },
    async recover(c, {application, assignee, reason}) {
      check(hasRole(c, "grant.coordinator"), "forbidden");
      check(await can_work(c, c.actor, application.parent.location) && application.state === "submitted" && reason.trim() !== "");
      check(!hasRole(c, "grant.reviewer", application.reviewer) || !await can_work(c, application.reviewer, application.parent.location));
      check(!same(assignee, application.account) && hasRole(c, "grant.reviewer", assignee) && await can_work(c, assignee, application.parent.location));
      await create(c, "grant.Recovery", {parent: application, previous: application.reviewer, reviewer: assignee, reason});
      await set(c, application, {reviewer: assignee});
    },
    async withdraw(c, { application, reason }) {
      check(hasRole(c, "grant.coordinator"), "forbidden");
      check(
        (await can_work(c, c.actor, application.parent.location)) &&
          application.state === "approved" &&
          reason.trim() !== "",
      );
      await create(c, "grant.Withdrawal", { parent: application, reason });
      await set(c, application, { state: "withdrawn" });
    },
  };
}

export async function awardsPage(c, bindings) {
  return renderPage(
    c,
    awardsPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Published programs and terms", {
          nl: "Gepubliceerde programma's en voorwaarden",
        }),
        children: [
          list({
            context: c,
            model: "grant.Grant",
            where: (grant) => grant.published,
            order: ["closes"],
            filter: ["location", "closes"],
            defaults: { location: c.preferences.grant.location },
            renderRow: (grant, v) => [
              text({
                context: v,
                values: [
                  grant.name,
                  grant.location,
                  grant.terms,
                  grant.questions,
                  grant.criteria,
                  grant.closes,
                  grant.timezone,
                ],
              }),
              form({
                context: v,
                operation: "grant.apply",
                arguments: { grant },
              }),
            ],
          }),
        ],
      }),
      ...(hasRole(c, "authenticated")
        ? [
            card({
              context: c,
              title: message("Own application intake and status", {
                nl: "Eigen aanvraag en status",
              }),
              children: [
                table({
                  context: c,
                  model: "grant.Application",
                  where: (application) => same(application.account, c.actor),
                  columns: ["title", "amount", "state", "decision", "notice_state", "received", "correction"],
                  filter: ["state"],
                  defaults: { state: c.preferences.grant.application_state },
                  renderRow: (application, v) => [
                    edit({
                      context: v,
                      operation: "grant.Application.update",
                      record: application,
                    }),
                    text({context: v, values: [application.terms, application.criteria, application.questions, application.answers]}),
                    actions({
                      context: v,
                      operations: ["grant.submit", "grant.correct"],
                      boundArgs: { application },
                    }),
                    table({context: v, model: "grant.Recovery", parent: application, columns: ["previous", "reviewer", "reason", "author", "recorded"]}),
                    table({
                      context: v,
                      model: "grant.Withdrawal",
                      parent: application,
                      columns: ["reason", "author", "recorded"],
                    }),
                    history({ context: v, record: application }),
                  ],
                }),
              ],
            }),
          ]
        : []),
    ],
  );
}

export async function reviewPage(c, bindings) {
  return renderPage(
    c,
    reviewPageDescriptor,
    () => [
      ...(hasRole(c, "grant.coordinator")
        ? [
            card({
              context: c,
              title: budgetCaption,
              children: [form({ context: c, operation: "grant.Grant.create" }), form({context: c, operation: "grant.intake"})],
            }),
          ]
        : []),
      card({
        context: c,
        title: message("Assigned applications and decisions", {
          nl: "Toegewezen aanvragen en besluiten",
        }),
        children: [
          list({
            context: c,
            model: "grant.Grant",
            order: ["closes"],
            filter: ["location", "closes"],
            defaults: { location: c.preferences.grant.location },
            display: "split",
            renderRow: async (grant, v) => [
              ...(hasRole(c, "grant.coordinator") && (await can_work(c, c.actor, grant.location))
                ? [
                    card({
                      context: v,
                      title: budgetCaption,
                      children: [
                        edit({ context: v, operation: "grant.Grant.update", record: grant }),
                        metrics({
                          context: v,
                          values: [
                            grant.budget,
                            grant.requested,
                            grant.committed,
                            grant.withdrawn,
                            grant.remaining,
                          ],
                        }),
                        form({
                          context: v,
                          operation: "grant.award_export",
                          arguments: { grant },
                          renderResult: (result, rv) => [
                            table({
                              context: rv,
                              items: result.items,
                              columns: ["application", "title", "amount", "decided_at"],
                            }),
                          ],
                        }),
                      ],
                    }),
                  ]
                : []),
              table({
                context: v,
                model: "grant.Application",
                parent: grant,
                columns: [
                  "title",
                  "description",
                  "terms",
                  "criteria",
                  "questions",
                  "answers",
                  "amount",
                  "received",
                  "receipt_evidence",
                  "override_reason",
                  "state",
                  "decision",
                  "notice_state",
                  "decided_by",
                  "decided_at",
                ],
                order: ["received"],
                filter: ["state", "reviewer"],
                defaults: { state: c.preferences.grant.application_state },
                renderRow: (application, av) => [
                  actions({
                    context: av,
                    operations: ["grant.decide", "grant.external", "grant.recover", "grant.withdraw"],
                    boundArgs: { application },
                  }),
                  form({
                    context: av,
                    operation: "grant.Comment.create",
                    arguments: { parent: application },
                  }),
                  table({
                    context: av,
                    model: "grant.Comment",
                    parent: application,
                    columns: ["body", "author", "recorded"],
                  }),
                  table({context: av, model: "grant.Recovery", parent: application, columns: ["previous", "reviewer", "reason", "author", "recorded"]}),
                  table({
                    context: av,
                    model: "grant.Withdrawal",
                    parent: application,
                    columns: ["reason", "author", "recorded"],
                  }),
                  history({ context: av, record: application }),
                ],
              }),
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
  const reviewer_user = {dependencies: [], user: async(c,s)=>({roles:["grant.reviewer"]})};
  const replacement_user = {dependencies: [], user: async(c,s)=>({roles:["grant.reviewer"]})};
  const coordinator_user = {dependencies: [], user: async(c,s)=>({roles:["grant.coordinator"]})};
  const ordinary_user = {dependencies: [], user: async(c,s)=>({roles:[]})};
  const hr_user = {dependencies: [], user: async(c,s)=>({roles:["employee.hr"]})};
  const replacement_worker = {model:"employee.Employee", dependencies:[test_site,replacement_user], value:async(c,s)=>({user:s.replacement_user,home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Replacement reviewer"})};
  const coordinator_worker = {model:"employee.Employee", dependencies:[test_site,coordinator_user], value:async(c,s)=>({user:s.coordinator_user,home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Coordinator"})};
  const ordinary_worker = {model:"employee.Employee", dependencies:[test_site,ordinary_user], value:async(c,s)=>({user:s.ordinary_user,home:s.test_site,locations:[s.test_site],start:date("2026-10-01"),role:"Reviewer"})};
  const colleague = {
    model: "employee.Employee",
    dependencies: [test_site, reviewer_user],
    value: async (c, s) => ({
      user: s.reviewer_user,
      home: s.test_site,
      locations: [s.test_site],
      start: date("2026-10-01"),
      role: "Reviewer",
    }),
  };
  const program = {
    model: "grant.Grant",
    dependencies: [test_site],
    value: async (c, s) => ({
      location: s.test_site,
      name: "Startup fund",
      terms: "Cash award",
      questions: [{ key: "purpose", prompt: "Purpose" }],
      criteria: "Impact",
      budget: money(100n, "EUR"),
      closes: datetime("2099-01-01T09:00:00Z"),
      timezone: "Europe/Brussels",
      published: true,
    }),
  };
  const submitted = {
    model: "grant.Application",
    dependencies: [program, reviewer_user],
    value: async (c, s) => ({
      parent: s.program,
      account: s.other,
      email: "applicant@example.test",
      title: "Project",
      description: "New business",
      terms: s.program.terms,
      criteria: s.program.criteria,
      questions: s.program.questions,
      answers: [{ question: "purpose", value: "Launch" }],
      amount: money(60n, "EUR"),
      reviewer: s.reviewer_user,
      received: datetime("2026-10-01T09:00:00Z"),
      state: "submitted",
    }),
  };
  const corrected = {
    model: "grant.Application",
    dependencies: [program, submitted],
    value: async (c, s) => ({
      parent: s.program,
      account: s.other,
      correction: s.submitted,
      email: "applicant@example.test",
      title: "Corrected project",
      description: "Clarified business",
      terms: s.submitted.terms,
      criteria: s.submitted.criteria,
      questions: s.submitted.questions,
      answers: s.submitted.answers,
      amount: money(60n, "EUR"),
      reviewer: s.reviewer_user,
    }),
  };
  const attempt={dependencies:[],delivery:"grant.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Notice",body:"Recorded decision"}})};
  const detached_notice={dependencies:[],delivery:"grant.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Notice",body:"Recorded decision"},status:"failed",error:{code:"provider",message:"Delivery rejected"}})};
  const detached_success={dependencies:[],delivery:"grant.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Notice",body:"Recorded decision"},status:"succeeded",result:{reference:"accepted-mail"}})};
  return {
    attempt, detached_notice, detached_success,
    colleague,
    program,
    submitted,
    corrected,
    reviewer_user, replacement_user, coordinator_user, ordinary_user, hr_user, replacement_worker, coordinator_worker, ordinary_worker,
    examples: [
      // Proposed causal sequences; each explicit call uses normal production admission.
      {operation:"grant.apply",dependencies:[program, colleague, coordinator_worker, ordinary_user],sequence:[
        {
          operation:"grant.apply",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({grant:s.program,email:"applicant@example.test",title:"Journey project",description:"New business",amount:money(60n,"EUR"),assignee:s.reviewer_user}),
        },
        {
          let:"draft",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.draft!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.draft}),
          error:"rule_failed",
        },
        {
          operation:"grant.Application.update",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({record:b.draft,changes:{answers:[{question:"purpose",value:"Launch"}]}}),
        },
        {
          let:"ready",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.ready!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.ready}),
        },
        {
          let:"pending",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.ordinary_user,
          inputs:async(c,s,b)=>({application:b.pending,approve:true,reason:"Meets criteria"}),
          error:"forbidden",
        },
        {
          observations:async(c,s,b)=>[await count(records(c,"grant.Application",{parent:s.program}))],
          expected:async(c,s,b)=>[0n],
          types:["int"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.pending,approve:true,reason:"Meets criteria"}),
        },
        {
          operation:"grant.award_export",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program}),
          bind:"first_awards",
        },
        {
          observations:async(c,s,b)=>[await count(b.first_awards.items), s.program.committed, s.program.remaining],
          expected:async(c,s,b)=>[1n, money(60n,"EUR"), money(40n,"EUR")],
          types:["int", "money", "money"],
        },
        {
          operation:"grant.apply",
          by:async(c,s,b)=>s.other,
          inputs:async(c,s,b)=>({grant:s.program,email:"applicant@example.test",title:"Competing project",description:"New business",amount:money(60n,"EUR"),assignee:s.reviewer_user}),
        },
        {
          let:"competing_draft",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.other) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.competing_draft!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.Application.update",
          by:async(c,s,b)=>s.other,
          inputs:async(c,s,b)=>({record:b.competing_draft,changes:{answers:[{question:"purpose",value:"Launch"}]}}),
        },
        {
          let:"competing_ready",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.other) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.competing_ready!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.submit",
          by:async(c,s,b)=>s.other,
          inputs:async(c,s,b)=>({application:b.competing_ready}),
        },
        {
          let:"competing_pending",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.other) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.competing_pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.competing_pending,approve:true,reason:"Impact also verified"}),
          error:"rule_failed",
        },
        {
          observations:async(c,s,b)=>[(await collect(records(c,"grant.Application",{parent:s.program,where:row=>row.state==="submitted"}))).map(row=>row.amount)],
          expected:async(c,s,b)=>[[money(60n,"EUR")]],
          types:["money[]"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.competing_pending,approve:false,reason:"Funds already committed"}),
        },
        {
          operation:"grant.award_export",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program}),
          bind:"retained_awards",
        },
        {
          let:"approved",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.approved!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.withdraw",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({application:b.approved,reason:"Funding cancelled"}),
        },
        {
          let:"withdrawn",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.withdrawn!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.withdraw",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({application:b.withdrawn,reason:"Repeated withdrawal"}),
          error:"rule_failed",
        },
        {
          operation:"grant.award_export",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program}),
          bind:"empty_awards",
        },
        {
          observations:async(c,s,b)=>[b.withdrawn.state, b.withdrawn.decision, b.withdrawn.decided_by, b.withdrawn.amount, await count(records(c,"grant.Withdrawal",{parent:b.withdrawn})), await count(b.empty_awards.items), s.program.requested, s.program.committed, s.program.withdrawn, s.program.remaining],
          expected:async(c,s,b)=>["withdrawn", "Meets criteria", s.reviewer_user, money(60n,"EUR"), 1n, 0n, money(120n,"EUR"), money(0n,"EUR"), money(60n,"EUR"), money(100n,"EUR")],
          types:["grant.Application.state", "text?", "user?", "money", "int", "int", "money", "money", "money", "money"],
        },
      ]},
      {operation:"grant.apply",dependencies:[program, colleague, coordinator_worker],sequence:[
        {
          operation:"grant.apply",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({grant:s.program,email:"applicant@example.test",title:"Journey project",description:"New business",amount:money(60n,"EUR"),assignee:s.reviewer_user}),
        },
        {
          let:"draft",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.draft!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.Application.update",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({record:b.draft,changes:{answers:[{question:"purpose",value:"Launch"}]}}),
        },
        {
          let:"ready",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.ready!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.ready}),
        },
        {
          let:"pending",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.Comment.create",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({parent:b.pending,body:"Private assessment"}),
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.pending,approve:false,reason:"Clarify the plan"}),
        },
        {
          operation:"grant.award_export",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program}),
          bind:"rejected_awards",
        },
        {
          let:"rejected",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.rejected!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.Application.update",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({record:b.rejected,changes:{answers:[]}}),
          error:"rule_failed",
        },
        {
          observations:async(c,s,b)=>[await count(records(c,"grant.Comment",{parent:b.rejected}))],
          expected:async(c,s,b)=>[0n],
          types:["int"],
        },
        {
          operation:"grant.Grant.update",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({record:s.program,changes:{terms:"New terms",criteria:"New criteria"}}),
        },
        {
          operation:"grant.correct",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.rejected}),
        },
        {
          operation:"grant.correct",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.rejected}),
          error:"rule_failed",
        },
        {
          let:"correction",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && same(row.correction,b.rejected),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.correction!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[b.correction.terms, b.correction.criteria, b.correction.state, b.rejected.state, b.rejected.decision],
          expected:async(c,s,b)=>["Cash award", "Impact", "draft", "rejected", "Clarify the plan"],
          types:["text", "text", "grant.Application.state", "grant.Application.state", "text?"],
        },
        {
          operation:"grant.Application.update",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({record:b.correction,changes:{answers:[{question:"purpose",value:"Launch"}],amount:money(40n,"EUR")}}),
        },
        {
          let:"corrected_ready",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && same(row.correction,b.rejected),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.corrected_ready!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.corrected_ready}),
        },
        {
          let:"corrected_pending",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && same(row.correction,b.rejected),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.corrected_pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.corrected_pending,approve:true,reason:"Corrected plan checked"}),
        },
        {
          operation:"grant.award_export",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program}),
          bind:"corrected_awards",
        },
        {
          let:"corrected_approved",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && same(row.correction,b.rejected),order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.corrected_approved!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          let:"retained_rejection",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.retained_rejection!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[b.retained_rejection.state, b.retained_rejection.decision, b.corrected_approved.state, b.corrected_approved.amount, b.corrected_approved.terms, b.corrected_approved.criteria, same(b.corrected_approved.correction,b.rejected), await count(b.corrected_awards.items), s.program.committed, s.program.remaining],
          expected:async(c,s,b)=>["rejected", "Clarify the plan", "approved", money(40n,"EUR"), "Cash award", "Impact", true, 1n, money(40n,"EUR"), money(60n,"EUR")],
          types:["grant.Application.state", "text?", "grant.Application.state", "money", "text", "text", "bool", "int", "money", "money"],
        },
      ]},
      {operation:"grant.apply",dependencies:[program, colleague, replacement_worker, coordinator_worker, ordinary_worker, hr_user],sequence:[
        {
          operation:"grant.apply",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({grant:s.program,email:"applicant@example.test",title:"Journey project",description:"New business",amount:money(60n,"EUR"),assignee:s.reviewer_user}),
        },
        {
          let:"draft",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.draft!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.Application.update",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({record:b.draft,changes:{answers:[{question:"purpose",value:"Launch"}]}}),
        },
        {
          let:"ready",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.ready!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.submit",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.ready}),
        },
        {
          let:"pending",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.pending!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          let:"submitted_version",
          value:async(c,s,b)=>b.pending.version,
        },
        {
          let:"original_received",
          value:async(c,s,b)=>b.pending.received,
        },
        {
          operation:"grant.Grant.update",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({record:s.program,changes:{closes:subtractDuration(c.now,60000n),terms:"New terms",criteria:"New criteria",questions:[{key:"new",prompt:"New question"}]}}),
        },
        {
          operation:"employee.deactivate",
          by:async(c,s,b)=>s.hr_user,
          inputs:async(c,s,b)=>({employee:s.colleague,ended:date("2026-10-02")}),
        },
        {
          observations:async(c,s,b)=>[s.colleague.active, hasRole(c,"grant.reviewer",s.reviewer_user), await can_work(c,s.reviewer_user,s.test_site)],
          expected:async(c,s,b)=>[false, true, false],
          types:["bool", "bool", "bool"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.pending,approve:true,reason:"Meets criteria"}),
          error:"rule_failed",
        },
        {
          operation:"grant.correct",
          by:async(c,s,b)=>s.self,
          inputs:async(c,s,b)=>({application:b.pending}),
          error:"rule_failed",
        },
        {
          operation:"grant.recover",
          by:async(c,s,b)=>s.ordinary_user,
          inputs:async(c,s,b)=>({application:b.pending,assignee:s.replacement_user,reason:"Reviewer unavailable"}),
          error:"forbidden",
        },
        {
          operation:"grant.recover",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({application:b.pending,assignee:s.ordinary_user,reason:"Reviewer unavailable"}),
          error:"rule_failed",
        },
        {
          operation:"grant.recover",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({application:b.pending,assignee:s.replacement_user,reason:" Reviewer unavailable "}),
        },
        {
          let:"recovered",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.recovered!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.recover",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({application:b.recovered,assignee:s.reviewer_user,reason:"Repeat"}),
          request:async(c,s,b)=>({application:{version:b.submitted_version}}),
          error:"conflict",
        },
        {
          operation:"grant.recover",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({application:b.recovered,assignee:s.replacement_user,reason:"Repeat"}),
          error:"rule_failed",
        },
        {
          observations:async(c,s,b)=>[b.recovered.state, b.recovered.reviewer, b.recovered.received, b.recovered.amount, b.recovered.terms, b.recovered.criteria, equalValue(c,"grant.Question[]",b.recovered.questions,[{key:"purpose",prompt:"Purpose"}]), await count(records(c,"grant.Recovery",{parent:b.recovered})), await any(records(c,"grant.Recovery",{parent:b.recovered}),evidence=>same(evidence.previous,s.reviewer_user)&&same(evidence.reviewer,s.replacement_user)&&evidence.reason==="Reviewer unavailable"&&same(evidence.author,s.coordinator_user)), s.program.committed],
          expected:async(c,s,b)=>["submitted", s.replacement_user, b.original_received, money(60n,"EUR"), "Cash award", "Impact", true, 1n, true, money(0n,"EUR")],
          types:["grant.Application.state", "user", "datetime?", "money", "text", "text", "bool", "int", "bool", "money"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.recovered,approve:true,reason:"Meets criteria"}),
          error:"rule_failed",
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.replacement_user,
          inputs:async(c,s,b)=>({application:b.recovered,approve:true,reason:"Recovery reviewed"}),
        },
        {
          operation:"grant.award_export",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program}),
          bind:"recovered_awards",
        },
        {
          let:"recovered_approved",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.self) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.recovered_approved!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          operation:"grant.recover",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({application:b.recovered_approved,assignee:s.reviewer_user,reason:"After decision"}),
          error:"rule_failed",
        },
        {
          observations:async(c,s,b)=>[b.recovered_approved.state, b.recovered_approved.reviewer, b.recovered_approved.decided_by, b.recovered_approved.decision, b.recovered_approved.received, ((await delivery(c,{record:b.recovered_approved,field:"notice"},["status"]))?.status ?? null), await count(b.recovered_awards.items), s.program.committed, s.program.remaining],
          expected:async(c,s,b)=>["approved", s.replacement_user, s.replacement_user, "Recovery reviewed", b.original_received, "pending", 1n, money(60n,"EUR"), money(40n,"EUR")],
          types:["grant.Application.state", "user", "user?", "text?", "datetime?", "std.DeliveryResult.status?", "int", "money", "money"],
        },
      ]},
      {operation:"grant.intake",dependencies:[program, colleague, coordinator_worker, ordinary_user],sequence:[
        {
          operation:"grant.Grant.update",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({record:s.program,changes:{closes:subtractDuration(c.now,60000n)}}),
        },
        {
          operation:"grant.intake",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program,applicant:s.other,email:"external@example.test",title:"External project",description:"Recorded application",answers:[{question:"purpose",value:"Launch"}],amount:money(60n,"EUR"),assignee:s.reviewer_user,received:c.now,evidence:"Signed receipt",override_reason:null}),
          error:"rule_failed",
        },
        {
          observations:async(c,s,b)=>[await count(records(c,"grant.Application",{parent:s.program}))],
          expected:async(c,s,b)=>[0n],
          types:["int"],
        },
        {
          operation:"grant.intake",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program,applicant:s.other,email:"external@example.test",title:"External project",description:"Recorded application",answers:[{question:"purpose",value:"Launch"}],amount:money(60n,"EUR"),assignee:s.reviewer_user,received:addDuration(c.now,60000n),evidence:"Signed receipt",override_reason:"Documented exception"}),
          error:"rule_failed",
        },
        {
          operation:"grant.intake",
          by:async(c,s,b)=>s.ordinary_user,
          inputs:async(c,s,b)=>({grant:s.program,applicant:s.other,email:"external@example.test",title:"External project",description:"Recorded application",answers:[{question:"purpose",value:"Launch"}],amount:money(60n,"EUR"),assignee:s.reviewer_user,received:c.now,evidence:"Signed receipt",override_reason:"Documented exception"}),
          error:"forbidden",
        },
        {
          operation:"grant.intake",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program,applicant:s.other,email:"external@example.test",title:"External project",description:"Recorded application",answers:[{question:"purpose",value:"Launch"}],amount:money(60n,"EUR"),assignee:s.reviewer_user,received:c.now,evidence:"Signed receipt",override_reason:"Documented exception"}),
        },
        {
          let:"external_application",
          value:async(c,s,b)=>await first(records(c,"grant.Application",{parent:s.program,where:row=>same(row.account,s.other) && row.correction===null,order:["id"]})),
        },
        {
          observations:async(c,s,b)=>[b.external_application!==null],
          expected:async(c,s,b)=>[true],
          types:["bool"],
        },
        {
          observations:async(c,s,b)=>[b.external_application.account, b.external_application.state, b.external_application.received, b.external_application.receipt_evidence, b.external_application.override_reason, b.external_application.terms, b.external_application.criteria],
          expected:async(c,s,b)=>[s.other, "submitted", c.now, "Signed receipt", "Documented exception", "Cash award", "Impact"],
          types:["user", "grant.Application.state", "datetime?", "text?", "text?", "text", "text"],
        },
        {
          operation:"grant.decide",
          by:async(c,s,b)=>s.reviewer_user,
          inputs:async(c,s,b)=>({application:b.external_application,approve:true,reason:"External evidence checked"}),
        },
        {
          operation:"grant.award_export",
          by:async(c,s,b)=>s.coordinator_user,
          inputs:async(c,s,b)=>({grant:s.program}),
          bind:"external_awards",
        },
        {
          observations:async(c,s,b)=>[await count(b.external_awards.items), s.program.committed, s.program.remaining],
          expected:async(c,s,b)=>[1n, money(60n,"EUR"), money(40n,"EUR")],
          types:["int", "money", "money"],
        },
      ]},
      {
        operation:"grant.Application.update",
        kind:"update",
        seed:[],
        dependencies:[submitted],
        inputs:async(c,s)=>({record:s.submitted,changes:{answers:[]}}),
        selectors:["as", "record.account", "record.state", "changes.answers"],
        observations:[async(c,s)=>await count(s.record.answers)],
        rows:[
          {dependencies:[],values:async(c,s)=>["members", s.self, "draft", []],expected:async(c,s)=>[0n]},
          {dependencies:[],values:async(c,s)=>["members", s.self, "draft", [{question:"purpose",value:""}]],error:"validation"},
          {dependencies:[],values:async(c,s)=>["members", s.other, "draft", []],error:"rule_failed"},
        ],
      },
      {
        operation:"grant.apply",
        seed:[colleague, ordinary_worker],
        dependencies:[program, reviewer_user, colleague, ordinary_worker],
        inputs:async(c,s)=>({grant:s.program,email:"applicant@example.test",title:"Project",description:"New business",amount:money(60n,"EUR"),assignee:s.reviewer_user}),
        selectors:["as", "assignee", "grant.closes", "amount"],
        observations:[async(c,s)=>await count(records(c,"grant.Application",{parent:s.grant}))],
        rows:[
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.reviewer_user, datetime("2099-01-01T09:00:00Z"), money(60n,"EUR")],expected:async(c,s)=>[1n]},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, datetime("2099-01-01T09:00:00Z"), money(60n,"EUR")],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.reviewer_user, datetime("2000-01-01T09:00:00Z"), money(60n,"EUR")],error:"rule_failed"},
          {dependencies:[ordinary_user],values:async(c,s)=>[s.self, s.ordinary_user, datetime("2099-01-01T09:00:00Z"), money(60n,"EUR")],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.reviewer_user, datetime("2099-01-01T09:00:00Z"), money(60n,"USD")],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.reviewer_user, datetime("2099-01-01T09:00:00Z"), money(0n,"EUR")],error:"rule_failed"},
        ],
      },
      {
        operation:"grant.correct",
        seed:[],
        dependencies:[submitted],
        inputs:async(c,s)=>({application:s.submitted}),
        selectors:["as", "application.account", "application.state"],
        observations:[async(c,s)=>s.application.state, async(c,s)=>await count(records(c,"grant.Application",{parent:s.application.parent}))],
        rows:[
          {dependencies:[],values:async(c,s)=>[s.self, s.self, "submitted"],expected:async(c,s)=>["submitted", 2n]},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, "rejected"],expected:async(c,s)=>["rejected", 2n]},
          {dependencies:[],values:async(c,s)=>[s.self, s.other, "submitted"],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, "approved"],error:"rule_failed"},
        ],
      },
      {
        operation:"grant.submit",
        seed:[colleague, ordinary_worker],
        dependencies:[submitted, colleague, ordinary_worker],
        inputs:async(c,s)=>({application:s.submitted}),
        selectors:["as", "application.account", "application.reviewer", "application.state", "application.answers", "application.parent.closes", "request.application.version"],
        observations:[async(c,s)=>s.application.state, async(c,s)=>s.application.received],
        rows:[
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.reviewer_user, "draft", [{question:"purpose",value:"Launch"}], datetime("2099-01-01T09:00:00Z"), 1n],expected:async(c,s)=>["submitted", c.now]},
          {dependencies:[],values:async(c,s)=>[s.self, s.self, s.self, "draft", [{question:"purpose",value:"Launch"}], datetime("2099-01-01T09:00:00Z"), 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.reviewer_user, "draft", [], datetime("2099-01-01T09:00:00Z"), 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.reviewer_user, "draft", [{question:"wrong",value:"Launch"}], datetime("2099-01-01T09:00:00Z"), 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.reviewer_user, "draft", [{question:"purpose",value:"Launch"},{question:"purpose",value:"Again"}], datetime("2099-01-01T09:00:00Z"), 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.reviewer_user, "draft", [{question:"purpose",value:"Launch"}], datetime("2000-01-01T09:00:00Z"), 1n],error:"rule_failed"},
          {dependencies:[ordinary_user],values:async(c,s)=>[s.self, s.self, s.ordinary_user, "draft", [{question:"purpose",value:"Launch"}], datetime("2099-01-01T09:00:00Z"), 1n],error:"rule_failed"},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.reviewer_user, "draft", [{question:"purpose",value:"Launch"}], datetime("2099-01-01T09:00:00Z"), 2n],error:"conflict"},
        ],
      },
      {
        operation:"grant.submit",
        seed:[colleague],
        dependencies:[corrected, colleague],
        inputs:async(c,s)=>({application:s.corrected}),
        selectors:["as", "application.account", "submitted.account", "application.reviewer", "submitted.state"],
        observations:[async(c,s)=>s.application.state, async(c,s)=>s.submitted.state, async(c,s)=>s.submitted.received, async(c,s)=>s.application.received],
        rows:[
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.self, s.reviewer_user, "submitted"],expected:async(c,s)=>["submitted", "superseded", datetime("2026-10-01T09:00:00Z"), c.now]},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.self, s.reviewer_user, "rejected"],expected:async(c,s)=>["submitted", "rejected", datetime("2026-10-01T09:00:00Z"), c.now]},
          {dependencies:[reviewer_user],values:async(c,s)=>[s.self, s.self, s.self, s.reviewer_user, "approved"],error:"rule_failed"},
        ],
      },
      {
        operation:"grant.external",
        seed:[test_worker, colleague],
        dependencies:[submitted, test_worker, colleague],
        inputs:async(c,s)=>({application:s.submitted,received:datetime("2026-10-01T09:00:00Z"),evidence:"Signed receipt"}),
        selectors:["as", "application.state", "application.answers", "application.parent.closes", "override_reason"],
        observations:[async(c,s)=>s.application.state, async(c,s)=>s.application.received, async(c,s)=>s.application.override_reason],
        rows:[
          {dependencies:[],values:async(c,s)=>["grant.coordinator", "draft", [{question:"purpose",value:"Launch"}], datetime("2099-01-01T09:00:00Z"), null],expected:async(c,s)=>["submitted", datetime("2026-10-01T09:00:00Z"), null]},
          {dependencies:[],values:async(c,s)=>["grant.coordinator", "draft", [{question:"purpose",value:"Launch"}], datetime("2000-01-01T09:00:00Z"), null],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>["grant.coordinator", "draft", [{question:"purpose",value:"Launch"}], datetime("2000-01-01T09:00:00Z"), "Documented exception"],expected:async(c,s)=>["submitted", datetime("2026-10-01T09:00:00Z"), "Documented exception"]},
          {dependencies:[],values:async(c,s)=>["grant.coordinator", "draft", [], datetime("2099-01-01T09:00:00Z"), null],error:"rule_failed"},
        ],
      },
      {
        operation:"grant.decide",
        seed:[test_worker, colleague],
        dependencies:[submitted, test_worker, colleague],
        inputs:async(c,s)=>({application:s.submitted,approve:true,reason:"Meets criteria"}),
        selectors:["as", "application.reviewer", "application.account", "application.amount", "request.application.version"],
        observations:[async(c,s)=>s.application.state, async(c,s)=>s.program.remaining, async(c,s)=>((await delivery(c,{record:s.application,field:"notice"},["status"]))?.status ?? null)],
        rows:[
          {dependencies:[],values:async(c,s)=>["grant.reviewer", s.self, s.other, money(60n,"EUR"), 1n],expected:async(c,s)=>["approved", money(40n,"EUR"), "pending"]},
          {dependencies:[],values:async(c,s)=>["grant.reviewer", s.self, s.self, money(60n,"EUR"), 1n],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>["grant.reviewer", s.self, s.other, money(101n,"EUR"), 1n],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>["members", s.self, s.other, money(60n,"EUR"), 1n],error:"forbidden"},
          {dependencies:[],values:async(c,s)=>["grant.reviewer", s.self, s.other, money(60n,"EUR"), 2n],error:"conflict"},
        ],
      },
      {
        operation:"grant.recover",
        seed:[colleague, ordinary_worker, replacement_worker, coordinator_worker],
        dependencies:[submitted, replacement_user, ordinary_user, colleague, ordinary_worker, replacement_worker, coordinator_worker],
        inputs:async(c,s)=>({application:s.submitted,assignee:s.replacement_user,reason:"Review unavailable"}),
        selectors:["as", "application.state", "application.reviewer", "colleague.active", "assignee", "reason", "request.application.version"],
        observations:[async(c,s)=>s.application.reviewer, async(c,s)=>s.application.state, async(c,s)=>s.application.received, async(c,s)=>s.application.amount, async(c,s)=>s.application.terms, async(c,s)=>s.application.criteria, async(c,s)=>await count(records(c,"grant.Recovery",{parent:s.application})), async(c,s)=>await any(records(c,"grant.Recovery",{parent:s.application}),row=>same(row.previous,s.reviewer_user)&&same(row.reviewer,s.replacement_user)&&row.reason==="Review unavailable"&&same(row.author,s.coordinator_user))],
        rows:[
          {dependencies:[coordinator_user, reviewer_user, replacement_user],values:async(c,s)=>[s.coordinator_user, "submitted", s.reviewer_user, false, s.replacement_user, " Review unavailable ", 1n],expected:async(c,s)=>[s.replacement_user, "submitted", datetime("2026-10-01T09:00:00Z"), money(60n,"EUR"), "Cash award", "Impact", 1n, true]},
          {dependencies:[coordinator_user, ordinary_user, replacement_user],values:async(c,s)=>[s.coordinator_user, "submitted", s.ordinary_user, true, s.replacement_user, " Review unavailable ", 1n],expected:async(c,s)=>[s.replacement_user, "submitted", datetime("2026-10-01T09:00:00Z"), money(60n,"EUR"), "Cash award", "Impact", 1n, false]},
          {dependencies:[coordinator_user, reviewer_user, replacement_user],values:async(c,s)=>[s.coordinator_user, "submitted", s.reviewer_user, true, s.replacement_user, "Review unavailable", 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, reviewer_user, ordinary_user],values:async(c,s)=>[s.coordinator_user, "submitted", s.reviewer_user, false, s.ordinary_user, "Review unavailable", 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, reviewer_user],values:async(c,s)=>[s.coordinator_user, "submitted", s.reviewer_user, false, s.other, "Review unavailable", 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, reviewer_user, replacement_user],values:async(c,s)=>[s.coordinator_user, "approved", s.reviewer_user, false, s.replacement_user, "Review unavailable", 1n],error:"rule_failed"},
          {dependencies:[ordinary_user, reviewer_user, replacement_user],values:async(c,s)=>[s.ordinary_user, "submitted", s.reviewer_user, false, s.replacement_user, "Review unavailable", 1n],error:"forbidden"},
          {dependencies:[coordinator_user, reviewer_user, replacement_user],values:async(c,s)=>[s.coordinator_user, "submitted", s.reviewer_user, false, s.replacement_user, " ", 1n],error:"rule_failed"},
          {dependencies:[coordinator_user, reviewer_user, replacement_user],values:async(c,s)=>[s.coordinator_user, "submitted", s.reviewer_user, false, s.replacement_user, "Review unavailable", 2n],error:"conflict"},
        ],
      },
      {
        operation:"grant.withdraw",
        seed:[test_worker],
        dependencies:[submitted, test_worker],
        inputs:async(c,s)=>({application:s.submitted,reason:"Funding cancelled"}),
        selectors:["as", "application.state", "application.decision", "application.decided_by", "application.decided_at"],
        observations:[async(c,s)=>s.application.state, async(c,s)=>s.application.decision, async(c,s)=>await count(records(c,"grant.Withdrawal",{parent:s.application})), async(c,s)=>s.program.remaining, async(c,s)=>s.application.decided_by, async(c,s)=>s.application.decided_at],
        rows:[
          {dependencies:[reviewer_user],values:async(c,s)=>["grant.coordinator", "approved", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z")],expected:async(c,s)=>["withdrawn", "Meets criteria", 1n, money(100n,"EUR"), s.reviewer_user, datetime("2026-10-01T09:00:00Z")]},
          {dependencies:[reviewer_user],values:async(c,s)=>["grant.coordinator", "withdrawn", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z")],error:"rule_failed"},
        ],
      },
      {
        operation:"grant.award_export",
        seed:[coordinator_worker],
        dependencies:[program, ordinary_user, coordinator_worker],
        inputs:async(c,s)=>({grant:s.program}),
        selectors:["as"],
        observations:[async(c,s)=>await count(s.result.items)],
        rows:[
          {dependencies:[coordinator_user],values:async(c,s)=>[s.coordinator_user],expected:async(c,s)=>[0n]},
          {dependencies:[ordinary_user],values:async(c,s)=>[s.ordinary_user],error:"forbidden"},
        ],
      },
      {operation:"grant.award_export",seed:[coordinator_worker,submitted,detached_notice,detached_success,attempt],dependencies:[coordinator_worker,submitted,detached_notice,detached_success,attempt,reviewer_user,coordinator_user,program],
        inputs:async(c,s)=>({grant:s.program}),
        selectors:["as", "submitted.state", "submitted.decision", "submitted.decided_by", "submitted.decided_at", "submitted.notice", "attempt.status", "attempt.result", "attempt.error"],observations:[async(c,s)=>(await delivery(c,{record:s.submitted,field:"notice"},["status"]))?.status ?? null,async(c,s)=>s.submitted.state,async(c,s)=>s.submitted.decision,async(c,s)=>s.submitted.decided_by,async(c,s)=>s.submitted.decided_at,async(c,s)=>s.submitted.amount,async(c,s)=>await count(s.result.items),async(c,s)=>s.program.remaining],rows:[
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "approved", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z"), s.attempt, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["succeeded","approved","Meets criteria",s.reviewer_user,datetime("2026-10-01T09:00:00Z"),money(60n,"EUR"),1n,money(40n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "approved", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z"), s.attempt, "unknown", null, null],expected:async(c,s)=>["unknown","approved","Meets criteria",s.reviewer_user,datetime("2026-10-01T09:00:00Z"),money(60n,"EUR"),1n,money(40n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "approved", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z"), s.attempt, "skipped", null, null],expected:async(c,s)=>["skipped","approved","Meets criteria",s.reviewer_user,datetime("2026-10-01T09:00:00Z"),money(60n,"EUR"),1n,money(40n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "approved", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z"), s.attempt, "failed", null, {code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["failed","approved","Meets criteria",s.reviewer_user,datetime("2026-10-01T09:00:00Z"),money(60n,"EUR"),1n,money(40n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "approved", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z"), s.attempt, "pending", null, null],expected:async(c,s)=>["pending","approved","Meets criteria",s.reviewer_user,datetime("2026-10-01T09:00:00Z"),money(60n,"EUR"),1n,money(40n,"EUR")]},
          {dependencies:[],values:async(c,s)=>[s.coordinator_user, "approved", "Meets criteria", s.reviewer_user, datetime("2026-10-01T09:00:00Z"), null, "pending", null, null],expected:async(c,s)=>[null,"approved","Meets criteria",s.reviewer_user,datetime("2026-10-01T09:00:00Z"),money(60n,"EUR"),1n,money(40n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "submitted", null, null, null, s.attempt, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["succeeded","submitted",null,null,null,money(60n,"EUR"),0n,money(100n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "submitted", null, null, null, s.attempt, "unknown", null, null],expected:async(c,s)=>["unknown","submitted",null,null,null,money(60n,"EUR"),0n,money(100n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "submitted", null, null, null, s.attempt, "skipped", null, null],expected:async(c,s)=>["skipped","submitted",null,null,null,money(60n,"EUR"),0n,money(100n,"EUR")]},
          {dependencies:[attempt],values:async(c,s)=>[s.coordinator_user, "submitted", null, null, null, s.attempt, "pending", null, null],expected:async(c,s)=>["pending","submitted",null,null,null,money(60n,"EUR"),0n,money(100n,"EUR")]}
        ]},
    ],
  };
}
