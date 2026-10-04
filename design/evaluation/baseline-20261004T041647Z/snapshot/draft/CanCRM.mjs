import {
  any,
  require as check,
  compareInstant,
  count,
  create,
  date,
  datetime,
  hasRole,
  lower,
  money,
  records,
  same,
  set,
  sum,
} from "@canlang/stdlib";
import {
  action,
  actions,
  board,
  card,
  details,
  edit,
  form,
  history,
  list,
  message,
  metrics,
  delete as remove,
  renderPage,
  table,
  tabs,
  text,
} from "@canlang/ui";
import { Appointment, Calendar, Type } from "./appointments.mjs";
import { Contact, Customer } from "./customer.mjs";
import { can_work } from "./employee.mjs";

import { Term } from "./member_terms.mjs";
import { Item, Proposal, Revision } from "./propose.mjs";
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

const live = ["lead", "qualified", "proposal"];

const closed = ["won", "lost"];

const stageLabel = message("Sales stage", { nl: "Verkoopfase" });

const outcomeLabel = message("Confirmed outcome reference", {
  nl: "Referentie bevestigde uitkomst",
});

export const appDefinition = {
  id: "CanCRM",
  uses: ["crm", "customer", "appointments", "propose"],
  description: message(
    "Help workspace sales teams turn inquiries into tours, quotes, and office or coworking sales.",
    {
      nl: "Help werkplekverkoopteams aanvragen omzetten in rondleidingen, offertes en kantoor- of coworkingverkopen.",
    },
  ),
  packages: {
    crm: {
      label: message("Sales", { nl: "Verkoop" }),
      description: message(
        "Manage scoped sales opportunities against the canonical customer directory.",
        { nl: "Beheer toegestane verkoopkansen met de canonieke klantendirectory." },
      ),

      roles: {
        salesperson: { id: "crm.salesperson", label: message("Salesperson", { nl: "Verkoper" }) },
      },
      messages: { label_Deal_stage: stageLabel, label_Deal_outcome_reference: outcomeLabel },
    },
  },
  models: {
    "crm.Deal": {
      readGrants: [{ rule: "Deal.read.1" }],
      invariants: ["Deal.require.1"],
      label: message("Sales opportunity", { nl: "Verkoopkans" }),
      fields: {
        customer: { type: Customer },
        contact: { type: Contact },
        title: { type: "text", trim: true, min: 1n },
        location: { type: Location },
        owner: {
          type: "user",
          server: "actor",
          label: message("Responsible person", { nl: "Verantwoordelijke" }),
        },
        value: { type: "money", label: message("Value", { nl: "Waarde" }) },
        stage: {
          type: "enum",
          cases: ["lead", "qualified", "proposal", "won", "lost"],
          default: "lead",
          label: {
            text: stageLabel,
            values: {
              lead: message("Lead", { nl: "Lead" }),
              qualified: message("Qualified", { nl: "Gekwalificeerd" }),
              proposal: message("Proposal", { nl: "Offertefase" }),
              won: message("Won", { nl: "Gewonnen" }),
              lost: message("Lost", { nl: "Verloren" }),
            },
          },
        },
        seats: { type: "int", default: 1n, min: 1n, label: message("Seats", { nl: "Plaatsen" }) },
        desired_start: {
          type: "date",
          nullable: true,
          default: null,
          label: message("Desired start date", { nl: "Gewenste startdatum" }),
        },
        duration: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Desired duration", { nl: "Gewenste duur" }),
        },
        workspace: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Workspace needs", { nl: "Werkplekbehoefte" }),
        },
        source: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Source reference", { nl: "Bronreferentie" }),
        },
        next_action: {
          type: "datetime",
          nullable: true,
          default: null,
          label: message("Next action time", { nl: "Tijd volgende actie" }),
        },
        notes: { type: "text", nullable: true, default: null },
        lost_reason: {
          type: "text",
          nullable: true,
          default: null,
          label: message("Loss reason", { nl: "Reden verloren kans" }),
        },
        outcome_reference: { type: "text", nullable: true, default: null, label: outcomeLabel },
      },
    },
    "crm.Activity": {
      parent: "crm.Deal",
      invariants: ["Activity.require.1"],
      readGrants: [{ rule: "Activity.read.1" }],
      label: message("Sales activity", { nl: "Verkoopactiviteit" }),
      locks: ["Activity.lock.1"],
      fields: {
        kind: {
          type: "enum",
          cases: ["call", "email", "note", "tour", "quote", "sale"],
          label: {
            text: message("Kind", { nl: "Soort" }),
            values: {
              call: message("Call", { nl: "Telefoongesprek" }),
              email: message("Email", { nl: "E-mail" }),
              note: message("Note", { nl: "Notitie" }),
              tour: message("Tour", { nl: "Rondleiding" }),
              quote: message("Quote", { nl: "Offerte" }),
              sale: message("Confirmed sale", { nl: "Bevestigde verkoop" }),
            },
          },
        },
        body: { type: "text", trim: true, min: 1n },
        link: {
          type: "url",
          nullable: true,
          default: null,
          label: message("Reviewed source link", { nl: "Beoordeelde bronlink" }),
        },
        appointment: {
          type: Appointment,
          nullable: true,
          default: null,
          label: message("Tour appointment", { nl: "Rondleidingafspraak" }),
        },
        revision: {
          type: Revision,
          nullable: true,
          default: null,
          label: message("Quote revision", { nl: "Offerteversie" }),
        },
        author: { type: "user", server: "actor", label: message("Author", { nl: "Auteur" }) },
        occurred: { type: "datetime", server: "now" },
      },
    },
    "crm.Sale": {
      readGrants: [{ rule: "Sale.read.1" }],
      invariants: ["Sale.require.1"],
      label: message("Confirmed sale evidence", { nl: "Bewijs bevestigde verkoop" }),
      locks: ["Sale.lock.1"],
      fields: {
        deal: { type: "crm.Deal" },
        booking: { type: Booking, nullable: true, default: null, unique: true },
        term: { type: Term, nullable: true, default: null, unique: true },
        recorded_by: {
          type: "user",
          server: "actor",
          label: message("Recorded by", { nl: "Vastgelegd door" }),
        },
        recorded_at: {
          type: "datetime",
          server: "now",
          label: message("Recorded at", { nl: "Vastgelegd op" }),
        },
      },
    },
  },
  contracts: {
    "crm.Pipeline": {
      label: message("Pipeline summary", { nl: "Samenvatting verkoopkansen" }),
      fields: { count: { type: "int" }, total: { type: "money" } },
    },
  },
  preferences: {
    crm: {
      validate: "preferencesValid",
      fields: {
        location: { type: Location, nullable: true, default: null },
        stage: { type: "crm.Deal.stage", nullable: true, default: null },
        followup: {
          type: "enum",
          cases: ["overdue", "upcoming"],
          default: "overdue",
          label: {
            text: message("Next-action view", { nl: "Weergave vervolgacties" }),
            values: {
              overdue: message("Overdue next actions", { nl: "Achterstallige vervolgacties" }),
              upcoming: message("Upcoming next actions", { nl: "Komende vervolgacties" }),
            },
          },
        },
      },
    },
  },
  operations: {
    "crm.Deal.create": {
      handler: "createDeal",
      kind: "create",
      model: "crm.Deal",
      by: "crm.salesperson",
      read: false,
      inputs: {
        fields: [
          "customer",
          "contact",
          "title",
          "location",
          "value",
          "seats",
          "desired_start",
          "duration",
          "workspace",
          "source",
          "next_action",
          "notes",
        ],
      },
      when: "Deal",
    },
    "crm.Deal.update": {
      handler: "updateDeal",
      kind: "update",
      model: "crm.Deal",
      by: "crm.salesperson",
      read: false,
      inputs: {
        record: { type: "crm.Deal" },
        changes: {
          fields: [
            "title",
            "owner",
            "value",
            "seats",
            "desired_start",
            "duration",
            "workspace",
            "source",
            "next_action",
            "notes",
          ],
        },
      },
      when: "Deal",
    },
    "crm.Activity.create": {
      handler: "createActivity",
      kind: "create",
      model: "crm.Activity",
      by: "crm.salesperson",
      read: false,
      inputs: { parent: { type: "crm.Deal" }, fields: ["kind", "body"] },
      when: "Activity",
    },
    "crm.advance": {
      handler: "advance",
      by: "crm.salesperson",
      read: false,
      label: message("Advance stage", { nl: "Fase vooruitzetten" }),
      description: message("Advance a live deal without claiming inventory or payment.", {
        nl: "Zet een actieve verkoopkans vooruit zonder voorraad of betaling te claimen.",
      }),
      inputs: { deal: { type: "crm.Deal" }, stage: { type: "crm.Deal.stage", label: stageLabel } },
    },
    "crm.record_link": {
      handler: "record_link",
      by: "crm.salesperson",
      read: false,
      label: message("Record reviewed link", { nl: "Beoordeelde link vastleggen" }),
      description: message(
        "Retain a reviewed tour or quote link without scheduling or issuing it.",
        {
          nl: "Bewaar een beoordeelde rondleiding- of offertelink zonder deze te plannen of uit te geven.",
        },
      ),
      inputs: {
        deal: { type: "crm.Deal" },
        kind: { type: "crm.Activity.kind" },
        link: {
          type: "url",
          label: message("Reviewed source link", { nl: "Beoordeelde bronlink" }),
        },
        body: { type: "text" },
      },
    },
    "crm.record_tour": {
      handler: "record_tour",
      by: "crm.salesperson",
      read: false,
      label: message("Record tour appointment", { nl: "Rondleidingafspraak vastleggen" }),
      description: message(
        "Link an actual appointment without treating pending coordination as confirmation.",
        {
          nl: "Koppel een echte afspraak zonder wachtende afstemming als bevestiging te behandelen.",
        },
      ),
      inputs: {
        deal: { type: "crm.Deal" },
        appointment: { type: Appointment },
        body: { type: "text" },
      },
    },
    "crm.record_quote": {
      handler: "record_quote",
      by: "crm.salesperson",
      read: false,
      label: message("Record issued quote", { nl: "Uitgegeven offerte vastleggen" }),
      description: message(
        "Record the exact issued revision; draft prices are not issued offer evidence.",
        {
          nl: "Leg de exact uitgegeven versie vast; conceptprijzen zijn geen bewijs van een uitgegeven offerte.",
        },
      ),
      inputs: { deal: { type: "crm.Deal" }, revision: { type: Revision }, body: { type: "text" } },
    },
    "crm.win": {
      handler: "win",
      by: "crm.salesperson",
      read: false,
      label: message("Record won opportunity", { nl: "Gewonnen kans vastleggen" }),
      description: message("Record a won outcome linked to actual source evidence.", {
        nl: "Leg een gewonnen uitkomst vast die naar werkelijk bronbewijs verwijst.",
      }),
      inputs: {
        deal: { type: "crm.Deal" },
        booking: { type: Booking, nullable: true, default: null },
        term: { type: Term, nullable: true, default: null },
      },
    },
    "crm.lose": {
      handler: "lose",
      by: "crm.salesperson",
      read: false,
      label: message("Record lost opportunity", { nl: "Verloren kans vastleggen" }),
      description: message("Record why a live opportunity was lost.", {
        nl: "Leg vast waarom een actieve verkoopkans verloren ging.",
      }),
      inputs: { deal: { type: "crm.Deal" }, reason: { type: "text" } },
    },
    "crm.reopen": {
      handler: "reopen",
      by: "crm.salesperson",
      read: false,
      description: message(
        "Reopen with an attributed activity preserving prior outcome evidence.",
        { nl: "Heropen met een toegeschreven activiteit die eerder uitkomstbewijs behoudt." },
      ),
      inputs: { deal: { type: "crm.Deal" }, reason: { type: "text" } },
    },
    "crm.pipeline": {
      handler: "pipeline",
      by: "crm.salesperson",
      read: true,
      result: "crm.Pipeline",
      label: message("Read pipeline", { nl: "Verkoopkansen lezen" }),
      description: message("Summarize only readable open opportunities in one selected currency.", {
        nl: "Vat uitsluitend leesbare open verkoopkansen samen in één gekozen valuta.",
      }),
      inputs: { currency: { type: "currency" } },
    },
  },
  pages: [{ path: "/sales", render: salesPage }],
  disabled: ["crm.Deal.delete", "crm.Activity.update", "crm.Activity.delete"],
};

