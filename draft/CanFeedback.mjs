import {
  any,
  require as check,
  compareInstant,
  count,
  create,
  deleteRecord,
  first,
  hasRole,
  records,
  same,
  set,
  subtractDuration,
  sum,
} from "@canlang/stdlib";
import {
  actions,
  card,
  content,
  delete as remove,
  details,
  edit,
  form,
  history,
  list,
  message,
  renderPage,
  table,
  text,
  title,
} from "@canlang/ui";
import { can_work } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";
import { open_request } from "./desk.mjs";

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

const suggestionCaption = message("Suggestion", { nl: "Suggestie" });

const statusCaption = message("Status", { nl: "Status" });

const hiddenCaption = message("Hidden", { nl: "Verborgen" });

const responseCaption = message("Staff response", { nl: "Antwoord medewerker" });

const duplicateCaption = message("Duplicate suggestion", { nl: "Dubbele suggestie" });

const feedbackPageDescriptor = {
  owner: "feedback",
  path: "/feedback",
  title: message("Suggestions", { nl: "Suggesties" }),
  description: message("Browse a public roadmap with counts that expose no voter records.", {
    nl: "Bekijk een openbare roadmap met aantallen die geen stemmerrecords blootgeven.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    return {};
  },
  render: feedbackPage,
};

const moderationPageDescriptor = {
  owner: "feedback",
  path: "/feedback/moderation",
  title: message("Moderation and roadmap", { nl: "Moderatie en roadmap" }),
  description: message("Moderate suggestions and record only authorized roadmap commitments.", {
    nl: "Modereer suggesties en leg uitsluitend toegestane roadmaptoezeggingen vast.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "feedback.product_owner"), "forbidden");
    return {};
  },
  render: moderationPage,
};

export const appDefinition = {
  id: "CanFeedback",
  uses: ["feedback"],
  description: message(
    "Help workspace members suggest improvements to facilities, amenities, and booking services and see the operator's response.",
    {
      nl: "Help werkplekleden verbeteringen voorstellen voor faciliteiten, voorzieningen en boekingsdiensten en het antwoord van de exploitant bekijken.",
    },
  ),
  packages: {
    feedback: {
      description: message(
        "Collect owned suggestions and votes while reserving moderation and roadmap decisions for product owners.",
        {
          nl: "Verzamel eigen suggesties en stemmen en reserveer moderatie en roadmapbesluiten voor productverantwoordelijken.",
        },
      ),
      roles: {
        product_owner: {
          id: "feedback.product_owner",
          label: message("Product owner", { nl: "Productverantwoordelijke" }),
        },
      },
    },
  },
  models: {
    "feedback.Product": {
      label: message("Product", { nl: "Product" }),
      readGrants: [{ rule: "Product.read.1" }, { rule: "Product.read.2" }],
      fields: {
        name: { type: "text" },
        location: { type: Location, nullable: true },
        owner: { type: "user", label: message("Responsible person", { nl: "Verantwoordelijke" }) },
        published: {
          type: "bool",
          default: true,
          label: message("Published", { nl: "Gepubliceerd" }),
        },
      },
    },
    "feedback.Suggestion": {
      parent: "feedback.Product",
      label: suggestionCaption,
      invariants: ["Suggestion.require.1", "Suggestion.require.2"],
      locks: ["Suggestion.lock.1"],
      readGrants: [
        {
          rule: "Suggestion.read.1",
          fields: ["title", "description", "category", "status", "response"],
        },
        { rule: "Suggestion.read.2" },
        { rule: "Suggestion.read.3" },
      ],
      fields: {
        title: { type: "text", trim: true, min: 1n, max: 300n },
        description: { type: "text", trim: true, min: 1n, max: 5000n },
        category: {
          type: "text",
          trim: true,
          min: 1n,
          max: 100n,
          label: message("Category", { nl: "Categorie" }),
        },
        author: { type: "user", server: "actor", label: message("Author", { nl: "Auteur" }) },
        status: {
          type: "enum",
          cases: ["proposed", "planned", "shipped", "declined"],
          default: "proposed",
          label: {
            text: statusCaption,
            values: {
              proposed: message("Proposed", { nl: "Voorgesteld" }),
              planned: message("Planned", { nl: "Gepland" }),
              shipped: message("Shipped", { nl: "Opgeleverd" }),
              declined: message("Declined", { nl: "Afgewezen" }),
            },
          },
        },
        hidden: { type: "bool", default: true, label: hiddenCaption },
        moderation_reason: {
          type: "text",
          nullable: true,
          label: message("Moderation reason", { nl: "Moderatiegrond" }),
        },
        response: { type: "text", nullable: true, label: responseCaption },
        duplicate: { type: "feedback.Suggestion", nullable: true, label: duplicateCaption },
        current_decision: {
          type: "feedback.Decision",
          nullable: true,
          label: message("Current operator decision", { nl: "Huidig exploitantbesluit" }),
        },
      },
    },
    "feedback.Vote": {
      parent: "feedback.Suggestion",
      label: message("Own vote", { nl: "Eigen stem" }),
      readGrants: [{ rule: "Vote.read.1" }],
      locks: ["Vote.lock.1"],
      unique: [{ fields: ["account"] }],
      fields: {
        account: { type: "user", server: "actor", label: message("Account", { nl: "Account" }) },
        active: { type: "bool", default: true },
        cast_at: {
          type: "datetime",
          server: "now",
          label: message("Last vote time", { nl: "Laatste stemtijd" }),
        },
      },
    },
    "feedback.Decision": {
      parent: "feedback.Suggestion",
      label: message("Operator decision", { nl: "Exploitantbesluit" }),
      readGrants: [{ rule: "Decision.read.1" }],
      locks: ["Decision.lock.1", "Decision.lock.2", "Decision.lock.3"],
      fields: {
        status: { type: "feedback.Suggestion.status" },
        response: { type: "text", label: responseCaption },
        published_at: {
          type: "datetime",
          nullable: true,
          label: message("Released at", { nl: "Vrijgegeven op" }),
        },
        withdrawn: {
          type: "bool",
          default: false,
          label: message("Withdrawn", { nl: "Ingetrokken" }),
        },
        withdrawal_reason: {
          type: "text",
          nullable: true,
          label: message("Withdrawal reason", { nl: "Reden van intrekking" }),
        },
      },
    },
  },
  contracts: {
    "feedback.Card": {
      label: message("Published suggestion", { nl: "Gepubliceerde suggestie" }),
      fields: {
        suggestion: { type: "feedback.Suggestion", label: suggestionCaption },
        title: { type: "text" },
        category: { type: "feedback.Suggestion.category" },
        status: { type: "feedback.Suggestion.status" },
        response: { type: "text", nullable: true, label: responseCaption },
        duplicate: { type: "feedback.Suggestion", nullable: true, label: duplicateCaption },
        votes: { type: "int", label: message("Votes", { nl: "Stemmen" }) },
      },
    },
    "feedback.Roadmap": {
      label: message("Published roadmap", { nl: "Gepubliceerde roadmap" }),
      fields: {
        items: {
          type: "feedback.Card",
          array: true,
          requiredArray: true,
          label: message("Items", { nl: "Items" }),
        },
      },
    },
    "feedback.DecisionCard": {
      fields: {
        status: { type: "feedback.Suggestion.status" },
        response: { type: "text", label: responseCaption },
        published_at: { type: "datetime", label: message("Released at", { nl: "Vrijgegeven op" }) },
      },
    },
    "feedback.DecisionHistory": {
      fields: {
        items: {
          type: "feedback.DecisionCard",
          array: true,
          requiredArray: true,
          label: message("Released decisions", { nl: "Vrijgegeven besluiten" }),
        },
      },
    },
    "feedback.ProductChoice": {
      fields: {
        product: { type: "feedback.Product", label: message("Product", { nl: "Product" }) },
        name: { type: "text" },
        location: { type: Location, nullable: true },
      },
    },
  },
  preferences: {
    feedback: {
      fields: {
        product: { type: "feedback.Product", nullable: true, default: null, label: message("Product", { nl: "Product" }) },
        location: { type: Location, nullable: true, default: null },
        category: { type: "feedback.Suggestion.category", nullable: true, default: null },
        status: { type: "feedback.Suggestion.status", nullable: true, default: null },
      },
    },
  },
  operations: {
    "feedback.Product.create": {
      handler: "createProduct",
      kind: "create",
      model: "feedback.Product",
      by: "feedback.product_owner",
      read: false,
      inputs: { fields: ["name", "location", "owner"] },
      when: "Product",
    },
    "feedback.Product.update": {
      handler: "updateProduct",
      kind: "update",
      model: "feedback.Product",
      by: "feedback.product_owner",
      read: false,
      inputs: { record: { type: "feedback.Product" }, changes: { fields: ["name", "published"] } },
      when: "Product",
    },
    "feedback.Suggestion.create": {
      handler: "createSuggestion",
      kind: "create",
      model: "feedback.Suggestion",
      by: "authenticated",
      read: false,
      inputs: {
        parent: { type: "feedback.Product" },
        fields: ["title", "description", "category"],
      },
      when: "Suggestion",
    },
    "feedback.Suggestion.update": {
      handler: "updateSuggestion",
      kind: "update",
      model: "feedback.Suggestion",
      by: "authenticated",
      read: false,
      inputs: {
        record: { type: "feedback.Suggestion" },
        changes: { fields: ["title", "description", "category"] },
      },
      when: "Suggestion",
    },
    "feedback.Suggestion.delete": {
      handler: "deleteSuggestion",
      kind: "delete",
      model: "feedback.Suggestion",
      by: "authenticated",
      read: false,
      mode: "archive",
      inputs: { record: { type: "feedback.Suggestion" } },
      when: "Suggestion",
    },
    "feedback.vote": {
      handler: "vote",
      by: "authenticated",
      read: false,
      label: message("Vote", { nl: "Stemmen" }),
      description: message(
        "Cast or restore your own vote after the account-wide ten-second cooldown; identities stay private.",
        {
          nl: "Breng je eigen stem uit of herstel die na de accountbrede wachttijd van tien seconden; identiteiten blijven privé.",
        },
      ),
      inputs: { suggestion: { type: "feedback.Suggestion" } },
      result: "feedback.Vote",
    },
    "feedback.unvote": {
      handler: "unvote",
      by: "authenticated",
      read: false,
      label: message("Withdraw own vote", { nl: "Eigen stem intrekken" }),
      description: message(
        "Withdraw only your own vote, retaining its identity and cooldown across retries.",
        {
          nl: "Trek uitsluitend je eigen stem in en behoud de identiteit en wachttijd bij herhaling.",
        },
      ),
      inputs: { vote: { type: "feedback.Vote" } },
    },
    "feedback.roadmap": {
      handler: "roadmap",
      by: "feedback.product_owner",
      read: false,
      label: message("Record roadmap decision", { nl: "Roadmapbesluit vastleggen" }),
      description: message(
        "Record an operator roadmap decision without changing authorship or votes; visible decisions release to public history.",
        {
          nl: "Leg een exploitantbesluit over de roadmap vast zonder auteurschap of stemmen te wijzigen; zichtbare besluiten worden vrijgegeven voor de openbare geschiedenis.",
        },
      ),
      inputs: {
        suggestion: { type: "feedback.Suggestion" },
        status: { type: "feedback.Suggestion.status", label: statusCaption },
        response: { type: "text", label: responseCaption },
        duplicate: {
          type: "feedback.Suggestion",
          nullable: true,
          default: null,
          label: duplicateCaption,
        },
      },
    },
    "feedback.moderate": {
      handler: "moderate",
      by: "feedback.product_owner",
      read: false,
      label: message("Moderate suggestion", { nl: "Suggestie modereren" }),
      description: message(
        "Hide abusive content with a reason under product-owner moderation; approving releases the selected decision.",
        {
          nl: "Verberg misbruik met een reden binnen moderatie door de productverantwoordelijke; bij goedkeuring wordt het geselecteerde besluit vrijgegeven.",
        },
      ),
      inputs: {
        suggestion: { type: "feedback.Suggestion" },
        hidden: { type: "bool", label: hiddenCaption },
        reason: { type: "text" },
      },
    },
    "feedback.published": {
      handler: "published",
      by: "public",
      read: true,
      scope: "authority",
      result: "feedback.Roadmap",
      label: message("Read published roadmap", { nl: "Gepubliceerde roadmap lezen" }),
      description: message(
        "Expose public aggregate counts, excluding voter identities and hidden content.",
        {
          nl: "Toon openbare geaggregeerde aantallen zonder stemmeridentiteiten of verborgen inhoud.",
        },
      ),
      inputs: { product: { type: "feedback.Product" } },
    },
    "feedback.withdraw_decision": {
      handler: "withdraw_decision",
      by: "feedback.product_owner",
      read: false,
      label: message("Withdraw operator decision", { nl: "Exploitantbesluit intrekken" }),
      description: message(
        "Withdraw released or private staff text while retaining owner evidence.",
        {
          nl: "Trek vrijgegeven of private medewerkerstekst in en behoud het bewijs voor de verantwoordelijke.",
        },
      ),
      inputs: { decision: { type: "feedback.Decision" }, reason: { type: "text" } },
    },
    "feedback.decision_history": {
      handler: "decision_history",
      by: "public",
      read: true,
      scope: "authority",
      result: "feedback.DecisionHistory",
      label: message("Read operator decision history", { nl: "Geschiedenis exploitantbesluiten lezen" }),
      description: message(
        "Read released operator decisions without private revisions or account identities.",
        {
          nl: "Lees vrijgegeven exploitantbesluiten zonder private revisies of accountidentiteiten.",
        },
      ),
      inputs: { suggestion: { type: "feedback.Suggestion" } },
    },
  },
  handlers: {
    "feedback.contribution_limit": {
      handler: "contribution_limit",
      on: "feedback.Suggestion.create",
    },
    "feedback.review_edited": { handler: "review_edited", on: "feedback.Suggestion.update" },
  },
  pure: {
    "feedback.product_choices": {
      handler: "product_choices",
      inputs: {},
      result: { type: "feedback.ProductChoice", array: true },
    },
  },
  pages: [
    feedbackPageDescriptor,
    moderationPageDescriptor,
  ],
  disabled: [
    "feedback.Product.delete",
    "feedback.Vote.create",
    "feedback.Vote.update",
    "feedback.Vote.delete",
    "feedback.Decision.create",
    "feedback.Decision.update",
    "feedback.Decision.delete",
  ],
};

async function product_choices(c) {
  const rows = [];
  for await (const product of records(c, "feedback.Product")) {
    rows.push({ product, name: product.name, location: product.location });
  }
  return rows;
}

export function canApp() {
  const crudWhen = {
    Product: async (c, row) =>
      same(row.owner, c.actor) &&
      (row.location === null || (await can_work(c, c.actor, row.location))),
    Suggestion: (c, row) =>
      same(row.author, c.actor) &&
      row.parent.published &&
      (!row.hidden || row.moderation_reason === null),
  };
  return {
    crudWhen,
    product_choices,

    read: {
      "Product.read.1": (c, row) => hasRole(c, "public") && row.published,
      "Product.read.2": (c, row) =>
        hasRole(c, "feedback.product_owner") && same(row.owner, c.actor),
      "Suggestion.read.1": (c, row) => hasRole(c, "public") && row.parent.published && !row.hidden,
      "Suggestion.read.2": (c, row) => hasRole(c, "authenticated") && same(row.author, c.actor),
      "Suggestion.read.3": (c, row) =>
        hasRole(c, "feedback.product_owner") && same(row.parent.owner, c.actor),
      "Vote.read.1": (c, row) => hasRole(c, "authenticated") && same(row.account, c.actor),
      "Decision.read.1": (c, row) =>
        hasRole(c, "feedback.product_owner") && same(row.parent.parent.owner, c.actor),
    },
    invariants: {
      "Suggestion.require.1": (c, row) =>
        row.duplicate === null ||
        (!same(row.duplicate, row) &&
          same(row.duplicate.parent, row.parent) &&
          row.duplicate.duplicate === null),
      "Suggestion.require.2": (c, row) =>
        row.current_decision === null ||
        (same(row.current_decision.parent, row) &&
          row.current_decision.status === row.status &&
          row.current_decision.response === row.response &&
          !row.current_decision.withdrawn),
    },
    locks: {
      "Suggestion.lock.1": { fields: ["author"] },
      "Vote.lock.1": { fields: ["account"] },
      "Decision.lock.1": { fields: ["status", "response"] },
      "Decision.lock.2": {
        fields: ["published_at"],
        when: (c, row) => row.published_at !== null,
      },
      "Decision.lock.3": {
        fields: ["withdrawn", "withdrawal_reason"],
        when: (c, row) => row.withdrawn,
      },
    },
    async createProduct(c, input) {
      check(hasRole(c, "feedback.product_owner"), "forbidden");
      await create(c, "feedback.Product", input, { when: crudWhen.Product });
    },
    async updateProduct(c, { record, changes }) {
      check(hasRole(c, "feedback.product_owner"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Product });
    },
    async createSuggestion(c, input) {
      check(hasRole(c, "authenticated"), "forbidden");
      await create(c, "feedback.Suggestion", input, { when: crudWhen.Suggestion });
    },
    async updateSuggestion(c, { record, changes }) {
      check(hasRole(c, "authenticated"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Suggestion });
    },
    async deleteSuggestion(c, { record }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(await crudWhen.Suggestion(c, record));
      await deleteRecord(c, record, { mode: "archive" });
    },
    async contribution_limit(c, { event }) {
      check(
        (await count(
          records(c, "feedback.Suggestion", {
            archived: "include",
            where: (item) =>
              same(item.author, event.after.author) &&
              compareInstant(item.created, subtractDuration(c.now, 3600000n)) > 0,
          }),
        )) <= 5n,
      );
    },
    async review_edited(c, { event }) {
      await set(c, event.after, { hidden: true, moderation_reason: null });
    },
    async vote(c, { suggestion }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(suggestion.parent.published && !suggestion.hidden);
      check(
        !(await any(
          records(c, "feedback.Vote", { archived: "include" }),
          (vote) =>
            same(vote.account, c.actor) &&
            compareInstant(vote.cast_at, subtractDuration(c.now, 10000n)) > 0,
        )),
      );
      const existing = await first(
        records(c, "feedback.Vote", {
          parent: suggestion,
          where: (vote) => same(vote.account, c.actor),
        }),
      );
      if (existing !== null) {
        await set(c, existing, { active: true, cast_at: c.now });
        return existing;
      }
      const vote = await create(c, "feedback.Vote", { parent: suggestion });
      return vote;
    },
    async unvote(c, { vote }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(same(vote.account, c.actor));
      await set(c, vote, { active: false });
    },
    async roadmap(c, { suggestion, status, response, duplicate = null }) {
      check(hasRole(c, "feedback.product_owner"), "forbidden");
      check(same(suggestion.parent.owner, c.actor) && response.trim() !== "");
      const decision = await create(c, "feedback.Decision", { parent: suggestion, status, response });
      if (!suggestion.hidden) await set(c, decision, { published_at: c.now });
      await set(c, suggestion, { status, response, duplicate, current_decision: decision });
    },
    async moderate(c, { suggestion, hidden, reason }) {
      check(hasRole(c, "feedback.product_owner"), "forbidden");
      check(same(suggestion.parent.owner, c.actor) && reason.trim() !== "");
      if (
        !hidden &&
        suggestion.current_decision !== null &&
        suggestion.current_decision.published_at === null
      ) {
        await set(c, suggestion.current_decision, { published_at: c.now });
      }
      await set(c, suggestion, { hidden, moderation_reason: reason });
    },
    async withdraw_decision(c, { decision, reason }) {
      check(hasRole(c, "feedback.product_owner"), "forbidden");
      check(
        same(decision.parent.parent.owner, c.actor) && reason.trim() !== "" && !decision.withdrawn,
      );
      if (same(decision.parent.current_decision, decision)) {
        await set(c, decision.parent, {
          hidden: true,
          moderation_reason: reason,
          status: "proposed",
          response: null,
          duplicate: null,
          current_decision: null,
        });
      }
      await set(c, decision, { withdrawn: true, withdrawal_reason: reason });
    },
    async decision_history(c, { suggestion }) {
      check(hasRole(c, "public"), "forbidden");
      check(
        suggestion.archived_at === null &&
          suggestion.parent.archived_at === null &&
          suggestion.parent.published &&
          !suggestion.hidden,
      );
      const items = [];
      for await (const decision of records(c, "feedback.Decision", {
        parent: suggestion,
        where: (decision) => decision.published_at !== null && !decision.withdrawn,
        order: ["published_at"],
      })) {
        items.push({
          status: decision.status,
          response: decision.response,
          published_at: decision.published_at,
        });
      }
      return { items };
    },
    async published(c, { product }) {
      check(hasRole(c, "public"), "forbidden");
      check(product.published);
      const items = [];
      for await (const suggestion of records(c, "feedback.Suggestion", {
        parent: product,
        where: (suggestion) => !suggestion.hidden,
      })) {
        items.push({
          suggestion,
          title: suggestion.title,
          category: suggestion.category,
          status: suggestion.status,
          response: suggestion.response,
          duplicate: await first(
            records(c, "feedback.Suggestion", {
              parent: product,
              where: (item) => same(item, suggestion.duplicate) && !item.hidden,
            }),
          ),
          votes: await count(
            records(c, "feedback.Vote", { parent: suggestion, where: (vote) => vote.active }),
          ),
        });
      }
      return { items };
    },
  };
}

export async function feedbackPage(c, bindings) {
  const choices = await product_choices(c);
  return renderPage(
    c,
    feedbackPageDescriptor,
    () => [
      list({
        context: c,
        rows: choices,
        contract: "feedback.ProductChoice",
        filter: ["product", "location"],
        defaults: {
          product: c.preferences.feedback.product,
          location: c.preferences.feedback.location,
        },
        search: ["name"],
        renderRow: (choice, view) => [
          text({ context: view, values: [choice.name, choice.location] }),
          card({
            context: view,
            title: message("Urgent private issue", { nl: "Dringend privéprobleem" }),
            children: [
              text({
                context: view,
                values: [
                  message(
                    "Use private support for incidents. Never put access instructions or anyone’s contact details in a suggestion. New suggestions await owner review.",
                    {
                      nl: "Gebruik privésupport voor incidenten. Zet nooit toegangsinstructies of contactgegevens van anderen in een suggestie. Nieuwe suggesties wachten op beoordeling door de verantwoordelijke.",
                    },
                  ),
                ],
              }),
              form({ context: view, operation: open_request, arguments: { priority: "urgent" } }),
            ],
          }),
          card({
            context: view,
            title: message("Contribution intake", { nl: "Bijdrage aanmaken" }),
            children: [
              form({
                context: view,
                operation: "feedback.Suggestion.create",
                arguments: { parent: choice.product },
              }),
            ],
          }),
          card({
            context: view,
            title: message("Published roadmap and aggregate votes", {
              nl: "Gepubliceerde roadmap en stemtotalen",
            }),
            children: [
              form({
                context: view,
                operation: "feedback.published",
                arguments: { product: choice.product },
                renderResult: (result, resultView) => [
                  table({
                    context: resultView,
                    rows: result.items,
                    contract: "feedback.Card",
                    columns: ["title", "category", "status", "response", "duplicate", "votes"],
                    filter: ["category", "status"],
                    defaults: {
                      category: c.preferences.feedback.category,
                      status: c.preferences.feedback.status,
                    },
                    order: ["-votes"],
                  }),
                ],
              }),
            ],
          }),
          ...(hasRole(view, "authenticated")
            ? [
                details({
                  context: view,
                  caption: message("Your submissions and review state", {
                    nl: "Je bijdragen en beoordelingsstatus",
                  }),
                  children: [
                    list({
                      context: view,
                      model: "feedback.Suggestion",
                      parent: choice.product,
                      where: (suggestion) => same(suggestion.author, view.actor),
                      filter: ["category", "status"],
                      defaults: {
                        category: c.preferences.feedback.category,
                        status: c.preferences.feedback.status,
                      },
                      renderRow: (suggestion, rowView) => [
                        title({ context: rowView, value: suggestion.title }),
                        content({ context: rowView, value: suggestion.description }),
                        text({
                          context: rowView,
                          values: [suggestion.category, suggestion.status, suggestion.response,
                            suggestion.hidden, suggestion.moderation_reason, suggestion.duplicate],
                        }),
                        edit({ context: rowView, operation: "feedback.Suggestion.update", record: suggestion }),
                        remove({ context: rowView, operation: "feedback.Suggestion.delete", record: suggestion }),
                        history({ context: rowView, record: suggestion }),
                      ],
                    }),
                  ],
                }),
              ]
            : []),
          details({
            context: view,
            caption: message("Suggestions and your votes", {
              nl: "Suggesties en je eigen stemmen",
            }),
            children: [
              list({
                context: view,
                model: "feedback.Suggestion",
                parent: choice.product,
                filter: ["category", "status"],
                defaults: {
                  category: c.preferences.feedback.category,
                  status: c.preferences.feedback.status,
                },
                renderRow: (suggestion, rowView) => [
                  title({ context: rowView, value: suggestion.title }),
                  content({ context: rowView, value: suggestion.description }),
                  text({
                    context: rowView,
                    values: [suggestion.category, suggestion.status, suggestion.response],
                  }),
                  edit({
                    context: rowView,
                    operation: "feedback.Suggestion.update",
                    record: suggestion,
                  }),
                  actions({
                    context: rowView,
                    operations: ["feedback.vote"],
                    boundArgs: { suggestion },
                  }),
                  details({
                    context: rowView,
                    caption: message("Operator decision history", {
                      nl: "Geschiedenis exploitantbesluiten",
                    }),
                    children: [
                      form({
                        context: rowView,
                        operation: "feedback.decision_history",
                        arguments: { suggestion },
                        renderResult: (result, resultView) => [
                          table({
                            context: resultView,
                            rows: result.items,
                            contract: "feedback.DecisionCard",
                            columns: ["published_at", "status", "response"],
                          }),
                        ],
                      }),
                    ],
                  }),
                  ...(hasRole(rowView, "authenticated")
                    ? [
                        details({
                          context: rowView,
                          caption: message("Your votes", { nl: "Je eigen stemmen" }),
                          children: [
                            list({
                              context: rowView,
                              model: "feedback.Vote",
                              parent: suggestion,
                              renderRow: (vote, voteView) => [
                                text({ context: voteView, values: [vote.active] }),
                                actions({
                                  context: voteView,
                                  operations: ["feedback.unvote"],
                                  boundArgs: { vote },
                                }),
                              ],
                            }),
                          ],
                        }),
                      ]
                    : []),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function moderationPage(c, bindings) {
  const choices = await product_choices(c);
  return renderPage(
    c,
    moderationPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Product intake", { nl: "Product aanmaken" }),
        children: [form({ context: c, operation: "feedback.Product.create" })],
      }),
      list({
        context: c,
        rows: choices.filter((choice) => same(choice.product.owner, c.actor)),
        contract: "feedback.ProductChoice",
        filter: ["product", "location"],
        defaults: {
          product: c.preferences.feedback.product,
          location: c.preferences.feedback.location,
        },
        search: ["name"],
        renderRow: (choice, view) => [
          text({ context: view, values: [choice.name, choice.location] }),
          form({
            context: view,
            operation: "feedback.Product.update",
            arguments: { record: choice.product },
          }),
          list({
            context: view,
            model: "feedback.Suggestion",
            parent: choice.product,
            filter: ["hidden", "status"],
            defaults: { status: c.preferences.feedback.status },
            display: "split",
            renderRow: (suggestion, rowView) => [
              card({
                context: rowView,
                title: message("Suggestion and roadmap outcome", {
                  nl: "Suggestie en roadmapuitkomst",
                }),
                children: [
                  title({ context: rowView, value: suggestion.title }),
                  content({ context: rowView, value: suggestion.description }),
                  text({
                    context: rowView,
                    values: [
                      suggestion.category,
                      suggestion.author,
                      suggestion.status,
                      suggestion.response,
                      suggestion.hidden,
                      suggestion.moderation_reason,
                      suggestion.duplicate,
                    ],
                  }),
                  actions({
                    context: rowView,
                    operations: ["feedback.roadmap", "feedback.moderate"],
                    boundArgs: { suggestion },
                  }),
                ],
              }),
              history({ context: rowView, record: suggestion }),
              details({
                context: rowView,
                caption: message("Operator decisions and withdrawals", {
                  nl: "Exploitantbesluiten en intrekkingen",
                }),
                children: [
                  list({
                    context: rowView,
                    model: "feedback.Decision",
                    parent: suggestion,
                    order: ["created"],
                    renderRow: (decision, decisionView) => [
                      text({
                        context: decisionView,
                        values: [
                          decision.status,
                          decision.response,
                          decision.published_at,
                          decision.withdrawn,
                          decision.withdrawal_reason,
                        ],
                      }),
                      actions({
                        context: decisionView,
                        operations: ["feedback.withdraw_decision"],
                        boundArgs: { decision },
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

/* Test-only fixture recipes and inline behavior examples. The future compiler
 * extracts these declarations and erases fixture-only imports from production.
 * Recipes retain identity; dependencies resolve before deferred value callbacks.
 * Each row provisions only seed/common-input/row dependencies and their closure.
 * Common bindings establish the baseline. Inputs, cells and expected values read
 * untouched seeded scope s; overrides apply together, observations use fresh scope.
 * No runner, provisioning implementation or Can-expression interpreter is added.
 */
export const exampleImports = [];

export function exampleFixtures({ self, other, imported }) {
  const product = {
    model: "feedback.Product",
    dependencies: [],
    value: async (c, s) => ({ name: "Facilities", owner: s.other }),
  };
  const suggestion = {
    model: "feedback.Suggestion",
    dependencies: [product],
    value: async (c, s) => ({
      parent: s.product,
      title: "Phone booths",
      description: "Add booths",
      category: "Amenity",
      hidden: false,
    }),
  };
  const root = {
    model: "feedback.Suggestion",
    dependencies: [product],
    value: async (c, s) => ({
      parent: s.product,
      title: "Quiet calls",
      description: "Improve call spaces",
      category: "Amenity",
      hidden: false,
    }),
  };
  const own_vote = {
    model: "feedback.Vote",
    dependencies: [suggestion],
    value: async (c, s) => ({ parent: s.suggestion, cast_at: subtractDuration(c.now, 60000n) }),
  };
  const foreign_vote = {
    model: "feedback.Vote",
    dependencies: [suggestion],
    value: async (c, s) => ({
      parent: s.suggestion,
      account: s.other,
      cast_at: subtractDuration(c.now, 60000n),
    }),
  };
  const decision = {
    model: "feedback.Decision",
    dependencies: [suggestion],
    value: async (c, s) => ({
      parent: s.suggestion,
      status: "planned",
      response: "Two booths this quarter",
    }),
  };
  const recent = {
    model: "feedback.Suggestion",
    dependencies: [product],
    value: async (c, s) => ({
      parent: s.product,
      title: "Bike storage",
      description: "Add a rack",
      category: "Amenity",
    }),
  };
  const recent2 = {
    model: "feedback.Suggestion",
    dependencies: [product],
    value: async (c, s) => ({
      parent: s.product,
      title: "Water",
      description: "Add a fountain",
      category: "Amenity",
    }),
  };
  const recent3 = {
    model: "feedback.Suggestion",
    dependencies: [product],
    value: async (c, s) => ({
      parent: s.product,
      title: "Desks",
      description: "Add sit-stand desks",
      category: "Amenity",
    }),
  };
  const recent4 = {
    model: "feedback.Suggestion",
    dependencies: [product],
    value: async (c, s) => ({
      parent: s.product,
      title: "Lighting",
      description: "Adjust desk lights",
      category: "Amenity",
    }),
  };
  const recent5 = {
    model: "feedback.Suggestion",
    dependencies: [product],
    value: async (c, s) => ({
      parent: s.product,
      title: "Plants",
      description: "Add greenery",
      category: "Amenity",
    }),
  };
  const moderator = {
    dependencies: [],
    user: async (c, s) => ({ roles: ["feedback.product_owner"] }),
  };
  const journey_product = {
    model: "feedback.Product",
    dependencies: [moderator],
    value: async (c, s) => ({ name: "Facilities", owner: s.moderator }),
  };
  return {
    product,
    suggestion,
    root,
    own_vote,
    foreign_vote,
    decision,
    recent,
    recent2,
    recent3,
    recent4,
    recent5,
    moderator,
    journey_product,
    examples: [
      {
        operation: "feedback.vote",
        dependencies: [journey_product],
        sequence: [
          { operation: "feedback.Suggestion.create", by: async (c, s, b) => s.self,
            inputs: async (c, s, b) => ({ parent: s.journey_product, title: "Phone booths", description: "Add private call spaces", category: "Amenity" }) },
          { let: "submitted", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => same(item.author, s.self) })) },
          { observations: async (c, s, b) => [b.submitted !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.submitted.hidden, b.submitted.author, b.submitted.status], expected: async (c, s, b) => [true, s.self, "proposed"], types: ["bool", "user", "feedback.Suggestion.status"] },
          { operation: "feedback.published", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ product: s.journey_product }), bind: "pending_roadmap" },
          { observations: async (c, s, b) => [await count(b.pending_roadmap.items)], expected: async (c, s, b) => [0n], types: ["int"] },
          { operation: "feedback.moderate", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.submitted, hidden: false, reason: "Reviewed for public roadmap" }) },
          { let: "reviewed", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.reviewed !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.roadmap", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.reviewed, status: "planned", response: "Two booths this quarter", duplicate: null }) },
          { let: "visible", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.visible !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.published", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ product: s.journey_product }), bind: "visible_roadmap" },
          { observations: async (c, s, b) => [await count(b.visible_roadmap.items), (await first(b.visible_roadmap.items))?.category ?? null, (await first(b.visible_roadmap.items))?.status ?? null, (await first(b.visible_roadmap.items))?.response ?? null],
            expected: async (c, s, b) => [1n, "Amenity", "planned", "Two booths this quarter"], types: ["int", "text?", "feedback.Suggestion.status?", "text?"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.visible }), bind: "first_history" },
          { observations: async (c, s, b) => [await count(b.first_history.items), (await first(b.first_history.items))?.response ?? null], expected: async (c, s, b) => [1n, "Two booths this quarter"], types: ["int", "text?"] },
          { operation: "feedback.vote", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ suggestion: b.visible }), bind: "cast_vote" },
          { operation: "feedback.unvote", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ vote: b.cast_vote }) },
          { let: "withdrawn", value: async (c, s, b) => await first(records(c, "feedback.Vote", { parent: b.visible, where: (item) => same(item.account, s.self) })) },
          { observations: async (c, s, b) => [b.withdrawn !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [same(b.withdrawn, b.cast_vote), b.withdrawn.active, await count(records(c, "feedback.Vote", { parent: b.visible })), await count(records(c, "feedback.Vote", { parent: b.visible, where: (item) => item.active }))],
            expected: async (c, s, b) => [true, false, 1n, 0n], types: ["bool", "bool", "int", "int"] },
          { operation: "feedback.unvote", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ vote: b.withdrawn }) },
          { operation: "feedback.vote", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ suggestion: b.visible }), error: "rule_failed" },
          { observations: async (c, s, b) => [await count(records(c, "feedback.Vote", { parent: b.visible })), await count(records(c, "feedback.Vote", { parent: b.visible, where: (item) => item.active }))], expected: async (c, s, b) => [1n, 0n], types: ["int", "int"] },
          { operation: "feedback.Suggestion.update", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ record: b.visible, changes: { title: "More phone booths" } }) },
          { let: "edited", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.edited !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.edited.title, b.edited.hidden, b.edited.moderation_reason, b.edited.author], expected: async (c, s, b) => ["More phone booths", true, null, s.self], types: ["text", "bool", "text?", "user"] },
          { operation: "feedback.published", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ product: s.journey_product }), bind: "review_roadmap" },
          { observations: async (c, s, b) => [await count(b.review_roadmap.items)], expected: async (c, s, b) => [0n], types: ["int"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.edited }), error: "rule_failed" },
          { operation: "feedback.moderate", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.edited, hidden: true, reason: "Private contact details" }) },
          { let: "blocked", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.blocked !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.Suggestion.update", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ record: b.blocked, changes: { title: "Try again" } }), error: "rule_failed" },
          { observations: async (c, s, b) => [b.blocked.title, b.blocked.author, b.blocked.moderation_reason], expected: async (c, s, b) => ["More phone booths", s.self, "Private contact details"], types: ["text", "user", "text?"] },
          { operation: "feedback.moderate", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.blocked, hidden: false, reason: "Reviewed correction" }) },
          { let: "corrected", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.corrected !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.roadmap", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.corrected, status: "shipped", response: "Two booths installed", duplicate: null }) },
          { let: "approved", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.approved !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.published", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ product: s.journey_product }), bind: "shipped_roadmap" },
          { observations: async (c, s, b) => [(await first(b.shipped_roadmap.items))?.status ?? null, (await first(b.shipped_roadmap.items))?.response ?? null, (await first(b.shipped_roadmap.items))?.votes ?? null], expected: async (c, s, b) => ["shipped", "Two booths installed", 0n], types: ["feedback.Suggestion.status?", "text?", "int?"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.approved }), bind: "shipped_history" },
          { observations: async (c, s, b) => [await count(b.shipped_history.items)], expected: async (c, s, b) => [2n], types: ["int"] },
          { operation: "feedback.Suggestion.delete", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ record: b.approved }) },
          { let: "archived", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { archived: "include", where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.archived !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.archived.archived_at !== null, b.archived.author], expected: async (c, s, b) => [true, s.self], types: ["bool", "user"] },
          { operation: "feedback.published", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ product: s.journey_product }), bind: "archived_roadmap" },
          { observations: async (c, s, b) => [await count(b.archived_roadmap.items)], expected: async (c, s, b) => [0n], types: ["int"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.archived }), error: "rule_failed" },
        ],
      },
      {
        operation: "feedback.Suggestion.create",
        dependencies: [product],
        inputs: async (c, s) => ({
          parent: s.product,
          title: "Air quality",
          description: "Improve ventilation",
          category: "Amenity",
        }),
        selectors: ["as", "parent.published"],
        observations: [
          async (c, s) => await count(records(c, "feedback.Suggestion", { parent: s.product })),
          async (c, s) =>
            await count(
              records(c, "feedback.Suggestion", {
                parent: s.product,
                where: (item) => !item.hidden,
              }),
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", true],
            expected: async (c, s) => [1n, 0n],
          },
          { dependencies: [], values: async (c, s) => ["members", false], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["public", true], error: "forbidden" },
        ],
      },
      {
        operation: "feedback.Suggestion.create",
        seed: [recent, recent2, recent3, recent4, recent5],
        dependencies: [product],
        inputs: async (c, s) => ({
          parent: s.product,
          title: "Air quality",
          description: "Improve ventilation",
          category: "Amenity",
        }),
        selectors: ["as"],
        observations: [
          async (c, s) => await count(records(c, "feedback.Suggestion", { parent: s.product })),
        ],
        rows: [{ dependencies: [], values: async (c, s) => ["members"], error: "rule_failed" }],
      },
      {
        operation: "feedback.Suggestion.update",
        dependencies: [suggestion],
        inputs: async (c, s) => ({ record: s.suggestion }),
        selectors: ["as", "changes.title", "record.author"],
        observations: [async (c, s) => s.suggestion.title, async (c, s) => s.suggestion.hidden],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", "More booths", s.self],
            expected: async (c, s) => ["More booths", true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "More booths", s.other],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "feedback.Suggestion.delete",
        dependencies: [suggestion],
        inputs: async (c, s) => ({ record: s.suggestion }),
        selectors: ["as"],
        observations: [async (c, s) => s.suggestion.archived_at !== null],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members"],
            expected: async (c, s) => [true],
          },
        ],
      },
      {
        operation: "feedback.vote",
        dependencies: [suggestion],
        inputs: async (c, s) => ({ suggestion: s.suggestion }),
        selectors: ["as", "suggestion.hidden"],
        observations: [
          async (c, s) =>
            await count(
              records(c, "feedback.Vote", { parent: s.suggestion, where: (item) => item.active }),
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", false],
            expected: async (c, s) => [1n],
          },
          { dependencies: [], values: async (c, s) => ["members", true], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["public", false], error: "forbidden" },
        ],
      },
      {
        operation: "feedback.vote",
        seed: [own_vote, foreign_vote],
        dependencies: [suggestion],
        inputs: async (c, s) => ({ suggestion: s.suggestion }),
        selectors: ["as", "own_vote.active", "own_vote.cast_at"],
        observations: [
          async (c, s) => await count(records(c, "feedback.Vote", { parent: s.suggestion })),
          async (c, s) =>
            await count(
              records(c, "feedback.Vote", { parent: s.suggestion, where: (item) => item.active }),
            ),
          async (c, s) => same(s.result, s.own_vote),
          async (c, s) => s.foreign_vote.account,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", true, subtractDuration(c.now, 60000n)],
            expected: async (c, s) => [2n, 2n, true, s.other],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", false, subtractDuration(c.now, 60000n)],
            expected: async (c, s) => [2n, 2n, true, s.other],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", false, c.now],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "feedback.unvote",
        seed: [foreign_vote],
        dependencies: [own_vote],
        inputs: async (c, s) => ({ vote: s.own_vote }),
        selectors: ["as", "vote.active"],
        observations: [
          async (c, s) => s.vote.active,
          async (c, s) =>
            await count(
              records(c, "feedback.Vote", { parent: s.suggestion, where: (item) => item.active }),
            ),
          async (c, s) => s.foreign_vote.active,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", true],
            expected: async (c, s) => [false, 1n, true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", false],
            expected: async (c, s) => [false, 1n, true],
          },
        ],
      },
      {
        operation: "feedback.unvote",
        dependencies: [foreign_vote],
        inputs: async (c, s) => ({ vote: s.foreign_vote }),
        selectors: ["as"],
        observations: [async (c, s) => s.vote.active],
        rows: [{ dependencies: [], values: async (c, s) => ["members"], error: "rule_failed" }],
      },
      {
        operation: "feedback.roadmap",
        seed: [own_vote, foreign_vote],
        dependencies: [suggestion, root],
        inputs: async (c, s) => ({
          suggestion: s.suggestion,
          status: "planned",
          response: "Two booths this quarter",
          duplicate: s.root,
        }),
        selectors: ["as", "suggestion.parent.owner", "duplicate.duplicate"],
        observations: [
          async (c, s) => s.suggestion.status,
          async (c, s) => s.suggestion.duplicate,
          async (c, s) => s.suggestion.author,
          async (c, s) =>
            await count(
              records(c, "feedback.Vote", { parent: s.suggestion, where: (item) => item.active }),
            ),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["feedback.product_owner", s.self, null],
            expected: async (c, s) => ["planned", s.root, s.self, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, null],
            error: "forbidden",
          },
          {
            dependencies: [],
            values: async (c, s) => ["feedback.product_owner", s.other, null],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["feedback.product_owner", s.self, s.suggestion],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "feedback.moderate",
        dependencies: [suggestion],
        inputs: async (c, s) => ({
          suggestion: s.suggestion,
          hidden: true,
          reason: "Private contact details",
        }),
        selectors: ["as", "suggestion.parent.owner"],
        observations: [
          async (c, s) => s.suggestion.hidden,
          async (c, s) => s.suggestion.moderation_reason,
          async (c, s) => s.suggestion.author,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["feedback.product_owner", s.self],
            expected: async (c, s) => [true, "Private contact details", s.self],
          },
          { dependencies: [], values: async (c, s) => ["members", s.self], error: "forbidden" },
        ],
      },
      {
        operation: "feedback.moderate",
        dependencies: [suggestion],
        inputs: async (c, s) => ({
          suggestion: s.suggestion,
          hidden: false,
          reason: "Reviewed for public roadmap",
        }),
        selectors: ["as", "suggestion.parent.owner"],
        observations: [
          async (c, s) => s.suggestion.hidden,
          async (c, s) => s.suggestion.moderation_reason,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["feedback.product_owner", s.self],
            expected: async (c, s) => [false, "Reviewed for public roadmap"],
          },
        ],
      },
      {
        operation: "feedback.published",
        seed: [own_vote, foreign_vote],
        dependencies: [product],
        inputs: async (c, s) => ({ product: s.product }),
        selectors: ["as", "suggestion.hidden", "own_vote.active"],
        observations: [
          async (c, s) => await count(s.result.items),
          async (c, s) => await sum(s.result.items, (item) => item.votes),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["public", false, true],
            expected: async (c, s) => [1n, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", false, false],
            expected: async (c, s) => [1n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", true, true],
            expected: async (c, s) => [0n, 0n],
          },
        ],
      },
      {
        operation: "feedback.published",
        seed: [suggestion, root],
        dependencies: [product],
        inputs: async (c, s) => ({ product: s.product }),
        selectors: ["as", "suggestion.duplicate", "root.hidden"],
        observations: [async (c, s) => (await first(s.result.items))?.duplicate ?? null],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["public", s.root, true],
            expected: async (c, s) => [null],
          },
        ],
      },
      {
        operation: "feedback.withdraw_decision",
        dependencies: [decision],
        inputs: async (c, s) => ({ decision: s.decision, reason: "Response needs correction" }),
        selectors: ["as", "decision.parent.parent.owner", "reason", "decision.withdrawn"],
        observations: [async (c, s) => s.decision.withdrawn],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, "Response needs correction", false],
            error: "forbidden",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "feedback.product_owner",
              s.other,
              "Response needs correction",
              false,
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["feedback.product_owner", s.self, "", false],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "feedback.product_owner",
              s.self,
              "Response needs correction",
              true,
            ],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "feedback.decision_history",
        dependencies: [journey_product],
        sequence: [
          { operation: "feedback.Suggestion.create", by: async (c, s, b) => s.self, inputs: async (c, s, b) => ({ parent: s.journey_product, title: "Quiet spaces", description: "More booths", category: "Amenity" }) },
          { let: "submitted", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => same(item.author, s.self) })) },
          { observations: async (c, s, b) => [b.submitted !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.roadmap", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.submitted, status: "planned", response: "Private draft containing a phone number", duplicate: null }) },
          { let: "drafted", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.drafted !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.roadmap", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.drafted, status: "planned", response: "Two booths this quarter", duplicate: null }) },
          { let: "ready", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.ready !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.ready }), error: "rule_failed" },
          { operation: "feedback.moderate", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.ready, hidden: false, reason: "Reviewed current text and response" }) },
          { let: "visible", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.visible !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.visible }), bind: "released" },
          { observations: async (c, s, b) => [await count(b.released.items), (await first(b.released.items))?.response ?? null], expected: async (c, s, b) => [1n, "Two booths this quarter"], types: ["int", "text?"] },
          { operation: "feedback.roadmap", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.visible, status: "shipped", response: "Two booths installed", duplicate: null }) },
          { let: "shipped", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.shipped !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.shipped }), bind: "history_before" },
          { observations: async (c, s, b) => [await count(b.history_before.items), await any(b.history_before.items, (item) => item.response === "Private draft containing a phone number")], expected: async (c, s, b) => [2n, false], types: ["int", "bool"] },
          { observations: async (c, s, b) => [b.shipped.current_decision !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.withdraw_decision", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ decision: b.shipped.current_decision, reason: "Response needs correction" }) },
          { let: "withdrawn", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.withdrawn !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { observations: async (c, s, b) => [b.withdrawn.hidden, b.withdrawn.status, b.withdrawn.response, b.withdrawn.current_decision], expected: async (c, s, b) => [true, "proposed", null, null], types: ["bool", "feedback.Suggestion.status", "text?", "feedback.Decision?"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.withdrawn }), error: "rule_failed" },
          { operation: "feedback.roadmap", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.withdrawn, status: "planned", response: "Installation postponed", duplicate: null }) },
          { let: "corrected", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.corrected !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.moderate", by: async (c, s, b) => s.moderator, inputs: async (c, s, b) => ({ suggestion: b.corrected, hidden: false, reason: "Reviewed replacement" }) },
          { let: "republished", value: async (c, s, b) => await first(records(c, "feedback.Suggestion", { parent: s.journey_product, where: (item) => item.id === b.submitted.id })) },
          { observations: async (c, s, b) => [b.republished !== null], expected: async (c, s, b) => [true], types: ["bool"] },
          { operation: "feedback.decision_history", by: async (c, s, b) => "public", inputs: async (c, s, b) => ({ suggestion: b.republished }), bind: "history_after" },
          { observations: async (c, s, b) => [await count(b.history_after.items), await any(b.history_after.items, (item) => item.response === "Two booths installed"), await any(b.history_after.items, (item) => item.response === "Installation postponed")], expected: async (c, s, b) => [2n, false, true], types: ["int", "bool", "bool"] },
        ],
      },
    ],
  };
}
