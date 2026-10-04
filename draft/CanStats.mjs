/* Then-only desired witness for CanStats (no base .mjs exists).
 * Every @canlang/ui factory below is a proposed, unimplemented contract owned
 * by lane-05; nothing here is verified installed behavior. Given/When lowering
 * and fixture/example extraction are out of scope for this frontend replan.
 */
import { require as check, hasRole, same } from "@canlang/stdlib";

const trafficPageDescriptor = {
  owner: "stats",
  path: "/traffic",
  title: message("Website traffic", { nl: "Websiteverkeer" }),
  description: message(
    "Inspect configured sites and clearly labeled tracker-observed goals.",
    {
      nl: "Bekijk ingestelde websites en duidelijk gelabelde doelen die de tracker heeft waargenomen.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "stats.analyst"), "forbidden");
    return {};
  },
  render: trafficPage,
};
import {
  alert,
  badge,
  breadcrumbs,
  button,
  calendar,
  card,
  collapse,
  footer,
  form,
  input,
  list,
  message,
  modal,
  pagination,
  progress,
  radio,
  renderPage,
  slot,
  stat,
  tab,
  table,
  tabs,
  text,
} from "@canlang/ui";

export async function trafficPage(c, bindings) {
  return renderPage(c, trafficPageDescriptor, () => [
    breadcrumbs({ context: c }),
    card({
      context: c,
      title: message("Configured site and reporting range", {
        nl: "Ingestelde website en rapportagebereik",
      }),
      children: [
        list({
          context: c,
          model: "stats.Site",
          alias: "site",
          where: (site) =>
            c.preferences.stats.site === null || same(site, c.preferences.stats.site),
          empty: message("No configured sites", { nl: "Geen ingestelde websites" }),
          renderRow: (row, view) => [
            text({ context: view, values: [row.name, row.domain, row.timezone, row.active, row.goals] }),
            card({
              context: view,
              title: message("Observed traffic and identifier coverage", {
                nl: "Gemeten verkeer en identificatiedekking",
              }),
              children: [
                form({
                  context: view,
                  operation: "stats.summary",
                  arguments: { site: row },
                  display: "inline",
                  children: [
                    calendar({ context: view, field: "from" }),
                    calendar({ context: view, field: "until" }),
                  ],
                  renderResult: (result, rv) => [
                    badge({ context: rv, value: result.state }),
                    text({ context: rv, values: [result.generated] }),
                    stat({
                      context: rv,
                      values: [result.events, result.goals, result.visitors, result.sessions],
                    }),
                    stat({ context: rv, values: [result.live, result.identified] }),
                    progress({ context: rv, value: result.goal_rate, max: 1 }),
                    progress({ context: rv, value: result.identity_coverage, max: 1 }),
                    ...(result.goal_counts !== null
                      ? [
                          collapse({
                            context: rv,
                            caption: message("Observed goals", { nl: "Gemeten doelen" }),
                            children: [
                              table({
                                context: rv,
                                model: "stats.GoalCount",
                                parent: result,
                                columns: ["name", "events"],
                                empty: message("No observed goals", { nl: "Geen gemeten doelen" }),
                                children: [pagination({ context: rv })],
                              }),
                            ],
                          }),
                        ]
                      : []),
                  ],
                }),
              ],
            }),
            card({
              context: view,
              title: message("Weighted dimension estimates", { nl: "Gewogen dimensieschattingen" }),
              children: [
                button({ context: view, opens: "request_breakdown" }),
                modal({
                  context: view,
                  caption: message("Request breakdown", { nl: "Uitsplitsing aanvragen" }),
                  id: "request_breakdown",
                  children: [
                    slot({
                      context: view,
                      name: "content",
                      children: [
                        form({
                          context: view,
                          operation: "stats.breakdown",
                          arguments: { site: row },
                          display: "inline",
                          children: [
                            calendar({ context: view, field: "from" }),
                            calendar({ context: view, field: "until" }),
                            radio({ context: view, field: "dimension" }),
                            input({ context: view, field: "goal" }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                list({
                  context: view,
                  model: "stats.Breakdown",
                  parent: row,
                  alias: "report",
                  where: (report) => same(report.account, c.actor) && report.current,
                  empty: message("No current reports", { nl: "Geen actuele rapporten" }),
                  renderRow: (report, rv) => [
                    badge({ context: rv, value: report.state }),
                    text({
                      context: rv,
                      values: [report.requested, report.goal, report.configured_goals, report.error],
                    }),
                    ...(report.result !== null
                      ? [
                          collapse({
                            context: rv,
                            caption: message("Report result", { nl: "Rapportresultaat" }),
                            children: [
                              text({
                                context: rv,
                                values: [
                                  report.result.from,
                                  report.result.until,
                                  report.result.sampled,
                                  report.result.complete,
                                  report.result.generated,
                                ],
                              }),
                              stat({
                                context: rv,
                                values: [
                                  report.result.events,
                                  report.result.goals,
                                  report.result.identified,
                                ],
                              }),
                              table({
                                context: rv,
                                model: "stats.DimensionRow",
                                parent: report.result,
                                columns: ["key", "events", "goals", "identified"],
                                empty: message("No report rows", { nl: "Geen rapportrijen" }),
                                children: [pagination({ context: rv })],
                              }),
                            ],
                          }),
                        ]
                      : []),
                  ],
                  children: [pagination({ context: view })],
                }),
              ],
            }),
            tabs({
              context: view,
              children: [
                tab({
                  context: view,
                  caption: message("Processing health", { nl: "Verwerkingsstatus" }),
                  children: [
                    table({
                      context: view,
                      model: "stats.Health",
                      parent: row,
                      columns: ["accepted", "rejected", "dropped", "last_processed", "observed", "state"],
                      empty: message("No health records", { nl: "Geen statusrecords" }),
                      renderRow: (health, hv) => [
                        badge({ context: hv, value: health.state }),
                        ...(health.state === "lagging"
                          ? [
                              alert({
                                context: hv,
                                children: [
                                  text({
                                    context: hv,
                                    values: [
                                      message(
                                        "Processing is delayed. Live activity excludes old queued events.",
                                        {
                                          nl: "Verwerking is vertraagd. Live activiteit sluit oude gebeurtenissen in de wachtrij uit.",
                                        },
                                      ),
                                    ],
                                  }),
                                ],
                              }),
                            ]
                          : []),
                      ],
                      children: [pagination({ context: view })],
                    }),
                  ],
                }),
                tab({
                  context: view,
                  caption: message("Accepted event inspection", {
                    nl: "Geaccepteerde gebeurtenissen bekijken",
                  }),
                  children: [
                    table({
                      context: view,
                      model: "stats.AcceptedEvent",
                      parent: row,
                      columns: ["name", "occurred", "path", "location", "workspace", "source", "medium"],
                      filter: ["name", "location", "path"],
                      order: ["-occurred"],
                      empty: message("No accepted events", { nl: "Geen geaccepteerde gebeurtenissen" }),
                      children: [pagination({ context: view })],
                    }),
                  ],
                }),
              ],
            }),
          ],
          children: [pagination({ context: c })],
        }),
      ],
    }),
    footer({
      context: c,
      children: [
        text({
          context: c,
          values: [
            message(
              "Weighted breakdowns are sampled estimates; exact counts come from accepted D1 events.",
              {
                nl: "Gewogen uitsplitsingen zijn geschatte steekproeven; exacte aantallen komen uit geaccepteerde D1-gebeurtenissen.",
              },
            ),
          ],
        }),
      ],
    }),
  ]);
}