export function canApp() {
  const crudWhen = {
    Deal: async (c, row) =>
      (await can_work(c, c.actor, row.location)) &&
      (await can_work(c, row.owner, row.location)) &&
      hasRole(c, "crm.salesperson", row.owner) &&
      row.customer.active &&
      ["lead", "qualified", "proposal"].includes(row.stage),
    Activity: async (c, row) =>
      (await can_work(c, c.actor, row.parent.location)) &&
      ["call", "email", "note"].includes(row.kind),
  };
  return {
    crudWhen,
    read: {
      "Deal.read.1": async (c, deal) =>
        hasRole(c, "crm.salesperson") && (await can_work(c, c.actor, deal.location)),
      "Activity.read.1": async (c, row) =>
        hasRole(c, "crm.salesperson") && (await can_work(c, c.actor, row.parent.location)),
      "Sale.read.1": async (c, row) =>
        hasRole(c, "crm.salesperson") && (await can_work(c, c.actor, row.deal.location)),
    },
    invariants: {
      "Deal.require.1": (c, row) =>
        same(row.contact.parent, row.customer) &&
        row.value.minor >= 0n &&
        row.value.currency === row.location.currency,
      "Activity.require.1": (c, row) =>
        (row.appointment === null ||
          (row.kind === "tour" &&
            row.revision === null &&
            same(row.appointment.customer, row.parent.customer) &&
            same(row.appointment.contact, row.parent.contact) &&
            same(row.appointment.parent.parent.location, row.parent.location))) &&
        (row.revision === null ||
          (row.kind === "quote" &&
            row.appointment === null &&
            same(row.revision.parent.parent, row.parent.customer) &&
            same(row.revision.parent.recipient, row.parent.contact) &&
            same(row.revision.parent.location, row.parent.location))),
      "Sale.require.1": (c, row) =>
        (row.booking !== null && row.term === null) || (row.booking === null && row.term !== null),
    },
    locks: {
      "Activity.lock.1": {
        fields: ["kind", "body", "link", "appointment", "revision", "author", "occurred"],
      },
      "Sale.lock.1": { fields: ["deal", "booking", "term", "recorded_by", "recorded_at"] },
    },
    preferencesValid: async (c, row) =>
      row.location === null || (await can_work(c, c.actor, row.location)),
    async createDeal(c, input) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      await create(c, "crm.Deal", input, { when: crudWhen.Deal });
    },
    async updateDeal(c, { record, changes }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Deal });
    },
    async createActivity(c, input) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      await create(c, "crm.Activity", input, { when: crudWhen.Activity });
    },
    async advance(c, { deal, stage }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      check((await can_work(c, c.actor, deal.location)) && live.includes(deal.stage));
      check(
        (deal.stage === "lead" && stage === "qualified") ||
          (deal.stage === "qualified" && stage === "proposal"),
      );
      await set(c, deal, { stage });
    },
    async record_link(c, { deal, kind, link, body }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      check(await can_work(c, c.actor, deal.location));
      check(["tour", "quote"].includes(kind) && body.trim() !== "");
      check(
        !(await any(
          records(c, "crm.Activity", { parent: deal }),
          (activity) => activity.kind === kind && activity.link === link,
        )),
      );
      await create(c, "crm.Activity", {
        parent: deal,
        kind,
        body,
        link,
        author: c.actor,
        occurred: c.now,
      });
    },
    async record_tour(c, { deal, appointment, body }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      check(await can_work(c, c.actor, deal.location));
      check(
        same(appointment.customer, deal.customer) &&
          same(appointment.contact, deal.contact) &&
          same(appointment.parent.parent.location, deal.location) &&
          body.trim() !== "",
      );
      check(
        !(await any(records(c, "crm.Activity", { parent: deal }), (activity) =>
          same(activity.appointment, appointment),
        )),
      );
      await create(c, "crm.Activity", {
        parent: deal,
        kind: "tour",
        body,
        appointment,
        revision: null,
        link: null,
        author: c.actor,
        occurred: c.now,
      });
    },
    async record_quote(c, { deal, revision, body }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      check(await can_work(c, c.actor, deal.location));
      check(
        same(revision.parent.parent, deal.customer) &&
          same(revision.parent.recipient, deal.contact) &&
          same(revision.parent.location, deal.location) &&
          ["sent", "accepted", "declined"].includes(revision.state) &&
          body.trim() !== "",
      );
      check(
        !(await any(records(c, "crm.Activity", { parent: deal }), (activity) =>
          same(activity.revision, revision),
        )),
      );
      await create(c, "crm.Activity", {
        parent: deal,
        kind: "quote",
        body,
        revision,
        appointment: null,
        link: null,
        author: c.actor,
        occurred: c.now,
      });
    },
    async win(c, { deal, booking = null, term = null }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      check((await can_work(c, c.actor, deal.location)) && live.includes(deal.stage));
      check((booking !== null && term === null) || (booking === null && term !== null));
      if (booking !== null) {
        check(
          same(booking.customer, deal.customer) &&
            same(booking.parent.location, deal.location) &&
            ["confirmed", "occupied", "completed"].includes(booking.status),
        );
        check(!(await any(records(c, "crm.Sale"), (sale) => same(sale.booking, booking))));
        await create(c, "crm.Sale", {
          deal,
          booking,
          term: null,
          recorded_by: c.actor,
          recorded_at: c.now,
        });
        await create(c, "crm.Activity", {
          parent: deal,
          kind: "sale",
          body: booking.id,
          link: null,
          author: c.actor,
          occurred: c.now,
        });
        await set(c, deal, { stage: "won", outcome_reference: booking.id, next_action: null });
      } else {
        check(
          term !== null &&
            same(term.parent.parent, deal.customer) &&
            (await any(term.locations, (location) => same(location, deal.location))) &&
            term.paid,
        );
        check(!(await any(records(c, "crm.Sale"), (sale) => same(sale.term, term))));
        await create(c, "crm.Sale", {
          deal,
          booking: null,
          term,
          recorded_by: c.actor,
          recorded_at: c.now,
        });
        await create(c, "crm.Activity", {
          parent: deal,
          kind: "sale",
          body: term.id,
          link: null,
          author: c.actor,
          occurred: c.now,
        });
        await set(c, deal, { stage: "won", outcome_reference: term.id, next_action: null });
      }
    },
    async lose(c, { deal, reason }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      check((await can_work(c, c.actor, deal.location)) && live.includes(deal.stage));
      check(reason.trim() !== "");
      await set(c, deal, { stage: "lost", lost_reason: reason, next_action: null });
    },
    async reopen(c, { deal, reason }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      check(await can_work(c, c.actor, deal.location));
      check(closed.includes(deal.stage) && reason.trim() !== "");
      await create(c, "crm.Activity", {
        parent: deal,
        kind: "note",
        body: reason,
        link: null,
        author: c.actor,
        occurred: c.now,
      });
      await set(c, deal, { stage: "lead" });
    },
    async pipeline(c, { currency }) {
      check(hasRole(c, "crm.salesperson"), "forbidden");
      return {
        count: await count(
          records(c, "crm.Deal", {
            where: (deal) =>
              ["lead", "qualified", "proposal"].includes(deal.stage) &&
              deal.value.currency === currency,
          }),
        ),
        total: await sum(
          records(c, "crm.Deal", {
            where: (deal) =>
              ["lead", "qualified", "proposal"].includes(deal.stage) &&
              deal.value.currency === currency,
          }),
          (deal) => deal.value,
          currency,
        ),
      };
    },
  };
}

