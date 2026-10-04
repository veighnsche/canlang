import {
  require as check,
  hasRole,
  same,
  create,
  set,
  records,
  any,
  compareInstant,
  compareDate,
  local_date,
  add_days,
  int64,
  send,
  format,
  action,
  local_instant,
  count,
  cancel,
  schedule,
  max,
  date,
} from "@canlang/stdlib";
import {
  message,
  renderPage,
  actions,
  card,
  edit,
  form,
  history,
  list,
  tab,
  table,
  tabs,
  text,
} from "@canlang/ui";
import { can_work } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";
import { Supplier } from "./supplier.mjs";
import { AffectedBookings } from "./rent_reservations.mjs";
import { dispatch as dispatch_visit, ReportSubmitted } from "./field.mjs";

/* Hand-written desired business/metadata output. All imports are proposed contracts,
 * not shared implementations. create returns a provisional typed row with stored
 * defaults. set stages fields, retaining admission versions until commit. The shared
 * boundary owns references, locks/invariants, exact values, atomicity and delivery.
 * compareDate compares typed civil dates; compareInstant compares absolute instants.
 * send freezes delivery content; when rechecks current source state at dispatch.
 * Canonical server factory calls below are proposed contracts, not a renderer.
 */
const checklistCaption = message("Checklist", { nl: "Checklist" });
const answersCaption = message("Answers", { nl: "Antwoorden" });
const pendingCaption = message("Pending", { nl: "In afwachting" });
const failedCaption = message("Failed", { nl: "Mislukt" });
const photoCaption = message("Photo", { nl: "Foto" });
export const WorkItem = "maintain.WorkItem";
export const WorkBatch = "maintain.WorkBatch";
export const Inspection = "maintain.Inspection";
export const Repair = "maintain.Repair";
export const Asset = "maintain.Asset";
export const report = "maintain.report";
export const inspect = "maintain.inspect";
export const work = "maintain.work";
export const work_detail = "maintain.work_detail";

const facilitiesPageDescriptor = {
  owner: "maintain",
  path: "/facilities",
  title: message("Facilities", { nl: "Faciliteiten" }),
  description: message("Keep assets, overdue inspections and repair verification connected.", {
    nl: "Houd bedrijfsmiddelen, achterstallige inspecties en reparatieverificatie met elkaar verbonden.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(
      hasRole(c, "maintain.maintenance_manager") || hasRole(c, "maintain.technician"),
      "forbidden",
    );
    return {};
  },
  render: facilitiesPage,
};

