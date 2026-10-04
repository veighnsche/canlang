import {
  delivery,
  any,
  addDuration,
  cancel,
  date,
  equalMoney,
  first,
  int64,
  local_date,
  max,
  money,
  schedule,
  require as check,
  compareInstant,
  count,
  create,
  datetime,
  format,
  hasRole,
  records,
  same,
  send,
  set,
} from "@canlang/stdlib";
import {
  actions,
  card,
  edit,
  form,
  history,
  list,
  message,
  renderPage,
  table,
  tabs,
  text,
} from "@canlang/ui";
import { Contact, Customer, owns, has_role } from "./customer.mjs";
import { can_work } from "./employee.mjs";
import { Term, eligible_term } from "./member_terms.mjs";
import { Charge } from "./invoice.mjs";
import { Location } from "./rent_catalog.mjs";

/* Handwritten desired target; every import is a proposed, unimplemented contract.
 * See DESIGN §13. The registry is linked once. Trusted c carries invocation data
 * and inherited query authority; records(c,model,{parent?,where?,order?,limit?,archived?})
 * preserves owner/team bounds, expiry and work limits. Viewer queries filter grants;
 * mutation decision queries use bounded authority state. Pure derives inherit mode. Limits reject excess.
 * CRUD when callbacks inspect a normalized candidate before this write is staged;
 * final invariants see staged state. Shared admission owns versions, locks, replay
 * and atomic effects. UI factories own daisyUI/HTMX, schemas, escaping and grants.
 * No compiler, stdlib, renderer, adapter or example runner is implemented here.
 */

/* Completed draft workflows use real member_terms.Term / eligible_term exports;
 * there is no assumed entitlement event feed. Standalone services require reviewed
 * paid evidence. Exact provider/source/version correlation and frozen fee inputs
 * remain authored business contracts. Retention expires completed items only.
 * All imported packages, transport, owner query and UI APIs remain unimplemented.
 */
const recipientCaption = message("Recipient", { nl: "Ontvanger" });

const sourceCaption = message("Source reference", { nl: "Bronreferentie" });

const accountCaption = message("Account", { nl: "Account" });

const kindCaption = message("Kind", { nl: "Soort" });

const storageCaption = message("Storage location", { nl: "Opslaglocatie" });

const photoCaption = message("Photo", { nl: "Foto" });

const incidentCaption = message("Handling incident", { nl: "Afhandelingsincident" });

const carrierCaption = message("Carrier", { nl: "Vervoerder" });

const feeCaption = message("Fee", { nl: "Kosten" });

// One authored queue expression is shared by both source pages, with distinct fields.
const queue = (view, item) =>
  view === "all" ||
  (view === "collection" && ["received", "notified", "collection_ready"].includes(item.state)) ||
  (view === "forwarding" && ["forward_pending", "forwarded"].includes(item.state)) ||
  (view === "history" && ["collected", "forwarded", "returned"].includes(item.state));