export async function salesPage(c) {
  check(hasRole(c, "crm.salesperson"), "forbidden");
  const preferences = c.preferences.crm;
  const activityRows = (deal, context) =>
    list({
      context,
      model: "crm.Activity",
      parent: deal,
      order: ["-occurred"],
      renderRow: (row, view) => [
        text({
          context: view,
          values: [
            row.kind,
            row.body,
            row.link,
            row.appointment,
            row.revision,
            row.author,
            row.occurred,
          ],
        }),
      ],
    });
  return renderPage(
    c,
    {
      owner: "crm",
      path: "/sales",
      title: message("Sales pipeline", { nl: "Verkoopkansen" }),
      description: message("Review prospects, location needs and dated follow-up.", {
        nl: "Bekijk prospects, locatiebehoeften en gedateerde vervolgacties.",
      }),
    },
    () => [
      card({
        context: c,
        title: message("Customer opportunity intake", { nl: "Klantverkoopkans aanmaken" }),
        children: [
          form({
            context: c,
            operation: "customer.Customer.create",
            import: "csv",
            review: "customer.duplicate_customers",
          }),
          list({
            context: c,
            model: "customer.Customer",
            where: (customer) => customer.active,
            columns: ["name", "kind"],
            search: ["name"],
            renderRow: (customer, view) => [
              edit({ context: view, operation: "customer.Customer.update", record: customer }),
              remove({ context: view, operation: "customer.Customer.delete", record: customer }),
              form({
                context: view,
                operation: "customer.Contact.create",
                arguments: { parent: customer },
                import: "csv",
                review: "customer.duplicate_contacts",
              }),
              details({
                context: view,
                caption: message("Likely company duplicates", {
                  nl: "Mogelijke dubbele bedrijven",
                }),
                children: [
                  list({
                    context: view,
                    model: "customer.Customer",
                    archived: "include",
                    where: (candidate) =>
                      candidate.kind === customer.kind &&
                      lower(candidate.name) === lower(customer.name) &&
                      !same(candidate, customer),
                    columns: ["name", "kind"],
                    renderRow: (candidate, duplicateView) => [
                      form({
                        context: duplicateView,
                        operation: "customer.alias",
                        arguments: { source: candidate, target: customer },
                      }),
                    ],
                  }),
                ],
              }),
              form({ context: view, operation: "customer.invite", arguments: { org: customer } }),
              form({ context: view, operation: "customer.recover", arguments: { org: customer } }),
              list({
                context: view,
                model: "customer.CompanyRole",
                parent: customer,
                columns: ["account", "role", "locations", "active"],
                renderRow: (grant, grantView) => [
                  action({
                    context: grantView,
                    operation: "customer.remove",
                    boundArgs: { grant },
                  }),
                ],
              }),
              list({
                context: view,
                model: "customer.Invitation",
                parent: customer,
                columns: ["email", "role", "locations", "status", "expires"],
                renderRow: (invitation, invitationView) => [
                  action({
                    context: invitationView,
                    operation: "customer.accept",
                    boundArgs: { invitation },
                  }),
                ],
              }),
              list({
                context: view,
                model: "customer.Alias",
                where: (mapping) =>
                  same(mapping.from_customer, customer) || same(mapping.to_customer, customer),
                columns: ["from_customer", "to_customer", "reason", "approved_by"],
              }),
              list({
                context: view,
                model: "customer.Contact",
                parent: customer,
                columns: ["name", "email"],
                renderRow: (contact, contactView) => [
                  edit({
                    context: contactView,
                    operation: "customer.Contact.update",
                    record: contact,
                  }),
                  remove({
                    context: contactView,
                    operation: "customer.Contact.delete",
                    record: contact,
                  }),
                  form({
                    context: contactView,
                    operation: "crm.Deal.create",
                    arguments: { customer, contact },
                  }),
                  action({
                    context: contactView,
                    operation: "customer.claim",
                    boundArgs: { contact },
                  }),
                  details({
                    context: contactView,
                    caption: message("Likely contact duplicates", {
                      nl: "Mogelijke dubbele contactpersonen",
                    }),
                    children: [
                      list({
                        context: contactView,
                        model: "customer.Contact",
                        archived: "include",
                        where: (candidate) =>
                          candidate.email === contact.email && !same(candidate, contact),
                        columns: ["name", "email"],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      board({
        context: c,
        model: "crm.Deal",
        by: "stage",
        columns: ["title", "customer", "contact", "value", "seats", "next_action"],
        filter: ["location", "owner", "stage"],
        defaults: { location: preferences.location, stage: preferences.stage },
        search: ["title"],
        renderRow: (deal, view) => [
          text({
            context: view,
            values: [deal.value, deal.seats, deal.next_action, deal.outcome_reference],
          }),
          details({
            context: view,
            caption: message("Deal needs and actions", { nl: "Behoeften en acties verkoopkans" }),
            display: "drawer",
            children: [
              text({
                context: view,
                values: [
                  deal.desired_start,
                  deal.duration,
                  deal.workspace,
                  deal.notes,
                  deal.lost_reason,
                ],
              }),
              edit({ context: view, operation: "crm.Deal.update", record: deal }),
              actions({
                context: view,
                operations: ["crm.advance", "crm.win", "crm.lose", "crm.reopen", "crm.record_link"],
                boundArgs: { deal },
              }),
              form({
                context: view,
                operation: "crm.Activity.create",
                arguments: { parent: deal },
              }),
              details({
                context: view,
                caption: message("Schedule a tour", { nl: "Rondleiding plannen" }),
                children: [
                  list({
                    context: view,
                    model: Calendar,
                    where: (calendar) => calendar.active && same(calendar.location, deal.location),
                    columns: ["location", "timezone", "hours", "instructions", "cutoff"],
                    renderRow: (calendar, calendarView) => [
                      table({
                        context: calendarView,
                        model: "appointments.Window",
                        parent: calendar,
                        columns: ["from", "until", "available"],
                        order: ["from"],
                      }),
                      list({
                        context: calendarView,
                        model: Type,
                        parent: calendar,
                        columns: ["name", "duration", "room"],
                        renderRow: (type, typeView) => [
                          form({
                            context: typeView,
                            operation: "appointments.book",
                            arguments: { type, customer: deal.customer, contact: deal.contact },
                          }),
                        ],
                      }),
                    ],
                  }),
                  list({
                    context: view,
                    model: Appointment,
                    where: (appointment) =>
                      same(appointment.customer, deal.customer) &&
                      same(appointment.contact, deal.contact) &&
                      same(appointment.parent.parent.location, deal.location),
                    columns: ["from", "until", "state", "reason", "host_ok", "room_ok"],
                    order: ["from"],
                    renderRow: (appointment, appointmentView) => [
                      actions({
                        context: appointmentView,
                        operations: ["appointments.cancel", "appointments.attendance"],
                        boundArgs: { appointment },
                      }),
                      form({
                        context: appointmentView,
                        operation: "crm.record_tour",
                        arguments: { deal, appointment },
                      }),
                    ],
                  }),
                ],
              }),
              details({
                context: view,
                caption: message("Prepare and issue a quote", {
                  nl: "Offerte voorbereiden en uitgeven",
                }),
                children: [
                  form({
                    context: view,
                    operation: "propose.Proposal.create",
                    arguments: {
                      parent: deal.customer,
                      recipient: deal.contact,
                      location: deal.location,
                      currency: deal.value.currency,
                    },
                  }),
                  list({
                    context: view,
                    model: Proposal,
                    where: (proposal) =>
                      same(proposal.parent, deal.customer) &&
                      same(proposal.recipient, deal.contact) &&
                      same(proposal.location, deal.location),
                    columns: ["title", "current", "currency"],
                    renderRow: (proposal, proposalView) => [
                      edit({
                        context: proposalView,
                        operation: "propose.Proposal.update",
                        record: proposal,
                      }),
                      form({
                        context: proposalView,
                        operation: "propose.revise",
                        arguments: { proposal, seats: deal.seats },
                      }),
                      list({
                        context: proposalView,
                        model: Revision,
                        parent: proposal,
                        order: ["-number"],
                        columns: ["number", "state", "total", "expires", "handoff", "booking"],
                        renderRow: (revision, revisionView) => [
                          text({
                            context: revisionView,
                            values: [
                              revision.from,
                              revision.until,
                              revision.seats,
                              revision.terms,
                              revision.pdf,
                            ],
                          }),
                          form({
                            context: revisionView,
                            operation: "propose.Item.create",
                            arguments: { parent: revision },
                          }),
                          list({
                            context: revisionView,
                            model: Item,
                            parent: revision,
                            columns: ["title", "quantity", "unit", "price", "tax", "discount"],
                            renderRow: (item, itemView) => [
                              edit({
                                context: itemView,
                                operation: "propose.Item.update",
                                record: item,
                              }),
                              remove({
                                context: itemView,
                                operation: "propose.Item.delete",
                                record: item,
                              }),
                            ],
                          }),
                          actions({
                            context: revisionView,
                            operations: [
                              "propose.send_offer",
                              "propose.document",
                              "propose.request_booking",
                            ],
                            boundArgs: { revision },
                          }),
                          form({
                            context: revisionView,
                            operation: "crm.record_quote",
                            arguments: { deal, revision },
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              activityRows(deal, view),
              list({
                context: view,
                model: "crm.Sale",
                where: (sale) => same(sale.deal, deal),
                columns: ["booking", "term", "recorded_by", "recorded_at"],
              }),
              history({ context: view, record: deal }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Selected currency pipeline", { nl: "Verkoopkansen in gekozen valuta" }),
        children: [
          form({
            context: c,
            operation: "crm.pipeline",
            display: "inline",
            renderResult: (result, view) => [
              metrics({ context: view, values: [result.count, result.total] }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Customer timeline", { nl: "Klanttijdlijn" }),
        children: [
          list({
            context: c,
            model: "customer.Customer",
            archived: "include",
            columns: ["name", "kind", "active", "archived_at"],
            search: ["name"],
            renderRow: (customer, view) => [
              list({
                context: view,
                model: "crm.Deal",
                where: (deal) => same(deal.customer, customer),
                columns: ["title", "contact", "stage", "next_action"],
                order: ["-updated"],
                renderRow: (deal, dealView) => [
                  activityRows(deal, dealView),
                  history({ context: dealView, record: deal }),
                ],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Next actions", { nl: "Vervolgacties" }),
        children: [
          tabs({ context: c, selector: "crm.followup", value: preferences.followup }),
          table({
            context: c,
            model: "crm.Deal",
            where: (deal) =>
              live.includes(deal.stage) &&
              deal.next_action !== null &&
              ((preferences.followup === "overdue" &&
                compareInstant(deal.next_action, c.now) < 0) ||
                (preferences.followup === "upcoming" &&
                  compareInstant(deal.next_action, c.now) >= 0)),
            columns: ["title", "customer", "contact", "next_action", "owner"],
            order: ["next_action"],
            filter: ["location", "owner"],
            defaults: { location: preferences.location },
            search: ["title"],
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
  { provider: "appointments", member: "booked", alias: "booked" },
  { provider: "propose", member: "current_offer", alias: "current_offer" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_company, test_contact, booked, current_offer, test_worker, test_site } = imported;
  const colleague = {
    model: "employee.Employee",
    dependencies: [test_worker],
    value: async (c, s) => ({
      user: s.other,
      home: s.test_worker.home,
      locations: s.test_worker.locations,
      start: s.test_worker.start,
      role: s.test_worker.role,
    }),
  };
  const prospect = {
    model: "crm.Deal",
    dependencies: [test_company, test_contact, test_site],
    value: async (c, s) => ({
      customer: s.test_company,
      contact: s.test_contact,
      title: "Office",
      location: s.test_site,
      owner: s.self,
      value: money(500n, "EUR"),
    }),
  };
  const sale_plan = {
    model: "member_plans.Plan",
    dependencies: [test_site],
    value: async (c, s) => ({
      name: "Coworking",
      price: money(500n, "EUR"),
      locations: [s.test_site],
      products: ["coworking"],
      access_hours: "Business hours",
      seats: 6n,
    }),
  };
  const sale_membership = {
    model: "member_terms.Membership",
    dependencies: [sale_plan, test_company],
    value: async (c, s) => ({
      parent: s.test_company,
      account: s.self,
      plan: s.sale_plan,
      anchor: date("2026-10-01"),
      timezone: "UTC",
    }),
  };
  const paid_term = {
    model: "member_terms.Term",
    dependencies: [sale_membership, test_site],
    value: async (c, s) => ({
      parent: s.sale_membership,
      source: "crm-win-term",
      from: datetime("2026-10-01T00:00:00Z"),
      until: datetime("2026-11-01T00:00:00Z"),
      price: money(500n, "EUR"),
      locations: [s.test_site],
      products: ["coworking"],
      access_hours: "Business hours",
      mail: false,
      seats: 6n,
      paid: true,
      cycle: 1n,
    }),
  };
  const prior_sale = {
    model: "crm.Sale",
    dependencies: [paid_term, prospect],
    value: async (c, s) => ({ deal: s.prospect, term: s.paid_term }),
  };
  const linked_tour = {
    model: "crm.Activity",
    dependencies: [booked, prospect],
    value: async (c, s) => ({
      parent: s.prospect,
      kind: "tour",
      body: "Scheduled tour",
      appointment: s.booked,
    }),
  };
  const linked_quote = {
    model: "crm.Activity",
    dependencies: [current_offer, prospect],
    value: async (c, s) => ({
      parent: s.prospect,
      kind: "quote",
      body: "Issued quote",
      revision: s.current_offer,
    }),
  };
  const reviewed_link = {
    model: "crm.Activity",
    dependencies: [prospect],
    value: async (c, s) => ({
      parent: s.prospect,
      kind: "tour",
      body: "Reviewed tour",
      link: "https://example.test/tours/1",
    }),
  };
  return {
    colleague,
    linked_quote,
    linked_tour,
    paid_term,
    prior_sale,
    prospect,
    reviewed_link,
    sale_membership,
    sale_plan,
    examples: [
      {
        operation: "crm.Deal.update",
        seed: [colleague, test_worker],
        dependencies: [prospect],
        inputs: async (c, s) => ({ record: s.prospect }),
        selectors: ["as", "changes.owner"],
        observations: [async (c, s) => s.record.owner],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", s.self],
            expected: async (c, s) => [s.self],
          },
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", s.other],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "crm.record_link",
        seed: [test_worker],
        dependencies: [prospect],
        inputs: async (c, s) => ({
          deal: s.prospect,
          link: "https://example.test/tours/1",
          body: "Reviewed tour",
        }),
        selectors: ["as", "kind"],
        observations: [async (c, s) => await count(records(c, "crm.Activity", { parent: s.deal }))],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", "tour"],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", "note"],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["members", "tour"], error: "forbidden" },
        ],
      },
      {
        operation: "crm.record_link",
        seed: [reviewed_link, test_worker],
        dependencies: [prospect],
        inputs: async (c, s) => ({
          deal: s.prospect,
          kind: "tour",
          link: "https://example.test/tours/1",
          body: "Reviewed tour",
        }),
        selectors: ["as"],
        observations: [async (c, s) => await count(records(c, "crm.Activity", { parent: s.deal }))],
        rows: [
          { dependencies: [], values: async (c, s) => ["crm.salesperson"], error: "rule_failed" },
        ],
      },
      {
        operation: "crm.record_tour",
        seed: [test_worker],
        dependencies: [booked, prospect],
        inputs: async (c, s) => ({
          deal: s.prospect,
          appointment: s.booked,
          body: "Scheduled tour",
        }),
        selectors: ["as", "appointment.state"],
        observations: [async (c, s) => await count(records(c, "crm.Activity", { parent: s.deal }))],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", "pending"],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", "confirmed"],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "confirmed"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "crm.record_tour",
        seed: [linked_tour, test_worker],
        dependencies: [booked, prospect],
        inputs: async (c, s) => ({
          deal: s.prospect,
          appointment: s.booked,
          body: "Scheduled tour",
        }),
        selectors: ["as"],
        observations: [async (c, s) => await count(records(c, "crm.Activity", { parent: s.deal }))],
        rows: [
          { dependencies: [], values: async (c, s) => ["crm.salesperson"], error: "rule_failed" },
        ],
      },
      {
        operation: "crm.record_quote",
        seed: [test_worker],
        dependencies: [current_offer, prospect],
        inputs: async (c, s) => ({
          deal: s.prospect,
          revision: s.current_offer,
          body: "Issued quote",
        }),
        selectors: ["as", "revision.state"],
        observations: [async (c, s) => await count(records(c, "crm.Activity", { parent: s.deal }))],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", "sent"],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", "draft"],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["members", "sent"], error: "forbidden" },
        ],
      },
      {
        operation: "crm.record_quote",
        seed: [linked_quote, test_worker],
        dependencies: [current_offer, prospect],
        inputs: async (c, s) => ({
          deal: s.prospect,
          revision: s.current_offer,
          body: "Issued quote",
        }),
        selectors: ["as"],
        observations: [async (c, s) => await count(records(c, "crm.Activity", { parent: s.deal }))],
        rows: [
          { dependencies: [], values: async (c, s) => ["crm.salesperson"], error: "rule_failed" },
        ],
      },
      {
        operation: "crm.win",
        seed: [test_worker],
        dependencies: [prospect],
        inputs: async (c, s) => ({ deal: s.prospect }),
        selectors: ["as"],
        observations: [async (c, s) => s.deal.stage],
        rows: [
          { dependencies: [], values: async (c, s) => ["crm.salesperson"], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["members"], error: "forbidden" },
        ],
      },
      {
        operation: "crm.win",
        seed: [test_worker],
        dependencies: [paid_term, prospect],
        inputs: async (c, s) => ({ deal: s.prospect, term: s.paid_term }),
        selectors: ["as", "term.paid", "term.locations"],
        observations: [
          async (c, s) => s.deal.stage,
          async (c, s) =>
            await count(records(c, "crm.Sale", { where: (sale) => sale.deal === s.deal })),
          async (c, s) => await count(records(c, "crm.Activity", { parent: s.deal })),
          async (c, s) => s.deal.outcome_reference === s.paid_term.id,
        ],
        rows: [
          {
            dependencies: [test_site],
            values: async (c, s) => ["crm.salesperson", true, [s.test_site]],
            expected: async (c, s) => ["won", 1n, 1n, true],
          },
          {
            dependencies: [test_site],
            values: async (c, s) => ["crm.salesperson", false, [s.test_site]],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", true, []],
            error: "rule_failed",
          },
          {
            dependencies: [test_site],
            values: async (c, s) => ["members", true, [s.test_site]],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "crm.win",
        seed: [prior_sale, test_worker],
        dependencies: [paid_term, prospect],
        inputs: async (c, s) => ({ deal: s.prospect, term: s.paid_term }),
        selectors: ["as"],
        observations: [async (c, s) => s.deal.stage],
        rows: [
          { dependencies: [], values: async (c, s) => ["crm.salesperson"], error: "rule_failed" },
        ],
      },
      {
        operation: "crm.lose",
        seed: [test_worker],
        dependencies: [prospect],
        inputs: async (c, s) => ({ deal: s.prospect }),
        selectors: ["as", "reason"],
        observations: [async (c, s) => s.deal.stage, async (c, s) => s.deal.lost_reason],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", "No longer needed"],
            expected: async (c, s) => ["lost", "No longer needed"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["crm.salesperson", ""],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "No longer needed"],
            error: "forbidden",
          },
        ],
      },
    ],
  };
}
