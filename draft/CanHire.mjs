import {
  addDuration,
  any,
  all,
  active_member,
  call,
  count,
  datetime,
  emit,
  cancel,
  require as check,
  compareInstant,
  create,
  EmailV1,
  format,
  hasRole,
  int64,
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
import { can_work, Employee, hr } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";
import { start, Template } from "./onboard.mjs";
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

const ownOutcomes = message("Own application outcomes", { nl: "Eigen sollicitatieresultaten" });

const interviewerCaption = message("Interviewer", { nl: "Interviewer" });

const applicationCaption = message("Application text", { nl: "Sollicitatietekst" });

const cvCaption = message("CV attachment", { nl: "CV-bijlage" });

const sourceCaption = message("Source reference", { nl: "Bronreferentie" });

const interviewCaption = message("Interview", { nl: "Sollicitatiegesprek" });

const fromCaption = message("Start", { nl: "Begin" });

const untilCaption = message("End", { nl: "Einde" });

const feedbackCaption = message("Interview feedback", { nl: "Gespreksfeedback" });

// A second authored selectable app; this adds no wrapper or aggregate package.
export const PeopleDevelopment = {
  id: "PeopleDevelopment",
  uses: ["CanHire", "CanOnboard", "CanLearn"],
  description: message(
    "Recruit employees, prepare onboarding and acknowledge published training versions.",
    {
      nl: "Werf medewerkers, bereid hun inwerking voor en bevestig gepubliceerde opleidingsversies.",
    },
  ),
};

const careersPageDescriptor = {
  owner: "hire",
  path: "/careers",
  title: message("Careers", { nl: "Vacatures" }),
  description: message("Find published vacancies and submit your own application.", {
    nl: "Vind gepubliceerde vacatures en dien je eigen sollicitatie in.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    return {};
  },
  render: careersPage,
};

const minePageDescriptor = {
  owner: "hire",
  path: "/careers/mine",
  title: message("My applications", { nl: "Mijn sollicitaties" }),
  description: message("Follow your own submission without private interviewer feedback.", {
    nl: "Volg je eigen sollicitatie zonder private interviewerfeedback.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: minePage,
};

const hiringPageDescriptor = {
  owner: "hire",
  path: "/hiring",
  title: message("Hiring", { nl: "Werving" }),
  description: message("Coordinate private candidates and restricted interview evidence.", {
    nl: "Coördineer private kandidaten en afgeschermd gespreksbewijs.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "hire.recruiter"), "forbidden");
    return {};
  },
  render: hiringPage,
};

const handoffPageDescriptor = {
  owner: "hire",
  path: "/hiring/handoff",
  title: message("Hiring handoff", { nl: "Wervingsoverdracht" }),
  description: message(
    "Review hired account identity using the canonical HR employee creation and checklist workflow.",
    {
      nl: "Beoordeel de aangenomen accountidentiteit via de canonieke HR-medewerker- en checklistworkflow.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, hr), "forbidden");
    return {};
  },
  render: handoffPage,
};

const interviewsPageDescriptor = {
  owner: "hire",
  path: "/hiring/interviews",
  title: message("My interviews", { nl: "Mijn gesprekken" }),
  description: message(
    "Record private feedback only for your own active confirmed interview assignment.",
    {
      nl: "Registreer private feedback alleen voor je eigen actieve bevestigde gesprekstoewijzing.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "hire.interviewer"), "forbidden");
    return {};
  },
  render: interviewsPage,
};

export const appDefinition = {
  id: "CanHire",
  uses: ["hire"],
  description: message(
    "Help the workspace operator recruit receptionists, community managers, sales staff, and facilities technicians for specific locations.",
    {
      nl: "Help de werkplekbeheerder receptionisten, communitymanagers, verkopers en facilitaire technici voor specifieke locaties te werven.",
    },
  ),
  packages: {
    hire: {
      label: message("Recruitment", { nl: "Werving" }),
      description: message(
        "Keep vacancy intake, interview feedback and reviewed hiring handoff private.",
        {
          nl: "Houd vacatureaanmeldingen, gespreksfeedback en de beoordeelde aanstellingsoverdracht privé.",
        },
      ),
      roles: {
        recruiter: { id: "hire.recruiter", label: message("Recruiter", { nl: "Recruiter" }) },
        interviewer: { id: "hire.interviewer", label: interviewerCaption },
      },
    },
  },
  bindings: {
    "hire.Mail": { capability: EmailV1, from: "deployment.mail" },
    "hire.StaffSchedule": { capability: ScheduleV1, from: "deployment.staff_schedule" },
  },
  models: {
    "hire.Vacancy": {
      label: message("Vacancy", { nl: "Vacature" }),
      fields: {
        location: { type: Location },
        title: { type: "text", trim: true, min: 1n },
        description: { type: "text" },
        employment: { type: "text", label: message("Employment type", { nl: "Dienstverband" }) },
        skills: {
          type: "text",
          array: true,
          default: [],
          label: message("Skills", { nl: "Vaardigheden" }),
        },
        owner: { type: "user", server: "actor", label: message("Owner", { nl: "Eigenaar" }) },
        published: {
          type: "bool",
          default: false,
          label: message("Published", { nl: "Gepubliceerd" }),
        },
        open: { type: "bool", default: true, label: message("Open", { nl: "Open" }) },
        retention_days: {
          type: "int",
          default: 180n,
          min: 1n,
          label: message("Candidate retention days", { nl: "Bewaartermijn kandidaten in dagen" }),
        },
        retention_until: {
          type: "datetime",
          nullable: true,
          label: message("Candidate expiry", { nl: "Vervaldatum kandidaten" }),
        },
        closed_at: {
          type: "datetime",
          nullable: true,
          label: message("Closed at", { nl: "Gesloten op" }),
        },
      },
      invariants: ["Vacancy.require.1"],
      readGrants: [
        {
          rule: "Vacancy.read.1",
          fields: ["location", "title", "description", "employment", "skills"],
        },
        { rule: "Vacancy.read.2" },
      ],
    },
    "hire.Candidate": {
      parent: "hire.Vacancy",
      retainUntil: "Candidate",
      locks: ["Candidate.lock.1"],
      label: message("Candidate", { nl: "Kandidaat" }),
      fields: {
        account: { type: "user", nullable: true, label: message("Account", { nl: "Account" }) },
        name: { type: "text" },
        email: { type: "email" },
        application: { type: "text", label: applicationCaption },
        cv: { type: "file", nullable: true, label: cvCaption },
        source: { type: "text", label: sourceCaption },
        stage: {
          type: "enum",
          cases: ["applied", "interview", "offer", "hired", "rejected", "withdrawn"],
          default: "applied",
          label: {
            text: message("Hiring stage", { nl: "Sollicitatiefase" }),
            values: {
              applied: message("Applied", { nl: "Gesolliciteerd" }),
              interview: interviewCaption,
              offer: message("Offer", { nl: "Aanbod" }),
              hired: message("Hired", { nl: "Aangenomen" }),
              rejected: message("Rejected", { nl: "Afgewezen" }),
              withdrawn: message("Withdrawn", { nl: "Ingetrokken" }),
            },
          },
        },
        reason: { type: "text", nullable: true },
        previous_stage: {
          type: "hire.Candidate.stage",
          nullable: true,
          label: message("Previous active stage", { nl: "Vorige actieve fase" }),
        },
        identity_review: {
          type: "text",
          nullable: true,
          label: message("Reviewed account evidence", { nl: "Bewijs beoordeeld account" }),
        },
        onboarding_reference: {
          type: "text",
          nullable: true,
          label: message("Onboarding reference", { nl: "Inwerkreferentie" }),
        },
      },
      unique: [{ fields: ["email"] }],
      readGrants: [
        {
          rule: "Candidate.read.hr",
          fields: ["name", "email", "account", "stage", "onboarding_reference", "identity_review"],
        },
        { rule: "Candidate.read.1" },
        {
          rule: "Candidate.read.2",
          fields: ["name", "email", "application", "cv", "stage", "reason"],
        },
        { rule: "Candidate.read.3", fields: ["name", "application", "cv", "stage"] },
      ],
    },
    "hire.Interview": {
      parent: "hire.Candidate",
      label: interviewCaption,
      fields: {
        interviewer: { type: Employee, label: interviewerCaption },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        timezone: { type: "timezone" },
        notes: { type: "text", nullable: true },
        feedback: { type: "text", nullable: true, label: feedbackCaption },
        state: {
          type: "enum",
          cases: ["pending", "confirmed", "cancelled", "unavailable", "failed"],
          default: "pending",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              pending: message("Pending", { nl: "In afwachting" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              cancelled: message("Cancelled", { nl: "Geannuleerd" }),
              unavailable: message("Unavailable", { nl: "Niet beschikbaar" }),
              failed: message("Failed", { nl: "Mislukt" }),
            },
          },
        },
        previous: {
          type: "hire.Interview",
          nullable: true,
          label: message("Retained interview", { nl: "Behouden gesprek" }),
        },
        notice_delivery: {
          type: "text",
          nullable: true,
          label: message("Reminder reference", { nl: "Herinneringsreferentie" }),
        },
        notice_state: {
          type: "enum",
          cases: ["none", "pending", "succeeded", "failed", "unknown", "skipped"],
          default: "none",
          label: {
            text: message("Reminder delivery", { nl: "Verzending herinnering" }),
            values: {
              none: message("Not requested", { nl: "Niet aangevraagd" }),
              pending: message("Pending", { nl: "In afwachting" }),
              succeeded: message("Sent", { nl: "Verzonden" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
              skipped: message("Skipped", { nl: "Overgeslagen" }),
            },
          },
        },
        release_delivery: {
          type: "text",
          nullable: true,
          label: message("Release reference", { nl: "Vrijgavereferentie" }),
        },
        release_state: {
          type: "enum",
          cases: ["none", "pending", "released", "failed", "unknown"],
          default: "none",
          label: {
            text: message("Reservation release", { nl: "Reservering vrijgeven" }),
            values: {
              none: message("Not requested", { nl: "Niet aangevraagd" }),
              pending: message("Pending", { nl: "In afwachting" }),
              released: message("Released", { nl: "Vrijgegeven" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
            },
          },
        },
        source: { type: "text", unique: true, label: sourceCaption },
        delivery: {
          type: "text",
          nullable: true,
          label: message("Delivery reference", { nl: "Verzendingsreferentie" }),
        },
      },
      readGrants: [{ rule: "Interview.read.1" }, { rule: "Interview.read.2" }],
      invariants: ["Interview.require.1"],
      locks: ["Interview.lock.1"],
    },
  },
  events: {
    "hire.InterviewAccepted": { fields: { interview: { type: "hire.Interview" } } },
    "hire.InterviewReminder": {
      fields: { interview: { type: "hire.Interview" }, revision: { type: "int" } },
    },
  },
  preferences: {
    hire: {
      fields: {
        location: { type: Location, nullable: true, default: null },
        stage: { type: "hire.Candidate.stage", nullable: true, default: null },
      },
    },
  },
  operations: {
    "hire.Vacancy.create": {
      handler: "createVacancy",
      kind: "create",
      model: "hire.Vacancy",
      by: "hire.recruiter",
      read: false,
      inputs: { fields: ["location", "title", "description", "employment", "skills"] },
      when: "Vacancy",
    },
    "hire.Vacancy.update": {
      handler: "updateVacancy",
      kind: "update",
      model: "hire.Vacancy",
      by: "hire.recruiter",
      read: false,
      inputs: {
        record: { type: "hire.Vacancy" },
        changes: { fields: ["title", "description", "employment", "skills", "published"] },
      },
      when: "Vacancy",
    },
    "hire.close": {
      handler: "close",
      by: "hire.recruiter",
      read: false,
      inputs: { vacancy: { type: "hire.Vacancy" } },
      label: message("Close vacancy", { nl: "Vacature sluiten" }),
      description: message(
        "Close new intake and record the fixed recruitment-retention deadline.",
        { nl: "Sluit nieuwe aanmeldingen en leg de vaste bewaartermijn voor werving vast." },
      ),
    },
    "hire.reopen_vacancy": {
      handler: "reopen_vacancy",
      by: "hire.recruiter",
      read: false,
      inputs: { vacancy: { type: "hire.Vacancy" } },
      label: message("Reopen vacancy", { nl: "Vacature heropenen" }),
      description: message("Reopen vacancy intake while preserving prior candidate outcomes.", {
        nl: "Heropen de vacature-intake met behoud van eerdere kandidaatresultaten.",
      }),
    },
    "hire.reschedule": {
      handler: "reschedule",
      by: "hire.recruiter",
      read: false,
      inputs: {
        booking: { type: "hire.Interview" },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        timezone: { type: "timezone" },
      },
      label: message("Reschedule interview", { nl: "Gesprek verplaatsen" }),
      description: message(
        "Retain the confirmed interview until its staged replacement is accepted.",
        { nl: "Behoud het bevestigde gesprek totdat de voorbereide vervanging is aanvaard." },
      ),
    },
    "hire.cancel_interview": {
      handler: "cancel_interview",
      by: "hire.recruiter",
      read: false,
      inputs: { interview: { type: "hire.Interview" }, reason: { type: "text" } },
      label: message("Cancel interview", { nl: "Gesprek annuleren" }),
      description: message(
        "Cancel one current interview and any staged replacement without losing its source fence.",
        {
          nl: "Annuleer een huidig gesprek en eventuele voorbereide vervanging met behoud van de brongrens.",
        },
      ),
    },
    "hire.retry_release": {
      handler: "retry_release",
      by: "hire.recruiter",
      read: false,
      inputs: { interview: { type: "hire.Interview" } },
      label: message("Retry release", { nl: "Vrijgave herhalen" }),
      description: message(
        "Retry an unresolved release through the same canonical scheduler source fence.",
        { nl: "Herhaal een onopgeloste vrijgave via dezelfde canonieke scheduler-brongrens." },
      ),
    },
    "hire.reopen_application": {
      handler: "reopen_application",
      by: "hire.recruiter",
      read: false,
      inputs: { candidate: { type: "hire.Candidate" }, reason: { type: "text" } },
      label: message("Reopen application", { nl: "Sollicitatie heropenen" }),
      description: message(
        "Restore the recorded active stage without erasing application history.",
        { nl: "Herstel de vastgelegde actieve fase zonder sollicitatiehistorie te wissen." },
      ),
    },
    "hire.handoff": {
      handler: "handoff",
      by: hr,
      read: false,
      inputs: {
        candidate: { type: "hire.Candidate" },
        employee: { type: Employee },
        template: { type: Template },
        evidence: {
          type: "text",
          label: message("Verified identity review", {
            nl: "Beoordeling geverifieerde identiteit",
          }),
        },
      },
      label: message("Review onboarding handoff", { nl: "Inwerkoverdracht beoordelen" }),
      description: message(
        "Match a reviewed hire to the HR-created account identity and start one readiness checklist.",
        {
          nl: "Koppel een beoordeelde aanstelling aan de door HR gemaakte accountidentiteit en start één inwerkchecklist.",
        },
      ),
    },
    "hire.apply": {
      handler: "apply",
      by: "authenticated",
      read: false,
      inputs: {
        vacancy: { type: "hire.Vacancy" },
        name: { type: "text" },
        application: { type: "text", label: applicationCaption },
        cv: { type: "file", nullable: true, default: null, label: cvCaption },
      },
      label: message("Apply", { nl: "Solliciteren" }),
      description: message("Apply once to a published open vacancy using your verified account.", {
        nl: "Solliciteer één keer op een gepubliceerde open vacature met je geverifieerde account.",
      }),
    },
    "hire.intake": {
      handler: "intake",
      by: "hire.recruiter",
      read: false,
      inputs: {
        vacancy: { type: "hire.Vacancy" },
        name: { type: "text" },
        email: { type: "email" },
        application: { type: "text", label: applicationCaption },
        cv: { type: "file", nullable: true, default: null, label: cvCaption },
        source: { type: "text", label: sourceCaption },
      },
      label: message("Record candidate intake", { nl: "Kandidaat registreren" }),
      description: message("Record recruiter-entered intake and its actual source.", {
        nl: "Registreer een door de recruiter ingevoerde kandidaat en de werkelijke bron.",
      }),
    },
    "hire.schedule": {
      handler: "schedule",
      by: "hire.recruiter",
      read: false,
      inputs: {
        candidate: { type: "hire.Candidate" },
        interviewer: { type: Employee, label: interviewerCaption },
        from: { type: "datetime", label: fromCaption },
        until: { type: "datetime", label: untilCaption },
        timezone: { type: "timezone" },
      },
      label: message("Schedule interview", { nl: "Gesprek plannen" }),
      description: message(
        "Request one interviewer reservation rather than relying on a local interview calendar.",
        {
          nl: "Vraag één interviewerreservering aan in plaats van op een lokale gesprekskalender te vertrouwen.",
        },
      ),
    },
    "hire.feedback": {
      handler: "feedback",
      by: "hire.interviewer",
      read: false,
      inputs: { interview: { type: "hire.Interview" }, notes: { type: "text" } },
      label: feedbackCaption,
      description: message("Save feedback only from the currently assigned active interviewer.", {
        nl: "Bewaar uitsluitend feedback van de momenteel toegewezen actieve interviewer.",
      }),
    },
    "hire.decide": {
      handler: "decide",
      by: "hire.recruiter",
      read: false,
      inputs: {
        candidate: { type: "hire.Candidate" },
        stage: { type: "hire.Candidate.stage" },
        reason: { type: "text" },
      },
      label: message("Record decision", { nl: "Besluit vastleggen" }),
      description: message("Record a hiring outcome without granting staff privileges.", {
        nl: "Registreer een aanstellingsresultaat zonder personeelsrechten toe te kennen.",
      }),
    },
    "hire.withdraw": {
      handler: "withdraw",
      by: "authenticated",
      read: false,
      inputs: { candidate: { type: "hire.Candidate" } },
      label: message("Withdraw", { nl: "Intrekken" }),
      description: message("Withdraw your application and cancel current interview commitments.", {
        nl: "Trek je sollicitatie in en annuleer huidige gespreksreserveringen.",
      }),
    },
  },
  handlers: {
    "hire.replacement_reserved": {
      handler: "replacement_reserved",
      on: { capability: "hire.StaffSchedule", operation: "stage", event: "completed" },
    },
    "hire.reservation_changed": {
      handler: "reservation_changed",
      on: { capability: "hire.StaffSchedule", event: "changed" },
    },
    "hire.accept_interview": { handler: "accept_interview", on: "hire.InterviewAccepted" },
    "hire.reminder_result": {
      handler: "reminder_result",
      on: { capability: "hire.Mail", operation: "send", event: "completed" },
    },
    "hire.released": {
      handler: "released",
      on: { capability: "hire.StaffSchedule", operation: "release", event: "completed" },
    },
    "hire.reservation": {
      handler: "reservation",
      on: { capability: "hire.StaffSchedule", operation: "reserve", event: "completed" },
    },
    "hire.remind": { handler: "remind", on: "hire.InterviewReminder" },
  },
  pages: [
    careersPageDescriptor,
    minePageDescriptor,
    hiringPageDescriptor,
    handoffPageDescriptor,
    interviewsPageDescriptor,
  ],
  disabled: ["hire.Vacancy.delete"],
};

export function canApp() {
  const crudWhen = { Vacancy: async (c, row) => await can_work(c, c.actor, row.location) };
  return {
    crudWhen,

    retention: { Candidate: (c, row) => row.parent.retention_until },
    locks: {
      "Candidate.lock.1": { fields: ["cv"] },
      "Interview.lock.1": {
        fields: ["interviewer", "from", "until", "timezone", "previous", "source"],
      },
    },
    read: {
      "Candidate.read.hr": (c, row) => hasRole(c, hr),
      "Vacancy.read.1": (c, row) => hasRole(c, "public") && row.published && row.open,
      "Vacancy.read.2": async (c, row) =>
        hasRole(c, "hire.recruiter") && (await can_work(c, c.actor, row.location)),
      "Candidate.read.1": async (c, row) =>
        hasRole(c, "hire.recruiter") && (await can_work(c, c.actor, row.parent.location)),
      "Candidate.read.2": (c, row) => hasRole(c, "authenticated") && same(row.account, c.actor),
      "Candidate.read.3": async (c, row) =>
        hasRole(c, "hire.interviewer") &&
        (await any(
          records(c, "hire.Interview", { parent: row }),
          (interview) =>
            same(interview.interviewer.user, c.actor) &&
            interview.state === "confirmed" &&
            interview.interviewer.active,
        )),
      "Interview.read.1": async (c, row) =>
        hasRole(c, "hire.recruiter") && (await can_work(c, c.actor, row.parent.parent.location)),
      "Interview.read.2": (c, row) =>
        hasRole(c, "hire.interviewer") &&
        same(row.interviewer.user, c.actor) &&
        row.interviewer.active,
    },
    invariants: {
      "Interview.require.1": (c, row) => compareInstant(row.from, row.until) < 0,
      "Vacancy.require.1": (c, row) =>
        row.open === (row.closed_at === null) && row.open === (row.retention_until === null),
    },
    async createVacancy(c, input) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      await create(c, "hire.Vacancy", input, { when: crudWhen.Vacancy });
    },
    async updateVacancy(c, { record, changes }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Vacancy });
    },
    async close(c, { vacancy }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check((await can_work(c, c.actor, vacancy.location)) && vacancy.open);
      const deadline = addDuration(c.now, int64(vacancy.retention_days * 86400000n));
      check(
        await all(
          records(c, "hire.Candidate", { parent: vacancy }),
          async (candidate) =>
            await all(
              records(c, "hire.Interview", { parent: candidate }),
              (interview) =>
                compareInstant(interview.until, deadline) <= 0 ||
                (["cancelled", "failed", "unavailable"].includes(interview.state) &&
                  interview.release_state === "released"),
            ),
        ),
        "rule_failed",
        message("Resolve interview commitments beyond the retention deadline before closing.", {
          nl: "Los gespreksreserveringen na de bewaartermijn op voordat je sluit.",
        }),
      );
      await set(c, vacancy, { open: false, closed_at: c.now, retention_until: deadline });
    },
    async reopen_vacancy(c, { vacancy }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check((await can_work(c, c.actor, vacancy.location)) && !vacancy.open);
      await set(c, vacancy, { open: true, closed_at: null, retention_until: null });
    },
    async reschedule(c, { booking, from, until, timezone }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.parent.location)) &&
          ["applied", "interview"].includes(booking.parent.stage) &&
          booking.state === "confirmed" &&
          booking.interviewer.active &&
          compareInstant(from, c.now) >= 0 &&
          compareInstant(from, until) < 0 &&
          (booking.parent.parent.retention_until === null ||
            compareInstant(until, booking.parent.parent.retention_until) <= 0) &&
          (compareInstant(from, booking.from) !== 0 ||
            compareInstant(until, booking.until) !== 0 ||
            timezone !== booking.timezone),
      );
      check(
        !(await any(
          records(c, "hire.Interview", { parent: booking.parent }),
          (item) => same(item.previous, booking) && item.state === "pending",
        )),
      );
      const replacement = await create(c, "hire.Interview", {
        parent: booking.parent,
        interviewer: booking.interviewer,
        from,
        until,
        timezone,
        previous: booking,
        source: c.operation.id,
      });
      const delivery = await send(c, "hire.StaffSchedule.stage", {
        value: {
          source: replacement.source,
          employee: replacement.interviewer.user,
          location: replacement.parent.parent.location.id,
          from,
          until,
          skill: "interview",
          kind: "interview",
          revision: 1n,
        },
        previous_source: booking.source,
        previous_revision: 1n,
      });
      await set(c, replacement, { delivery: delivery.id });
    },
    async cancel_interview(c, { interview, reason }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check(
        (await can_work(c, c.actor, interview.parent.parent.location)) &&
          ["pending", "confirmed"].includes(interview.state) &&
          reason.trim() !== "",
      );
      await set(c, interview, { state: "cancelled", notes: reason });
      await cancel(c, interview.id);
      const release = await send(c, "hire.StaffSchedule.release", {
        source: interview.source,
        revision: 2n,
      });
      await set(c, interview, { release_delivery: release.id, release_state: "pending" });
      for await (const replacement of records(c, "hire.Interview", {
        parent: interview.parent,
        where: (item) => same(item.previous, interview) && item.state === "pending",
        limit: 100n,
      })) {
        await set(c, replacement, { state: "cancelled" });
        await cancel(c, replacement.id);
        const replacement_release = await send(c, "hire.StaffSchedule.release", {
          source: replacement.source,
          revision: 2n,
        });
        await set(c, replacement, {
          release_delivery: replacement_release.id,
          release_state: "pending",
        });
      }
    },
    async retry_release(c, { interview }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check(
        (await can_work(c, c.actor, interview.parent.parent.location)) &&
          ["cancelled", "failed", "unavailable"].includes(interview.state) &&
          ["failed", "unknown"].includes(interview.release_state),
      );
      const release = await send(c, "hire.StaffSchedule.release", {
        source: interview.source,
        revision: 2n,
      });
      await set(c, interview, { release_delivery: release.id, release_state: "pending" });
    },
    async reopen_application(c, { candidate, reason }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check(
        (await can_work(c, c.actor, candidate.parent.location)) &&
          ["rejected", "withdrawn"].includes(candidate.stage) &&
          ["applied", "interview", "offer"].includes(candidate.previous_stage) &&
          reason.trim() !== "",
      );
      await set(c, candidate, { stage: candidate.previous_stage, reason });
    },
    async handoff(c, { candidate, employee, template, evidence }) {
      check(hasRole(c, hr), "forbidden");
      check(
        candidate.stage === "hired" &&
          candidate.onboarding_reference === null &&
          employee.active &&
          (await active_member(c, employee.user, c.team)) &&
          same(employee.home, candidate.parent.location) &&
          (candidate.account === null || same(candidate.account, employee.user)) &&
          evidence.trim() !== "",
      );
      await call(c, start, { employee, template });
      await set(c, candidate, {
        account: employee.user,
        onboarding_reference: employee.id,
        identity_review: evidence,
      });
    },
    async apply(c, { vacancy, name, application, cv = null }) {
      check(hasRole(c, "authenticated"), "forbidden");
      // DESIGN supplies read-only authenticated actor.email/email_verified facts.
      // These remain trusted admission data, never client-controlled account inputs.
      check(
        c.actor.email_verified &&
          vacancy.open &&
          vacancy.published &&
          name.trim() !== "" &&
          application.trim() !== "" &&
          !(await any(
            records(c, "hire.Candidate", { parent: vacancy }),
            (candidate) => candidate.email === c.actor.email,
          )),
      );
      await create(c, "hire.Candidate", {
        parent: vacancy,
        account: c.actor,
        name,
        email: c.actor.email,
        application,
        cv,
        source: "Verified intake",
      });
    },
    async intake(c, { vacancy, name, email, application, cv = null, source }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check((await can_work(c, c.actor, vacancy.location)) && vacancy.open && source.trim() !== "");
      await create(c, "hire.Candidate", { parent: vacancy, name, email, application, cv, source });
    },
    async schedule(c, { candidate, interviewer, from, until, timezone }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check(
        (await can_work(c, c.actor, candidate.parent.location)) &&
          ["applied", "interview"].includes(candidate.stage) &&
          interviewer.active &&
          (await can_work(c, interviewer.user, candidate.parent.location)) &&
          compareInstant(from, c.now) >= 0 &&
          compareInstant(from, until) < 0 &&
          (candidate.parent.retention_until === null ||
            compareInstant(until, candidate.parent.retention_until) <= 0),
      );
      const interview = await create(c, "hire.Interview", {
        parent: candidate,
        interviewer,
        from,
        until,
        timezone,
        source: c.operation.id,
      });
      const delivery = await send(c, "hire.StaffSchedule.reserve", {
        value: {
          source: interview.source,
          employee: interviewer.user,
          location: candidate.parent.location.id,
          from,
          until,
          skill: "interview",
          kind: "interview",
          revision: 1n,
        },
      });
      await set(c, interview, { delivery: delivery.id });
    },
    async feedback(c, { interview, notes }) {
      check(hasRole(c, "hire.interviewer"), "forbidden");
      check(
        same(interview.interviewer.user, c.actor) &&
          interview.interviewer.active &&
          interview.state === "confirmed" &&
          ["applied", "interview", "offer"].includes(interview.parent.stage) &&
          notes.trim() !== "",
      );
      await set(c, interview, { feedback: notes });
    },
    async decide(c, { candidate, stage, reason }) {
      check(hasRole(c, "hire.recruiter"), "forbidden");
      check(
        (await can_work(c, c.actor, candidate.parent.location)) &&
          ["offer", "hired", "rejected"].includes(stage) &&
          reason.trim() !== "" &&
          ["applied", "interview", "offer"].includes(candidate.stage),
      );
      if (stage === "rejected") await set(c, candidate, { previous_stage: candidate.stage });
      await set(c, candidate, { stage, reason });
      if (["hired", "rejected"].includes(stage)) {
        for await (const interview of records(c, "hire.Interview", {
          parent: candidate,
          where: (item) => ["pending", "confirmed"].includes(item.state),
          limit: 100n,
        })) {
          await set(c, interview, { state: "cancelled" });
          await cancel(c, interview.id);
          const release = await send(c, "hire.StaffSchedule.release", {
            source: interview.source,
            revision: 2n,
          });
          await set(c, interview, { release_delivery: release.id, release_state: "pending" });
        }
      }
    },
    async withdraw(c, { candidate }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(candidate.account, c.actor) &&
          ["applied", "interview", "offer"].includes(candidate.stage),
      );
      await set(c, candidate, { previous_stage: candidate.stage, stage: "withdrawn" });
      for await (const interview of records(c, "hire.Interview", {
        parent: candidate,
        where: (item) => ["pending", "confirmed"].includes(item.state),
        limit: 100n,
      })) {
        await set(c, interview, { state: "cancelled" });
        await cancel(c, interview.id);
        const release = await send(c, "hire.StaffSchedule.release", {
          source: interview.source,
          revision: 2n,
        });
        await set(c, interview, { release_delivery: release.id, release_state: "pending" });
      }
    },
    async reservation(c, { event }) {
      for await (const interview of records(c, "hire.Interview", {
        where: (item) =>
          item.delivery === event.delivery_id && item.previous === null && item.state === "pending",
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === interview.source &&
          event.result.revision === 1n &&
          event.result.state === "confirmed"
        )
          await emit(c, "hire.InterviewAccepted", { interview });
        else if (
          event.status === "failed" ||
          (event.status === "succeeded" &&
            event.result !== null &&
            event.result.source === interview.source &&
            ["unavailable", "failed", "released"].includes(event.result.state))
        ) {
          await set(c, interview, {
            state:
              event.result !== null && event.result.state === "unavailable"
                ? "unavailable"
                : "failed",
          });
          const release = await send(c, "hire.StaffSchedule.release", {
            source: interview.source,
            revision: 2n,
          });
          await set(c, interview, { release_delivery: release.id, release_state: "pending" });
        }
      }
    },
    async replacement_reserved(c, { event }) {
      for await (const interview of records(c, "hire.Interview", {
        where: (item) =>
          item.delivery === event.delivery_id && item.previous !== null && item.state === "pending",
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === interview.source &&
          event.result.revision === 1n &&
          event.result.state === "confirmed"
        )
          await emit(c, "hire.InterviewAccepted", { interview });
        else if (
          event.status === "failed" ||
          (event.status === "succeeded" &&
            event.result !== null &&
            event.result.source === interview.source &&
            ["unavailable", "failed", "released"].includes(event.result.state))
        ) {
          await set(c, interview, {
            state:
              event.result !== null && event.result.state === "unavailable"
                ? "unavailable"
                : "failed",
          });
          const release = await send(c, "hire.StaffSchedule.release", {
            source: interview.source,
            revision: 2n,
          });
          await set(c, interview, { release_delivery: release.id, release_state: "pending" });
        }
      }
    },
    async reservation_changed(c, { event }) {
      for await (const interview of records(c, "hire.Interview", {
        where: (item) => item.source === event.value.source && item.state === "pending",
        limit: 1n,
      })) {
        if (event.value.revision === 1n && event.value.state === "confirmed")
          await emit(c, "hire.InterviewAccepted", { interview });
        else if (["unavailable", "failed", "released"].includes(event.value.state)) {
          await set(c, interview, {
            state: event.value.state === "unavailable" ? "unavailable" : "failed",
          });
          const release = await send(c, "hire.StaffSchedule.release", {
            source: interview.source,
            revision: 2n,
          });
          await set(c, interview, { release_delivery: release.id, release_state: "pending" });
        }
      }
      for await (const interview of records(c, "hire.Interview", {
        where: (item) =>
          item.source === event.value.source &&
          ["pending", "failed", "unknown"].includes(item.release_state),
        limit: 1n,
      })) {
        if (event.value.state === "released" && event.value.revision >= 2n)
          await set(c, interview, { release_state: "released" });
      }
    },
    async accept_interview(c, { event }) {
      const booking = event.interview;
      if (booking.state === "pending") {
        if (
          compareInstant(booking.from, c.now) > 0 &&
          (await can_work(c, booking.interviewer.user, booking.parent.parent.location)) &&
          ["applied", "interview"].includes(booking.parent.stage) &&
          booking.interviewer.active &&
          (booking.previous === null || booking.previous.state === "confirmed")
        ) {
          await set(c, booking, { state: "confirmed" });
          await set(c, booking.parent, { stage: "interview" });
          if (booking.previous !== null) {
            await set(c, booking.previous, { state: "cancelled" });
            await cancel(c, booking.previous.id);
            const release = await send(c, "hire.StaffSchedule.release", {
              source: booking.previous.source,
              revision: 2n,
            });
            await set(c, booking.previous, {
              release_delivery: release.id,
              release_state: "pending",
            });
          }
          if (compareInstant(booking.from, addDuration(c.now, 3600000n)) > 0)
            await schedule(
              c,
              booking.id,
              subtractDuration(booking.from, 3600000n),
              "hire.InterviewReminder",
              { interview: booking, revision: 1n },
            );
        } else {
          await set(c, booking, { state: "cancelled" });
          const release = await send(c, "hire.StaffSchedule.release", {
            source: booking.source,
            revision: 2n,
          });
          await set(c, booking, { release_delivery: release.id, release_state: "pending" });
        }
      }
    },
    async released(c, { event }) {
      for await (const interview of records(c, "hire.Interview", {
        where: (item) => item.release_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === interview.source &&
          event.result.revision >= 2n &&
          event.result.state === "released"
        )
          await set(c, interview, { release_state: "released" });
        else if (event.status === "failed") await set(c, interview, { release_state: "failed" });
        else await set(c, interview, { release_state: "unknown" });
      }
    },
    async remind(c, { event }) {
      check(
        event.interview.state === "confirmed" &&
          event.revision === 1n &&
          ["applied", "interview", "offer"].includes(event.interview.parent.stage) &&
          event.interview.interviewer.active,
      );
      const notice = await send(
        c,
        "hire.Mail.send",
        {
          to: event.interview.parent.email,
          subject: format(
            c,
            message("Interview reminder", { nl: "Herinnering sollicitatiegesprek" }),
            { locale: null },
          ),
          body: event.interview.parent.parent.title,
        },
        {
          when: () =>
            event.interview.state === "confirmed" &&
            ["applied", "interview", "offer"].includes(event.interview.parent.stage),
        },
      );
      await set(c, event.interview, { notice_delivery: notice.id, notice_state: "pending" });
    },
    async reminder_result(c, { event }) {
      for await (const interview of records(c, "hire.Interview", {
        where: (item) => item.notice_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (event.status === "succeeded") await set(c, interview, { notice_state: "succeeded" });
        else if (event.status === "failed") await set(c, interview, { notice_state: "failed" });
        else if (event.status === "skipped") await set(c, interview, { notice_state: "skipped" });
        else if (event.status === "unknown") await set(c, interview, { notice_state: "unknown" });
        else await set(c, interview, { notice_state: "pending" });
      }
    },
  };
}

export async function careersPage(c, bindings) {
  return renderPage(
    c,
    careersPageDescriptor,
    () =>
      card({
        context: c,
        title: message("Published vacancies", { nl: "Gepubliceerde vacatures" }),
        children: [
          list({
            context: c,
            model: "hire.Vacancy",
            where: (vacancy) => vacancy.published && vacancy.open,
            filter: ["location"],
            search: ["title"],
            defaults: { location: c.preferences.hire.location },
            renderRow: (vacancy, view) => [
              text({
                context: view,
                values: [
                  vacancy.title,
                  vacancy.location,
                  vacancy.description,
                  vacancy.employment,
                  vacancy.skills,
                ],
              }),
              form({ context: view, operation: "hire.apply", arguments: { vacancy } }),
            ],
          }),
        ],
      }),
  );
}

export async function minePage(c, bindings) {
  return renderPage(
    c,
    minePageDescriptor,
    () =>
      card({
        context: c,
        title: ownOutcomes,
        children: [
          table({
            context: c,
            model: "hire.Candidate",
            where: (candidate) => same(candidate.account, c.actor),
            columns: ["name", "stage", "reason"],
            filter: ["stage"],
            defaults: { stage: c.preferences.hire.stage },
            renderRow: (candidate, view) =>
              details({
                context: view,
                caption: ownOutcomes,
                record: candidate,
                display: "drawer",
                children: [
                  text({ context: view, values: [candidate.application, candidate.cv] }),
                  actions({
                    context: view,
                    operations: ["hire.withdraw"],
                    boundArgs: { candidate },
                  }),
                ],
              }),
          }),
        ],
      }),
  );
}

export async function hiringPage(c, bindings) {
  return renderPage(
    c,
    hiringPageDescriptor,
    () =>
      card({
        context: c,
        title: message("Vacancy authoring", { nl: "Vacatures beheren" }),
        children: [
          form({ context: c, operation: "hire.Vacancy.create" }),
          list({
            context: c,
            model: "hire.Vacancy",
            filter: ["location"],
            search: ["title"],
            defaults: { location: c.preferences.hire.location },
            display: "split",
            renderRow: (vacancy, view) => [
              edit({ context: view, operation: "hire.Vacancy.update", record: vacancy }),
              actions({
                context: view,
                operations: ["hire.close", "hire.reopen_vacancy"],
                boundArgs: { vacancy },
              }),
              form({ context: view, operation: "hire.intake", arguments: { vacancy } }),
              list({
                context: view,
                model: "hire.Candidate",
                parent: vacancy,
                filter: ["stage"],
                defaults: { stage: c.preferences.hire.stage },
                renderRow: async (candidate, v) => [
                  text({
                    context: v,
                    values: [candidate.name, candidate.application, candidate.cv, candidate.stage],
                  }),
                  // Only this source card has the recruiter/location guard; surrounding scoped
                  // candidate/interview components retain their original current read grants.
                  hasRole(c, "hire.recruiter") &&
                  (await can_work(c, c.actor, candidate.parent.location))
                    ? card({
                        context: v,
                        title: message("Recruiter decision", { nl: "Besluit van de recruiter" }),
                        children: [text({ context: v, values: [candidate.reason] })],
                      })
                    : null,
                  actions({
                    context: v,
                    operations: ["hire.schedule", "hire.decide", "hire.reopen_application"],
                    boundArgs: { candidate },
                  }),
                  list({
                    context: v,
                    model: "hire.Interview",
                    parent: candidate,
                    order: ["from"],
                    renderRow: (interview, iv) =>
                      details({
                        context: iv,
                        caption: message("Interview evidence", { nl: "Gespreksbewijs" }),
                        record: interview,
                        display: "drawer",
                        children: [
                          text({
                            context: iv,
                            values: [
                              interview.from,
                              interview.until,
                              interview.timezone,
                              interview.state,
                              interview.feedback,
                              interview.release_state,
                              interview.notice_state,
                            ],
                          }),
                          actions({
                            context: iv,
                            operations: ["hire.reschedule"],
                            boundArgs: { booking: interview },
                          }),
                          actions({
                            context: iv,
                            operations: ["hire.cancel_interview", "hire.retry_release"],
                            boundArgs: { interview },
                          }),
                          form({
                            context: iv,
                            operation: "hire.feedback",
                            arguments: { interview },
                          }),
                        ],
                      }),
                  }),
                  history({ context: v, record: candidate }),
                ],
              }),
            ],
          }),
        ],
      }),
  );
}

export async function handoffPage(c, bindings) {
  return renderPage(
    c,
    handoffPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Reviewed employee identity", { nl: "Beoordeelde medewerkeridentiteit" }),
        children: [
          form({ context: c, operation: "employee.Employee.create" }),
          list({
            context: c,
            model: "hire.Candidate",
            where: (candidate) =>
              candidate.stage === "hired" && candidate.onboarding_reference === null,
            renderRow: (candidate, view) => [
              text({ context: view, values: [candidate.name, candidate.email, candidate.account] }),
              form({ context: view, operation: "hire.handoff", arguments: { candidate } }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function interviewsPage(c, bindings) {
  return renderPage(
    c,
    interviewsPageDescriptor,
    () => [
      list({
        context: c,
        model: "hire.Interview",
        where: (interview) =>
          same(interview.interviewer.user, c.actor) &&
          interview.interviewer.active &&
          interview.state === "confirmed",
        order: ["from"],
        renderRow: (interview, view) => [
          text({
            context: view,
            values: [
              interview.parent.name,
              interview.parent.application,
              interview.parent.cv,
              interview.from,
              interview.until,
              interview.timezone,
              interview.feedback,
            ],
          }),
          form({ context: view, operation: "hire.feedback", arguments: { interview } }),
        ],
      }),
    ],
  );
}

/* Canonical scheduler staging and release fences are declared by CanShift;
 * provider adapters, delivery reconciliation, mail delivery UI and nullable
 * retention execution remain unimplemented. Authored examples are not run here.
 */

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
  { provider: "onboard", member: "test_template", alias: "test_template" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_site, test_worker, test_template } = imported;
  const vacancy = {
    model: "hire.Vacancy",
    dependencies: [test_site],
    value: async (c, s) => ({
      location: s.test_site,
      title: "Reception",
      description: "Reception role",
      employment: "Full-time",
    }),
  };
  const applicant = {
    model: "hire.Candidate",
    dependencies: [vacancy],
    value: async (c, s) => ({
      parent: s.vacancy,
      account: s.self,
      name: "Applicant",
      email: "applicant@example.test",
      application: "Application",
      source: "Verified intake",
    }),
  };
  const booked = {
    model: "hire.Interview",
    dependencies: [applicant, test_worker],
    value: async (c, s) => ({
      parent: s.applicant,
      interviewer: s.test_worker,
      from: datetime("2099-01-01T09:00:00Z"),
      until: datetime("2099-01-01T10:00:00Z"),
      timezone: "Europe/Brussels",
      state: "confirmed",
      source: "original-interview",
    }),
  };
  const proposed = {
    model: "hire.Interview",
    dependencies: [applicant, test_worker, booked],
    value: async (c, s) => ({
      parent: s.applicant,
      interviewer: s.test_worker,
      from: datetime("2099-01-01T10:00:00Z"),
      until: datetime("2099-01-01T11:00:00Z"),
      timezone: "Europe/Brussels",
      previous: s.booked,
      source: "replacement-interview",
      delivery: "move-interview",
    }),
  };
  return {
    proposed,
    booked,
    applicant,
    vacancy,
    examples: [
      {
        operation: "hire.replacement_reserved",
        dependencies: [test_worker, booked, proposed],
        inputs: async (c, s) => ({
          event: {
            delivery_id: "move-interview",
            status: "succeeded",
            result: {
              source: "replacement-interview",
              revision: 1n,
              state: "unavailable",
              reference: null,
              detail: "Interviewer unavailable",
            },
            error: null,
          },
        }),
        selectors: ["event.result.state"],
        observations: [async (c, s) => s.proposed.state, async (c, s) => s.booked.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["unavailable"],
            expected: async (c, s) => ["unavailable", "confirmed"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["confirmed"],
            expected: async (c, s) => ["pending", "confirmed"],
          },
        ],
      },
      {
        operation: "hire.accept_interview",
        dependencies: [test_worker, booked, proposed],
        inputs: async (c, s) => ({ event: { interview: s.proposed } }),
        selectors: ["event.interview.state", "event.interview.previous.state"],
        observations: [
          async (c, s) => s.proposed.state,
          async (c, s) => s.booked.state,
          async (c, s) => s.applicant.stage,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["pending", "confirmed"],
            expected: async (c, s) => ["confirmed", "cancelled", "interview"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["cancelled", "confirmed"],
            expected: async (c, s) => ["cancelled", "confirmed", "applied"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["pending", "cancelled"],
            expected: async (c, s) => ["cancelled", "cancelled", "applied"],
          },
        ],
      },
      {
        operation: "hire.close",
        dependencies: [test_worker, vacancy],
        inputs: async (c, s) => ({ vacancy: s.vacancy }),
        selectors: ["as", "vacancy.open"],
        observations: [
          async (c, s) => s.vacancy.open,
          async (c, s) => s.vacancy.closed_at,
          async (c, s) => s.vacancy.retention_until,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", true],
            expected: async (c, s) => [false, c.now, addDuration(c.now, 15552000000n)],
          },
          { dependencies: [], values: async (c, s) => ["public", true], error: "forbidden" },
        ],
      },
      {
        operation: "hire.close",
        dependencies: [test_worker, booked, vacancy],
        inputs: async (c, s) => ({ vacancy: s.vacancy }),
        selectors: ["as"],
        observations: [async (c, s) => s.vacancy.open],
        rows: [
          { dependencies: [], values: async (c, s) => ["hire.recruiter"], error: "rule_failed" },
        ],
      },
      {
        operation: "hire.reopen_vacancy",
        dependencies: [test_worker, vacancy],
        inputs: async (c, s) => ({ vacancy: s.vacancy }),
        selectors: ["as", "vacancy.open", "vacancy.closed_at", "vacancy.retention_until"],
        observations: [
          async (c, s) => s.vacancy.open,
          async (c, s) => s.vacancy.closed_at,
          async (c, s) => s.vacancy.retention_until,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "hire.recruiter",
              false,
              datetime("2099-01-01T00:00:00Z"),
              datetime("2099-06-30T00:00:00Z"),
            ],
            expected: async (c, s) => [true, null, null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", true, null, null],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "hire.reschedule",
        dependencies: [test_worker, booked],
        inputs: async (c, s) => ({
          booking: s.booked,
          until: datetime("2099-01-01T11:00:00Z"),
          timezone: "Europe/Brussels",
        }),
        selectors: ["as", "from"],
        observations: [
          async (c, s) => s.booking.state,
          async (c, s) => await count(records(c, "hire.Interview", { parent: s.booking.parent })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", datetime("2099-01-01T10:00:00Z")],
            expected: async (c, s) => ["confirmed", 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", datetime("2099-01-01T12:00:00Z")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", datetime("2099-01-01T10:00:00Z")],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "hire.cancel_interview",
        dependencies: [test_worker, booked],
        inputs: async (c, s) => ({ interview: s.booked, reason: "Candidate unavailable" }),
        selectors: ["as", "interview.state"],
        observations: [
          async (c, s) => s.interview.state,
          async (c, s) => s.interview.release_state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", "confirmed"],
            expected: async (c, s) => ["cancelled", "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", "cancelled"],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["public", "confirmed"], error: "forbidden" },
        ],
      },
      {
        operation: "hire.reopen_application",
        dependencies: [test_worker, applicant],
        inputs: async (c, s) => ({ candidate: s.applicant, reason: "Reviewed correction" }),
        selectors: ["as", "candidate.stage", "candidate.previous_stage"],
        observations: [async (c, s) => s.candidate.stage],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", "rejected", "offer"],
            expected: async (c, s) => ["offer"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", "withdrawn", "interview"],
            expected: async (c, s) => ["interview"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", "hired", "offer"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "hire.handoff",
        dependencies: [test_worker, applicant, test_template],
        inputs: async (c, s) => ({
          candidate: s.applicant,
          employee: s.test_worker,
          template: s.test_template,
          evidence: "Verified account matched to the accepted candidate",
        }),
        selectors: ["as", "candidate.stage", "candidate.account"],
        observations: [async (c, s) => s.candidate.onboarding_reference],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", "hired", s.self],
            expected: async (c, s) => [s.employee.id],
          },
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", "offer", s.self],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", "hired", s.other],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["hire.recruiter", "hired", s.self],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "hire.withdraw",
        dependencies: [applicant],
        inputs: async (c, s) => ({ candidate: s.applicant }),
        selectors: ["as", "candidate.stage"],
        observations: [async (c, s) => s.candidate.stage],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "applied"],
            expected: async (c, s) => ["withdrawn"],
          },
          { dependencies: [], values: async (c, s) => ["members", "hired"], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["public", "applied"], error: "forbidden" },
        ],
      },
    ],
  };
}
