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
  details,
  edit,
  form,
  history,
  list,
  message,
  renderPage,
  table,
  text,
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
      invariants: ["Suggestion.require.1"],
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
  },
  contracts: {
    "feedback.Card": {
      label: message("Published suggestion", { nl: "Gepubliceerde suggestie" }),
      fields: {
        suggestion: { type: "feedback.Suggestion", label: suggestionCaption },
        title: { type: "text" },
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
  },
  preferences: {
    feedback: {
      fields: {
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
        "Record an operator roadmap decision without changing authorship or votes.",
        {
          nl: "Leg een exploitantbesluit over de roadmap vast zonder auteurschap of stemmen te wijzigen.",
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
      description: message("Hide abusive content with a reason under product-owner moderation.", {
        nl: "Verberg misbruik met een reden binnen moderatie door de productverantwoordelijke.",
      }),
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
  },
  handlers: {
    "feedback.contribution_limit": {
      handler: "contribution_limit",
      on: "feedback.Suggestion.create",
    },
    "feedback.review_edited": { handler: "review_edited", on: "feedback.Suggestion.update" },
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
  ],
};

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

    read: {
      "Product.read.1": (c, row) => hasRole(c, "public") && row.published,
      "Product.read.2": (c, row) =>
        hasRole(c, "feedback.product_owner") && same(row.owner, c.actor),
      "Suggestion.read.1": (c, row) => hasRole(c, "public") && row.parent.published && !row.hidden,
      "Suggestion.read.2": (c, row) => hasRole(c, "authenticated") && same(row.author, c.actor),
      "Suggestion.read.3": (c, row) =>
        hasRole(c, "feedback.product_owner") && same(row.parent.owner, c.actor),
      "Vote.read.1": (c, row) => hasRole(c, "authenticated") && same(row.account, c.actor),
    },
    invariants: {
      "Suggestion.require.1": (c, row) =>
        row.duplicate === null ||
        (!same(row.duplicate, row) &&
          same(row.duplicate.parent, row.parent) &&
          row.duplicate.duplicate === null),
    },
    locks: { "Suggestion.lock.1": { fields: ["author"] }, "Vote.lock.1": { fields: ["account"] } },
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
      await set(c, suggestion, { status, response, duplicate });
    },
    async moderate(c, { suggestion, hidden, reason }) {
      check(hasRole(c, "feedback.product_owner"), "forbidden");
      check(same(suggestion.parent.owner, c.actor) && reason.trim() !== "");
      await set(c, suggestion, { hidden, moderation_reason: reason });
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
  return renderPage(
    c,
    feedbackPageDescriptor,
    () => [
      list({
        context: c,
        model: "feedback.Product",
        filter: ["location"],
        defaults: { location: c.preferences.feedback.location },
        search: ["name"],
        renderRow: (product, view) => [
          text({ context: view, values: [product.name] }),
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
                arguments: { parent: product },
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
                arguments: { product },
                renderResult: (result, resultView) => [
                  table({
                    context: resultView,
                    rows: result.items,
                    contract: "feedback.Card",
                    columns: ["title", "status", "response", "duplicate", "votes"],
                    order: ["-votes"],
                  }),
                ],
              }),
            ],
          }),
          details({
            context: view,
            caption: message("Suggestions and your votes", {
              nl: "Suggesties en je eigen stemmen",
            }),
            children: [
              list({
                context: view,
                model: "feedback.Suggestion",
                parent: product,
                filter: ["category", "status"],
                defaults: {
                  category: c.preferences.feedback.category,
                  status: c.preferences.feedback.status,
                },
                renderRow: (suggestion, rowView) => [
                  content({ context: rowView, value: suggestion.description }),
                  text({
                    context: rowView,
                    values: [suggestion.status, suggestion.response],
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
        model: "feedback.Product",
        where: (product) => same(product.owner, c.actor),
        filter: ["location"],
        defaults: { location: c.preferences.feedback.location },
        search: ["name"],
        renderRow: (product, view) => [
          edit({ context: view, operation: "feedback.Product.update", record: product }),
          list({
            context: view,
            model: "feedback.Suggestion",
            parent: product,
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
                  content({ context: rowView, value: suggestion.description }),
                  text({
                    context: rowView,
                    values: [
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
  return {
    product,
    suggestion,
    root,
    own_vote,
    foreign_vote,
    recent,
    recent2,
    recent3,
    recent4,
    recent5,
    examples: [
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
    ],
  };
}
