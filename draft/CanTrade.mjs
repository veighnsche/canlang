import { any, require as check, hasRole, records, same } from "@canlang/stdlib";
import {
  alert,
  badge,
  breadcrumbs,
  button,
  card,
  checkbox,
  collapse,
  content,
  edit,
  fieldset,
  form,
  history,
  input,
  list,
  message,
  modal,
  pagination,
  radio,
  remove,
  renderPage,
  select,
  slot,
  table,
  tabs,
  text,
  textarea,
} from "@canlang/ui";

/* Then-only composition companion for draft/CanTrade.can (lane L replan). Desired
 * witness: each use site marked desired-unimplemented is a proposed,
 * unimplemented producer contract (lane 05 owns renderers, lane 01 owns
 * checking/emission). Business lowering (registry, guards, fixtures, inline
 * examples) stays with the future full witness; this file mirrors the Then
 * page composition only — modals, badges, pagination, and placed inputs.
 * The publish-card eligibility gate calls the eligible() derive, which
 * resolves via the full witness registry. This file must pass node --check
 * (syntax only) and never claims to run.
 */

const marketplacePageDescriptor = {
  owner: "trade",
  path: "/marketplace",
  title: message("Community marketplace", { nl: "Communitymarktplaats" }),
  description: message(
    "Find active community listings and publish only contact details you deliberately choose.",
    {
      nl: "Vind actieve communityadvertenties en publiceer alleen contactgegevens die je bewust kiest.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    return {};
  },
  render: marketplacePage,
};

const reportsPageDescriptor = {
  owner: "trade",
  path: "/marketplace/reports",
  title: message("Listing reports", { nl: "Advertentiemeldingen" }),
  description: message(
    "Resolve reported listings under a separate moderation grant.",
    { nl: "Behandel gemelde advertenties onder een afzonderlijke moderatiebevoegdheid." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "trade.moderator") || hasRole(c, "owner"), "forbidden");
    return {};
  },
  render: reportsPage,
};

