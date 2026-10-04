import { app_url, compareInstant, format, hasRole, require as check } from "@canlang/stdlib";
import {
  actions,
  badge, // desired/unimplemented
  breadcrumbs, // desired/unimplemented
  button, // desired/unimplemented
  card,
  checkbox, // desired/unimplemented
  collapse, // desired/unimplemented
  copy, // desired/unimplemented
  delete as remove, // desired/unimplemented
  edit,
  fieldset, // desired/unimplemented
  form,
  history,
  input, // desired/unimplemented
  list,
  message,
  modal, // desired/unimplemented
  pagination, // desired/unimplemented
  renderPage,
  slot, // desired/unimplemented
  status, // desired/unimplemented
  tab,
  table,
  tabs,
  text,
  textarea, // desired/unimplemented
} from "@canlang/ui";

/* Handwritten desired target; every import is a proposed, unimplemented contract.
 * See DESIGN §13. This file founds the CanPropose witness as a Then-only slice:
 * Given/When business lowering is absent (no CanPropose.mjs exists at base) and
 * follows the established witness pattern when landed in full. Trusted c carries
 * invocation data and inherited query authority. Viewer grants apply before
 * filtering and aggregation; pure derives inherit caller mode. UI factories own
 * daisyUI/HTMX, schemas, escaping and grants. No compiler, stdlib, renderer,
 * adapter or example runner is implemented here.
 */

/* Proposed shared server UI contract: renderPage resolves one page to the shared
 * shell or authorized partial response. Lower-case factories accept one props
 * object; children arrays retain lexical record scope, renderRow uses the protected
 * row/view context, and forms/actions resolve the canonical owning operation.
 * pagination consumes its enclosing collection's admitted cursor/filter/order
 * state; the library renders one control per collection. badge presents one
 * readable own-enum value. modal declares a local activation identity opened by
 * an external button opens=; collapse shares the details disclosure contract.
 * copy moves its value to the clipboard. This file passes node --check (syntax
 * only) and never runs.
 */

const itemizedQuoteCaption = message("Itemized quote", { nl: "Gespecificeerde offerte" });

const offersPageDescriptor = {
  owner: "propose",
  path: "/offers",
  title: message("Offers", { nl: "Offertes" }),
  description: message(
    "Author offers and resolve accepted quotations still awaiting inventory.",
    { nl: "Maak offertes en los geaccepteerde offertes op die nog op voorraad wachten." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "propose.salesperson"), "forbidden");
    return {};
  },
  render: offersPage,
};