const reportsPageDescriptor = {
  owner: "maintain",
  path: "/facilities/my-reports",
  title: message("My facility reports", { nl: "Mijn storingsmeldingen" }),
  description: message("Submit and follow your own fault report.", {
    nl: "Dien je eigen storingsmelding in en volg deze.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: reportsPage,
};

export const appDefinition = {
  id: "CanMaintain",
  uses: ["maintain"],
  description: message(
    "Help workspace managers move facility faults in offices, meeting rooms, common areas, and equipment through repair and return to service.",
    {
      nl: "Help werkplekmanagers storingen in kantoren, vergaderruimten, gemeenschappelijke ruimten en apparatuur te herstellen en voorzieningen terug in gebruik te nemen.",
    },
  ),
  compositions: {
    Facilities: {
      uses: ["CanMaintain", "CanField", "CanStock"],
      description: message(
        "Maintain equipment, verify repairs, dispatch technicians and track consumable stock.",
        {
          nl: "Onderhoud apparatuur, verifieer reparaties, plan technici en volg de verbruiksvoorraad.",
        },
      ),
    },
  },
  packages: {
    maintain: {
      description: message(
        "Own equipment, immutable inspection evidence and manager-verified repairs.",
        {
          nl: "Beheer apparatuur, onveranderlijk inspectiebewijs en door managers geverifieerde reparaties.",
        },
      ),
      roles: {
        maintenance_manager: {
          id: "maintain.maintenance_manager",
          label: message("Maintenance manager", { nl: "Onderhoudsbeheerder" }),
        },
        technician: {
          id: "maintain.technician",
          label: message("Technician", { nl: "Technicus" }),
        },
      },
    },
  },
  bindings: {
    "maintain.Mail": { capability: "std.EmailV1", from: "deployment.mail" },
    "maintain.Rooms": { capability: "rent_reservations.RoomsV1", from: "deployment.rooms" },
  },
  contracts: {
    "maintain.WorkItem": {
      exported: true,
      label: message("Authorized inspection", { nl: "Toegestane inspectie" }),
      fields: {
        reference: { type: "text" },
        revision: { type: "int" },
        location: { type: "text", nullable: true },
        title: { type: "text" },
        detail: { type: "text", nullable: true },
        due: { type: "datetime", nullable: true },
        action: { type: "action", targets: ["maintain.inspect"] },
      },
    },
    "maintain.WorkBatch": {
      exported: true,
      label: message("Authorized inspections", { nl: "Toegestane inspecties" }),
      fields: { items: { type: "maintain.WorkItem", array: true, requiredArray: true, max: 500 } },
    },
  },
  models: {
    "maintain.Asset": {
      exported: true,
      label: message("Asset", { nl: "Bedrijfsmiddel" }),
      readGrants: [
        { rule: "Asset.read.1", fields: ["location", "identifier", "name"] },
        { rule: "Asset.read.2" },
      ],
      fields: {
        location: { type: Location },
        identifier: {
          type: "text",
          unique: true,
          label: message("Identifier", { nl: "Identificatie" }),
        },
        name: { type: "text" },
        category: { type: "text", label: message("Category", { nl: "Categorie" }) },
        supplier: { type: Supplier, nullable: true },
        resource: {
          type: "text",
          nullable: true,
          label: message("Resource reference", { nl: "Referentie voorziening" }),
        },
        serial: {
          type: "text",
          nullable: true,
          label: message("Serial number", { nl: "Serienummer" }),
        },
        warranty: {
          type: "date",
          nullable: true,
          label: message("Warranty expiry", { nl: "Garantie-einddatum" }),
        },
        manual: { type: "file", nullable: true, label: message("Manual", { nl: "Handleiding" }) },
        retired: {
          type: "bool",
          default: false,
          label: message("Retired", { nl: "Buiten gebruik" }),
        },
      },
    },
    "maintain.Plan": {
      parent: "maintain.Asset",
      label: message("Inspection plan", { nl: "Inspectieplan" }),
      readGrants: [{ rule: "Plan.read.1" }],
      invariants: ["Plan.require.1"],
      fields: {
        name: { type: "text" },
        assignee: { type: "user", label: message("Assignee", { nl: "Toegewezen persoon" }) },
        assignee_email: {
          type: "email",
          label: message("Reminder destination", { nl: "Bestemming herinnering" }),
        },
        cadence_days: {
          type: "int",
          min: 1n,
          label: message("Interval in days", { nl: "Interval in dagen" }),
        },
        next_due: {
          type: "date",
          label: message("Next inspection date", { nl: "Volgende inspectiedatum" }),
        },
        checklist: { type: "text", array: true, requiredArray: true, label: checklistCaption },
        revision: { type: "int", default: 1n },
        active: { type: "bool", default: true },
      },
    },
    [Inspection]: {
      parent: "maintain.Plan",
      exported: true,
      label: message("Inspection", { nl: "Inspectie" }),
      readGrants: [{ rule: "Inspection.read.1" }, { rule: "Inspection.read.2" }],
      invariants: ["Inspection.require.1"],
      locks: ["Inspection.lock.1", "Inspection.lock.2"],
      fields: {
        cancelled: {
          type: "bool",
          default: false,
          label: message("Cancelled", { nl: "Geannuleerd" }),
        },
        cancellation: {
          type: "text",
          nullable: true,
          label: message("Cancellation reason", { nl: "Reden annulering" }),
        },
        cancelled_by: {
          type: "user",
          nullable: true,
          label: message("Cancelled by", { nl: "Geannuleerd door" }),
        },
        cancelled_at: {
          type: "datetime",
          nullable: true,
          label: message("Cancelled at", { nl: "Geannuleerd op" }),
        },
        reminder_email: {
          type: "email",
          label: message("Reminder destination", { nl: "Bestemming herinnering" }),
        },
        reminded_at: {
          type: "datetime",
          nullable: true,
          label: message("Reminder queued at", { nl: "Herinnering klaargezet op" }),
        },
        occurrence: {
          type: "text",
          unique: true,
          label: message("Occurrence reference", { nl: "Referentie uitvoering" }),
        },
        due: { type: "date" },
        checklist: { type: "text", array: true, requiredArray: true, label: checklistCaption },
        template_version: {
          type: "int",
          label: message("Template version", { nl: "Templateversie" }),
        },
        inspector: { type: "user", label: message("Inspector", { nl: "Inspecteur" }) },
        answers: { type: "text", array: true, label: answersCaption },
        result: {
          type: "enum",
          cases: ["pending", "passed", "failed", "blocked"],
          default: "pending",
          label: {
            text: message("Inspection result", { nl: "Inspectieresultaat" }),
            values: {
              pending: pendingCaption,
              passed: message("Passed", { nl: "Goedgekeurd" }),
              failed: failedCaption,
              blocked: message("Blocked", { nl: "Geblokkeerd" }),
            },
          },
        },
        evidence: { type: "text", nullable: true },
        inspected_at: {
          type: "datetime",
          nullable: true,
          label: message("Inspected at", { nl: "Geïnspecteerd op" }),
        },
        repair: { type: Repair, nullable: true },
      },
    },
    [Repair]: {
      parent: "maintain.Asset",
      exported: true,
      label: message("Repair", { nl: "Reparatie" }),
      readGrants: [
        { rule: "Repair.read.1" },
        {
          rule: "Repair.read.2",
          fields: ["title", "description", "severity", "state", "due", "completion", "reporter"],
        },
      ],
      invariants: ["Repair.require.1"],
      fields: {
        affected: {
          type: AffectedBookings,
          nullable: true,
          label: message("Affected bookings", { nl: "Getroffen boekingen" }),
        },
        affected_delivery: {
          type: "text",
          nullable: true,
          label: message("Affected-booking lookup delivery", {
            nl: "Verzending opvraag getroffen boekingen",
          }),
        },
        affected_state: {
          type: "enum",
          cases: ["none", "pending", "fresh", "failed", "unknown"],
          default: "none",
          label: {
            text: message("Booking review read", { nl: "Lezen boekingsbeoordeling" }),
            values: {
              none: message("Not requested", { nl: "Niet aangevraagd" }),
              pending: pendingCaption,
              fresh: message("Fresh snapshot", { nl: "Actuele momentopname" }),
              failed: failedCaption,
              unknown: message("Unknown", { nl: "Onbekend" }),
            },
          },
        },
        assignment: {
          type: "maintain.Assignment",
          nullable: true,
          label: message("Current assignment", { nl: "Huidige opdracht" }),
        },
        block_from: {
          type: "datetime",
          nullable: true,
          label: message("Downtime start", { nl: "Begin uitval" }),
        },
        block_until: {
          type: "datetime",
          nullable: true,
          label: message("Downtime end", { nl: "Einde uitval" }),
        },
        block_action: {
          type: "enum",
          cases: ["downtime", "restore"],
          default: "downtime",
          label: {
            text: message("Availability action", { nl: "Beschikbaarheidsactie" }),
            values: {
              downtime: message("Downtime", { nl: "Uitval" }),
              restore: message("Restore", { nl: "Herstellen" }),
            },
          },
        },
        block_revision: { type: "int", default: 0n },
        restore_evidence: {
          type: "text",
          nullable: true,
          label: message("Release evidence", { nl: "Vrijgavebewijs" }),
        },
        visit_review: {
          type: "bool",
          default: false,
          label: message("Visit report needs review", { nl: "Bezoekverslag vereist beoordeling" }),
        },
        title: { type: "text", trim: true, min: 1n },
        description: { type: "text" },
        severity: {
          type: "enum",
          cases: ["low", "normal", "urgent"],
          default: "normal",
          label: {
            text: message("Severity", { nl: "Ernst" }),
            values: {
              low: message("Low", { nl: "Laag" }),
              normal: message("Normal", { nl: "Normaal" }),
              urgent: message("Urgent", { nl: "Dringend" }),
            },
          },
        },
        reporter: { type: "user", nullable: true, label: message("Reporter", { nl: "Melder" }) },
        reporter_email: {
          type: "email",
          nullable: true,
          label: message("Reporter email", { nl: "E-mailadres melder" }),
        },
        photo: { type: "file", nullable: true, label: photoCaption },
        contractor: {
          type: Supplier,
          nullable: true,
          label: message("Contractor", { nl: "Uitvoerder" }),
        },
        due: { type: "date", nullable: true },
        cost: { type: "money", nullable: true, label: message("Cost", { nl: "Kosten" }) },
        state: {
          type: "enum",
          cases: ["open", "assigned", "in_progress", "awaiting_verification", "fixed"],
          default: "open",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              open: message("Open", { nl: "Open" }),
              assigned: message("Assigned", { nl: "Toegewezen" }),
              in_progress: message("In progress", { nl: "In uitvoering" }),
              awaiting_verification: message("Awaiting verification", {
                nl: "Wacht op verificatie",
              }),
              fixed: message("Fixed", { nl: "Hersteld" }),
            },
          },
        },
        completion: {
          type: "text",
          nullable: true,
          label: message("Completion evidence", { nl: "Afrondingsbewijs" }),
        },
        verified_by: {
          type: "user",
          nullable: true,
          label: message("Verified by", { nl: "Geverifieerd door" }),
        },
        block_resource: {
          type: "text",
          nullable: true,
          label: message("Blocked resource", { nl: "Geblokkeerde voorziening" }),
        },
        block_source: {
          type: "text",
          nullable: true,
          label: message("Downtime reference", { nl: "Uitvalreferentie" }),
        },
        block_state: {
          type: "enum",
          cases: ["none", "pending", "confirmed", "failed", "unknown", "released"],
          default: "none",
          label: {
            text: message("Downtime outcome", { nl: "Uitvalresultaat" }),
            values: {
              pending: pendingCaption,
              failed: failedCaption,
              none: message("None", { nl: "Geen" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
              released: message("Released", { nl: "Vrijgegeven" }),
            },
          },
        },
        delivery: {
          type: "text",
          nullable: true,
          label: message("Delivery reference", { nl: "Verzendingsreferentie" }),
        },
      },
    },
    "maintain.Assignment": {
      parent: Repair,
      label: message("Contractor assignment", { nl: "Opdracht aan leverancier" }),
      readGrants: [{ rule: "Assignment.read.1" }],
      locks: ["Assignment.lock.1"],
      fields: {
        body: {
          type: "text",
          label: message("Frozen assignment details", { nl: "Vastgelegde opdrachtdetails" }),
        },
        supplier: { type: Supplier },
        contact: { type: "email", label: message("Contact", { nl: "Contact" }) },
        reason: { type: "text" },
        author: { type: "user", server: "actor", label: message("Author", { nl: "Auteur" }) },
      },
    },
    "maintain.Notice": {
      parent: "maintain.Assignment",
      label: message("Assignment delivery", { nl: "Opdrachtverzending" }),
      readGrants: [{ rule: "Notice.read.1" }],
      fields: {
        delivery: { type: "text" },
        state: {
          type: "enum",
          cases: ["pending", "succeeded", "failed", "unknown", "skipped"],
          default: "pending",
          label: {
            text: message("Delivery outcome", { nl: "Verzendingsresultaat" }),
            values: {
              pending: pendingCaption,
              succeeded: message("Delivered", { nl: "Bezorgd" }),
              failed: failedCaption,
              unknown: message("Unknown", { nl: "Onbekend" }),
              skipped: message("Superseded", { nl: "Vervangen" }),
            },
          },
        },
      },
    },
  },
  events: {
    "maintain.Reminder": {
      fields: { inspection: { type: Inspection }, revision: { type: "int" } },
    },
    "maintain.PlanDue": {
      fields: { plan: { type: "maintain.Plan" }, revision: { type: "int" }, due: { type: "date" } },
    },
  },
  preferences: {
    maintain: {
      fields: {
        location: { type: Location, nullable: true, default: null },
        severity: { field: "maintain.Repair.severity", nullable: true, default: null },
      },
    },
  },
  operations: {
    "maintain.work": {
      handler: "work",
      exported: true,
      read: true,
      scope: "authority",
      by: "maintain.technician",
      result: "maintain.WorkBatch",
      inputs: { locations: { type: "text", array: true } },
      description: message(
        "Expose only your pending inspection titles and authorized completion actions.",
        { nl: "Toon alleen je openstaande inspectietitels en toegestane afrondingsacties." },
      ),
    },
    "maintain.work_detail": {
      handler: "work_detail",
      exported: true,
      read: true,
      scope: "authority",
      by: "maintain.technician",
      result: "maintain.WorkItem",
      inputs: { record: { type: Inspection } },
      description: message(
        "Recheck the selected inspection before showing its source-owned checklist form.",
        {
          nl: "Controleer de gekozen inspectie opnieuw voordat het bronformulier met checklist wordt getoond.",
        },
      ),
    },
    "maintain.Asset.create": {
      handler: "createAsset",
      kind: "create",
      model: "maintain.Asset",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: {
        fields: [
          "location",
          "identifier",
          "name",
          "category",
          "supplier",
          "resource",
          "serial",
          "warranty",
          "manual",
        ],
      },
      when: "Asset",
    },
    "maintain.Asset.update": {
      handler: "updateAsset",
      kind: "update",
      model: "maintain.Asset",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: {
        record: { type: "maintain.Asset" },
        changes: {
          fields: [
            "name",
            "category",
            "supplier",
            "resource",
            "serial",
            "warranty",
            "manual",
            "retired",
          ],
        },
      },
      when: "Asset",
    },
    "maintain.Plan.create": {
      handler: "createPlan",
      kind: "create",
      model: "maintain.Plan",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: {
        parent: { type: "maintain.Asset" },
        fields: [
          "name",
          "assignee",
          "assignee_email",
          "cadence_days",
          "next_due",
          "checklist",
          "active",
        ],
      },
      when: "Plan",
    },
    "maintain.Plan.update": {
      handler: "updatePlan",
      kind: "update",
      model: "maintain.Plan",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: {
        record: { type: "maintain.Plan" },
        changes: {
          fields: [
            "name",
            "assignee",
            "assignee_email",
            "cadence_days",
            "next_due",
            "checklist",
            "active",
          ],
        },
      },
      when: "Plan",
    },
    "maintain.Repair.create": {
      handler: "createRepair",
      kind: "create",
      model: Repair,
      read: false,
      by: "maintain.maintenance_manager",
      inputs: {
        parent: { type: "maintain.Asset" },
        fields: ["title", "description", "severity", "due", "photo", "cost"],
      },
      when: "Repair",
    },
    "maintain.Repair.update": {
      handler: "updateRepair",
      kind: "update",
      model: Repair,
      read: false,
      by: "maintain.maintenance_manager",
      inputs: {
        record: { type: Repair },
        changes: { fields: ["title", "description", "severity", "due", "photo", "cost"] },
      },
      when: "Repair",
    },
    "maintain.report": {
      handler: "report",
      exported: true,
      result: Repair,
      read: false,
      by: "authenticated",
      inputs: {
        asset: { type: "maintain.Asset" },
        title: { type: "text" },
        description: { type: "text" },
        photo: { type: "file", nullable: true, default: null, label: photoCaption },
      },
      label: message("Report fault", { nl: "Storing melden" }),
      description: message("Report your own facility fault without browsing unrelated repairs.", {
        nl: "Meld je eigen facilitaire storing zonder niet-gerelateerde reparaties te bekijken.",
      }),
    },
    "maintain.assign": {
      handler: "assign",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: { repair: { type: Repair }, supplier: { type: Supplier }, reason: { type: "text" } },
      description: message("Assign an active supplier and freeze the notification destination.", {
        nl: "Wijs een actieve leverancier toe en leg de meldingsbestemming vast.",
      }),
    },
    "maintain.block": {
      handler: "block",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: {
        repair: { type: Repair },
        from: { type: "datetime", label: message("Start", { nl: "Begin" }) },
        until: {
          type: "datetime",
          nullable: true,
          default: null,
          label: message("End", { nl: "Einde" }),
        },
      },
      label: message("Record blocker", { nl: "Blokkade registreren" }),
      description: message(
        "Request canonical room downtime while preserving affected customer bookings.",
        { nl: "Vraag canonieke ruimte-uitval aan en behoud de getroffen klantboekingen." },
      ),
    },
    "maintain.finish": {
      handler: "finish",
      read: false,
      by: "maintain.technician",
      inputs: { repair: { type: Repair }, evidence: { type: "text" } },
      label: message("Submit repair evidence", { nl: "Reparatiebewijs indienen" }),
      description: message(
        "Capture technician evidence for manager verification rather than automatic resale.",
        {
          nl: "Leg technicusbewijs vast voor managerverificatie in plaats van automatische herverkoop.",
        },
      ),
    },
    "maintain.verify": {
      handler: "verify",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: { repair: { type: Repair }, evidence: { type: "text" } },
      label: message("Verify repair", { nl: "Reparatie verifiëren" }),
      description: message("Verify a repair and request release of only its own downtime block.", {
        nl: "Verifieer een reparatie en vraag vrijgave van uitsluitend haar eigen uitvalblokkade aan.",
      }),
    },
    "maintain.reopen": {
      handler: "reopen",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: { repair: { type: Repair }, reason: { type: "text" } },
      description: message(
        "Reopen a recurrence without erasing previous inspection or completion evidence.",
        {
          nl: "Heropen een terugkerende storing zonder eerder inspectie- of afrondingsbewijs te wissen.",
        },
      ),
    },
    "maintain.inspect": {
      handler: "inspect",
      exported: true,
      read: false,
      by: "maintain.technician",
      inputs: {
        inspection: { type: Inspection },
        answers: { type: "text", array: true, label: answersCaption },
        result: { field: "maintain.Inspection.result" },
        evidence: { type: "text" },
      },
      label: message("Record inspection", { nl: "Inspectie registreren" }),
      description: message(
        "Record one attributable checklist result; a failed or blocked result opens a corrective repair.",
        {
          nl: "Registreer één herleidbaar checklistresultaat; een mislukt of geblokkeerd resultaat opent een corrigerende reparatie.",
        },
      ),
    },
    "maintain.retry_notice": {
      handler: "retry_notice",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: { notice: { type: "maintain.Notice" } },
      label: message("Retry assignment notice", { nl: "Opdrachtmelding opnieuw sturen" }),
    },
    "maintain.start": {
      handler: "start",
      read: false,
      by: "maintain.technician",
      inputs: { repair: { type: Repair } },
      label: message("Start repair", { nl: "Reparatie starten" }),
    },
    "maintain.retry_availability": {
      handler: "retry_availability",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: { repair: { type: Repair } },
      label: message("Retry availability request", {
        nl: "Beschikbaarheidsaanvraag opnieuw proberen",
      }),
    },
    "maintain.affected_bookings": {
      handler: "affected_bookings",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: { repair: { type: Repair } },
      label: message("Refresh affected bookings", { nl: "Getroffen boekingen vernieuwen" }),
    },
  },
  handlers: {
    "maintain.activate_plan": { handler: "activate_plan", on: "maintain.Plan.create" },
    "maintain.revise_plan": { handler: "revise_plan", on: "maintain.Plan.update" },
    "maintain.retire_asset": { handler: "retire_asset", on: "maintain.Asset.update" },
    "maintain.notice_result": { handler: "notice_result", on: "maintain.Mail.send.completed" },
    "maintain.remind": { handler: "remind", on: "maintain.Reminder" },
    "maintain.affected_result": {
      handler: "affected_result",
      on: "maintain.Rooms.affected.completed",
    },
    "maintain.availability_changed": {
      handler: "availability_changed",
      on: "maintain.Rooms.changed",
    },
    "maintain.visit_report": { handler: "visit_report", on: ReportSubmitted },
    "maintain.generate": { handler: "generate", on: "maintain.PlanDue" },
    "maintain.downtime_result": {
      handler: "downtime_result",
      on: "maintain.Rooms.downtime.completed",
    },
    "maintain.restore_result": {
      handler: "restore_result",
      on: "maintain.Rooms.restore.completed",
    },
  },
  disabled: ["maintain.Asset.delete", "maintain.Plan.delete", "maintain.Repair.delete"],
  pages: [
    facilitiesPageDescriptor,
    reportsPageDescriptor,
  ],
};

export function canApp() {
  const crudWhen = {
    Asset: (c, row) => can_work(c, c.actor, row.location),
    Plan: (c, row) => can_work(c, c.actor, row.parent.location),
    Repair: async (c, row) =>
      (await can_work(c, c.actor, row.parent.location)) && row.state === "open",
  };
  return {
    read: {
      "Asset.read.1": (c, row) => hasRole(c, "authenticated") && !row.retired,
      "Asset.read.2": async (c, row) =>
        (hasRole(c, "maintain.maintenance_manager") || hasRole(c, "maintain.technician")) &&
        (await can_work(c, c.actor, row.location)),
      "Plan.read.1": async (c, row) =>
        hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "Inspection.read.1": async (c, row) =>
        hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Inspection.read.2": async (c, row) =>
        hasRole(c, "maintain.technician") &&
        same(row.inspector, c.actor) &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Repair.read.1": async (c, row) =>
        (hasRole(c, "maintain.maintenance_manager") || hasRole(c, "maintain.technician")) &&
        (await can_work(c, c.actor, row.parent.location)),
      "Repair.read.2": (c, row) => hasRole(c, "authenticated") && same(row.reporter, c.actor),
      "Assignment.read.1": async (c, row) =>
        hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Notice.read.1": async (c, row) =>
        hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.parent.parent.location)),
    },
    invariants: {
      "Plan.require.1": async (c, row) =>
        row.cadence_days > 0n &&
        (await count(row.checklist)) > 0n &&
        (!row.active ||
          (!row.parent.retired &&
            hasRole(c, "maintain.technician", row.assignee) &&
            (await can_work(c, row.assignee, row.parent.location)))),
      "Inspection.require.1": async (c, row) =>
        row.result === "pending" ||
        (row.evidence !== null &&
          row.inspected_at !== null &&
          (await count(row.answers)) === (await count(row.checklist))),
      "Repair.require.1": (c, row) =>
        row.state !== "fixed" || (row.completion !== null && row.verified_by !== null),
    },
    locks: {
      "Inspection.lock.1": {
        fields: ["occurrence", "due", "checklist", "template_version", "inspector"],
      },
      "Inspection.lock.2": {
        fields: ["answers", "result", "evidence", "inspected_at"],
        when: (c, row) => row.result !== "pending",
      },
      "Assignment.lock.1": { fields: ["supplier", "contact", "reason", "author", "body"] },
    },
    crudWhen,
    async createAsset(c, input) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      await create(c, "maintain.Asset", input, { when: crudWhen.Asset });
    },
    async updateAsset(c, { record, changes }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Asset });
    },
    async createPlan(c, input) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      await create(c, "maintain.Plan", input, { when: crudWhen.Plan });
    },
    async updatePlan(c, { record, changes }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Plan });
    },
    async createRepair(c, input) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      await create(c, Repair, input, { when: crudWhen.Repair });
    },
    async updateRepair(c, { record, changes }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Repair });
    },
    async activate_plan(c, { event }) {
      if (event.after.active)
        await schedule(
          c,
          event.after.id,
          await max([
            c.now,
            local_instant(event.after.next_due, "00:00", event.after.parent.location.timezone, {
              fold: "earlier",
            }),
          ]),
          "maintain.PlanDue",
          { plan: event.after, revision: event.after.revision, due: event.after.next_due },
        );
    },
    async revise_plan(c, { event }) {
      await set(c, event.after, { revision: int64(event.before.revision + 1n) });
      for await (const inspection of records(c, Inspection, {
        parent: event.before,
        where: (item) =>
          item.result === "pending" &&
          !item.cancelled &&
          compareDate(item.due, local_date(c.now, event.before.parent.location.timezone)) > 0,
        limit: 100n,
      })) {
        await set(c, inspection, {
          cancelled: true,
          cancellation: "Plan revised",
          cancelled_by: c.actor,
          cancelled_at: c.now,
        });
        await cancel(c, inspection.id);
      }
      await cancel(c, event.after.id);
      if (event.after.active)
        await schedule(
          c,
          event.after.id,
          await max([
            c.now,
            local_instant(event.after.next_due, "00:00", event.after.parent.location.timezone, {
              fold: "earlier",
            }),
          ]),
          "maintain.PlanDue",
          { plan: event.after, revision: event.after.revision, due: event.after.next_due },
        );
    },
    async retire_asset(c, { event }) {
      if (event.after.retired && !event.before.retired) {
        for await (const plan of records(c, "maintain.Plan", {
          parent: event.before,
          limit: 100n,
        })) {
          await set(c, plan, { active: false, revision: int64(plan.revision + 1n) });
          await cancel(c, plan.id);
          for await (const inspection of records(c, Inspection, {
            parent: plan,
            where: (item) =>
              item.result === "pending" &&
              !item.cancelled &&
              compareDate(item.due, local_date(c.now, event.before.location.timezone)) > 0,
            limit: 100n,
          })) {
            await set(c, inspection, {
              cancelled: true,
              cancellation: "Asset retired",
              cancelled_by: c.actor,
              cancelled_at: c.now,
            });
            await cancel(c, inspection.id);
          }
        }
      }
    },
    async report(c, { asset, title, description, photo = null }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        c.actor.email_verified &&
          !asset.retired &&
          title.trim() !== "" &&
          description.trim() !== "",
      );
      const repair = await create(c, Repair, {
        parent: asset,
        title,
        description,
        photo,
        reporter: c.actor,
        reporter_email: c.actor.email,
      });
      return repair;
    },
    async assign(c, { repair, supplier, reason }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, repair.parent.location)) &&
          supplier.active &&
          supplier.locations.some((location) => same(location, repair.parent.location)) &&
          repair.state !== "fixed" &&
          reason.trim() !== "",
      );
      const assignment = await create(c, "maintain.Assignment", {
        parent: repair,
        supplier,
        contact: supplier.contact,
        reason,
        body: repair.description,
      });
      await set(c, repair, { contractor: supplier, assignment, state: "assigned" });
      const notice = await send(
        c,
        "maintain.Mail.send",
        {
          to: assignment.contact,
          subject: format(c, message("Repair assignment", { nl: "Reparatieopdracht" }), {
            locale: null,
          }),
          body: assignment.body,
        },
        {
          when: () =>
            same(repair.assignment, assignment) &&
            supplier.active &&
            ["assigned", "in_progress"].includes(repair.state),
        },
      );
      await create(c, "maintain.Notice", { parent: assignment, delivery: notice.id });
    },
    async retry_notice(c, { notice }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, notice.parent.parent.parent.location)) &&
          notice.state === "failed" &&
          !(await any(records(c, "maintain.Notice", { parent: notice.parent }), (item) =>
            ["pending", "unknown", "succeeded"].includes(item.state),
          )) &&
          same(notice.parent.parent.assignment, notice.parent) &&
          notice.parent.supplier.active &&
          ["assigned", "in_progress"].includes(notice.parent.parent.state),
      );
      const delivery = await send(
        c,
        "maintain.Mail.send",
        {
          to: notice.parent.contact,
          subject: format(c, message("Repair assignment", { nl: "Reparatieopdracht" }), {
            locale: null,
          }),
          body: notice.parent.body,
        },
        {
          when: () =>
            same(notice.parent.parent.assignment, notice.parent) &&
            notice.parent.supplier.active &&
            ["assigned", "in_progress"].includes(notice.parent.parent.state),
        },
      );
      await create(c, "maintain.Notice", { parent: notice.parent, delivery: delivery.id });
    },
    async notice_result(c, { event }) {
      for await (const notice of records(c, "maintain.Notice", {
        where: (item) =>
          item.delivery === event.delivery_id && ["pending", "unknown"].includes(item.state),
        limit: 1n,
      }))
        await set(c, notice, { state: event.status });
    },
    async start(c, { repair }) {
      check(hasRole(c, "maintain.technician"), "forbidden");
      check((await can_work(c, c.actor, repair.parent.location)) && repair.state === "assigned");
      await set(c, repair, { state: "in_progress" });
    },
    async block(c, { repair, from, until = null }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, repair.parent.location)) &&
          repair.parent.resource !== null &&
          repair.state !== "fixed" &&
          ["none", "released"].includes(repair.block_state) &&
          (until === null || compareInstant(from, until) < 0),
      );
      const delivery = await send(c, "maintain.Rooms.downtime", {
        source: c.operation.id,
        resource: repair.parent.resource,
        from,
        until,
      });
      await set(c, repair, {
        block_resource: repair.parent.resource,
        block_source: c.operation.id,
        block_from: from,
        block_until: until,
        block_action: "downtime",
        block_revision: 0n,
        block_state: "pending",
        delivery: delivery.id,
        affected: null,
        affected_state: "none",
        affected_delivery: null,
      });
    },
    async finish(c, { repair, evidence }) {
      check(hasRole(c, "maintain.technician"), "forbidden");
      check(
        (await can_work(c, c.actor, repair.parent.location)) &&
          ["assigned", "in_progress"].includes(repair.state) &&
          evidence.trim() !== "",
      );
      await set(c, repair, { state: "awaiting_verification", completion: evidence });
    },
    async verify(c, { repair, evidence }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, repair.parent.location)) &&
          repair.state === "awaiting_verification" &&
          repair.completion !== null &&
          evidence.trim() !== "",
      );
      await set(c, repair, { state: "fixed", verified_by: c.actor, visit_review: false });
      if (repair.block_source !== null && repair.block_state !== "released") {
        check(repair.block_resource !== null);
        const delivery = await send(c, "maintain.Rooms.restore", {
          source: repair.block_source,
          resource: repair.block_resource,
          evidence,
        });
        await set(c, repair, {
          block_action: "restore",
          restore_evidence: evidence,
          block_state: "pending",
          delivery: delivery.id,
        });
      }
    },
    async reopen(c, { repair, reason }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, repair.parent.location)) &&
          repair.state === "fixed" &&
          ["none", "released", "confirmed"].includes(repair.block_state) &&
          (repair.block_action === "downtime" ||
            ["none", "released"].includes(repair.block_state)) &&
          reason.trim() !== "",
      );
      await set(c, repair, { state: "open", description: reason, verified_by: null });
    },
    async inspect(c, { inspection, answers, result, evidence }) {
      check(hasRole(c, "maintain.technician"), "forbidden");
      check(
        (await can_work(c, c.actor, inspection.parent.parent.location)) &&
          same(inspection.inspector, c.actor) &&
          inspection.result === "pending" &&
          !inspection.cancelled &&
          ["passed", "failed", "blocked"].includes(result) &&
          (await count(answers)) === (await count(inspection.checklist)) &&
          evidence.trim() !== "",
      );
      await set(c, inspection, { answers, result, evidence, inspected_at: c.now });
      await cancel(c, inspection.id);
      if (["failed", "blocked"].includes(result)) {
        const repair = await create(c, Repair, {
          parent: inspection.parent.parent,
          title: inspection.parent.name,
          description: evidence,
          reporter: c.actor,
        });
        await set(c, inspection, { repair });
      }
    },
    async visit_report(c, { event }) {
      const job = event.report.parent;
      if (job.repair !== null) {
        check(same(job.location, job.repair.parent.location) && job.state === "done");
        if (["assigned", "in_progress", "awaiting_verification"].includes(job.repair.state))
          await set(c, job.repair, {
            state: "awaiting_verification",
            completion: event.report.notes,
            visit_review: true,
          });
        else await set(c, job.repair, { visit_review: true });
      }
    },
    async generate(c, { event }) {
      const plan = event.plan;
      if (
        plan.active &&
        plan.revision === event.revision &&
        compareDate(plan.next_due, event.due) === 0 &&
        !plan.parent.retired &&
        hasRole(c, "maintain.technician", plan.assignee) &&
        (await can_work(c, plan.assignee, plan.parent.location)) &&
        compareDate(plan.next_due, local_date(c.now, plan.parent.location.timezone)) <= 0
      ) {
        const occurrence = format(c, "{plan}:{due}:{revision}", {
          plan: plan.id,
          due: plan.next_due,
          revision: plan.revision,
        });
        if (
          !(await any(
            records(c, Inspection, { parent: plan }),
            (inspection) =>
              !inspection.cancelled && compareDate(inspection.due, plan.next_due) === 0,
          ))
        ) {
          const inspection = await create(c, Inspection, {
            parent: plan,
            occurrence,
            due: plan.next_due,
            checklist: plan.checklist,
            template_version: plan.revision,
            inspector: plan.assignee,
            reminder_email: plan.assignee_email,
          });
          await schedule(
            c,
            inspection.id,
            await max([
              c.now,
              local_instant(inspection.due, "09:00", plan.parent.location.timezone, {
                fold: "earlier",
              }),
            ]),
            "maintain.Reminder",
            { inspection, revision: inspection.template_version },
          );
        }
        await set(c, plan, { next_due: add_days(plan.next_due, plan.cadence_days) });
        await schedule(
          c,
          plan.id,
          await max([
            c.now,
            local_instant(plan.next_due, "00:00", plan.parent.location.timezone, {
              fold: "earlier",
            }),
          ]),
          "maintain.PlanDue",
          { plan, revision: plan.revision, due: plan.next_due },
        );
      }
    },
    async remind(c, { event }) {
      const inspection = event.inspection;
      if (
        inspection.result === "pending" &&
        !inspection.cancelled &&
        inspection.template_version === event.revision &&
        inspection.parent.revision === event.revision &&
        same(inspection.inspector, inspection.parent.assignee) &&
        compareInstant(
          local_instant(inspection.due, "09:00", inspection.parent.parent.location.timezone, {
            fold: "earlier",
          }),
          c.now,
        ) <= 0 &&
        inspection.parent.active &&
        !inspection.parent.parent.retired &&
        hasRole(c, "maintain.technician", inspection.inspector) &&
        (await can_work(c, inspection.inspector, inspection.parent.parent.location))
      ) {
        await send(
          c,
          "maintain.Mail.send",
          {
            to: inspection.reminder_email,
            subject: format(c, message("Inspection due", { nl: "Inspectie gepland" }), {
              locale: null,
            }),
            body: inspection.parent.name,
          },
          {
            when: async () =>
              inspection.result === "pending" &&
              !inspection.cancelled &&
              inspection.template_version === event.revision &&
              inspection.parent.revision === event.revision &&
              same(inspection.inspector, inspection.parent.assignee) &&
              compareInstant(
                local_instant(inspection.due, "09:00", inspection.parent.parent.location.timezone, {
                  fold: "earlier",
                }),
                c.now,
              ) <= 0 &&
              inspection.parent.active &&
              !inspection.parent.parent.retired &&
              hasRole(c, "maintain.technician", inspection.inspector) &&
              (await can_work(c, inspection.inspector, inspection.parent.parent.location)),
          },
        );
        await set(c, inspection, { reminded_at: c.now });
      }
    },
    async retry_availability(c, { repair }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, repair.parent.location)) &&
          ["failed", "unknown"].includes(repair.block_state) &&
          repair.block_source !== null &&
          repair.block_resource !== null,
      );
      if (repair.block_action === "downtime") {
        check(repair.block_from !== null && repair.state !== "fixed");
        const delivery = await send(c, "maintain.Rooms.downtime", {
          source: repair.block_source,
          resource: repair.block_resource,
          from: repair.block_from,
          until: repair.block_until,
        });
        await set(c, repair, { delivery: delivery.id, block_state: "pending" });
      } else {
        check(repair.state === "fixed" && repair.restore_evidence !== null);
        const delivery = await send(c, "maintain.Rooms.restore", {
          source: repair.block_source,
          resource: repair.block_resource,
          evidence: repair.restore_evidence,
        });
        await set(c, repair, { delivery: delivery.id, block_state: "pending" });
      }
    },
    async downtime_result(c, { event }) {
      for await (const repair of records(c, Repair, {
        where: (r) =>
          r.delivery === event.delivery_id &&
          r.block_action === "downtime" &&
          ["pending", "unknown"].includes(r.block_state),
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === repair.block_source &&
          event.result.revision >= repair.block_revision
        ) {
          if (event.result.state === "confirmed")
            await set(c, repair, {
              block_state: "confirmed",
              block_revision: event.result.revision,
            });
          else if (["failed", "unavailable"].includes(event.result.state))
            await set(c, repair, { block_state: "failed", block_revision: event.result.revision });
          else await set(c, repair, { block_state: "unknown" });
        } else if (event.status === "failed") await set(c, repair, { block_state: "failed" });
        else await set(c, repair, { block_state: "unknown" });
      }
    },
    async restore_result(c, { event }) {
      for await (const repair of records(c, Repair, {
        where: (r) =>
          r.delivery === event.delivery_id &&
          r.block_action === "restore" &&
          ["pending", "unknown"].includes(r.block_state),
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === repair.block_source &&
          event.result.revision >= repair.block_revision &&
          event.result.state === "released"
        )
          await set(c, repair, { block_state: "released", block_revision: event.result.revision });
        else if (event.status === "failed") await set(c, repair, { block_state: "failed" });
        else await set(c, repair, { block_state: "unknown" });
      }
    },
    async affected_bookings(c, { repair }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, repair.parent.location)) &&
          repair.block_source !== null &&
          repair.block_resource !== null &&
          repair.affected_state !== "pending",
      );
      const delivery = await send(c, "maintain.Rooms.affected", {
        source: repair.block_source,
        resource: repair.block_resource,
      });
      await set(c, repair, { affected_delivery: delivery.id, affected_state: "pending" });
    },
    async affected_result(c, { event }) {
      for await (const repair of records(c, Repair, {
        where: (r) => r.affected_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === repair.block_source &&
          event.result.resource === repair.block_resource
        )
          await set(c, repair, { affected: event.result, affected_state: "fresh" });
        else if (event.status === "failed") await set(c, repair, { affected_state: "failed" });
        else await set(c, repair, { affected_state: "unknown" });
      }
    },
    async availability_changed(c, { event }) {
      for await (const repair of records(c, Repair, {
        where: (r) =>
          r.block_source === event.value.source && event.value.revision > r.block_revision,
        limit: 1n,
      })) {
        if (repair.block_action === "downtime" && event.value.state === "confirmed")
          await set(c, repair, { block_state: "confirmed", block_revision: event.value.revision });
        if (repair.block_action === "restore" && event.value.state === "released")
          await set(c, repair, { block_state: "released", block_revision: event.value.revision });
      }
    },
    async work(c, { locations }) {
      check(hasRole(c, "maintain.technician"), "forbidden");
      const items = [];
      for await (const item of records(c, Inspection, {
        where: async (item) =>
          same(item.inspector, c.actor) &&
          item.result === "pending" &&
          !item.cancelled &&
          (await can_work(c, c.actor, item.parent.parent.location)) &&
          ((await count(locations)) === 0n || locations.includes(item.parent.parent.location.id)),
      }))
        items.push({
          reference: item.id,
          revision: item.version,
          location: item.parent.parent.location.id,
          title: item.parent.name,
          detail: item.parent.parent.name,
          due: local_instant(item.due, "00:00", item.parent.parent.location.timezone, {
            fold: "earlier",
          }),
          action: action(c, "maintain.inspect", { inspection: item }),
        });
      return { items };
    },
    async work_detail(c, { record }) {
      check(hasRole(c, "maintain.technician"), "forbidden");
      check(
        same(record.inspector, c.actor) &&
          record.result === "pending" &&
          !record.cancelled &&
          (await can_work(c, c.actor, record.parent.parent.location)),
      );
      return {
        reference: record.id,
        revision: record.version,
        location: record.parent.parent.location.id,
        title: record.parent.name,
        detail: record.parent.parent.name,
        due: local_instant(record.due, "00:00", record.parent.parent.location.timezone, {
          fold: "earlier",
        }),
        action: action(c, "maintain.inspect", { inspection: record }),
      };
    },
  };
}

