import {
  action,
  addDuration,
  all,
  any,
  cancel,
  require as check,
  compareInstant,
  count,
  create,
  datetime,
  deleteRecord,
  format,
  hasRole,
  int64,
  overlaps,
  records,
  same,
  schedule,
  send,
  set,
  subtractDuration,
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
  tab,
  tabs,
  text,
} from "@canlang/ui";
import { can_work } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";
import { Booking } from "./rent_reservations.mjs";

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

const cancelled = message("Cancelled", { nl: "Geannuleerd" });

const attended = message("Attended", { nl: "Aanwezig geweest" });

const activeStates = ["registered", "confirmed"];

async function venue_covers(c, venue, location, from, until) {
  return (
    ["confirmed", "occupied"].includes(venue.status) &&
    ["paid", "free", "on_account"].includes(venue.payment) &&
    ["not_required", "consumed"].includes(venue.allowance) &&
    same(venue.parent.location, location) &&
    (((await count(venue.intervals)) === 0n &&
      compareInstant(venue.from, from) <= 0 &&
      compareInstant(until, venue.until) <= 0) ||
      (await any(
        venue.intervals,
        (interval) =>
          compareInstant(interval.from, from) <= 0 && compareInstant(until, interval.until) <= 0,
      )))
  );
}

export const Task = "volunteer.Task";

export const complete = "volunteer.complete";

/* Venue references require the caller's current CanRent booking read entitlement;
 * imports never grant booking access. Verified ReservationChanged consumption and
 * current dispatch reads are proposed unimplemented contracts, not atomic writes
 * across booking/volunteer authorities. No booking is reserved by Volunteer.
 * Activity cancellation and rescheduling preserve participant/task history.
 */
