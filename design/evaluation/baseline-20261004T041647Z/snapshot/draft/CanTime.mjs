import {
  add_days,
  all,
  any,
  bounded,
  compareDate,
  compareInstant,
  compareMoney,
  count,
  create,
  datetime,
  divideDecimal,
  durationBetween,
  equalMoney,
  first,
  group,
  hasRole,
  local_date,
  money,
  multiplyMoney,
  overlaps,
  records,
  require as check,
  same,
  send,
  set,
  subtractMoney,
  sum,
} from "@canlang/stdlib";
import {
  action,
  actions,
  card,
  details,
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
import { Customer } from "./customer.mjs";
import { can_work, Employee } from "./employee.mjs";
import { Job } from "./field.mjs";
import { BillingV1 } from "./invoice.mjs";
import { Location } from "./rent_catalog.mjs";
/* Handwritten desired target. All imports are proposed unimplemented contracts.
 * DESIGN §13 defines the one registry/query/scalar/UI/test representation.
 * Owner admission supplies atomic D1 writes, versions, replay and staged rules.
 * No compiler, stdlib, adapter, renderer or example runner is implemented here. */
const projectCaption = message("Time project", { nl: "Tijdregistratieproject" });
const fromCaption = message("Started at", { nl: "Gestart op" });
const untilCaption = message("Stopped at", { nl: "Gestopt op" });
const billableCaption = message("Billable", { nl: "Factureerbaar" });

export const appDefinition = {
  id: "CanTime",
  uses: ["time"],
  description: message(
    "Help workspace teams record time spent on customer services, facilities work, and location projects.",
    {
      nl: "Help werkplekteams tijd voor klantdiensten, facilitair werk en locatieprojecten te registreren.",
    },
  ),
  packages: {
    time: {
      label: message("Time tracking", { nl: "Tijdregistratie" }),
      description: message(
        "Record observed or manual employee time, freeze period reviews and preserve correction and billing evidence.",
        {
          nl: "Registreer gemeten of handmatig ingevoerde medewerkerstijd, leg periodebeoordelingen vast en bewaar correctie- en facturatiebewijs.",
        },
      ),
      roles: {
        project_manager: {
          id: "time.project_manager",
          label: message("Project manager", { nl: "Projectmanager" }),
        },
      },
    },
  },
  bindings: { "time.Billing": { capability: BillingV1, from: "deployment.billing" } },
  models: {
    "time.Project": {
      label: message("Time project", { nl: "Tijdregistratieproject" }),
      fields: {
        name: { type: "text" },
        location: { type: Location },
        customer: { type: Customer, nullable: true },
        rate: { type: "money", label: message("Current hourly rate", { nl: "Huidig uurtarief" }) },
        active: { type: "bool", default: true },
      },
      readGrants: [{ rule: "Project.read.1" }],
      invariants: ["Project.require.1"],
    },
    "time.Entry": {
      label: message("Time entry", { nl: "Tijdregistratie" }),
      fields: {
        project: { type: "time.Project" },
        service: {
          type: Job,
          nullable: true,
          label: message("Service visit", { nl: "Servicebezoek" }),
        },
        description: { type: "text" },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", nullable: true, label: untilCaption },
        rate: { type: "money", label: message("Frozen rate", { nl: "Vastgelegd tarief" }) },
        billable: { type: "bool", default: true, label: billableCaption },
        origin: {
          type: "enum",
          values: ["timer", "manual"],
          label: {
            text: message("Time origin", { nl: "Herkomst tijdregistratie" }),
            values: {
              timer: message("Observed timer", { nl: "Gemeten timer" }),
              manual: message("Manual entry", { nl: "Handmatige registratie" }),
            },
          },
        },
        reason: { type: "text", nullable: true },
        author: { type: "user", server: "actor" },
        overlap_reason: {
          type: "text",
          nullable: true,
          label: message("Overlap exception", { nl: "Overlapuitzondering" }),
        },
        overlap_author: { type: "user", nullable: true },
        state: {
          type: "enum",
          values: ["draft", "submitted", "approved", "exported", "superseded"],
          default: "draft",
        },
        review: { type: "time.PeriodReview", nullable: true },
        correction: { type: "time.Correction", nullable: true },
        decision: { type: "text", nullable: true },
        exported_source: { type: "text", nullable: true },
        delivery: { type: "text", nullable: true },
      },
      readGrants: [{ rule: "Entry.read.1" }, { rule: "Entry.read.2" }],
      parent: "employee.Employee",
      invariants: ["Entry.require.1"],
      locks: ["Entry.lock.1"],
      derived: {
        duration: { type: "duration", handler: "Entry.duration" },
        amount: { type: "money", handler: "Entry.amount" },
      },
      unique: [{ fields: ["parent"], where: (c, row) => row.until === null }],
    },
    "time.PeriodReview": {
      label: message("Period review", { nl: "Periodebeoordeling" }),
      fields: {
        from: { type: "datetime" },
        until: { type: "datetime" },
        entries: { type: "time.Entry", array: true, requiredArray: true },
        state: {
          type: "enum",
          values: ["submitted", "approved", "rejected", "withdrawn"],
          default: "submitted",
        },
        submitted_by: { type: "user", server: "actor" },
        decided_by: { type: "user", nullable: true },
        reason: { type: "text", nullable: true },
      },
      readGrants: [{ rule: "PeriodReview.read.1" }, { rule: "PeriodReview.read.2" }],
      parent: "employee.Employee",
      invariants: ["PeriodReview.require.1"],
      locks: ["PeriodReview.lock.1"],
    },
    "time.Correction": {
      label: message("Time correction", { nl: "Tijdcorrectie" }),
      fields: {
        reason: { type: "text" },
        replacement: { type: "time.Entry" },
        author: { type: "user", server: "actor" },
        original_source: { type: "text", nullable: true },
        amount: { type: "money" },
        cancel_delivery: { type: "text", nullable: true },
        cancel_status: {
          type: "enum",
          values: ["pending", "succeeded", "failed", "unknown"],
          default: "pending",
        },
        fenced: { type: "bool", default: false },
        fence_revision: { type: "int", default: 0n },
        absent: { type: "bool", default: false },
        revision: { type: "int", default: 0n },
        collected: { type: "money" },
        refunded: { type: "money" },
        collection_pending: { type: "bool", default: true },
        refund_pending: { type: "bool", default: false },
        refund_delivery: { type: "text", nullable: true },
        refund_revision: { type: "int", default: 0n },
        refund_status: {
          type: "enum",
          nullable: true,
          values: ["pending", "succeeded", "failed", "unknown"],
        },
        reconcile_delivery: { type: "text", nullable: true },
        reconcile_status: {
          type: "enum",
          nullable: true,
          values: ["pending", "succeeded", "failed", "unknown"],
        },
      },
      readGrants: [{ rule: "Correction.read.1" }, { rule: "Correction.read.2" }],
      parent: "time.Entry",
      locks: ["Correction.lock.1"],
      derived: { ready: { type: "bool", handler: "Correction.ready" } },
      unique: [{ fields: ["parent"] }],
    },
  },
  pure: {
    "time.overlaps_work": {
      handler: "overlaps_work",
      inputs: {
        employee: { type: Employee },
        from: { type: "datetime" },
        until: { type: "datetime" },
        skip: { type: "time.Entry", nullable: true },
      },
      result: "bool",
    },
  },
  preferences: {
    time: {
      fields: {
        project: { type: "time.Project", nullable: true, default: null, label: projectCaption },
        location: { type: Location, nullable: true, default: null },
        week: { type: "date", nullable: true, default: null },
        billable_filter: {
          type: "bool",
          nullable: true,
          default: null,
          label: message("Initial billable filter", { nl: "Eerste facturatiefilter" }),
        },
      },
    },
  },
  operations: {
    "time.Project.create": {
      handler: "createProject",
      kind: "create",
      model: "time.Project",
      by: "time.project_manager",
      read: false,
      inputs: { fields: ["name", "location", "customer", "rate"] },
      when: "Project",
    },
    "time.Project.update": {
      handler: "updateProject",
      kind: "update",
      model: "time.Project",
      by: "time.project_manager",
      read: false,
      inputs: { record: { type: "time.Project" }, changes: { fields: ["name", "rate", "active"] } },
      when: "Project",
    },
    "time.start": {
      handler: "start",
      by: "members",
      read: false,
      inputs: {
        employee: { type: Employee },
        project: { type: "time.Project" },
        description: { type: "text" },
        billable: { type: "bool", default: true, label: billableCaption },
        service: { type: Job, nullable: true, default: null },
      },
      description: message(
        "Return the current timer or begin observed work at server time with the current rate.",
        {
          nl: "Geef de huidige timer terug of begin gemeten werk op servertijd met het huidige tarief.",
        },
      ),
      result: "time.Entry",
    },
    "time.stop": {
      handler: "stop",
      by: "members",
      read: false,
      inputs: { entry: { type: "time.Entry" } },
      description: message("Fix a running timer's end once while checking the final interval.", {
        nl: "Leg de eindtijd van een lopende timer eenmaal vast en controleer het definitieve tijdvak.",
      }),
    },
    "time.manual": {
      handler: "manual",
      by: ["members", "time.project_manager"],
      read: false,
      inputs: {
        employee: { type: Employee },
        project: { type: "time.Project" },
        description: { type: "text" },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        billable: { type: "bool", label: billableCaption },
        reason: { type: "text" },
        service: { type: Job, nullable: true, default: null },
        exception: { type: "text", nullable: true, default: null },
      },
      description: message(
        "Record forgotten work with its author and reason; only a manager can grant a recorded overlap exception.",
        {
          nl: "Registreer vergeten werk met auteur en reden; alleen een manager mag een vastgelegde overlapuitzondering toestaan.",
        },
      ),
      result: "time.Entry",
    },
    "time.revise": {
      handler: "revise",
      by: ["members", "time.project_manager"],
      read: false,
      inputs: {
        entry: { type: "time.Entry" },
        description: { type: "text" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        billable: { type: "bool" },
        reason: { type: "text" },
        exception: { type: "text", nullable: true, default: null },
      },
      description: message(
        "Revise own finished draft work without changing its frozen rate or service identity.",
        {
          nl: "Wijzig eigen afgerond conceptwerk zonder het vastgelegde tarief of de service-identiteit te wijzigen.",
        },
      ),
    },
    "time.submit": {
      handler: "submit",
      by: "members",
      read: false,
      inputs: {
        employee: { type: Employee },
        from: { type: "datetime" },
        until: { type: "datetime" },
      },
      description: message(
        "Freeze all finished draft entries wholly inside a period as one attributed submission.",
        {
          nl: "Leg alle afgeronde conceptregistraties binnen een periode vast als \u00e9\u00e9n toegeschreven indiening.",
        },
      ),
      result: "time.PeriodReview",
    },
    "time.decide": {
      handler: "decide",
      by: "time.project_manager",
      read: false,
      inputs: {
        review: { type: "time.PeriodReview" },
        approve: { type: "bool" },
        reason: { type: "text" },
      },
      description: message(
        "Decide the frozen period under every entry's current location grant, retaining the reviewer and reason.",
        {
          nl: "Beoordeel de vastgelegde periode onder de actuele locatierechten van elke registratie en bewaar beoordelaar en reden.",
        },
      ),
    },
    "time.withdraw": {
      handler: "withdraw",
      by: ["members", "time.project_manager"],
      read: false,
      inputs: { review: { type: "time.PeriodReview" }, reason: { type: "text" } },
      description: message(
        "Withdraw a submitted period with an attributed explanation and restore its editable drafts.",
        {
          nl: "Trek een ingediende periode in met een toegeschreven toelichting en herstel bewerkbare concepten.",
        },
      ),
    },
    "time.correct": {
      handler: "correct",
      by: "time.project_manager",
      read: false,
      inputs: {
        entry: { type: "time.Entry" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        reason: { type: "text" },
        exception: { type: "text", nullable: true, default: null },
      },
      description: message(
        "Preserve approved evidence, retire its active interval and create an attributed replacement for a new review.",
        {
          nl: "Bewaar goedgekeurd bewijs, be\u00ebindig het actieve tijdvak en maak een toegeschreven vervanging voor een nieuwe beoordeling.",
        },
      ),
      result: "time.Entry",
    },
    "time.bill": {
      handler: "bill",
      by: "time.project_manager",
      read: false,
      inputs: { entry: { type: "time.Entry" } },
      description: message(
        "Queue the approved frozen source once after any prior exported source is fenced and financially neutral.",
        {
          nl: "Zet de goedgekeurde vastgelegde bron eenmaal in de wachtrij nadat een eerdere ge\u00ebxporteerde bron is afgeschermd en financieel vereffend.",
        },
      ),
    },
    "time.retry_cancel": {
      handler: "retry_cancel",
      by: "time.project_manager",
      read: false,
      inputs: { correction: { type: "time.Correction" } },
      description: message(
        "Retry a definite failed original-source cancellation without releasing the replacement.",
        {
          nl: "Probeer een definitief mislukte annulering van de oorspronkelijke bron opnieuw zonder de vervanging vrij te geven.",
        },
      ),
    },
    "time.reconcile": {
      handler: "reconcile",
      by: "time.project_manager",
      read: false,
      inputs: { correction: { type: "time.Correction" } },
      description: message(
        "Refresh original-source balances without confusing delivery with settlement.",
        {
          nl: "Ververs saldi van de oorspronkelijke bron zonder verzending met afwikkeling te verwarren.",
        },
      ),
    },
    "time.refund": {
      handler: "refund",
      by: "time.project_manager",
      read: false,
      inputs: { correction: { type: "time.Correction" }, reason: { type: "text" } },
      description: message(
        "Ask the invoice owner to refund remaining original-source funds only after uncertainty has cleared.",
        {
          nl: "Vraag de factuureigenaar resterende bronbedragen terug te betalen zodra onzekerheid is verdwenen.",
        },
      ),
    },
  },
  handlers: {
    "time.cancelled": {
      handler: "cancelled",
      on: { capability: "time.Billing", operation: "cancel", event: "completed" },
    },
    "time.refunded": {
      handler: "refunded",
      on: { capability: "time.Billing", operation: "refund", event: "completed" },
    },
    "time.reconciled": {
      handler: "reconciled",
      on: { capability: "time.Billing", operation: "reconcile", event: "completed" },
    },
    "time.settled": { handler: "settled", on: { capability: "time.Billing", event: "settled" } },
  },
  pages: [
    { path: "/time/mine", render: minePage },
    { path: "/time/review", render: reviewPage },
  ],
  disabled: ["time.Project.delete"],
};

export function canApp() {
  const crudWhen = { Project: async (c, row) => await can_work(c, c.actor, row.location) };
  async function overlaps_work(c, employee, from, until, skip) {
    return await any(
      records(c, "time.Entry", { parent: employee }),
      (entry) =>
        !same(entry, skip) &&
        entry.state !== "superseded" &&
        ((entry.until === null && compareInstant(entry.from, until) < 0) ||
          (entry.until !== null && overlaps(from, until, entry.from, entry.until))),
    );
  }
  return {
    crudWhen,
    overlaps_work,
    read: {
      "Project.read.1": async (c, row) =>
        hasRole(c, "members") && (await can_work(c, c.actor, row.location)),
      "Entry.read.1": (c, row) => hasRole(c, "members") && same(row.parent.user, c.actor),
      "Entry.read.2": async (c, row) =>
        hasRole(c, "time.project_manager") && (await can_work(c, c.actor, row.project.location)),
      "PeriodReview.read.1": (c, row) => hasRole(c, "members") && same(row.parent.user, c.actor),
      "PeriodReview.read.2": async (c, row) =>
        hasRole(c, "time.project_manager") &&
        (await all(
          row.entries,
          async (entry) => await can_work(c, c.actor, entry.project.location),
        )),
      "Correction.read.1": (c, row) =>
        hasRole(c, "members") && same(row.parent.parent.user, c.actor),
      "Correction.read.2": async (c, row) =>
        hasRole(c, "time.project_manager") &&
        (await can_work(c, c.actor, row.parent.project.location)),
    },
    derives: {
      "Entry.duration": (c, row) => durationBetween(row.until ?? c.now, row.from),
      "Entry.amount": (c, row) => multiplyMoney(row.rate, divideDecimal(row.duration, 3600000n)),
      "Correction.ready": (c, row) =>
        row.fenced &&
        (row.absent ||
          (row.revision > 0n &&
            row.revision >= row.fence_revision &&
            !row.collection_pending &&
            !row.refund_pending &&
            equalMoney(row.collected, row.refunded))),
    },
    invariants: {
      "Project.require.1": (c, row) =>
        row.rate.minor >= 0n &&
        (row.customer === null ||
          row.customer.locations.some((location) => same(row.location, location))),
      "Entry.require.1": (c, row) => row.until === null || compareInstant(row.until, row.from) > 0,
      "PeriodReview.require.1": async (c, row) =>
        compareInstant(row.from, row.until) < 0 &&
        (await count(row.entries)) > 0n &&
        (await all(
          row.entries,
          (entry) =>
            same(entry.parent, row.parent) &&
            entry.until !== null &&
            compareInstant(row.from, entry.from) <= 0 &&
            compareInstant(entry.until, row.until) <= 0,
        )),
    },
    locks: {
      "Entry.lock.1": {
        fields: [
          "project",
          "service",
          "description",
          "from",
          "until",
          "rate",
          "billable",
          "origin",
          "reason",
          "author",
          "overlap_reason",
          "overlap_author",
        ],
        when: (c, row) => ["submitted", "approved", "exported", "superseded"].includes(row.state),
      },
      "PeriodReview.lock.1": { fields: ["from", "until", "entries", "submitted_by"] },
      "Correction.lock.1": {
        fields: ["reason", "replacement", "author", "original_source", "amount"],
      },
    },
    async createProject(c, input) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      await create(c, "time.Project", input, { when: crudWhen.Project });
    },
    async updateProject(c, { record, changes }) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Project });
    },
    async start(c, { employee, project, description, billable = true, service = null }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(employee.user, c.actor) &&
          employee.active &&
          project.active &&
          (await can_work(c, c.actor, project.location)),
      );
      check(
        service === null ||
          (same(service.employee, employee) &&
            same(service.location, project.location) &&
            (project.customer === null || same(service.customer, project.customer))),
      );
      const running = await first(
        records(c, "time.Entry", {
          parent: employee,
          where: (entry) => entry.until === null,
          order: ["id"],
        }),
      );
      if (running !== null) {
        check(
          same(running.project, project) &&
            running.description === description &&
            running.billable === billable &&
            same(running.service, service),
        );
        return running;
      }
      check(
        !(await any(
          records(c, "time.Entry", { parent: employee }),
          (entry) =>
            entry.state !== "superseded" &&
            entry.until !== null &&
            compareInstant(entry.until, c.now) > 0,
        )),
      );
      const entry = await create(c, "time.Entry", {
        parent: employee,
        project,
        service,
        description,
        from: c.now,
        rate: project.rate,
        billable,
        origin: "timer",
      });
      return entry;
    },
    async stop(c, { entry }) {
      check(hasRole(c, "members"), "forbidden");
      check(same(entry.parent.user, c.actor) && entry.state === "draft");
      if (entry.until === null) {
        check(
          compareInstant(c.now, entry.from) > 0 &&
            (!(await overlaps_work(c, entry.parent, entry.from, c.now, entry)) ||
              entry.overlap_reason !== null),
        );
        await set(c, entry, { until: c.now });
      }
    },
    async manual(
      c,
      {
        employee,
        project,
        description,
        from,
        until,
        billable,
        reason,
        service = null,
        exception = null,
      },
    ) {
      check(hasRole(c, "members") || hasRole(c, "time.project_manager"), "forbidden");
      check(
        (same(employee.user, c.actor) || hasRole(c, "time.project_manager")) &&
          employee.active &&
          project.active &&
          (await can_work(c, c.actor, project.location)) &&
          compareInstant(from, until) < 0 &&
          compareInstant(until, c.now) <= 0 &&
          reason.trim() !== "",
      );
      check(
        service === null ||
          (same(service.employee, employee) &&
            same(service.location, project.location) &&
            (project.customer === null || same(service.customer, project.customer))),
      );
      const overlap = await overlaps_work(c, employee, from, until, null);
      check(!overlap || (hasRole(c, "time.project_manager") && (exception ?? "").trim() !== ""));
      const entry = await create(c, "time.Entry", {
        parent: employee,
        project,
        service,
        description,
        from,
        until,
        rate: project.rate,
        billable,
        origin: "manual",
        reason,
      });
      if (overlap) await set(c, entry, { overlap_reason: exception, overlap_author: c.actor });
      return entry;
    },
    async revise(c, { entry, description, from, until, billable, reason, exception = null }) {
      check(hasRole(c, "members") || hasRole(c, "time.project_manager"), "forbidden");
      check(
        (same(entry.parent.user, c.actor) || hasRole(c, "time.project_manager")) &&
          (await can_work(c, c.actor, entry.project.location)) &&
          entry.state === "draft" &&
          entry.until !== null &&
          compareInstant(from, until) < 0 &&
          compareInstant(until, c.now) <= 0 &&
          reason.trim() !== "",
      );
      const overlap = await overlaps_work(c, entry.parent, from, until, entry);
      check(!overlap || (hasRole(c, "time.project_manager") && (exception ?? "").trim() !== ""));
      await set(c, entry, {
        description,
        from,
        until,
        billable,
        origin: "manual",
        reason,
        overlap_reason: null,
        overlap_author: null,
      });
      if (overlap) await set(c, entry, { overlap_reason: exception, overlap_author: c.actor });
    },
    async submit(c, { employee, from, until }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(employee.user, c.actor) &&
          employee.active &&
          compareInstant(from, until) < 0 &&
          compareInstant(until, c.now) <= 0,
      );
      check(
        !(await any(
          records(c, "time.Entry", { parent: employee }),
          (entry) =>
            entry.state !== "superseded" &&
            compareInstant(entry.from, until) < 0 &&
            (entry.until === null || compareInstant(entry.until, from) > 0) &&
            (entry.until === null ||
              compareInstant(entry.from, from) < 0 ||
              compareInstant(entry.until, until) > 0),
        )),
      );
      const entries = records(c, "time.Entry", {
        parent: employee,
        where: (entry) =>
          entry.state === "draft" &&
          entry.until !== null &&
          compareInstant(from, entry.from) <= 0 &&
          compareInstant(entry.until, until) <= 0,
        order: ["from"],
      });
      check((await count(entries)) > 0n);
      const review = await create(c, "time.PeriodReview", {
        parent: employee,
        from,
        until,
        entries,
      });
      for await (const entry of bounded(entries, 500n))
        await set(c, entry, { state: "submitted", review, decision: null });
      return review;
    },
    async decide(c, { review, approve, reason }) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      check(
        review.state === "submitted" &&
          reason.trim() !== "" &&
          (await all(
            review.entries,
            async (entry) =>
              entry.state === "submitted" &&
              same(entry.review, review) &&
              (await can_work(c, c.actor, entry.project.location)),
          )),
      );
      if (approve) await set(c, review, { state: "approved", decided_by: c.actor, reason });
      else await set(c, review, { state: "rejected", decided_by: c.actor, reason });
      for await (const entry of bounded(review.entries, 500n)) {
        if (approve) await set(c, entry, { state: "approved", decision: reason });
        else await set(c, entry, { state: "draft", decision: reason });
      }
    },
    async withdraw(c, { review, reason }) {
      check(hasRole(c, "members") || hasRole(c, "time.project_manager"), "forbidden");
      check(
        review.state === "submitted" &&
          reason.trim() !== "" &&
          (same(review.parent.user, c.actor) || hasRole(c, "time.project_manager")) &&
          (await all(
            review.entries,
            async (entry) =>
              entry.state === "submitted" &&
              same(entry.review, review) &&
              (await can_work(c, c.actor, entry.project.location)),
          )),
      );
      await set(c, review, { state: "withdrawn", decided_by: c.actor, reason });
      for await (const entry of bounded(review.entries, 500n))
        await set(c, entry, { state: "draft", decision: reason });
    },
    async correct(c, { entry, from, until, reason, exception = null }) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, entry.project.location)) &&
          ["approved", "exported"].includes(entry.state) &&
          (entry.correction === null || entry.correction.ready) &&
          entry.until !== null &&
          compareInstant(from, until) < 0 &&
          compareInstant(until, c.now) <= 0 &&
          reason.trim() !== "",
      );
      const overlap = await overlaps_work(c, entry.parent, from, until, entry);
      check(!overlap || (exception ?? "").trim() !== "");
      const replacement = await create(c, "time.Entry", {
        parent: entry.parent,
        project: entry.project,
        service: entry.service,
        description: entry.description,
        from,
        until,
        rate: entry.rate,
        billable: entry.billable,
        origin: "manual",
        reason,
      });
      const correction = await create(c, "time.Correction", {
        parent: entry,
        reason,
        replacement,
        original_source: entry.exported_source,
        amount: entry.amount,
        collected: money(0n, entry.rate.currency),
        refunded: money(0n, entry.rate.currency),
      });
      await set(c, entry, { state: "superseded" });
      await set(c, replacement, { correction });
      if (overlap)
        await set(c, replacement, { overlap_reason: exception, overlap_author: c.actor });
      if (correction.original_source !== null) {
        const cancellation = await send(c, "time.Billing.cancel", {
          source: correction.original_source,
          reason,
        });
        await set(c, correction, { cancel_delivery: cancellation.id });
      } else await set(c, correction, { fenced: true, absent: true, collection_pending: false });
      return replacement;
    },
    async bill(c, { entry }) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, entry.project.location)) &&
          entry.state === "approved" &&
          entry.billable &&
          entry.project.customer !== null &&
          entry.amount.minor > 0n &&
          (entry.correction === null || entry.correction.ready),
      );
      const delivery = await send(c, "time.Billing.charge", {
        value: {
          source: entry.id,
          customer: entry.project.customer.id,
          location: entry.project.location.id,
          description: entry.description,
          amount: entry.amount,
          due: local_date(c.now, entry.project.location.timezone),
        },
      });
      await set(c, entry, { state: "exported", exported_source: entry.id, delivery: delivery.id });
    },
    async retry_cancel(c, { correction }) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, correction.parent.project.location)) &&
          correction.original_source !== null &&
          correction.cancel_status === "failed" &&
          !correction.fenced,
      );
      const delivery = await send(c, "time.Billing.cancel", {
        source: correction.original_source,
        reason: correction.reason,
      });
      await set(c, correction, { cancel_delivery: delivery.id, cancel_status: "pending" });
    },
    async reconcile(c, { correction }) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, correction.parent.project.location)) &&
          correction.original_source !== null,
      );
      const delivery = await send(c, "time.Billing.reconcile", {
        source: correction.original_source,
      });
      await set(c, correction, { reconcile_delivery: delivery.id, reconcile_status: "pending" });
    },
    async refund(c, { correction, reason }) {
      check(hasRole(c, "time.project_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, correction.parent.project.location)) &&
          correction.original_source !== null &&
          correction.fenced &&
          correction.revision > 0n &&
          !correction.collection_pending &&
          !correction.refund_pending &&
          compareMoney(correction.collected, correction.refunded) > 0 &&
          (correction.refund_status === null ||
            correction.refund_status === "failed" ||
            (correction.refund_status === "succeeded" &&
              correction.revision > correction.refund_revision)) &&
          reason.trim() !== "",
      );
      const delivery = await send(c, "time.Billing.refund", {
        source: correction.original_source,
        amount: subtractMoney(correction.collected, correction.refunded),
        reason,
      });
      await set(c, correction, {
        refund_delivery: delivery.id,
        refund_revision: correction.revision,
        refund_status: "pending",
      });
    },
    async cancelled(c, { event }) {
      for await (const correction of records(c, "time.Correction", {
        where: (row) => row.cancel_delivery === event.delivery_id,
        limit: 1n,
      })) {
        await set(c, correction, { cancel_status: event.status });
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === correction.original_source &&
          ["released", "pending", "unavailable"].includes(event.result.state)
        ) {
          await set(c, correction, { fenced: true, fence_revision: event.result.revision });
          if (event.result.state === "released" && event.result.reference === null)
            await set(c, correction, { absent: true, collection_pending: false });
        }
      }
    },
    async refunded(c, { event }) {
      for await (const correction of records(c, "time.Correction", {
        where: (row) => row.refund_delivery === event.delivery_id,
        limit: 1n,
      })) {
        await set(c, correction, { refund_status: event.status });
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === correction.original_source &&
          event.result.state === "unavailable"
        )
          await set(c, correction, { refund_status: "failed" });
      }
    },
    async reconciled(c, { event }) {
      for await (const correction of records(c, "time.Correction", {
        where: (row) => row.reconcile_delivery === event.delivery_id,
        limit: 1n,
      })) {
        await set(c, correction, { reconcile_status: event.status });
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === correction.original_source &&
          equalMoney(event.result.amount, correction.amount) &&
          event.result.revision > correction.revision
        )
          await set(c, correction, {
            absent: false,
            revision: event.result.revision,
            collected: event.result.collected,
            refunded: event.result.refunded,
            collection_pending: event.result.collection_pending,
            refund_pending: event.result.refund_pending,
          });
      }
    },
    async settled(c, { event }) {
      for await (const correction of records(c, "time.Correction", {
        where: (row) => row.original_source === event.value.source,
        limit: 1n,
      })) {
        check(equalMoney(event.value.amount, correction.amount));
        if (event.value.revision > correction.revision)
          await set(c, correction, {
            absent: false,
            revision: event.value.revision,
            collected: event.value.collected,
            refunded: event.value.refunded,
            collection_pending: event.value.collection_pending,
            refund_pending: event.value.refund_pending,
          });
      }
    },
  };
}

