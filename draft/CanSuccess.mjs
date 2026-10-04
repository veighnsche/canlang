/* Then-only desired witness for CanSuccess (no base .mjs exists).
 * Every @canlang/ui factory below is a proposed, unimplemented contract owned
 * by lane-05; nothing here is verified installed behavior. Given/When lowering
 * and fixture/example extraction are out of scope for this frontend replan.
 */
import { require as check, hasRole, compareInstant } from "@canlang/stdlib";

const customerSuccessPageDescriptor = {
  owner: "success",
  path: "/customer-success",
  title: message("Customer success", { nl: "Klantopvolging" }),
  description: message(
    "Review renewal risk, dated milestones and source agreement references.",
    {
      nl: "Beoordeel verlengingsrisico, gedateerde mijlpalen en bronreferenties naar overeenkomsten.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "success.account_manager"), "forbidden");
    return {};
  },
  render: customerSuccessPage,
};
import {
  action,
  alert,
  badge,
  breadcrumbs,
  button,
  calendar,
  card,
  collapse,
  edit,
  form,
  history,
  input,
  list,
  message,
  modal,
  pagination,
  radial_progress,
  radio,
  renderPage,
  select,
  slot,
  stat,
  status,
  tab,
  table,
  tabs,
  text,
  textarea,
  tooltip,
} from "@canlang/ui";

export async function customerSuccessPage(c, bindings) {
  return renderPage(c, customerSuccessPageDescriptor, () => [
    breadcrumbs({ context: c }),
    card({
      context: c,
      title: message("Customer selection", { nl: "Klantselectie" }),
      children: [
        list({
          context: c,
          model: "customer.Customer",
          empty: message("No customers found", { nl: "Geen klanten gevonden" }),
          renderRow: (row, view) => [
            form({
              context: view,
              operation: "success.Account.create",
              arguments: { parent: row },
              children: [
                select({ context: view, field: "location" }),
                input({ context: view, field: "email" }),
                calendar({ context: view, field: "renewal" }),
                radio({ context: view, field: "risk" }),
                textarea({ context: view, field: "risk_reason" }),
                textarea({ context: view, field: "notes" }),
              ],
            }),
          ],
          children: [pagination({ context: c })],
        }),
      ],
    }),
    card({
      context: c,
      title: message("Overdue follow-ups", { nl: "Achterstallige opvolgtaken" }),
      children: [
        table({
          context: c,
          model: "success.FollowUp",
          alias: "followup",
          where: (followup) =>
            !followup.done && followup.parent.active && compareInstant(followup.due, c.now) <= 0,
          columns: ["parent", "title", "due", "assignee"],
          order: ["due"],
          empty: message("No overdue follow-ups", { nl: "Geen achterstallige opvolgtaken" }),
          renderRow: (row, view) => [
            action({ context: view, operation: "success.complete", boundArgs: { followup: row } }),
          ],
          children: [pagination({ context: c })],
        }),
      ],
    }),
    card({
      context: c,
      title: message("Renewal portfolio", { nl: "Verlengingsportefeuille" }),
      children: [
        list({
          context: c,
          model: "success.Account",
          filter: ["location", "manager", "risk", "active"],
          defaults: {
            location: c.preferences.success.location,
            risk: c.preferences.success.risk_filter,
          },
          order: ["renewal"],
          display: "split",
          empty: message("No accounts found", { nl: "Geen dossiers gevonden" }),
          renderRow: (row, view) => [
            badge({ context: view, value: row.risk }),
            text({
              context: view,
              values: [row.renewal, row.active, row.risk_reason, row.agreement, row.membership],
            }),
            edit({ context: view, operation: "success.Account.update", record: row }),
            radial_progress({ context: view, value: row.progress, max: 100 }),
            stat({ context: view, values: [row.completed, row.total] }),
            text({ context: view, values: [row.reviewed_at, row.reviewed_by] }),
            tooltip({
              context: view,
              caption: message("Record that you reviewed this account", {
                nl: "Vastleggen dat je dit dossier hebt beoordeeld",
              }),
              children: [
                action({ context: view, operation: "success.review", boundArgs: { account: row } }),
              ],
            }),
            button({ context: view, opens: "reassign" }),
            modal({
              context: view,
              caption: message("Reassign account", { nl: "Klantdossier opnieuw toewijzen" }),
              id: "reassign",
              children: [
                slot({
                  context: view,
                  name: "content",
                  children: [
                    form({
                      context: view,
                      operation: "success.reassign",
                      arguments: { account: row },
                      display: "inline",
                      children: [input({ context: view, field: "email" })],
                    }),
                  ],
                }),
              ],
            }),
            ...(row.risk === "high"
              ? [
                  alert({
                    context: view,
                    children: [text({ context: view, values: [row.risk_reason] })],
                  }),
                ]
              : []),
            collapse({
              context: view,
              caption: message("Risk assessment and source references", {
                nl: "Risicobeoordeling en bronreferenties",
              }),
              children: [text({ context: view, values: [row.notes] })],
            }),
            tabs({
              context: view,
              children: [
                tab({
                  context: view,
                  caption: message("Source agreement", { nl: "Bronovereenkomst" }),
                  children: [
                    ...(row.agreement !== null
                      ? [
                          text({ context: view, values: [row.agreement] }),
                          form({
                            context: view,
                            operation: "agreements.renew",
                            arguments: { term: row.agreement },
                          }),
                        ]
                      : []),
                  ],
                }),
                tab({
                  context: view,
                  caption: message("Source membership", { nl: "Bronlidmaatschap" }),
                  children: [
                    ...(row.membership !== null
                      ? [
                          text({ context: view, values: [row.membership] }),
                          form({
                            context: view,
                            operation: "member_terms.term",
                            arguments: { membership: row.membership },
                          }),
                          table({
                            context: view,
                            model: "member_terms.Term",
                            parent: row.membership,
                            columns: ["from", "until", "paid", "collection", "cancellation"],
                            order: ["-from"],
                            empty: message("No terms found", { nl: "Geen voorwaarden gevonden" }),
                            children: [pagination({ context: view })],
                          }),
                        ]
                      : []),
                  ],
                }),
                tab({
                  context: view,
                  caption: message("Reminder delivery", { nl: "Herinneringsbezorging" }),
                  children: [
                    table({
                      context: view,
                      model: "success.Notice",
                      parent: row,
                      columns: ["followup", "recipient", "state", "created"],
                      order: ["-created"],
                      empty: message("No reminders sent", { nl: "Geen herinneringen verzonden" }),
                      renderRow: (notice, nv) => [status({ context: nv, value: notice.state })],
                      children: [pagination({ context: view })],
                    }),
                  ],
                }),
                tab({
                  context: view,
                  caption: message("Account milestones", { nl: "Klantmijlpalen" }),
                  children: [
                    form({
                      context: view,
                      operation: "success.Milestone.create",
                      arguments: { parent: row },
                      children: [
                        input({ context: view, field: "title" }),
                        calendar({ context: view, field: "due" }),
                      ],
                    }),
                    table({
                      context: view,
                      model: "success.Milestone",
                      parent: row,
                      columns: ["title", "due", "done"],
                      order: ["due"],
                      filter: ["done"],
                      empty: message("No milestones yet", { nl: "Nog geen mijlpalen" }),
                      renderRow: (milestone, mv) => [
                        edit({ context: mv, operation: "success.Milestone.update", record: milestone }),
                        action({
                          context: mv,
                          operation: "success.milestone",
                          boundArgs: { milestone },
                        }),
                      ],
                      children: [pagination({ context: view })],
                    }),
                  ],
                }),
                tab({
                  context: view,
                  caption: message("Dated follow-ups", { nl: "Gedateerde opvolgtaken" }),
                  children: [
                    form({
                      context: view,
                      operation: "success.FollowUp.create",
                      arguments: { parent: row },
                      children: [
                        input({ context: view, field: "title" }),
                        input({ context: view, field: "email" }),
                        input({ context: view, field: "due" }),
                      ],
                    }),
                    table({
                      context: view,
                      model: "success.FollowUp",
                      parent: row,
                      columns: ["title", "due", "assignee", "done"],
                      order: ["due"],
                      filter: ["done"],
                      empty: message("No follow-ups yet", { nl: "Nog geen opvolgtaken" }),
                      renderRow: (followup, fv) => [
                        edit({ context: fv, operation: "success.FollowUp.update", record: followup }),
                        action({
                          context: fv,
                          operation: "success.complete",
                          boundArgs: { followup },
                        }),
                      ],
                      children: [pagination({ context: view })],
                    }),
                  ],
                }),
              ],
            }),
            history({ context: view, record: row }),
          ],
          children: [pagination({ context: c })],
        }),
      ],
    }),
  ]);
}
