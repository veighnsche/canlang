import {
  require as check,
  hasRole,
  same,
  create,
  set,
  records,
  first,
  emit,
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
  datetime,
  delivery,
} from "@canlang/stdlib";
/* Desired, unimplemented @canlang/ui contracts. Every factory below is proposed;
 * none is an installed export and this file never runs. See file header. */
import {
  message,
  renderPage,
  actions,
  badge,
  breadcrumbs,
  calendar,
  card,
  collapse,
  edit,
  fieldset,
  file_input,
  form,
  history,
  input,
  link,
  list,
  pagination,
  radio,
  tab,
  table,
  tabs,
  text,
  textarea,
  toggle,
} from "@canlang/ui";
import { Employee, can_work } from "./employee.mjs";
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
const Cancellation = "maintain.Cancellation";

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
      fields: { items: { type: "maintain.WorkItem", array: true, requiredArray: true, max: 500n } },
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
        inspection_epoch: { type: "int", default: 0n, min: 0n },
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
      readGrants: [{ rule: "Plan.read.1" }, { rule: "Plan.read.2", fields: ["name"] }],
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
        asset_epoch: { type: "int", default: 0n, min: 0n },
        active: { type: "bool", default: true },
      },
    },
    [Inspection]: {
      parent: "maintain.Plan",
      exported: true,
      label: message("Inspection", { nl: "Inspectie" }),
      readGrants: [{ rule: "Inspection.read.1" }, { rule: "Inspection.read.2" }],
      invariants: ["Inspection.require.1"],
      locks: ["Inspection.lock.1", "Inspection.lock.2", "Inspection.lock.3"],
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
        asset_epoch: { type: "int", default: 0n, min: 0n },
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
    "maintain.Verification": {
      parent: Repair,
      label: message("Repair verification", { nl: "Reparatieverificatie" }),
      readGrants: [{ rule: "Verification.read.1" }],
      locks: ["Verification.lock.1"],
      fields: {
        completion: { type: "text" }, evidence: { type: "text" },
        author: { type: "user", server: "actor" }, at: { type: "datetime", server: "now" },
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
        delivery: { type: "delivery", operation: "maintain.Mail.send" },
      },
      derived: {
        state: {
          type: "std.DeliveryResult.status",
          handler: "Notice.state",
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
    [Cancellation]: {
      parent: Asset,
      label: message("Inspection cancellation", { nl: "Inspectieannulering" }),
      readGrants: [{ rule: "Cancellation.read.1" }],
      invariants: ["Cancellation.require.1"],
      locks: ["Cancellation.lock.1"],
      fields: {
        plan: { type: "maintain.Plan", nullable: true },
        through: { type: "int", min: 0n },
        cutoff: { type: "date" },
        reason: { type: "enum", cases: ["plan_revised", "asset_retired"] },
        author: { type: "user", server: "actor" },
        at: { type: "datetime", server: "now" },
        after: { type: "text", nullable: true },
        phase: { type: "enum", cases: ["plans", "inspections", "complete"], default: "inspections" },
      },
    },
  },
  pure: {
    "maintain.plan_eligible": {
      handler: "plan_eligible",
      inputs: { plan: { type: "maintain.Plan" } },
      result: "bool",
    },
    "maintain.matches_cancellation": {
      handler: "matches_cancellation",
      inputs: {
        change: { type: "maintain.Cancellation" },
        inspection: { type: "maintain.Inspection" },
      },
      result: "bool",
    },
    "maintain.inspection_superseded": {
      handler: "inspection_superseded",
      inputs: { inspection: { type: "maintain.Inspection" } },
      result: "bool",
    },
    "maintain.inspection_pending": {
      handler: "inspection_pending",
      inputs: { inspection: { type: "maintain.Inspection" } },
      result: "bool",
    },
  },
  events: {
    "maintain.CancellationStep": { fields: { cancellation: { type: Cancellation } } },
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
    "maintain.resume_cancellation": {
      handler: "resume_cancellation",
      read: false,
      by: "maintain.maintenance_manager",
      inputs: { cancellation: { type: Cancellation } },
      description: message("Resume the retained cancellation without changing its original scope or attribution.", { nl: "Hervat de vastgelegde annulering zonder haar oorspronkelijke bereik of toeschrijving te wijzigen." }),
      label: message("Resume inspection cancellation", { nl: "Inspectieannulering hervatten" }),
    },
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
    "maintain.cancel_inspection_step": { handler: "cancel_inspection_step", on: "maintain.CancellationStep" },
    "maintain.activate_plan": { handler: "activate_plan", on: "maintain.Plan.create" },
    "maintain.revise_plan": { handler: "revise_plan", on: "maintain.Plan.update" },
    "maintain.retire_asset": { handler: "retire_asset", on: "maintain.Asset.update" },
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

async function plan_eligible(c, plan) {
  return plan.active && !plan.parent.retired &&
    plan.asset_epoch === plan.parent.inspection_epoch &&
    hasRole(c, "maintain.technician", plan.assignee) &&
    (await can_work(c, plan.assignee, plan.parent.location));
}
function matches_cancellation(c, change, inspection) {
  return same(change.parent, inspection.parent.parent) &&
    compareDate(inspection.due, change.cutoff) > 0 &&
    ((change.reason === "plan_revised" && same(change.plan, inspection.parent) &&
      inspection.template_version <= change.through) ||
     (change.reason === "asset_retired" && inspection.asset_epoch <= change.through));
}
async function inspection_superseded(c, inspection) {
  return await any(records(c, Cancellation, { parent: inspection.parent.parent }),
    (change) => matches_cancellation(c, change, inspection));
}
async function inspection_pending(c, inspection) {
  return inspection.result === "pending" && !inspection.cancelled &&
    !(await inspection_superseded(c, inspection));
}

export function canApp() {
  const crudWhen = {
    Asset: (c, row) => can_work(c, c.actor, row.location),
    Plan: async (c, row) => (await can_work(c, c.actor, row.parent.location)) &&
      (!row.active || (!row.parent.retired && hasRole(c, "maintain.technician", row.assignee) &&
        (await can_work(c, row.assignee, row.parent.location)))),
    Repair: async (c, row) =>
      (await can_work(c, c.actor, row.parent.location)) && row.state === "open",
  };
  return {
    plan_eligible,
    matches_cancellation,
    inspection_pending,
    inspection_superseded,
    read: {
      "Asset.read.1": (c, row) => hasRole(c, "authenticated") && !row.retired,
      "Asset.read.2": async (c, row) =>
        (hasRole(c, "maintain.maintenance_manager") || hasRole(c, "maintain.technician")) &&
        (await can_work(c, c.actor, row.location)),
      "Cancellation.read.1": async (c, row) => hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "Plan.read.1": async (c, row) =>
        hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.location)),
      "Plan.read.2": async (c, row) => hasRole(c, "maintain.technician") &&
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
      "Verification.read.1": async (c, row) =>
        (hasRole(c, "maintain.maintenance_manager") || hasRole(c, "maintain.technician")) &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Assignment.read.1": async (c, row) =>
        hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Notice.read.1": async (c, row) =>
        hasRole(c, "maintain.maintenance_manager") &&
        (await can_work(c, c.actor, row.parent.parent.parent.location)),
    },
    derives: {
      "Notice.state": async (c, row) =>
        (await delivery(c, { record: row, field: "delivery" }, ["status"])).status,
    },
    invariants: {
      "Cancellation.require.1": (c, row) =>
        (row.reason === "plan_revised" && row.plan !== null && same(row.plan.parent, row.parent)) ||
        (row.reason === "asset_retired" && row.plan === null),
      "Plan.require.1": async (c, row) => row.cadence_days > 0n && (await count(row.checklist)) > 0n,
      "Inspection.require.1": async (c, row) =>
        row.result === "pending" ||
        (row.evidence !== null &&
          row.inspected_at !== null &&
          (await count(row.answers)) === (await count(row.checklist))),
      "Repair.require.1": (c, row) =>
        row.state !== "fixed" || (row.completion !== null && row.verified_by !== null),
    },
    locks: {
      "Cancellation.lock.1": { fields: ["plan", "through", "cutoff", "reason", "author", "at"] },
      "Inspection.lock.1": {
        fields: ["occurrence", "due", "checklist", "template_version", "asset_epoch", "inspector"],
      },
      "Inspection.lock.2": {
        fields: ["answers", "result", "evidence", "inspected_at"],
        when: (c, row) => row.result !== "pending",
      },
      "Inspection.lock.3": { fields: ["cancelled", "cancellation", "cancelled_by", "cancelled_at"], when: (c, row) => row.cancelled },
      "Verification.lock.1": { fields: ["completion", "evidence", "author", "at"] },
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
      await set(c, event.after, { asset_epoch: event.after.parent.inspection_epoch });
      if (await plan_eligible(c, event.after))
        await schedule(c, event.after.id, await max([c.now,
          local_instant(event.after.next_due, "00:00", event.after.parent.location.timezone, { fold: "earlier" })]),
          "maintain.PlanDue", { plan: event.after, revision: event.after.revision, due: event.after.next_due });
    },
    async revise_plan(c, { event }) {
      await set(c, event.after, { revision: int64(event.before.revision + 1n),
        asset_epoch: event.after.parent.inspection_epoch });
      const change = await create(c, Cancellation, { parent: event.after.parent, plan: event.after,
        through: event.before.revision, cutoff: local_date(c.now, event.after.parent.location.timezone),
        reason: "plan_revised" });
      await emit(c, "maintain.CancellationStep", { cancellation: change });
      await cancel(c, event.after.id);
      if (await plan_eligible(c, event.after))
        await schedule(c, event.after.id, await max([c.now,
          local_instant(event.after.next_due, "00:00", event.after.parent.location.timezone, { fold: "earlier" })]),
          "maintain.PlanDue", { plan: event.after, revision: event.after.revision, due: event.after.next_due });
    },
    async retire_asset(c, { event }) {
      if (event.after.retired && !event.before.retired) {
        await set(c, event.after, { inspection_epoch: int64(event.before.inspection_epoch + 1n) });
        const change = await create(c, Cancellation, { parent: event.after, plan: null,
          through: event.before.inspection_epoch, cutoff: local_date(c.now, event.after.location.timezone),
          reason: "asset_retired", phase: "plans" });
        await emit(c, "maintain.CancellationStep", { cancellation: change });
      }
    },
    async cancel_inspection_step(c, { event }) {
      const change = event.cancellation;
      if (change.phase === "plans") {
        const plan = await first(records(c, "maintain.Plan", { parent: change.parent,
          where: (row) => row.asset_epoch <= change.through &&
            (change.after === null || row.id > change.after), order: ["id"] }));
        if (plan !== null) {
          await set(c, plan, { active: false, revision: int64(plan.revision + 1n) });
          await cancel(c, plan.id);
          await set(c, change, { after: plan.id });
          await emit(c, "maintain.CancellationStep", { cancellation: change });
        } else {
          await set(c, change, { phase: "inspections", after: null });
          await emit(c, "maintain.CancellationStep", { cancellation: change });
        }
      } else if (change.phase === "inspections") {
        const inspection = await first(records(c, Inspection, {
          where: (row) => row.result === "pending" && !row.cancelled &&
            matches_cancellation(c, change, row) && (change.after === null || row.id > change.after),
          order: ["id"] }));
        if (inspection !== null) {
          await set(c, inspection, { cancelled: true, cancellation: "Plan revised",
            cancelled_by: change.author, cancelled_at: change.at });
          if (change.reason === "asset_retired") await set(c, inspection, { cancellation: "Asset retired" });
          await cancel(c, inspection.id);
          await set(c, change, { after: inspection.id });
          await emit(c, "maintain.CancellationStep", { cancellation: change });
        } else await set(c, change, { phase: "complete" });
      }
    },
    async resume_cancellation(c, { cancellation }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check((await can_work(c, c.actor, cancellation.parent.location)) && cancellation.phase !== "complete");
      await emit(c, "maintain.CancellationStep", { cancellation });
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
      await create(c, "maintain.Notice", { parent: assignment, delivery: notice });
    },
    async retry_notice(c, { notice }) {
      check(hasRole(c, "maintain.maintenance_manager"), "forbidden");
      check(
        (await can_work(c, c.actor, notice.parent.parent.parent.location)) &&
          (await delivery(c, { record: notice, field: "delivery" }, ["status"])).status ===
            "failed" &&
          !(await any(
            records(c, "maintain.Notice", { parent: notice.parent }),
            async (item) =>
              ["pending", "unknown", "succeeded"].includes(
                (await delivery(c, { record: item, field: "delivery" }, ["status"])).status,
              ),
          )) &&
          same(notice.parent.parent.assignment, notice.parent) &&
          notice.parent.supplier.active &&
          ["assigned", "in_progress"].includes(notice.parent.parent.state),
      );
      const attempt = await send(
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
      await create(c, "maintain.Notice", { parent: notice.parent, delivery: attempt });
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
      await create(c, "maintain.Verification", { parent: repair, completion: repair.completion, evidence });
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
          (await inspection_pending(c, inspection)) &&
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
        (await plan_eligible(c, plan)) &&
        plan.revision === event.revision &&
        compareDate(plan.next_due, event.due) === 0 &&
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
            async (inspection) =>
              !inspection.cancelled &&
              !(inspection.result === "pending" && (await inspection_superseded(c, inspection))) &&
              compareDate(inspection.due, plan.next_due) === 0,
          ))
        ) {
          const inspection = await create(c, Inspection, {
            parent: plan,
            occurrence,
            due: plan.next_due,
            checklist: plan.checklist,
            template_version: plan.revision,
            asset_epoch: plan.asset_epoch,
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
        (await inspection_pending(c, inspection)) &&
        inspection.template_version === event.revision &&
        inspection.parent.revision === event.revision &&
        same(inspection.inspector, inspection.parent.assignee) &&
        compareInstant(
          local_instant(inspection.due, "09:00", inspection.parent.parent.location.timezone, {
            fold: "earlier",
          }),
          c.now,
        ) <= 0 &&
        (await plan_eligible(c, inspection.parent)) &&
        inspection.asset_epoch === inspection.parent.asset_epoch
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
              (await inspection_pending(c, inspection)) &&
              inspection.template_version === event.revision &&
              inspection.parent.revision === event.revision &&
              same(inspection.inspector, inspection.parent.assignee) &&
              compareInstant(
                local_instant(inspection.due, "09:00", inspection.parent.parent.location.timezone, {
                  fold: "earlier",
                }),
                c.now,
              ) <= 0 &&
              (await plan_eligible(c, inspection.parent)) &&
              inspection.asset_epoch === inspection.parent.asset_epoch,
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
          (await inspection_pending(c, item)) &&
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
          (await inspection_pending(c, record)) &&
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
    () => [
      /* desired-unimplemented: breadcrumbs derives current declared ancestry. */
      breadcrumbs({ context: c }),
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
            empty: message("No assets match these filters", {
              nl: "Geen bedrijfsmiddelen voor deze filters",
            }),
            renderRow: (asset, v) => [
              /* desired-unimplemented: pagination consumes this collection cursor. */
              pagination({ context: v }),
              text({ context: v, values: [asset.retired] }),
              edit({ context: v, operation: "maintain.Asset.update", record: asset }),
              // The manual collapse renders only when a manual is attached.
              same(asset.manual, null)
                ? null
                : collapse({
                    context: v,
                    caption: message("Manual", { nl: "Handleiding" }),
                    children: [
                      /* desired-unimplemented: link targets the authorized file URL. */
                      link({
                        context: v,
                        target: asset.manual,
                        caption: message("Manual", { nl: "Handleiding" }),
                      }),
                    ],
                  }),
              tabs({
                context: v,
                children: [
                  tab({
                    context: v,
                    caption: message("Inspection plans and checklists", {
                      nl: "Inspectieplannen en checklists",
                    }),
                    children: [
                      table({ context: v, model: Cancellation, parent: asset,
                        columns: ["reason", "cutoff", "author", "at", "phase"],
                        empty: message("No cancellations recorded", {
                          nl: "Geen annuleringen vastgelegd",
                        }),
                        renderRow: (cancellation, cv) => [
                          /* desired-unimplemented: pagination consumes this collection cursor. */
                          pagination({ context: cv }),
                          actions({ context: cv,
                            operations: ["maintain.resume_cancellation"], boundArgs: { cancellation } })] }),
                      form({
                        context: v,
                        operation: "maintain.Plan.create",
                        arguments: { parent: asset },
                        /* desired-unimplemented: fieldset groups existing form fields. */
                        children: [
                          fieldset({
                            context: v,
                            caption: message("Inspection plan", { nl: "Inspectieplan" }),
                            children: [
                              /* desired-unimplemented: placed controls move the generated controls. */
                              input({ context: v, field: "name" }),
                              input({ context: v, field: "cadence_days" }),
                              calendar({ context: v, field: "next_due" }),
                              toggle({ context: v, field: "active" }),
                            ],
                          }),
                        ],
                      }),
                      list({
                        context: v,
                        model: "maintain.Plan",
                        parent: asset,
                        empty: message("No inspection plans", { nl: "Geen inspectieplannen" }),
                        renderRow: (plan, pv) => [
                          /* desired-unimplemented: pagination consumes this collection cursor. */
                          pagination({ context: pv }),
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
                            empty: message("No inspections recorded", {
                              nl: "Geen inspecties vastgelegd",
                            }),
                            renderRow: (inspection, iv) => [
                              /* desired-unimplemented: pagination consumes this collection cursor. */
                              pagination({ context: iv }),
                              /* desired-unimplemented: badge presents the readable enum value. */
                              badge({ context: iv, value: inspection.result }),
                              text({ context: iv, values: [inspection.checklist] }),
                              form({
                                context: iv,
                                operation: "maintain.inspect",
                                arguments: { inspection },
                                /* desired-unimplemented: fieldset groups existing form fields. */
                                children: [
                                  fieldset({
                                    context: iv,
                                    caption: message("Checklist result", {
                                      nl: "Checklistresultaat",
                                    }),
                                    children: [
                                      /* desired-unimplemented: placed controls move the generated controls. */
                                      radio({ context: iv, field: "result" }),
                                      textarea({ context: iv, field: "evidence" }),
                                    ],
                                  }),
                                ],
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
                        empty: message("No repairs match these filters", {
                          nl: "Geen reparaties voor deze filters",
                        }),
                        renderRow: (repair, rv) => [
                          /* desired-unimplemented: pagination consumes this collection cursor. */
                          pagination({ context: rv }),
                          /* desired-unimplemented: badge presents readable enum values. */
                          badge({ context: rv, value: repair.state }),
                          badge({ context: rv, value: repair.severity }),
                          badge({ context: rv, value: repair.block_state }),
                          edit({
                            context: rv,
                            operation: "maintain.Repair.update",
                            record: repair,
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
                          form({
                            context: rv,
                            operation: dispatch_visit,
                            arguments: { repair, location: repair.parent.location },
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
                                      empty: message("No affected bookings", {
                                        nl: "Geen getroffen boekingen",
                                      }),
                                      renderRow: (booking, bv) => [
                                        /* desired-unimplemented: pagination consumes this collection cursor. */
                                        pagination({ context: bv }),
                                      ],
                                    }),
                                  ],
                                }),
                              ]
                            : []),
                          table({ context: rv, model: "maintain.Verification", parent: repair,
                            columns: ["completion", "evidence", "author", "at"],
                            empty: message("No verifications recorded", {
                              nl: "Geen verificaties vastgelegd",
                            }),
                            renderRow: (verification, vv) => [
                              /* desired-unimplemented: pagination consumes this collection cursor. */
                              pagination({ context: vv }),
                            ] }),
                          list({
                            context: rv,
                            model: "maintain.Assignment",
                            parent: repair,
                            empty: message("No assignments recorded", {
                              nl: "Geen opdrachten vastgelegd",
                            }),
                            renderRow: (assignment, av) => [
                              /* desired-unimplemented: pagination consumes this collection cursor. */
                              pagination({ context: av }),
                              text({
                                context: av,
                                values: [assignment.reason, assignment.contact],
                              }),
                              table({
                                context: av,
                                model: "maintain.Notice",
                                parent: assignment,
                                columns: ["state", "delivery"],
                                empty: message("No delivery attempts", {
                                  nl: "Geen verzendpogingen",
                                }),
                                renderRow: (notice, nv) => [
                                  /* desired-unimplemented: pagination consumes this collection cursor. */
                                  pagination({ context: nv }),
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
    ],
  );
}
export async function reportsPage(c, bindings) {
  return renderPage(
    c,
    reportsPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs derives current declared ancestry. */
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Own fault intake", { nl: "Eigen storing melden" }),
        children: [
          form({
            context: c,
            operation: "maintain.report",
            /* desired-unimplemented: fieldset groups existing form fields. */
            children: [
              fieldset({
                context: c,
                caption: message("Fault details", { nl: "Storingsdetails" }),
                children: [
                  /* desired-unimplemented: placed controls move the generated controls. */
                  input({ context: c, field: "title" }),
                  textarea({ context: c, field: "description" }),
                  file_input({ context: c, field: "photo" }),
                ],
              }),
            ],
          }),
        ],
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
            empty: message("No own reports match these filters", {
              nl: "Geen eigen meldingen voor deze filters",
            }),
            renderRow: (report, v) => [
              /* desired-unimplemented: pagination consumes this collection cursor. */
              pagination({ context: v }),
              /* desired-unimplemented: badge presents the readable enum value. */
              badge({ context: v, value: report.state }),
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
  const fault_reporter = { dependencies: [], user: async () => ({ roles: [] }) };
  const inspection_manager = { dependencies: [], user: async () => ({ roles: ["maintain.maintenance_manager"] }) };
  const inspection_technician = { dependencies: [], user: async () => ({ roles: ["maintain.technician"] }) };
  const manager_employee = { model: Employee, dependencies: [inspection_manager, test_site], value: async (c, s) => ({
    user: s.inspection_manager, home: s.test_site, locations: [s.test_site], start: date("2020-01-01"), role: "maintenance manager" }) };
  const technician_employee = { model: Employee, dependencies: [inspection_technician, test_site], value: async (c, s) => ({
    user: s.inspection_technician, home: s.test_site, locations: [s.test_site], start: date("2020-01-01"), role: "inspection technician" }) };
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
    dependencies: [equipment, inspection_technician],
    value: async (c, s) => ({
      parent: s.equipment,
      name: "Cooling inspection",
      assignee: s.inspection_technician,
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
      inspector: s.inspection_technician,
      reminder_email: "technician@example.test",
    }),
  };
  const service_supplier = { model: Supplier, dependencies: [test_site], value: async(c,s) => ({
    name: "Cooling service", contact: "service@example.test", locations: [s.test_site] }) };
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
  const superseded = { model: Cancellation, dependencies: [equipment, recurring, inspection_manager], value: async (c, s) => ({
    parent: s.equipment, plan: s.recurring, through: 1n, cutoff: date("2020-01-01"), reason: "plan_revised",
    author: s.inspection_manager, at: datetime("2020-01-01T12:00:00Z") }) };
  const retired_work = { model: Cancellation, dependencies: [equipment, inspection_manager], value: async (c, s) => ({
    parent: s.equipment, plan: null, through: 0n, cutoff: date("2020-01-01"), reason: "asset_retired", phase: "plans",
    author: s.inspection_manager, at: datetime("2020-01-01T12:00:00Z") }) };
  return {
    fault_reporter, inspection_manager, inspection_technician, manager_employee, technician_employee, superseded, retired_work, service_supplier,
    awaiting,
    check,
    equipment,
    recurring,
    examples: [
      {operation:"maintain.resume_cancellation",dependencies:[manager_employee,superseded],inputs:async(c,s)=>({cancellation:s.superseded}),
        selectors:["as","cancellation.phase","manager_employee.active"],observations:[async(c,s)=>s.cancellation.phase],
        rows:[
          {dependencies:[],values:async(c,s)=>[s.inspection_manager,"inspections",true],expected:async()=>["inspections"]},
          {dependencies:[],values:async(c,s)=>[s.inspection_manager,"complete",true],error:"rule_failed"},
          {dependencies:[],values:async(c,s)=>[s.inspection_manager,"inspections",false],error:"rule_failed"},
          {dependencies:[inspection_technician],values:async(c,s)=>[s.inspection_technician,"inspections",true],error:"forbidden"},
          {dependencies:[],values:async()=>["public","inspections",true],error:"forbidden"},
        ]},
      {operation:"maintain.generate", dependencies:[technician_employee,check,superseded],
        inputs:async(c,s)=>({event:{plan:s.recurring,revision:2n,due:local_date(c.now,s.test_site.timezone)}}),
        selectors:["superseded.cutoff","recurring.revision","recurring.active","recurring.next_due","check.due","check.result","check.answers","check.evidence","check.inspected_at"],
        observations:[async(c,s)=>await count(records(c,Inspection,{parent:s.recurring}))],
        rows:[
          {dependencies:[],values:async(c,s)=>[add_days(local_date(c.now,s.test_site.timezone),-1n),2n,true,local_date(c.now,s.test_site.timezone),local_date(c.now,s.test_site.timezone),"pending",[],null,null],expected:async()=>[2n]},
          {dependencies:[],values:async(c,s)=>[add_days(local_date(c.now,s.test_site.timezone),-1n),2n,true,local_date(c.now,s.test_site.timezone),local_date(c.now,s.test_site.timezone),"passed",["Cooling works"],"Already checked",c.now],expected:async()=>[1n]},
        ]},
      {operation:"maintain.generate", dependencies:[technician_employee,recurring],
        inputs:async(c,s)=>({event:{plan:s.recurring,revision:1n,due:local_date(c.now,s.test_site.timezone)}}),
        selectors:["recurring.active","recurring.next_due","technician_employee.active","equipment.inspection_epoch"],
        observations:[async(c,s)=>await count(records(c,Inspection,{parent:s.recurring}))],
        rows:[
          {dependencies:[],values:async(c,s)=>[true,local_date(c.now,s.test_site.timezone),false,0n],expected:async()=>[0n]},
          {dependencies:[],values:async(c,s)=>[true,local_date(c.now,s.test_site.timezone),true,1n],expected:async()=>[0n]},
        ]},
      {operation:"maintain.verify",dependencies:[manager_employee,technician_employee,service_supplier,fault_reporter],sequence:[
        {operation:"maintain.report",by:async(c,s,b)=>s.fault_reporter,inputs:async(c,s,b)=>({asset:s.equipment,title:"Cooling fault",description:"No cooling",photo:null}),bind:"initial_fault"},
        {operation:"maintain.assign",by:async(c,s,b)=>s.inspection_manager,inputs:async(c,s,b)=>({repair:b.initial_fault,supplier:s.service_supplier,reason:"Repair cooling"})},
        {let:"first_assignment",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.first_assignment!==null],expected:async()=>[true],types:["bool"]},
        {operation:"maintain.start",by:async(c,s,b)=>s.inspection_technician,inputs:async(c,s,b)=>({repair:b.first_assignment})},
        {let:"first_started",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.first_started!==null],expected:async()=>[true],types:["bool"]},
        {operation:"maintain.finish",by:async(c,s,b)=>s.inspection_technician,inputs:async(c,s,b)=>({repair:b.first_started,evidence:"Repaired"})},
        {let:"first_submitted",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.first_submitted!==null],expected:async()=>[true],types:["bool"]},
        {operation:"maintain.verify",by:async(c,s,b)=>s.inspection_manager,inputs:async(c,s,b)=>({repair:b.first_submitted,evidence:"Manager checked cooling"})},
        {let:"verified_repair",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.verified_repair!==null],expected:async()=>[true],types:["bool"]},
        {let:"initial",value:async(c,s,b)=>await first(records(c,"maintain.Verification",{parent:b.verified_repair,where:row=>true,order:["id"]}))},
        {observations:async(c,s,b)=>[b.initial!==null],expected:async()=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.verified_repair.state,b.verified_repair.block_state,b.initial.completion,b.initial.evidence,b.initial.author,b.initial.at],expected:async(c,s,b)=>["fixed","none","Repaired","Manager checked cooling",s.inspection_manager,c.now],types:["maintain.Repair.state", "maintain.Repair.block_state", "text", "text", "user", "datetime"]},
        {operation:"maintain.reopen",by:async(c,s,b)=>s.inspection_manager,inputs:async(c,s,b)=>({repair:b.verified_repair,reason:"Cooling failed again"})},
        {let:"reopened",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.reopened!==null],expected:async()=>[true],types:["bool"]},
        {operation:"maintain.assign",by:async(c,s,b)=>s.inspection_manager,inputs:async(c,s,b)=>({repair:b.reopened,supplier:s.service_supplier,reason:"Investigate recurrence"})},
        {let:"assigned",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.assigned!==null],expected:async()=>[true],types:["bool"]},
        {operation:"maintain.start",by:async(c,s,b)=>s.inspection_technician,inputs:async(c,s,b)=>({repair:b.assigned})},
        {let:"started",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.started!==null],expected:async()=>[true],types:["bool"]},
        {operation:"maintain.finish",by:async(c,s,b)=>s.inspection_technician,inputs:async(c,s,b)=>({repair:b.started,evidence:"Replaced compressor"})},
        {let:"submitted",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.submitted!==null],expected:async()=>[true],types:["bool"]},
        {operation:"maintain.verify",by:async(c,s,b)=>s.inspection_manager,inputs:async(c,s,b)=>({repair:b.submitted,evidence:"Load test passed"})},
        {let:"final",value:async(c,s,b)=>await first(records(c,"maintain.Repair",{where:row=>row.id===b.initial_fault.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.final!==null],expected:async()=>[true],types:["bool"]},
        {let:"latest",value:async(c,s,b)=>await first(records(c,"maintain.Verification",{parent:b.final,where:row=>row.evidence==="Load test passed",order:["id"]}))},
        {observations:async(c,s,b)=>[b.latest!==null],expected:async()=>[true],types:["bool"]},
        {let:"previous",value:async(c,s,b)=>await first(records(c,"maintain.Verification",{parent:b.final,where:row=>row.id===b.initial.id,order:["id"]}))},
        {observations:async(c,s,b)=>[b.previous!==null],expected:async()=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.final.state,b.final.completion,b.final.block_state,b.final.block_source,await count(records(c,"maintain.Verification",{parent:b.final})),b.previous.completion,b.previous.evidence,b.latest.completion,b.latest.evidence,b.latest.author,b.latest.at],expected:async(c,s,b)=>["fixed","Replaced compressor","none",null,2n,"Repaired","Manager checked cooling","Replaced compressor","Load test passed",s.inspection_manager,c.now],types:["maintain.Repair.state", "text?", "maintain.Repair.block_state", "text?", "int", "text", "text", "text", "text", "user", "datetime"]}
      ]},
      { operation: "maintain.Plan.update", dependencies: [recurring,test_worker,technician_employee], inputs: async (c,s) => ({record:s.recurring}),
        selectors: ["as", "changes.active", "changes.assignee", "equipment.retired"],
        observations: [async(c,s)=>s.recurring.revision,async(c,s)=>await count(records(c,Cancellation,{parent:s.equipment}))],
        rows: [
          { dependencies: [], values: async(c,s)=>["maintain.maintenance_manager",true,s.inspection_technician,false], expected: async(c,s)=>[2n,1n] },
          { dependencies: [], values: async(c,s)=>["maintain.maintenance_manager",true,s.other,false], error: "rule_failed" },
          { dependencies: [], values: async(c,s)=>["maintain.maintenance_manager",true,s.inspection_technician,true], error: "rule_failed" },
          { dependencies: [], values: async(c,s)=>["maintain.maintenance_manager",false,s.other,true], expected: async(c,s)=>[2n,1n] },
        ] },
      { operation: "maintain.cancel_inspection_step", dependencies: [check,superseded], inputs: async (c,s) => ({event:{cancellation:s.superseded}}),
        selectors: ["check.due", "check.result", "check.answers", "check.evidence", "check.inspected_at", "superseded.phase"],
        observations: [async(c,s)=>s.check.cancelled,async(c,s)=>s.check.result,async(c,s)=>s.superseded.phase,async(c,s)=>s.check.cancelled_by,async(c,s)=>s.check.cancelled_at],
        rows: [
          { dependencies: [], values: async(c,s)=>[date("2099-12-01"),"pending",[],null,null,"inspections"], expected: async(c,s)=>[true,"pending","inspections",s.inspection_manager,s.superseded.at] },
          { dependencies: [], values: async(c,s)=>[date("2020-01-01"),"pending",[],null,null,"inspections"], expected: async(c,s)=>[false,"pending","complete",null,null] },
          { dependencies: [], values: async(c,s)=>[date("2019-12-31"),"pending",[],null,null,"inspections"], expected: async(c,s)=>[false,"pending","complete",null,null] },
          { dependencies: [], values: async(c,s)=>[date("2099-12-01"),"passed",["Cooling works"],"Measured cooling",datetime("2019-12-31T12:00:00Z"),"inspections"], expected: async(c,s)=>[false,"passed","complete",null,null] },
          { dependencies: [], values: async(c,s)=>[date("2099-12-01"),"pending",[],null,null,"complete"], expected: async(c,s)=>[false,"pending","complete",null,null] },
        ] },
      { operation: "maintain.cancel_inspection_step", dependencies: [check,retired_work], inputs: async (c,s) => ({event:{cancellation:s.retired_work}}),
        selectors: ["equipment.inspection_epoch", "recurring.asset_epoch", "check.asset_epoch", "recurring.active"],
        observations: [async(c,s)=>s.recurring.active,async(c,s)=>s.recurring.revision,async(c,s)=>s.retired_work.phase,async(c,s)=>s.check.cancelled],
        rows: [
          { dependencies: [], values: async(c,s)=>[1n,0n,0n,true], expected: async(c,s)=>[false,2n,"plans",false] },
          { dependencies: [], values: async(c,s)=>[1n,1n,1n,true], expected: async(c,s)=>[true,1n,"inspections",false] },
        ] },
      { operation: "maintain.cancel_inspection_step", dependencies: [check,retired_work], inputs: async (c,s) => ({event:{cancellation:s.retired_work}}),
        selectors: ["retired_work.phase", "equipment.inspection_epoch", "check.asset_epoch"],
        observations: [async(c,s)=>s.check.cancelled,async(c,s)=>s.retired_work.phase],
        rows: [
          { dependencies: [], values: async(c,s)=>["inspections",1n,0n], expected: async(c,s)=>[true,"inspections"] },
          { dependencies: [], values: async(c,s)=>["inspections",1n,1n], expected: async(c,s)=>[false,"complete"] },
        ] },
      { operation: "maintain.inspect", dependencies: [check,technician_employee], inputs: async (c,s) => ({inspection:s.check,answers:["Cooling works"],result:"passed",evidence:"Measured cooling"}),
        selectors: ["as", "technician_employee.active"],
        observations: [async(c,s)=>s.inspection.result],
        rows: [
          { dependencies: [], values: async(c,s)=>[s.inspection_technician,false], error: "rule_failed" },
        ] },
      {operation:"maintain.inspect", dependencies:[manager_employee,technician_employee,check], sequence:[
        {operation:"maintain.Plan.update", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({record:s.recurring,changes:{name:"Revised cooling check"}})},
        {let:"future", value:async(c,s,b)=>await first(records(c,"maintain.Inspection",{where:(row)=>row.occurrence==="check", order:["id"]}))},
        {observations:async(c,s,b)=>[b.future!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {observations:async(c,s,b)=>[b.future.result,b.future.cancelled,await inspection_pending(c,b.future),await count(records(c,Cancellation,{parent:s.equipment}))], expected:async(c,s,b)=>["pending",false,false,1n], types:["maintain.Inspection.result", "bool", "bool", "int"]},
        {operation:"maintain.inspect", by:async(c,s,b)=>s.inspection_technician, inputs:async(c,s,b)=>({inspection:b.future,answers:["Cooling works"],result:"passed",evidence:"Superseded checklist"}), error:"rule_failed"},
        {let:"revised", value:async(c,s,b)=>await first(records(c,"maintain.Plan",{where:(row)=>row.id===s.recurring.id, order:["id"]}))},
        {observations:async(c,s,b)=>[b.revised!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {operation:"maintain.Plan.update", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({record:b.revised,changes:{checklist:["Replacement checklist"]}})},
        {operation:"maintain.Asset.update", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({record:s.equipment,changes:{retired:true}})},
        {let:"retired", value:async(c,s,b)=>await first(records(c,"maintain.Asset",{where:(row)=>row.id===s.equipment.id, order:["id"]}))},
        {observations:async(c,s,b)=>[b.retired!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {observations:async(c,s,b)=>[b.retired.retired,b.retired.inspection_epoch], expected:async(c,s,b)=>[true,1n], types:["bool", "int"]},
        {operation:"maintain.Asset.update", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({record:b.retired,changes:{retired:false}})},
        {let:"configured", value:async(c,s,b)=>await first(records(c,"maintain.Plan",{where:(row)=>row.id===s.recurring.id, order:["id"]}))},
        {observations:async(c,s,b)=>[b.configured!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {operation:"maintain.Plan.update", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({record:b.configured,changes:{active:true}})},
        {let:"renewed", value:async(c,s,b)=>await first(records(c,"maintain.Plan",{where:(row)=>row.id===s.recurring.id, order:["id"]}))},
        {observations:async(c,s,b)=>[b.renewed!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {observations:async(c,s,b)=>[b.renewed.asset_epoch,await plan_eligible(c,b.renewed),b.future.checklist,await inspection_pending(c,b.future)], expected:async(c,s,b)=>[1n,true,["Cooling works"],false], types:["int", "bool", "text[]", "bool"]},
        {operation:"maintain.inspect", by:async(c,s,b)=>s.inspection_technician, inputs:async(c,s,b)=>({inspection:b.future,answers:["Cooling works"],result:"passed",evidence:"Old work after reinstatement"}), error:"rule_failed"},
        {operation:"maintain.Plan.update", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({record:b.renewed,changes:{name:"Stale change"}}), error:"conflict", request:async(c,s,b)=>({record:{version:1n}})},
        {let:"cancellation", value:async(c,s,b)=>await first(records(c,"maintain.Cancellation",{parent:s.equipment, where:(row)=>row.reason==="asset_retired", order:["id"]}))},
        {observations:async(c,s,b)=>[b.cancellation!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {operation:"maintain.resume_cancellation", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({cancellation:b.cancellation})},
        {let:"history", value:async(c,s,b)=>await first(records(c,"maintain.Cancellation",{parent:s.equipment, where:(row)=>row.id===b.cancellation.id, order:["id"]}))},
        {observations:async(c,s,b)=>[b.history!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {observations:async(c,s,b)=>[b.history.phase,b.history.author,b.history.at,b.history.through,b.future.result,b.future.cancelled], expected:async(c,s,b)=>["plans",s.inspection_manager,c.now,0n,"pending",false], types:["maintain.Cancellation.phase", "user", "datetime", "int", "maintain.Inspection.result", "bool"]}
      ]},
      {operation:"maintain.inspect", dependencies:[manager_employee,technician_employee,check], sequence:[
        {operation:"maintain.inspect", by:async(c,s,b)=>s.inspection_technician, inputs:async(c,s,b)=>({inspection:s.check,answers:["Cooling works"],result:"passed",evidence:"Measured cooling"})},
        {operation:"maintain.Asset.update", by:async(c,s,b)=>s.inspection_manager, inputs:async(c,s,b)=>({record:s.equipment,changes:{retired:true}})},
        {let:"completed_check", value:async(c,s,b)=>await first(records(c,"maintain.Inspection",{where:(row)=>row.occurrence==="check", order:["id"]}))},
        {observations:async(c,s,b)=>[b.completed_check!==null], expected:async(c,s,b)=>[true], types:["bool"]},
        {observations:async(c,s,b)=>[b.completed_check.result,b.completed_check.answers,b.completed_check.evidence,b.completed_check.inspector,b.completed_check.inspected_at,b.completed_check.cancelled], expected:async(c,s,b)=>["passed",["Cooling works"],"Measured cooling",s.inspection_technician,c.now,false], types:["maintain.Inspection.result", "text[]", "text?", "user", "datetime?", "bool"]},
        {operation:"maintain.inspect", by:async(c,s,b)=>s.inspection_technician, inputs:async(c,s,b)=>({inspection:b.completed_check,answers:["Replacement"],result:"failed",evidence:"Overwrite result"}), error:"rule_failed"}
      ]},
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
          async (c, s) => await inspection_pending(c, s.check),
          async (c, s) => await count(records(c, Cancellation, { parent: s.equipment })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["maintain.maintenance_manager", "Revised cooling check"],
            expected: async (c, s) => [2n, false, "pending", false, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.inspection_technician, "Revised cooling check"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "maintain.start",
        seed: [technician_employee],
        dependencies: [awaiting],
        inputs: async (c, s) => ({ repair: s.awaiting }),
        selectors: ["as", "repair.state"],
        observations: [async (c, s) => s.repair.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [s.inspection_technician, "assigned"],
            expected: async (c, s) => ["in_progress"],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.inspection_technician, "open"],
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
        seed: [technician_employee],
        dependencies: [awaiting],
        inputs: async (c, s) => ({ repair: s.awaiting }),
        selectors: ["as", "evidence"],
        observations: [async (c, s) => s.repair.state, async (c, s) => s.repair.verified_by,
          async(c,s)=>(await first(records(c,"maintain.Verification",{parent:s.repair,order:["id"]})))?.evidence],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["maintain.maintenance_manager", "Checked cooling"],
            expected: async (c, s) => ["fixed", s.self, "Checked cooling"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["maintain.maintenance_manager", ""],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [s.inspection_technician, "Checked cooling"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "maintain.reopen",
        seed: [technician_employee],
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
        seed: [technician_employee],
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
            values: async (c, s) => [s.inspection_technician, "failed", false],
            expected: async (c, s) => ["failed", 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.inspection_technician, "passed", false],
            expected: async (c, s) => ["passed", 0n],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.inspection_technician, "failed", true],
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