export async function marketplacePage(c, bindings) {
  const preferences = c.preferences.trade;
  return renderPage(
    c,
    marketplacePageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs consume the declared route ancestry. */
      breadcrumbs({ context: c }),
      /* require: authenticated and actor.email_verified and eligible(actor,null). */
      hasRole(c, "authenticated") && c.actor.email_verified && eligible(c, c.actor, null)
        ? card({
            context: c,
            title: message("Publish a listing", { nl: "Een advertentie publiceren" }),
            children: [
              form({
                context: c,
                operation: "trade.Post.create",
                /* desired-unimplemented: placed controls move the generated fields. */
                children: [
                  fieldset({
                    context: c,
                    caption: message("Listing details", { nl: "Advertentiegegevens" }),
                    children: [
                      radio({ context: c, field: "kind" }),
                      input({ context: c, field: "title" }),
                      textarea({ context: c, field: "description" }),
                      radio({ context: c, field: "visibility" }),
                      select({ context: c, field: "location" }),
                      input({ context: c, field: "category" }),
                      input({ context: c, field: "amount" }),
                      input({ context: c, field: "contact" }),
                    ],
                  }),
                ],
              }),
            ],
          })
        : null,
      tabs({ context: c, selector: "trade.view", value: preferences.view }),
      preferences.view === "community"
        ? card({
            context: c,
            title: message("Community discovery", { nl: "Communityaanbod ontdekken" }),
            children: [
              table({
                context: c,
                model: "trade.Post",
                where: (post) => post.state === "active",
                columns: ["kind", "category", "location", "title", "amount", "contact"],
                filter: ["kind", "category", "location"],
                defaults: {
                  kind: preferences.kind,
                  category: preferences.category,
                  location: preferences.location,
                },
                search: ["title"],
                display: "split",
                empty: message("No active listings match.", {
                  nl: "Geen actieve advertenties gevonden.",
                }),
                renderRow: (post, v) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: v }),
                  /* desired-unimplemented: badge presents the readable typed value. */
                  badge({ context: v, value: post.state }),
                  /* desired-unimplemented: content presents the readable long text. */
                  content({ context: v, value: post.description }),
                  edit({ context: v, operation: "trade.Post.update", record: post }),
                  /* desired-unimplemented: button opens activates the local modal. */
                  button({ context: v, opens: "community_listing_status" }),
                  /* desired-unimplemented: modal declares the local activation identity. */
                  modal({
                    context: v,
                    caption: message("Change listing status", { nl: "Advertentiestatus wijzigen" }),
                    id: "community_listing_status",
                    children: [
                      slot({
                        context: v,
                        name: "content",
                        children: [
                          form({
                            context: v,
                            operation: "trade.status",
                            arguments: { post },
                            display: "inline",
                            /* desired-unimplemented: placed controls move the generated fields. */
                            children: [checkbox({ context: v, field: "open" })],
                          }),
                        ],
                      }),
                    ],
                  }),
                  /* desired-unimplemented: collapse shares the details disclosure contract. */
                  collapse({
                    context: v,
                    caption: message("Published contact and reporting", {
                      nl: "Gepubliceerd contact en melden",
                    }),
                    children: [
                      text({ context: v, values: [post.visibility, post.state] }),
                      form({
                        context: v,
                        operation: "trade.Report.create",
                        arguments: { parent: post },
                        /* desired-unimplemented: placed controls move the generated fields. */
                        children: [textarea({ context: v, field: "reason" })],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          })
        : null,
      hasRole(c, "authenticated") && preferences.view === "mine"
        ? card({
            context: c,
            title: message("My listings", { nl: "Mijn advertenties" }),
            children: [
              table({
                context: c,
                model: "trade.Post",
                where: (post) => same(post.author, c.actor),
                columns: ["kind", "title", "visibility", "state", "moderation_reason"],
                filter: ["state"],
                display: "split",
                empty: message("No own listings yet.", { nl: "Nog geen eigen advertenties." }),
                renderRow: (post, v) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: v }),
                  /* desired-unimplemented: badge presents the readable typed value. */
                  badge({ context: v, value: post.state }),
                  edit({ context: v, operation: "trade.Post.update", record: post }),
                  remove({ context: v, operation: "trade.Post.delete", record: post }),
                  /* desired-unimplemented: button opens activates the local modal. */
                  button({ context: v, opens: "own_listing_status" }),
                  /* desired-unimplemented: modal declares the local activation identity. */
                  modal({
                    context: v,
                    caption: message("Change listing status", { nl: "Advertentiestatus wijzigen" }),
                    id: "own_listing_status",
                    children: [
                      slot({
                        context: v,
                        name: "content",
                        children: [
                          form({
                            context: v,
                            operation: "trade.status",
                            arguments: { post },
                            display: "inline",
                            /* desired-unimplemented: placed controls move the generated fields. */
                            children: [checkbox({ context: v, field: "open" })],
                          }),
                        ],
                      }),
                    ],
                  }),
                  history({ context: v, record: post }),
                ],
              }),
            ],
          })
        : null,
    ],
  );
}

export async function reportsPage(c, bindings) {
  return renderPage(
    c,
    reportsPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs consume the declared route ancestry. */
      breadcrumbs({ context: c }),
      hasRole(c, "owner")
        ? card({
            context: c,
            title: message("Publication audience", { nl: "Publicatiedoelgroep" }),
            children: [
              form({
                context: c,
                operation: "trade.Audience.create",
                /* desired-unimplemented: placed controls move the generated fields. */
                children: [checkbox({ context: c, field: "allow_public" })],
              }),
              list({
                context: c,
                model: "trade.Audience",
                empty: message("No audience record yet.", { nl: "Nog geen doelgroeprecord." }),
                renderRow: (audience, v) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: v }),
                  edit({ context: v, operation: "trade.Audience.update", record: audience }),
                ],
              }),
            ],
          })
        : null,
      hasRole(c, "trade.moderator")
        ? card({
            context: c,
            title: message("Reported listings", { nl: "Gemelde advertenties" }),
            children: [
              /* desired-unimplemented: alert leaf carries a readable notice. */
              alert({
                context: c,
                value: message(
                  "Unresolved reports first; dismissed reports stay readable with their decision.",
                  {
                    nl: "Eerst onopgeloste meldingen; afgewezen meldingen blijven leesbaar met hun besluit.",
                  },
                ),
              }),
              table({
                context: c,
                model: "trade.Report",
                columns: ["parent", "reason", "resolved", "decision"],
                filter: ["resolved"],
                defaults: { resolved: false },
                empty: message("No reports match this filter.", {
                  nl: "Geen meldingen voor dit filter.",
                }),
                renderRow: (report, v) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: v }),
                  /* desired-unimplemented: text presents the readable bool; badges stay enum-only. */
                  text({ context: v, values: [report.resolved] }),
                  /* desired-unimplemented: button opens activates the local modal. */
                  button({ context: v, opens: "dismiss_report" }),
                  /* desired-unimplemented: modal declares the local activation identity. */
                  modal({
                    context: v,
                    caption: message("Dismiss report", { nl: "Melding afwijzen" }),
                    id: "dismiss_report",
                    children: [
                      slot({
                        context: v,
                        name: "content",
                        children: [
                          form({
                            context: v,
                            operation: "trade.dismiss",
                            arguments: { report },
                            display: "inline",
                            /* desired-unimplemented: placed controls move the generated fields. */
                            children: [textarea({ context: v, field: "reason" })],
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
      hasRole(c, "trade.moderator")
        ? card({
            context: c,
            title: message("Moderation decisions", { nl: "Moderatiebesluiten" }),
            children: [
              list({
                context: c,
                model: "trade.Post",
                where: async (post) =>
                  await any(
                    records(c, "trade.Report", { parent: post }),
                    (report) => !report.resolved,
                  ),
                display: "split",
                empty: message("No listings awaiting moderation.", {
                  nl: "Geen advertenties te beoordelen.",
                }),
                renderRow: (post, v) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: v }),
                  /* desired-unimplemented: badge presents the readable typed value. */
                  badge({ context: v, value: post.state }),
                  /* desired-unimplemented: button opens activates the local modal. */
                  button({ context: v, opens: "moderate_listing" }),
                  /* desired-unimplemented: modal declares the local activation identity. */
                  modal({
                    context: v,
                    caption: message("Remove reported listing", {
                      nl: "Gemelde advertentie verwijderen",
                    }),
                    id: "moderate_listing",
                    children: [
                      slot({
                        context: v,
                        name: "content",
                        children: [
                          form({
                            context: v,
                            operation: "trade.moderate",
                            arguments: { post },
                            display: "inline",
                            /* desired-unimplemented: placed controls move the generated fields. */
                            children: [textarea({ context: v, field: "reason" })],
                          }),
                        ],
                      }),
                    ],
                  }),
                  history({ context: v, record: post }),
                ],
              }),
            ],
          })
        : null,
    ],
  );
}