const activitiesPageDescriptor = {
  owner: "volunteer",
  path: "/volunteering",
  title: message("Volunteer activities", { nl: "Vrijwilligersactiviteiten" }),
  description: message("Discover activities and follow only your own assignments.", {
    nl: "Ontdek activiteiten en volg alleen je eigen opdrachten.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    return {};
  },
  render: activitiesPage,
};

const workPageDescriptor = {
  owner: "volunteer",
  path: "/volunteering/work",
  title: message("Volunteer coordination", { nl: "Vrijwilligerscoördinatie" }),
  description: message("Coordinate confirmed participants and entered attendance.", {
    nl: "Coördineer bevestigde deelnemers en ingevoerde aanwezigheid.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "volunteer.organizer"), "forbidden");
    return {};
  },
  render: workPage,
};

export const appDefinition = {
  id: "CanVolunteer",
  uses: ["volunteer"],
  description: message(
    "Optionally help workspace community teams organize member volunteers for mentoring sessions, community events, and charity activities.",
    {
      nl: "Help werkplekcommunityteams desgewenst vrijwilligers te organiseren voor mentorsessies, communityevenementen en liefdadigheidsactiviteiten.",
    },
  ),
  packages: {
    volunteer: {
      label: message("Volunteering", { nl: "Vrijwilligerswerk" }),
      description: message(
        "Reserve community volunteer places and record attributable tasks and attendance.",
        {
          nl: "Reserveer vrijwilligersplaatsen en registreer toegeschreven taken en aanwezigheid.",
        },
      ),
      roles: {
        organizer: {
          id: "volunteer.organizer",
          label: message("Organizer", { nl: "Organisator" }),
        },
      },
    },
  },
  bindings: { "volunteer.Mail": { capability: "std.EmailV1", from: "deployment.mail" } },
  models: {
    "volunteer.Community": {
      label: message("Community", { nl: "Community" }),
      readGrants: [{ rule: "Community.read.1" }],
      fields: { name: { type: "text", unique: true } },
    },
    "volunteer.Opportunity": {
      parent: "volunteer.Community",
      label: message("Volunteer activity", { nl: "Vrijwilligersactiviteit" }),
      readGrants: [
        {
          rule: "Opportunity.read.1",
          fields: [
            "location",
            "title",
            "description",
            "requirements",
            "contact",
            "timezone",
            "from",
            "until",
            "capacity",
          ],
        },
        { rule: "Opportunity.read.2" },
      ],
      invariants: ["Opportunity.require.1"],
      derived: {
        venue_confirmed: {
          type: "bool",
          handler: "Opportunity.venue_confirmed",
          label: message("Venue confirmed", { nl: "Locatie bevestigd" }),
        },
        remaining: {
          type: "int",
          handler: "Opportunity.remaining",
          label: message("Remaining places", { nl: "Resterende plaatsen" }),
        },
      },
      fields: {
        location: { type: Location },
        title: { type: "text" },
        description: { type: "text" },
        requirements: {
          type: "text",
          label: message("Activity requirements", { nl: "Activiteitsvereisten" }),
        },
        contact: { type: "email", label: message("Organizer email", { nl: "E-mail organisator" }) },
        timezone: { type: "timezone" },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: { type: "datetime", label: message("Until", { nl: "Tot" }) },
        capacity: { type: "int", min: 1n, label: message("Capacity", { nl: "Capaciteit" }) },
        venue: {
          type: Booking,
          nullable: true,
          label: message("Venue reservation", { nl: "Locatiereservering" }),
        },
        open: { type: "bool", default: false, label: message("Open", { nl: "Open" }) },
        cancelled: { type: "bool", default: false, label: cancelled },
      },
    },
    "volunteer.Signup": {
      parent: "volunteer.Opportunity",
      label: message("Volunteer signup", { nl: "Vrijwilligersinschrijving" }),
      readGrants: [{ rule: "Signup.read.1" }, { rule: "Signup.read.2" }],
      unique: [{ fields: ["account"] }],
      fields: {
        account: {
          type: "user",
          server: "actor",
          label: message("User account", { nl: "Gebruikersaccount" }),
        },
        email: { type: "email" },
        needs_confirmation: {
          type: "bool",
          default: false,
          label: message("Reconfirmation required", { nl: "Herbevestiging vereist" }),
        },
        state: {
          type: "enum",
          cases: ["registered", "confirmed", "withdrawn", "cancelled", "attended", "no_show"],
          default: "registered",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              cancelled,
              registered: message("Registered", { nl: "Ingeschreven" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              withdrawn: message("Withdrawn", { nl: "Ingetrokken" }),
              attended,
              no_show: message("No-show", { nl: "Niet verschenen" }),
            },
          },
        },
      },
    },
    [Task]: {
      parent: "volunteer.Signup",
      exported: true,
      label: message("Volunteer task", { nl: "Vrijwilligerstaak" }),
      readGrants: [{ rule: "Task.read.1" }, { rule: "Task.read.2" }],
      fields: {
        title: { type: "text" },
        done: { type: "bool", default: false },
        completed_by: {
          type: "user",
          nullable: true,
          label: message("Completed by", { nl: "Afgerond door" }),
        },
        completed_at: {
          type: "datetime",
          nullable: true,
          label: message("Completed at", { nl: "Afgerond op" }),
        },
      },
    },
  },
  contracts: {
    "volunteer.Availability": {
      label: message("Available volunteer places", { nl: "Beschikbare vrijwilligersplaatsen" }),
      fields: { remaining: { type: "int" } },
    },
    "volunteer.WorkItem": {
      exported: true,
      label: message("Authorized work item", { nl: "Toegestaan werkitem" }),
      fields: {
        reference: { type: "text" },
        revision: { type: "int" },
        location: { type: "text", nullable: true },
        title: { type: "text" },
        detail: { type: "text", nullable: true },
        due: { type: "datetime", nullable: true },
        action: { type: "action", targets: ["volunteer.complete"] },
      },
    },
    "volunteer.WorkBatch": {
      exported: true,
      label: message("Authorized work batch", { nl: "Toegestane werkverzameling" }),
      fields: {
        items: { type: "volunteer.WorkItem", array: true, requiredArray: true, max: 500n },
      },
    },
  },
  events: {
    "volunteer.Reminder": {
      fields: {
        signup: { type: "volunteer.Signup" },
        revision: { type: "int" },
        opportunity_revision: { type: "int" },
      },
    },
  },
  pure: {
    "volunteer.venue_covers": {
      handler: "venue_covers",
      inputs: {
        venue: { type: Booking },
        location: { type: Location },
        from: { type: "datetime" },
        until: { type: "datetime" },
      },
      result: "bool",
    },
  },
  preferences: {
    volunteer: {
      fields: {
        location: { type: Location, nullable: true, default: null },
        view: {
          type: "enum",
          cases: ["discovery", "assignments"],
          default: "discovery",
          label: {
            text: message("Initial view", { nl: "Beginweergave" }),
            values: {
              discovery: message("Discover activities", { nl: "Activiteiten ontdekken" }),
              assignments: message("My assignments", { nl: "Mijn opdrachten" }),
            },
          },
        },
      },
    },
  },
  operations: {
    "volunteer.Community.create": {
      handler: "createCommunity",
      kind: "create",
      model: "volunteer.Community",
      by: "volunteer.organizer",
      read: false,
      inputs: { fields: ["name"] },
    },
    "volunteer.Community.update": {
      handler: "updateCommunity",
      kind: "update",
      model: "volunteer.Community",
      by: "volunteer.organizer",
      read: false,
      inputs: { record: { type: "volunteer.Community" }, changes: { fields: ["name"] } },
    },
    "volunteer.Community.delete": {
      handler: "deleteCommunity",
      kind: "delete",
      model: "volunteer.Community",
      by: "volunteer.organizer",
      read: false,
      mode: "archive",
      inputs: { record: { type: "volunteer.Community" } },
    },
    "volunteer.availability": {
      handler: "availability",
      read: true,
      scope: "authority",
      by: "public",
      result: "volunteer.Availability",
      inputs: { opportunity: { type: "volunteer.Opportunity" } },
      description: message(
        "Publish an aggregate place count without granting participant records.",
        { nl: "Toon een geaggregeerd aantal plaatsen zonder toegang tot deelnemersgegevens." },
      ),
    },
    "volunteer.reactivate": {
      read: false,
      handler: "reactivate",
      by: "authenticated",
      inputs: { signup: { type: "volunteer.Signup" } },
      label: message("Register again", { nl: "Opnieuw inschrijven" }),
      description: message(
        "Reuse your withdrawn signup without consuming a second place or losing its history.",
        {
          nl: "Hergebruik je ingetrokken inschrijving zonder een tweede plaats te bezetten of geschiedenis te verliezen.",
        },
      ),
    },
    "volunteer.reconfirm": {
      read: false,
      handler: "reconfirm",
      by: "authenticated",
      inputs: { signup: { type: "volunteer.Signup" } },
      label: message("Accept changed activity", { nl: "Gewijzigde activiteit aanvaarden" }),
      description: message("Accept the changed activity interval before organizer confirmation.", {
        nl: "Aanvaard het gewijzigde activiteitstijdvak vóór bevestiging door de organisator.",
      }),
    },
    "volunteer.link_venue": {
      read: false,
      handler: "link_venue",
      by: "volunteer.organizer",
      inputs: { opportunity: { type: "volunteer.Opportunity" }, venue: { type: Booking } },
      label: message("Link venue reservation", { nl: "Locatiereservering koppelen" }),
      description: message(
        "Link an already entitled canonical rental; this operation never reserves its venue.",
        {
          nl: "Koppel een canonieke huurreservering met geldig recht; deze operatie reserveert zelf geen locatie.",
        },
      ),
    },
    "volunteer.reschedule": {
      read: false,
      handler: "reschedule",
      by: "volunteer.organizer",
      inputs: {
        opportunity: { type: "volunteer.Opportunity" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        timezone: { type: "timezone" },
        venue: { type: Booking, nullable: true },
        reason: { type: "text" },
      },
      label: message("Reschedule activity", { nl: "Activiteit verplaatsen" }),
      description: message(
        "Move only after conflict and venue checks; retain reserved places pending volunteer consent.",
        {
          nl: "Verplaats alleen na conflict- en locatiecontrole; behoud gereserveerde plaatsen in afwachting van instemming.",
        },
      ),
    },
    "volunteer.work": {
      handler: "work",
      exported: true,
      read: true,
      scope: "authority",
      by: "authenticated",
      result: "volunteer.WorkBatch",
      inputs: { locations: { type: "text", array: true } },
      description: message(
        "Return only current eligible work under the canonical completion authority.",
        {
          nl: "Geef alleen actueel uitvoerbaar werk terug binnen de canonieke afrondingsbevoegdheid.",
        },
      ),
    },
    "volunteer.work_detail": {
      handler: "work_detail",
      exported: true,
      read: true,
      scope: "authority",
      by: "authenticated",
      result: "volunteer.WorkItem",
      inputs: { record: { type: "volunteer.Task" } },
      description: message(
        "Revalidate the selected item before presenting its protected canonical action.",
        {
          nl: "Controleer het gekozen item opnieuw voordat de beschermde canonieke actie wordt getoond.",
        },
      ),
    },
    "volunteer.Opportunity.create": {
      handler: "createOpportunity",
      kind: "create",
      model: "volunteer.Opportunity",
      by: "volunteer.organizer",
      read: false,
      inputs: {
        parent: { type: "volunteer.Community" },
        fields: [
          "location",
          "title",
          "description",
          "requirements",
          "contact",
          "timezone",
          "from",
          "until",
          "capacity",
          "venue",
        ],
      },
      when: "Opportunity",
    },
    "volunteer.Opportunity.update": {
      handler: "updateOpportunity",
      kind: "update",
      model: "volunteer.Opportunity",
      by: "volunteer.organizer",
      read: false,
      inputs: {
        record: { type: "volunteer.Opportunity" },
        changes: { fields: ["title", "description", "requirements", "contact"] },
      },
      when: "Opportunity",
    },
    "volunteer.Task.create": {
      handler: "createTask",
      kind: "create",
      model: Task,
      by: "volunteer.organizer",
      read: false,
      inputs: { parent: { type: "volunteer.Signup" }, fields: ["title"] },
      when: "Task",
    },
    "volunteer.Task.update": {
      handler: "updateTask",
      kind: "update",
      model: Task,
      by: "volunteer.organizer",
      read: false,
      inputs: { record: { type: Task }, changes: { fields: ["title"] } },
      when: "Task",
    },
    "volunteer.publish": {
      read: false,
      handler: "publish",
      by: "volunteer.organizer",
      inputs: { opportunity: { type: "volunteer.Opportunity" } },
      description: message(
        "Publish only an opportunity with any required rentable venue already confirmed.",
        {
          nl: "Publiceer een activiteit pas wanneer een eventueel vereiste verhuurbare locatie al bevestigd is.",
        },
      ),
    },
    "volunteer.signup": {
      read: false,
      handler: "signup",
      by: "authenticated",
      inputs: { opportunity: { type: "volunteer.Opportunity" } },
      label: message("Sign up for activity", { nl: "Inschrijven voor activiteit" }),
      description: message(
        "Reserve one place and reject overlapping active community assignments.",
        { nl: "Reserveer één plaats en weiger overlappende actieve communityopdrachten." },
      ),
    },
    "volunteer.confirm": {
      read: false,
      handler: "confirm",
      by: "volunteer.organizer",
      inputs: { signup: { type: "volunteer.Signup" } },
      label: message("Confirm signup", { nl: "Inschrijving bevestigen" }),
      description: message("Confirm a recorded place and arm only a future reminder.", {
        nl: "Bevestig een vastgelegde plaats en plan alleen een toekomstige herinnering.",
      }),
    },
    "volunteer.withdraw": {
      read: false,
      handler: "withdraw",
      by: "authenticated",
      inputs: { signup: { type: "volunteer.Signup" } },
      label: message("Withdraw signup", { nl: "Inschrijving intrekken" }),
      description: message("Withdraw your place once and cancel its pending notification.", {
        nl: "Trek je plaats eenmalig in en annuleer de wachtende melding.",
      }),
    },
    "volunteer.complete": {
      read: false,
      handler: "complete",
      exported: true,
      by: "authenticated",
      inputs: { task: { type: Task } },
      description: message("Complete only a task in your own currently confirmed assignment.", {
        nl: "Rond alleen een taak binnen je eigen momenteel bevestigde opdracht af.",
      }),
    },
    "volunteer.attendance": {
      read: false,
      handler: "attendance",
      by: "volunteer.organizer",
      inputs: { signup: { type: "volunteer.Signup" }, attend: { type: "bool", label: attended } },
      label: message("Record attendance", { nl: "Aanwezigheid vastleggen" }),
      description: message("Record attendance manually after the activity begins.", {
        nl: "Leg aanwezigheid handmatig vast nadat de activiteit begint.",
      }),
    },
    "volunteer.cancel": {
      read: false,
      handler: "cancel",
      by: "volunteer.organizer",
      inputs: { opportunity: { type: "volunteer.Opportunity" }, reason: { type: "text" } },
      description: message("Cancel opportunities while preserving signup and task evidence.", {
        nl: "Annuleer activiteiten en behoud inschrijvings- en taakbewijs.",
      }),
    },
  },
  handlers: {
    "volunteer.opportunity_changed": {
      handler: "opportunity_changed",
      on: "volunteer.Opportunity.update",
    },
    "volunteer.venue_changed": {
      handler: "venue_changed",
      on: "rent_reservations.ReservationChanged",
    },
    "volunteer.remind": { handler: "remind", on: "volunteer.Reminder" },
  },
  pages: [
    activitiesPageDescriptor,
    workPageDescriptor,
  ],
  disabled: ["volunteer.Opportunity.delete", "volunteer.Task.delete"],
};

export function canApp() {
  const crudWhen = {
    Opportunity: async (c, row) => (await can_work(c, c.actor, row.location)) && !row.open,
    Task: async (c, row) =>
      (await can_work(c, c.actor, row.parent.parent.location)) &&
      ["registered", "confirmed"].includes(row.parent.state),
  };
  return {
    venue_covers,
    derives: {
      "Opportunity.venue_confirmed": async (c, row) =>
        row.venue !== null && (await venue_covers(c, row.venue, row.location, row.from, row.until)),
      "Opportunity.remaining": async (c, row) =>
        int64(
          row.capacity -
            (await count(
              records(c, "volunteer.Signup", {
                parent: row,
                where: (signup) => activeStates.includes(signup.state),
              }),
            )),
        ),
    },
    read: {
      "Community.read.1": (c, row) => hasRole(c, "volunteer.organizer"),
      "Opportunity.read.1": (c, row) => hasRole(c, "public") && row.open && !row.cancelled,
      "Opportunity.read.2": async (c, row) =>
        hasRole(c, "volunteer.organizer") && (await can_work(c, c.actor, row.location)),
      "Signup.read.1": async (c, row) =>
        hasRole(c, "volunteer.organizer") && (await can_work(c, c.actor, row.parent.location)),
      "Signup.read.2": (c, row) => hasRole(c, "authenticated") && same(row.account, c.actor),
      "Task.read.1": async (c, row) =>
        hasRole(c, "volunteer.organizer") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Task.read.2": (c, row) => hasRole(c, "authenticated") && same(row.parent.account, c.actor),
    },
    invariants: {
      "Opportunity.require.1": async (c, row) =>
        compareInstant(row.from, row.until) < 0 &&
        (await count(
          records(c, "volunteer.Signup", {
            parent: row,
            where: (s) => activeStates.includes(s.state),
          }),
        )) <= row.capacity,
    },
    crudWhen,
    async opportunity_changed(c, { event }) {
      for await (const signup of records(c, "volunteer.Signup", {
        parent: event.after,
        where: (row) => row.state === "confirmed",
        limit: 500n,
      })) {
        await cancel(c, signup.id);
        if (
          !event.after.cancelled &&
          compareInstant(event.after.from, addDuration(c.now, 86400000n)) > 0
        )
          await schedule(
            c,
            signup.id,
            subtractDuration(event.after.from, 86400000n),
            "volunteer.Reminder",
            { signup, revision: signup.version, opportunity_revision: event.after.version },
          );
      }
    },
    async createCommunity(c, input) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      await create(c, "volunteer.Community", input);
    },
    async updateCommunity(c, { record, changes }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      await set(c, record, changes);
    },
    async deleteCommunity(c, { record }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      await deleteRecord(c, record, { mode: "archive" });
    },
    async createOpportunity(c, input) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      await create(c, "volunteer.Opportunity", input, { when: crudWhen.Opportunity });
    },
    async updateOpportunity(c, { record, changes }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Opportunity });
    },
    async createTask(c, input) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      await create(c, Task, input, { when: crudWhen.Task });
    },
    async updateTask(c, { record, changes }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Task });
    },
    async publish(c, { opportunity }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      check(
        (await can_work(c, c.actor, opportunity.location)) &&
          !opportunity.cancelled &&
          compareInstant(opportunity.from, c.now) > 0 &&
          (opportunity.venue === null || opportunity.venue_confirmed),
      );
      await set(c, opportunity, { open: true });
      for await (const signup of records(c, "volunteer.Signup", {
        parent: opportunity,
        where: (row) => row.state === "confirmed",
        limit: 500n,
      })) {
        await cancel(c, signup.id);
        if (compareInstant(opportunity.from, addDuration(c.now, 86400000n)) > 0)
          await schedule(
            c,
            signup.id,
            subtractDuration(opportunity.from, 86400000n),
            "volunteer.Reminder",
            {
              signup,
              revision: signup.version,
              opportunity_revision: int64(opportunity.version + 1n),
            },
          );
      }
    },
    async signup(c, { opportunity }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        opportunity.open &&
          !opportunity.cancelled &&
          compareInstant(opportunity.from, c.now) > 0 &&
          (opportunity.venue === null || opportunity.venue_confirmed),
      );
      check(
        !(await any(
          records(c, "volunteer.Signup"),
          (signup) =>
            same(signup.parent.parent, opportunity.parent) &&
            same(signup.account, c.actor) &&
            activeStates.includes(signup.state) &&
            overlaps(signup.parent.from, signup.parent.until, opportunity.from, opportunity.until),
        )),
      );
      await create(c, "volunteer.Signup", {
        parent: opportunity,
        email: c.actor.email,
        account: c.actor,
      });
    },
    async confirm(c, { signup }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      check(
        (await can_work(c, c.actor, signup.parent.location)) &&
          signup.state === "registered" &&
          !signup.needs_confirmation &&
          signup.parent.open &&
          !signup.parent.cancelled &&
          compareInstant(signup.parent.from, c.now) > 0 &&
          (signup.parent.venue === null || signup.parent.venue_confirmed),
      );
      await set(c, signup, { state: "confirmed" });
      if (compareInstant(signup.parent.from, addDuration(c.now, 86400000n)) > 0)
        await schedule(
          c,
          signup.id,
          subtractDuration(signup.parent.from, 86400000n),
          "volunteer.Reminder",
          {
            signup,
            revision: int64(signup.version + 1n),
            opportunity_revision: signup.parent.version,
          },
        );
    },
    async withdraw(c, { signup }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(same(signup.account, c.actor) && activeStates.includes(signup.state));
      await set(c, signup, { state: "withdrawn" });
      await cancel(c, signup.id);
    },
    async complete(c, { task }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(task.parent.account, c.actor) &&
          task.parent.state === "confirmed" &&
          !task.parent.parent.cancelled &&
          (task.parent.parent.venue === null || task.parent.parent.venue_confirmed) &&
          !task.done,
      );
      await set(c, task, { done: true, completed_by: c.actor, completed_at: c.now });
    },
    async attendance(c, { signup, attend }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      check(
        (await can_work(c, c.actor, signup.parent.location)) &&
          signup.state === "confirmed" &&
          !signup.parent.cancelled &&
          compareInstant(c.now, signup.parent.from) >= 0,
      );
      await set(c, signup, { state: attend ? "attended" : "no_show" });
    },
    async availability(c, { opportunity }) {
      check(hasRole(c, "public"), "forbidden");
      check(opportunity.open && !opportunity.cancelled);
      return {
        remaining: int64(
          opportunity.capacity -
            (await count(
              records(c, "volunteer.Signup", {
                parent: opportunity,
                where: (signup) => activeStates.includes(signup.state),
              }),
            )),
        ),
      };
    },
    async reactivate(c, { signup }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(signup.account, c.actor) &&
          signup.state === "withdrawn" &&
          signup.parent.open &&
          !signup.parent.cancelled &&
          compareInstant(signup.parent.from, c.now) > 0 &&
          (signup.parent.venue === null || signup.parent.venue_confirmed),
      );
      check(
        !(await any(
          records(c, "volunteer.Signup"),
          (other) =>
            !same(other, signup) &&
            same(other.parent.parent, signup.parent.parent) &&
            same(other.account, c.actor) &&
            activeStates.includes(other.state) &&
            overlaps(
              other.parent.from,
              other.parent.until,
              signup.parent.from,
              signup.parent.until,
            ),
        )),
      );
      await set(c, signup, {
        state: "registered",
        email: c.actor.email,
        needs_confirmation: false,
      });
    },
    async reconfirm(c, { signup }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(signup.account, c.actor) &&
          signup.state === "registered" &&
          signup.needs_confirmation &&
          signup.parent.open &&
          !signup.parent.cancelled &&
          compareInstant(signup.parent.from, c.now) > 0 &&
          (signup.parent.venue === null || signup.parent.venue_confirmed),
      );
      check(
        !(await any(
          records(c, "volunteer.Signup"),
          (other) =>
            !same(other, signup) &&
            same(other.parent.parent, signup.parent.parent) &&
            same(other.account, c.actor) &&
            activeStates.includes(other.state) &&
            overlaps(
              other.parent.from,
              other.parent.until,
              signup.parent.from,
              signup.parent.until,
            ),
        )),
      );
      await set(c, signup, { needs_confirmation: false });
    },
    async link_venue(c, { opportunity, venue }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      check(
        (await can_work(c, c.actor, opportunity.location)) &&
          !opportunity.cancelled &&
          compareInstant(opportunity.from, c.now) > 0 &&
          (await venue_covers(c, venue, opportunity.location, opportunity.from, opportunity.until)),
      );
      await set(c, opportunity, { venue });
      for await (const signup of records(c, "volunteer.Signup", {
        parent: opportunity,
        where: (row) => row.state === "confirmed",
        limit: 500n,
      })) {
        await cancel(c, signup.id);
        if (compareInstant(opportunity.from, addDuration(c.now, 86400000n)) > 0)
          await schedule(
            c,
            signup.id,
            subtractDuration(opportunity.from, 86400000n),
            "volunteer.Reminder",
            {
              signup,
              revision: signup.version,
              opportunity_revision: int64(opportunity.version + 1n),
            },
          );
      }
    },
    async reschedule(c, { opportunity, from, until, timezone, venue, reason }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      check(
        (await can_work(c, c.actor, opportunity.location)) &&
          !opportunity.cancelled &&
          compareInstant(c.now, from) < 0 &&
          compareInstant(from, until) < 0 &&
          reason.trim() !== "",
      );
      check(
        compareInstant(opportunity.from, from) !== 0 ||
          compareInstant(opportunity.until, until) !== 0 ||
          opportunity.timezone !== timezone,
      );
      check(
        (opportunity.venue === null || venue !== null) &&
          (venue === null || (await venue_covers(c, venue, opportunity.location, from, until))),
      );
      check(
        await all(
          records(c, "volunteer.Signup", { parent: opportunity }),
          async (signup) =>
            !activeStates.includes(signup.state) ||
            !(await any(
              records(c, "volunteer.Signup"),
              (other) =>
                !same(other.parent, opportunity) &&
                same(other.parent.parent, opportunity.parent) &&
                same(other.account, signup.account) &&
                activeStates.includes(other.state) &&
                overlaps(other.parent.from, other.parent.until, from, until),
            )),
        ),
      );
      await set(c, opportunity, { from, until, timezone, venue });
      for await (const signup of records(c, "volunteer.Signup", {
        parent: opportunity,
        where: (row) => activeStates.includes(row.state),
        limit: 500n,
      })) {
        const was_confirmed = signup.state === "confirmed";
        await set(c, signup, { state: "registered", needs_confirmation: true });
        await cancel(c, signup.id);
        const signup_revision = int64(signup.version + 1n),
          opportunity_revision = int64(opportunity.version + 1n);
        if (was_confirmed)
          await send(
            c,
            "volunteer.Mail.send",
            {
              to: signup.email,
              subject: format(
                c,
                message("Volunteer activity rescheduled", {
                  nl: "Vrijwilligersactiviteit verplaatst",
                }),
                { locale: null },
              ),
              body: reason,
            },
            {
              when: () =>
                signup.version === signup_revision &&
                signup.parent.version === opportunity_revision &&
                signup.needs_confirmation &&
                !signup.parent.cancelled,
            },
          );
      }
    },
    async venue_changed(c, { event }) {
      check(event.booking.version === event.revision);
      for await (const opportunity of records(c, "volunteer.Opportunity", {
        where: async (item) =>
          same(item.venue, event.booking) && item.open && !item.cancelled && !item.venue_confirmed,
        limit: 100n,
      })) {
        await set(c, opportunity, { open: false });
        for await (const signup of records(c, "volunteer.Signup", {
          parent: opportunity,
          where: (row) => activeStates.includes(row.state),
          limit: 500n,
        })) {
          const was_confirmed = signup.state === "confirmed";
          await set(c, signup, { state: "registered", needs_confirmation: true });
          await cancel(c, signup.id);
          const signup_revision = int64(signup.version + 1n),
            opportunity_revision = int64(opportunity.version + 1n);
          if (was_confirmed)
            await send(
              c,
              "volunteer.Mail.send",
              {
                to: signup.email,
                subject: format(
                  c,
                  message("Volunteer venue unavailable", {
                    nl: "Vrijwilligerslocatie niet beschikbaar",
                  }),
                  { locale: null },
                ),
                body: opportunity.title,
              },
              {
                when: () =>
                  signup.version === signup_revision &&
                  signup.parent.version === opportunity_revision &&
                  !signup.parent.open &&
                  !signup.parent.cancelled,
              },
            );
        }
      }
    },
    async cancel(c, { opportunity, reason }) {
      check(hasRole(c, "volunteer.organizer"), "forbidden");
      check(
        (await can_work(c, c.actor, opportunity.location)) &&
          !opportunity.cancelled &&
          reason.trim() !== "",
      );
      await set(c, opportunity, { cancelled: true, open: false });
      for await (const signup of records(c, "volunteer.Signup", {
        parent: opportunity,
        where: (row) => activeStates.includes(row.state),
        limit: 500n,
      })) {
        await set(c, signup, { state: "cancelled" });
        await cancel(c, signup.id);
        const signup_revision = int64(signup.version + 1n),
          opportunity_revision = int64(opportunity.version + 1n);
        await send(
          c,
          "volunteer.Mail.send",
          {
            to: signup.email,
            subject: format(
              c,
              message("Volunteer activity cancelled", {
                nl: "Vrijwilligersactiviteit geannuleerd",
              }),
              { locale: null },
            ),
            body: reason,
          },
          {
            when: () =>
              signup.version === signup_revision &&
              signup.parent.version === opportunity_revision &&
              signup.state === "cancelled" &&
              signup.parent.cancelled,
          },
        );
      }
    },
    async remind(c, { event }) {
      check(
        event.signup.state === "confirmed" &&
          event.signup.version === event.revision &&
          event.signup.parent.version === event.opportunity_revision &&
          !event.signup.parent.cancelled &&
          (event.signup.parent.venue === null || event.signup.parent.venue_confirmed),
      );
      await send(
        c,
        "volunteer.Mail.send",
        {
          to: event.signup.email,
          subject: format(
            c,
            message("Volunteer reminder", { nl: "Herinnering vrijwilligersactiviteit" }),
            { locale: null },
          ),
          body: event.signup.parent.description,
        },
        {
          when: async () =>
            event.signup.state === "confirmed" &&
            event.signup.version === event.revision &&
            event.signup.parent.version === event.opportunity_revision &&
            !event.signup.parent.cancelled &&
            (event.signup.parent.venue === null || event.signup.parent.venue_confirmed),
        },
      );
    },
    async work(c, { locations }) {
      check(hasRole(c, "authenticated"), "forbidden");
      const items = [];
      for await (const item of records(c, "volunteer.Task", {
        where: async (item) =>
          same(item.parent.account, c.actor) &&
          item.parent.state === "confirmed" &&
          !item.parent.parent.cancelled &&
          (item.parent.parent.venue === null || item.parent.parent.venue_confirmed) &&
          !item.done &&
          ((await count(locations)) === 0n || locations.includes(item.parent.parent.location.id)),
      }))
        items.push({
          reference: item.id,
          revision: item.version,
          location: item.parent.parent.location.id,
          title: item.title,
          detail: item.parent.parent.title,
          due: item.parent.parent.from,
          action: action(c, "volunteer.complete", { task: item }),
        });
      return { items };
    },
    async work_detail(c, { record }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(record.parent.account, c.actor) &&
          record.parent.state === "confirmed" &&
          !record.parent.parent.cancelled &&
          (record.parent.parent.venue === null || record.parent.parent.venue_confirmed) &&
          !record.done,
      );
      return {
        reference: record.id,
        revision: record.version,
        location: record.parent.parent.location.id,
        title: record.title,
        detail: record.parent.parent.title,
        due: record.parent.parent.from,
        action: action(c, "volunteer.complete", { task: record }),
      };
    },
  };
}

