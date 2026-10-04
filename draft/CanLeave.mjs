import {
  add_days,
  all,
  any,
  bounded,
  require as check,
  collect,
  compareDate,
  count,
  create,
  date,
  date_year,
  dates,
  first,
  group,
  hasRole,
  int64,
  local_instant,
  overlaps,
  records,
  same,
  send,
  set,
  sum,
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
import { can_work, Employee } from "./employee.mjs";

import { Location } from "./rent_catalog.mjs";
import { ScheduleV1 } from "./shift.mjs";

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

const yearCaption = message("Year", { nl: "Jaar" });

const bucketCaption = message("Leave category", { nl: "Verlofcategorie" });

const daysCaption = message("Days", { nl: "Dagen" });

const fromCaption = message("Start", { nl: "Begin" });

const untilCaption = message("End", { nl: "Einde" });

const reviewerCaption = message("Reviewer", { nl: "Beoordelaar" });

const pendingCaption = message("Pending", { nl: "In afwachting" });

const minePageDescriptor = {
  owner: "leave",
  path: "/leave/mine",
  title: message("My leave", { nl: "Mijn verlof" }),
  description: message(
    "Preview recorded calendar and allowance data before requesting whole working days.",
    {
      nl: "Bekijk vastgelegde kalender- en tegoedgegevens voordat je hele werkdagen aanvraagt.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: minePage,
};

const reviewPageDescriptor = {
  owner: "leave",
  path: "/leave/review",
  title: message("Leave review", { nl: "Verlof beoordelen" }),
  description: message(
    "Decide assigned leave while keeping private reasons out of the shared absence calendar.",
    {
      nl: "Beoordeel toegewezen verlof en houd private redenen buiten de gedeelde afwezigheidskalender.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "leave.hr") || hasRole(c, "leave.leave_reviewer"), "forbidden");
    return {};
  },
  render: reviewPage,
};

const absencePageDescriptor = {
  owner: "leave",
  path: "/leave/absence",
  title: message("Absence dates", { nl: "Afwezigheidsdatums" }),
  description: message("View accepted dates for coverage planning under location grants.", {
    nl: "Bekijk geaccepteerde datums voor bezettingsplanning binnen locatierechten.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: absencePage,
};

export const appDefinition = {
  id: "CanLeave",
  uses: ["leave"],
  description: message(
    "Help workspace staff request time off while location managers see approved absences and plan reception, sales, and facilities coverage.",
    {
      nl: "Help werkplekmedewerkers verlof aan te vragen terwijl locatiemanagers goedgekeurde afwezigheid zien en de bezetting voor receptie, verkoop en faciliteiten plannen.",
    },
  ),
  packages: {
    leave: {
      label: message("Leave", { nl: "Verlof" }),
      description: message(
        "Calculate whole working-day leave from an explicit employee calendar and private review ledger.",
        {
          nl: "Bereken verlof in hele werkdagen uit een expliciete medewerkerskalender en een privaat beoordelingsregister.",
        },
      ),
      roles: {
        hr: { id: "leave.hr", label: message("HR staff", { nl: "HR-medewerker" }) },
        leave_reviewer: {
          id: "leave.leave_reviewer",
          label: message("Leave reviewer", { nl: "Verlofbeoordelaar" }),
        },
      },
    },
  },
  bindings: {
    "leave.StaffSchedule": { capability: ScheduleV1, from: "deployment.staff_schedule" },
  },
  models: {
    "leave.Calendar": {
      parent: Employee,
      label: message("Working calendar", { nl: "Werkkalender" }),
      fields: {
        name: { type: "text" },
        timezone: { type: "timezone" },
        revision: { type: "int", default: 1n, min: 1n },
      },
      readGrants: [{ rule: "Calendar.read.1" }, { rule: "Calendar.read.2" }],
    },
    "leave.Category": {
      parent: "leave.Calendar",
      label: message("Leave policy", { nl: "Verlofbeleid" }),
      fields: {
        name: { type: "text", unique: true, label: bucketCaption },
        allowance_bucket: {
          type: "text",
          nullable: true,
          label: message("Charged allowance category", { nl: "Belaste verlofcategorie" }),
        },
      },
      readGrants: [{ rule: "Category.read.1" }, { rule: "Category.read.2" }],
    },
    "leave.Day": {
      parent: "leave.Calendar",
      label: message("Calendar day", { nl: "Kalenderdag" }),
      fields: {
        date: { type: "date", unique: true, label: message("Date", { nl: "Datum" }) },
        working: { type: "bool", label: message("Working day", { nl: "Werkdag" }) },
      },
      derived: { year: { type: "int", handler: "Day.year", label: yearCaption } },
      readGrants: [{ rule: "Day.read.1" }, { rule: "Day.read.2" }],
    },
    "leave.Allowance": {
      parent: Employee,
      label: message("Allowance", { nl: "Tegoed" }),
      fields: {
        year: { type: "int", label: yearCaption },
        bucket: { type: "text", default: "vacation", label: bucketCaption },
        days: { type: "int", default: 20n, min: 0n, label: daysCaption },
      },
      derived: {
        remaining: {
          type: "int",
          handler: "Allowance.remaining",
          label: message("Remaining", { nl: "Resterend" }),
        },
      },
      readGrants: [{ rule: "Allowance.read.1" }, { rule: "Allowance.read.2" }],
      unique: [{ fields: ["year", "bucket"] }],
      invariants: ["Allowance.require.1"],
    },
    "leave.Request": {
      parent: "leave.Calendar",
      label: message("Leave request", { nl: "Verlofaanvraag" }),
      fields: {
        location: { type: Location },
        from: { type: "date", label: fromCaption },
        until: { type: "date", label: untilCaption },
        bucket: { type: "text", label: bucketCaption },
        reason: { type: "text" },
        reviewer: { type: "user", label: reviewerCaption },
        allowance_bucket: {
          type: "text",
          nullable: true,
          label: message("Recorded charge category", { nl: "Vastgelegde belastingscategorie" }),
        },
        schedule_revision: { type: "int", default: 1n, min: 1n },
        reserve_delivery: { type: "text", nullable: true },
        release_delivery: { type: "text", nullable: true },
        release_state: {
          type: "enum",
          cases: ["none", "pending", "released", "failed", "unknown"],
          default: "none",
          label: {
            text: message("Absence release", { nl: "Afwezigheid vrijgeven" }),
            values: {
              none: message("Not requested", { nl: "Niet aangevraagd" }),
              pending: pendingCaption,
              released: message("Released", { nl: "Vrijgegeven" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
            },
          },
        },
        timezone: { type: "timezone" },
        calendar_version: {
          type: "int",
          label: message("Calendar version", { nl: "Kalenderversie" }),
        },
        state: {
          type: "enum",
          cases: ["pending", "approved", "rejected", "withdrawn", "cancelled"],
          default: "pending",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              pending: pendingCaption,
              approved: message("Approved", { nl: "Goedgekeurd" }),
              rejected: message("Rejected", { nl: "Afgewezen" }),
              withdrawn: message("Withdrawn", { nl: "Ingetrokken" }),
              cancelled: message("Cancelled", { nl: "Geannuleerd" }),
            },
          },
        },
        decision: { type: "text", nullable: true, label: message("Decision", { nl: "Besluit" }) },
        schedule_source: {
          type: "text",
          nullable: true,
          label: message("Schedule source", { nl: "Planningsbron" }),
        },
        sync: {
          type: "enum",
          cases: ["none", "pending", "confirmed", "conflict", "unavailable"],
          default: "none",
          label: {
            text: message("Schedule synchronization", { nl: "Planningsafstemming" }),
            values: {
              pending: pendingCaption,
              none: message("None", { nl: "Geen" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              conflict: message("Conflict", { nl: "Conflict" }),
              unavailable: message("Unavailable", { nl: "Niet beschikbaar" }),
            },
          },
        },
      },
      readGrants: [
        { rule: "Request.read.1" },
        { rule: "Request.read.2" },
        { rule: "Request.read.3" },
        { rule: "Request.read.4", fields: ["location", "from", "until", "state"] },
      ],
      invariants: ["Request.require.1"],
      locks: ["Request.lock.1"],
    },
    "leave.Portion": {
      parent: "leave.Request",
      label: message("Yearly leave portion", { nl: "Verlofdeel per jaar" }),
      fields: {
        allowance: { type: "leave.Allowance", nullable: true },
        days: { type: "int", label: daysCaption },
        dates: {
          type: "date",
          array: true,
          requiredArray: true,
          label: message("Working dates", { nl: "Werkdagen" }),
        },
      },
      readGrants: [
        { rule: "Portion.read.1" },
        { rule: "Portion.read.2" },
        { rule: "Portion.read.3" },
      ],
      locks: ["Portion.lock.1"],
    },
  },
  preferences: {
    leave: {
      fields: {
        year: { type: "int", nullable: true, default: null, label: yearCaption },
        bucket: { type: "text", nullable: true, default: null, label: bucketCaption },
      },
    },
  },
  contracts: {
    "leave.PreviewPortion": {
      fields: {
        year: { type: "int", label: yearCaption },
        days: { type: "int", label: daysCaption },
        allowance: { type: "leave.Allowance", nullable: true },
      },
    },
    "leave.Preview": {
      fields: {
        days: { type: "int", label: daysCaption },
        portions: { type: "leave.PreviewPortion", array: true, requiredArray: true },
      },
    },
  },
  operations: {
    "leave.Calendar.create": {
      handler: "createCalendar",
      kind: "create",
      model: "leave.Calendar",
      by: "leave.hr",
      read: false,
      inputs: { parent: { type: Employee }, fields: ["name", "timezone"] },
    },
    "leave.Calendar.update": {
      handler: "updateCalendar",
      kind: "update",
      model: "leave.Calendar",
      by: "leave.hr",
      read: false,
      inputs: {
        record: { type: "leave.Calendar" },
        changes: { fields: ["name", "timezone"] },
      },
    },
    "leave.Category.create": {
      handler: "createCategory",
      kind: "create",
      model: "leave.Category",
      by: "leave.hr",
      read: false,
      inputs: { parent: { type: "leave.Calendar" }, fields: ["name", "allowance_bucket"] },
    },
    "leave.Category.update": {
      handler: "updateCategory",
      kind: "update",
      model: "leave.Category",
      by: "leave.hr",
      read: false,
      inputs: {
        record: { type: "leave.Category" },
        changes: { fields: ["name", "allowance_bucket"] },
      },
    },
    "leave.Day.create": {
      handler: "createDay",
      kind: "create",
      model: "leave.Day",
      by: "leave.hr",
      read: false,
      inputs: { parent: { type: "leave.Calendar" }, fields: ["date", "working"] },
    },
    "leave.Day.update": {
      handler: "updateDay",
      kind: "update",
      model: "leave.Day",
      by: "leave.hr",
      read: false,
      inputs: { record: { type: "leave.Day" }, changes: { fields: ["date", "working"] } },
    },
    "leave.Allowance.create": {
      handler: "createAllowance",
      kind: "create",
      model: "leave.Allowance",
      by: "leave.hr",
      read: false,
      inputs: { parent: { type: Employee }, fields: ["year", "bucket", "days"] },
    },
    "leave.Allowance.update": {
      handler: "updateAllowance",
      kind: "update",
      model: "leave.Allowance",
      by: "leave.hr",
      read: false,
      inputs: { record: { type: "leave.Allowance" }, changes: { fields: ["days"] } },
    },
    "leave.preview": {
      handler: "preview",
      read: true,
      result: "leave.Preview",
      by: "members",
      inputs: {
        calendar: { type: "leave.Calendar" },
        from: { type: "date", label: fromCaption },
        until: { type: "date", label: untilCaption },
        bucket: { type: "text", label: bucketCaption },
      },
      label: message("Preview leave", { nl: "Verlof vooraf bekijken" }),
      description: message(
        "Preview counted dates and yearly balances without creating a request.",
        { nl: "Bekijk getelde datums en jaarsaldi zonder een aanvraag aan te maken." },
      ),
    },
    "leave.request": {
      handler: "request",
      by: "members",
      read: false,
      inputs: {
        calendar: { type: "leave.Calendar" },
        from: { type: "date", label: fromCaption },
        until: { type: "date", label: untilCaption },
        bucket: { type: "text", label: bucketCaption },
        reason: { type: "text" },
        reviewer: { type: "user", label: reviewerCaption },
      },
      label: message("Request leave", { nl: "Verlof aanvragen" }),
      description: message(
        "Snapshot configured working dates and split the request against each applicable year.",
        {
          nl: "Leg ingestelde werkdagen vast en verdeel de aanvraag over alle toepasselijke jaren.",
        },
      ),
    },
    "leave.decide": {
      handler: "decide",
      by: "leave.leave_reviewer",
      read: false,
      inputs: {
        request: { type: "leave.Request" },
        approve: { type: "bool", label: message("Approve", { nl: "Goedkeuren" }) },
        reason: { type: "text" },
      },
      label: message("Record decision", { nl: "Besluit vastleggen" }),
      description: message(
        "Reserve all applicable yearly allowances atomically and publish only absence dates.",
        {
          nl: "Reserveer alle toepasselijke jaarlijkse tegoeden atomair en publiceer uitsluitend afwezigheidsdatums.",
        },
      ),
    },
    "leave.withdraw": {
      handler: "withdraw",
      by: "members",
      read: false,
      inputs: { request: { type: "leave.Request" } },
      label: message("Withdraw", { nl: "Intrekken" }),
      description: message(
        "Withdraw your still-pending request without changing approved allowances.",
        { nl: "Trek je nog lopende aanvraag in zonder goedgekeurde tegoeden te wijzigen." },
      ),
    },
    "leave.retry_release": {
      handler: "retry_release",
      read: false,
      by: ["leave.hr", "leave.leave_reviewer"],
      inputs: { request: { type: "leave.Request" } },
      label: message("Retry absence release", { nl: "Vrijgave afwezigheid herhalen" }),
      description: message(
        "Retry an unresolved cancellation using its retained absence release fence.",
        {
          nl: "Herhaal een onopgeloste annulering met de behouden vrijgavegrens voor afwezigheid.",
        },
      ),
    },
    "leave.cancel": {
      handler: "cancel",
      by: ["leave.hr", "leave.leave_reviewer"],
      read: false,
      inputs: { request: { type: "leave.Request" }, reason: { type: "text" } },
      description: message(
        "Restore a previously reserved allowance once and release its accepted absence reference.",
        {
          nl: "Herstel een eerder gereserveerd tegoed één keer en geef de geaccepteerde afwezigheidsreferentie vrij.",
        },
      ),
    },
  },
  handlers: {
    "leave.calendar_changed": { handler: "calendar_changed", on: "leave.Calendar.update" },
    "leave.day_created": { handler: "day_created", on: "leave.Day.create" },
    "leave.day_changed": { handler: "day_changed", on: "leave.Day.update" },
    "leave.category_created": { handler: "category_created", on: "leave.Category.create" },
    "leave.category_changed": { handler: "category_changed", on: "leave.Category.update" },
    "leave.reserve_result": {
      handler: "reserve_result",
      on: { capability: "leave.StaffSchedule", operation: "reserve", event: "completed" },
    },
    "leave.release_result": {
      handler: "release_result",
      on: { capability: "leave.StaffSchedule", operation: "release", event: "completed" },
    },
    "leave.schedule_result": {
      handler: "schedule_result",
      on: { capability: "leave.StaffSchedule", event: "changed" },
    },
  },
  pages: [
    minePageDescriptor,
    reviewPageDescriptor,
    absencePageDescriptor,
  ],
  disabled: [
    "leave.Calendar.delete",
    "leave.Day.delete",
    "leave.Allowance.delete",
    "leave.Category.delete",
  ],
};

export function canApp() {
  return {
    read: {
      "Calendar.read.1": (c, row) => hasRole(c, "authenticated") && same(row.parent.user, c.actor),
      "Calendar.read.2": (c, row) => hasRole(c, "leave.hr"),
      "Category.read.1": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.parent.user, c.actor),
      "Category.read.2": (c, row) => hasRole(c, "leave.hr"),
      "Day.read.1": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.parent.user, c.actor),
      "Day.read.2": (c, row) => hasRole(c, "leave.hr"),
      "Allowance.read.1": (c, row) => hasRole(c, "authenticated") && same(row.parent.user, c.actor),
      "Allowance.read.2": (c, row) => hasRole(c, "leave.hr"),
      "Request.read.1": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.parent.user, c.actor),
      "Request.read.2": async (c, row) =>
        hasRole(c, "leave.leave_reviewer") &&
        same(row.reviewer, c.actor) &&
        (await can_work(c, c.actor, row.parent.parent.home)),
      "Request.read.3": (c, row) => hasRole(c, "leave.hr"),
      "Request.read.4": async (c, row) =>
        hasRole(c, "members") &&
        row.state === "approved" &&
        (await can_work(c, c.actor, row.parent.parent.home)),
      "Portion.read.1": (c, row) =>
        hasRole(c, "authenticated") && same(row.parent.parent.parent.user, c.actor),
      "Portion.read.2": (c, row) => hasRole(c, "leave.hr"),
      "Portion.read.3": async (c, row) =>
        hasRole(c, "leave.leave_reviewer") &&
        same(row.parent.reviewer, c.actor) &&
        (await can_work(c, c.actor, row.parent.parent.parent.home)),
    },
    derives: {
      "Day.year": (c, row) => date_year(row.date),
      "Allowance.remaining": async (c, row) =>
        int64(
          row.days -
            (await sum(
              records(c, "leave.Portion", {
                where: (portion) =>
                  same(portion.allowance, row) && portion.parent.state === "approved",
              }),
              (portion) => portion.days,
            )),
        ),
    },
    invariants: {
      "Request.require.1": (c, row) =>
        compareDate(row.from, row.until) <= 0 && !same(row.reviewer, row.parent.parent.user),
      "Allowance.require.1": (c, row) => row.remaining >= 0n,
    },

    locks: {
      "Request.lock.1": {
        fields: [
          "location",
          "from",
          "until",
          "bucket",
          "reason",
          "reviewer",
          "timezone",
          "allowance_bucket",
          "calendar_version",
        ],
      },
      "Portion.lock.1": { fields: ["allowance", "days", "dates"] },
    },
    async createCalendar(c, input) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await create(c, "leave.Calendar", input);
    },
    async updateCalendar(c, { record, changes }) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await set(c, record, changes);
    },
    async createCategory(c, input) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await create(c, "leave.Category", input);
    },
    async updateCategory(c, { record, changes }) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await set(c, record, changes);
    },
    async createDay(c, input) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await create(c, "leave.Day", input);
    },
    async updateDay(c, { record, changes }) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await set(c, record, changes);
    },
    async createAllowance(c, input) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await create(c, "leave.Allowance", input);
    },
    async updateAllowance(c, { record, changes }) {
      check(hasRole(c, "leave.hr"), "forbidden");
      await set(c, record, changes);
    },
    async calendar_changed(c, { event }) {
      await set(c, event.after, { revision: int64(event.before.revision + 1n) });
    },
    async day_created(c, { event }) {
      await set(c, event.after.parent, { revision: int64(event.after.parent.revision + 1n) });
    },
    async day_changed(c, { event }) {
      await set(c, event.after.parent, { revision: int64(event.after.parent.revision + 1n) });
    },
    async category_created(c, { event }) {
      await set(c, event.after.parent, { revision: int64(event.after.parent.revision + 1n) });
    },
    async category_changed(c, { event }) {
      await set(c, event.after.parent, { revision: int64(event.after.parent.revision + 1n) });
    },
    async preview(c, { calendar, from, until, bucket }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(calendar.parent.user, c.actor) &&
          calendar.parent.active &&
          compareDate(from, until) <= 0,
      );
      check(
        await all(dates(from, add_days(until, 1n), 3660n), (day_date) =>
          any(
            records(c, "leave.Day", { parent: calendar }),
            (day) => compareDate(day.date, day_date) === 0,
          ),
        ),
      );
      const policy = await first(
        records(c, "leave.Category", {
          parent: calendar,
          where: (category) => category.name === bucket,
          order: ["id"],
        }),
      );
      check(policy !== null);
      const selected = await collect(
        records(c, "leave.Day", {
          parent: calendar,
          where: (day) =>
            compareDate(from, day.date) <= 0 && compareDate(day.date, until) <= 0 && day.working,
        }),
      );
      check((await count(selected)) > 0n);
      const portions = [];
      for (const year of await group(selected, (day) => day.year))
        portions.push({
          year: year.key,
          days: await count(year.items),
          allowance: await first(
            records(c, "leave.Allowance", {
              parent: calendar.parent,
              where: (allowance) =>
                allowance.year === year.key && allowance.bucket === policy.allowance_bucket,
              order: ["id"],
            }),
          ),
        });
      check(
        (await count(portions)) <= 10n &&
          (await all(
            portions,
            (portion) => policy.allowance_bucket === null || portion.allowance !== null,
          )),
      );
      return { days: await count(selected), portions };
    },
    async request(c, { calendar, from, until, bucket, reason, reviewer }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(calendar.parent.user, c.actor) &&
          calendar.parent.active &&
          compareDate(from, until) <= 0 &&
          !same(reviewer, c.actor) &&
          (await can_work(c, reviewer, calendar.parent.home)) &&
          reason.trim() !== "",
      );
      check(
        !(await any(
          records(c, "leave.Request", { parent: calendar }),
          (old) =>
            ["pending", "approved"].includes(old.state) &&
            overlaps(from, add_days(until, 1n), old.from, add_days(old.until, 1n)),
        )),
      );
      check(
        await all(dates(from, add_days(until, 1n), 3660n), (day_date) =>
          any(
            records(c, "leave.Day", { parent: calendar }),
            (day) => compareDate(day.date, day_date) === 0,
          ),
        ),
      );
      const policy = await first(
        records(c, "leave.Category", {
          parent: calendar,
          where: (category) => category.name === bucket,
          order: ["id"],
        }),
      );
      check(policy !== null);
      const selected = await collect(
        records(c, "leave.Day", {
          parent: calendar,
          where: (day) =>
            compareDate(from, day.date) <= 0 && compareDate(day.date, until) <= 0 && day.working,
        }),
      );
      check((await count(selected)) > 0n);
      const request = await create(c, "leave.Request", {
        parent: calendar,
        location: calendar.parent.home,
        from,
        until,
        bucket,
        reason,
        reviewer,
        timezone: calendar.timezone,
        allowance_bucket: policy.allowance_bucket,
        calendar_version: calendar.revision,
      });
      const years = await group(selected, (day) => day.year);
      for await (const year of bounded(years, 10n)) {
        const allowance = await first(
          records(c, "leave.Allowance", {
            parent: calendar.parent,
            where: (allowance) =>
              allowance.year === year.key && allowance.bucket === policy.allowance_bucket,
            order: ["id"],
          }),
        );
        check(policy.allowance_bucket === null || allowance !== null);
        await create(c, "leave.Portion", {
          parent: request,
          allowance,
          days: await count(year.items),
          dates: year.items.map((day) => day.date),
        });
      }
    },
    async decide(c, { request, approve, reason }) {
      check(hasRole(c, "leave.leave_reviewer"), "forbidden");
      check(
        request.state === "pending" &&
          same(request.reviewer, c.actor) &&
          !same(request.parent.parent.user, c.actor) &&
          (await can_work(c, c.actor, request.parent.parent.home)) &&
          reason.trim() !== "",
      );
      const reserve_revision = request.schedule_revision;
      if (approve) {
        check(
          await all(
            records(c, "leave.Portion", { parent: request }),
            (portion) => portion.allowance === null || portion.days <= portion.allowance.remaining,
          ),
        );
        await set(c, request, {
          state: "approved",
          decision: reason,
          schedule_source: c.operation.id,
          sync: "pending",
        });
        const delivery = await send(
          c,
          "leave.StaffSchedule.reserve",
          {
            value: {
              source: c.operation.id,
              employee: request.parent.parent.user,
              location: request.location.id,
              from: local_instant(request.from, "00:00", request.timezone, {
                fold: "earlier",
              }),
              until: local_instant(add_days(request.until, 1n), "00:00", request.timezone, {
                fold: "earlier",
              }),
              skill: "absence",
              kind: "absence",
              revision: reserve_revision,
            },
          },
          {
            when: () =>
              request.state === "approved" &&
              request.schedule_source === c.operation.id &&
              request.schedule_revision === reserve_revision,
          },
        );
        await set(c, request, { reserve_delivery: delivery.id });
      } else await set(c, request, { state: "rejected", decision: reason });
    },
    async withdraw(c, { request }) {
      check(hasRole(c, "members"), "forbidden");
      check(same(request.parent.parent.user, c.actor) && request.state === "pending");
      await set(c, request, { state: "withdrawn" });
    },
    async cancel(c, { request, reason }) {
      check(hasRole(c, "leave.hr") || hasRole(c, "leave.leave_reviewer"), "forbidden");
      check(
        request.state === "approved" &&
          reason.trim() !== "" &&
          (hasRole(c, "leave.hr") ||
            (same(request.reviewer, c.actor) &&
              (await can_work(c, c.actor, request.parent.parent.home)))),
      );
      await set(c, request, {
        state: "cancelled",
        decision: reason,
        sync: "none",
        schedule_revision: int64(request.schedule_revision + 1n),
        release_state: "pending",
      });
      if (request.schedule_source !== null) {
        const delivery = await send(
          c,
          "leave.StaffSchedule.release",
          { source: request.schedule_source, revision: request.schedule_revision },
          { when: () => request.state === "cancelled" },
        );
        await set(c, request, { release_delivery: delivery.id });
      }
    },
    async retry_release(c, { request }) {
      check(hasRole(c, "leave.hr") || hasRole(c, "leave.leave_reviewer"), "forbidden");
      check(
        request.state === "cancelled" &&
          request.schedule_source !== null &&
          ["failed", "unknown"].includes(request.release_state) &&
          (hasRole(c, "leave.hr") ||
            (same(request.reviewer, c.actor) &&
              (await can_work(c, c.actor, request.parent.parent.home)))),
      );
      const delivery = await send(
        c,
        "leave.StaffSchedule.release",
        { source: request.schedule_source, revision: request.schedule_revision },
        { when: () => request.state === "cancelled" },
      );
      await set(c, request, { release_delivery: delivery.id, release_state: "pending" });
    },
    async schedule_result(c, { event }) {
      for await (const request of records(c, "leave.Request", {
        where: (item) =>
          item.schedule_source === event.value.source &&
          item.schedule_revision === event.value.revision,
        limit: 1n,
      })) {
        if (request.state === "approved") {
          if (event.value.state === "confirmed") await set(c, request, { sync: "confirmed" });
          else if (event.value.state === "unavailable") await set(c, request, { sync: "conflict" });
          else if (["failed", "unknown"].includes(event.value.state))
            await set(c, request, { sync: "unavailable" });
        } else if (request.state === "cancelled" && event.value.state === "released")
          await set(c, request, { release_state: "released" });
      }
    },
    async reserve_result(c, { event }) {
      for await (const request of records(c, "leave.Request", {
        where: (item) => item.reserve_delivery === event.delivery_id && item.state === "approved",
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === request.schedule_source &&
          event.result.revision === request.schedule_revision
        ) {
          if (event.result.state === "confirmed") await set(c, request, { sync: "confirmed" });
          else if (event.result.state === "unavailable")
            await set(c, request, { sync: "conflict" });
          else if (["failed", "unknown"].includes(event.result.state))
            await set(c, request, { sync: "unavailable" });
        } else if (["failed", "unknown", "skipped"].includes(event.status))
          await set(c, request, { sync: "unavailable" });
      }
    },
    async release_result(c, { event }) {
      for await (const request of records(c, "leave.Request", {
        where: (item) =>
          item.release_delivery === event.delivery_id &&
          item.state === "cancelled" &&
          item.release_state !== "released",
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === request.schedule_source &&
          event.result.revision === request.schedule_revision &&
          event.result.state === "released"
        )
          await set(c, request, { release_state: "released" });
        else if (["failed", "skipped"].includes(event.status))
          await set(c, request, { release_state: "failed" });
        else if (event.status === "unknown") await set(c, request, { release_state: "unknown" });
      }
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
        title: message("Leave dates and allowance", { nl: "Verlofdatums en tegoed" }),
        layout: "columns",
        children: [
          card({
            context: c,
            title: message("Working calendar and request intake", {
              nl: "Werkkalender en verlofaanvraag",
            }),
            children: [
              list({
                context: c,
                model: "leave.Calendar",
                display: "split",
                renderRow: (calendar, view) => [
                  form({
                    context: view,
                    operation: "leave.preview",
                    arguments: { calendar },
                    renderResult: (result, v) => [
                      text({ context: v, values: [result.days] }),
                      list({
                        context: v,
                        items: result.portions,
                        renderRow: (portion, w) =>
                          text({
                            context: w,
                            values: [portion.year, portion.days, portion.allowance?.remaining],
                          }),
                      }),
                    ],
                  }),
                  form({ context: view, operation: "leave.request", arguments: { calendar } }),
                  table({
                    context: view,
                    model: "leave.Day",
                    parent: calendar,
                    columns: ["date", "working"],
                  }),
                  table({
                    context: view,
                    model: "leave.Request",
                    parent: calendar,
                    columns: ["from", "until", "bucket", "state", "decision", "sync"],
                    order: ["-from"],
                    filter: ["bucket", "state"],
                    defaults: { bucket: c.preferences.leave.bucket },
                    renderRow: (request, v) =>
                      actions({
                        context: v,
                        operations: ["leave.withdraw"],
                        boundArgs: { request },
                      }),
                  }),
                ],
              }),
            ],
          }),
          card({
            context: c,
            title: message("Annual allowance", { nl: "Jaarlijks verloftegoed" }),
            children: [
              table({
                context: c,
                model: "leave.Allowance",
                columns: ["year", "bucket", "days", "remaining"],
                filter: ["year", "bucket"],
                defaults: { year: c.preferences.leave.year, bucket: c.preferences.leave.bucket },
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
      card({
        context: c,
        title: message("Assigned review", { nl: "Toegewezen beoordeling" }),
        children: [
          table({
            context: c,
            model: "leave.Request",
            columns: ["from", "until", "reason", "state", "decision", "sync", "release_state"],
            order: ["from"],
            filter: ["bucket", "state"],
            defaults: { bucket: c.preferences.leave.bucket },
            display: "split",
            renderRow: (request, view) => [
              actions({
                context: view,
                operations: ["leave.decide", "leave.cancel", "leave.retry_release"],
                boundArgs: { request },
              }),
              details({
                context: view,
                caption: message("Recorded date portions", { nl: "Vastgelegde datumdelen" }),
                children: [
                  list({
                    context: view,
                    model: "leave.Portion",
                    parent: request,
                    renderRow: (portion, v) =>
                      text({
                        context: v,
                        values: [portion.days, portion.dates],
                      }),
                  }),
                ],
              }),
              history({ context: view, record: request }),
            ],
          }),
        ],
      }),
      ...(hasRole(c, "leave.hr")
        ? [
            card({
              context: c,
              title: message("Allowance and calendar policies", { nl: "Tegoed en kalenderbeleid" }),
              children: [
                form({ context: c, operation: "leave.Allowance.create" }),
                table({
                  context: c,
                  model: "leave.Allowance",
                  columns: ["year", "bucket", "days", "remaining"],
                  filter: ["year", "bucket"],
                  renderRow: (allowance, v) =>
                    edit({ context: v, operation: "leave.Allowance.update", record: allowance }),
                }),
                list({
                  context: c,
                  model: "leave.Calendar",
                  renderRow: (calendar, v) => [
                    form({
                      context: v,
                      operation: "leave.Category.create",
                      arguments: { parent: calendar },
                    }),
                    table({
                      context: v,
                      model: "leave.Category",
                      parent: calendar,
                      columns: ["name", "allowance_bucket"],
                      renderRow: (category, w) =>
                        edit({ context: w, operation: "leave.Category.update", record: category }),
                    }),
                    table({
                      context: v,
                      model: "leave.Day",
                      parent: calendar,
                      columns: ["date", "working"],
                      renderRow: (day, w) =>
                        edit({ context: w, operation: "leave.Day.update", record: day }),
                    }),
                  ],
                }),
              ],
            }),
          ]
        : []),
    ],
  );
}

export async function absencePage(c, bindings) {
  return renderPage(
    c,
    absencePageDescriptor,
    () => [
      card({
        context: c,
        title: message("Scoped absence dates", { nl: "Afwezigheid binnen scope" }),
        children: [
          table({
            context: c,
            model: "leave.Request",
            where: (request) => request.state === "approved",
            columns: ["location", "from", "until", "state"],
            filter: ["location", "from", "until"],
          }),
        ],
      }),
    ],
  );
}

/* Remaining implementation limits: all runtime/UI/transport contracts and inline
 * examples are unimplemented. Request timezone/category and Portion date snapshots
 * remain independent of later calendar or policy changes. */

/* Test-only fixture recipes and inline behavior examples. The future compiler
 * extracts these declarations and erases fixture-only imports from production.
 * Recipes retain identity; dependencies resolve before deferred value callbacks.
 * Each row provisions only seed/common-input/row dependencies and their closure.
 * Common bindings establish the baseline. Inputs, cells and expected values read
 * untouched seeded scope s; overrides apply together, observations use fresh scope.
 * No runner, provisioning implementation or Can-expression interpreter is added.
 */
export const exampleImports = [
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_worker, test_site } = imported;
  const calendar = {
    model: "leave.Calendar",
    dependencies: [test_worker],
    value: async (c, s) => ({
      parent: s.test_worker,
      name: "Working days",
      timezone: "Europe/Brussels",
    }),
  };
  const vacation = {
    model: "leave.Category",
    dependencies: [calendar],
    value: async (c, s) => ({ parent: s.calendar, name: "vacation", allowance_bucket: "vacation" }),
  };
  const sick = {
    model: "leave.Category",
    dependencies: [calendar],
    value: async (c, s) => ({ parent: s.calendar, name: "sick" }),
  };
  const pending = {
    model: "leave.Request",
    dependencies: [calendar, test_site],
    value: async (c, s) => ({
      parent: s.calendar,
      location: s.test_site,
      from: date("2099-01-02"),
      until: date("2099-01-02"),
      bucket: "vacation",
      reason: "Holiday",
      reviewer: s.other,
      timezone: "Europe/Brussels",
      calendar_version: 1n,
    }),
  };
  const reviewer_worker = {
    model: "employee.Employee",
    dependencies: [test_site],
    value: async (c, s) => ({
      user: s.other,
      home: s.test_site,
      locations: [s.test_site],
      start: date("2026-10-01"),
      role: "reviewer",
    }),
  };
  const december_30 = {
    model: "leave.Day",
    dependencies: [calendar],
    value: async (c, s) => ({ parent: s.calendar, date: date("2099-12-30"), working: true }),
  };
  const december_31 = {
    model: "leave.Day",
    dependencies: [calendar],
    value: async (c, s) => ({ parent: s.calendar, date: date("2099-12-31"), working: true }),
  };
  const january_1 = {
    model: "leave.Day",
    dependencies: [calendar],
    value: async (c, s) => ({ parent: s.calendar, date: date("2100-01-01"), working: false }),
  };
  const january_2 = {
    model: "leave.Day",
    dependencies: [calendar],
    value: async (c, s) => ({ parent: s.calendar, date: date("2100-01-02"), working: true }),
  };
  const allowance_2099 = {
    model: "leave.Allowance",
    dependencies: [test_worker],
    value: async (c, s) => ({ parent: s.test_worker, year: 2099n, bucket: "vacation" }),
  };
  const recorded = {
    model: "leave.Portion",
    dependencies: [pending, allowance_2099],
    value: async (c, s) => ({
      parent: s.pending,
      allowance: s.allowance_2099,
      days: 1n,
      dates: [date("2099-01-02")],
    }),
  };
  const allowance_2100 = {
    model: "leave.Allowance",
    dependencies: [test_worker],
    value: async (c, s) => ({ parent: s.test_worker, year: 2100n, bucket: "vacation" }),
  };
  return {
    vacation,
    sick,
    recorded,
    allowance_2099,
    allowance_2100,
    calendar,
    december_30,
    december_31,
    january_1,
    january_2,
    pending,
    reviewer_worker,
    examples: [
      {
        operation: "leave.preview",
        seed: [
          vacation,
          december_30,
          december_31,
          january_1,
          january_2,
          allowance_2099,
          allowance_2100,
        ],
        dependencies: [calendar],
        inputs: async (c, s) => ({
          calendar: s.calendar,
          from: date("2099-12-30"),
          until: date("2100-01-02"),
          bucket: "vacation",
        }),
        selectors: ["as"],
        observations: [
          async (c, s) => s.result.days,
          async (c, s) => s.result.portions.map((portion) => portion.days),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members"],
            expected: async (c, s) => [3n, [2n, 1n]],
          },
        ],
      },
      {
        operation: "leave.request",
        seed: [
          vacation,
          allowance_2099,
          allowance_2100,
          december_30,
          december_31,
          january_1,
          january_2,
          reviewer_worker,
        ],
        dependencies: [calendar],
        inputs: async (c, s) => ({
          calendar: s.calendar,
          from: date("2099-12-30"),
          until: date("2100-01-02"),
          bucket: "vacation",
          reason: "Year-end leave",
          reviewer: s.other,
        }),
        selectors: ["as"],
        observations: [
          async (c, s) =>
            await (async () => {
              const values = [];
              for await (const portion of records(c, "leave.Portion", {
                where: (portion) => same(portion.parent.parent, s.calendar),
                order: ["allowance.year"],
              }))
                values.push(portion.allowance.year);
              return values;
            })(),
          async (c, s) =>
            await (async () => {
              const values = [];
              for await (const portion of records(c, "leave.Portion", {
                where: (portion) => same(portion.parent.parent, s.calendar),
                order: ["allowance.year"],
              }))
                values.push(portion.days);
              return values;
            })(),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members"],
            expected: async (c, s) => [
              [2099n, 2100n],
              [2n, 1n],
            ],
          },
        ],
      },
      {
        operation: "leave.request",
        seed: [
          vacation,
          allowance_2099,
          allowance_2100,
          december_30,
          december_31,
          january_2,
          reviewer_worker,
        ],
        dependencies: [calendar],
        inputs: async (c, s) => ({
          calendar: s.calendar,
          from: date("2099-12-30"),
          until: date("2100-01-02"),
          bucket: "vacation",
          reason: "Year-end leave",
          reviewer: s.other,
        }),
        selectors: ["as"],
        observations: [
          async (c, s) => await count(records(c, "leave.Request", { parent: s.calendar })),
        ],
        rows: [{ dependencies: [], values: async (c, s) => ["members"], error: "rule_failed" }],
      },
      {
        operation: "leave.request",
        seed: [sick, reviewer_worker, january_2],
        dependencies: [calendar],
        inputs: async (c, s) => ({
          calendar: s.calendar,
          from: date("2100-01-02"),
          until: date("2100-01-02"),
          bucket: "sick",
          reason: "Unwell",
          reviewer: s.other,
        }),
        selectors: ["as"],
        observations: [
          async (c, s) =>
            (
              await collect(
                records(c, "leave.Portion", {
                  where: (portion) => same(portion.parent.parent, s.calendar),
                }),
              )
            ).map((portion) => portion.allowance),
          async (c, s) =>
            (
              await collect(
                records(c, "leave.Portion", {
                  where: (portion) => same(portion.parent.parent, s.calendar),
                }),
              )
            ).map((portion) => portion.days),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members"],
            expected: async (c, s) => [[null], [1n]],
          },
        ],
      },
      {
        operation: "leave.decide",
        seed: [recorded, reviewer_worker],
        dependencies: [pending],
        inputs: async (c, s) => ({ request: s.pending, approve: true, reason: "Reviewed policy" }),
        selectors: [
          "as",
          "request.parent.parent.user",
          "request.reviewer",
          "reviewer_worker.user",
          "allowance_2099.days",
        ],
        observations: [
          async (c, s) => s.request.state,
          async (c, s) => s.allowance_2099.remaining,
          async (c, s) => s.request.sync,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["leave.leave_reviewer", s.other, s.self, s.self, 1n],
            expected: async (c, s) => ["approved", 0n, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["leave.leave_reviewer", s.other, s.self, s.self, 0n],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "leave.cancel",
        seed: [recorded],
        dependencies: [pending],
        inputs: async (c, s) => ({ request: s.pending, reason: "Cancelled plans" }),
        selectors: ["as", "request.state", "request.schedule_source"],
        observations: [
          async (c, s) => s.request.state,
          async (c, s) => s.allowance_2099.remaining,
          async (c, s) => s.request.release_state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["leave.hr", "approved", "leave-source"],
            expected: async (c, s) => ["cancelled", 20n, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["leave.hr", "cancelled", "leave-source"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "leave.schedule_result",
        seed: [pending],
        dependencies: [],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "leave-source",
              revision: 2n,
              state: "confirmed",
              reference: null,
              detail: null,
            },
          },
        }),
        selectors: [
          "pending.state",
          "pending.schedule_source",
          "pending.schedule_revision",
          "event.value.state",
        ],
        observations: [
          async (c, s) => s.pending.state,
          async (c, s) => s.pending.sync,
          async (c, s) => s.pending.release_state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cancelled", "leave-source", 2n, "confirmed"],
            expected: async (c, s) => ["cancelled", "none", "none"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["cancelled", "leave-source", 2n, "released"],
            expected: async (c, s) => ["cancelled", "none", "released"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["approved", "leave-source", 2n, "confirmed"],
            expected: async (c, s) => ["approved", "confirmed", "none"],
          },
        ],
      },
      {
        operation: "leave.withdraw",
        dependencies: [pending],
        inputs: async (c, s) => ({ request: s.pending }),
        selectors: ["as", "request.state"],
        observations: [async (c, s) => s.request.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "pending"],
            expected: async (c, s) => ["withdrawn"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "approved"],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["public", "pending"], error: "forbidden" },
        ],
      },
    ],
  };
}
