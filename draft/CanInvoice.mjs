import { hasRole, require as check } from "@canlang/stdlib";
import {
  actions,
  badge, // desired/unimplemented
  breadcrumbs, // desired/unimplemented
  button, // desired/unimplemented
  calendar,
  card,
  checkbox, // desired/unimplemented
  content, // desired/unimplemented
  copy, // desired/unimplemented
  delete as removeRecord, // desired/unimplemented
  dropdown, // desired/unimplemented
  edit,
  fieldset, // desired/unimplemented
  file_input, // desired/unimplemented
  form,
  history,
  input, // desired/unimplemented
  join, // desired/unimplemented
  link, // desired/unimplemented
  list,
  message,
  metrics, // desired/unimplemented
  modal, // desired/unimplemented
  pagination, // desired/unimplemented
  renderPage,
  select, // desired/unimplemented
  slot, // desired/unimplemented
  tab,
  table,
  tabs,
  text,
  textarea, // desired/unimplemented
} from "@canlang/ui";
import { has_role, owns } from "./customer.mjs";

/* Handwritten desired target; every import is a proposed, unimplemented contract.
 * See DESIGN §13. This file founds the CanInvoice witness as a Then-only slice:
 * Given/When business lowering is preserved byte-identical (no Given/When change
 * in this slice) and follows the established witness pattern when landed in full.
 * Trusted c carries invocation data and inherited query authority. Viewer grants
 * apply before filtering and aggregation; pure derives inherit caller mode. UI
 * factories own daisyUI/HTMX, schemas, escaping and grants. No compiler, stdlib,
 * renderer, adapter or example runner is implemented here.
 */

/* Proposed shared server UI contract: renderPage resolves one page to the shared
 * shell or authorized partial response. Lower-case factories accept one props
 * object; children arrays retain lexical record scope, renderRow uses the protected
 * row/view context, and forms/actions resolve the canonical owning operation.
 * Async renderRow/data preparation is unresolved shared library work: no serializer
 * or promise handling is implemented here, and syntax checks do not verify it.
 * pagination consumes its enclosing collection's admitted cursor/filter/order
 * state; the library renders one control per collection.
 */