export async function activitiesPage(c, bindings) {
  return renderPage(
    c,
    activitiesPageDescriptor,
    () => [
      tabs({
        context: c,
        selector: "volunteer.preferences.view",
        value: c.preferences.volunteer.view,
        children: [
          tab({
            context: c,
            value: "discovery",
            children: [
              card({
                context: c,
                title: message("Published volunteer activities", {
                  nl: "Gepubliceerde vrijwilligersactiviteiten",
                }),
                children: [
                  list({
                    context: c,
                    model: "volunteer.Opportunity",
                    filter: ["location"],
                    defaults: { location: c.preferences.volunteer.location },
                    order: ["from"],
                    renderRow: (opportunity, v) => [
                      text({
                        context: v,
                        values: [
                          opportunity.description,
                          opportunity.requirements,
                          opportunity.from,
                          opportunity.until,
                          opportunity.capacity,
                        ],
                      }),
                      form({
                        context: v,
                        operation: "volunteer.availability",
                        arguments: { opportunity },
                        renderResult: (result, scope) => [
                          metrics({ context: scope, result, fields: ["remaining"] }),
                        ],
                      }),
                      actions({
                        context: v,
                        operations: ["volunteer.signup"],
                        boundArgs: { opportunity },
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          ...(hasRole(c, "authenticated")
            ? [
                tab({
                  context: c,
                  value: "assignments",
                  children: [
                    card({
                      context: c,
                      title: message("Your signups and assigned tasks", {
                        nl: "Jouw inschrijvingen en toegewezen taken",
                      }),
                      children: [
                        list({
                          context: c,
                          model: "volunteer.Signup",
                          display: "split",
                          renderRow: (signup, v) => [
                            text({ context: v, values: [signup.state, signup.needs_confirmation] }),
                            actions({
                              context: v,
                              operations: [
                                "volunteer.withdraw",
                                "volunteer.reactivate",
                                "volunteer.reconfirm",
                              ],
                              boundArgs: { signup },
                            }),
                            list({
                              context: v,
                              model: Task,
                              parent: signup,
                              renderRow: (task, tv) => [
                                text({
                                  context: tv,
                                  values: [task.title, task.done, task.completed_by, task.completed_at],
                                }),
                                actions({
                                  context: tv,
                                  operations: ["volunteer.complete"],
                                  boundArgs: { task },
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                })
              ]
            : []),
        ],
      }),
    ],
  );
}

export async function workPage(c, bindings) {
  return renderPage(
    c,
    workPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Opportunity authoring", { nl: "Activiteiten opstellen" }),
        children: [
          form({ context: c, operation: "volunteer.Community.create" }),
          list({
            context: c,
            model: "volunteer.Community",
            renderRow: (community, scope) => [
              form({
                context: scope,
                operation: "volunteer.Opportunity.create",
                arguments: { parent: community },
              }),
            ],
          }),
          list({
            context: c,
            model: "volunteer.Opportunity",
            filter: ["location"],
            defaults: { location: c.preferences.volunteer.location },
            order: ["from"],
            display: "split",
            renderRow: (opportunity, v) => [
              edit({ context: v, operation: "volunteer.Opportunity.update", record: opportunity }),
              text({
                context: v,
                values: [opportunity.venue, opportunity.venue_confirmed, opportunity.remaining],
              }),
              form({ context: v, operation: "volunteer.link_venue", arguments: { opportunity } }),
              form({ context: v, operation: "volunteer.reschedule", arguments: { opportunity } }),
              actions({
                context: v,
                operations: ["volunteer.publish", "volunteer.cancel"],
                boundArgs: { opportunity },
              }),
              card({
                context: v,
                title: message("Participants and attendance", { nl: "Deelnemers en aanwezigheid" }),
                children: [
                  list({
                    context: v,
                    model: "volunteer.Signup",
                    parent: opportunity,
                    renderRow: (signup, sv) => [
                      text({
                        context: sv,
                        values: [signup.email, signup.state, signup.needs_confirmation],
                      }),
                      actions({
                        context: sv,
                        operations: ["volunteer.confirm", "volunteer.attendance"],
                        boundArgs: { signup },
                      }),
                      card({
                        context: sv,
                        title: message("Task assignments", { nl: "Taaktoewijzingen" }),
                        children: [
                          form({
                            context: sv,
                            operation: "volunteer.Task.create",
                            arguments: { parent: signup },
                          }),
                        ],
                      }),
                      history({ context: sv, record: signup }),
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
  const community = {
    model: "volunteer.Community",
    dependencies: [],
    value: async (c, s) => ({ name: "Community" }),
  };
  const mentoring = {
    model: "volunteer.Opportunity",
    dependencies: [community, test_site],
    value: async (c, s) => ({
      parent: s.community,
      location: s.test_site,
      title: "Mentor",
      description: "Community session",
      requirements: "Experience",
      contact: "organizer@example.test",
      timezone: "Europe/Brussels",
      from: datetime("2099-01-02T09:00:00Z"),
      until: datetime("2099-01-02T10:00:00Z"),
      capacity: 1n,
      open: true,
    }),
  };
  const place = {
    model: "volunteer.Signup",
    dependencies: [mentoring],
    value: async (c, s) => ({
      parent: s.mentoring,
      account: s.self,
      email: "volunteer@example.test",
      state: "confirmed",
    }),
  };
  return {
    community,
    mentoring,
    place,
    examples: [
      {
        operation: "volunteer.withdraw",
        dependencies: [place],
        inputs: async (c, s) => ({ signup: s.place }),
        selectors: ["as", "signup.state"],
        observations: [async (c, s) => s.signup.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "confirmed"],
            expected: async (c, s) => ["withdrawn"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "withdrawn"],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["public", "confirmed"], error: "forbidden" },
        ],
      },
      {
        operation: "volunteer.reactivate",
        dependencies: [place],
        inputs: async (c, s) => ({ signup: s.place }),
        selectors: ["as", "signup.account", "signup.state"],
        observations: [
          async (c, s) => s.signup.state,
          async (c, s) => await count(records(c, "volunteer.Signup", { parent: s.mentoring })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, "withdrawn"],
            expected: async (c, s) => ["registered", 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, "withdrawn"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, "confirmed"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "volunteer.reconfirm",
        dependencies: [place],
        inputs: async (c, s) => ({ signup: s.place }),
        selectors: ["as", "signup.account", "signup.state", "signup.needs_confirmation"],
        observations: [async (c, s) => s.signup.needs_confirmation],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, "registered", true],
            expected: async (c, s) => [false],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, "registered", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, "registered", false],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "volunteer.reschedule",
        seed: [place, test_worker],
        dependencies: [mentoring],
        inputs: async (c, s) => ({
          opportunity: s.mentoring,
          from: datetime("2099-01-03T09:00:00Z"),
          until: datetime("2099-01-03T10:00:00Z"),
          timezone: "Europe/Brussels",
          venue: null,
          reason: "New activity date",
        }),
        selectors: ["as", "opportunity.cancelled"],
        observations: [
          async (c, s) => s.opportunity.from,
          async (c, s) => s.place.state,
          async (c, s) => s.place.needs_confirmation,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["volunteer.organizer", false],
            expected: async (c, s) => [datetime("2099-01-03T09:00:00Z"), "registered", true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["volunteer.organizer", true],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["members", false], error: "forbidden" },
        ],
      },
    ],
  };
}