const mailroomPageDescriptor = {
  owner: "mailroom",
  path: "/mailroom",
  order: 2n,
  title: message("Mail and parcels", { nl: "Post en pakketten" }),
  description: message(
    "Receive, locate and resolve mail while restricting physical storage information.",
    {
      nl: "Ontvang, lokaliseer en handel post af terwijl fysieke opslaginformatie afgeschermd blijft.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "mailroom.mail_staff"), "forbidden");
    return {};
  },
  render: mailroomPage,
};

const myMailPageDescriptor = {
  owner: "mailroom",
  path: "/mailroom/mine",
  order: 1n,
  title: message("My mail", { nl: "Mijn post" }),
  description: message("Follow only your own mail and authorized collection delegates.", {
    nl: "Volg uitsluitend je eigen post en geautoriseerde afhaalgemachtigden.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: myMailPage,
};

export const appDefinition = {
  id: "CanMail",
  uses: ["mailroom"],
  description: message(
    "Optionally help a workspace operator receive and deliver customer mail/parcels for on-site or virtual-office customers.",
    {
      nl: "Help een werkplekbeheerder desgewenst post en pakketten te ontvangen en af te leveren voor klanten op locatie of met een virtueel kantoor.",
    },
  ),
  packages: {
    mailroom: {
      label: message("Mailroom", { nl: "Postkamer" }),
      description: message(
        "Receive and resolve physical mail under explicit recipient and delegate authority.",
        {
          nl: "Ontvang en handel fysieke post af met expliciete ontvanger- en gemachtigderechten.",
        },
      ),
      roles: {
        mail_staff: {
          id: "mailroom.mail_staff",
          label: message("Mailroom staff", { nl: "Postmedewerker" }),
        },
      },
    },
  },
  bindings: {
    "mailroom.Mail": { capability: "std.EmailV1", from: "deployment.mail" },
    "mailroom.Billing": { capability: "invoice.BillingV1", from: "deployment.billing" },
  },
  models: {
    "mailroom.Service": {
      parent: Customer,
      label: message("Mail service", { nl: "Postdienst" }),
      invariants: ["Service.require.1"],
      locks: ["Service.lock.1"],
      readGrants: [{ rule: "Service.read.1" }, { rule: "Service.read.2" }],
      fields: {
        location: { type: Location },
        recipient: { type: Contact, label: recipientCaption },
        from: { type: "datetime", label: message("Start", { nl: "Begin" }) },
        until: { type: "datetime", label: message("End", { nl: "Einde" }) },
        instructions: { type: "text" },
        forwarding: {
          type: "text",
          nullable: true,
          label: message("Forwarding instructions", { nl: "Doorzendinstructies" }),
        },
        revision: { type: "int", default: 1n },
        verified: {
          type: "bool",
          default: false,
          label: message("Verified", { nl: "Geverifieerd" }),
        },
        source: { type: "text", unique: true, label: sourceCaption },
        term: {
          type: Term,
          nullable: true,
          label: message("Purchased paid term", { nl: "Gekochte betaalde termijn" }),
        },
        paid_evidence: {
          type: "text",
          nullable: true,
          label: message("Paid-service evidence", { nl: "Bewijs betaalde dienst" }),
        },
        currency: { type: "currency" },
        billing: {
          type: "bool",
          default: false,
          label: message("Invoice handling fees", { nl: "Afhandelingskosten factureren" }),
        },
        active: { type: "bool", default: true },
      },
    },
    "mailroom.Delegate": {
      parent: "mailroom.Service",
      label: message("Collection delegate", { nl: "Afhaalgemachtigde" }),
      readGrants: [{ rule: "Delegate.read.1" }],
      unique: [{ fields: ["contact", "account"] }],
      invariants: ["Delegate.require.1"],
      locks: ["Delegate.lock.1"],
      fields: {
        contact: { type: Contact, label: message("Nominated contact", { nl: "Genomineerde contactpersoon" }) },
        account: { type: "user", label: accountCaption },
        active: { type: "bool", default: true },
      },
    },
    "mailroom.Item": {
      label: message("Mail item", { nl: "Poststuk" }),
      invariants: ["Item.require.1"],
      readGrants: [
        { rule: "Item.read.1" },
        {
          rule: "Item.read.2",
          fields: ["service", "recipient", "kind", "state", "notice_state", "notification.status", "completed", "created"],
        },
      ],
      fields: {
        location: { type: Location },
        service: { type: "mailroom.Service", nullable: true },
        recipient: { type: Contact, nullable: true, label: recipientCaption },
        source: { type: "text", unique: true, label: sourceCaption },
        kind: {
          type: "enum",
          cases: ["letter", "parcel"],
          label: {
            text: kindCaption,
            values: {
              letter: message("Letter", { nl: "Brief" }),
              parcel: message("Parcel", { nl: "Pakket" }),
            },
          },
        },
        storage: { type: "text", label: storageCaption },
        photo: { type: "file", nullable: true, label: photoCaption },
        state: {
          type: "enum",
          cases: [
            "unmatched",
            "received",
            "notified",
            "collection_ready",
            "collected",
            "forward_pending",
            "forwarded",
            "returned",
          ],
          default: "unmatched",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              unmatched: message("Unmatched", { nl: "Niet gekoppeld" }),
              received: message("Received", { nl: "Ontvangen" }),
              notified: message("Notified", { nl: "Gemeld" }),
              collection_ready: message("Ready for collection", { nl: "Klaar om af te halen" }),
              collected: message("Collected", { nl: "Afgehaald" }),
              forward_pending: message("Forwarding pending", { nl: "Doorzending in afwachting" }),
              forwarded: message("Forwarded", { nl: "Doorgestuurd" }),
              returned: message("Returned", { nl: "Geretourneerd" }),
            },
          },
        },
        reminders: { type: "int", default: 0n },
        reminder_delay: { type: "duration", default: 604800000n },
        reminder_limit: { type: "int", default: 2n, min: 0n, max: 5n },
        history_days: { type: "int", default: 180n, min: 1n },
        retention_until: { type: "datetime", nullable: true },
        dispatch: { type: "mailroom.Dispatch", nullable: true },
        notification: {
          type: "delivery",
          operation: "mailroom.Mail.send",
          nullable: true,
          label: message("Notification reference", { nl: "Meldingsreferentie" }),
        },
        completed: {
          type: "datetime",
          nullable: true,
          label: message("Completed at", { nl: "Afgerond op" }),
        },
        incident: { type: "text", nullable: true, label: incidentCaption },
      },
      derived: {
        notice_state: {
          type: "std.DeliveryResult.status",
          nullable: true,
          handler: "Item.notice_state",
          label: {
            text: message("Notification", { nl: "Melding" }),
            values: {
              pending: message("Sending", { nl: "Wordt verzonden" }),
              succeeded: message("Accepted", { nl: "Geaccepteerd" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Uncertain", { nl: "Onzeker" }),
              skipped: message("Skipped", { nl: "Overgeslagen" }),
            },
          },
        },
      },
    },
    "mailroom.Handling": {
      parent: "mailroom.Item",
      label: message("Handling record", { nl: "Afhandelingsregistratie" }),
      locks: ["Handling.lock.1"],
      readGrants: [
        { rule: "Handling.read.1" },
        {
          rule: "Handling.read.2",
          fields: [
            "kind",
            "account",
            "instruction",
            "revision",
            "destination",
            "evidence",
            "carrier",
            "fee",
            "created",
          ],
        },
      ],
      fields: {
        kind: {
          type: "enum",
          cases: ["collection", "forward", "return", "correction"],
          label: {
            text: kindCaption,
            values: {
              collection: message("Collection", { nl: "Afhalen" }),
              forward: message("Forwarding", { nl: "Doorzending" }),
              return: message("Return", { nl: "Retour" }),
              correction: message("Correction", { nl: "Correctie" }),
            },
          },
        },
        account: { type: "user", nullable: true, label: accountCaption },
        instruction: {
          type: "text",
          label: message("Recorded instruction", { nl: "Vastgelegde instructie" }),
        },
        destination: {
          type: "text",
          nullable: true,
          label: message("Destination", { nl: "Bestemming" }),
        },
        evidence: { type: "text" },
        carrier: { type: "text", nullable: true, label: carrierCaption },
        fee: { type: "money", nullable: true, label: feeCaption },
        source: { type: "text", unique: true, label: sourceCaption },
        revision: { type: "int" },
        dispatch: { type: "mailroom.Dispatch", nullable: true },
        author: { type: "user", server: "actor", label: message("Author", { nl: "Auteur" }) },
      },
    },
    "mailroom.Dispatch": {
      parent: "mailroom.Item",
      label: message("Forwarding attempt", { nl: "Doorzendpoging" }),
      readGrants: [{ rule: "Dispatch.read.1" }],
      invariants: ["Dispatch.require.1"],
      locks: ["Dispatch.lock.1"],
      fields: {
        source: { type: "text", unique: true },
        instruction: { type: "text" },
        instruction_revision: {
          type: "int",
          label: message("Instruction version", { nl: "Instructieversie" }),
        },
        destination: {
          type: "text",
          label: message("Frozen postal destination", { nl: "Vastgelegde postbestemming" }),
        },
        fee: { type: "money", nullable: true, label: feeCaption },
        charge: { type: Charge, nullable: true },
        state: {
          type: "enum",
          cases: ["pending", "unknown", "dispatched", "cancelled"],
          default: "pending",
          label: {
            text: message("Dispatch", { nl: "Verzending" }),
            values: {
              pending: message("Pending", { nl: "In afwachting" }),
              unknown: message("Uncertain", { nl: "Onzeker" }),
              dispatched: message("Evidenced dispatch", { nl: "Verzending met bewijs" }),
              cancelled: message("No dispatch recorded", { nl: "Geen verzending vastgelegd" }),
            },
          },
        },
        charge_state: {
          type: "enum",
          cases: ["none", "pending", "confirmed", "failed", "unknown"],
          default: "none",
          label: {
            text: message("Fee invoice", { nl: "Kostenfactuur" }),
            values: {
              none: message("No invoice requested", { nl: "Geen factuur aangevraagd" }),
              pending: message("Invoice requested", { nl: "Factuur aangevraagd" }),
              confirmed: message("Invoice created", { nl: "Factuur aangemaakt" }),
              failed: message("Invoice failed", { nl: "Factuur mislukt" }),
              unknown: message("Invoice uncertain", { nl: "Factuur onzeker" }),
            },
          },
        },
        charge_delivery: { type: "text", nullable: true },
        reconcile_delivery: { type: "text", nullable: true },
        invoice: { type: "text", nullable: true },
        revision: { type: "int", default: 1n },
      },
    },
  },
  events: {
    "mailroom.Reminder": { fields: { item: { type: "mailroom.Item" }, number: { type: "int" } } },
  },
  pure: {
    "mailroom.recipient": {
      handler: "recipient",
      inputs: { person: { type: "user" }, service: { type: "mailroom.Service" } },
      result: "bool",
    },
    "mailroom.manage": {
      handler: "manage",
      inputs: { person: { type: "user" }, service: { type: "mailroom.Service" } },
      result: "bool",
    },
    "mailroom.live": {
      handler: "live",
      inputs: { service: { type: "mailroom.Service" } },
      result: "bool",
    },
    "mailroom.fee_charge": {
      handler: "fee_charge",
      inputs: { item: { type: "mailroom.Item" }, fee: { type: "money", nullable: true } },
      result: { type: Charge, nullable: true },
    },
    "mailroom.delegate_eligible": {
      handler: "delegate_eligible",
      inputs: { delegate: { type: "mailroom.Delegate" } },
      result: "bool",
    },
    "mailroom.permitted_collector": {
      handler: "permitted_collector",
      inputs: { person: { type: "user" }, service: { type: "mailroom.Service" } },
      result: "bool",
    },
  },
  preferences: {
    mailroom: {
      fields: {
        location: { type: Location, nullable: true, default: null },
        view: {
          type: "enum",
          cases: ["all", "collection", "forwarding", "history"],
          default: "all",
          label: {
            text: message("Mail view", { nl: "Postweergave" }),
            values: {
              all: message("All mail", { nl: "Alle post" }),
              collection: message("Collection queue", { nl: "Afhaalwachtrij" }),
              forwarding: message("Forwarding queue", { nl: "Doorzendwachtrij" }),
              history: message("Mail history", { nl: "Postgeschiedenis" }),
            },
          },
        },
      },
    },
  },
  operations: {
    "mailroom.configure": {
      handler: "configure",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Configure mail service", { nl: "Postdienst instellen" }),
      inputs: {
        customer: { type: Customer },
        location: { type: Location },
        recipient: { type: Contact },
        from: { type: "datetime" },
        until: { type: "datetime" },
        source: { type: "text" },
        term: {
          type: Term,
          nullable: true,
          label: message("Purchased paid term", { nl: "Gekochte betaalde termijn" }),
        },
        paid_evidence: { type: "text", nullable: true },
        currency: { type: "currency" },
        billing: { type: "bool", default: false },
        instructions: { type: "text" },
        forwarding: { type: "text", nullable: true },
      },
      description: message(
        "Record the owning paid-service reference, without inventing a membership notification feed.",
        {
          nl: "Leg de verwijzing naar de betaalde dienst vast zonder een lidmaatschapsmeldingsfeed te verzinnen.",
        },
      ),
    },
    "mailroom.service_status": {
      handler: "service_status",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Review service availability", { nl: "Dienstbeschikbaarheid beoordelen" }),
      inputs: {
        service: { type: "mailroom.Service" },
        active: { type: "bool" },
        until: { type: "datetime" },
        paid_evidence: { type: "text", nullable: true },
      },
      description: message(
        "Change future service availability without resolving or deleting held physical items.",
        {
          nl: "Wijzig toekomstige dienstbeschikbaarheid zonder bewaarde fysieke items af te handelen of te verwijderen.",
        },
      ),
    },
    "mailroom.instructions": {
      handler: "instructions",
      by: "authenticated",
      read: false,
      label: message("Update handling instructions", { nl: "Afhandelingsinstructies bijwerken" }),
      inputs: {
        service: { type: "mailroom.Service" },
        instructions: { type: "text" },
        forwarding: { type: "text", nullable: true },
        revision: { type: "int" },
      },
      description: message(
        "Update authorized instructions without changing an existing forwarding snapshot.",
        {
          nl: "Werk geautoriseerde instructies bij zonder een bestaande doorzendmomentopname te wijzigen.",
        },
      ),
    },
    "mailroom.uncertain": {
      handler: "uncertain",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Record uncertain dispatch", { nl: "Onzekere verzending registreren" }),
      inputs: {
        dispatch: { type: "mailroom.Dispatch" },
        revision: { type: "int" },
        evidence: { type: "text" },
      },
      description: message(
        "Keep uncertain forwarding pending and append the attempted-dispatch evidence.",
        { nl: "Houd onzekere doorzending in behandeling en voeg bewijs van de verzendpoging toe." },
      ),
    },
    "mailroom.retry_fee": {
      handler: "retry_fee",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Retry forwarding invoice", { nl: "Doorzendfactuur opnieuw proberen" }),
      inputs: { dispatch: { type: "mailroom.Dispatch" } },
      description: message("Re-submit only the frozen fee with its original billing source.", {
        nl: "Dien uitsluitend de vastgelegde kosten opnieuw in met de oorspronkelijke facturatiebron.",
      }),
    },
    "mailroom.Delegate.create": {
      handler: "createDelegate",
      kind: "create",
      model: "mailroom.Delegate",
      by: "authenticated",
      read: false,
      inputs: { parent: { type: "mailroom.Service" }, fields: ["contact", "account"] },
      when: "Delegate",
    },
    "mailroom.Delegate.update": {
      handler: "updateDelegate",
      kind: "update",
      model: "mailroom.Delegate",
      by: "authenticated",
      read: false,
      inputs: { record: { type: "mailroom.Delegate" }, changes: { fields: ["active"] } },
      when: "Delegate",
    },
    "mailroom.receive": {
      handler: "receive",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Record receipt", { nl: "Ontvangst registreren" }),
      description: message(
        "Receive one physical item; unmatched recipients remain a restricted review.",
        {
          nl: "Ontvang één fysiek item; niet-gekoppelde ontvangers blijven in een afgeschermde beoordeling.",
        },
      ),
      inputs: {
        location: { type: Location },
        source: { type: "text", label: sourceCaption },
        kind: { type: "mailroom.Item.kind" },
        storage: { type: "text", label: storageCaption },
        service: { type: "mailroom.Service", nullable: true, default: null },
        photo: { type: "file", nullable: true, default: null, label: photoCaption },
      },
    },
    "mailroom.match": {
      handler: "match",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Match recipient", { nl: "Ontvanger koppelen" }),
      description: message(
        "Match an unresolved receipt against the current paid service and notify separately.",
        {
          nl: "Koppel een onopgeloste ontvangst aan de huidige betaalde dienst en meld afzonderlijk.",
        },
      ),
      inputs: { item: { type: "mailroom.Item" }, service: { type: "mailroom.Service" } },
    },
    "mailroom.collect": {
      handler: "collect",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Record collection", { nl: "Afhaling registreren" }),
      description: message(
        "Record one evidenced collection by the currently verified recipient or delegate, including after service expiry.",
        {
          nl: "Registreer één bewezen afhaling door de huidige geverifieerde ontvanger of gemachtigde, ook na het verlopen van de dienst.",
        },
      ),
      inputs: {
        item: { type: "mailroom.Item" },
        collector: { type: "user", label: message("Collector", { nl: "Afhaler" }) },
        evidence: { type: "text" },
      },
    },
    "mailroom.forward": {
      handler: "forward",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Prepare forwarding", { nl: "Doorzending voorbereiden" }),
      description: message(
        "Freeze a unique forwarding attempt and optional same-currency invoice charge.",
        { nl: "Leg een unieke doorzendpoging en optionele factuurkosten in dezelfde valuta vast." },
      ),
      inputs: {
        item: { type: "mailroom.Item" },
        fee: { type: "money", nullable: true, label: feeCaption },
        destination_verified: {
          type: "bool",
          label: message("Postal destination verified", { nl: "Postbestemming geverifieerd" }),
        },
      },
    },
    "mailroom.dispatched": {
      handler: "dispatched",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Record dispatch", { nl: "Verzending registreren" }),
      description: message(
        "Confirm the exact current forwarding attempt with carrier evidence, independently of billing.",
        {
          nl: "Bevestig de exacte huidige doorzendpoging met vervoerdersbewijs, onafhankelijk van facturatie.",
        },
      ),
      inputs: {
        dispatch: { type: "mailroom.Dispatch" },
        revision: { type: "int" },
        carrier: { type: "text", label: carrierCaption },
        evidence: { type: "text" },
      },
    },
    "mailroom.return_item": {
      handler: "return_item",
      by: "mailroom.mail_staff",
      read: false,
      label: message("Record return", { nl: "Retour registreren" }),
      description: message(
        "Return only by an evidenced staff decision; an unresolved dispatch needs an explicit no-dispatch confirmation.",
        {
          nl: "Retourneer alleen op basis van een bewezen personeelsbesluit; een onopgeloste verzending vereist expliciete bevestiging dat niet is verzonden.",
        },
      ),
      inputs: {
        item: { type: "mailroom.Item" },
        evidence: { type: "text" },
        no_dispatch: { type: "bool", default: false },
      },
    },
    "mailroom.incident": {
      handler: "incident",
      by: "mailroom.mail_staff",
      read: false,
      label: incidentCaption,
      description: message("Append corrections without rewriting receipt or handling evidence.", {
        nl: "Voeg correcties toe zonder ontvangst- of afhandelingsbewijs te herschrijven.",
      }),
      inputs: { item: { type: "mailroom.Item" }, reason: { type: "text" } },
    },
  },
  handlers: {
    "mailroom.fee_result": {
      handler: "fee_result",
      on: { capability: "mailroom.Billing", operation: "charge", event: "completed" },
    },
    "mailroom.fee_reconciled": {
      handler: "fee_reconciled",
      on: { capability: "mailroom.Billing", operation: "reconcile", event: "completed" },
    },
    "mailroom.remind": { handler: "remind", on: "mailroom.Reminder" },
    "mailroom.notice_result": {
      handler: "notice_result",
      on: { capability: "mailroom.Mail", operation: "send", event: "completed" },
    },
  },
  pages: [
    mailroomPageDescriptor,
    myMailPageDescriptor,
  ],
  disabled: [
    "mailroom.Service.create",
    "mailroom.Service.update",
    "mailroom.Service.delete",
    "mailroom.Delegate.delete",
    "mailroom.Item.create",
    "mailroom.Item.update",
    "mailroom.Item.delete",
    "mailroom.Handling.create",
    "mailroom.Handling.update",
    "mailroom.Handling.delete",
    "mailroom.Dispatch.create",
    "mailroom.Dispatch.update",
    "mailroom.Dispatch.delete",
  ],
};

async function recipient(c, person, service) {
  return (
    service.parent.active &&
    service.parent.archived_at === null &&
    service.recipient.archived_at === null &&
    service.recipient.verified &&
    service.recipient.account !== null &&
    same(service.recipient.account, person)
  );
}
async function manage(c, person, service) {
  return (
    (await recipient(c, person, service)) ||
    (await has_role(c, person, service.parent, "administrator"))
  );
}
async function live(c, service) {
  return (
    service.active &&
    service.verified &&
    service.parent.active &&
    service.parent.archived_at === null &&
    service.location.active &&
    service.recipient.archived_at === null &&
    service.recipient.verified &&
    service.recipient.account !== null &&
    compareInstant(service.from, c.now) <= 0 &&
    compareInstant(c.now, service.until) < 0 &&
    ((service.term !== null &&
      same(service.term.parent.parent, service.parent) &&
      service.term.mail &&
      service.term.locations.some((location) => same(location, service.location)) &&
      service.term.price.currency === service.currency &&
      (await eligible_term(c, service.recipient.account, service.term, c.now))) ||
      (service.term === null &&
        service.paid_evidence !== null &&
        service.paid_evidence.trim() !== ""))
  );
}
async function fee_charge(c, item, fee) {
  return await first(
    [
      {
        source: format(c, "mail-forward-{item}", { item: item.id }),
        customer: item.service.parent.id,
        location: item.location.id,
        description: format(c, message("Forwarding fee", { nl: "Doorzendkosten" }), {
          locale: null,
        }),
        amount: fee ?? money(0n, item.service.currency),
        due: local_date(c.now, item.location.timezone),
      },
    ].filter((value) => item.service.billing && fee !== null && fee.minor > 0n),
  );
}
async function delegate_eligible(c, delegate) {
  return (
    delegate.parent.parent.active &&
    delegate.parent.parent.archived_at === null &&
    delegate.contact.archived_at === null &&
    delegate.contact.verified &&
    same(delegate.contact.account, delegate.account)
  );
}
async function permitted_collector(c, person, service) {
  return (
    (await recipient(c, person, service)) ||
    (await any(
      records(c, "mailroom.Delegate", { parent: service }),
      async (delegate) => same(delegate.account, person) && delegate.active &&
        (await delegate_eligible(c, delegate)),
    ))
  );
}

export function canApp() {
  const crudWhen = {
    Delegate: async (c, row) =>
      ((await owns(c, c.actor, row.parent.parent)) ||
        (await has_role(c, c.actor, row.parent.parent, "administrator"))) &&
      (!row.active || (await delegate_eligible(c, row))),
  };
  return {
    derives: {"Item.notice_state": async(c,row) => (await delivery(c,{record:row,field:"notification"},["status"]))?.status ?? null},
    crudWhen,
    recipient,
    manage,
    live,
    fee_charge,
    permitted_collector,
    delegate_eligible,
    retention: { Item: (c, row) => row.retention_until },
    read: {
      "Service.read.1": async (c, row) =>
        hasRole(c, "mailroom.mail_staff") && (await can_work(c, c.actor, row.location)),
      "Service.read.2": async (c, row) =>
        hasRole(c, "authenticated") && (await manage(c, c.actor, row)),
      "Delegate.read.1": async (c, row) =>
        hasRole(c, "authenticated") &&
        (same(row.account, c.actor) || (await manage(c, c.actor, row.parent))),
      "Item.read.1": async (c, row) =>
        hasRole(c, "mailroom.mail_staff") && (await can_work(c, c.actor, row.location)),
      "Item.read.2": async (c, row) =>
        hasRole(c, "authenticated") &&
        row.service !== null &&
        (await recipient(c, c.actor, row.service)),
      "Handling.read.1": async (c, row) =>
        hasRole(c, "mailroom.mail_staff") && (await can_work(c, c.actor, row.parent.location)),
      "Handling.read.2": async (c, row) =>
        hasRole(c, "authenticated") &&
        row.parent.service !== null &&
        (await recipient(c, c.actor, row.parent.service)),
      "Dispatch.read.1": async (c, row) =>
        hasRole(c, "mailroom.mail_staff") && (await can_work(c, c.actor, row.parent.location)),
    },
    invariants: {
      "Service.require.1": (c, row) =>
        compareInstant(row.from, row.until) < 0 &&
        same(row.recipient.parent, row.parent) &&
        row.revision > 0n &&
        (row.term === null ||
          (same(row.term.parent.parent, row.parent) &&
            row.term.locations.some((location) => same(location, row.location)) &&
            row.currency === row.term.price.currency)),
      "Delegate.require.1": (c, row) => same(row.contact.parent, row.parent.parent),
      "Item.require.1": (c, row) =>
        (row.service === null ||
          (same(row.service.location, row.location) &&
            same(row.recipient, row.service.recipient))) &&
        (row.dispatch === null || same(row.dispatch.parent, row)),
      "Dispatch.require.1": (c, row) =>
        (row.fee === null ||
          (row.fee.minor >= 0n &&
            row.parent.service !== null &&
            row.fee.currency === row.parent.service.currency)) &&
        (row.charge === null || row.charge.source === row.source),
    },
    locks: {
      "Delegate.lock.1": { fields: ["parent", "contact", "account"] },
      "Service.lock.1": {
        fields: ["parent", "location", "recipient", "source", "term", "currency", "billing"],
      },
      "Dispatch.lock.1": {
        fields: ["source", "instruction", "instruction_revision", "destination", "fee", "charge"],
      },
      "Handling.lock.1": {
        fields: [
          "kind",
          "account",
          "instruction",
          "revision",
          "destination",
          "evidence",
          "carrier",
          "fee",
          "source",
          "dispatch",
          "author",
        ],
      },
    },
    async configure(
      c,
      {
        customer,
        location,
        recipient: contact,
        from,
        until,
        source,
        term = null,
        paid_evidence = null,
        currency,
        billing = false,
        instructions,
        forwarding = null,
      },
    ) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, location)) &&
          customer.active &&
          customer.archived_at === null &&
          same(contact.parent, customer) &&
          contact.verified &&
          contact.account !== null &&
          compareInstant(from, until) < 0 &&
          source.trim() !== "" &&
          instructions.trim() !== "" &&
          (forwarding === null || forwarding.trim() !== ""),
      );
      check(
        (term !== null &&
          same(term.parent.parent, customer) &&
          term.mail &&
          term.locations.some((site) => same(site, location)) &&
          term.price.currency === currency) ||
          (term === null && paid_evidence !== null && paid_evidence.trim() !== ""),
      );
      await create(c, "mailroom.Service", {
        parent: customer,
        location,
        recipient: contact,
        from,
        until,
        source,
        term,
        paid_evidence,
        currency,
        billing,
        instructions,
        forwarding,
        verified: true,
      });
    },
    async service_status(c, { service, active, until, paid_evidence = null }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, service.location)) &&
          compareInstant(service.from, until) < 0 &&
          (service.term !== null ||
            !active ||
            (paid_evidence !== null && paid_evidence.trim() !== "")),
      );
      await set(c, service, { active, until, paid_evidence });
    },
    async createDelegate(c, input) {
      check(hasRole(c, "authenticated"), "forbidden");
      await create(c, "mailroom.Delegate", input, { when: crudWhen.Delegate });
    },
    async updateDelegate(c, { record, changes }) {
      check(hasRole(c, "authenticated"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Delegate });
    },
    async instructions(c, { service, instructions, forwarding = null, revision }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        (await manage(c, c.actor, service)) &&
          revision === service.revision &&
          instructions.trim() !== "" &&
          (forwarding === null || forwarding.trim() !== ""),
      );
      await set(c, service, { instructions, forwarding, revision: int64(service.revision + 1n) });
    },
    async receive(c, { location, source, kind, storage, service = null, photo = null }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, location)) &&
          source.trim() !== "" &&
          storage.trim() !== "" &&
          !(await any(records(c, "mailroom.Item"), (item) => item.source === source)),
      );
      check(service === null || (same(service.location, location) && (await live(c, service))));
      const item = await create(c, "mailroom.Item", { location, source, kind, storage, photo });
      if (service !== null) {
        await set(c, item, { service, recipient: service.recipient, state: "received" });
        const notice = await send(
          c,
          "mailroom.Mail.send",
          {
            to: service.recipient.email,
            subject: format(c, message("Mail received", { nl: "Post ontvangen" }), {
              locale: null,
            }),
            body: format(
              c,
              message("An item is available for authorized collection.", {
                nl: "Er ligt een item klaar dat door een bevoegde persoon kan worden afgehaald.",
              }),
              { locale: null },
            ),
          },
          {
            when: async (current) =>
              ["received", "notified", "collection_ready"].includes(item.state) &&
              (await recipient(current, service.recipient.account, service)),
          },
        );
        await set(c, item, { notification: notice });
        await schedule(
          c,
          format(c, "mail-reminder-{item}", { item: item.id }),
          addDuration(c.now, item.reminder_delay),
          "mailroom.Reminder",
          { item, number: 1n },
        );
      }
    },
    async match(c, { item, service }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, item.location)) &&
          item.state === "unmatched" &&
          same(service.location, item.location) &&
          (await live(c, service)),
      );
      await set(c, item, { service, recipient: service.recipient, state: "received" });
      const notice = await send(
        c,
        "mailroom.Mail.send",
        {
          to: service.recipient.email,
          subject: format(c, message("Mail received", { nl: "Post ontvangen" }), { locale: null }),
          body: format(
            c,
            message("An item is available for authorized collection.", {
              nl: "Er ligt een item klaar dat door een bevoegde persoon kan worden afgehaald.",
            }),
            { locale: null },
          ),
        },
        {
          when: async (current) =>
            ["received", "notified", "collection_ready"].includes(item.state) &&
            (await recipient(current, service.recipient.account, service)),
        },
      );
      await set(c, item, { notification: notice });
      await schedule(
        c,
        format(c, "mail-reminder-{item}", { item: item.id }),
        addDuration(c.now, item.reminder_delay),
        "mailroom.Reminder",
        { item, number: 1n },
      );
    },
    async collect(c, { item, collector, evidence }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, item.location)) &&
          ["received", "notified", "collection_ready"].includes(item.state) &&
          evidence.trim() !== "" &&
          item.service !== null,
      );
      check(await permitted_collector(c, collector, item.service));
      await create(c, "mailroom.Handling", {
        parent: item,
        kind: "collection",
        account: collector,
        instruction: item.service.instructions,
        revision: item.service.revision,
        evidence,
        source: c.operation.id,
      });
      await set(c, item, {
        state: "collected",
        completed: c.now,
        retention_until: addDuration(c.now, int64(item.history_days * 86400000n)),
      });
      await cancel(c, format(c, "mail-reminder-{item}", { item: item.id }));
    },
    async forward(c, { item, fee = null, destination_verified }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, item.location)) &&
          item.service !== null &&
          ["received", "notified", "collection_ready"].includes(item.state) &&
          item.dispatch === null &&
          (await live(c, item.service)) &&
          item.service.forwarding !== null &&
          item.service.forwarding.trim() !== "",
      );
      check(
        destination_verified &&
          (fee === null || (fee.minor >= 0n && fee.currency === item.service.currency)),
      );
      const source = format(c, "mail-forward-{item}", { item: item.id });
      const dispatch = await create(c, "mailroom.Dispatch", {
        parent: item,
        source,
        instruction: item.service.instructions,
        instruction_revision: item.service.revision,
        destination: item.service.forwarding,
        fee,
        charge: await fee_charge(c, item, fee),
      });
      await set(c, item, { state: "forward_pending", dispatch });
      await cancel(c, format(c, "mail-reminder-{item}", { item: item.id }));
      if (dispatch.charge !== null) {
        const delivery = await send(c, "mailroom.Billing.charge", { value: dispatch.charge });
        await set(c, dispatch, { charge_delivery: delivery.id, charge_state: "pending" });
      }
    },
    async dispatched(c, { dispatch, revision, carrier, evidence }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, dispatch.parent.location)) &&
          dispatch.parent.state === "forward_pending" &&
          same(dispatch.parent.dispatch, dispatch) &&
          ["pending", "unknown"].includes(dispatch.state) &&
          revision === dispatch.revision &&
          carrier.trim() !== "" &&
          evidence.trim() !== "",
      );
      await create(c, "mailroom.Handling", {
        parent: dispatch.parent,
        kind: "forward",
        instruction: dispatch.instruction,
        revision: dispatch.instruction_revision,
        destination: dispatch.destination,
        carrier,
        evidence,
        fee: dispatch.fee,
        dispatch,
        source: dispatch.source,
      });
      await set(c, dispatch, { state: "dispatched", revision: int64(dispatch.revision + 1n) });
      await set(c, dispatch.parent, {
        state: "forwarded",
        completed: c.now,
        retention_until: addDuration(c.now, int64(dispatch.parent.history_days * 86400000n)),
      });
    },
    async uncertain(c, { dispatch, revision, evidence }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, dispatch.parent.location)) &&
          dispatch.parent.state === "forward_pending" &&
          same(dispatch.parent.dispatch, dispatch) &&
          ["pending", "unknown"].includes(dispatch.state) &&
          dispatch.revision === revision &&
          evidence.trim() !== "",
      );
      await create(c, "mailroom.Handling", {
        parent: dispatch.parent,
        kind: "correction",
        instruction: dispatch.instruction,
        revision: dispatch.instruction_revision,
        destination: dispatch.destination,
        evidence,
        dispatch,
        source: c.operation.id,
      });
      await set(c, dispatch, { state: "unknown", revision: int64(dispatch.revision + 1n) });
      await set(c, dispatch.parent, { incident: evidence });
    },
    async return_item(c, { item, evidence, no_dispatch = false }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, item.location)) &&
          ["unmatched", "received", "notified", "collection_ready", "forward_pending"].includes(
            item.state,
          ) &&
          evidence.trim() !== "",
      );
      check(item.state !== "forward_pending" || no_dispatch);
      await create(c, "mailroom.Handling", {
        parent: item,
        kind: "return",
        instruction: "Recorded return",
        revision: item.service?.revision ?? 0n,
        evidence,
        dispatch: item.dispatch,
        source: c.operation.id,
      });
      if (item.dispatch !== null)
        await set(c, item.dispatch, {
          state: "cancelled",
          revision: int64(item.dispatch.revision + 1n),
        });
      await set(c, item, {
        state: "returned",
        completed: c.now,
        retention_until: addDuration(c.now, int64(item.history_days * 86400000n)),
      });
      await cancel(c, format(c, "mail-reminder-{item}", { item: item.id }));
    },
    async incident(c, { item, reason }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check((await can_work(c, c.actor, item.location)) && reason.trim() !== "");
      await create(c, "mailroom.Handling", {
        parent: item,
        kind: "correction",
        instruction: "Staff correction",
        revision: item.service?.revision ?? 0n,
        evidence: reason,
        dispatch: item.dispatch,
        source: c.operation.id,
      });
      await set(c, item, { incident: reason });
    },
    async retry_fee(c, { dispatch }) {
      check(hasRole(c, "mailroom.mail_staff"), "forbidden");
      check(
        (await can_work(c, c.actor, dispatch.parent.location)) &&
          dispatch.charge !== null &&
          ["failed", "unknown"].includes(dispatch.charge_state),
      );
      const delivery = await send(c, "mailroom.Billing.reconcile", { source: dispatch.source });
      await set(c, dispatch, {
        reconcile_delivery: delivery.id,
        charge_delivery: null,
        charge_state: "pending",
      });
    },
    async fee_result(c, { event }) {
      for (const dispatch of await records(c, "mailroom.Dispatch", {
        where: (row) => row.charge_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (event.status === "succeeded" && event.result !== null) {
          check(event.result.source === dispatch.source);
          if (event.result.state === "confirmed")
            await set(c, dispatch, { charge_state: "confirmed", invoice: event.result.reference });
          else await set(c, dispatch, { charge_state: "failed" });
        } else if (event.status === "failed") await set(c, dispatch, { charge_state: "failed" });
        else if (event.status === "unknown") await set(c, dispatch, { charge_state: "unknown" });
      }
    },
    async fee_reconciled(c, { event }) {
      for (const dispatch of await records(c, "mailroom.Dispatch", {
        where: (row) => row.reconcile_delivery === event.delivery_id,
        limit: 1n,
      })) {
        if (event.status === "succeeded") {
          if (event.result !== null) {
            check(
              event.result.source === dispatch.source &&
                equalMoney(event.result.amount, dispatch.fee),
            );
            await set(c, dispatch, {
              charge_state: "confirmed",
              invoice: event.result.invoice,
              reconcile_delivery: null,
            });
          } else {
            const delivery = await send(c, "mailroom.Billing.charge", { value: dispatch.charge });
            await set(c, dispatch, {
              charge_delivery: delivery.id,
              charge_state: "pending",
              reconcile_delivery: null,
            });
          }
        } else if (["failed", "unknown"].includes(event.status))
          await set(c, dispatch, { charge_state: "unknown", reconcile_delivery: null });
      }
    },
    async remind(c, { event }) {
      const item = event.item;
      if (
        ["received", "notified", "collection_ready"].includes(item.state) &&
        item.service !== null &&
        event.number === int64(item.reminders + 1n) &&
        event.number <= item.reminder_limit &&
        (await recipient(c, item.service.recipient.account, item.service))
      ) {
        const notice = await send(
          c,
          "mailroom.Mail.send",
          {
            to: item.service.recipient.email,
            subject: format(
              c,
              message("Mail awaiting collection", { nl: "Post wacht op afhaling" }),
              { locale: null },
            ),
            body: format(
              c,
              message("Please arrange authorized collection of your item.", {
                nl: "Regel bevoegde afhaling van je poststuk.",
              }),
              { locale: null },
            ),
          },
          {
            when: async (current) =>
              ["received", "notified", "collection_ready"].includes(item.state) &&
              (await recipient(current, item.service.recipient.account, item.service)),
          },
        );
        await set(c, item, {
          notification: notice,
          reminders: event.number,
        });
        if (item.reminders < item.reminder_limit)
          await schedule(
            c,
            format(c, "mail-reminder-{item}", { item: item.id }),
            addDuration(c.now, item.reminder_delay),
            "mailroom.Reminder",
            { item, number: int64(item.reminders + 1n) },
          );
      }
    },
    async notice_result(c, { event }) {
      for (const item of await records(c, "mailroom.Item", {
        where: async row => (await delivery(c,{record:row,field:"notification"},["id"]))?.id === event.delivery_id,
        limit: 1n,
      })) {
        if (event.status === "succeeded" && event.result !== null && item.state === "received")
          await set(c, item, {state: "notified"});
      }
    },
  };
}