const respondPageDescriptor = {
  owner: "propose",
  path: "/offers/respond/{Revision.id}",
  title: message("Your offer", { nl: "Jouw offerte" }),
  description: message(
    "Review the exact addressed offer and its separate booking outcome.",
    { nl: "Bekijk de exact geadresseerde offerte en het afzonderlijke boekingsresultaat." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return { row: routeBindings.Revision };
  },
  render: respondPage,
};

export async function offersPage(c, bindings) {
  return renderPage(
    c,
    offersPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Customer selection", { nl: "Klantselectie" }),
        children: [
          list({
            context: c,
            model: "customer.Customer",
            empty: message("No customers in scope.", { nl: "Geen klanten binnen scope." }),
            renderRow: (customer, view) => [
              pagination({ context: view }),
              form({ context: view, operation: "propose.Proposal.create" }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Offer drafts", { nl: "Conceptoffertes" }),
        children: [
          list({
            context: c,
            model: "propose.Proposal",
            filter: ["location"],
            search: ["title"],
            defaults: { location: c.preferences.propose.location },
            display: "split",
            empty: message("No proposals match these filters.", {
              nl: "Geen offertes voor deze filters.",
            }),
            renderRow: (proposal, view) => [
              pagination({ context: view }),
              edit({ context: view, operation: "propose.Proposal.update", record: proposal }),
              form({
                context: view,
                operation: "propose.revise",
                arguments: { proposal },
                children: [
                  fieldset({
                    context: view,
                    caption: message("Revision terms", { nl: "Versievoorwaarden" }),
                    children: [
                      textarea({ context: view, field: "terms" }),
                      input({ context: view, field: "resource" }),
                      input({ context: view, field: "seats" }),
                      input({ context: view, field: "quantity" }),
                      input({ context: view, field: "product" }),
                    ],
                  }),
                ],
              }),
              list({
                context: view,
                model: "propose.Revision",
                parent: proposal,
                order: ["-number"],
                filter: ["state", "handoff"],
                defaults: { state: c.preferences.propose.state },
                empty: message("No revisions recorded.", { nl: "Geen versies vastgelegd." }),
                renderRow: (revision, rv) => [
                  pagination({ context: rv }),
                  badge({ context: rv, value: revision.state }),
                  badge({ context: rv, value: revision.handoff }),
                  badge({ context: rv, value: revision.hold_state }),
                  badge({ context: rv, value: revision.document_state }),
                  status({ context: rv, value: revision.notice_state }),
                  status({ context: rv, value: revision.document_delivery_state }),
                  text({
                    context: rv,
                    values: [
                      revision.number,
                      revision.issuer_snapshot,
                      revision.customer_snapshot,
                      revision.title_snapshot,
                      revision.location_snapshot,
                      revision.recipient_email,
                      revision.resource,
                      revision.from,
                      revision.until,
                      revision.seats,
                      revision.quantity,
                      revision.terms,
                      revision.refund_before,
                      revision.expires,
                      revision.total,
                      revision.state,
                      revision.handoff,
                      revision.booking,
                      revision.invoice,
                      revision.hold_state,
                      revision.held_until,
                      revision.document_state,
                      revision.pdf,
                    ],
                  }),
                  tabs({
                    context: rv,
                    children: [
                      tab({
                        context: rv,
                        caption: message("Frozen revisions and items", {
                          nl: "Vastgelegde versies en regels",
                        }),
                        children: [
                          form({
                            context: rv,
                            operation: "propose.Item.create",
                            arguments: { parent: revision },
                            children: [
                              fieldset({
                                context: rv,
                                caption: itemizedQuoteCaption,
                                children: [
                                  input({ context: rv, field: "title" }),
                                  input({ context: rv, field: "quantity" }),
                                  input({ context: rv, field: "unit" }),
                                ],
                              }),
                            ],
                          }),
                          list({
                            context: rv,
                            model: "propose.Item",
                            parent: revision,
                            empty: message("No items recorded.", {
                              nl: "Geen offerteregels vastgelegd.",
                            }),
                            renderRow: (item, iv) => [
                              pagination({ context: iv }),
                              edit({ context: iv, operation: "propose.Item.update", record: item }),
                              remove({ context: iv, operation: "propose.Item.delete", record: item }),
                            ],
                          }),
                        ],
                      }),
                      tab({
                        context: rv,
                        caption: message("Booking follow-up", { nl: "Boekingsopvolging" }),
                        children: [
                          actions({
                            context: rv,
                            operations: [
                              "propose.send_offer",
                              "propose.document",
                              "propose.request_booking",
                              "propose.retry_hold_release",
                              "propose.recover_hold",
                            ],
                            boundArgs: { revision },
                          }),
                          button({ context: rv, opens: "hold_detail" }),
                          modal({
                            context: rv,
                            caption: message("Hold quoted inventory", {
                              nl: "Geoffreerde voorraad tijdelijk reserveren",
                            }),
                            id: "hold_detail",
                            children: [
                              slot({
                                context: rv,
                                name: "content",
                                children: [
                                  form({
                                    context: rv,
                                    operation: "propose.hold_inventory",
                                    arguments: { revision },
                                    display: "inline",
                                    children: [input({ context: rv, field: "until" })],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          button({ context: rv, opens: "alternative_detail" }),
                          modal({
                            context: rv,
                            caption: message("Prepare sold-out alternative", {
                              nl: "Alternatief bij uitverkoop voorbereiden",
                            }),
                            id: "alternative_detail",
                            children: [
                              slot({
                                context: rv,
                                name: "content",
                                children: [
                                  form({
                                    context: rv,
                                    operation: "propose.offer_alternative",
                                    arguments: { revision },
                                    display: "inline",
                                    children: [
                                      fieldset({
                                        context: rv,
                                        caption: message("Alternative terms", {
                                          nl: "Alternatieve voorwaarden",
                                        }),
                                        children: [
                                          input({ context: rv, field: "resource" }),
                                          input({ context: rv, field: "from" }),
                                          input({ context: rv, field: "until" }),
                                          textarea({ context: rv, field: "terms" }),
                                          input({ context: rv, field: "refund_before" }),
                                          input({ context: rv, field: "product" }),
                                        ],
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          revision.handoff === "unavailable" && revision.booking === null
                            ? collapse({
                                context: rv,
                                caption: message("New offer required", {
                                  nl: "Nieuwe offerte vereist",
                                }),
                                children: [
                                  text({
                                    context: rv,
                                    values: [
                                      message(
                                        "This accepted revision cannot be booked again. Prepare a new alternative revision for the recipient to review.",
                                        {
                                          nl: "Deze geaccepteerde versie kan niet opnieuw worden geboekt. Bereid een nieuwe alternatieve versie voor die de ontvanger kan beoordelen.",
                                        },
                                      ),
                                    ],
                                  }),
                                ],
                              })
                            : null,
                          revision.handoff === "unavailable" && revision.booking !== null
                            ? collapse({
                                context: rv,
                                caption: message("Existing booking needs review", {
                                  nl: "Bestaande boeking vereist beoordeling",
                                }),
                                children: [
                                  text({
                                    context: rv,
                                    values: [
                                      message(
                                        "Use the recorded booking and invoice references to resolve cancellation, payment or refund work in Workspace. A separate new offer does not replace those obligations.",
                                        {
                                          nl: "Gebruik de vastgelegde boekings- en factuurreferenties om annulering, betaling of terugbetaling in Workspace af te handelen. Een afzonderlijke nieuwe offerte vervangt die verplichtingen niet.",
                                        },
                                      ),
                                    ],
                                  }),
                                ],
                              })
                            : null,
                          copy({
                            context: rv,
                            value: app_url(
                              format(c, "/offers/respond/{id}", { id: revision.id }),
                            ),
                          }),
                          history({ context: rv, record: revision }),
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

export async function respondPage(c, bindings) {
  const { row } = bindings;
  return renderPage(
    c,
    respondPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Frozen offer facts", { nl: "Vastgelegde offertegegevens" }),
        children: [
          badge({ context: c, value: row.state }),
          badge({ context: c, value: row.handoff }),
          text({
            context: c,
            values: [
              row.issuer_snapshot,
              row.customer_snapshot,
              row.title_snapshot,
              row.location_snapshot,
              row.from,
              row.until,
              row.seats,
              row.quantity,
              row.terms,
              row.refund_before,
              row.expires,
              row.state,
              row.handoff,
              row.total,
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: itemizedQuoteCaption,
        children: [
          collapse({
            context: c,
            caption: itemizedQuoteCaption,
            open: c.preferences.propose.items_open,
            children: [
              table({
                context: c,
                model: "propose.Item",
                parent: row,
                columns: ["title", "quantity", "unit", "price", "tax", "discount"],
                empty: message("No items recorded.", { nl: "Geen offerteregels vastgelegd." }),
                renderRow: (item, iv) => [pagination({ context: iv })],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Decision and booking outcome", { nl: "Besluit en boekingsresultaat" }),
        children: [
          button({ context: c, opens: "decide_detail" }),
          modal({
            context: c,
            caption: message("Record decision", { nl: "Besluit vastleggen" }),
            id: "decide_detail",
            children: [
              slot({
                context: c,
                name: "content",
                children: [
                  form({
                    context: c,
                    operation: "propose.decide",
                    arguments: { revision: row },
                    display: "inline",
                    children: [checkbox({ context: c, field: "accept" })],
                  }),
                ],
              }),
            ],
          }),
          actions({
            context: c,
            operations: ["propose.document", "propose.request_booking"],
            boundArgs: { revision: row },
          }),
          status({ context: c, value: row.notice_state }),
          status({ context: c, value: row.document_delivery_state }),
          text({
            context: c,
            values: [row.pdf, row.document_state, row.booking, row.invoice],
          }),
          row.handoff === "unavailable" && row.booking === null
            ? collapse({
                context: c,
                caption: message("New offer required", { nl: "Nieuwe offerte vereist" }),
                children: [
                  text({
                    context: c,
                    values: [
                      message(
                        "The reservation is unavailable. Sales can prepare a new offer; its price and terms require a new decision.",
                        {
                          nl: "De reservering is niet beschikbaar. Verkoop kan een nieuwe offerte voorbereiden; de prijs en voorwaarden vereisen een nieuw besluit.",
                        },
                      ),
                    ],
                  }),
                ],
              })
            : null,
          row.handoff === "unavailable" && row.booking !== null
            ? collapse({
                context: c,
                caption: message("Existing booking needs review", {
                  nl: "Bestaande boeking vereist beoordeling",
                }),
                children: [
                  text({
                    context: c,
                    values: [
                      message(
                        "Your booking and invoice references remain available above. Review cancellation, payment or refund progress with the workspace operator.",
                        {
                          nl: "Je boekings- en factuurreferenties blijven hierboven beschikbaar. Bespreek de voortgang van annulering, betaling of terugbetaling met de werkplekexploitant.",
                        },
                      ),
                    ],
                  }),
                ],
              })
            : null,
          card({
            context: c,
            title: message("Inventory promise", { nl: "Voorraadtoezegging" }),
            children: [
              text({ context: c, values: [row.held_until] }),
              row.hold_state === "held" &&
              row.held_until !== null &&
              compareInstant(row.held_until, c.now) > 0
                ? collapse({
                    context: c,
                    caption: message("Held inventory", {
                      nl: "Tijdelijk gereserveerde voorraad",
                    }),
                    children: [
                      text({
                        context: c,
                        values: [
                          message("Inventory is held only until the displayed deadline.", {
                            nl: "Voorraad is uitsluitend tot de getoonde deadline gereserveerd.",
                          }),
                        ],
                      }),
                    ],
                  })
                : null,
              row.hold_state !== "held" ||
              row.held_until === null ||
              compareInstant(row.held_until, c.now) <= 0
                ? collapse({
                    context: c,
                    caption: message("Availability must be checked", {
                      nl: "Beschikbaarheid moet worden gecontroleerd",
                    }),
                    children: [
                      text({
                        context: c,
                        values: [
                          message("Acceptance does not guarantee inventory or payment.", {
                            nl: "Acceptatie garandeert geen voorraad of betaling.",
                          }),
                        ],
                      }),
                    ],
                  })
                : null,
            ],
          }),
        ],
      }),
    ],
  );
}