/* Proposed, unimplemented @canlang/ui server factory contracts. Each factory
 * receives one props object; nested children are arrays. The shared UI library
 * owns element construction, daisyUI markup/classes, canonical operation routing,
 * form/HTMX behavior, typed escaping and locale descriptors. These calls are not
 * direct calls to hook-using browser components. Scoped collection/result callbacks
 * and guards may be async: shared bounded authorized data preparation must resolve
 * them before serialization. That async integration, renderer, field/row grant
 * enforcement and full-page/fragment behavior remain unimplemented and unverified.
 */
export async function facilitiesPage(c, bindings) {
  return renderPage(
    c,
    facilitiesPageDescriptor,
    () =>
      card({
        context: c,
        title: message("Asset directory", { nl: "Bedrijfsmiddelenregister" }),
        children: [
          form({ context: c, operation: "maintain.Asset.create" }),
          list({
            context: c,
            model: "maintain.Asset",
            filter: ["location", "category", "retired"],
            search: ["name"],
            defaults: { location: c.preferences.maintain.location },
            display: "split",
            renderRow: (asset, v) => [
              edit({ context: v, operation: "maintain.Asset.update", record: asset }),
              tabs({
                context: v,
                children: [
                  tab({
                    context: v,
                    caption: message("Inspection plans and checklists", {
                      nl: "Inspectieplannen en checklists",
                    }),
                    children: [
                      form({
                        context: v,
                        operation: "maintain.Plan.create",
                        arguments: { parent: asset },
                      }),
                      list({
                        context: v,
                        model: "maintain.Plan",
                        parent: asset,
                        renderRow: (plan, pv) => [
                          edit({ context: pv, operation: "maintain.Plan.update", record: plan }),
                          table({
                            context: pv,
                            model: Inspection,
                            parent: plan,
                            columns: [
                              "due",
                              "inspector",
                              "result",
                              "cancelled",
                              "evidence",
                              "repair",
                              "reminded_at",
                            ],
                            renderRow: (inspection, iv) => [
                              text({ context: iv, values: [inspection.checklist] }),
                              form({
                                context: iv,
                                operation: "maintain.inspect",
                                arguments: { inspection },
                              }),
                              form({
                                context: iv,
                                operation: dispatch_visit,
                                arguments: {
                                  inspection,
                                  location: inspection.parent.parent.location,
                                },
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                  tab({
                    context: v,
                    caption: message("Repairs and verification", {
                      nl: "Reparaties en verificatie",
                    }),
                    children: [
                      form({
                        context: v,
                        operation: "maintain.Repair.create",
                        arguments: { parent: asset },
                      }),
                      table({
                        context: v,
                        model: Repair,
                        parent: asset,
                        columns: [
                          "title",
                          "severity",
                          "due",
                          "state",
                          "contractor",
                          "block_action",
                          "block_state",
                          "affected_state",
                          "visit_review",
                        ],
                        filter: ["state", "severity"],
                        defaults: { severity: c.preferences.maintain.severity },
                        renderRow: (repair, rv) => [
                          edit({
                            context: rv,
                            operation: "maintain.Repair.update",
                            record: repair,
                          }),
                          form({
                            context: rv,
                            operation: dispatch_visit,
                            arguments: { repair, location: repair.parent.location },
                          }),
                          actions({
                            context: rv,
                            operations: [
                              "maintain.assign",
                              "maintain.start",
                              "maintain.block",
                              "maintain.finish",
                              "maintain.verify",
                              "maintain.retry_availability",
                              "maintain.affected_bookings",
                              "maintain.reopen",
                            ],
                            boundArgs: { repair },
                          }),
                          ...(repair.affected !== null
                            ? [
                                card({
                                  context: rv,
                                  title: message("Affected bookings", {
                                    nl: "Getroffen boekingen",
                                  }),
                                  children: [
                                    text({
                                      context: rv,
                                      values: [repair.affected_state, repair.affected.checked_at],
                                    }),
                                    table({
                                      context: rv,
                                      items: repair.affected.items,
                                      columns: [
                                        "reference",
                                        "from",
                                        "until",
                                        "quantity",
                                        "status",
                                        "conflict",
                                      ],
                                    }),
                                  ],
                                }),
                              ]
                            : []),
                          list({
                            context: rv,
                            model: "maintain.Assignment",
                            parent: repair,
                            renderRow: (assignment, av) => [
                              text({
                                context: av,
                                values: [assignment.reason, assignment.contact],
                              }),
                              table({
                                context: av,
                                model: "maintain.Notice",
                                parent: assignment,
                                columns: ["state", "delivery"],
                                renderRow: (notice, nv) => [
                                  actions({
                                    context: nv,
                                    operations: ["maintain.retry_notice"],
                                    boundArgs: { notice },
                                  }),
                                ],
                              }),
                            ],
                          }),
                          history({ context: rv, record: repair }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
  );
}
export async function reportsPage(c, bindings) {
  return renderPage(
    c,
    reportsPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Own fault intake", { nl: "Eigen storing melden" }),
        children: [form({ context: c, operation: "maintain.report" })],
      }),
      card({
        context: c,
        title: message("Own report outcomes", { nl: "Eigen meldingsresultaten" }),
        children: [
          table({
            context: c,
            model: Repair,
            where: (report) => same(report.reporter, c.actor),
            columns: ["title", "description", "state", "due", "completion"],
            filter: ["severity", "state"],
            defaults: { severity: c.preferences.maintain.severity },
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
  const equipment = {
    model: "maintain.Asset",
    dependencies: [test_site],
    value: async (c, s) => ({
      location: s.test_site,
      identifier: "HVAC-1",
      name: "Air conditioner",
      category: "HVAC",
    }),
  };
  const recurring = {
    model: "maintain.Plan",
    dependencies: [equipment],
    value: async (c, s) => ({
      parent: s.equipment,
      name: "Cooling inspection",
      assignee: s.self,
      assignee_email: "technician@example.test",
      cadence_days: 30n,
      next_due: date("2099-12-01"),
      checklist: ["Cooling works"],
      active: false,
    }),
  };
  const check = {
    model: "maintain.Inspection",
    dependencies: [recurring],
    value: async (c, s) => ({
      parent: s.recurring,
      occurrence: "check",
      due: date("2099-12-01"),
      checklist: ["Cooling works"],
      template_version: 1n,
      inspector: s.self,
      reminder_email: "technician@example.test",
    }),
  };
  const awaiting = {
    model: "maintain.Repair",
    dependencies: [equipment],
    value: async (c, s) => ({
      parent: s.equipment,
      title: "Fault",
      description: "No cooling",
      state: "awaiting_verification",
      completion: "Repaired",
    }),
  };
  return {
    awaiting,
    check,
    equipment,
    recurring,
    examples: [
      {
        operation: "maintain.report",
        dependencies: [equipment],
        inputs: async (c, s) => ({ asset: s.equipment, photo: null }),
        selectors: ["as", "title", "description"],
        observations: [
          async (c, s) => s.result.title,
          async (c, s) => s.result.reporter,
          async (c, s) => s.result.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "Wi-Fi fault", "Router is not responding"],
            expected: async (c, s) => ["Wi-Fi fault", s.self, "open"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "Wi-Fi fault", ""],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", "Wi-Fi fault", "Router is not responding"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "maintain.Plan.update",
        seed: [check, test_worker],
        dependencies: [recurring],
        inputs: async (c, s) => ({ record: s.recurring }),
        selectors: ["as", "changes.name"],
        observations: [
          async (c, s) => s.recurring.revision,
          async (c, s) => s.check.cancelled,
          async (c, s) => s.check.result,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["maintain.maintenance_manager", "Revised cooling check"],
            expected: async (c, s) => [2n, true, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.technician", "Revised cooling check"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "maintain.start",
        seed: [test_worker],
        dependencies: [awaiting],
        inputs: async (c, s) => ({ repair: s.awaiting }),
        selectors: ["as", "repair.state"],
        observations: [async (c, s) => s.repair.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["maintain.technician", "assigned"],
            expected: async (c, s) => ["in_progress"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.technician", "open"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.maintenance_manager", "assigned"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "maintain.verify",
        seed: [test_worker],
        dependencies: [awaiting],
        inputs: async (c, s) => ({ repair: s.awaiting }),
        selectors: ["as", "evidence"],
        observations: [async (c, s) => s.repair.state, async (c, s) => s.repair.verified_by],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["maintain.maintenance_manager", "Checked cooling"],
            expected: async (c, s) => ["fixed", s.self],
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.maintenance_manager", ""],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.technician", "Checked cooling"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "maintain.reopen",
        seed: [test_worker],
        dependencies: [awaiting],
        inputs: async (c, s) => ({ repair: s.awaiting, reason: "Cooling failed again" }),
        selectors: [
          "as",
          "repair.state",
          "repair.verified_by",
          "repair.block_state",
          "repair.block_action",
        ],
        observations: [async (c, s) => s.repair.state, async (c, s) => s.repair.completion],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "maintain.maintenance_manager",
              "fixed",
              s.self,
              "released",
              "restore",
            ],
            expected: async (c, s) => ["open", "Repaired"],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "maintain.maintenance_manager",
              "fixed",
              s.self,
              "unknown",
              "restore",
            ],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "maintain.inspect",
        seed: [test_worker],
        dependencies: [check],
        inputs: async (c, s) => ({
          inspection: s.check,
          answers: ["No cooling"],
          evidence: "Measured warm air",
        }),
        selectors: ["as", "result", "inspection.cancelled"],
        observations: [
          async (c, s) => s.inspection.result,
          async (c, s) =>
            await count(records(c, "maintain.Repair", { parent: s.inspection.parent.parent })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["maintain.technician", "failed", false],
            expected: async (c, s) => ["failed", 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.technician", "passed", false],
            expected: async (c, s) => ["passed", 0n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.technician", "failed", true],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "maintain.downtime_result",
        seed: [awaiting],
        dependencies: [],
        inputs: async (c, s) => ({
          event: {
            delivery_id: "block-delivery",
            status: "succeeded",
            result: {
              source: "block-source",
              revision: 1n,
              state: "confirmed",
              reference: "block",
              detail: null,
            },
            error: null,
          },
        }),
        selectors: [
          "awaiting.delivery",
          "awaiting.block_source",
          "awaiting.block_state",
          "event.result.source",
        ],
        observations: [async (c, s) => s.awaiting.block_state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["block-delivery", "block-source", "pending", "block-source"],
            expected: async (c, s) => ["confirmed"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["old-delivery", "block-source", "pending", "block-source"],
            expected: async (c, s) => ["pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["block-delivery", "block-source", "pending", "other-source"],
            expected: async (c, s) => ["unknown"],
          },
        ],
      },
    ],
  };
}