export async function mailroomPage(c, bindings) {
  return renderPage(
    c,
    mailroomPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Service entitlement", { nl: "Dienstrecht" }),
        children: [
          form({ context: c, operation: "mailroom.configure" }),
          list({
            context: c,
            model: "mailroom.Service",
            display: "split",
            renderRow: (service, view) => [
              text({
                context: view,
                values: [
                  service.location,
                  service.recipient,
                  service.from,
                  service.until,
                  service.active,
                  service.source,
                  service.term,
                  service.paid_evidence,
                ],
              }),
              actions({
                context: view,
                operations: ["mailroom.service_status"],
                boundArgs: { service },
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Mail receipt", { nl: "Post ontvangen" }),
        children: [form({ context: c, operation: "mailroom.receive" })],
      }),
      card({
        context: c,
        title: message("Located items", { nl: "Gelokaliseerde post" }),
        children: [
          tabs({ context: c, selector: "mailroom.view", value: c.preferences.mailroom.view }),
          table({
            context: c,
            model: "mailroom.Item",
            where: (item) => queue(c.preferences.mailroom.view, item),
            columns: [
              "location",
              "recipient",
              "kind",
              "storage",
              "state",
              "notice_state",
              "incident",
            ],
            filter: ["location", "state"],
            defaults: { location: c.preferences.mailroom.location },
            display: "split",
            renderRow: (item, view) => [
              text({ context: view, values: [item.service, item.photo, item.completed] }),
              actions({
                context: view,
                operations: [
                  "mailroom.match",
                  "mailroom.collect",
                  "mailroom.forward",
                  "mailroom.return_item",
                  "mailroom.incident",
                ],
                boundArgs: { item },
              }),
              list({
                context: view,
                model: "mailroom.Dispatch",
                parent: item,
                display: "split",
                renderRow: (dispatch, dispatchView) => [
                  text({
                    context: dispatchView,
                    values: [
                      dispatch.destination,
                      dispatch.instruction_revision,
                      dispatch.state,
                      dispatch.fee,
                      dispatch.charge_state,
                      dispatch.invoice,
                    ],
                  }),
                  form({
                    context: dispatchView,
                    operation: "mailroom.dispatched",
                    arguments: { dispatch, revision: dispatch.revision },
                  }),
                  form({
                    context: dispatchView,
                    operation: "mailroom.uncertain",
                    arguments: { dispatch, revision: dispatch.revision },
                  }),
                  actions({
                    context: dispatchView,
                    operations: ["mailroom.retry_fee"],
                    boundArgs: { dispatch },
                  }),
                ],
              }),
              table({
                context: view,
                model: "mailroom.Handling",
                parent: item,
                columns: [
                  "kind",
                  "instruction",
                  "revision",
                  "destination",
                  "evidence",
                  "carrier",
                  "fee",
                ],
              }),
              history({ context: view, record: item }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function myMailPage(c, bindings) {
  return renderPage(
    c,
    myMailPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Own service", { nl: "Eigen postdienst" }),
        children: [
          list({
            context: c,
            model: "mailroom.Service",
            display: "split",
            renderRow: (service, view) => [
              text({
                context: view,
                values: [
                  service.location,
                  service.from,
                  service.until,
                  service.instructions,
                  service.forwarding,
                  service.revision,
                ],
              }),
              form({
                context: view,
                operation: "mailroom.instructions",
                arguments: { service, revision: service.revision },
              }),
              form({
                context: view,
                operation: "mailroom.Delegate.create",
                arguments: { parent: service },
              }),
              list({
                context: view,
                model: "mailroom.Delegate",
                parent: service,
                renderRow: (delegate, rowView) => [
                  text({ context: rowView, values: [delegate.contact, delegate.account, delegate.active] }),
                  edit({
                    context: rowView,
                    operation: "mailroom.Delegate.update",
                    record: delegate,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Own mail outcomes", { nl: "Eigen postresultaten" }),
        children: [
          tabs({ context: c, selector: "mailroom.view", value: c.preferences.mailroom.view }),
          table({
            context: c,
            model: "mailroom.Item",
            where: (item) => queue(c.preferences.mailroom.view, item),
            columns: ["recipient", "kind", "state", "notice_state", "completed"],
            filter: ["state"],
            display: "split",
            renderRow: (item, view) => [
              table({
                context: view,
                model: "mailroom.Handling",
                parent: item,
                columns: [
                  "kind",
                  "account",
                  "instruction",
                  "revision",
                  "destination",
                  "evidence",
                  "carrier",
                  "fee",
                  "created",
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
  { provider: "customer", member: "test_company", alias: "test_company" },
  { provider: "customer", member: "test_contact", alias: "test_contact" },
  { provider: "customer", member: "test_admin", alias: "test_admin" },
  { provider: "customer", member: "test_directory_manager", alias: "test_directory_manager" },
  { provider: "customer", member: "test_directory_employee", alias: "test_directory_employee" },
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "member_terms", member: "paid_term", alias: "paid_term" },
  { provider: "member_terms", member: "allocated", alias: "allocated" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_company, test_contact, test_admin, test_directory_manager, test_directory_employee, test_site, test_worker, paid_term, allocated } =
    imported;
  const nominee = { dependencies: [], user: async (c, s) => ({}) };
  const unrelated = { dependencies: [], user: async (c, s) => ({}) };
  const mail_operator = { dependencies: [], user: async (c, s) => ({ roles: ["mailroom.mail_staff"] }) };
  const mail_employee = {
    model: "employee.Employee", dependencies: [mail_operator, test_site],
    value: async (c, s) => ({ user: s.mail_operator, home: s.test_site, locations: [s.test_site], start: date("2026-10-01"), role: "mail operator" }),
  };
  const service = {
    model: "mailroom.Service",
    dependencies: [test_company, test_contact, test_site, paid_term],
    value: async (c, s) => ({
      parent: s.test_company,
      location: s.test_site,
      recipient: s.test_contact,
      from: datetime("2020-01-01T00:00:00Z"),
      until: datetime("2099-01-01T00:00:00Z"),
      instructions: "Collection by verified recipient",
      verified: true,
      source: "mail-term",
      currency: "EUR",
      term: s.paid_term,
    }),
  };
  const parcel = {
    model: "mailroom.Item",
    dependencies: [service, test_contact, test_site],
    value: async (c, s) => ({
      location: s.test_site,
      service: s.service,
      recipient: s.test_contact,
      source: "physical-parcel",
      kind: "parcel",
      storage: "Shelf A",
      state: "collection_ready",
    }),
  };
  const delegate_contact = {
    model: Contact,
    dependencies: [test_company, nominee],
    value: async (c, s) => ({
      parent: s.test_company,
      name: "Collection delegate",
      email: "delegate@example.test",
      account: s.nominee,
      verified: true,
    }),
  };
  const delegate = {
    model: "mailroom.Delegate",
    dependencies: [service, delegate_contact, nominee],
    value: async (c, s) => ({ parent: s.service, contact: s.delegate_contact, account: s.nominee }),
  };
  const prepared = {
    model: "mailroom.Dispatch",
    dependencies: [parcel, test_company, test_site],
    value: async (c, s) => ({
      parent: s.parcel,
      source: "mail-forward-parcel",
      instruction: "Collection by verified recipient",
      instruction_revision: 1n,
      destination: "Original address",
      fee: money(5n, "EUR"),
      charge: {
        source: "mail-forward-parcel",
        customer: s.test_company.id,
        location: s.test_site.id,
        description: "Forwarding fee",
        amount: money(5n, "EUR"),
        due: date("2090-01-01"),
      },
      state: "pending",
    }),
  };
  const attempt={dependencies:[],delivery:"mailroom.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Notice",body:"Recorded decision"}})};
  const pending_notice={dependencies:[],delivery:"mailroom.Mail.send",values:async(c,s)=>({request:{to:"recipient@example.test",subject:"Notice",body:"Recorded decision"}})};
  return {
    attempt, pending_notice,
    nominee,
    unrelated,
    mail_operator,
    mail_employee,
    service,
    parcel,
    prepared,
    delegate_contact,
    delegate,
    examples: [
      {
        operation: "mailroom.Delegate.create",
        seed: [test_admin],
        dependencies: [service, delegate_contact, nominee],
        inputs: async (c, s) => ({ parent: s.service, contact: s.delegate_contact, account: s.nominee }),
        selectors: ["as", "delegate_contact.verified", "test_admin.active", "test_company.active"],
        observations: [async (c, s) => await count(records(c, "mailroom.Delegate", { parent: s.service }))],
        rows: [
          { dependencies: [], values: async (c, s) => ["members", true, true, true], expected: async (c, s) => [1n] },
          { dependencies: [], values: async (c, s) => ["members", false, true, true], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["members", true, false, true], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["members", true, true, false], error: "rule_failed" },
          { dependencies: [unrelated], values: async (c, s) => [s.unrelated, true, true, true], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["public", true, true, true], error: "forbidden" },
        ],
      },
      {
        operation: "mailroom.Delegate.update",
        seed: [test_admin],
        dependencies: [delegate],
        inputs: async (c, s) => ({ record: s.delegate }),
        selectors: ["as", "changes.active", "delegate_contact.verified"],
        observations: [async (c, s) => s.delegate.active, async (c, s) => await count(records(c, "mailroom.Delegate", { parent: s.service }))],
        rows: [
          { dependencies: [], values: async (c, s) => ["members", false, false], expected: async (c, s) => [false, 1n] },
          { dependencies: [], values: async (c, s) => ["members", true, false], error: "rule_failed" },
          { dependencies: [unrelated], values: async (c, s) => [s.unrelated, false, true], error: "rule_failed" },
        ],
      },
      {
        operation: "mailroom.instructions",
        seed: [test_admin, allocated],
        dependencies: [service],
        inputs: async (c, s) => ({ service: s.service, instructions: "Collect at reception", forwarding: "New address", revision: 1n }),
        selectors: ["as", "revision"],
        observations: [async (c, s) => s.service.forwarding, async (c, s) => s.service.revision],
        rows: [
          { dependencies: [], values: async (c, s) => ["members", 1n], expected: async (c, s) => ["New address", 2n] },
          { dependencies: [], values: async (c, s) => ["members", 0n], error: "rule_failed" },
          { dependencies: [unrelated], values: async (c, s) => [s.unrelated, 1n], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["public", 1n], error: "forbidden" },
        ],
      },
      {
        operation: "mailroom.receive",
        seed: [test_worker, test_admin, allocated],
        dependencies: [test_site, service],
        inputs: async (c, s) => ({
          location: s.test_site,
          source: "new-receipt",
          kind: "parcel",
          storage: "Shelf A",
          service: s.service,
          photo: null,
        }),
        selectors: ["as", "paid_term.mail", "paid_term.paid", "service.paid_evidence"],
        observations: [
          async (c, s) =>
            await count(
              records(c, "mailroom.Item", { where: (item) => item.source === "new-receipt" }),
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", true, true, null],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", false, true, null],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "mailroom.mail_staff",
              true,
              false,
              "Manual evidence cannot override linked term",
            ],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "mailroom.receive",
        dependencies: [test_admin, test_contact, mail_employee, test_directory_employee, delegate_contact],
        sequence: [
          {
            operation: "mailroom.configure", by: async (c, s, b) => s.mail_operator,
            inputs: async (c, s, b) => ({ customer: s.test_company, location: s.test_site, recipient: s.test_contact, from: datetime("2020-01-01T00:00:00Z"), until: datetime("2099-01-01T00:00:00Z"), source: "mail-journey-service", term: null, paid_evidence: "Reviewed standalone mail purchase", currency: "EUR", instructions: "Collect at reception", forwarding: null }),
          },
          { let: "route", value: async (c, s, b) => await first(records(c, "mailroom.Service", { where: (row) => row.source === "mail-journey-service", order: ["id"] })) },
          { observations: async (c, s, b) => [b.route !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          {
            operation: "mailroom.receive", by: async (c, s, b) => s.mail_operator,
            inputs: async (c, s, b) => ({ location: s.test_site, source: "mail-journey-receipt", kind: "parcel", storage: "Shelf B", service: b.route, photo: null }),
          },
          { let: "arrived", value: async (c, s, b) => await first(records(c, "mailroom.Item", { where: (row) => row.source === "mail-journey-receipt", order: ["id"] })) },
          { observations: async (c, s, b) => [b.arrived !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          {
            observations: async (c, s, b) => [b.arrived.state, ((await delivery(c,{record:b.arrived,field:"notification"},["status"]))?.status ?? null), await count(records(c, "mailroom.Handling", { parent: b.arrived })), b.arrived.retention_until],
            expected: async (c, s, b) => ["received", "pending", 0n, null], types: ["mailroom.Item.state", "std.DeliveryResult.status?", "int", "datetime?"],
          },
          {
            operation: "mailroom.Delegate.create", by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ parent: b.route, contact: s.delegate_contact, account: s.nominee }),
          },
          { let: "nomination", value: async (c, s, b) => await first(records(c, "mailroom.Delegate", { parent: b.route, where: (row) => same(row.contact, s.delegate_contact) && same(row.account, s.nominee), order: ["id"] })) },
          { observations: async (c, s, b) => [b.nomination !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.nomination.active, await delegate_eligible(c, b.nomination)], expected: async (c, s, b) => [true, true], types: ["bool", "bool"] },
          {
            operation: "customer.Contact.update", by: async (c, s, b) => s.test_directory_manager,
            inputs: async (c, s, b) => ({ record: s.delegate_contact, changes: { email: "replacement@example.test" } }),
          },
          { observations: async (c, s, b) => [s.delegate_contact.verified, s.delegate_contact.account], expected: async (c, s, b) => [false, null], types: ["bool", "user?"] },
          {
            operation: "mailroom.collect", by: async (c, s, b) => s.mail_operator,
            inputs: async (c, s, b) => ({ item: b.arrived, collector: s.nominee, evidence: "Former nominee identity" }), error: "rule_failed",
          },
          { let: "held", value: async (c, s, b) => await first(records(c, "mailroom.Item", { where: (row) => row.source === "mail-journey-receipt", order: ["id"] })) },
          { observations: async (c, s, b) => [b.held !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.held.state, await count(records(c, "mailroom.Handling", { parent: b.held })), b.held.retention_until], expected: async (c, s, b) => ["received", 0n, null], types: ["mailroom.Item.state", "int", "datetime?"] },
          { let: "current_nomination", value: async (c, s, b) => await first(records(c, "mailroom.Delegate", { parent: b.route, where: (row) => same(row.contact, s.delegate_contact) && same(row.account, s.nominee), order: ["id"] })) },
          { observations: async (c, s, b) => [b.current_nomination !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          {
            operation: "mailroom.Delegate.update", by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ record: b.current_nomination, changes: { active: false } }),
          },
          { operation: "customer.Contact.delete", by: async (c, s, b) => s.test_directory_manager, inputs: async (c, s, b) => ({ record: s.delegate_contact }) },
          { let: "history", value: async (c, s, b) => await first(records(c, "mailroom.Delegate", { parent: b.route, where: (row) => same(row.account, s.nominee), order: ["id"] })) },
          { observations: async (c, s, b) => [b.history !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.history.active, b.history.contact, b.history.account, b.history.contact.archived_at !== null, await delegate_eligible(c, b.history)], expected: async (c, s, b) => [false, s.delegate_contact, s.nominee, true, false], types: ["bool", "customer.Contact", "user", "bool", "bool"] },
          {
            operation: "mailroom.service_status", by: async (c, s, b) => s.mail_operator,
            inputs: async (c, s, b) => ({ service: b.route, active: false, until: datetime("2021-01-01T00:00:00Z"), paid_evidence: "Reviewed standalone mail purchase" }),
          },
          { let: "expired_route", value: async (c, s, b) => await first(records(c, "mailroom.Service", { where: (row) => row.source === "mail-journey-service", order: ["id"] })) },
          { observations: async (c, s, b) => [b.expired_route !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.expired_route.active, await live(c, b.expired_route), await recipient(c, s.self, b.expired_route)], expected: async (c, s, b) => [false, false, true], types: ["bool", "bool", "bool"] },
          { let: "retained", value: async (c, s, b) => await first(records(c, "mailroom.Item", { where: (row) => row.source === "mail-journey-receipt", order: ["id"] })) },
          { observations: async (c, s, b) => [b.retained !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          {
            operation: "mailroom.collect", by: async (c, s, b) => s.mail_operator,
            inputs: async (c, s, b) => ({ item: b.retained, collector: s.self, evidence: "Verified original recipient collected held property" }),
          },
          { let: "collected_item", value: async (c, s, b) => await first(records(c, "mailroom.Item", { where: (row) => row.source === "mail-journey-receipt", order: ["id"] })) },
          { observations: async (c, s, b) => [b.collected_item !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          {
            observations: async (c, s, b) => [b.collected_item.state, await count(records(c, "mailroom.Handling", { parent: b.collected_item })), await any(records(c, "mailroom.Handling", { parent: b.collected_item }), (handling) => handling.kind === "collection" && same(handling.account, s.self) && same(handling.author, s.mail_operator)), b.collected_item.retention_until],
            expected: async (c, s, b) => ["collected", 1n, true, addDuration(c.now, int64(b.collected_item.history_days * 86400000n))], types: ["mailroom.Item.state", "int", "bool", "datetime?"],
          },
          {
            operation: "mailroom.collect", by: async (c, s, b) => s.mail_operator,
            inputs: async (c, s, b) => ({ item: b.collected_item, collector: s.self, evidence: "Repeated collection" }), error: "rule_failed",
          },
          { let: "final_item", value: async (c, s, b) => await first(records(c, "mailroom.Item", { where: (row) => row.source === "mail-journey-receipt", order: ["id"] })) },
          { observations: async (c, s, b) => [b.final_item !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.final_item.state, await count(records(c, "mailroom.Handling", { parent: b.final_item })), await count(records(c, "mailroom.Delegate", { parent: b.expired_route })), await recipient(c, s.self, b.expired_route), await recipient(c, s.nominee, b.expired_route)], expected: async (c, s, b) => ["collected", 1n, 1n, true, false], types: ["mailroom.Item.state", "int", "int", "bool", "bool"] },
        ],
      },
      {
        operation: "mailroom.collect",
        seed: [test_worker, delegate],
        dependencies: [parcel],
        inputs: async (c, s) => ({ item: s.parcel, evidence: "Identity verified" }),
        selectors: ["as", "collector", "item.state", "service.until", "delegate.active", "delegate_contact.verified"],
        observations: [async (c, s) => s.item.state, async (c, s) => await count(records(c, "mailroom.Handling", { parent: s.parcel }))],
        rows: [
          { dependencies: [], values: async (c, s) => ["mailroom.mail_staff", s.self, "collection_ready", datetime("2021-01-01T00:00:00Z"), true, true], expected: async (c, s) => ["collected", 1n] },
          { dependencies: [], values: async (c, s) => ["mailroom.mail_staff", s.nominee, "collection_ready", datetime("2099-01-01T00:00:00Z"), true, true], expected: async (c, s) => ["collected", 1n] },
          { dependencies: [], values: async (c, s) => ["mailroom.mail_staff", s.nominee, "collection_ready", datetime("2099-01-01T00:00:00Z"), false, true], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["mailroom.mail_staff", s.nominee, "collection_ready", datetime("2099-01-01T00:00:00Z"), true, false], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["mailroom.mail_staff", s.self, "collected", datetime("2099-01-01T00:00:00Z"), true, true], error: "rule_failed" },
          { dependencies: [unrelated], values: async (c, s) => [s.unrelated, s.self, "collection_ready", datetime("2099-01-01T00:00:00Z"), true, true], error: "forbidden" },
        ],
      },
      {
        operation: "mailroom.collect",
        seed: [test_worker, delegate],
        dependencies: [parcel, nominee],
        inputs: async (c, s) => ({ item: s.parcel, collector: s.nominee, evidence: "Identity verified" }),
        selectors: ["as", "delegate_contact.account", "test_company.active"],
        observations: [async (c, s) => s.item.state],
        rows: [
          { dependencies: [], values: async (c, s) => ["mailroom.mail_staff", null, true], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["mailroom.mail_staff", s.nominee, false], error: "rule_failed" },
        ],
      },
      {
        operation: "mailroom.forward",
        seed: [test_worker, test_admin, allocated],
        dependencies: [parcel],
        inputs: async (c, s) => ({
          item: s.parcel,
          fee: money(5n, "EUR"),
          destination_verified: true,
        }),
        selectors: [
          "as",
          "paid_term.mail",
          "paid_term.paid",
          "service.forwarding",
          "destination_verified",
        ],
        observations: [
          async (c, s) => s.item.state,
          async (c, s) => await count(records(c, "mailroom.Dispatch", { parent: s.item })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", true, true, "Original address", true],
            expected: async (c, s) => ["forward_pending", 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", true, true, "Original address", false],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", false, true, "Original address", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", true, false, "Original address", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", true, true, null, true],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "mailroom.dispatched",
        seed: [test_worker],
        dependencies: [prepared],
        inputs: async (c, s) => ({
          dispatch: s.prepared,
          revision: 1n,
          carrier: "Manual carrier",
          evidence: "Tracking reference",
        }),
        selectors: [
          "as",
          "parcel.state",
          "parcel.dispatch",
          "service.forwarding",
          "dispatch.charge_state",
          "revision",
        ],
        observations: [
          async (c, s) => s.parcel.state,
          async (c, s) =>
            await max(
              (await records(c, "mailroom.Handling", { parent: s.parcel })).map(
                (row) => row.destination,
              ),
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "mailroom.mail_staff",
              "forward_pending",
              s.prepared,
              "Changed address",
              "confirmed",
              1n,
            ],
            expected: async (c, s) => ["forwarded", "Original address"],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "mailroom.mail_staff",
              "forward_pending",
              s.prepared,
              "Original address",
              "pending",
              0n,
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "mailroom.mail_staff",
              "forwarded",
              s.prepared,
              "Original address",
              "confirmed",
              1n,
            ],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "mailroom.return_item",
        seed: [test_worker],
        dependencies: [parcel],
        inputs: async (c, s) => ({
          item: s.parcel,
          evidence: "Physical return recorded",
          no_dispatch: false,
        }),
        selectors: ["as", "item.state", "no_dispatch"],
        observations: [async (c, s) => s.item.state, async (c, s) => s.item.retention_until],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", "received", false],
            expected: async (c, s) => [
              "returned",
              addDuration(c.now, int64(s.item.history_days * 86400000n)),
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", "forward_pending", false],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["mailroom.mail_staff", "forward_pending", true],
            expected: async (c, s) => [
              "returned",
              addDuration(c.now, int64(s.item.history_days * 86400000n)),
            ],
          },
        ],
      },
      {
        operation: "mailroom.fee_result",
        dependencies: [],
        inputs: async (c, s) => ({
          event: {
            delivery_id: "forward-fee",
            status: "succeeded",
            result: {
              source: "mail-forward-parcel",
              revision: 1n,
              state: "confirmed",
              reference: "invoice-1",
              detail: null,
            },
            error: null,
          },
        }),
        selectors: ["prepared.charge_delivery", "parcel.state", "prepared.state"],
        observations: [async (c, s) => s.parcel.state, async (c, s) => s.prepared.charge_state],
        rows: [
          {
            dependencies: [prepared, parcel],
            values: async (c, s) => ["forward-fee", "forward_pending", "unknown"],
            expected: async (c, s) => ["forward_pending", "confirmed"],
          },
          {
            dependencies: [prepared, parcel],
            values: async (c, s) => ["older-fee", "forward_pending", "unknown"],
            expected: async (c, s) => ["forward_pending", "none"],
          },
        ],
      },
      {
        operation: "mailroom.remind",
        dependencies: [parcel],
        inputs: async (c, s) => ({ event: { item: s.parcel, number: 1n } }),
        selectors: ["parcel.state", "parcel.reminders"],
        observations: [
          async (c, s) => s.parcel.state,
          async (c, s) => s.parcel.reminders,
          async (c, s) => s.parcel.retention_until,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["collection_ready", 0n],
            expected: async (c, s) => ["collection_ready", 1n, null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["collected", 0n],
            expected: async (c, s) => ["collected", 0n, null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["collection_ready", 2n],
            expected: async (c, s) => ["collection_ready", 2n, null],
          },
        ],
      },

      {operation:"mailroom.notice_result",dependencies:[attempt],inputs:async(c,s)=>({event:{delivery_id:s.attempt.id,status:"succeeded",result:{reference:"accepted-mail"},error:null}}),selectors:["parcel.notification", "parcel.state", "event.delivery_id", "event.status", "event.result", "event.error", "attempt.status", "attempt.result", "attempt.error"],observations:[async(c,s)=>s.parcel.state,async(c,s)=>(await delivery(c,{record:s.parcel,field:"notification"},["status"]))?.status ?? null],rows:[
          {dependencies:[parcel,attempt],values:async(c,s)=>[s.attempt, "received", s.attempt.id, "succeeded", {"reference": "accepted-mail"}, null, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["notified", "succeeded"]},
          {dependencies:[parcel,attempt,pending_notice],values:async(c,s)=>[s.pending_notice, "received", s.attempt.id, "succeeded", {"reference": "accepted-mail"}, null, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["received", "pending"]},
          {dependencies:[parcel,attempt],values:async(c,s)=>[null, "received", s.attempt.id, "succeeded", {"reference": "accepted-mail"}, null, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["received", null]},
          {dependencies:[parcel,attempt],values:async(c,s)=>[s.attempt, "received", s.attempt.id, "unknown", null, null, "unknown", null, null],expected:async(c,s)=>["received", "unknown"]},
          {dependencies:[parcel,attempt],values:async(c,s)=>[s.attempt, "received", s.attempt.id, "failed", null, {"code": "provider", "message": "Delivery rejected"}, "failed", null, {code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["received", "failed"]},
          {dependencies:[parcel,attempt],values:async(c,s)=>[s.attempt, "received", s.attempt.id, "skipped", null, null, "skipped", null, null],expected:async(c,s)=>["received", "skipped"]},
          {dependencies:[parcel,attempt],values:async(c,s)=>[s.attempt, "collected", s.attempt.id, "succeeded", {"reference": "accepted-mail"}, null, "succeeded", {reference:"accepted-mail"}, null],expected:async(c,s)=>["collected", "succeeded"]}
        ]},
    ],
  };
}
