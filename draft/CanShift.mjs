import {
  active_member,
  delivery,
  EmailV1,
  flatten,
  format,
  send,
  addDuration,
  all,
  any,
  bounded,
  require as check,
  collect,
  compareInstant,
  count,
  create,
  date,
  datetime,
  emit,
  first,
  hasRole,
  int64,
  OperationOutcome,
  overlaps,
  records,
  same,
  set,
  subtractDuration,
} from "@canlang/stdlib";
import {
  actions,
  calendar,
  card,
  edit,
  form,
  history,
  list,
  message,
  renderPage,
  table,
  text,
} from "@canlang/ui";
import { can_work, Employee, EmployeeChanged } from "./employee.mjs";
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

const rosterCaption = message("Staff roster", { nl: "Personeelsrooster" });

const sourceCaption = message("Source reference", { nl: "Bronreferentie" });

const employeeCaption = message("Employee", { nl: "Medewerker" });

const fromCaption = message("From", { nl: "Van" });

const untilCaption = message("Until", { nl: "Tot" });

const beforeCaption = message("Travel buffer before", { nl: "Reisbuffer vooraf" });

const afterCaption = message("Travel buffer after", { nl: "Reisbuffer achteraf" });

const skillCaption = message("Required skill", { nl: "Vereiste vaardigheid" });

const kindCaption = {
  text: message("Kind", { nl: "Soort" }),
  values: {
    duty: message("Staff duty", { nl: "Personeelsdienst" }),
    visit: message("Service visit", { nl: "Servicebezoek" }),
    appointment: message("Host appointment", { nl: "Hostafspraak" }),
    absence: message("Absence", { nl: "Afwezigheid" }),
    interview: message("Interview", { nl: "Sollicitatiegesprek" }),
  },
};

const roleCaption = message("Work role", { nl: "Werkrol" });

const overrideCaption = message("Coverage override reason", {
  nl: "Reden voor bezettingsafwijking",
});

const substituteCaption = message("Proposed substitute", { nl: "Voorgestelde vervanger" });

export const CommitmentRequest = "shift.CommitmentRequest";

export const ScheduleV1 = "shift.ScheduleV1";

export const ScheduleIngressV1 = "shift.ScheduleIngressV1";

export const ReservationOutcome = "shift.ReservationOutcome";

async function fits(c, roster, employee, from, until, before, after, skip) {
  return (
    employee.active &&
    (await any(
      records(c, "shift.Availability", { parent: roster }),
      (window) =>
        same(window.employee, employee) &&
        window.available &&
        compareInstant(window.from, subtractDuration(from, before)) <= 0 &&
        compareInstant(addDuration(until, after), window.until) <= 0,
    )) &&
    !(await any(
      records(c, "shift.Availability", { parent: roster }),
      (window) =>
        same(window.employee, employee) &&
        !window.available &&
        overlaps(
          subtractDuration(from, before),
          addDuration(until, after),
          window.from,
          window.until,
        ),
    )) &&
    !(await any(
      records(c, "shift.Commitment", { parent: roster }),
      (existing) =>
        !same(existing, skip) &&
        same(existing.employee, employee) &&
        existing.active &&
        overlaps(
          subtractDuration(from, before),
          addDuration(until, after),
          subtractDuration(existing.from, existing.before),
          addDuration(existing.until, existing.after),
        ),
    ))
  );
}

/* The declared reservation/notice bridges, query authority, transaction admission
 * and example runner remain proposed contracts. Source checks do not execute them. */