const invoiceHistoryPageDescriptor = {
  owner: "invoice",
  path: "/finance/invoice-history",
  title: message("Historical invoice evidence", { nl: "Historisch factuurbewijs" }),
  description: message(
    "Read retained invoices and reviewed booking relationships under current billing access.",
    {
      nl: "Lees bewaarde facturen en beoordeelde reserveringsrelaties met huidige factuurtoegang.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: invoiceHistoryPage,
};

const myInvoicesPageDescriptor = {
  owner: "invoice",
  path: "/finance/my-invoices",
  title: message("My invoices", { nl: "Mijn facturen" }),
  description: message(
    "Keep own issued invoices and payment outcomes reachable after membership expiry.",
    {
      nl: "Houd eigen uitgegeven facturen en betalingsresultaten bereikbaar na afloop van het lidmaatschap.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: myInvoicesPage,
};

const customerInvoicesPageDescriptor = {
  owner: "invoice",
  path: "/finance/invoices",
  title: message("Customer invoices", { nl: "Klantfacturen" }),
  description: message(
    "Review receivables, failed collections, credits and separate refund outcomes.",
    {
      nl: "Bekijk vorderingen, mislukte inningen, credits en afzonderlijke terugbetalingsresultaten.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "invoice.finance"), "forbidden");
    return {};
  },
  render: customerInvoicesPage,
};

const financeInvoiceDetailPageDescriptor = {
  owner: "invoice",
  path: "/finance/invoice/{Invoice.id}",
  // Desired binding: title reuses the Given message, not a copied literal.
  title: page_finance_invoice_Invoice_id_title,
  description: message(
    "Print the exact issued invoice rather than current customer-directory data.",
    {
      nl: "Druk de exacte uitgegeven factuur af in plaats van huidige gegevens uit het klantenregister.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return { row: routeBindings.Invoice };
  },
  render: financeInvoiceDetailPage,
};

export async function invoiceHistoryPage(c, bindings) {
  return renderPage(
    c,
    invoiceHistoryPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      hasRole(c, "invoice.finance")
        ? card({
            context: c,
            title: message("Retain source invoices", { nl: "Bronfacturen bewaren" }),
            children: [
              form({
                context: c,
                operation: "invoice.retain_legacy",
                import: "csv",
                review: "invoice.legacy_matches",
                children: [
                  fieldset({
                    context: c,
                    children: [
                      input({ context: c, field: "source" }),
                      input({ context: c, field: "external_id" }),
                      select({ context: c, field: "location" }),
                      file_input({ context: c, field: "document" }),
                      textarea({ context: c, field: "document_issue" }),
                      file_input({ context: c, field: "source_evidence" }),
                      textarea({ context: c, field: "attestation" }),
                    ],
                  }),
                ],
              }),
            ],
          })
        : null,
      form({
        context: c,
        operation: "invoice.legacy_matches",
        renderResult: (result, view) => [
          list({
            context: view,
            rows: result,
            columns: ["source", "external_id", "location"],
            empty: message("No historical invoices match this lookup", {
              nl: "Geen historische facturen voldoen aan deze zoekopdracht",
            }),
            renderRow: (row, rowView) => [
              copy({ context: rowView, value: row.source }),
              copy({ context: rowView, value: row.external_id }),
            ],
          }),
        ],
      }),
      table({
        context: c,
        model: "invoice.LegacyInvoice",
        archived: "include",
        columns: ["source", "external_id", "location"],
        empty: message("No historical invoices retained yet", {
          nl: "Nog geen historische facturen bewaard",
        }),
        display: "split",
        renderRow: (entry, view) => [
          copy({ context: view, value: entry.source }),
          copy({ context: view, value: entry.external_id }),
          text({
            context: view,
            values: [
              entry.facts.number,
              entry.facts.issuer,
              entry.facts.recipient,
              entry.facts.issued_original,
              entry.facts.issued_at,
              entry.facts.due_original,
              entry.facts.due,
              entry.facts.status,
              entry.facts.payment,
              entry.facts.amount,
              entry.facts.booking_count,
              entry.document_issue,
              entry.customer,
            ],
          }),
          entry.document != null
            ? link({
                context: view,
                target: entry.document,
                caption: message("Original invoice document", {
                  nl: "Oorspronkelijk factuurdocument",
                }),
              })
            : null,
          table({
            context: view,
            model: "invoice.LegacyInvoiceBooking",
            parent: entry,
            archived: "include",
            columns: ["booking_source", "booking_external_id", "booking"],
            empty: message("No booking links retained for this invoice", {
              nl: "Geen reserveringskoppelingen bewaard voor deze factuur",
            }),
            renderRow: (row, rowView) => [
              hasRole(rowView, "invoice.finance")
                ? card({
                    context: rowView,
                    title: message("Resolve retained booking evidence", {
                      nl: "Bewaard reserveringsbewijs koppelen",
                    }),
                    children: [
                      button({ context: rowView, opens: "legacy_booking_resolve" }),
                      text({
                        context: rowView,
                        values: [row.mapping_reason, row.attestation, row.source_evidence],
                      }),
                      modal({
                        context: rowView,
                        caption: message("Resolve invoice booking link", {
                          nl: "Factuur-reserveringskoppeling oplossen",
                        }),
                        id: "legacy_booking_resolve",
                        children: [
                          slot({
                            name: "content",
                            children: [
                              form({
                                context: rowView,
                                operation: "invoice.link_legacy_booking",
                                arguments: { edge: row },
                                display: "inline",
                                children: [
                                  fieldset({
                                    context: rowView,
                                    children: [textarea({ context: rowView, field: "reason" })],
                                  }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  })
                : null,
              pagination({ context: rowView }),
            ],
          }),
          hasRole(view, "invoice.finance")
            ? card({
                context: view,
                title: message("Current customer mapping and original export", {
                  nl: "Huidige klantkoppeling en oorspronkelijke export",
                }),
                children: [
                  join({
                    context: view,
                    children: [
                      button({ context: view, opens: "legacy_map" }),
                      button({ context: view, opens: "legacy_edge_retain" }),
                    ],
                  }),
                  link({
                    context: view,
                    target: entry.source_evidence,
                    caption: message("Original source artifact", {
                      nl: "Oorspronkelijk bronbestand",
                    }),
                  }),
                  text({
                    context: view,
                    values: [
                      entry.mapping_reason,
                      entry.attestation,
                      entry.imported_by,
                      entry.imported_at,
                    ],
                  }),
                  modal({
                    context: view,
                    caption: message("Map historical invoice customer", {
                      nl: "Historische factuur aan klant koppelen",
                    }),
                    id: "legacy_map",
                    children: [
                      slot({
                        name: "content",
                        children: [
                          form({
                            context: view,
                            operation: "invoice.link_legacy",
                            arguments: { entry },
                            display: "inline",
                            children: [
                              fieldset({
                                context: view,
                                children: [
                                  select({ context: view, field: "customer" }),
                                  textarea({ context: view, field: "reason" }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                  modal({
                    context: view,
                    caption: message("Retain invoice booking link", {
                      nl: "Factuur-reserveringskoppeling bewaren",
                    }),
                    id: "legacy_edge_retain",
                    children: [
                      slot({
                        name: "content",
                        children: [
                          form({
                            context: view,
                            operation: "invoice.retain_legacy_booking",
                            arguments: { entry },
                            display: "inline",
                            children: [
                              fieldset({
                                context: view,
                                children: [
                                  input({ context: view, field: "booking_source" }),
                                  input({ context: view, field: "booking_external_id" }),
                                  file_input({ context: view, field: "source_evidence" }),
                                  textarea({ context: view, field: "attestation" }),
                                  textarea({ context: view, field: "reason" }),
                                ],
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                  history({ context: view, record: entry }),
                ],
              })
            : null,
          pagination({ context: view }),
        ],
      }),
    ],
  );
}

export async function myInvoicesPage(c, bindings) {
  const preferences = c.preferences.invoice;
  return renderPage(
    c,
    myInvoicesPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Issued invoices", { nl: "Uitgegeven facturen" }),
        children: [
          list({
            context: c,
            model: "invoice.Invoice",
            where: (invoice) =>
              invoice.state !== "draft"
              && (owns(c, c.actor, invoice.parent)
                || has_role(c, c.actor, invoice.parent, "billing")),
            order: ["-issued_at"],
            filter: ["location", "currency"],
            empty: message("No own invoices match these filters", {
              nl: "Geen eigen facturen voldoen aan deze filters",
            }),
            defaults: { location: preferences.location, currency: preferences.currency },
            display: "split",
            renderRow: (invoice, view) => [
              badge({ context: view, value: invoice.state }),
              text({
                context: view,
                values: [
                  invoice.number,
                  invoice.description,
                  invoice.total,
                  invoice.balance,
                  invoice.settled,
                  invoice.collection_pending,
                  invoice.due,
                  invoice.currency,
                ],
              }),
              copy({ context: view, value: invoice.number }),
              actions({
                context: view,
                operations: ["invoice.collect", "invoice.document", "invoice.receipt"],
                boundArgs: { invoice },
              }),
              tabs({
                context: view,
                children: [
                  tab({
                    context: view,
                    caption: message("Documents and lines", { nl: "Documenten en regels" }),
                    children: [
                      table({
                        context: view,
                        model: "invoice.Document",
                        parent: invoice,
                        columns: ["kind", "revision", "file", "generated"],
                        empty: message("No documents generated yet", {
                          nl: "Nog geen documenten gegenereerd",
                        }),
                        renderRow: (row, rowView) => [pagination({ context: rowView })],
                      }),
                      table({
                        context: view,
                        model: "invoice.DocumentRequest",
                        parent: invoice,
                        columns: ["kind", "revision", "status", "error"],
                        empty: message("No document requests yet", {
                          nl: "Nog geen documentaanvragen",
                        }),
                        renderRow: (row, rowView) => [pagination({ context: rowView })],
                      }),
                      table({
                        context: view,
                        model: "invoice.Line",
                        parent: invoice,
                        columns: [
                          "description",
                          "quantity",
                          "unit",
                          "service_from",
                          "service_until",
                          "service_location",
                          "service_reference",
                          "price",
                          "tax",
                          "discount",
                        ],
                        empty: message("No lines on this invoice", {
                          nl: "Geen regels op deze factuur",
                        }),
                        renderRow: (row, rowView) => [pagination({ context: rowView })],
                      }),
                    ],
                  }),
                  tab({
                    context: view,
                    caption: message("Own payment outcomes", {
                      nl: "Eigen betalingsresultaten",
                    }),
                    children: [
                      table({
                        context: view,
                        model: "invoice.Attempt",
                        parent: invoice,
                        columns: ["kind", "amount", "status", "checkout", "received"],
                        empty: message("No payment attempts yet", {
                          nl: "Nog geen betaalpogingen",
                        }),
                        renderRow: (row, rowView) => [
                          row.checkout != null
                            ? link({
                                context: rowView,
                                target: row.checkout,
                                caption: message("Payment link", { nl: "Betaallink" }),
                              })
                            : null,
                          pagination({ context: rowView }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              history({ context: view, record: invoice }),
              pagination({ context: view }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function customerInvoicesPage(c, bindings) {
  const preferences = c.preferences.invoice;
  return renderPage(
    c,
    customerInvoicesPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Customer selection", { nl: "Klantselectie" }),
        children: [
          list({
            context: c,
            model: "customer.Customer",
            empty: message("No customers available", { nl: "Geen klanten beschikbaar" }),
            renderRow: (customer, view) => [
              form({
                context: view,
                operation: "invoice.Invoice.create",
                arguments: { parent: customer },
                children: [
                  fieldset({
                    context: view,
                    children: [
                      select({ context: view, field: "location" }),
                      input({ context: view, field: "source" }),
                      input({ context: view, field: "issuer" }),
                      input({ context: view, field: "recipient" }),
                      input({ context: view, field: "recipient_email" }),
                      input({ context: view, field: "tax_reference" }),
                      textarea({ context: view, field: "address" }),
                      textarea({ context: view, field: "description" }),
                      calendar({ context: view, field: "due" }),
                    ],
                  }),
                ],
              }),
              pagination({ context: view }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Invoice drafts and lines", { nl: "Conceptfacturen en regels" }),
        children: [
          table({
            context: c,
            model: "invoice.Invoice",
            columns: [
              "number",
              "location",
              "recipient",
              "total",
              "balance",
              "refund_due",
              "state",
              "settled",
              "collection_pending",
              "refund_pending",
              "next_collection",
              "due",
              "needs_review",
            ],
            filter: ["location", "state", "currency", "due"],
            search: ["recipient"],
            empty: message("No invoices match these filters", {
              nl: "Geen facturen voldoen aan deze filters",
            }),
            defaults: { location: preferences.location, currency: preferences.currency },
            display: "split",
            renderRow: (row, view) => [
              pagination({ context: view }),
              badge({ context: view, value: row.state }),
              edit({ context: view, operation: "invoice.Invoice.update", record: row }),
              tabs({
                context: view,
                children: [
                  tab({
                    context: view,
                    caption: message("Invoice lines", { nl: "Factuurregels" }),
                    children: [
                      form({
                        context: view,
                        operation: "invoice.Line.create",
                        arguments: { parent: row },
                        children: [
                          fieldset({
                            context: view,
                            children: [
                              textarea({ context: view, field: "description" }),
                              input({ context: view, field: "unit" }),
                            ],
                          }),
                        ],
                      }),
                      table({
                        context: view,
                        model: "invoice.Line",
                        parent: row,
                        columns: [
                          "description",
                          "quantity",
                          "unit",
                          "service_from",
                          "service_until",
                          "service_location",
                          "service_reference",
                          "price",
                          "tax",
                          "discount",
                        ],
                        empty: message("No lines on this invoice", {
                          nl: "Geen regels op deze factuur",
                        }),
                        renderRow: (line, lineView) => [
                          edit({
                            context: lineView,
                            operation: "invoice.Line.update",
                            record: line,
                          }),
                          removeRecord({ context: lineView }),
                          pagination({ context: lineView }),
                        ],
                      }),
                    ],
                  }),
                  tab({
                    context: view,
                    caption: message("Collection queue", { nl: "Inningswachtrij" }),
                    children: [
                      text({
                        context: view,
                        values: [
                          row.due,
                          row.balance,
                          row.next_collection,
                          row.collection_pending,
                          row.refund_pending,
                          row.needs_review,
                        ],
                      }),
                      actions({
                        context: view,
                        operations: ["invoice.collect"],
                        boundArgs: { invoice: row },
                      }),
                      table({
                        context: view,
                        model: "invoice.Attempt",
                        parent: row,
                        columns: [
                          "mode",
                          "requested",
                          "outcome_at",
                          "amount",
                          "status",
                          "failure",
                          "checkout",
                          "received",
                        ],
                        empty: message("No attempts recorded yet", {
                          nl: "Nog geen pogingen vastgelegd",
                        }),
                        renderRow: (attempt, attemptView) => [
                          button({ context: attemptView, opens: "attempt_review" }),
                          modal({
                            context: attemptView,
                            caption: message("Review payment outcome", {
                              nl: "Betalingsresultaat beoordelen",
                            }),
                            id: "attempt_review",
                            children: [
                              slot({
                                name: "content",
                                children: [
                                  form({
                                    context: attemptView,
                                    operation: "invoice.review_attempt",
                                    arguments: { attempt },
                                    display: "inline",
                                    children: [
                                      fieldset({
                                        context: attemptView,
                                        children: [
                                          textarea({ context: attemptView, field: "reason" }),
                                        ],
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          table({
                            context: attemptView,
                            model: "invoice.PaymentRequest",
                            parent: attempt,
                            columns: [
                              "kind",
                              "status",
                              "review_reason",
                              "reviewed_by",
                              "reviewed_at",
                            ],
                            empty: message("No observation requests yet", {
                              nl: "Nog geen waarnemingsaanvragen",
                            }),
                            renderRow: (request, requestView) => [
                              pagination({ context: requestView }),
                            ],
                          }),
                          pagination({ context: attemptView }),
                        ],
                      }),
                    ],
                  }),
                  tab({
                    context: view,
                    caption: message("Collection and refund evidence", {
                      nl: "Innings- en terugbetalingsbewijs",
                    }),
                    children: [
                      actions({
                        context: view,
                        operations: [
                          "invoice.document",
                          "invoice.receipt",
                          "invoice.collect",
                        ],
                        boundArgs: { invoice: row },
                      }),
                      button({ context: view, opens: "issue_detail" }),
                      modal({
                        context: view,
                        caption: message("Issue invoice", { nl: "Factuur uitgeven" }),
                        id: "issue_detail",
                        children: [
                          slot({
                            context: view,
                            name: "content",
                            children: [
                              form({
                                context: view,
                                operation: "invoice.issue",
                                arguments: { invoice: row },
                                display: "inline",
                                children: [input({ context: view, field: "number" })],
                              }),
                            ],
                          }),
                        ],
                      }),
                      dropdown({
                        context: view,
                        children: [
                          slot({
                            name: "trigger",
                            children: [
                              text({
                                context: view,
                                values: [
                                  message("More actions", { nl: "Meer acties" }),
                                ],
                              }),
                            ],
                          }),
                          slot({
                            name: "content",
                            children: [
                              button({ context: view, opens: "payment_detail" }),
                              modal({
                                context: view,
                                caption: message("Record external payment", {
                                  nl: "Externe betaling registreren",
                                }),
                                id: "payment_detail",
                                children: [
                                  slot({
                                    context: view,
                                    name: "content",
                                    children: [
                                      form({
                                        context: view,
                                        operation: "invoice.record_payment",
                                        arguments: { invoice: row },
                                        display: "inline",
                                        children: [
                                          input({ context: view, field: "amount" }),
                                          input({ context: view, field: "reference" }),
                                          input({ context: view, field: "received" }),
                                          textarea({ context: view, field: "evidence" }),
                                        ],
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                              button({ context: view, opens: "credit_detail" }),
                              modal({
                                context: view,
                                caption: message("Credit invoice", {
                                  nl: "Factuur crediteren",
                                }),
                                id: "credit_detail",
                                children: [
                                  slot({
                                    context: view,
                                    name: "content",
                                    children: [
                                      form({
                                        context: view,
                                        operation: "invoice.credit",
                                        arguments: { invoice: row },
                                        display: "inline",
                                        children: [
                                          input({ context: view, field: "amount" }),
                                          textarea({ context: view, field: "reason" }),
                                        ],
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                              button({ context: view, opens: "refund_detail" }),
                              modal({
                                context: view,
                                caption: message("Refund payment", {
                                  nl: "Betaling terugbetalen",
                                }),
                                id: "refund_detail",
                                children: [
                                  slot({
                                    context: view,
                                    name: "content",
                                    children: [
                                      form({
                                        context: view,
                                        operation: "invoice.refund",
                                        arguments: { invoice: row },
                                        display: "inline",
                                        children: [
                                          select({ context: view, field: "payment" }),
                                          input({ context: view, field: "amount" }),
                                          textarea({ context: view, field: "reason" }),
                                        ],
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                              button({ context: view, opens: "record_refund_detail" }),
                              modal({
                                context: view,
                                caption: message("Record external refund", {
                                  nl: "Externe terugbetaling registreren",
                                }),
                                id: "record_refund_detail",
                                children: [
                                  slot({
                                    context: view,
                                    name: "content",
                                    children: [
                                      form({
                                        context: view,
                                        operation: "invoice.record_refund",
                                        arguments: { invoice: row },
                                        display: "inline",
                                        children: [
                                          select({ context: view, field: "payment" }),
                                          input({ context: view, field: "amount" }),
                                          input({ context: view, field: "reference" }),
                                          input({ context: view, field: "received" }),
                                          textarea({ context: view, field: "evidence" }),
                                          textarea({ context: view, field: "reason" }),
                                        ],
                                      }),
                                    ],
                                  }),
                                ],
                              }),
                              button({ context: view, opens: "void_detail" }),
                              modal({
                                context: view,
                                caption: message("Void invoice", {
                                  nl: "Factuur ongeldig maken",
                                }),
                                id: "void_detail",
                                children: [
                                  slot({
                                    context: view,
                                    name: "content",
                                    children: [
                                      form({
                                        context: view,
                                        operation: "invoice.void",
                                        arguments: { invoice: row },
                                        display: "inline",
                                        children: [
                                          textarea({ context: view, field: "reason" }),
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
                      table({
                        context: view,
                        model: "invoice.Attempt",
                        parent: row,
                        columns: [
                          "mode",
                          "requested",
                          "outcome_at",
                          "kind",
                          "amount",
                          "status",
                          "failure",
                          "checkout",
                          "received",
                        ],
                        empty: message("No attempts recorded yet", {
                          nl: "Nog geen pogingen vastgelegd",
                        }),
                        renderRow: (attempt, attemptView) => [
                          table({
                            context: attemptView,
                            model: "invoice.PaymentRequest",
                            parent: attempt,
                            columns: [
                              "kind",
                              "status",
                              "review_reason",
                              "reviewed_by",
                              "reviewed_at",
                            ],
                            empty: message("No observation requests yet", {
                              nl: "Nog geen waarnemingsaanvragen",
                            }),
                            renderRow: (request, requestView) => [
                              pagination({ context: requestView }),
                            ],
                          }),
                          pagination({ context: attemptView }),
                        ],
                      }),
                      table({
                        context: view,
                        model: "invoice.ExternalPayment",
                        parent: row,
                        columns: ["reference", "amount", "received", "evidence"],
                        empty: message("No external payments recorded", {
                          nl: "Geen externe betalingen vastgelegd",
                        }),
                        renderRow: (payment, paymentView) => [
                          pagination({ context: paymentView }),
                        ],
                      }),
                      table({
                        context: view,
                        model: "invoice.ExternalRefund",
                        parent: row,
                        columns: ["reference", "amount", "received", "evidence", "reason"],
                        empty: message("No external refunds recorded", {
                          nl: "Geen externe terugbetalingen vastgelegd",
                        }),
                        renderRow: (refund, refundView) => [
                          pagination({ context: refundView }),
                        ],
                      }),
                      history({ context: view, record: row }),
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

export async function financeInvoiceDetailPage(c, bindings) {
  const { row } = bindings;
  return renderPage(
    c,
    financeInvoiceDetailPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      badge({ context: c, value: row.state }),
      card({
        context: c,
        title: message("Frozen issuer and recipient", {
          nl: "Vastgelegde uitgever en ontvanger",
        }),
        children: [
          text({
            context: c,
            values: [
              row.issuer,
              row.recipient,
              row.address,
              row.tax_reference,
              row.number,
              row.issued_at,
              row.due,
              row.currency,
            ],
          }),
          copy({ context: c, value: row.number }),
          content({ context: c, values: [row.terms] }),
        ],
      }),
      card({
        context: c,
        title: message("Itemized charges", { nl: "Gespecificeerde kosten" }),
        children: [
          table({
            context: c,
            model: "invoice.Line",
            parent: row,
            columns: [
              "description",
              "quantity",
              "unit",
              "service_from",
              "service_until",
              "service_location",
              "service_reference",
              "price",
              "tax",
              "discount",
            ],
            empty: message("No lines on this invoice", {
              nl: "Geen regels op deze factuur",
            }),
            renderRow: (line, lineView) => [pagination({ context: lineView })],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Balance and refund obligation", {
          nl: "Saldo en terugbetalingsverplichting",
        }),
        children: [
          metrics({
            context: c,
            values: [
              row.total,
              row.credits,
              row.received,
              row.refunded,
              row.balance,
              row.refund_due,
            ],
          }),
          text({
            context: c,
            values: [row.settled, row.collection_pending, row.refund_pending],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Documents and adjustments", {
          nl: "Documenten en correcties",
        }),
        children: [
          actions({
            context: c,
            operations: ["invoice.document", "invoice.receipt", "invoice.collect"],
            boundArgs: { invoice: row },
          }),
          table({
            context: c,
            model: "invoice.Document",
            parent: row,
            columns: ["kind", "revision", "file", "generated"],
            empty: message("No documents generated yet", {
              nl: "Nog geen documenten gegenereerd",
            }),
            renderRow: (document, documentView) => [pagination({ context: documentView })],
          }),
          table({
            context: c,
            model: "invoice.DocumentRequest",
            parent: row,
            columns: ["kind", "revision", "status", "error"],
            empty: message("No document requests yet", {
              nl: "Nog geen documentaanvragen",
            }),
            renderRow: (request, requestView) => [pagination({ context: requestView })],
          }),
          table({
            context: c,
            model: "invoice.Credit",
            parent: row,
            columns: ["amount", "reason"],
            empty: message("No credits recorded", { nl: "Geen credits vastgelegd" }),
            renderRow: (credit, creditView) => [pagination({ context: creditView })],
          }),
          table({
            context: c,
            model: "invoice.Attempt",
            parent: row,
            columns: ["kind", "amount", "status", "checkout", "received", "reason"],
            empty: message("No attempts recorded yet", {
              nl: "Nog geen pogingen vastgelegd",
            }),
            renderRow: (attempt, attemptView) => [pagination({ context: attemptView })],
          }),
        ],
      }),
      hasRole(c, "invoice.finance")
        ? card({
            context: c,
            title: message("Customer commercial history", {
              nl: "Commerciële klanthistoriek",
            }),
            children: [
              table({
                context: c,
                model: "invoice.CommercialHistory",
                parent: row.parent,
                columns: ["complete", "first_invoice", "evidence"],
                empty: message("No commercial history reviewed yet", {
                  nl: "Nog geen commerciële historiek beoordeeld",
                }),
                renderRow: (entry, entryView) => [pagination({ context: entryView })],
              }),
              form({
                context: c,
                operation: "invoice.review_commercial_history",
                arguments: { customer: row.parent },
                children: [
                  fieldset({
                    context: c,
                    children: [
                      checkbox({ context: c, field: "complete" }),
                      textarea({ context: c, field: "evidence" }),
                    ],
                  }),
                ],
              }),
            ],
          })
        : null,
      history({ context: c, record: row }),
    ],
  );
}
