import { any, compareInstant, hasRole, local_date, records, require as check } from "@canlang/stdlib";
import {
  actions,
  alert, // desired/unimplemented
  badge, // desired/unimplemented
  breadcrumbs, // desired/unimplemented
  button, // desired/unimplemented
  card,
  checkbox, // desired/unimplemented
  collapse, // desired/unimplemented
  drawer, // desired/unimplemented
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
  select, // desired/unimplemented
  slot, // desired/unimplemented
  stat, // desired/unimplemented
  status, // desired/unimplemented
  table,
  tabs,
  text,
  textarea, // desired/unimplemented
} from "@canlang/ui";
import { has_role } from "./customer.mjs";
import { can_work } from "./employee.mjs";

/* Handwritten desired target; every import is a proposed, unimplemented contract.
 * See DESIGN §13. This file founds the CanReception witness as a Then-only slice:
 * Given/When business lowering is absent (no CanReception.mjs exists at base) and
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
 * readable own-enum value; status presents one readable nullable delivery value.
 * stat shares the typed metric contract, including read-form result scope.
 * drawer declares a local activation identity opened by an external button
 * opens=; collapse shares the details disclosure contract. This file passes
 * node --check (syntax only) and never runs.
 */

const outcomesCaption = message("Current admission and credential outcomes", {
  nl: "Huidige toelatings- en sleutelresultaten",
});

const reviewFields = [
  "admission_conflicts",
  "admission_pending",
  "on_site_review",
  "revoke_needed",
  "revoke_pending",
  "revoke_failed",
  "revoke_unknown",
  "revoke_conflicts",
  "revoke_confirmed",
];

const accessReviewPageDescriptor = {
  owner: "reception",
  path: "/reception/access-review",
  title: message("Reception access review", { nl: "Beoordeling receptietoegang" }),
  description: message("Discover safe owner review without mounting private reception work in Customer."),
  admit: async (c, routeBindings = {}) => {
    check(
      hasRole(c, "reception.receptionist") ||
        hasRole(c, "reception.access_staff") ||
        (await any(records(c, "customer.Customer"), (customer) =>
          has_role(c, c.actor, customer, "administrator"),
        )),
      "forbidden",
    );
    return {};
  },
  render: accessReviewPage,
};

const companyAccessPageDescriptor = {
  owner: "reception",
  path: "/companies/{Customer.id}/reception-access",
  title: message("Company reception access", { nl: "Bedrijfsreceptietoegang" }),
  description: message(
    "Customer administrators inspect only safe owner outcomes; raw visitor and credential work retains staff grants.",
  ),
  admit: async (c, routeBindings = {}) => {
    const row = routeBindings.Customer;
    check(
      (await has_role(c, c.actor, row, "administrator")) ||
        ((hasRole(c, "reception.receptionist") || hasRole(c, "reception.access_staff")) &&
          (await any(row.locations, (location) => can_work(c, c.actor, location)))),
      "forbidden",
    );
    return { row };
  },
  render: companyAccessPage,
};

