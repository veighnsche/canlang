import {
  compareInstant,
  hasRole,
  records,
  require as check,
  same,
} from "@canlang/stdlib";
import {
  action,
  actions,
  alert,
  badge,
  breadcrumbs,
  button,
  card,
  checkbox,
  content,
  copy,
  edit,
  fieldset,
  file_input,
  form,
  history,
  input,
  join,
  link,
  list,
  message,
  modal,
  pagination,
  radio,
  renderPage,
  select,
  slot,
  stat,
  tab,
  table,
  tabs,
  text,
  textarea,
  title,
  toggle,
  tooltip,
} from "@canlang/ui";
import { has_role } from "./customer.mjs";
import { can_work } from "./employee.mjs";

/* Handwritten desired target; every import is a proposed, unimplemented contract.
 * See DESIGN §13. Trusted c carries invocation data and inherited query
 * authority; records(c, model, {...}) preserves owner/team bounds, expiry and
 * work limits. Viewer grants apply before filtering and aggregation; pure
 * derives inherit caller mode. Shared admission owns versions, locks, replay
 * and atomic effects. UI factories own daisyUI/HTMX, schemas, escaping and
 * grants. No compiler, stdlib, renderer, adapter or example runner is
 * implemented here.
 *
 * Lane K replan (Then only): the descriptors and page composition below are
 * the desired frontend target. Given/When business lowering (models, derives,
 * policies, scenarios, examples) is unchanged on the compiler path and is
 * preserved through the operations table, not re-derived here. The alert,
 * badge, breadcrumbs, button, checkbox, content, copy, fieldset, input, join,
 * link, modal, pagination, radio, select, slot, stat, textarea, title, toggle
 * and tooltip factories, the has_role customer helper, the read-form
 * renderResult contract, modal/tooltip focus contracts, breadcrumbs ancestry
 * and link file contracts are desired/unimplemented (lane 5 owns renderers,
 * lane 1 owns checking).
 */

// desired/unimplemented: customer-owner role read across the composition.
async function isCustomerAdministrator(c, person) {
  if (person === null) return false;
  const customers = await records(c, "customer.Customer", {});
  for (const customer of customers) {
    if (await has_role(c, person, customer, "administrator")) return true;
  }
  return false;
}

// desired/unimplemented: record-route binding resolves the company row.
async function companyFromRoute(c, routeBindings) {
  const matches = await records(c, "customer.Customer", {
    where: (customer) => customer.id === routeBindings.id,
  });
  return matches.length > 0 ? matches[0] : null;
}

async function managesCompanyLocation(c, person, company) {
  if (person === null) return false;
  for (const location of company.locations ?? []) {
    if (await can_work(c, person, location)) return true;
  }
  return false;
}

function termVisible(term, c) {
  return (
    !c.preferences.member_terms.current_only ||
    (compareInstant(term.from, c.now) <= 0 &&
      compareInstant(c.now, term.until) < 0)
  );
}