export async function minePage(c) {
  check(hasRole(c, "members"), "forbidden");
  return renderPage(
    c,
    {
      owner: "time",
      path: "/time/mine",
      title: message("My time", { nl: "Mijn tijd" }),
      description: message(
        "Start, stop and submit your own time with separate observed and entered evidence.",
        {
          nl: "Start, stop en dien je eigen tijd in met afzonderlijk gemeten en ingevoerd bewijs.",
        },
      ),
    },
    async () => [
      card({
        context: c,
        title: message("Timer and manual time intake", { nl: "Timer- en handmatige tijdinvoer" }),
        layout: "columns",
        children: [
          form({ context: c, operation: "time.start", display: "inline" }),
          form({ context: c, operation: "time.manual" }),
          form({ context: c, operation: "time.submit" }),
        ],
      }),
      list({
        context: c,
        query: records(c, "time.Entry", {
          where: (entry) => same(entry.parent.user, c.actor) && entry.until === null,
        }),
        renderRow: (entry, view) => [
          text({ context: view, values: [entry.project, entry.from, entry.duration] }),
          action({ context: view, operation: "time.stop", boundArgs: { entry } }),
        ],
      }),
      table({
        context: c,
        query: records(c, "time.Entry", {
          where: (entry) =>
            same(entry.parent.user, c.actor) &&
            (c.preferences.time.location === null ||
              same(entry.project.location, c.preferences.time.location)) &&
            (c.preferences.time.week === null ||
              (compareDate(local_date(entry.from, c.team.timezone), c.preferences.time.week) >= 0 &&
                compareDate(
                  local_date(entry.from, c.team.timezone),
                  add_days(c.preferences.time.week, 7n),
                ) < 0)),
        }),
        columns: [
          "project",
          "service",
          "description",
          "from",
          "until",
          "origin",
          "duration",
          "rate",
          "amount",
          "state",
        ],
        filter: ["project", "project.location", "from", "until", "billable", "state"],
        defaults: {
          project: c.preferences.time.project,
          billable: c.preferences.time.billable_filter,
        },
        order: ["-from"],
        display: "split",
        renderRow: (entry, view) => [
          actions({
            context: view,
            operations: ["time.stop", "time.revise"],
            boundArgs: { entry },
          }),
          details({
            context: view,
            caption: message("Observed, entered and review evidence", {
              nl: "Gemeten, ingevoerd en beoordelingsbewijs",
            }),
            children: [
              text({
                context: view,
                values: [
                  entry.author,
                  entry.billable,
                  entry.reason,
                  entry.overlap_reason,
                  entry.overlap_author,
                  entry.decision,
                  entry.review,
                ],
              }),
            ],
          }),
          history({ context: view, record: entry }),
        ],
      }),
      list({
        context: c,
        query: await group(
          records(c, "time.Entry", {
            where: (entry) =>
              same(entry.parent.user, c.actor) &&
              entry.until !== null &&
              entry.state !== "superseded" &&
              (c.preferences.time.project === null ||
                same(entry.project, c.preferences.time.project)) &&
              (c.preferences.time.location === null ||
                same(entry.project.location, c.preferences.time.location)) &&
              (c.preferences.time.billable_filter === null ||
                entry.billable === c.preferences.time.billable_filter) &&
              (c.preferences.time.week === null ||
                (compareDate(local_date(entry.from, c.team.timezone), c.preferences.time.week) >=
                  0 &&
                  compareDate(
                    local_date(entry.from, c.team.timezone),
                    add_days(c.preferences.time.week, 7n),
                  ) < 0)),
          }),
          (entry) => entry.rate.currency,
        ),
        renderRow: async (row, view) =>
          metrics({
            context: view,
            values: [
              row.key,
              await sum(row.items, (entry) => entry.duration),
              await sum(row.items, (entry) => entry.amount, row.key),
            ],
          }),
      }),
      table({
        context: c,
        query: records(c, "time.PeriodReview", {
          where: (review) => same(review.parent.user, c.actor),
        }),
        columns: ["from", "until", "state", "reason"],
        renderRow: (review, view) => [
          action({ context: view, operation: "time.withdraw", boundArgs: { review } }),
          history({ context: view, record: review }),
        ],
      }),
    ],
  );
}
export async function reviewPage(c) {
  check(hasRole(c, "time.project_manager"), "forbidden");
  return renderPage(
    c,
    {
      owner: "time",
      path: "/time/review",
      title: message("Time review", { nl: "Tijdbeoordeling" }),
      description: message(
        "Review fixed periods and preserve correction financial uncertainty until the invoice owner resolves it.",
        {
          nl: "Beoordeel vastgelegde periodes en bewaar financiële correctieonzekerheid totdat de factuureigenaar deze oplost.",
        },
      ),
    },
    async () => [
      card({
        context: c,
        title: message("Project rates", { nl: "Projecttarieven" }),
        children: [
          form({ context: c, operation: "time.Project.create" }),
          table({
            context: c,
            model: "time.Project",
            columns: ["name", "location", "customer", "rate", "active"],
            renderRow: (row, view) =>
              edit({ context: view, operation: "time.Project.update", record: row }),
          }),
        ],
      }),
      table({
        context: c,
        model: "time.PeriodReview",
        columns: ["parent", "from", "until", "state", "decided_by", "reason"],
        filter: ["parent", "from", "until", "state"],
        order: ["-from"],
        display: "split",
        renderRow: (review, view) => [
          actions({
            context: view,
            operations: ["time.decide", "time.withdraw"],
            boundArgs: { review },
          }),
          table({
            context: view,
            query: review.entries,
            columns: [
              "project",
              "from",
              "until",
              "rate",
              "amount",
              "overlap_reason",
              "overlap_author",
              "state",
            ],
          }),
          history({ context: view, record: review }),
        ],
      }),
      table({
        context: c,
        query: records(c, "time.Entry", {
          where: (entry) =>
            c.preferences.time.location === null ||
            same(entry.project.location, c.preferences.time.location),
        }),
        columns: ["parent", "project", "from", "until", "rate", "amount", "state"],
        filter: ["parent", "project", "project.location", "from", "until", "state", "billable"],
        defaults: {
          project: c.preferences.time.project,
          billable: c.preferences.time.billable_filter,
        },
        order: ["-from"],
        display: "split",
        renderRow: (entry, view) => [
          actions({
            context: view,
            operations: ["time.correct", "time.bill"],
            boundArgs: { entry },
          }),
          details({
            context: view,
            caption: message("Correction and billing evidence", {
              nl: "Correctie- en facturatiebewijs",
            }),
            children: [
              text({
                context: view,
                values: [
                  entry.service,
                  entry.origin,
                  entry.billable,
                  entry.reason,
                  entry.decision,
                  entry.exported_source,
                  entry.delivery,
                ],
              }),
              table({
                context: view,
                model: "time.Correction",
                parent: entry,
                columns: [
                  "reason",
                  "replacement",
                  "author",
                  "original_source",
                  "cancel_status",
                  "collected",
                  "refunded",
                  "collection_pending",
                  "refund_pending",
                  "refund_status",
                  "reconcile_status",
                  "ready",
                ],
                renderRow: (correction, v) =>
                  actions({
                    context: v,
                    operations: ["time.retry_cancel", "time.reconcile", "time.refund"],
                    boundArgs: { correction },
                  }),
              }),
            ],
          }),
          history({ context: view, record: entry }),
        ],
      }),
      list({
        context: c,
        query: await group(
          records(c, "time.Entry", {
            where: (entry) =>
              entry.state === "approved" &&
              entry.billable &&
              (c.preferences.time.project === null ||
                same(entry.project, c.preferences.time.project)) &&
              (c.preferences.time.location === null ||
                same(entry.project.location, c.preferences.time.location)),
          }),
          (entry) => entry.rate.currency,
        ),
        renderRow: async (row, view) => [
          metrics({
            context: view,
            values: [row.key, await sum(row.items, (entry) => entry.amount, row.key)],
          }),
          table({
            context: view,
            query: row.items,
            columns: ["parent", "project", "duration", "rate", "amount", "state"],
            renderRow: (entry, v) =>
              action({ context: v, operation: "time.bill", boundArgs: { entry } }),
          }),
        ],
      }),
    ],
  );
}