const receptionPageDescriptor = {
  owner: "reception",
  path: "/reception",
  title: message("Reception", { nl: "Receptie" }),
  description: message("Record expected guests, on-site evidence and unresolved departures.", {
    nl: "Registreer verwachte gasten, aanwezigheidsbewijs en onopgeloste vertrekken.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "reception.receptionist"), "forbidden");
    return {};
  },
  render: receptionPage,
};

const credentialsPageDescriptor = {
  owner: "reception",
  path: "/reception/credentials",
  title: message("Keys and cards", { nl: "Sleutels en kaarten" }),
  description: message("Track physical issue, return, loss and device uncertainty separately.", {
    nl: "Volg fysieke uitgifte, teruggave, verlies en apparaatonzekerheid afzonderlijk.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "reception.access_staff"), "forbidden");
    return {};
  },
  render: credentialsPage,
};

const minePageDescriptor = {
  owner: "reception",
  path: "/reception/mine",
  title: message("My visitors", { nl: "Mijn bezoekers" }),
  description: message("See only your invitations and current arrival instructions.", {
    nl: "Bekijk uitsluitend je eigen uitnodigingen en huidige aankomstinstructies.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: minePage,
};

export async function accessReviewPage(c, bindings) {
  return renderPage(
    c,
    accessReviewPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: outcomesCaption,
        children: [
          form({
            context: c,
            operation: "reception.access_review",
            renderResult: (result, view) => [
              stat({ context: view, result, fields: reviewFields }),
            ],
          }),
          form({ context: c, operation: "reception.recheck_access" }),
        ],
      }),
    ],
  );
}

export async function companyAccessPage(c, bindings) {
  const { row } = bindings;
  return renderPage(
    c,
    companyAccessPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: outcomesCaption,
        children: [
          form({
            context: c,
            operation: "reception.access_review",
            arguments: { customer: row },
            renderResult: (result, view) => [
              stat({ context: view, result, fields: reviewFields }),
            ],
          }),
          form({
            context: c,
            operation: "reception.recheck_access",
            arguments: { customer: row },
          }),
          text({
            context: c,
            values: [
              message(
                "Reception resolves guest admission and departure. Access staff records physical return or manual revocation and reconciles or retries uncertain device results.",
                {
                  nl: "Receptie behandelt gasttoelating en vertrek. Toegangsmedewerkers leggen fysieke retour of handmatige intrekking vast en controleren of herhalen onzekere apparaatresultaten.",
                },
              ),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function receptionPage(c, bindings) {
  return renderPage(
    c,
    receptionPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Host presence", { nl: "Aanwezigheid gastheer" }),
        children: [
          form({
            context: c,
            operation: "reception.host_arrived",
            children: [
              fieldset({
                context: c,
                caption: message("Host presence", { nl: "Aanwezigheid gastheer" }),
                children: [
                  input({ context: c, field: "until" }),
                  textarea({ context: c, field: "evidence" }),
                ],
              }),
            ],
          }),
          table({
            context: c,
            model: "reception.HostPresence",
            columns: ["location", "account", "from", "until", "ended"],
            empty: message("No host presence recorded.", { nl: "Geen aanwezigheid vastgelegd." }),
            renderRow: (presence, view) => [
              pagination({ context: view }),
              actions({
                context: view,
                operations: ["reception.host_departed"],
                boundArgs: { presence },
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Expected and on-site visits", { nl: "Verwachte en aanwezige bezoekers" }),
        children: [
          tabs({
            context: c,
            selector: "reception.queue",
            value: c.preferences.reception.queue,
          }),
          table({
            context: c,
            model: "reception.Visit",
            where: (visit) =>
              c.preferences.reception.queue === "all" ||
              (c.preferences.reception.queue === "expected" && visit.state === "expected") ||
              (c.preferences.reception.queue === "today" &&
                local_date(visit.from, c.team.timezone) ===
                  local_date(c.now, c.team.timezone)) ||
              (c.preferences.reception.queue === "on_site" &&
                visit.state === "arrived" &&
                visit.departed === null) ||
              (c.preferences.reception.queue === "overdue" &&
                visit.state === "arrived" &&
                compareInstant(visit.until, c.now) < 0),
            columns: ["location", "guest", "host", "from", "until", "state", "arrived", "departed"],
            order: ["from"],
            filter: ["location", "state"],
            search: ["purpose"],
            defaults: { location: c.preferences.reception.location },
            empty: message("No visits match this queue.", {
              nl: "Geen bezoekers voor deze wachtrij.",
            }),
            renderRow: (visit, view) => [
              pagination({ context: view }),
              badge({ context: view, value: visit.state }),
              status({ context: view, value: visit.notice_state }),
              button({ context: view, opens: "visit_detail" }),
              drawer({
                context: view,
                caption: message("Physical arrival and departure history", {
                  nl: "Geschiedenis van fysieke aankomst en vertrek",
                }),
                id: "visit_detail",
                children: [
                  slot({
                    context: view,
                    name: "content",
                    children: [
                      text({
                        context: view,
                        values: [
                          visit.purpose,
                          visit.identity_evidence,
                          visit.reason,
                          visit.eligibility?.eligible,
                          visit.eligibility?.until,
                          visit.eligibility?.checked_at,
                          visit.eligibility?.guest_limit,
                          visit.access_review,
                          visit.notice_state,
                        ],
                      }),
                      actions({
                        context: view,
                        operations: ["reception.refresh", "reception.resend"],
                        boundArgs: { visit },
                      }),
                      button({ context: view, opens: "arrive_detail" }),
                      modal({
                        context: view,
                        caption: message("Record arrival", { nl: "Aankomst registreren" }),
                        id: "arrive_detail",
                        children: [
                          slot({
                            context: view,
                            name: "content",
                            children: [
                              form({
                                context: view,
                                operation: "reception.arrive",
                                arguments: { visit },
                                display: "inline",
                                children: [textarea({ context: view, field: "evidence" })],
                              }),
                            ],
                          }),
                        ],
                      }),
                      button({ context: view, opens: "depart_detail" }),
                      modal({
                        context: view,
                        caption: message("Record departure", { nl: "Vertrek registreren" }),
                        id: "depart_detail",
                        children: [
                          slot({
                            context: view,
                            name: "content",
                            children: [
                              form({
                                context: view,
                                operation: "reception.depart",
                                arguments: { visit },
                                display: "inline",
                                children: [textarea({ context: view, field: "evidence" })],
                              }),
                            ],
                          }),
                        ],
                      }),
                      button({ context: view, opens: "refuse_detail" }),
                      modal({
                        context: view,
                        caption: message("Refuse arrival", { nl: "Toegang weigeren" }),
                        id: "refuse_detail",
                        children: [
                          slot({
                            context: view,
                            name: "content",
                            children: [
                              form({
                                context: view,
                                operation: "reception.refuse",
                                arguments: { visit },
                                display: "inline",
                                children: [textarea({ context: view, field: "reason" })],
                              }),
                            ],
                          }),
                        ],
                      }),
                      button({ context: view, opens: "cancel_detail" }),
                      modal({
                        context: view,
                        caption: message("Cancel visit", { nl: "Bezoek annuleren" }),
                        id: "cancel_detail",
                        children: [
                          slot({
                            context: view,
                            name: "content",
                            children: [
                              form({
                                context: view,
                                operation: "reception.cancel",
                                arguments: { visit },
                                display: "inline",
                                children: [textarea({ context: view, field: "reason" })],
                              }),
                            ],
                          }),
                        ],
                      }),
                      history({ context: view, record: visit }),
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

export async function credentialsPage(c, bindings) {
  return renderPage(
    c,
    credentialsPageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Visitor rules", { nl: "Bezoekersregels" }),
        children: [
          form({
            context: c,
            operation: "reception.GuestPolicy.create",
            children: [
              fieldset({
                context: c,
                caption: message("Visitor rules", { nl: "Bezoekersregels" }),
                children: [
                  checkbox({ context: c, field: "host_present" }),
                  input({ context: c, field: "visitor_days" }),
                  input({ context: c, field: "credential_days" }),
                ],
              }),
            ],
          }),
          list({
            context: c,
            model: "reception.GuestPolicy",
            empty: message("No visitor rules recorded.", {
              nl: "Geen bezoekersregels vastgelegd.",
            }),
            renderRow: (policy, view) => [
              pagination({ context: view }),
              edit({
                context: view,
                operation: "reception.GuestPolicy.update",
                record: policy,
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Credential catalog", { nl: "Toegangsmiddelenregister" }),
        children: [
          form({
            context: c,
            operation: "reception.Credential.create",
            children: [
              fieldset({
                context: c,
                caption: message("Credential catalog", { nl: "Toegangsmiddelenregister" }),
                children: [
                  input({ context: c, field: "identifier" }),
                  input({ context: c, field: "device" }),
                ],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Issue and device outcomes", { nl: "Uitgifte- en apparaatresultaten" }),
        children: [
          list({
            context: c,
            model: "reception.Credential",
            filter: ["location", "active"],
            defaults: { location: c.preferences.reception.location },
            display: "split",
            empty: message("No credentials recorded.", {
              nl: "Geen toegangsmiddelen vastgelegd.",
            }),
            renderRow: (credential, view) => [
              pagination({ context: view }),
              edit({
                context: view,
                operation: "reception.Credential.update",
                record: credential,
              }),
              form({
                context: view,
                operation: "reception.issue",
                arguments: { credential },
                children: [
                  select({ context: view, field: "visit" }),
                  input({ context: view, field: "holder" }),
                  textarea({ context: view, field: "evidence" }),
                ],
              }),
              table({
                context: view,
                model: "reception.Issue",
                parent: credential,
                columns: ["holder", "until", "desired", "confirmed", "returned", "lost_reason"],
                empty: message("No credential issues recorded.", {
                  nl: "Geen sleuteluitgiften vastgelegd.",
                }),
                renderRow: (issue, iv) => [
                  pagination({ context: iv }),
                  badge({ context: iv, value: issue.desired }),
                  badge({ context: iv, value: issue.confirmed }),
                  button({ context: iv, opens: "issue_detail" }),
                  drawer({
                    context: iv,
                    caption: message("Credential issue detail", {
                      nl: "Details sleuteluitgifte",
                    }),
                    id: "issue_detail",
                    children: [
                      slot({
                        context: iv,
                        name: "content",
                        children: [
                          text({
                            context: iv,
                            values: [
                              issue.visit,
                              issue.evidence,
                              issue.revoke_evidence,
                              issue.issued_by,
                            ],
                          }),
                          actions({
                            context: iv,
                            operations: [
                              "reception.reconcile_device",
                              "reception.retry_device",
                            ],
                            boundArgs: { issue },
                          }),
                          button({ context: iv, opens: "return_detail" }),
                          modal({
                            context: iv,
                            caption: message("Record credential return", {
                              nl: "Sleutelretour registreren",
                            }),
                            id: "return_detail",
                            children: [
                              slot({
                                context: iv,
                                name: "content",
                                children: [
                                  form({
                                    context: iv,
                                    operation: "reception.return_key",
                                    arguments: { issue },
                                    display: "inline",
                                    children: [
                                      textarea({ context: iv, field: "evidence" }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          button({ context: iv, opens: "lost_detail" }),
                          modal({
                            context: iv,
                            caption: message("Record lost credential", {
                              nl: "Verloren sleutel registreren",
                            }),
                            id: "lost_detail",
                            children: [
                              slot({
                                context: iv,
                                name: "content",
                                children: [
                                  form({
                                    context: iv,
                                    operation: "reception.lost",
                                    arguments: { issue },
                                    display: "inline",
                                    children: [textarea({ context: iv, field: "reason" })],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          button({ context: iv, opens: "revoke_detail" }),
                          modal({
                            context: iv,
                            caption: message("Record manual revocation", {
                              nl: "Handmatige intrekking registreren",
                            }),
                            id: "revoke_detail",
                            children: [
                              slot({
                                context: iv,
                                name: "content",
                                children: [
                                  form({
                                    context: iv,
                                    operation: "reception.manual_revoke",
                                    arguments: { issue },
                                    display: "inline",
                                    children: [
                                      textarea({ context: iv, field: "evidence" }),
                                    ],
                                  }),
                                ],
                              }),
                            ],
                          }),
                          history({ context: iv, record: issue }),
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

export async function minePage(c, bindings) {
  return renderPage(
    c,
    minePageDescriptor,
    () => [
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Own visitor invitations", { nl: "Eigen bezoekersuitnodigingen" }),
        children: [
          form({
            context: c,
            operation: "reception.invite",
            children: [
              textarea({ context: c, field: "purpose" }),
              input({ context: c, field: "source" }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Window and state", { nl: "Tijdvenster en status" }),
        children: [
          list({
            context: c,
            model: "reception.Visit",
            empty: message("No invitations yet.", { nl: "Nog geen uitnodigingen." }),
            renderRow: (visit, view) => [
              pagination({ context: view }),
              badge({ context: view, value: visit.state }),
              text({
                context: view,
                values: [
                  visit.location,
                  visit.guest,
                  visit.host,
                  visit.purpose,
                  visit.from,
                  visit.until,
                  visit.state,
                ],
              }),
              actions({
                context: view,
                operations: ["reception.refresh", "reception.resend"],
                boundArgs: { visit },
              }),
              button({ context: view, opens: "cancel_detail" }),
              modal({
                context: view,
                caption: message("Cancel visit", { nl: "Bezoek annuleren" }),
                id: "cancel_detail",
                children: [
                  slot({
                    context: view,
                    name: "content",
                    children: [
                      form({
                        context: view,
                        operation: "reception.cancel",
                        arguments: { visit },
                        display: "inline",
                        children: [textarea({ context: view, field: "reason" })],
                      }),
                    ],
                  }),
                ],
              }),
              text({ context: view, values: [visit.notice_state, visit.access_review] }),
              visit.notice_state === "failed"
                ? collapse({
                    context: view,
                    caption: message("Invitation delivery", { nl: "Uitnodigingsbezorging" }),
                    children: [alert({ context: view, value: visit.notice_state })],
                  })
                : null,
            ],
          }),
        ],
      }),
    ],
  );
}
