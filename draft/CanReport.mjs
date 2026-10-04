import { require as check, hasRole, same } from "@canlang/stdlib";
import {
  alert,
  badge,
  breadcrumbs,
  card,
  collapse,
  form,
  hero,
  list,
  message,
  metrics,
  pagination,
  renderPage,
  table,
  text,
} from "@canlang/ui";

/* Then-only composition companion for draft/CanReport.can (lane L replan). Desired
 * witness: each use site marked desired-unimplemented is a proposed,
 * unimplemented producer contract (lane 05 owns renderers, lane 01 owns
 * checking/emission). Business lowering (registry, guards, fixtures, inline
 * examples) stays with the future full witness; this file mirrors the Then
 * page composition only — badges, pagination, and the measure form (no modals).
 * It must pass node --check (syntax only) and never claims to run.
 */

const reportsPageDescriptor = {
  owner: "report",
  path: "/reports",
  title: message("Operational reports", { nl: "Operationele rapporten" }),
  description: message(
    "Compare booked and recorded occupancy, cash receipts, balances and service backlog.",
    {
      nl: "Vergelijk gereserveerde en vastgelegde bezetting, ontvangen betalingen, saldi en serviceachterstand.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "report.manager"), "forbidden");
    return {};
  },
  render: reportsPage,
};

export async function reportsPage(c, bindings) {
  const preferences = c.preferences.report;
  return renderPage(
    c,
    reportsPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs consume the declared route ancestry. */
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Existing report definitions", { nl: "Bestaande rapportdefinities" }),
        children: [
          list({
            context: c,
            model: "report.Definition",
            where: (definition) =>
              preferences.definition === null || same(definition, preferences.definition),
            empty: message("No report definitions available.", {
              nl: "Geen rapportdefinities beschikbaar.",
            }),
            renderRow: (definition, v) => [
              /* desired-unimplemented: pagination consumes this collection cursor. */
              pagination({ context: v }),
              /* desired-unimplemented: hero groups the scoped definition content. */
              hero({
                context: v,
                caption: definition.name,
                children: [
                  text({
                    context: v,
                    values: [definition.inclusion, definition.unit, definition.display_timezone],
                  }),
                  form({ context: v, operation: "report.refresh", arguments: { definition } }),
                  card({
                    context: v,
                    title: message("Run checkpoints and completeness", {
                      nl: "Controlepunten en volledigheid van uitvoeringen",
                    }),
                    children: [
                      list({
                        context: v,
                        model: "report.Run",
                        parent: definition,
                        order: ["-requested"],
                        display: "split",
                        empty: message("No runs yet.", { nl: "Nog geen uitvoeringen." }),
                        renderRow: (run, rv) => [
                          /* desired-unimplemented: pagination consumes this collection cursor. */
                          pagination({ context: rv }),
                          /* desired-unimplemented: badge presents the readable typed value. */
                          badge({ context: rv, value: run.state }),
                          text({
                            context: rv,
                            values: [
                              run.checkpoint,
                              run.pending,
                              run.from,
                              run.until,
                              run.currency,
                            ],
                          }),
                          card({
                            context: rv,
                            title: message("Typed report measure", {
                              nl: "Getypeerde rapportmaatstaf",
                            }),
                            children: [
                              form({
                                context: rv,
                                operation: "report.measure",
                                arguments: { run },
                                renderResult: (result, scope) => [
                                  metrics({
                                    context: scope,
                                    values: [
                                      result.quantity,
                                      result.numerator,
                                      result.denominator,
                                      result.value,
                                      result.amount,
                                    ],
                                  }),
                                  /* desired-unimplemented: badge presents the readable typed value. */
                                  badge({ context: scope, value: result.state }),
                                  text({
                                    context: scope,
                                    values: [
                                      result.complete,
                                      result.pending,
                                      result.generated,
                                      result.inclusion,
                                      result.unit,
                                    ],
                                  }),
                                  result.state !== "fresh" || !result.complete || result.pending
                                    ? /* desired-unimplemented: alert suite carries the coverage notice. */
                                      alert({
                                        context: scope,
                                        children: [
                                          text({
                                            context: scope,
                                            values: [
                                              message(
                                                "Coverage is incomplete; shown quantities are withheld, never zero-filled.",
                                                {
                                                  nl: "De dekking is onvolledig; getoonde hoeveelheden blijven achtergehouden en worden nooit met nul gevuld.",
                                                },
                                              ),
                                            ],
                                          }),
                                        ],
                                      })
                                    : null,
                                ],
                              }),
                            ],
                          }),
                          /* desired-unimplemented: collapse shares the details disclosure contract. */
                          collapse({
                            context: rv,
                            caption: message("Source contributions", { nl: "Bronbijdragen" }),
                            children: [
                              /* desired-unimplemented: items+contract renders the typed structural array. */
                              table({
                                context: rv,
                                items: run.rows,
                                contract: "report.Contribution",
                                columns: [
                                  "source",
                                  "revision",
                                  "location",
                                  "metric",
                                  "quantity",
                                  "unit",
                                  "amount",
                                  "provisional",
                                ],
                                empty: message("No source contributions.", {
                                  nl: "Geen bronbijdragen.",
                                }),
                                renderRow: () => [
                                  /* desired-unimplemented: pagination consumes this collection cursor. */
                                  pagination({ context: rv }),
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
          }),
        ],
      }),
    ],
  );
}