const plansDescriptor = {
  owner: "member_plans",
  path: "/membership/plans",
  order: 4n,
  title: message("Membership plans", { nl: "Lidmaatschapsabonnementen" }),
  description: message(
    "Author the sellable plan catalog under a distinct plan-owner grant.",
    {
      nl: "Beheer het verkoopbare abonnementscatalogus onder een afzonderlijk eigenaarsrecht.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "member_plans.plan_owner"), "forbidden");
    return {};
  },
  render: plansPage,
};

const accessReviewDescriptor = {
  owner: "member_terms",
  path: "/membership/access-review",
  title: message("Membership access review", {
    nl: "Beoordeling lidmaatschapstoegang",
  }),
  description: message(
    "Discover the owner review independently of any customer application's selected pages.",
  ),
  admit: async (c, routeBindings = {}) => {
    check(
      hasRole(c, "member_terms.member_manager") ||
        (await isCustomerAdministrator(c, c.actor)),
      "forbidden",
    );
    return {};
  },
  render: accessReviewPage,
};

const companyAccessDescriptor = {
  owner: "member_terms",
  path: "/companies/{Customer.id}/membership-access",
  title: message("Company membership access", {
    nl: "Bedrijfslidmaatschapstoegang",
  }),
  description: message(
    "Keep company access review in the membership owner, without disclosing visitor/device records.",
  ),
  admit: async (c, routeBindings = {}) => {
    const company = await companyFromRoute(c, routeBindings);
    check(company !== null, "not_found");
    check(
      (c.actor !== null &&
        (await has_role(c, c.actor, company, "administrator"))) ||
        (hasRole(c, "member_terms.member_manager") &&
          (await managesCompanyLocation(c, c.actor, company))),
      "forbidden",
    );
    return { row: company };
  },
  render: companyAccessPage,
};

const myMembershipDescriptor = {
  owner: "member_terms",
  path: "/membership/mine",
  order: 1n,
  title: message("My membership", { nl: "Mijn lidmaatschap" }),
  description: message(
    "View your current benefits and keep your billing portal available after expiry.",
    {
      nl: "Bekijk je huidige voordelen en houd je facturatieportaal bereikbaar na afloop.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: myMembershipPage,
};

const registerDescriptor = {
  owner: "member_terms",
  path: "/membership/register",
  order: 3n,
  title: message("Membership register", { nl: "Lidmaatschapsregister" }),
  description: message(
    "Resolve paid terms, allowances and company seat allocations.",
    {
      nl: "Beheer betaalde termijnen, tegoeden en bedrijfsplaatsen.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "member_terms.member_manager"), "forbidden");
    return {};
  },
  render: registerPage,
};

const contentEditDescriptor = {
  owner: "member_content",
  path: "/membership/content/edit",
  title: message("Edit member information", {
    nl: "Ledeninformatie bewerken",
  }),
  description: message(
    "Publish site guides under the content editor grant.",
    {
      nl: "Publiceer locatiegidsen onder het recht van de inhoudsredacteur.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "member_terms.content_editor"), "forbidden");
    return {};
  },
  render: contentEditPage,
};

const contentDescriptor = {
  owner: "member_content",
  path: "/membership/content",
  order: 2n,
  title: message("Member information", { nl: "Ledeninformatie" }),
  description: message(
    "Open only member content currently granted by paid, nonrevoked terms.",
    {
      nl: "Open uitsluitend ledeninhoud die momenteel door betaalde, niet-ingetrokken termijnen wordt toegestaan.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: contentPage,
};

export const appDefinition = {
  id: "CanMember",
  uses: [
    "member_plans",
    "member_terms",
    "member_content",
    "rent_fulfillment",
    "invoice",
    "desk",
    "events",
  ],
  description: message(
    "Help the workspace operator manage paid membership terms and a useful customer member portal.",
    {
      nl: "Help de werkplekbeheerder betaalde lidmaatschapstermijnen en een nuttig klantenportaal te beheren.",
    },
  ),
  packages: {
    member_plans: {
      description: message(
        "Publish shared membership benefits without making customers administrators.",
        {
          nl: "Publiceer gedeelde lidmaatschapsvoordelen zonder klanten beheerder te maken.",
        },
      ),
      roles: {
        plan_owner: {
          label: message("Plan owner", { nl: "Abonnementseigenaar" }),
          id: "member_plans.plan_owner",
        },
      },
    },
    member_terms: {
      label: message("Membership", { nl: "Lidmaatschap" }),
      description: message(
        "Own paid term snapshots, company seats and period-bound allowance allocations.",
        {
          nl: "Beheer vastgelegde betaalde termijnen, bedrijfsplaatsen en periodegebonden tegoedtoewijzingen.",
        },
      ),
      roles: {
        member_manager: {
          label: message("Membership manager", {
            nl: "Lidmaatschapsbeheerder",
          }),
          id: "member_terms.member_manager",
        },
        content_editor: {
          exported: true,
          label: message("Content editor", { nl: "Inhoudsredacteur" }),
          id: "member_terms.content_editor",
        },
      },
    },
    member_content: {
      description: message(
        "Serve member content under live entitlement, distinct from staff procedures.",
        {
          nl: "Bied ledeninhoud aan onder een actueel recht, gescheiden van personeelsprocedures.",
        },
      ),
    },
  },
  // Every operation the Then composition invokes, with its Given/When label
  // and inputs preserved; guards and effects stay on the compiler path.
  operations: {
    "member_plans.Plan.create": {
      kind: "create",
      model: "member_plans.Plan",
      by: "member_plans.plan_owner",
      inputs: {
        fields: [
          "name",
          "price",
          "months",
          "locations",
          "products",
          "access_hours",
          "mail",
          "guest_limit",
          "seats",
          "active",
        ],
      },
    },
    "member_plans.Plan.update": {
      kind: "update",
      model: "member_plans.Plan",
      by: "member_plans.plan_owner",
      inputs: {
        record: { type: "member_plans.Plan" },
        changes: {
          fields: [
            "name",
            "price",
            "months",
            "locations",
            "products",
            "access_hours",
            "mail",
            "guest_limit",
            "seats",
            "active",
          ],
        },
      },
    },
    "member_plans.AccessHours.create": {
      kind: "create",
      model: "member_plans.AccessHours",
      by: "member_plans.plan_owner",
      inputs: {
        fields: ["location", "weekdays", "opens", "closes", "close_after", "fold"],
      },
    },
    "member_plans.AccessHours.update": {
      kind: "update",
      model: "member_plans.AccessHours",
      by: "member_plans.plan_owner",
      inputs: {
        record: { type: "member_plans.AccessHours" },
        changes: {
          fields: [
            "location",
            "weekdays",
            "opens",
            "closes",
            "close_after",
            "fold",
          ],
        },
      },
    },
    "member_plans.Benefit.create": {
      kind: "create",
      model: "member_plans.Benefit",
      by: "member_plans.plan_owner",
      inputs: {
        fields: ["product", "unit", "quantity", "duration", "overage"],
      },
    },
    "member_plans.Benefit.update": {
      kind: "update",
      model: "member_plans.Benefit",
      by: "member_plans.plan_owner",
      inputs: {
        record: { type: "member_plans.Benefit" },
        changes: {
          fields: ["product", "unit", "quantity", "duration", "overage"],
        },
      },
    },
    "member_terms.term": {
      label: message("Paid term", { nl: "Betaalde termijn" }),
      inputs: {
        membership: { type: "member_terms.Membership" },
        cycle: {
          type: "int",
          label: message("Billing cycle", { nl: "Facturatiecyclus" }),
        },
        capture: { type: "sales_attribution.Capture", nullable: true },
      },
    },
    "member_terms.consent": {
      label: message("Recurrence consent", { nl: "Toestemming voor herhaling" }),
      inputs: {
        membership: { type: "member_terms.Membership" },
        enabled: { type: "bool" },
        reference: {
          type: "text",
          nullable: true,
          label: message("Recurrence consent", {
            nl: "Toestemming voor herhaling",
          }),
        },
      },
    },
    "member_terms.cancel_membership": {
      label: message("Request membership cancellation", {
        nl: "Annulering lidmaatschap aanvragen",
      }),
      inputs: {
        membership: { type: "member_terms.Membership" },
        effective: {
          type: "datetime",
          label: message("Cancellation effective date", {
            nl: "Ingangsdatum annulering",
          }),
        },
        reason: { type: "text" },
      },
    },
    "member_terms.retry_renewal": {
      label: message("Retry renewal generation", {
        nl: "Verlengingsgeneratie opnieuw proberen",
      }),
      inputs: {
        renewal: { type: "member_terms.Renewal" },
      },
    },
    "member_terms.assign": {
      inputs: {
        term: { type: "member_terms.Term" },
        account: {
          type: "user",
          label: message("Account", { nl: "Account" }),
        },
      },
    },
    "member_terms.remove": {
      label: message("Remove seat", { nl: "Plaats intrekken" }),
      inputs: {
        seat: { type: "member_terms.Seat" },
        reason: { type: "text" },
      },
    },
    "member_terms.pause": {
      inputs: {
        membership: { type: "member_terms.Membership" },
        reason: { type: "text" },
      },
    },
    "member_terms.resume": {
      inputs: {
        membership: { type: "member_terms.Membership" },
      },
    },
    "member_terms.revoke": {
      label: message("Revoke benefits", { nl: "Voordelen intrekken" }),
      inputs: {
        membership: { type: "member_terms.Membership" },
        reason: { type: "text" },
      },
    },
    "member_terms.refund_term": {
      label: message("Apply term refund policy", {
        nl: "Terugbetalingsbeleid termijn toepassen",
      }),
      inputs: {
        term: { type: "member_terms.Term" },
        amount: { type: "money" },
        revoke_access: {
          type: "bool",
          label: message("Revoke access", { nl: "Toegang intrekken" }),
        },
        reason: { type: "text" },
      },
    },
    "member_terms.retry_collection": {
      label: message("Retry term invoice", {
        nl: "Termijnfactuur opnieuw proberen",
      }),
      inputs: {
        term: { type: "member_terms.Term" },
      },
    },
    "member_terms.access_review": {
      label: message("Inspect membership access review", {
        nl: "Beoordeel lidmaatschapstoegang",
      }),
      read: true,
      result: { type: "member_terms.MembershipAccessReview" },
      inputs: {
        customer: { type: "customer.Customer" },
        location: { type: "rent_catalog.Location" },
      },
    },
    "member_terms.recheck_access": {
      label: message("Recheck membership access", {
        nl: "Controleer lidmaatschapstoegang opnieuw",
      }),
      inputs: {
        customer: { type: "customer.Customer" },
        location: { type: "rent_catalog.Location" },
      },
    },
    "member_terms.Content.create": {
      kind: "create",
      model: "member_terms.Content",
      by: "member_terms.content_editor",
      inputs: {
        fields: [
          "title",
          "category",
          "body",
          "locations",
          "plans",
          "published",
          "attachment",
        ],
      },
    },
    "member_terms.Content.update": {
      kind: "update",
      model: "member_terms.Content",
      by: "member_terms.content_editor",
      inputs: {
        record: { type: "member_terms.Content" },
        changes: {
          fields: [
            "title",
            "category",
            "body",
            "locations",
            "plans",
            "published",
            "attachment",
          ],
        },
      },
    },
  },
  pages: [
    plansDescriptor,
    accessReviewDescriptor,
    companyAccessDescriptor,
    myMembershipDescriptor,
    registerDescriptor,
    contentEditDescriptor,
    contentDescriptor,
  ],
};

export async function plansPage(c, bindings) {
  return renderPage(c, plansDescriptor, () => [
    breadcrumbs({ context: c }),
    card({
      context: c,
      title: message("Plan catalog", { nl: "Abonnementscatalogus" }),
      children: [
        form({
          context: c,
          operation: "member_plans.Plan.create",
          children: [
            fieldset({
              context: c,
              children: [
                input({ context: c, field: "name" }),
                input({ context: c, field: "price" }),
                input({ context: c, field: "months" }),
                textarea({ context: c, field: "access_hours" }),
                checkbox({ context: c, field: "mail" }),
                input({ context: c, field: "guest_limit" }),
                input({ context: c, field: "seats" }),
                checkbox({ context: c, field: "active" }),
              ],
            }),
          ],
        }),
      ],
    }),
    card({
      context: c,
      title: message("Benefits and units", { nl: "Voordelen en eenheden" }),
      children: [
        list({
          context: c,
          model: "member_plans.Plan",
          filter: ["active"],
          defaults: { active: c.preferences.member_plans.active_filter },
          empty: message("No membership plans match this filter", {
            nl: "Geen lidmaatschapsabonnementen voldoen aan dit filter",
          }),
          display: "split",
          renderRow: (plan, planView) => [
            edit({
              context: planView,
              operation: "member_plans.Plan.update",
              record: plan,
            }),
            form({
              context: planView,
              operation: "member_plans.AccessHours.create",
              arguments: { parent: plan },
              children: [
                fieldset({
                  context: planView,
                  children: [
                    select({ context: planView, field: "location" }),
                    input({ context: planView, field: "opens" }),
                    input({ context: planView, field: "closes" }),
                    input({ context: planView, field: "close_after" }),
                    radio({ context: planView, field: "fold" }),
                  ],
                }),
              ],
            }),
            table({
              context: planView,
              model: "member_plans.AccessHours",
              parent: plan,
              columns: [
                "location",
                "weekdays",
                "opens",
                "closes",
                "close_after",
                "fold",
              ],
              empty: message("No access hours for this plan", {
                nl: "Geen toegangsuren voor dit abonnement",
              }),
              renderRow: (hours, hoursView) => [
                edit({
                  context: hoursView,
                  operation: "member_plans.AccessHours.update",
                  record: hours,
                }),
                pagination({ context: hoursView }),
              ],
            }),
            form({
              context: planView,
              operation: "member_plans.Benefit.create",
              arguments: { parent: plan },
              children: [
                fieldset({
                  context: planView,
                  children: [
                    input({ context: planView, field: "product" }),
                    radio({ context: planView, field: "unit" }),
                    input({ context: planView, field: "quantity" }),
                    input({ context: planView, field: "duration" }),
                    input({ context: planView, field: "overage" }),
                  ],
                }),
              ],
            }),
            table({
              context: planView,
              model: "member_plans.Benefit",
              parent: plan,
              columns: ["product", "unit", "quantity", "duration", "overage"],
              empty: message("No benefits for this plan", {
                nl: "Geen voordelen voor dit abonnement",
              }),
              renderRow: (benefit, benefitView) => [
                edit({
                  context: benefitView,
                  operation: "member_plans.Benefit.update",
                  record: benefit,
                }),
                pagination({ context: benefitView }),
              ],
            }),
            history({ context: planView, record: plan }),
            pagination({ context: planView }),
          ],
        }),
      ],
    }),
  ]);
}

export async function accessReviewPage(c, bindings) {
  return renderPage(c, accessReviewDescriptor, () => [
    breadcrumbs({ context: c }),
    card({
      context: c,
      title: message("Current seat and allowance review", {
        nl: "Huidige plaats- en tegoedbeoordeling",
      }),
      children: [
        form({
          context: c,
          operation: "member_terms.access_review",
          renderResult: (result, resultView) => [
            text({
              context: resultView,
              values: [
                result.seats_needing_review,
                result.requests_needing_review,
                result.pending_reviews,
                result.recorded_conflicts,
              ],
            }),
          ],
        }),
        form({ context: c, operation: "member_terms.recheck_access" }),
      ],
    }),
  ]);
}

export async function companyAccessPage(c, bindings) {
  const company = bindings.row;
  return renderPage(c, companyAccessDescriptor, () => [
    breadcrumbs({ context: c }),
    card({
      context: c,
      title: message("Current seat and allowance review", {
        nl: "Huidige plaats- en tegoedbeoordeling",
      }),
      children: [
        form({
          context: c,
          operation: "member_terms.access_review",
          renderResult: (result, resultView) => [
            text({
              context: resultView,
              values: [
                result.seats_needing_review,
                result.requests_needing_review,
                result.pending_reviews,
                result.recorded_conflicts,
              ],
            }),
          ],
        }),
        form({ context: c, operation: "member_terms.recheck_access" }),
      ],
    }),
    card({
      context: c,
      title: message("Paid terms and explicit seat decisions", {
        nl: "Betaalde termijnen en expliciete plaatsbesluiten",
      }),
      children: [
        list({
          context: c,
          model: "member_terms.Membership",
          where: (membership) => same(membership.parent, company),
          empty: message("No memberships for this company", {
            nl: "Geen lidmaatschappen voor dit bedrijf",
          }),
          renderRow: (membership, membershipView) => [
            text({
              context: membershipView,
              values: [membership.paused, membership.revoked],
            }),
            list({
              context: membershipView,
              model: "member_terms.Term",
              parent: membership,
              empty: message("No paid terms for this membership", {
                nl: "Geen betaalde termijnen voor dit lidmaatschap",
              }),
              renderRow: (term, termView) => [
                badge({ context: termView, value: term.collection }),
                badge({ context: termView, value: term.cancellation }),
                text({
                  context: termView,
                  values: [term.paid, term.from, term.until, term.price],
                }),
                copy({ context: termView, value: term.source }),
                form({
                  context: termView,
                  operation: "member_terms.assign",
                  arguments: { term },
                }),
                table({
                  context: termView,
                  model: "member_terms.Seat",
                  parent: term,
                  columns: ["account", "active", "removed_reason"],
                  empty: message("No seats assigned for this term", {
                    nl: "Geen plaatsen toegewezen voor deze termijn",
                  }),
                  renderRow: (seat, seatView) => [
                    button({ context: seatView, opens: "seat_remove_company" }),
                    modal({
                      context: seatView,
                      caption: message("Remove seat", { nl: "Plaats intrekken" }),
                      id: "seat_remove_company",
                      children: [
                        slot({
                          context: seatView,
                          name: "content",
                          children: [
                            form({
                              context: seatView,
                              operation: "member_terms.remove",
                              arguments: { seat },
                              display: "inline",
                              children: [
                                fieldset({
                                  context: seatView,
                                  children: [
                                    textarea({
                                      context: seatView,
                                      field: "reason",
                                    }),
                                  ],
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                    pagination({ context: seatView }),
                  ],
                }),
                pagination({ context: termView }),
              ],
            }),
            table({
              context: membershipView,
              model: "member_terms.BenefitRequest",
              parent: membership.parent,
              columns: ["source", "state", "review_reason"],
              empty: message("No benefit requests for this company", {
                nl: "Geen voordeelaanvragen voor dit bedrijf",
              }),
              renderRow: (request, requestView) => [
                pagination({ context: requestView }),
              ],
            }),
            pagination({ context: membershipView }),
          ],
        }),
      ],
    }),
  ]);
}

export async function myMembershipPage(c, bindings) {
  return renderPage(c, myMembershipDescriptor, () => [
    breadcrumbs({ context: c }),
    // The preferences panel dissolves into its placed view-setting controls.
    toggle({ context: c, field: "current_only" }),
    card({
      context: c,
      title: message("Own membership and consent", {
        nl: "Eigen lidmaatschap en toestemming",
      }),
      children: [
        list({
          context: c,
          model: "member_terms.Membership",
          empty: message("No memberships for your account", {
            nl: "Geen lidmaatschappen voor je account",
          }),
          display: "split",
          renderRow: (membership, membershipView) => [
            text({
              context: membershipView,
              values: [membership.paused, membership.revoked],
            }),
            form({
              context: membershipView,
              operation: "member_terms.consent",
              arguments: { membership },
              children: [
                fieldset({
                  context: membershipView,
                  children: [
                    checkbox({ context: membershipView, field: "enabled" }),
                    input({ context: membershipView, field: "reference" }),
                  ],
                }),
              ],
            }),
            form({
              context: membershipView,
              operation: "member_terms.term",
              arguments: { membership },
            }),
            button({ context: membershipView, opens: "membership_cancel" }),
            modal({
              context: membershipView,
              caption: message("Request membership cancellation", {
                nl: "Annulering lidmaatschap aanvragen",
              }),
              id: "membership_cancel",
              children: [
                slot({
                  context: membershipView,
                  name: "content",
                  children: [
                    form({
                      context: membershipView,
                      operation: "member_terms.cancel_membership",
                      arguments: { membership },
                      display: "inline",
                      children: [
                        fieldset({
                          context: membershipView,
                          children: [
                            input({ context: membershipView, field: "effective" }),
                            textarea({
                              context: membershipView,
                              field: "reason",
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
              context: membershipView,
              model: "member_terms.Renewal",
              parent: membership,
              columns: ["cycle", "state", "term"],
              empty: message("No renewal requests for this membership", {
                nl: "Geen verlengingsaanvragen voor dit lidmaatschap",
              }),
              renderRow: (renewal, renewalView) => [
                tooltip({
                  context: renewalView,
                  caption: message("Retry renewal", {
                    nl: "Verlenging opnieuw proberen",
                  }),
                  children: [
                    action({
                      context: renewalView,
                      operation: "member_terms.retry_renewal",
                      boundArgs: { renewal },
                    }),
                  ],
                }),
                pagination({ context: renewalView }),
              ],
            }),
            list({
              context: membershipView,
              model: "member_terms.Term",
              parent: membership,
              where: (term) => termVisible(term, c),
              empty: message("No terms in this view", {
                nl: "Geen termijnen in deze weergave",
              }),
              renderRow: (term, termView) => [
                badge({ context: termView, value: term.collection }),
                badge({ context: termView, value: term.cancellation }),
                badge({ context: termView, value: term.refund_access }),
                text({
                  context: termView,
                  values: [
                    term.paid,
                    term.mail,
                    term.from,
                    term.until,
                    term.invoice,
                  ],
                }),
                stat({ context: termView, values: [term.price, term.seats] }),
                copy({ context: termView, value: term.source }),
                actions({
                  context: termView,
                  operations: ["member_terms.retry_collection"],
                  boundArgs: { term },
                }),
                button({ context: termView, opens: "term_refund_mine" }),
                modal({
                  context: termView,
                  caption: message("Apply term refund policy", {
                    nl: "Terugbetalingsbeleid termijn toepassen",
                  }),
                  id: "term_refund_mine",
                  children: [
                    slot({
                      context: termView,
                      name: "content",
                      children: [
                        form({
                          context: termView,
                          operation: "member_terms.refund_term",
                          arguments: { term },
                          display: "inline",
                          children: [
                            fieldset({
                              context: termView,
                              children: [
                                input({ context: termView, field: "amount" }),
                                checkbox({
                                  context: termView,
                                  field: "revoke_access",
                                }),
                                textarea({
                                  context: termView,
                                  field: "reason",
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                tabs({
                  context: termView,
                  children: [
                    tab({
                      context: termView,
                      caption: message("Term seats", { nl: "Termijnplaatsen" }),
                      children: [
                        form({
                          context: termView,
                          operation: "member_terms.assign",
                          arguments: { term },
                        }),
                        list({
                          context: termView,
                          model: "member_terms.Seat",
                          parent: term,
                          empty: message("No seats assigned for this term", {
                            nl: "Geen plaatsen toegewezen voor deze termijn",
                          }),
                          renderRow: (seat, seatView) => [
                            button({
                              context: seatView,
                              opens: "seat_remove_mine",
                            }),
                            modal({
                              context: seatView,
                              caption: message("Remove seat", {
                                nl: "Plaats intrekken",
                              }),
                              id: "seat_remove_mine",
                              children: [
                                slot({
                                  context: seatView,
                                  name: "content",
                                  children: [
                                    form({
                                      context: seatView,
                                      operation: "member_terms.remove",
                                      arguments: { seat },
                                      display: "inline",
                                      children: [
                                        fieldset({
                                          context: seatView,
                                          children: [
                                            textarea({
                                              context: seatView,
                                              field: "reason",
                                            }),
                                          ],
                                        }),
                                      ],
                                    }),
                                  ],
                                }),
                              ],
                            }),
                            pagination({ context: seatView }),
                          ],
                        }),
                      ],
                    }),
                    tab({
                      context: termView,
                      caption: message("Allowance allocations", {
                        nl: "Tegoedtoewijzingen",
                      }),
                      children: [
                        list({
                          context: termView,
                          model: "member_terms.Allowance",
                          parent: term,
                          empty: message("No allowances in this term", {
                            nl: "Geen tegoeden in deze termijn",
                          }),
                          renderRow: (allowance, allowanceView) => [
                            badge({
                              context: allowanceView,
                              value: allowance.unit,
                            }),
                            stat({
                              context: allowanceView,
                              values: [
                                allowance.granted,
                                allowance.available,
                                allowance.reserved,
                                allowance.consumed,
                                allowance.expired,
                              ],
                            }),
                            text({
                              context: allowanceView,
                              values: [
                                allowance.product,
                                allowance.overage,
                                allowance.from,
                                allowance.until,
                              ],
                            }),
                            table({
                              context: allowanceView,
                              model: "member_terms.Allocation",
                              parent: allowance,
                              columns: ["from", "until", "units", "held", "state"],
                              empty: message(
                                "No allocations for this allowance",
                                {
                                  nl: "Geen toewijzingen voor dit tegoed",
                                },
                              ),
                              renderRow: (allocation, allocationView) => [
                                pagination({ context: allocationView }),
                              ],
                            }),
                            pagination({ context: allowanceView }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
                pagination({ context: termView }),
              ],
            }),
            table({
              context: membershipView,
              model: "member_terms.BenefitRequest",
              parent: membership.parent,
              columns: [
                "source",
                "units",
                "covered_units",
                "overage",
                "state",
                "review_reason",
              ],
              empty: message("No benefit requests for this account", {
                nl: "Geen voordeelaanvragen voor dit account",
              }),
              renderRow: (request, requestView) => [
                pagination({ context: requestView }),
              ],
            }),
            history({ context: membershipView, record: membership }),
            pagination({ context: membershipView }),
          ],
        }),
      ],
    }),
  ]);
}

export async function registerPage(c, bindings) {
  return renderPage(c, registerDescriptor, () => [
    breadcrumbs({ context: c }),
    alert({
      context: c,
      value: message("Allowances reconcile per period", {
        nl: "Tegoeden worden per periode afgestemd",
      }),
    }),
    // The preferences panel dissolves into its placed view-setting controls.
    toggle({ context: c, field: "current_only" }),
    card({
      context: c,
      title: message("Membership register", { nl: "Lidmaatschapsregister" }),
      children: [
        list({
          context: c,
          model: "member_terms.Membership",
          empty: message("No memberships match this view", {
            nl: "Geen lidmaatschappen in deze weergave",
          }),
          display: "split",
          renderRow: (membership, membershipView) => [
            text({
              context: membershipView,
              values: [membership.paused, membership.revoked],
            }),
            form({
              context: membershipView,
              operation: "member_terms.term",
              arguments: { membership },
            }),
            actions({
              context: membershipView,
              operations: ["member_terms.resume"],
              boundArgs: { membership },
            }),
            join({
              context: membershipView,
              children: [
                button({ context: membershipView, opens: "membership_pause" }),
                button({ context: membershipView, opens: "membership_revoke" }),
              ],
            }),
            modal({
              context: membershipView,
              caption: message("Pause", { nl: "Pauzeren" }),
              id: "membership_pause",
              children: [
                slot({
                  context: membershipView,
                  name: "content",
                  children: [
                    form({
                      context: membershipView,
                      operation: "member_terms.pause",
                      arguments: { membership },
                      display: "inline",
                      children: [
                        fieldset({
                          context: membershipView,
                          children: [
                            textarea({
                              context: membershipView,
                              field: "reason",
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
            modal({
              context: membershipView,
              caption: message("Revoke benefits", { nl: "Voordelen intrekken" }),
              id: "membership_revoke",
              children: [
                slot({
                  context: membershipView,
                  name: "content",
                  children: [
                    form({
                      context: membershipView,
                      operation: "member_terms.revoke",
                      arguments: { membership },
                      display: "inline",
                      children: [
                        fieldset({
                          context: membershipView,
                          children: [
                            textarea({
                              context: membershipView,
                              field: "reason",
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
              context: membershipView,
              model: "member_terms.Renewal",
              parent: membership,
              columns: ["cycle", "state", "term"],
              empty: message("No renewal requests for this membership", {
                nl: "Geen verlengingsaanvragen voor dit lidmaatschap",
              }),
              renderRow: (renewal, renewalView) => [
                tooltip({
                  context: renewalView,
                  caption: message("Retry renewal", {
                    nl: "Verlenging opnieuw proberen",
                  }),
                  children: [
                    action({
                      context: renewalView,
                      operation: "member_terms.retry_renewal",
                      boundArgs: { renewal },
                    }),
                  ],
                }),
                pagination({ context: renewalView }),
              ],
            }),
            table({
              context: membershipView,
              model: "member_terms.BenefitRequest",
              parent: membership.parent,
              columns: [
                "source",
                "units",
                "covered_units",
                "overage",
                "state",
                "review_reason",
              ],
              empty: message("No benefit requests for this customer", {
                nl: "Geen voordeelaanvragen voor deze klant",
              }),
              renderRow: (request, requestView) => [
                pagination({ context: requestView }),
              ],
            }),
            list({
              context: membershipView,
              model: "member_terms.Term",
              parent: membership,
              where: (term) => termVisible(term, c),
              empty: message("No terms in this view", {
                nl: "Geen termijnen in deze weergave",
              }),
              renderRow: (term, termView) => [
                badge({ context: termView, value: term.collection }),
                badge({ context: termView, value: term.cancellation }),
                badge({ context: termView, value: term.refund_access }),
                text({
                  context: termView,
                  values: [term.paid, term.from, term.until, term.invoice],
                }),
                stat({ context: termView, values: [term.price, term.seats] }),
                copy({ context: termView, value: term.source }),
                actions({
                  context: termView,
                  operations: ["member_terms.retry_collection"],
                  boundArgs: { term },
                }),
                button({ context: termView, opens: "term_refund_register" }),
                modal({
                  context: termView,
                  caption: message("Apply term refund policy", {
                    nl: "Terugbetalingsbeleid termijn toepassen",
                  }),
                  id: "term_refund_register",
                  children: [
                    slot({
                      context: termView,
                      name: "content",
                      children: [
                        form({
                          context: termView,
                          operation: "member_terms.refund_term",
                          arguments: { term },
                          display: "inline",
                          children: [
                            fieldset({
                              context: termView,
                              children: [
                                input({ context: termView, field: "amount" }),
                                checkbox({
                                  context: termView,
                                  field: "revoke_access",
                                }),
                                textarea({
                                  context: termView,
                                  field: "reason",
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
                  context: termView,
                  model: "member_terms.Allowance",
                  parent: term,
                  columns: [
                    "product",
                    "unit",
                    "granted",
                    "available",
                    "reserved",
                    "consumed",
                    "expired",
                    "overage",
                    "from",
                    "until",
                  ],
                  empty: message("No allowances in this term", {
                    nl: "Geen tegoeden in deze termijn",
                  }),
                  renderRow: (allowance, allowanceView) => [
                    pagination({ context: allowanceView }),
                  ],
                }),
                table({
                  context: termView,
                  model: "member_terms.Seat",
                  parent: term,
                  columns: ["account", "active", "removed_reason"],
                  empty: message("No seats assigned for this term", {
                    nl: "Geen plaatsen toegewezen voor deze termijn",
                  }),
                  renderRow: (seat, seatView) => [
                    button({ context: seatView, opens: "seat_remove_register" }),
                    modal({
                      context: seatView,
                      caption: message("Remove seat", { nl: "Plaats intrekken" }),
                      id: "seat_remove_register",
                      children: [
                        slot({
                          context: seatView,
                          name: "content",
                          children: [
                            form({
                              context: seatView,
                              operation: "member_terms.remove",
                              arguments: { seat },
                              display: "inline",
                              children: [
                                fieldset({
                                  context: seatView,
                                  children: [
                                    textarea({
                                      context: seatView,
                                      field: "reason",
                                    }),
                                  ],
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),
                    pagination({ context: seatView }),
                  ],
                }),
                form({
                  context: termView,
                  operation: "member_terms.assign",
                  arguments: { term },
                }),
                history({ context: termView, record: term }),
                pagination({ context: termView }),
              ],
            }),
            pagination({ context: membershipView }),
          ],
        }),
      ],
    }),
  ]);
}

export async function contentEditPage(c, bindings) {
  return renderPage(c, contentEditDescriptor, () => [
    breadcrumbs({ context: c }),
    form({
      context: c,
      operation: "member_terms.Content.create",
      children: [
        fieldset({
          context: c,
          children: [
            input({ context: c, field: "title" }),
            input({ context: c, field: "category" }),
            textarea({ context: c, field: "body" }),
            checkbox({ context: c, field: "published" }),
            file_input({ context: c, field: "attachment" }),
            checkbox({ context: c, field: "staff_only" }),
          ],
        }),
      ],
    }),
    list({
      context: c,
      model: "member_terms.Content",
      empty: message("No member information yet", {
        nl: "Nog geen ledeninformatie",
      }),
      display: "split",
      renderRow: (guide, guideView) => [
        text({ context: guideView, values: [guide.published] }),
        edit({
          context: guideView,
          operation: "member_terms.Content.update",
          record: guide,
        }),
        history({ context: guideView, record: guide }),
        pagination({ context: guideView }),
      ],
    }),
  ]);
}

export async function contentPage(c, bindings) {
  return renderPage(c, contentDescriptor, () => [
    breadcrumbs({ context: c }),
    card({
      context: c,
      title: message("Authorized member information", {
        nl: "Geautoriseerde ledeninformatie",
      }),
      children: [
        list({
          context: c,
          model: "member_terms.Content",
          empty: message("No member information available", {
            nl: "Geen ledeninformatie beschikbaar",
          }),
          renderRow: (guide, guideView) => [
            title({ context: guideView, value: guide.title }),
            content({ context: guideView, values: [guide.body] }),
            ...(guide.attachment !== null
              ? [
                  card({
                    context: guideView,
                    children: [
                      link({
                        context: guideView,
                        target: guide.attachment,
                        caption: message("Member document", {
                          nl: "Ledendocument",
                        }),
                      }),
                    ],
                  }),
                ]
              : []),
            pagination({ context: guideView }),
          ],
        }),
      ],
    }),
  ]);
}