async function eligible(c, commitment) {
  return (
    commitment.active &&
    commitment.location.active &&
    commitment.employee.active &&
    (await can_work(c, commitment.employee.user, commitment.location)) &&
    (commitment.kind === "absence" || commitment.employee.skills.includes(commitment.skill)) &&
    (commitment.kind === "absence" ||
      ((await any(
        records(c, "shift.Availability", { parent: commitment.parent }),
        (window) =>
          same(window.employee, commitment.employee) &&
          window.available &&
          compareInstant(window.from, subtractDuration(commitment.from, commitment.before)) <= 0 &&
          compareInstant(addDuration(commitment.until, commitment.after), window.until) <= 0,
      )) &&
        !(await any(
          records(c, "shift.Availability", { parent: commitment.parent }),
          (window) =>
            same(window.employee, commitment.employee) &&
            !window.available &&
            overlaps(
              subtractDuration(commitment.from, commitment.before),
              addDuration(commitment.until, commitment.after),
              window.from,
              window.until,
            ),
        ))))
  );
}
async function coverage_met(c, roster, window, publishing) {
  const boundaries = [
    window.from,
    ...(await flatten(
      (
        await collect(
          records(c, "shift.Commitment", {
            parent: roster,
            where: (item) => item.kind === "duty" && same(item.location, window.location),
          }),
        )
      ).map((item) => [item.from, item.until]),
    )),
  ];
  return await all(
    boundaries,
    async (instant) =>
      compareInstant(instant, window.from) < 0 ||
      compareInstant(instant, window.until) >= 0 ||
      (await count(
        records(c, "shift.Duty", {
          where: async (duty) =>
            same(duty.parent.parent, roster) &&
            duty.role === window.role &&
            same(duty.parent.location, window.location) &&
            duty.parent.employee.role === duty.role &&
            (duty.published || same(duty, publishing)) &&
            !duty.parent.conflict &&
            (await eligible(c, duty.parent)) &&
            compareInstant(duty.parent.from, instant) <= 0 &&
            compareInstant(instant, duty.parent.until) < 0,
        }),
      )) >= window.minimum,
  );
}
async function previous_work(c, roster, employee, from, skip) {
  return await first(
    records(c, "shift.Commitment", {
      parent: roster,
      where: (item) =>
        !same(item, skip) &&
        item.active &&
        same(item.employee, employee) &&
        item.kind !== "absence" &&
        compareInstant(item.until, from) <= 0,
      order: ["-until"],
    }),
  );
}
async function next_work(c, roster, employee, until, skip) {
  return await first(
    records(c, "shift.Commitment", {
      parent: roster,
      where: (item) =>
        !same(item, skip) &&
        item.active &&
        same(item.employee, employee) &&
        item.kind !== "absence" &&
        compareInstant(until, item.from) <= 0,
      order: ["from"],
    }),
  );
}
async function travel_entered(c, roster, employee, location, from, until, before, after, skip) {
  return (
    (same((await previous_work(c, roster, employee, from, skip))?.location ?? location, location) ||
      before > 0n ||
      ((await previous_work(c, roster, employee, from, skip))?.after ?? 0n) > 0n) &&
    (same((await next_work(c, roster, employee, until, skip))?.location ?? location, location) ||
      after > 0n ||
      ((await next_work(c, roster, employee, until, skip))?.before ?? 0n) > 0n)
  );
}
const rosterPageDescriptor = {
  owner: "shift",
  path: "/roster",
  title: rosterCaption,
  description: message("Plan drafts, publish coverage and resolve current commitments.", {
    nl: "Plan concepten, publiceer bezetting en los huidige inzetverplichtingen op.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "shift.scheduler"), "forbidden");
    return {};
  },
  render: rosterPage,
};

const minePageDescriptor = {
  owner: "shift",
  path: "/roster/mine",
  title: message("My shifts", { nl: "Mijn diensten" }),
  description: message("Maintain your availability separately from hidden roster drafts.", {
    nl: "Beheer je beschikbaarheid afzonderlijk van verborgen conceptroosters.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: minePage,
};

export const appDefinition = {
  id: "CanShift",
  uses: ["shift"],
  description: message(
    "Help workspace managers roster reception, community, sales, and facilities staff across locations and arrange replacements.",
    {
      nl: "Help werkplekbeheerders receptie-, community-, verkoop- en facilitaire medewerkers over locaties in te roosteren en vervanging te regelen.",
    },
  ),
  packages: {
    shift: {
      label: message("Staff scheduling", { nl: "Personeelsplanning" }),
      description: message(
        "Own the operator-wide employee commitment ledger, published duty coverage and guarded swaps.",
        {
          nl: "Beheer het locatieoverstijgende inzetregister, gepubliceerde dienstbezetting en bewaakte dienstruilen.",
        },
      ),
      roles: {
        scheduler: { id: "shift.scheduler", label: message("Scheduler", { nl: "Roosterplanner" }) },
      },
    },
  },
  bindings: {
    "shift.Mail": { capability: EmailV1, from: "deployment.mail" },
    "shift.ScheduleRequests": {
      capability: ScheduleIngressV1,
      from: "deployment.schedule_ingress",
    },
  },
  models: {
    "shift.Roster": {
      label: rosterCaption,
      invariants: ["Roster.require.1"],
      readGrants: [{ rule: "Roster.read.1" }],
      fields: { name: { type: "text", unique: true } },
    },
    "shift.Availability": {
      parent: "shift.Roster",
      label: message("Employee availability", { nl: "Medewerkersbeschikbaarheid" }),
      readGrants: [{ rule: "Availability.read.1" }, { rule: "Availability.read.2" }],
      invariants: ["Availability.require.1"],
      fields: {
        employee: { type: Employee, label: employeeCaption },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        available: {
          type: "bool",
          default: true,
          label: message("Available for work", { nl: "Beschikbaar voor werk" }),
        },
      },
    },
    "shift.Commitment": {
      parent: "shift.Roster",
      label: message("Employee commitment", { nl: "Personeelsinzet" }),
      readGrants: [{ rule: "Commitment.read.1" }, { rule: "Commitment.read.2" }],
      invariants: ["Commitment.require.1"],
      fields: {
        employee: { type: Employee, label: employeeCaption },
        location: { type: Location },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        before: { type: "duration", default: 0n, label: beforeCaption },
        after: { type: "duration", default: 0n, label: afterCaption },
        skill: { type: "text", label: skillCaption },
        kind: {
          type: "enum",
          cases: ["duty", "visit", "appointment", "absence", "interview"],
          label: kindCaption,
        },
        source: { type: "text", unique: true, label: sourceCaption },
        previous: {
          type: "shift.Commitment",
          nullable: true,
          label: message("Retained predecessor", { nl: "Behouden voorganger" }),
        },
        revision: { type: "int", default: 1n },
        active: { type: "bool", default: true },
        conflict: {
          type: "bool",
          default: false,
          label: message("Commitment conflict", { nl: "Inzetconflict" }),
        },
      },
    },
    "shift.Release": {
      parent: "shift.Roster",
      label: message("Released source fence", { nl: "Vrijgavegrens bron" }),
      locks: ["Release.lock.1"],
      fields: {
        source: { type: "text", unique: true, label: sourceCaption },
        revision: { type: "int", min: 1n },
      },
    },
    "shift.Duty": {
      parent: "shift.Commitment",
      label: message("Published duty", { nl: "Gepubliceerde dienst" }),
      readGrants: [{ rule: "Duty.read.1" }, { rule: "Duty.read.2" }],
      fields: {
        role: { type: "text", label: roleCaption },
        published: {
          type: "bool",
          default: false,
          label: message("Published", { nl: "Gepubliceerd" }),
        },
        published_revision: {
          type: "int",
          default: 0n,
          label: message("Published revision", { nl: "Gepubliceerde versie" }),
        },
        published_by: {
          type: "user",
          nullable: true,
          label: message("Published by", { nl: "Gepubliceerd door" }),
        },
        override_reason: { type: "text", nullable: true, label: overrideCaption },
      },
    },
    "shift.Coverage": {
      parent: "shift.Roster",
      label: message("Coverage requirement", { nl: "Bezettingsvereiste" }),
      invariants: ["Coverage.require.1"],
      derived: {
        met: {
          type: "bool",
          handler: "Coverage.met",
          label: message("Coverage met", { nl: "Bezetting gehaald" }),
        },
      },
      readGrants: [{ rule: "Coverage.read.1" }],
      fields: {
        location: { type: Location },
        role: { type: "text", label: roleCaption },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        minimum: {
          type: "int",
          default: 1n,
          min: 1n,
          label: message("Minimum staff", { nl: "Minimumbezetting" }),
        },
      },
    },
    "shift.Notice": {
      parent: "shift.Duty", label: message("Roster notice", { nl: "Roosterbericht" }),
      readGrants: [
        { rule: "Notice.read.1", fields: ["parent", "recipient", "revision", "kind", "delivery.id", "delivery.status", "state", "created", "created_by", "updated", "updated_by", "archived_at"] },
        { rule: "Notice.read.2", fields: ["parent", "recipient", "revision", "kind", "delivery.id", "delivery.status", "state", "created", "created_by", "updated", "updated_by", "archived_at"] },
      ],
      fields: {
        recipient: { type: "user" }, revision: { type: "int" }, kind: { type: "shift.DutyNotice.kind" },
        delivery: { type: "delivery", operation: "shift.Mail.send" },
      },
      derived: { state: { type: "std.DeliveryResult.status", handler: "Notice.state", label: {
        text: message("Notice delivery", { nl: "Berichtverzending" }),
        values: {
          pending: message("Pending", { nl: "In afwachting" }),
          succeeded: message("Sent", { nl: "Verzonden" }),
          failed: message("Failed", { nl: "Mislukt" }),
          unknown: message("Unknown", { nl: "Onbekend" }),
          skipped: message("Skipped", { nl: "Overgeslagen" }),
        },
      } } },
    },
    "shift.Swap": {
      parent: "shift.Duty",
      label: message("Shift swap", { nl: "Dienstruil" }),
      readGrants: [{ rule: "Swap.read.1" }, { rule: "Swap.read.2" }],
      locks: ["Swap.lock.1"],
      fields: {
        substitute: { type: Employee, label: substituteCaption },
        original: {
          type: Employee,
          label: message("Original employee", { nl: "Oorspronkelijke medewerker" }),
        },
        revision: { type: "int" },
        state: {
          type: "enum",
          cases: ["open", "accepted", "rejected", "obsolete"],
          default: "open",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              open: message("Open", { nl: "Open" }),
              accepted: message("Accepted", { nl: "Geaccepteerd" }),
              rejected: message("Rejected", { nl: "Afgewezen" }),
              obsolete: message("Superseded", { nl: "Achterhaald" }),
            },
          },
        },
      },
    },
  },
  contracts: {
    [CommitmentRequest]: {
      exported: true,
      label: message("Employee commitment request", { nl: "Aanvraag personeelsinzet" }),
      fields: {
        source: { type: "text", label: sourceCaption },
        employee: { type: "user", label: employeeCaption },
        location: { type: "text" },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        before: { type: "duration", default: 0n, label: beforeCaption },
        after: { type: "duration", default: 0n, label: afterCaption },
        skill: { type: "text", label: skillCaption },
        kind: {
          type: "enum",
          cases: ["duty", "visit", "appointment", "absence", "interview"],
          label: kindCaption,
        },
        revision: { type: "int" },
      },
    },
  },
  events: {
    "shift.DutyNotice": {
      fields: {
        duty: { type: "shift.Duty" },
        recipient: { type: "user" },
        revision: { type: "int" },
        kind: {
          type: "enum",
          cases: [
            "published",
            "changed",
            "cancelled",
            "swap_request",
            "swap_accepted",
            "swap_rejected",
          ],
          label: {
            text: message("Roster notice kind", { nl: "Soort roosterbericht" }),
            values: {
              published: message("Published", { nl: "Gepubliceerd" }),
              changed: message("Changed", { nl: "Gewijzigd" }),
              cancelled: message("Cancelled", { nl: "Geannuleerd" }),
              swap_request: message("Swap request", { nl: "Ruilverzoek" }),
              swap_accepted: message("Swap accepted", { nl: "Ruil geaccepteerd" }),
              swap_rejected: message("Swap declined", { nl: "Ruil afgewezen" }),
            },
          },
        },
        swap: { type: "shift.Swap", nullable: true },
      },
    },
    [ReservationOutcome]: { exported: true, fields: { value: { type: OperationOutcome } } },
  },
  capabilities: {
    [ScheduleV1]: {
      exported: true,
      version: 1n,
      operations: {
        reserve: { inputs: { value: { type: CommitmentRequest } }, result: OperationOutcome },
        stage: {
          inputs: {
            value: { type: CommitmentRequest },
            previous_source: { type: "text" },
            previous_revision: { type: "int" },
          },
          result: OperationOutcome,
        },
        release: {
          inputs: { source: { type: "text" }, revision: { type: "int" } },
          result: OperationOutcome,
        },
      },
      events: { changed: { fields: { value: { type: OperationOutcome } } } },
    },
    [ScheduleIngressV1]: {
      exported: true,
      version: 1n,
      events: {
        reserve: {
          fields: {
            roster: { type: "shift.Roster" },
            employee: { type: Employee },
            location: { type: Location },
            value: { type: CommitmentRequest },
          },
        },
        stage: {
          fields: {
            roster: { type: "shift.Roster" },
            employee: { type: Employee },
            location: { type: Location },
            value: { type: CommitmentRequest },
            previous_source: { type: "text" },
            previous_revision: { type: "int" },
          },
        },
        release: {
          fields: {
            roster: { type: "shift.Roster" },
            source: { type: "text" },
            revision: { type: "int" },
          },
        },
      },
    },
  },
  pure: {
    "shift.eligible": {
      handler: "eligible",
      inputs: { commitment: { type: "shift.Commitment" } },
      result: "bool",
    },
    "shift.coverage_met": {
      handler: "coverage_met",
      inputs: {
        roster: { type: "shift.Roster" },
        window: { type: "shift.Coverage" },
        publishing: { type: "shift.Duty", nullable: true },
      },
      result: "bool",
    },
    "shift.previous_work": {
      handler: "previous_work",
      inputs: {
        roster: { type: "shift.Roster" },
        employee: { type: Employee },
        from: { type: "datetime" },
        skip: { type: "shift.Commitment", nullable: true },
      },
      result: { type: "shift.Commitment", nullable: true },
    },
    "shift.next_work": {
      handler: "next_work",
      inputs: {
        roster: { type: "shift.Roster" },
        employee: { type: Employee },
        until: { type: "datetime" },
        skip: { type: "shift.Commitment", nullable: true },
      },
      result: { type: "shift.Commitment", nullable: true },
    },
    "shift.travel_entered": {
      handler: "travel_entered",
      inputs: {
        roster: { type: "shift.Roster" },
        employee: { type: Employee },
        location: { type: Location },
        from: { type: "datetime" },
        until: { type: "datetime" },
        before: { type: "duration" },
        after: { type: "duration" },
        skip: { type: "shift.Commitment", nullable: true },
      },
      result: "bool",
    },
    "shift.fits": {
      handler: "fits",
      inputs: {
        roster: { type: "shift.Roster" },
        employee: { type: Employee },
        from: { type: "datetime" },
        until: { type: "datetime" },
        before: { type: "duration" },
        after: { type: "duration" },
        skip: { type: "shift.Commitment", nullable: true },
      },
      result: "bool",
    },
  },
  preferences: {
    shift: { fields: { location: { type: Location, nullable: true, default: null } } },
  },
  operations: {
    "shift.Roster.create": {
      handler: "createRoster",
      kind: "create",
      model: "shift.Roster",
      by: "shift.scheduler",
      read: false,
      inputs: { fields: ["name"] },
    },
    "shift.Roster.update": {
      handler: "updateRoster",
      kind: "update",
      model: "shift.Roster",
      by: "shift.scheduler",
      read: false,
      inputs: { record: { type: "shift.Roster" }, changes: { fields: ["name"] } },
    },
    "shift.recover_commitment": {
      handler: "recover_commitment", read: false, by: "shift.scheduler",
      inputs: { commitment: { type: "shift.Commitment" } },
      label: message("Review commitment eligibility", { nl: "Controleer inzetgeschiktheid" }),
      description: message("Review one retained commitment and its pending swaps after bounded automatic reconciliation fails.", { nl: "Controleer één behouden inzetverplichting en de openstaande dienstruilen nadat begrensde automatische reconciliatie faalt." }),
    },
    "shift.reconcile": {
      handler: "reconcile",
      read: false,
      by: "shift.scheduler",
      inputs: {
        duty: { type: "shift.Duty" },
        employee: { type: Employee },
        from: { type: "datetime" },
        until: { type: "datetime" },
        before: { type: "duration", default: 0n },
        after: { type: "duration", default: 0n },
        reason: { type: "text" },
      },
      label: message("Resolve roster conflict", { nl: "Roosterconflict oplossen" }),
      description: message(
        "Resolve an attributed duty conflict after connected visits and appointments have been handled.",
        {
          nl: "Los een toegeschreven dienstconflict op nadat verbonden bezoeken en afspraken zijn afgehandeld.",
        },
      ),
    },

    "shift.Availability.create": {
      handler: "createAvailability",
      kind: "create",
      model: "shift.Availability",
      by: "members",
      read: false,
      inputs: {
        parent: { type: "shift.Roster" },
        fields: ["employee", "from", "until", "available"],
      },
      when: "Availability",
    },
    "shift.Availability.update": {
      handler: "updateAvailability",
      kind: "update",
      model: "shift.Availability",
      by: "members",
      read: false,
      inputs: {
        record: { type: "shift.Availability" },
        changes: { fields: ["from", "until", "available"] },
      },
      when: "Availability",
    },
    "shift.Coverage.create": {
      handler: "createCoverage",
      kind: "create",
      model: "shift.Coverage",
      by: "shift.scheduler",
      read: false,
      inputs: {
        parent: { type: "shift.Roster" },
        fields: ["location", "role", "from", "until", "minimum"],
      },
      when: "Coverage",
    },
    "shift.Coverage.update": {
      handler: "updateCoverage",
      kind: "update",
      model: "shift.Coverage",
      by: "shift.scheduler",
      read: false,
      inputs: {
        record: { type: "shift.Coverage" },
        changes: { fields: ["role", "from", "until", "minimum"] },
      },
      when: "Coverage",
    },
    "shift.assign": {
      read: false,
      handler: "assign",
      by: "shift.scheduler",
      inputs: {
        roster: { type: "shift.Roster" },
        employee: { type: Employee },
        location: { type: Location },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        role: { type: "text", label: roleCaption },
        skill: { type: "text", label: skillCaption },
        before: { type: "duration", default: 0n, label: beforeCaption },
        after: { type: "duration", default: 0n, label: afterCaption },
      },
      description: message(
        "Reserve draft duty at the single operator schedule, including entered travel buffers.",
        {
          nl: "Reserveer conceptdiensten in het enige exploitantrooster, inclusief ingevoerde reisbuffers.",
        },
      ),
    },
    "shift.publish": {
      read: false,
      handler: "publish",
      by: "shift.scheduler",
      inputs: {
        duty: { type: "shift.Duty" },
        override_reason: { type: "text", nullable: true, default: null, label: overrideCaption },
      },
      description: message(
        "Publish coverage or preserve an attributed reason for the visible gap.",
        { nl: "Publiceer bezetting of behoud een toegeschreven reden voor het zichtbare tekort." },
      ),
    },
    "shift.request_swap": {
      read: false,
      handler: "request_swap",
      by: "members",
      inputs: {
        duty: { type: "shift.Duty" },
        substitute: { type: Employee, label: substituteCaption },
      },
      label: message("Request shift swap", { nl: "Dienstruil aanvragen" }),
      description: message("Request a replacement against the current published assignment.", {
        nl: "Vraag vervanging aan voor de huidige gepubliceerde dienst.",
      }),
    },
    "shift.accept": {
      read: false,
      handler: "accept",
      by: "members",
      inputs: { swap: { type: "shift.Swap" } },
      label: message("Accept shift swap", { nl: "Dienstruil accepteren" }),
      description: message(
        "Accept only your current available substitution and invalidate competing requests.",
        {
          nl: "Accepteer alleen je huidige beschikbare vervanging en maak concurrerende aanvragen ongeldig.",
        },
      ),
    },
    "shift.decline": {
      read: false,
      handler: "decline",
      by: "members",
      inputs: { swap: { type: "shift.Swap" } },
      label: message("Decline shift swap", { nl: "Dienstruil afwijzen" }),
      description: message("Decline your own proposed swap while leaving the duty unchanged.", {
        nl: "Wijs je eigen voorgestelde dienstruil af en laat de dienst ongewijzigd.",
      }),
    },
    "shift.cancel": {
      read: false,
      handler: "cancel",
      by: "shift.scheduler",
      inputs: { duty: { type: "shift.Duty" }, reason: { type: "text" } },
      description: message(
        "Release a duty only after dependent appointments and visits have been resolved.",
        { nl: "Geef een dienst pas vrij nadat afhankelijke afspraken en bezoeken zijn opgelost." },
      ),
    },
  },
  handlers: {
    "shift.employee_changed": { handler: "employee_changed", on: EmployeeChanged },
    "shift.location_changed": { handler: "location_changed", on: "rent_catalog.Location.updated" },
    "shift.member_removed": { handler: "member_removed", on: "teams.member_removed" },
    "shift.availability_created": {
      handler: "availability_created",
      on: "shift.Availability.create",
    },
    "shift.availability_changed": {
      handler: "availability_changed",
      on: "shift.Availability.update",
    },
    "shift.duty_notice": { handler: "duty_notice", on: "shift.DutyNotice" },
    "shift.reserve_connected": {
      handler: "reserve_connected",
      on: "shift.ScheduleRequests.reserve",
    },
    "shift.stage_connected": { handler: "stage_connected", on: "shift.ScheduleRequests.stage" },
    "shift.release_connected": {
      handler: "release_connected",
      on: "shift.ScheduleRequests.release",
    },
  },
  pages: [
    rosterPageDescriptor,
    minePageDescriptor,
  ],
  disabled: ["shift.Roster.delete", "shift.Availability.delete", "shift.Coverage.delete"],
  compositions: {
    StaffScheduling: {
      uses: ["CanLeave", "CanShift"],
      description: message(
        "Review private leave and publish conflict-aware staff rotas and swaps.",
        {
          nl: "Beoordeel privéverlof en publiceer conflictbewuste personeelsroosters en dienstruilen.",
        },
      ),
    },
  },
};

export function canApp() {
  const crudWhen = {
    Availability: (c, row) => same(row.employee.user, c.actor) && row.employee.active,
    Coverage: async (c, row) => await can_work(c, c.actor, row.location),
  };
  return {
    fits,
    eligible,
    coverage_met,
    previous_work,
    next_work,
    travel_entered,
    read: {
      "Notice.read.1": async (c, row) =>
        hasRole(c, "shift.scheduler") && (await can_work(c, c.actor, row.parent.parent.location)),
      "Notice.read.2": (c, row) => hasRole(c, "members") && same(row.recipient, c.actor),
      "Roster.read.1": (c, row) => hasRole(c, "shift.scheduler"),
      "Availability.read.1": (c, row) => hasRole(c, "shift.scheduler"),
      "Availability.read.2": (c, row) => hasRole(c, "members") && same(row.employee.user, c.actor),
      "Commitment.read.1": async (c, row) =>
        hasRole(c, "shift.scheduler") && (await can_work(c, c.actor, row.location)),
      "Commitment.read.2": async (c, row) =>
        hasRole(c, "members") &&
        same(row.employee.user, c.actor) &&
        (row.kind !== "duty" ||
          (await any(records(c, "shift.Duty", { parent: row }), (duty) => duty.published))),
      "Duty.read.1": async (c, row) =>
        hasRole(c, "shift.scheduler") && (await can_work(c, c.actor, row.parent.location)),
      "Duty.read.2": (c, row) =>
        hasRole(c, "members") && row.published && same(row.parent.employee.user, c.actor),
      "Coverage.read.1": async (c, row) =>
        hasRole(c, "shift.scheduler") && (await can_work(c, c.actor, row.location)),
      "Swap.read.1": (c, row) => hasRole(c, "shift.scheduler"),
      "Swap.read.2": (c, row) =>
        hasRole(c, "members") &&
        (same(row.substitute.user, c.actor) || same(row.original.user, c.actor)),
    },
    derives: {
      "Coverage.met": async (c, row) => await coverage_met(c, row.parent, row, null),
      "Notice.state": async (c, row) => (await delivery(c, { record: row, field: "delivery" }, ["status"])).status,
    },
    invariants: {
      "Roster.require.1": async (c, row) => (await count(records(c, "shift.Roster"))) === 1n,
      "Coverage.require.1": (c, row) => compareInstant(row.from, row.until) < 0,
      "Availability.require.1": (c, row) => compareInstant(row.from, row.until) < 0,
      "Commitment.require.1": (c, row) =>
        compareInstant(row.from, row.until) < 0 && row.before >= 0n && row.after >= 0n,
    },
    locks: {
      "Release.lock.1": { fields: ["source"] },
      "Swap.lock.1": { fields: ["substitute", "original", "revision"] },
    },
    crudWhen,
    async createRoster(c, input) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      await create(c, "shift.Roster", input);
    },
    async updateRoster(c, { record, changes }) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      await set(c, record, changes);
    },
    async createAvailability(c, input) {
      check(hasRole(c, "members"), "forbidden");
      await create(c, "shift.Availability", input, { when: crudWhen.Availability });
    },
    async updateAvailability(c, { record, changes }) {
      check(hasRole(c, "members"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Availability });
    },
    async createCoverage(c, input) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      await create(c, "shift.Coverage", input, { when: crudWhen.Coverage });
    },
    async updateCoverage(c, { record, changes }) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Coverage });
    },
    async assign(
      c,
      { roster, employee, location, from, until, role, skill, before = 0n, after = 0n },
    ) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      check(
        location.active &&
          (await can_work(c, c.actor, location)) &&
          (await can_work(c, employee.user, location)) &&
          employee.role === role &&
          employee.skills.includes(skill) &&
          compareInstant(from, until) < 0 &&
          before >= 0n &&
          after >= 0n &&
          (await fits(c, roster, employee, from, until, before, after, null)) &&
          (await travel_entered(c, roster, employee, location, from, until, before, after, null)),
      );
      const commitment = await create(c, "shift.Commitment", {
        parent: roster,
        employee,
        location,
        from,
        until,
        before,
        after,
        skill,
        kind: "duty",
        source: c.operation.id,
      });
      await create(c, "shift.Duty", { parent: commitment, role });
    },
    async publish(c, { duty, override_reason = null }) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      check(
        (await can_work(c, c.actor, duty.parent.location)) &&
          (await eligible(c, duty.parent)) &&
          duty.parent.employee.role === duty.role &&
          !duty.parent.conflict &&
          !duty.published,
      );
      check(override_reason === null || override_reason.trim() !== "");
      check(
        override_reason !== null ||
          (await all(
            records(c, "shift.Coverage", { parent: duty.parent.parent }),
            async (window) =>
              !same(window.location, duty.parent.location) ||
              window.role !== duty.role ||
              !overlaps(duty.parent.from, duty.parent.until, window.from, window.until) ||
              (await coverage_met(c, duty.parent.parent, window, duty)),
          )),
      );
      await set(c, duty.parent, { revision: int64(duty.parent.revision + 1n) });
      await set(c, duty, {
        published: true,
        published_revision: duty.parent.revision,
        published_by: c.actor,
        override_reason,
      });
      await emit(c, "shift.DutyNotice", {
        duty,
        recipient: duty.parent.employee.user,
        revision: duty.parent.revision,
        kind: "published",
      });
    },
    async request_swap(c, { duty, substitute }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        duty.published &&
          duty.parent.active &&
          compareInstant(duty.parent.until, c.now) > 0 &&
          same(duty.parent.employee.user, c.actor) &&
          duty.parent.location.active &&
          (await can_work(c, c.actor, duty.parent.location)) &&
          !same(substitute.user, c.actor) &&
          substitute.active &&
          substitute.role === duty.role &&
          (await can_work(c, substitute.user, duty.parent.location)) &&
          substitute.skills.includes(duty.parent.skill),
      );
      const swap = await create(c, "shift.Swap", {
        parent: duty,
        substitute,
        original: duty.parent.employee,
        revision: duty.parent.version,
      });
      await emit(c, "shift.DutyNotice", {
        duty,
        recipient: substitute.user,
        revision: duty.parent.revision,
        kind: "swap_request",
        swap,
      });
    },
    async accept(c, { swap }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        swap.state === "open" &&
          swap.parent.published &&
          swap.parent.parent.active &&
          swap.parent.parent.location.active &&
          compareInstant(swap.parent.parent.until, c.now) > 0 &&
          same(swap.substitute.user, c.actor) &&
          swap.substitute.active &&
          same(swap.parent.parent.employee, swap.original) &&
          swap.parent.parent.version === swap.revision &&
          swap.substitute.role === swap.parent.role &&
          (await can_work(c, swap.substitute.user, swap.parent.parent.location)) &&
          swap.substitute.skills.includes(swap.parent.parent.skill),
      );
      check(
        (await fits(
          c,
          swap.parent.parent.parent,
          swap.substitute,
          swap.parent.parent.from,
          swap.parent.parent.until,
          swap.parent.parent.before,
          swap.parent.parent.after,
          swap.parent.parent,
        )) &&
          (await travel_entered(
            c,
            swap.parent.parent.parent,
            swap.substitute,
            swap.parent.parent.location,
            swap.parent.parent.from,
            swap.parent.parent.until,
            swap.parent.parent.before,
            swap.parent.parent.after,
            swap.parent.parent,
          )),
      );
      check(
        !(await any(
          records(c, "shift.Commitment", { parent: swap.parent.parent.parent }),
          (dependent) =>
            dependent.active &&
            same(dependent.employee, swap.original) &&
            ["visit", "appointment", "interview"].includes(dependent.kind) &&
            overlaps(
              dependent.from,
              dependent.until,
              swap.parent.parent.from,
              swap.parent.parent.until,
            ),
        )),
      );
      await set(c, swap.parent.parent, {
        employee: swap.substitute,
        conflict: false,
        revision: int64(swap.parent.parent.revision + 1n),
      });
      await set(c, swap, { state: "accepted" });
      await set(c, swap.parent, { published_revision: swap.parent.parent.revision });
      await emit(c, "shift.DutyNotice", {
        duty: swap.parent,
        recipient: swap.original.user,
        revision: swap.parent.parent.revision,
        kind: "swap_accepted",
        swap,
      });
      await emit(c, "shift.DutyNotice", {
        duty: swap.parent,
        recipient: swap.substitute.user,
        revision: swap.parent.parent.revision,
        kind: "swap_accepted",
        swap,
      });
      for await (const other of records(c, "shift.Swap", {
        parent: swap.parent,
        where: (item) => !same(item, swap) && item.state === "open",
        limit: 100n,
      }))
        await set(c, other, { state: "obsolete" });
    },
    async decline(c, { swap }) {
      check(hasRole(c, "members"), "forbidden");
      check(same(swap.substitute.user, c.actor) && swap.state === "open");
      await set(c, swap, { state: "rejected" });
      await emit(c, "shift.DutyNotice", {
        duty: swap.parent,
        recipient: swap.original.user,
        revision: swap.parent.parent.revision,
        kind: "swap_rejected",
        swap,
      });
    },
    async cancel(c, { duty, reason }) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      check(
        (await can_work(c, c.actor, duty.parent.location)) &&
          duty.parent.active &&
          reason.trim() !== "",
      );
      check(
        !(await any(
          records(c, "shift.Commitment", { parent: duty.parent.parent }),
          (dependent) =>
            dependent.active &&
            same(dependent.employee, duty.parent.employee) &&
            ["visit", "appointment", "interview"].includes(dependent.kind) &&
            overlaps(dependent.from, dependent.until, duty.parent.from, duty.parent.until),
        )),
      );
      await set(c, duty.parent, { active: false, revision: int64(duty.parent.revision + 1n) });
      for await (const swap of records(c, "shift.Swap", {
        parent: duty,
        where: (item) => item.state === "open",
        limit: 100n,
      }))
        await set(c, swap, { state: "obsolete" });
      if (duty.published)
        await emit(c, "shift.DutyNotice", {
          duty,
          recipient: duty.parent.employee.user,
          revision: duty.parent.revision,
          kind: "cancelled",
        });
    },
    async reconcile(c, { duty, employee, from, until, before = 0n, after = 0n, reason }) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      check(
        duty.parent.location.active &&
          (await can_work(c, c.actor, duty.parent.location)) &&
          duty.parent.active &&
          reason.trim() !== "" &&
          (await can_work(c, employee.user, duty.parent.location)) &&
          employee.role === duty.role &&
          employee.skills.includes(duty.parent.skill) &&
          compareInstant(from, until) < 0 &&
          before >= 0n &&
          after >= 0n,
      );
      check(
        (await fits(c, duty.parent.parent, employee, from, until, before, after, duty.parent)) &&
          (await travel_entered(
            c,
            duty.parent.parent,
            employee,
            duty.parent.location,
            from,
            until,
            before,
            after,
            duty.parent,
          )),
      );
      check(
        !(await any(
          records(c, "shift.Commitment", { parent: duty.parent.parent }),
          (dependent) =>
            dependent.active &&
            same(dependent.employee, duty.parent.employee) &&
            ["visit", "appointment", "interview"].includes(dependent.kind) &&
            overlaps(dependent.from, dependent.until, duty.parent.from, duty.parent.until),
        )),
      );
      const original = duty.parent.employee;
      const original_from = duty.parent.from;
      const original_until = duty.parent.until;
      await set(c, duty.parent, {
        employee,
        from,
        until,
        before,
        after,
        conflict: false,
        revision: int64(duty.parent.revision + 1n),
      });
      for await (const swap of records(c, "shift.Swap", {
        parent: duty,
        where: (item) => item.state === "open",
        limit: 100n,
      }))
        await set(c, swap, { state: "obsolete" });
      if (duty.published) {
        check(
          await all(
            records(c, "shift.Coverage", { parent: duty.parent.parent }),
            async (window) =>
              !same(window.location, duty.parent.location) ||
              window.role !== duty.role ||
              (!overlaps(original_from, original_until, window.from, window.until) &&
                !overlaps(duty.parent.from, duty.parent.until, window.from, window.until)) ||
              (await coverage_met(c, duty.parent.parent, window, duty)),
          ),
        );
        await set(c, duty, {
          published_revision: duty.parent.revision,
          override_reason: reason,
          published_by: c.actor,
        });
        await emit(c, "shift.DutyNotice", {
          duty,
          recipient: original.user,
          revision: duty.parent.revision,
          kind: "changed",
        });
        if (!same(employee, original))
          await emit(c, "shift.DutyNotice", {
            duty,
            recipient: employee.user,
            revision: duty.parent.revision,
            kind: "changed",
          });
      }
    },
    async recover_commitment(c, { commitment }) {
      check(hasRole(c, "shift.scheduler"), "forbidden");
      check((await can_work(c, c.actor, commitment.location)) && commitment.active && compareInstant(addDuration(commitment.until, commitment.after), c.now) > 0);
      if (commitment.conflict || !(await eligible(c, commitment)) || (await any(records(c, "shift.Duty", { parent: commitment }), (duty) => duty.role !== commitment.employee.role))) {
        await set(c, commitment, { conflict: true });
        await emit(c, ReservationOutcome, { value: { source: commitment.source, revision: commitment.revision, state: "unavailable", reference: commitment.id } });
      }
      for await (const swap of records(c, "shift.Swap", {
        where: (item) => same(item.parent.parent, commitment) && item.state === "open" && compareInstant(item.parent.parent.until, c.now) > 0,
        limit: 100n,
      })) {
        if (commitment.conflict || !commitment.location.active || !same(swap.original, commitment.employee) || commitment.version !== swap.revision ||
          !(await can_work(c, swap.original.user, commitment.location)) || !(await can_work(c, swap.substitute.user, commitment.location)) ||
          swap.original.role !== swap.parent.role || swap.substitute.role !== swap.parent.role || !swap.substitute.skills.includes(commitment.skill) ||
          !(await fits(c, commitment.parent, swap.substitute, commitment.from, commitment.until, commitment.before, commitment.after, commitment)) ||
          !(await travel_entered(c, commitment.parent, swap.substitute, commitment.location, commitment.from, commitment.until, commitment.before, commitment.after, commitment)))
          await set(c, swap, { state: "obsolete" });
      }
    },
    async employee_changed(c, { event }) {
      for await (const commitment of records(c, "shift.Commitment", {
        where: (item) =>
          item.active &&
          compareInstant(addDuration(item.until, item.after), c.now) > 0 &&
          same(item.employee, event.employee),
        limit: 500n,
      }))
        if (
          !(await eligible(c, commitment)) ||
          (await any(
            records(c, "shift.Duty", { parent: commitment }),
            (duty) => duty.role !== commitment.employee.role,
          ))
        ) {
          await set(c, commitment, { conflict: true });
          await emit(c, ReservationOutcome, {
            value: {
              source: commitment.source,
              revision: commitment.revision,
              state: "unavailable",
              reference: commitment.id,
            },
          });
        }
      for await (const swap of records(c, "shift.Swap", {
        where: (item) =>
          item.state === "open" &&
          compareInstant(item.parent.parent.until, c.now) > 0 &&
          (same(item.original, event.employee) || same(item.substitute, event.employee)),
        limit: 500n,
      }))
        if (
          !(await can_work(c, swap.substitute.user, swap.parent.parent.location)) ||
          !(await can_work(c, swap.original.user, swap.parent.parent.location)) ||
          swap.substitute.role !== swap.parent.role ||
          swap.original.role !== swap.parent.role ||
          !swap.substitute.skills.includes(swap.parent.parent.skill)
        )
          await set(c, swap, { state: "obsolete" });
    },
    async location_changed(c, { event }) {
      for await (const commitment of records(c, "shift.Commitment", {
        where: (item) => item.active && compareInstant(addDuration(item.until, item.after), c.now) > 0 &&
          item.location.id === event.id && !item.location.active,
        limit: 500n,
      })) {
        await set(c, commitment, { conflict: true });
        await emit(c, ReservationOutcome, { value: {
          source: commitment.source, revision: commitment.revision, state: "unavailable", reference: commitment.id,
        } });
      }
      for await (const swap of records(c, "shift.Swap", {
        where: (item) => item.state === "open" && compareInstant(item.parent.parent.until, c.now) > 0 &&
          item.parent.parent.location.id === event.id && !item.parent.parent.location.active,
        limit: 500n,
      })) await set(c, swap, { state: "obsolete" });
    },
    async member_removed(c, { event }) {
      for await (const commitment of records(c, "shift.Commitment", {
        where: (item) =>
          item.active &&
          compareInstant(addDuration(item.until, item.after), c.now) > 0 &&
          same(item.employee.user, event.user),
        limit: 500n,
      })) {
        await set(c, commitment, { conflict: true });
        await emit(c, ReservationOutcome, {
          value: {
            source: commitment.source,
            revision: commitment.revision,
            state: "unavailable",
            reference: commitment.id,
          },
        });
      }
      for await (const swap of records(c, "shift.Swap", {
        where: (item) =>
          item.state === "open" &&
          compareInstant(item.parent.parent.until, c.now) > 0 &&
          (same(item.original.user, event.user) || same(item.substitute.user, event.user)),
        limit: 500n,
      }))
        await set(c, swap, { state: "obsolete" });
    },
    async availability_changed(c, { event }) {
      for await (const commitment of records(c, "shift.Commitment", {
        parent: event.after.parent,
        where: (item) =>
          item.active &&
          compareInstant(addDuration(item.until, item.after), c.now) > 0 &&
          same(item.employee, event.after.employee),
        limit: 500n,
      }))
        if (!(await eligible(c, commitment))) {
          await set(c, commitment, { conflict: true });
          await emit(c, ReservationOutcome, {
            value: {
              source: commitment.source,
              revision: commitment.revision,
              state: "unavailable",
              reference: commitment.id,
            },
          });
        }
      for await (const swap of records(c, "shift.Swap", {
        where: (item) =>
          item.state === "open" &&
          same(item.parent.parent.parent, event.after.parent) &&
          same(item.substitute, event.after.employee) &&
          compareInstant(item.parent.parent.until, c.now) > 0,
        limit: 500n,
      })) {
        if (
          !(await fits(
            c,
            swap.parent.parent.parent,
            swap.substitute,
            swap.parent.parent.from,
            swap.parent.parent.until,
            swap.parent.parent.before,
            swap.parent.parent.after,
            swap.parent.parent,
          )) ||
          !(await travel_entered(
            c,
            swap.parent.parent.parent,
            swap.substitute,
            swap.parent.parent.location,
            swap.parent.parent.from,
            swap.parent.parent.until,
            swap.parent.parent.before,
            swap.parent.parent.after,
            swap.parent.parent,
          ))
        )
          await set(c, swap, { state: "obsolete" });
      }
    },
    async availability_created(c, { event }) {
      for await (const commitment of records(c, "shift.Commitment", {
        parent: event.after.parent,
        where: (item) =>
          item.active &&
          compareInstant(addDuration(item.until, item.after), c.now) > 0 &&
          same(item.employee, event.after.employee),
        limit: 500n,
      }))
        if (!(await eligible(c, commitment))) {
          await set(c, commitment, { conflict: true });
          await emit(c, ReservationOutcome, {
            value: {
              source: commitment.source,
              revision: commitment.revision,
              state: "unavailable",
              reference: commitment.id,
            },
          });
        }
      for await (const swap of records(c, "shift.Swap", {
        where: (item) =>
          item.state === "open" &&
          same(item.parent.parent.parent, event.after.parent) &&
          same(item.substitute, event.after.employee) &&
          compareInstant(item.parent.parent.until, c.now) > 0,
        limit: 500n,
      })) {
        if (
          !(await fits(
            c,
            swap.parent.parent.parent,
            swap.substitute,
            swap.parent.parent.from,
            swap.parent.parent.until,
            swap.parent.parent.before,
            swap.parent.parent.after,
            swap.parent.parent,
          )) ||
          !(await travel_entered(
            c,
            swap.parent.parent.parent,
            swap.substitute,
            swap.parent.parent.location,
            swap.parent.parent.from,
            swap.parent.parent.until,
            swap.parent.parent.before,
            swap.parent.parent.after,
            swap.parent.parent,
          ))
        )
          await set(c, swap, { state: "obsolete" });
      }
    },
    async duty_notice(c, { event }) {
      const attempt = await send(
        c,
        "shift.Mail.send",
        {
          to: event.recipient.email,
          subject: format(
            c,
            message("Your staff roster changed", { nl: "Je personeelsrooster is gewijzigd" }),
            { locale: null },
          ),
          body: format(
            c,
            message("Review your current shifts and swap decisions.", {
              nl: "Bekijk je huidige diensten en ruilbesluiten.",
            }),
            { locale: null },
          ),
        },
        {
          when: async () =>
            active_member(event.recipient, c.team) &&
            event.duty.parent.revision === event.revision &&
            (["cancelled", "swap_rejected"].includes(event.kind) ||
              ((await eligible(c, event.duty.parent)) && !event.duty.parent.conflict)) &&
            ((event.kind === "cancelled" && !event.duty.parent.active) ||
              (event.kind !== "cancelled" &&
                event.duty.parent.active &&
                (event.kind !== "swap_request" ||
                  (event.swap !== null && event.swap.state === "open")))),
        },
      );
      await create(c, "shift.Notice", {
        parent: event.duty,
        recipient: event.recipient,
        revision: event.revision,
        kind: event.kind,
        delivery: attempt,
      });
    },
    async reserve_connected(c, { event }) {
      check(
        same(event.employee.user, event.value.employee) &&
          event.location.id === event.value.location &&
          event.location.active &&
          event.employee.active &&
          compareInstant(event.value.from, event.value.until) < 0 &&
          event.value.before >= 0n &&
          event.value.after >= 0n &&
          event.value.revision > 0n,
      );
      check(
        (await can_work(c, event.employee.user, event.location)) &&
          (event.value.kind === "absence" || event.employee.skills.includes(event.value.skill)),
      );
      check(
        !(await any(
          records(c, "shift.Release", { parent: event.roster }),
          (released) =>
            released.source === event.value.source && released.revision >= event.value.revision,
        )),
      );
      const previous = await first(
        records(c, "shift.Commitment", {
          parent: event.roster,
          where: (item) => item.source === event.value.source,
          order: ["id"],
        }),
      );
      if (previous !== null) {
        check(
          previous.revision === event.value.revision &&
            previous.active &&
            same(previous.employee, event.employee) &&
            same(previous.location, event.location) &&
            previous.kind === event.value.kind &&
            previous.skill === event.value.skill &&
            previous.before === event.value.before &&
            previous.after === event.value.after &&
            compareInstant(previous.from, event.value.from) === 0 &&
            compareInstant(previous.until, event.value.until) === 0,
        );
        await emit(c, ReservationOutcome, {
          value: {
            source: previous.source,
            revision: previous.revision,
            state: previous.conflict || !(await eligible(c, previous)) ? "unavailable" : "confirmed",
            reference: previous.id,
          },
        });
      } else {
        const conflicts = await collect(
          records(c, "shift.Commitment", {
            parent: event.roster,
            where: (item) =>
              !same(item, previous) &&
              item.active &&
              same(item.employee, event.employee) &&
              overlaps(
                subtractDuration(event.value.from, event.value.before),
                addDuration(event.value.until, event.value.after),
                subtractDuration(item.from, item.before),
                addDuration(item.until, item.after),
              ),
          }),
        );
        const available =
          (await any(
            records(c, "shift.Availability", { parent: event.roster }),
            (window) =>
              same(window.employee, event.employee) &&
              window.available &&
              compareInstant(window.from, subtractDuration(event.value.from, event.value.before)) <=
                0 &&
              compareInstant(addDuration(event.value.until, event.value.after), window.until) <= 0,
          )) &&
          !(await any(
            records(c, "shift.Availability", { parent: event.roster }),
            (window) =>
              same(window.employee, event.employee) &&
              !window.available &&
              overlaps(
                subtractDuration(event.value.from, event.value.before),
                addDuration(event.value.until, event.value.after),
                window.from,
                window.until,
              ),
          ));
        const compatible = await all(
          conflicts,
          async (item) =>
            item.kind === "duty" &&
            !item.conflict &&
            (await eligible(c, item)) &&
            same(item.location, event.location) &&
            compareInstant(item.from, event.value.from) <= 0 &&
            compareInstant(event.value.until, item.until) <= 0 &&
            ["visit", "appointment", "interview"].includes(event.value.kind),
        );
        if (
          event.value.kind !== "absence" &&
          (!available ||
            !compatible ||
            !(await travel_entered(
              c,
              event.roster,
              event.employee,
              event.location,
              event.value.from,
              event.value.until,
              event.value.before,
              event.value.after,
              previous,
            )))
        )
          await emit(c, ReservationOutcome, {
            value: {
              source: event.value.source,
              revision: event.value.revision,
              state: "unavailable",
              detail: "Employee commitment unavailable",
            },
          });
        else {
          const commitment = await create(c, "shift.Commitment", {
            parent: event.roster,
            employee: event.employee,
            location: event.location,
            from: event.value.from,
            until: event.value.until,
            before: event.value.before,
            after: event.value.after,
            skill: event.value.skill,
            kind: event.value.kind,
            source: event.value.source,
            revision: event.value.revision,
          });
          await emit(c, ReservationOutcome, {
            value: {
              source: commitment.source,
              revision: commitment.revision,
              state: "confirmed",
              reference: commitment.id,
            },
          });
          if (event.value.kind === "absence")
            for await (const conflict of bounded(conflicts, 100n)) {
              await set(c, conflict, { conflict: true });
              await emit(c, ReservationOutcome, {
                value: {
                  source: conflict.source,
                  revision: conflict.revision,
                  state: "unavailable",
                  reference: conflict.id,
                },
              });
            }
        }
      }
    },
    async stage_connected(c, { event }) {
      check(
        same(event.employee.user, event.value.employee) &&
          event.location.id === event.value.location &&
          event.location.active &&
          event.employee.active &&
          compareInstant(event.value.from, event.value.until) < 0 &&
          event.value.before >= 0n &&
          event.value.after >= 0n &&
          event.value.revision === 1n &&
          event.value.source !== event.previous_source,
      );
      check(
        (await can_work(c, event.employee.user, event.location)) &&
          event.employee.skills.includes(event.value.skill),
      );
      const previous = await first(
        records(c, "shift.Commitment", {
          parent: event.roster,
          where: (item) => item.source === event.previous_source,
          order: ["id"],
        }),
      );
      check(
        previous !== null &&
          same(previous.location, event.location) &&
          previous.kind === event.value.kind &&
          previous.revision === event.previous_revision,
      );
      const release_fence = await first(
        records(c, "shift.Release", {
          parent: event.roster,
          where: (item) => item.source === event.value.source,
          order: ["id"],
        }),
      );
      const candidate = await first(
        records(c, "shift.Commitment", {
          parent: event.roster,
          where: (item) => item.source === event.value.source,
          order: ["id"],
        }),
      );
      if (release_fence !== null)
        await emit(c, ReservationOutcome, {
          value: {
            source: event.value.source,
            revision: release_fence.revision,
            state: "released",
            reference: event.value.source,
          },
        });
      else if (candidate !== null) {
        check(
          candidate.active &&
            same(candidate.previous, previous) &&
            candidate.revision === event.value.revision &&
            same(candidate.employee, event.employee) &&
            same(candidate.location, event.location) &&
            candidate.kind === event.value.kind &&
            candidate.skill === event.value.skill &&
            compareInstant(candidate.from, event.value.from) === 0 &&
            compareInstant(candidate.until, event.value.until) === 0 &&
            candidate.before === event.value.before &&
            candidate.after === event.value.after,
        );
        await emit(c, ReservationOutcome, {
          value: {
            source: candidate.source,
            revision: candidate.revision,
            state: candidate.conflict || !(await eligible(c, candidate)) ? "unavailable" : "confirmed",
            reference: candidate.id,
          },
        });
      } else {
        check(
          previous.active &&
            !(await any(
              records(c, "shift.Commitment", { parent: event.roster }),
              (item) => item.active && same(item.previous, previous),
            )),
        );
        const conflicts = await collect(
          records(c, "shift.Commitment", {
            parent: event.roster,
            where: (item) =>
              !same(item, previous) &&
              item.active &&
              same(item.employee, event.employee) &&
              overlaps(
                subtractDuration(event.value.from, event.value.before),
                addDuration(event.value.until, event.value.after),
                subtractDuration(item.from, item.before),
                addDuration(item.until, item.after),
              ),
          }),
        );
        const available =
          (await any(
            records(c, "shift.Availability", { parent: event.roster }),
            (window) =>
              same(window.employee, event.employee) &&
              window.available &&
              compareInstant(window.from, subtractDuration(event.value.from, event.value.before)) <=
                0 &&
              compareInstant(addDuration(event.value.until, event.value.after), window.until) <= 0,
          )) &&
          !(await any(
            records(c, "shift.Availability", { parent: event.roster }),
            (window) =>
              same(window.employee, event.employee) &&
              !window.available &&
              overlaps(
                subtractDuration(event.value.from, event.value.before),
                addDuration(event.value.until, event.value.after),
                window.from,
                window.until,
              ),
          ));
        const compatible = await all(
          conflicts,
          async (item) =>
            item.kind === "duty" &&
            !item.conflict &&
            (await eligible(c, item)) &&
            same(item.location, event.location) &&
            compareInstant(item.from, event.value.from) <= 0 &&
            compareInstant(event.value.until, item.until) <= 0 &&
            ["visit", "appointment", "interview"].includes(event.value.kind),
        );
        if (
          !available ||
          !compatible ||
          !(await travel_entered(
            c,
            event.roster,
            event.employee,
            event.location,
            event.value.from,
            event.value.until,
            event.value.before,
            event.value.after,
            previous,
          ))
        )
          await emit(c, ReservationOutcome, {
            value: {
              source: event.value.source,
              revision: event.value.revision,
              state: "unavailable",
              detail: "Employee commitment unavailable",
            },
          });
        else {
          const candidate = await create(c, "shift.Commitment", {
            parent: event.roster,
            employee: event.employee,
            location: event.location,
            from: event.value.from,
            until: event.value.until,
            before: event.value.before,
            after: event.value.after,
            skill: event.value.skill,
            kind: event.value.kind,
            source: event.value.source,
            previous,
            revision: event.value.revision,
          });
          await emit(c, ReservationOutcome, {
            value: {
              source: candidate.source,
              revision: candidate.revision,
              state: "confirmed",
              reference: candidate.id,
            },
          });
        }
      }
    },
    async release_connected(c, { event }) {
      check(event.revision > 0n);
      const release_fence = await first(
        records(c, "shift.Release", {
          parent: event.roster,
          where: (item) => item.source === event.source,
          order: ["id"],
        }),
      );
      if (release_fence === null)
        await create(c, "shift.Release", {
          parent: event.roster,
          source: event.source,
          revision: event.revision,
        });
      else if (event.revision > release_fence.revision)
        await set(c, release_fence, { revision: event.revision });
      for await (const commitment of records(c, "shift.Commitment", {
        parent: event.roster,
        where: (item) => item.source === event.source && item.active,
        limit: 1n,
      })) {
        check(event.revision >= commitment.revision);
        check(commitment.kind !== "duty" || !(await any(
          records(c, "shift.Commitment", { parent: event.roster }),
          (dependent) => dependent.active && same(dependent.employee, commitment.employee) &&
            ["visit", "appointment", "interview"].includes(dependent.kind) &&
            overlaps(dependent.from, dependent.until, commitment.from, commitment.until),
        )));
        await set(c, commitment, { active: false, revision: event.revision });
      }
      await emit(c, ReservationOutcome, {
        value: {
          source: event.source,
          revision: event.revision,
          state: "released",
          reference: event.source,
        },
      });
    },
  };
}