/* Test-only deferred fixture recipes. The future compiler emits a separate test
 * artifact and erases fixture-only imports. This target supplies no test runner. */
export const exampleImports = [
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "customer", member: "test_company", alias: "test_company" },
];
export function exampleFixtures({ self, other, imported }) {
  const { test_worker, test_site, test_company } = imported;
  const project = {
    model: "time.Project",
    dependencies: [test_site, test_company],
    value: async (c, s) => ({
      name: "Repair",
      location: s.test_site,
      customer: s.test_company,
      rate: money(30n, "EUR"),
    }),
  };
  const stopped = {
    model: "time.Entry",
    dependencies: [project, test_worker],
    value: async (c, s) => ({
      parent: s.test_worker,
      project: s.project,
      description: "Visit",
      from: datetime("2026-10-01T22:00:00Z"),
      until: datetime("2026-10-02T02:00:00Z"),
      rate: money(30n, "EUR"),
      origin: "timer",
    }),
  };
  const prior = {
    model: "time.Entry",
    dependencies: [test_worker, project],
    value: async (c, s) => ({
      parent: s.test_worker,
      project: s.project,
      description: "Original source",
      from: datetime("2026-09-30T10:00:00Z"),
      until: datetime("2026-09-30T14:00:00Z"),
      rate: money(30n, "EUR"),
      origin: "timer",
      state: "superseded",
      exported_source: "prior-source",
    }),
  };
  const adjustment = {
    model: "time.Correction",
    dependencies: [prior, stopped],
    value: async (c, s) => ({
      parent: s.prior,
      reason: "Corrected exported time",
      replacement: s.stopped,
      original_source: "prior-source",
      amount: money(120n, "EUR"),
      fenced: true,
      fence_revision: 2n,
      revision: 2n,
      collected: money(120n, "EUR"),
      refunded: money(120n, "EUR"),
      collection_pending: false,
    }),
  };
  const review = {
    model: "time.PeriodReview",
    dependencies: [test_worker, stopped],
    value: async (c, s) => ({
      parent: s.test_worker,
      from: datetime("2026-10-01T00:00:00Z"),
      until: datetime("2026-10-03T00:00:00Z"),
      entries: [s.stopped],
    }),
  };
  return {
    project,
    stopped,
    prior,
    adjustment,
    review,
    examples: [
      {
        operation: "time.stop",
        dependencies: [stopped],
        inputs: async (c, s) => ({ entry: s.stopped }),
        selectors: ["as", "entry.state"],
        observations: [
          async (c, s) => s.entry.until,
          async (c, s) => s.entry.duration,
          async (c, s) => s.entry.amount,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "draft"],
            expected: async (c, s) => [
              datetime("2026-10-02T02:00:00Z"),
              14400000n,
              money(120n, "EUR"),
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "approved"],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["public", "draft"], error: "forbidden" },
        ],
      },
      {
        operation: "time.manual",
        dependencies: [stopped, test_worker, project],
        inputs: async (c, s) => ({
          employee: s.test_worker,
          project: s.project,
          description: "Forgotten visit",
          from: datetime("2026-10-02T03:00:00Z"),
          until: datetime("2026-10-02T04:00:00Z"),
          billable: true,
          reason: "Forgot timer",
        }),
        selectors: ["as", "from", "exception"],
        observations: [
          async (c, s) => s.result.origin,
          async (c, s) => s.result.amount,
          async (c, s) => s.result.overlap_reason,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", datetime("2026-10-02T03:00:00Z"), null],
            expected: async (c, s) => ["manual", money(30n, "EUR"), null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", datetime("2026-10-02T01:00:00Z"), null],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "time.project_manager",
              datetime("2026-10-02T01:00:00Z"),
              "Approved concurrent work",
            ],
            expected: async (c, s) => ["manual", money(90n, "EUR"), "Approved concurrent work"],
          },
        ],
      },
      {
        operation: "time.submit",
        dependencies: [test_worker, stopped],
        inputs: async (c, s) => ({
          employee: s.test_worker,
          from: datetime("2026-10-01T00:00:00Z"),
          until: datetime("2026-10-03T00:00:00Z"),
        }),
        selectors: ["stopped.state"],
        observations: [
          async (c, s) => s.stopped.state,
          async (c, s) => s.result.state,
          async (c, s) => await count(s.result.entries),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["draft"],
            expected: async (c, s) => ["submitted", "submitted", 1n],
          },
          { dependencies: [], values: async (c, s) => ["approved"], error: "rule_failed" },
        ],
      },
      {
        operation: "time.decide",
        dependencies: [review],
        inputs: async (c, s) => ({ review: s.review, reason: "Reviewed period" }),
        selectors: ["as", "approve", "stopped.state", "stopped.review"],
        observations: [
          async (c, s) => s.review.state,
          async (c, s) => s.stopped.state,
          async (c, s) => s.review.decided_by,
        ],
        rows: [
          {
            dependencies: [review],
            values: async (c, s) => ["time.project_manager", true, "submitted", s.review],
            expected: async (c, s) => ["approved", "approved", self],
          },
          {
            dependencies: [review],
            values: async (c, s) => ["time.project_manager", false, "submitted", s.review],
            expected: async (c, s) => ["rejected", "draft", self],
          },
          {
            dependencies: [review],
            values: async (c, s) => ["members", true, "submitted", s.review],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "time.correct",
        dependencies: [stopped],
        inputs: async (c, s) => ({
          entry: s.stopped,
          from: datetime("2026-10-01T22:00:00Z"),
          until: datetime("2026-10-02T01:00:00Z"),
          reason: "End time corrected",
        }),
        selectors: ["as", "entry.state"],
        observations: [
          async (c, s) => s.entry.state,
          async (c, s) => s.entry.until,
          async (c, s) => s.result.amount,
          async (c, s) => s.result.correction.ready,
          async (c, s) => s.result.correction.author,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["time.project_manager", "approved"],
            expected: async (c, s) => [
              "superseded",
              datetime("2026-10-02T02:00:00Z"),
              money(90n, "EUR"),
              true,
              self,
            ],
          },
          { dependencies: [], values: async (c, s) => ["members", "approved"], error: "forbidden" },
          {
            dependencies: [],
            values: async (c, s) => ["time.project_manager", "draft"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "time.bill",
        dependencies: [stopped, adjustment],
        inputs: async (c, s) => ({ entry: s.stopped }),
        selectors: [
          "as",
          "entry.state",
          "entry.correction",
          "adjustment.revision",
          "adjustment.collection_pending",
          "adjustment.refunded",
        ],
        observations: [async (c, s) => s.entry.state, async (c, s) => s.entry.exported_source],
        rows: [
          {
            dependencies: [adjustment],
            values: async (c, s) => [
              "time.project_manager",
              "approved",
              s.adjustment,
              2n,
              false,
              money(120n, "EUR"),
            ],
            expected: async (c, s) => ["exported", s.stopped.id],
          },
          {
            dependencies: [adjustment],
            values: async (c, s) => [
              "time.project_manager",
              "approved",
              s.adjustment,
              1n,
              false,
              money(120n, "EUR"),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [adjustment],
            values: async (c, s) => [
              "time.project_manager",
              "approved",
              s.adjustment,
              2n,
              true,
              money(120n, "EUR"),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [adjustment],
            values: async (c, s) => [
              "time.project_manager",
              "approved",
              s.adjustment,
              2n,
              false,
              money(0n, "EUR"),
            ],
            error: "rule_failed",
          },
        ],
      },
    ],
  };
}