export async function rosterPage(c, bindings) {
  return renderPage(
    c,
    rosterPageDescriptor,
    () => [
      form({ context: c, operation: "shift.Roster.create" }),
      list({
        context: c,
        model: "shift.Roster",
        renderRow: (roster, v) => [
          card({
            context: v,
            title: message("Roster assignment", { nl: "Roostertoewijzing" }),
            children: [form({ context: v, operation: "shift.assign", arguments: { roster } })],
          }),
          card({
            context: v,
            title: message("Dated employee commitments", { nl: "Gedateerde personeelsinzet" }),
            children: [
              calendar({
                context: v,
                model: "shift.Commitment",
                parent: roster,
                start: "from",
                end: "until",
                filter: ["location", "kind", "conflict"],
                defaults: { location: c.preferences.shift.location },
                renderRow: (commitment, cv) => [
                  text({
                    context: cv,
                    values: [
                      commitment.employee,
                      commitment.skill,
                      commitment.active,
                      commitment.conflict,
                    ],
                  }),
                  actions({ context: cv, operations: ["shift.recover_commitment"], boundArgs: { commitment } }),
                  list({
                    context: cv,
                    model: "shift.Duty",
                    parent: commitment,
                    renderRow: (duty, dv) => [
                      text({
                        context: dv,
                        values: [
                          duty.role,
                          duty.published_revision,
                          duty.override_reason,
                          duty.published_by,
                        ],
                      }),
                      actions({
                        context: dv,
                        operations: ["shift.publish", "shift.cancel", "shift.reconcile"],
                        boundArgs: { duty },
                      }),
                      history({ context: dv, record: duty }),
                      table({
                        context: dv,
                        model: "shift.Notice",
                        parent: duty,
                        columns: ["kind", "revision", "state"],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          card({
            context: v,
            title: message("Coverage requirements", { nl: "Bezettingsvereisten" }),
            children: [
              form({
                context: v,
                operation: "shift.Coverage.create",
                arguments: { parent: roster },
              }),
              table({
                context: v,
                model: "shift.Coverage",
                parent: roster,
                columns: ["location", "role", "from", "until", "minimum", "met"],
                filter: ["location"],
                defaults: { location: c.preferences.shift.location },
                renderRow: (coverage, cv) =>
                  edit({ context: cv, operation: "shift.Coverage.update", record: coverage }),
              }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function minePage(c, bindings) {
  return renderPage(
    c,
    minePageDescriptor,
    () => [
      card({
        context: c,
        title: message("Your availability", { nl: "Jouw beschikbaarheid" }),
        children: [
          form({ context: c, operation: "shift.Availability.create" }),
          list({
            context: c,
            model: "shift.Availability",
            renderRow: (availability, v) => [
              text({
                context: v,
                values: [availability.from, availability.until, availability.available],
              }),
              edit({ context: v, operation: "shift.Availability.update", record: availability }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Published duties and swap decisions", {
          nl: "Gepubliceerde diensten en ruilbesluiten",
        }),
        children: [
          list({
            context: c,
            model: "shift.Duty",
            display: "split",
            renderRow: (duty, v) => [
              text({
                context: v,
                values: [
                  duty.parent.location,
                  duty.parent.from,
                  duty.parent.until,
                  duty.parent.skill,
                  duty.role,
                  duty.published,
                  duty.published_revision,
                  duty.parent.before,
                  duty.parent.after,
                  duty.parent.conflict,
                ],
              }),
              history({ context: v, record: duty }),
              table({
                context: v,
                model: "shift.Notice",
                parent: duty,
                columns: ["kind", "revision", "state"],
              }),
              form({ context: v, operation: "shift.request_swap", arguments: { duty } }),
              list({
                context: v,
                model: "shift.Swap",
                parent: duty,
                renderRow: (swap, sv) => [
                  text({ context: sv, values: [swap.substitute, swap.original, swap.state] }),
                  actions({
                    context: sv,
                    operations: ["shift.accept", "shift.decline"],
                    boundArgs: { swap },
                  }),
                  history({ context: sv, record: swap }),
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
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_worker, test_site } = imported;
  const roster = {
    model: "shift.Roster",
    dependencies: [],
    value: async (c, s) => ({ name: "Operator" }),
  };
  const substitute = {
    model: "employee.Employee",
    dependencies: [test_site],
    value: async (c, s) => ({
      user: s.other,
      home: s.test_site,
      start: date("2026-10-01"),
      role: "Reception",
      skills: ["reception"],
    }),
  };
  const assignment = {
    model: "shift.Commitment",
    dependencies: [roster, test_site, test_worker],
    value: async (c, s) => ({
      parent: s.roster,
      employee: s.test_worker,
      location: s.test_site,
      from: datetime("2099-01-01T09:00:00Z"),
      until: datetime("2099-01-01T17:00:00Z"),
      skill: "reception",
      kind: "duty",
      source: "duty",
    }),
  };
  const duty = {
    model: "shift.Duty",
    dependencies: [assignment],
    value: async (c, s) => ({ parent: s.assignment, role: "Reception", published: true }),
  };
  const working = {
    model: "shift.Availability",
    dependencies: [roster, test_worker],
    value: async (c, s) => ({
      parent: s.roster,
      employee: s.test_worker,
      from: datetime("2099-01-01T08:00:00Z"),
      until: datetime("2099-01-01T18:00:00Z"),
    }),
  };
  const replacement_hours = {
    model: "shift.Availability",
    dependencies: [roster, substitute],
    value: async (c, s) => ({
      parent: s.roster,
      employee: s.substitute,
      from: datetime("2099-01-01T08:00:00Z"),
      until: datetime("2099-01-01T18:00:00Z"),
    }),
  };
  const target = {
    model: "shift.Coverage",
    dependencies: [roster, test_site],
    value: async (c, s) => ({
      parent: s.roster,
      location: s.test_site,
      role: "Reception",
      from: datetime("2099-01-01T09:00:00Z"),
      until: datetime("2099-01-01T17:00:00Z"),
    }),
  };
  const afternoon = {
    model: "shift.Commitment",
    dependencies: [roster, substitute, test_site],
    value: async (c, s) => ({
      parent: s.roster,
      employee: s.substitute,
      location: s.test_site,
      from: datetime("2099-01-01T13:00:00Z"),
      until: datetime("2099-01-01T17:00:00Z"),
      skill: "reception",
      kind: "duty",
      source: "afternoon",
    }),
  };
  const afternoon_duty = {
    model: "shift.Duty",
    dependencies: [afternoon],
    value: async (c, s) => ({ parent: s.afternoon, role: "Reception", published: true }),
  };
  const proposed = {
    model: "shift.Swap",
    dependencies: [duty, substitute, test_worker],
    value: async (c, s) => ({
      parent: s.duty,
      substitute: s.test_worker,
      original: s.substitute,
      revision: 1n,
    }),
  };
  const away = {
    model: "rent_catalog.Location", dependencies: [],
    value: async (c, s) => ({ name: "Second site", address: "2 Example Road", timezone: "Europe/Brussels", currency: "EUR", hours: "09:00–18:00", arrival: "Report to reception" }),
  };
  const unavailable = {
    model: "shift.Availability", dependencies: [roster, test_worker],
    value: async (c, s) => ({ parent: s.roster, employee: s.test_worker, from: datetime("2099-01-01T17:00:00Z"), until: datetime("2099-01-01T17:15:00Z"), available: false }),
  };
  const notice_attempt = { dependencies: [], delivery: "shift.Mail.send", values: async (c, s) => ({ request: { to: "staff@example.test", subject: "Roster", body: "Review the current roster" } }) };
  const notification = { model: "shift.Notice", dependencies: [duty, notice_attempt], value: async (c, s) => ({ parent: s.duty, recipient: s.self, revision: 1n, kind: "published", delivery: s.notice_attempt }) };
  return {
    notice_attempt,
    notification,
    away,
    unavailable,
    working,
    replacement_hours,
    target,
    afternoon,
    afternoon_duty,
    assignment,
    duty,
    proposed,
    roster,
    substitute,
    examples: [
      {
        operation: "shift.Roster.create",
        dependencies: [],
        inputs: async (c, s) => ({ name: "Operator" }),
        selectors: ["as"],
        observations: [async (c, s) => await count(records(c, "shift.Roster"))],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["shift.scheduler"],
            expected: async (c, s) => [1n],
          },
        ],
      },
      {
        operation: "shift.Roster.create",
        seed: [roster],
        dependencies: [],
        inputs: async (c, s) => ({ name: "Second roster" }),
        selectors: ["as"],
        observations: [async (c, s) => await count(records(c, "shift.Roster"))],
        rows: [
          { dependencies: [], values: async (c, s) => ["shift.scheduler"], error: "rule_failed" },
        ],
      },
      {
        operation: "shift.assign", seed: [working, assignment], dependencies: [roster, test_worker, away],
        inputs: async (c, s) => ({ roster: s.roster, employee: s.test_worker, location: s.away, from: datetime("2099-01-01T17:30:00Z"), until: datetime("2099-01-01T18:00:00Z"), role: "Reception", skill: "reception" }),
        selectors: ["as", "before", "test_worker.locations", "test_worker.role", "test_worker.skills"],
        observations: [async (c, s) => await count(records(c, "shift.Commitment", { parent: s.roster }))],
        rows: [
          { dependencies: [], values: async (c, s) => ["shift.scheduler", 1800000n, [s.test_site, s.away], "Reception", ["reception"]], expected: async (c, s) => [2n] },
          { dependencies: [], values: async (c, s) => ["shift.scheduler", 0n, [s.test_site, s.away], "Reception", ["reception"]], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["shift.scheduler", 3600000n, [s.test_site, s.away], "Reception", ["reception"]], error: "rule_failed" },
        ],
      },
      {
        operation: "shift.assign", seed: [working, assignment, unavailable], dependencies: [roster, test_worker, away],
        inputs: async (c, s) => ({ roster: s.roster, employee: s.test_worker, location: s.away, from: datetime("2099-01-01T17:30:00Z"), until: datetime("2099-01-01T18:00:00Z"), role: "Reception", skill: "reception", before: 1800000n }),
        selectors: ["as", "test_worker.locations", "test_worker.role", "test_worker.skills"],
        observations: [async (c, s) => await count(records(c, "shift.Commitment", { parent: s.roster }))],
        rows: [{ dependencies: [], values: async (c, s) => ["shift.scheduler", [s.test_site, s.away], "Reception", ["reception"]], error: "rule_failed" }],
      },
      {
        operation: "shift.publish",
        seed: [working, target],
        dependencies: [duty],
        inputs: async (c, s) => ({ duty: s.duty, override_reason: null }),
        selectors: [
          "as",
          "duty.published",
          "assignment.employee.skills",
          "assignment.employee.role",
        ],
        observations: [async (c, s) => s.duty.published],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["shift.scheduler", false, ["reception"], "Reception"],
            expected: async (c, s) => [true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["shift.scheduler", false, [], "Reception"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "shift.publish",
        seed: [working, replacement_hours, target, afternoon_duty],
        dependencies: [duty],
        inputs: async (c, s) => ({ duty: s.duty, override_reason: null }),
        selectors: [
          "as",
          "duty.published",
          "assignment.until",
          "assignment.employee.skills",
          "assignment.employee.role",
        ],
        observations: [async (c, s) => s.duty.published],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "shift.scheduler",
              false,
              datetime("2099-01-01T13:00:00Z"),
              ["reception"],
              "Reception",
            ],
            expected: async (c, s) => [true],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "shift.scheduler",
              false,
              datetime("2099-01-01T12:00:00Z"),
              ["reception"],
              "Reception",
            ],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "shift.accept", seed: [working], dependencies: [proposed],
        inputs: async (c, s) => ({ swap: s.proposed }),
        selectors: ["as", "assignment.employee", "test_worker.role", "test_worker.skills", "assignment.conflict", "assignment.active", "duty.published"],
        observations: [async (c, s) => s.swap.state, async (c, s) => s.assignment.employee, async (c, s) => s.assignment.conflict],
        rows: [
          { dependencies: [], values: async (c, s) => ["members", s.substitute, "Reception", ["reception"], true, true, true], expected: async (c, s) => ["accepted", s.test_worker, false] },
          { dependencies: [], values: async (c, s) => ["members", s.substitute, "Reception", ["reception"], true, false, true], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["members", s.substitute, "Reception", ["reception"], true, true, false], error: "rule_failed" },
        ],
      },
      {
        operation: "shift.reconcile", seed: [working, target], dependencies: [duty, test_worker],
        inputs: async (c, s) => ({ duty: s.duty, employee: s.test_worker, from: datetime("2099-01-01T09:00:00Z"), until: datetime("2099-01-01T17:00:00Z"), reason: "Restore eligible coverage" }),
        selectors: ["as", "assignment.employee.role", "assignment.employee.skills", "assignment.conflict", "from", "until"],
        observations: [async (c, s) => s.assignment.conflict, async (c, s) => s.duty.published_revision],
        rows: [
          { dependencies: [], values: async (c, s) => ["shift.scheduler", "Reception", ["reception"], true, datetime("2099-01-01T09:00:00Z"), datetime("2099-01-01T17:00:00Z")], expected: async (c, s) => [false, 2n] },
          { dependencies: [], values: async (c, s) => ["shift.scheduler", "Reception", ["reception"], false, datetime("2099-01-01T17:00:00Z"), datetime("2099-01-01T18:00:00Z")], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["shift.scheduler", "Reception", ["reception"], false, datetime("2099-01-01T09:00:00Z"), datetime("2099-01-01T13:00:00Z")], error: "rule_failed" },
        ],
      },
      {
        operation: "shift.reserve_connected", seed: [working, assignment], dependencies: [roster, test_worker, test_site],
        inputs: async (c, s) => ({ event: { roster: s.roster, employee: s.test_worker, location: s.test_site, value: { source: "duty", employee: s.self, location: s.test_site.id, from: datetime("2099-01-01T09:00:00Z"), until: datetime("2099-01-01T17:00:00Z"), before: 0n, after: 0n, skill: "reception", kind: "duty", revision: 1n } } }),
        selectors: ["event.value.revision", "event.value.until", "test_worker.skills"],
        observations: [async (c, s) => s.assignment.from, async (c, s) => s.assignment.until, async (c, s) => s.assignment.revision],
        rows: [
          { dependencies: [], values: async (c, s) => [1n, datetime("2099-01-01T17:00:00Z"), ["reception"]], expected: async (c, s) => [datetime("2099-01-01T09:00:00Z"), datetime("2099-01-01T17:00:00Z"), 1n] },
          { dependencies: [], values: async (c, s) => [2n, datetime("2099-01-01T18:00:00Z"), ["reception"]], error: "rule_failed" },
        ],
      },
      {
        operation: "shift.recover_commitment", seed: [working, replacement_hours, proposed], dependencies: [assignment],
        inputs: async (c, s) => ({ commitment: s.assignment }),
        selectors: ["as", "test_worker.role", "test_worker.skills", "proposed.original", "proposed.substitute"],
        observations: [async (c, s) => s.assignment.active, async (c, s) => s.assignment.conflict, async (c, s) => s.proposed.state],
        rows: [
          { dependencies: [], values: async (c, s) => ["shift.scheduler", "Reception", ["reception"], s.test_worker, s.substitute], expected: async (c, s) => [true, false, "open"] },
          { dependencies: [], values: async (c, s) => ["shift.scheduler", "Reception", [], s.test_worker, s.substitute], expected: async (c, s) => [true, true, "obsolete"] },
          { dependencies: [], values: async (c, s) => ["members", "Reception", ["reception"], s.test_worker, s.substitute], error: "forbidden" },
        ],
      },
      {
        operation: "shift.employee_changed",
        seed: [assignment, proposed],
        dependencies: [test_worker],
        inputs: async (c, s) => ({
          event: { employee: s.test_worker, active: false, revision: 2n },
        }),
        selectors: ["event.employee.active"],
        observations: [async (c, s) => s.assignment.conflict, async (c, s) => s.proposed.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [false],
            expected: async (c, s) => [true, "obsolete"],
          },
        ],
      },
      {
        operation: "shift.member_removed",
        seed: [assignment, proposed],
        dependencies: [],
        inputs: async (c, s) => ({
          event: { team_id: c.team.id, membership_id: "removed", user: s.self },
        }),
        selectors: ["event.user"],
        observations: [async (c, s) => s.assignment.conflict, async (c, s) => s.proposed.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [s.self],
            expected: async (c, s) => [true, "obsolete"],
          },
        ],
      },
      {
        operation: "shift.decline", seed: [notification], dependencies: [proposed, notice_attempt],
        inputs: async (c, s) => ({ swap: s.proposed }),
        selectors: ["as", "notice_attempt.status", "notice_attempt.result", "notice_attempt.error"],
        observations: [async (c, s) => s.swap.state, async (c, s) => (await delivery(c, { record: s.notification, field: "delivery" }, ["status"])).status],
        rows: [
          { dependencies: [], values: async (c, s) => ["members", "pending", null, null], expected: async (c, s) => ["rejected", "pending"] },
          { dependencies: [], values: async (c, s) => ["members", "succeeded", { reference: "accepted-roster" }, null], expected: async (c, s) => ["rejected", "succeeded"] },
          { dependencies: [], values: async (c, s) => ["members", "failed", null, { code: "provider", message: "Delivery rejected" }], expected: async (c, s) => ["rejected", "failed"] },
          { dependencies: [], values: async (c, s) => ["members", "unknown", null, { code: "timeout", message: "Acceptance uncertain" }], expected: async (c, s) => ["rejected", "unknown"] },
          { dependencies: [], values: async (c, s) => ["members", "skipped", null, null], expected: async (c, s) => ["rejected", "skipped"] },
        ],
      },
      {
        operation: "shift.decline",
        dependencies: [proposed],
        inputs: async (c, s) => ({ swap: s.proposed }),
        selectors: ["as", "swap.state"],
        observations: [async (c, s) => s.swap.state, async (c, s) => s.assignment.employee],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "open"],
            expected: async (c, s) => ["rejected", s.test_worker],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "accepted"],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["public", "open"], error: "forbidden" },
        ],
      },
    ],
  };
}
