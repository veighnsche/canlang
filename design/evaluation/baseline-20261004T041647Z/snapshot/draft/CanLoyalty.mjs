import {
  all,
  compareInstant,
  datetime,
  equalMoney,
  equalValue,
  max,
  min,
  money,
  any,
  require as check,
  count,
  create,
  first,
  format,
  hasRole,
  int64,
  records,
  same,
  send,
  set,
  sum,
} from "@canlang/stdlib";
import {
  actions,
  card,
  edit,
  form,
  history,
  list,
  message,
  metrics,
  renderPage,
  tab,
  table,
  tabs,
  text,
  content,
} from "@canlang/ui";
import { Contact, Customer } from "./customer.mjs";
import { can_work } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";

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

const rewards = message("Rewards", { nl: "Beloningen" });

const programCaption = message("Reward program", { nl: "Beloningsprogramma" });

const fulfillmentCaption = message("Reward fulfillment", { nl: "Beloningen uitvoeren" });

const locationsCaption = message("Locations", { nl: "Locaties" });

const costCaption = message("Cost", { nl: "Kosten" });

const sourceCaption = message("Source reference", { nl: "Bronreferentie" });

export const appDefinition = {
  id: "CanLoyalty",
  uses: ["loyalty"],
  description: message(
    "Help the workspace operator reward repeat paid workspace visits with points, tiers, and fulfillable perks.",
    {
      nl: "Help de werkplekbeheerder herhaalde betaalde bezoeken te belonen met punten, niveaus en uitvoerbare voordelen.",
    },
  ),
  packages: {
    loyalty: {
      label: rewards,
      description: message(
        "Keep earned points, tier progress and fulfillable perk reservations separate from cash and member allowances.",
        {
          nl: "Houd verdiende punten, niveauvoortgang en voordeelreserveringen gescheiden van geld en lidmaatschapstegoeden.",
        },
      ),
      roles: {
        program_owner: {
          id: "loyalty.program_owner",
          label: message("Program owner", { nl: "Programma-eigenaar" }),
        },
        reward_staff: {
          id: "loyalty.reward_staff",
          label: message("Reward staff", { nl: "Beloningsmedewerker" }),
        },
      },
    },
  },
  bindings: {
    "loyalty.Mail": { capability: "std.EmailV1", from: "deployment.mail" },
    "loyalty.Sales": { capability: "invoice.SalesV1", from: "deployment.qualified_sales" },
  },
  models: {
    "loyalty.Program": {
      label: programCaption,
      readGrants: [
        {
          rule: "Program.read.1",
          fields: ["name", "locations", "products", "terms", "points_per_sale", "active"],
        },
        { rule: "Program.read.2" },
      ],
      invariants: ["Program.require.1"],
      fields: {
        name: { type: "text" },
        locations: { type: Location, array: true, label: locationsCaption },
        terms: { type: "text", label: message("Terms", { nl: "Voorwaarden" }) },
        products: {
          type: "text",
          array: true,
          requiredArray: true,
          min: 1n,
          label: message("Qualifying products", { nl: "Kwalificerende producten" }),
        },
        points_per_sale: {
          type: "int",
          min: 1n,
          label: message("Points per sale", { nl: "Punten per verkoop" }),
        },
        active: { type: "bool", default: true },
      },
    },
    "loyalty.Tier": {
      parent: "loyalty.Program",
      label: message("Reward tier", { nl: "Beloningsniveau" }),
      readGrants: [{ rule: "Tier.read.1" }],
      unique: [{ fields: ["threshold"] }],
      fields: {
        name: { type: "text" },
        threshold: {
          type: "int",
          min: 0n,
          label: message("Points threshold", { nl: "Puntendrempel" }),
        },
      },
    },
    "loyalty.Reward": {
      parent: "loyalty.Program",
      label: message("Reward", { nl: "Beloning" }),
      readGrants: [{ rule: "Reward.read.1" }, { rule: "Reward.read.2" }],
      invariants: ["Reward.require.1"],
      fields: {
        name: { type: "text" },
        cost: { type: "int", min: 1n, label: costCaption },
        instructions: { type: "text" },
        locations: { type: Location, array: true, label: locationsCaption },
        active: { type: "bool", default: true },
      },
    },
    "loyalty.Account": {
      parent: "loyalty.Program",
      label: message("Reward account", { nl: "Beloningsaccount" }),
      readGrants: [{ rule: "Account.read.1" }, { rule: "Account.read.2" }],
      invariants: ["Account.require.1"],
      unique: [{ fields: ["customer"] }],
      fields: { customer: { type: Customer }, contact: { type: Contact } },
      derived: {
        tier: {
          type: "loyalty.Tier",
          nullable: true,
          handler: "Account.tier",
          label: message("Current tier", { nl: "Huidig niveau" }),
        },
        next_tier: {
          type: "loyalty.Tier",
          nullable: true,
          handler: "Account.next_tier",
          label: message("Next tier", { nl: "Volgend niveau" }),
        },
        tier_span: {
          type: "int",
          handler: "Account.tier_span",
          label: message("Points between tiers", { nl: "Punten tussen niveaus" }),
        },
        tier_progress: {
          type: "int",
          handler: "Account.tier_progress",
          label: message("Points toward next tier", { nl: "Punten richting volgend niveau" }),
        },
        earned: {
          type: "int",
          handler: "Account.earned",
          label: message("Earned points", { nl: "Verdiende punten" }),
        },
        available: {
          type: "int",
          handler: "Account.available",
          label: message("Available points", { nl: "Beschikbare punten" }),
        },
      },
    },
    "loyalty.SourceEvidence": {
      parent: "loyalty.Account",
      readGrants: [{ rule: "SourceEvidence.read.1" }, { rule: "SourceEvidence.read.2" }],
      invariants: ["SourceEvidence.require.1"],
      locks: ["SourceEvidence.lock.1"],
      fields: {
        source: { type: "text", unique: true },
        value: { type: "invoice.Qualification" },
        reversed: { type: "bool", default: false },
        decided: { type: "bool", default: false },
      },
    },
    "loyalty.Earning": {
      parent: "loyalty.Account",
      label: message("Points entry", { nl: "Puntenboeking" }),
      readGrants: [{ rule: "Earning.read.1" }, { rule: "Earning.read.2" }],
      locks: ["Earning.lock.1"],
      invariants: ["Earning.require.1"],
      unique: [{ fields: ["reversal"] }],
      fields: {
        tier: {
          type: "bool",
          default: false,
          label: message("Counts toward tier", { nl: "Telt mee voor niveau" }),
        },
        author: { type: "user", nullable: true },
        qualification: { type: "loyalty.SourceEvidence", nullable: true },
        source: { type: "text", unique: true, label: sourceCaption },
        points: { type: "int", label: message("Points", { nl: "Punten" }) },
        reason: { type: "text" },
        reversal: {
          type: "loyalty.Earning",
          nullable: true,
          label: message("Reversed entry", { nl: "Tegenboeking" }),
        },
      },
    },
    "loyalty.Redemption": {
      parent: "loyalty.Account",
      label: message("Reward reservation", { nl: "Beloningsreservering" }),
      readGrants: [{ rule: "Redemption.read.1" }, { rule: "Redemption.read.2" }],
      invariants: ["Redemption.require.1"],
      locks: ["Redemption.lock.1"],
      fields: {
        reward: { type: "loyalty.Reward" },
        name: { type: "text" },
        instructions: { type: "text" },
        locations: { type: Location, array: true, requiredArray: true },
        location: { type: Location },
        fulfilled_by: { type: "user", nullable: true },
        cancelled_by: { type: "user", nullable: true },
        notification: {
          type: "std.DeliveryResult.status",
          default: "pending",
          label: message("Notification outcome", { nl: "Meldingsresultaat" }),
        },
        notification_delivery: { type: "text", nullable: true },
        cost: { type: "int", label: costCaption },
        state: {
          type: "enum",
          cases: ["reserved", "fulfilled", "cancelled"],
          default: "reserved",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              reserved: message("Reserved", { nl: "Gereserveerd" }),
              fulfilled: message("Fulfilled", { nl: "Uitgevoerd" }),
              cancelled: message("Cancelled", { nl: "Geannuleerd" }),
            },
          },
        },
        evidence: { type: "text", nullable: true },
        source: { type: "text", unique: true, label: sourceCaption },
      },
    },
  },
  preferences: {
    loyalty: {
      fields: {
        view: {
          type: "enum",
          cases: ["rewards", "history"],
          default: "rewards",
          label: {
            text: message("Reward view", { nl: "Beloningsweergave" }),
            values: { rewards, history: message("History", { nl: "Geschiedenis" }) },
          },
        },
        location: {
          type: Location,
          nullable: true,
          default: null,
          label: message("Reward location", { nl: "Beloningslocatie" }),
        },
        redemption_state: {
          type: "loyalty.Redemption.state",
          nullable: true,
          default: null,
          label: message("Reward state", { nl: "Beloningsstatus" }),
        },
      },
    },
  },
  operations: {
    "loyalty.Program.create": {
      handler: "createProgram",
      kind: "create",
      model: "loyalty.Program",
      by: "loyalty.program_owner",
      read: false,
      inputs: { fields: ["name", "locations", "products", "terms", "points_per_sale", "active"] },
      when: "Program",
    },
    "loyalty.Program.update": {
      handler: "updateProgram",
      kind: "update",
      model: "loyalty.Program",
      by: "loyalty.program_owner",
      read: false,
      inputs: {
        record: { type: "loyalty.Program" },
        changes: {
          fields: ["name", "locations", "products", "terms", "points_per_sale", "active"],
        },
      },
      when: "Program",
    },
    "loyalty.Tier.create": {
      handler: "createTier",
      kind: "create",
      model: "loyalty.Tier",
      by: "loyalty.program_owner",
      read: false,
      inputs: { parent: { type: "loyalty.Program" }, fields: ["name", "threshold"] },
      when: "Tier",
    },
    "loyalty.Tier.update": {
      handler: "updateTier",
      kind: "update",
      model: "loyalty.Tier",
      by: "loyalty.program_owner",
      read: false,
      inputs: { record: { type: "loyalty.Tier" }, changes: { fields: ["name", "threshold"] } },
      when: "Tier",
    },
    "loyalty.Reward.create": {
      handler: "createReward",
      kind: "create",
      model: "loyalty.Reward",
      by: "loyalty.program_owner",
      read: false,
      inputs: {
        parent: { type: "loyalty.Program" },
        fields: ["name", "cost", "instructions", "locations", "active"],
      },
      when: "Reward",
    },
    "loyalty.Reward.update": {
      handler: "updateReward",
      kind: "update",
      model: "loyalty.Reward",
      by: "loyalty.program_owner",
      read: false,
      inputs: {
        record: { type: "loyalty.Reward" },
        changes: { fields: ["name", "cost", "instructions", "locations", "active"] },
      },
      when: "Reward",
    },
    "loyalty.Account.create": {
      handler: "createAccount",
      kind: "create",
      model: "loyalty.Account",
      by: "loyalty.reward_staff",
      read: false,
      inputs: { parent: { type: "loyalty.Program" }, fields: ["customer", "contact"] },
      when: "Account",
    },
    "loyalty.redeem": {
      read: false,
      handler: "redeem",
      by: "authenticated",
      inputs: {
        account: { type: "loyalty.Account" },
        reward: { type: "loyalty.Reward" },
        location: { type: Location },
      },
      result: "loyalty.Redemption",
      label: message("Reserve reward", { nl: "Beloning reserveren" }),
      description: message(
        "Reserve your own current reward cost only when the ledger is affordable.",
        {
          nl: "Reserveer de huidige kosten van je eigen beloning uitsluitend wanneer het puntensaldo toereikend is.",
        },
      ),
    },
    "loyalty.fulfill": {
      read: false,
      handler: "fulfill",
      by: "loyalty.reward_staff",
      inputs: { redemption: { type: "loyalty.Redemption" }, evidence: { type: "text" } },
      label: message("Fulfill reward", { nl: "Beloning uitvoeren" }),
      description: message("Record actual perk fulfillment; notification is not fulfillment.", {
        nl: "Registreer de werkelijke uitvoering van het voordeel; een melding is geen uitvoering.",
      }),
    },
    "loyalty.adjust": {
      read: false,
      handler: "adjust",
      by: "loyalty.reward_staff",
      inputs: {
        account: { type: "loyalty.Account" },
        points: { type: "int" },
        reason: { type: "text" },
        tier: { type: "bool", default: false },
      },
      description: message(
        "Record an attributed nonzero correction; explicitly choose whether it corrects earned-tier points.",
      ),
    },
    "loyalty.reverse": {
      read: false,
      handler: "reverse",
      by: "loyalty.reward_staff",
      inputs: { entry: { type: "loyalty.Earning" }, reason: { type: "text" } },
      description: message(
        "Reverse one original ledger entry with a reason, preserving its immutable evidence.",
      ),
    },
    "loyalty.cancel": {
      read: false,
      handler: "cancel",
      by: "loyalty.reward_staff",
      inputs: { redemption: { type: "loyalty.Redemption" }, reason: { type: "text" } },
      description: message(
        "Release the snapshotted reservation once without altering earned-tier progress.",
        {
          nl: "Geef de vastgelegde reservering één keer vrij zonder de verdiende niveauvoortgang te veranderen.",
        },
      ),
    },
  },
  handlers: {
    "loyalty.earning": { handler: "earning", on: "loyalty.Sales.qualification" },
    "loyalty.notification": { handler: "notification", on: "loyalty.Mail.send.completed" },
  },
  pages: [
    { path: "/loyalty", render: loyaltyPage },
    { path: "/loyalty/fulfillment", render: fulfillmentPage },
    { path: "/loyalty/catalog", render: catalogPage },
  ],
  disabled: [
    "loyalty.Program.delete",
    "loyalty.Tier.delete",
    "loyalty.Reward.delete",
    "loyalty.Account.update",
    "loyalty.Account.delete",
  ],
};

export function canApp() {
  const crudWhen = {
    Program: async (c, row) =>
      await all(row.locations, (location) => can_work(c, c.actor, location)),
    Tier: async (c, row) =>
      await all(row.parent.locations, (location) => can_work(c, c.actor, location)),
    Reward: async (c, row) =>
      await all(row.parent.locations, (location) => can_work(c, c.actor, location)),
    Account: async (c, row) =>
      await all(row.parent.locations, (location) => can_work(c, c.actor, location)),
  };
  return {
    read: {
      "Program.read.1": (c, row) => hasRole(c, "public"),
      "Program.read.2": async (c, row) =>
        (hasRole(c, "loyalty.program_owner") || hasRole(c, "loyalty.reward_staff")) &&
        (await all(row.locations, (location) => can_work(c, c.actor, location))),
      "Tier.read.1": (c, row) => hasRole(c, "public"),
      "Reward.read.1": (c, row) => hasRole(c, "public") && row.active,
      "Reward.read.2": async (c, row) =>
        hasRole(c, "loyalty.program_owner") &&
        (await all(row.parent.locations, (location) => can_work(c, c.actor, location))),
      "Account.read.1": (c, row) =>
        hasRole(c, "authenticated") && same(row.contact.account, c.actor) && row.contact.verified,
      "Account.read.2": async (c, row) =>
        hasRole(c, "loyalty.reward_staff") &&
        (await all(row.parent.locations, (location) => can_work(c, c.actor, location))),
      "Earning.read.1": (c, row) =>
        hasRole(c, "authenticated") &&
        same(row.parent.contact.account, c.actor) &&
        row.parent.contact.verified,
      "Earning.read.2": async (c, row) =>
        hasRole(c, "loyalty.reward_staff") &&
        (await all(row.parent.parent.locations, (location) => can_work(c, c.actor, location))),
      "SourceEvidence.read.1": (c, row) =>
        hasRole(c, "authenticated") &&
        same(row.parent.contact.account, c.actor) &&
        row.parent.contact.verified,
      "SourceEvidence.read.2": async (c, row) =>
        hasRole(c, "loyalty.reward_staff") &&
        (await all(row.parent.parent.locations, (location) => can_work(c, c.actor, location))),
      "Redemption.read.1": (c, row) =>
        hasRole(c, "authenticated") &&
        same(row.parent.contact.account, c.actor) &&
        row.parent.contact.verified,
      "Redemption.read.2": async (c, row) =>
        hasRole(c, "loyalty.reward_staff") && (await can_work(c, c.actor, row.location)),
    },
    derives: {
      "Account.earned": (c, row) =>
        sum(
          records(c, "loyalty.Earning", { parent: row, where: (earning) => earning.tier }),
          (earning) => earning.points,
        ),
      "Account.available": async (c, row) =>
        int64(
          (await sum(records(c, "loyalty.Earning", { parent: row }), (earning) => earning.points)) -
            (await sum(
              records(c, "loyalty.Redemption", {
                parent: row,
                where: (redemption) => ["reserved", "fulfilled"].includes(redemption.state),
              }),
              (redemption) => redemption.cost,
            )),
        ),
      "Account.tier": (c, row) =>
        first(
          records(c, "loyalty.Tier", {
            parent: row.parent,
            where: (tier) => tier.threshold <= row.earned,
            order: ["-threshold"],
          }),
        ),
      "Account.next_tier": (c, row) =>
        first(
          records(c, "loyalty.Tier", {
            parent: row.parent,
            where: (tier) => tier.threshold > row.earned,
            order: ["threshold"],
          }),
        ),
      "Account.tier_span": (c, row) =>
        max([
          0n,
          int64(
            (row.next_tier?.threshold ?? row.tier?.threshold ?? 0n) - (row.tier?.threshold ?? 0n),
          ),
        ]),
      "Account.tier_progress": async (c, row) =>
        min([row.tier_span, await max([0n, int64(row.earned - (row.tier?.threshold ?? 0n))])]),
    },
    invariants: {
      "Program.require.1": async (c, row) =>
        (await count(row.locations)) > 0n &&
        (await count(row.products)) > 0n &&
        (await all(records(c, "loyalty.Reward", { parent: row }), (reward) =>
          all(reward.locations, (location) => any(row.locations, (item) => same(item, location))),
        )),
      "Reward.require.1": async (c, row) =>
        (await count(row.locations)) > 0n &&
        (await all(row.locations, (location) =>
          any(row.parent.locations, (item) => same(item, location)),
        )),
      "SourceEvidence.require.1": (c, row) => row.source === row.value.source,
      "Earning.require.1": (c, row) =>
        row.points !== 0n &&
        row.reason.trim() !== "" &&
        (row.qualification === null || same(row.qualification.parent, row.parent)) &&
        (row.reversal === null ||
          (same(row.reversal.parent, row.parent) &&
            row.reversal.reversal === null &&
            row.points === int64(-row.reversal.points) &&
            row.tier === row.reversal.tier)),
      "Account.require.1": (c, row) => same(row.contact.parent, row.customer),
      "Redemption.require.1": async (c, row) =>
        row.cost > 0n &&
        same(row.reward.parent, row.parent.parent) &&
        (await count(row.locations)) > 0n &&
        (await any(row.locations, (location) => same(location, row.location))),
    },
    locks: {
      "SourceEvidence.lock.1": { fields: ["source"] },
      "Earning.lock.1": {
        fields: ["source", "points", "reason", "reversal", "tier", "author", "qualification"],
      },
      "Redemption.lock.1": {
        fields: ["reward", "name", "instructions", "locations", "location", "cost", "source"],
      },
    },
    crudWhen,
    async createProgram(c, input) {
      check(hasRole(c, "loyalty.program_owner"), "forbidden");
      await create(c, "loyalty.Program", input, { when: crudWhen.Program });
    },
    async updateProgram(c, { record, changes }) {
      check(hasRole(c, "loyalty.program_owner"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Program });
    },
    async createTier(c, input) {
      check(hasRole(c, "loyalty.program_owner"), "forbidden");
      await create(c, "loyalty.Tier", input, { when: crudWhen.Tier });
    },
    async updateTier(c, { record, changes }) {
      check(hasRole(c, "loyalty.program_owner"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Tier });
    },
    async createReward(c, input) {
      check(hasRole(c, "loyalty.program_owner"), "forbidden");
      await create(c, "loyalty.Reward", input, { when: crudWhen.Reward });
    },
    async updateReward(c, { record, changes }) {
      check(hasRole(c, "loyalty.program_owner"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Reward });
    },
    async createAccount(c, input) {
      check(hasRole(c, "loyalty.reward_staff"), "forbidden");
      await create(c, "loyalty.Account", input, { when: crudWhen.Account });
    },
    async redeem(c, { account, reward, location }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        same(account.contact.account, c.actor) &&
          account.contact.verified &&
          account.parent.active &&
          reward.active &&
          same(reward.parent, account.parent) &&
          account.available >= reward.cost &&
          (await any(reward.locations, (item) => same(item, location))) &&
          (await any(account.parent.locations, (item) => same(item, location))),
      );
      const redemption = await create(c, "loyalty.Redemption", {
        parent: account,
        reward,
        name: reward.name,
        instructions: reward.instructions,
        locations: reward.locations,
        location,
        cost: reward.cost,
        source: c.operation.id,
      });
      const notice = await send(c, "loyalty.Mail.send", {
        to: account.contact.email,
        subject: format(c, message("Reward reserved", { nl: "Beloning gereserveerd" }), {
          locale: null,
        }),
        body: redemption.instructions,
      });
      await set(c, redemption, { notification_delivery: notice.id });
      return redemption;
    },
    async fulfill(c, { redemption, evidence }) {
      check(hasRole(c, "loyalty.reward_staff"), "forbidden");
      check(
        redemption.state === "reserved" &&
          evidence.trim() !== "" &&
          (await can_work(c, c.actor, redemption.location)),
      );
      await set(c, redemption, { state: "fulfilled", evidence, fulfilled_by: c.actor });
    },
    async cancel(c, { redemption, reason }) {
      check(hasRole(c, "loyalty.reward_staff"), "forbidden");
      check(
        redemption.state === "reserved" &&
          reason.trim() !== "" &&
          (await can_work(c, c.actor, redemption.location)),
      );
      await set(c, redemption, { state: "cancelled", evidence: reason, cancelled_by: c.actor });
    },
    async adjust(c, { account, points, reason, tier = false }) {
      check(hasRole(c, "loyalty.reward_staff"), "forbidden");
      check(
        points !== 0n &&
          reason.trim() !== "" &&
          (await all(account.parent.locations, (location) => can_work(c, c.actor, location))),
      );
      await create(c, "loyalty.Earning", {
        parent: account,
        source: format(c, "adjust:{id}", { id: c.operation.id }),
        points,
        reason,
        tier,
        author: c.actor,
      });
    },
    async reverse(c, { entry, reason }) {
      check(hasRole(c, "loyalty.reward_staff"), "forbidden");
      check(
        entry.reversal === null &&
          reason.trim() !== "" &&
          (await all(entry.parent.parent.locations, (location) =>
            can_work(c, c.actor, location),
          )) &&
          !(await any(records(c, "loyalty.Earning", { parent: entry.parent }), (item) =>
            same(item.reversal, entry),
          )),
      );
      await create(c, "loyalty.Earning", {
        parent: entry.parent,
        source: format(c, "reversal:{id}", { id: entry.id }),
        points: int64(-entry.points),
        reason,
        tier: entry.tier,
        author: c.actor,
        qualification: entry.qualification,
        reversal: entry,
      });
    },
    async earning(c, { event }) {
      for await (const account of records(c, "loyalty.Account", {
        where: (row) => row.customer.id === event.value.customer,
        limit: 100n,
      })) {
        const prior = await first(
          records(c, "loyalty.SourceEvidence", {
            parent: account,
            where: (item) => item.source === event.value.source,
            order: ["id"],
          }),
        );
        if (prior !== null) {
          check(
            prior.value.customer === event.value.customer &&
              same(prior.value.account, event.value.account) &&
              prior.value.location === event.value.location &&
              prior.value.product === event.value.product &&
              equalMoney(prior.value.amount, event.value.amount) &&
              compareInstant(prior.value.purchased_at, event.value.purchased_at) === 0 &&
              prior.value.attribution === event.value.attribution &&
              prior.value.exclusive_program === event.value.exclusive_program &&
              ((prior.value.attributed_at === null && event.value.attributed_at === null) ||
                (prior.value.attributed_at !== null &&
                  event.value.attributed_at !== null &&
                  compareInstant(prior.value.attributed_at, event.value.attributed_at) === 0)) &&
              prior.value.attribution_window === event.value.attribution_window,
          );
          if (event.value.revision === prior.value.revision)
            check(equalValue(c, "invoice.Qualification", prior.value, event.value));
          if (event.value.revision > prior.value.revision)
            await set(c, prior, {
              value: event.value,
              reversed: prior.reversed || event.value.milestone === "reversed",
            });
        } else {
          await create(c, "loyalty.SourceEvidence", {
            parent: account,
            source: event.value.source,
            value: event.value,
            reversed: event.value.milestone === "reversed",
          });
        }
        const evidence = await first(
          records(c, "loyalty.SourceEvidence", {
            parent: account,
            where: (item) => item.source === event.value.source,
            order: ["id"],
          }),
        );
        check(evidence !== null);
        if (!evidence.decided && evidence.value.milestone === "completed" && !evidence.reversed) {
          await set(c, evidence, { decided: true });
          if (
            account.parent.active &&
            account.parent.products.includes(evidence.value.product) &&
            (await any(
              account.parent.locations,
              (location) => location.id === evidence.value.location,
            ))
          ) {
            await create(c, "loyalty.Earning", {
              parent: account,
              source: format(c, "sale:{source}", { source: evidence.source }),
              points: account.parent.points_per_sale,
              reason: "Qualified completed sale",
              tier: true,
              qualification: evidence,
            });
          }
        }
        if (evidence.reversed) {
          await set(c, evidence, { decided: true });
          const earning = await first(
            records(c, "loyalty.Earning", {
              parent: account,
              where: (item) => same(item.qualification, evidence) && item.reversal === null,
              order: ["id"],
            }),
          );
          if (
            earning !== null &&
            !(await any(records(c, "loyalty.Earning", { parent: account }), (item) =>
              same(item.reversal, earning),
            ))
          ) {
            await create(c, "loyalty.Earning", {
              parent: account,
              source: format(c, "reversal:{id}", { id: earning.id }),
              points: int64(-earning.points),
              reason: "Source reversal",
              tier: earning.tier,
              qualification: evidence,
              reversal: earning,
            });
          }
        }
      }
    },
    async notification(c, { event }) {
      for await (const redemption of records(c, "loyalty.Redemption", {
        where: (row) => row.notification_delivery === event.delivery_id,
        limit: 1n,
      })) {
        await set(c, redemption, { notification: event.status });
      }
    },
  };
}

export async function loyaltyPage(c) {
  check(hasRole(c, "authenticated"), "forbidden");
  return renderPage(
    c,
    {
      owner: "loyalty",
      path: "/loyalty",
      title: message("My rewards", { nl: "Mijn beloningen" }),
      description: message(
        "View your point history and reserve an available manually fulfillable perk.",
        {
          nl: "Bekijk je puntengeschiedenis en reserveer een beschikbaar handmatig uitvoerbaar voordeel.",
        },
      ),
    },
    () =>
      card({
        context: c,
        title: message("Own earned and available points", {
          nl: "Eigen verdiende en beschikbare punten",
        }),
        children: [
          list({
            context: c,
            model: "loyalty.Account",
            where: (account) => same(account.contact.account, c.actor) && account.contact.verified,
            display: "split",
            renderRow: (account, v) => [
              metrics({
                context: v,
                result: account,
                fields: ["available", "earned", "tier_progress", "tier_span"],
              }),
              text({ context: v, values: [account.tier, account.next_tier] }),
              text({
                context: v,
                values: [
                  message(
                    "A negative available balance means points are owed; new rewards must be affordable",
                    {
                      nl: "Een negatief beschikbaar saldo betekent dat punten verschuldigd zijn; nieuwe beloningen moeten betaalbaar zijn",
                    },
                  ),
                ],
              }),
              tabs({
                context: v,
                selector: "loyalty.preferences.view",
                value: c.preferences.loyalty.view,
                children: [
                  tab({
                    context: v,
                    value: "rewards",
                    children: [
                      list({
                        context: v,
                        model: "loyalty.Reward",
                        parent: account.parent,
                        where: (reward) => reward.active,
                        columns: ["name", "cost", "locations"],
                        renderRow: (reward, rv) => [
                          content({ context: rv, value: reward.instructions }),
                          form({
                            context: rv,
                            operation: "loyalty.redeem",
                            arguments: { account, reward },
                          }),
                        ],
                      }),
                      table({
                        context: v,
                        model: "loyalty.Redemption",
                        parent: account,
                        columns: [
                          "name",
                          "cost",
                          "location",
                          "instructions",
                          "state",
                          "evidence",
                          "notification",
                        ],
                        filter: ["location", "state"],
                        defaults: {
                          location: c.preferences.loyalty.location,
                          state: c.preferences.loyalty.redemption_state,
                        },
                        display: "split",
                        renderRow: (redemption, rv) => [
                          text({
                            context: rv,
                            values: [
                              message(
                                "A failed or uncertain notification does not cancel this reservation",
                                {
                                  nl: "Een mislukte of onzekere melding annuleert deze reservering niet",
                                },
                              ),
                            ],
                          }),
                          history({ context: rv, record: redemption }),
                        ],
                      }),
                    ],
                  }),
                  tab({
                    context: v,
                    value: "history",
                    children: [
                      table({
                        context: v,
                        model: "loyalty.Earning",
                        parent: account,
                        columns: [
                          "points",
                          "tier",
                          "reason",
                          "source",
                          "reversal",
                          "author",
                          "qualification",
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
  );
}

export async function fulfillmentPage(c) {
  check(hasRole(c, "loyalty.reward_staff"), "forbidden");
  return renderPage(
    c,
    {
      owner: "loyalty",
      path: "/loyalty/fulfillment",
      title: fulfillmentCaption,
      description: message("Fulfill or cancel reserved perks with evidence.", {
        nl: "Voer gereserveerde voordelen uit of annuleer ze met bewijs.",
      }),
    },
    () => [
      card({
        context: c,
        title: fulfillmentCaption,
        children: [form({ context: c, operation: "loyalty.Account.create" })],
      }),
      card({
        context: c,
        title: message("Evidence and history", { nl: "Bewijs en geschiedenis" }),
        children: [
          table({
            context: c,
            model: "loyalty.Redemption",
            columns: [
              "parent",
              "name",
              "cost",
              "location",
              "instructions",
              "state",
              "evidence",
              "fulfilled_by",
              "cancelled_by",
              "notification",
            ],
            filter: ["location", "state"],
            defaults: {
              location: c.preferences.loyalty.location,
              state: c.preferences.loyalty.redemption_state,
            },
            renderRow: (redemption, v) => [
              actions({
                context: v,
                operations: ["loyalty.fulfill", "loyalty.cancel"],
                boundArgs: { redemption },
              }),
              history({ context: v, record: redemption }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Earning review and corrections", { nl: "Puntencontrole en correcties" }),
        children: [
          list({
            context: c,
            model: "loyalty.Account",
            display: "split",
            renderRow: (account, v) => [
              metrics({ context: v, result: account, fields: ["available", "earned"] }),
              form({ context: v, operation: "loyalty.adjust", arguments: { account } }),
              table({
                context: v,
                model: "loyalty.Earning",
                parent: account,
                columns: [
                  "points",
                  "tier",
                  "reason",
                  "source",
                  "reversal",
                  "author",
                  "qualification",
                ],
                renderRow: (entry, ev) => [
                  actions({ context: ev, operations: ["loyalty.reverse"], boundArgs: { entry } }),
                  history({ context: ev, record: entry }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function catalogPage(c) {
  check(hasRole(c, "loyalty.program_owner"), "forbidden");
  return renderPage(
    c,
    {
      owner: "loyalty",
      path: "/loyalty/catalog",
      title: programCaption,
      description: message("Set published program terms under the separate program-owner grant.", {
        nl: "Stel gepubliceerde programmavoorwaarden vast onder het afzonderlijke programma-eigenaarsrecht.",
      }),
    },
    () =>
      card({
        context: c,
        title: message("Program terms", { nl: "Programmavoorwaarden" }),
        children: [
          form({ context: c, operation: "loyalty.Program.create" }),
          list({
            context: c,
            model: "loyalty.Program",
            display: "split",
            renderRow: (program, v) => [
              edit({ context: v, operation: "loyalty.Program.update", record: program }),
              tabs({
                context: v,
                children: [
                  tab({
                    context: v,
                    caption: message("Tiers", { nl: "Niveaus" }),
                    children: [
                      form({
                        context: v,
                        operation: "loyalty.Tier.create",
                        arguments: { parent: program },
                      }),
                      list({
                        context: v,
                        model: "loyalty.Tier",
                        parent: program,
                        renderRow: (tier, tv) =>
                          edit({ context: tv, operation: "loyalty.Tier.update", record: tier }),
                      }),
                    ],
                  }),
                  tab({
                    context: v,
                    caption: rewards,
                    children: [
                      form({
                        context: v,
                        operation: "loyalty.Reward.create",
                        arguments: { parent: program },
                      }),
                      list({
                        context: v,
                        model: "loyalty.Reward",
                        parent: program,
                        renderRow: (reward, rv) =>
                          edit({ context: rv, operation: "loyalty.Reward.update", record: reward }),
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
  );
}

/* Test-only recipes and examples use DESIGN §13's deferred contract. No runner
 * or provisioning exists. Scope s resolves real records; cells read baseline state,
 * selectors override simultaneously, and observations reread post-invocation state.
 */
export const exampleImports = [
  { provider: "customer", member: "test_company", alias: "test_company" },
  { provider: "customer", member: "test_contact", alias: "test_contact" },
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_company, test_contact, test_site, test_worker } = imported;
  const perks = {
    model: "loyalty.Program",
    dependencies: [test_site],
    value: async (c, s) => ({
      name: "Perks",
      locations: [s.test_site],
      terms:
        "Enrolled customers earn points in each matching program, including cash-attributed sales",
      products: ["meeting", "membership"],
      points_per_sale: 10n,
    }),
  };
  const wallet = {
    model: "loyalty.Account",
    dependencies: [perks, test_company, test_contact],
    value: async (c, s) => ({ parent: s.perks, customer: s.test_company, contact: s.test_contact }),
  };
  const balance = {
    model: "loyalty.Earning",
    dependencies: [wallet],
    value: async (c, s) => ({
      parent: s.wallet,
      source: "sale:paid-booking",
      points: 100n,
      reason: "Qualified sale",
      tier: true,
    }),
  };
  const welcome = {
    model: "loyalty.Reward",
    dependencies: [perks, test_site],
    value: async (c, s) => ({
      parent: s.perks,
      name: "Welcome pack",
      cost: 60n,
      instructions: "Collect at reception",
      locations: [s.test_site],
    }),
  };
  const remote = {
    model: Location,
    dependencies: [],
    value: async (c, s) => ({
      name: "Annex",
      address: "8 Other Street",
      timezone: "Europe/Brussels",
      currency: "EUR",
      hours: "10:00–16:00",
      arrival: "Annex reception",
    }),
  };
  const bronze = {
    model: "loyalty.Tier",
    dependencies: [perks],
    value: async (c, s) => ({ parent: s.perks, name: "Bronze", threshold: 0n }),
  };
  const silver = {
    model: "loyalty.Tier",
    dependencies: [perks],
    value: async (c, s) => ({ parent: s.perks, name: "Silver", threshold: 100n }),
  };
  const gold = {
    model: "loyalty.Tier",
    dependencies: [perks],
    value: async (c, s) => ({ parent: s.perks, name: "Gold", threshold: 200n }),
  };
  const reservation = {
    model: "loyalty.Redemption",
    dependencies: [wallet, welcome, test_site],
    value: async (c, s) => ({
      parent: s.wallet,
      reward: s.welcome,
      name: "Welcome pack",
      instructions: "Collect at reception",
      locations: [s.test_site],
      location: s.test_site,
      cost: 60n,
      source: "reserved",
      notification_delivery: "notice",
    }),
  };
  const observed = {
    model: "loyalty.SourceEvidence",
    dependencies: [wallet, test_company, test_site],
    value: async (c, s) => ({
      parent: s.wallet,
      source: "sale",
      value: {
        source: "sale",
        revision: 1n,
        customer: s.test_company.id,
        account: s.self,
        location: s.test_site.id,
        product: "meeting",
        amount: money(100n, "EUR"),
        purchased_at: datetime("2026-10-01T00:00:00Z"),
        occurred: datetime("2026-10-02T00:00:00Z"),
        milestone: "completed",
        first_customer: false,
        history_known: false,
      },
      decided: true,
    }),
  };
  const credited = {
    model: "loyalty.Earning",
    dependencies: [wallet, observed],
    value: async (c, s) => ({
      parent: s.wallet,
      source: "sale:sale",
      points: 10n,
      reason: "Qualified completed sale",
      tier: true,
      qualification: s.observed,
    }),
  };
  const reversed = {
    model: "loyalty.Earning",
    dependencies: [wallet, observed, credited],
    value: async (c, s) => ({
      parent: s.wallet,
      source: "reversal:credited",
      points: -10n,
      reason: "Source reversal",
      tier: true,
      qualification: s.observed,
      reversal: s.credited,
    }),
  };
  return {
    perks,
    wallet,
    balance,
    welcome,
    remote,
    bronze,
    silver,
    gold,
    reservation,
    observed,
    credited,
    reversed,
    examples: [
      {
        operation: "loyalty.redeem",
        seed: [balance, bronze, silver, gold],
        dependencies: [wallet, welcome, test_site],
        inputs: async (c, s) => ({ account: s.wallet, reward: s.welcome, location: s.test_site }),
        selectors: ["as", "reward.cost", "wallet.contact.verified", "balance.points"],
        observations: [
          async (c, s) => s.wallet.available,
          async (c, s) => s.wallet.earned,
          async (c, s) => s.wallet.tier,
          async (c, s) => s.wallet.tier_progress,
          async (c, s) => s.wallet.tier_span,
          async (c, s) => s.result.cost,
          async (c, s) => s.result.instructions,
          async (c, s) => s.result.location,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", 60n, true, 100n],
            expected: async (c, s) => [
              40n,
              100n,
              s.silver,
              0n,
              100n,
              60n,
              "Collect at reception",
              s.test_site,
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 60n, true, 150n],
            expected: async (c, s) => [
              90n,
              150n,
              s.silver,
              50n,
              100n,
              60n,
              "Collect at reception",
              s.test_site,
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 60n, true, 250n],
            expected: async (c, s) => [
              190n,
              250n,
              s.gold,
              0n,
              0n,
              60n,
              "Collect at reception",
              s.test_site,
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 40n, true, 50n],
            expected: async (c, s) => [
              10n,
              50n,
              s.bronze,
              50n,
              100n,
              40n,
              "Collect at reception",
              s.test_site,
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 101n, true, 100n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 60n, false, 100n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 60n, true, -10n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", 60n, true, 100n],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "loyalty.redeem",
        seed: [balance],
        dependencies: [wallet, welcome, test_site],
        inputs: async (c, s) => ({ account: s.wallet, reward: s.welcome, location: s.test_site }),
        selectors: [
          "location",
          "reward.active",
          "wallet.parent.active",
          "wallet.contact.account",
          "request.account.version",
        ],
        observations: [async (c, s) => s.wallet.available],
        rows: [
          {
            dependencies: [remote],
            values: async (c, s) => [s.remote, true, true, s.self, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [s.test_site, false, true, s.self, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [s.test_site, true, false, s.self, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [s.test_site, true, true, s.other, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [s.test_site, true, true, s.self, 0n],
            error: "conflict",
          },
        ],
      },
      {
        operation: "loyalty.fulfill",
        seed: [balance, test_worker],
        dependencies: [reservation],
        inputs: async (c, s) => ({ redemption: s.reservation, evidence: "Delivered at reception" }),
        selectors: ["as", "redemption.state", "welcome.cost", "welcome.instructions"],
        observations: [
          async (c, s) => s.reservation.cost,
          async (c, s) => s.reservation.instructions,
          async (c, s) => s.reservation.state,
          async (c, s) => s.wallet.available,
          async (c, s) => s.wallet.earned,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", "reserved", 99n, "New instructions"],
            expected: async (c, s) => [60n, "Collect at reception", "fulfilled", 40n, 100n],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "loyalty.reward_staff",
              "fulfilled",
              60n,
              "Collect at reception",
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "reserved", 60n, "Collect at reception"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "loyalty.fulfill",
        seed: [test_worker],
        dependencies: [reservation],
        inputs: async (c, s) => ({ redemption: s.reservation, evidence: "Delivered at reception" }),
        selectors: ["as", "test_worker.active"],
        observations: [async (c, s) => s.reservation.state],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", false],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "loyalty.cancel",
        seed: [balance, test_worker],
        dependencies: [reservation],
        inputs: async (c, s) => ({ redemption: s.reservation, reason: "Perk unavailable" }),
        selectors: ["as", "redemption.state", "welcome.cost"],
        observations: [
          async (c, s) => s.wallet.available,
          async (c, s) => s.wallet.earned,
          async (c, s) => s.reservation.cost,
          async (c, s) => s.reservation.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", "reserved", 99n],
            expected: async (c, s) => [100n, 100n, 60n, "cancelled"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", "cancelled", 60n],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "loyalty.adjust",
        seed: [balance, test_worker],
        dependencies: [wallet],
        inputs: async (c, s) => ({
          account: s.wallet,
          points: 20n,
          reason: "Missed visit correction",
        }),
        selectors: ["as", "points", "tier", "reason"],
        observations: [async (c, s) => s.wallet.available, async (c, s) => s.wallet.earned],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", 20n, false, "Goodwill"],
            expected: async (c, s) => [120n, 100n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", 20n, true, "Missed visit correction"],
            expected: async (c, s) => [120n, 120n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", 0n, false, "Goodwill"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", 20n, false, " "],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 20n, true, "Missed visit correction"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "loyalty.adjust",
        seed: [test_worker],
        dependencies: [wallet],
        inputs: async (c, s) => ({ account: s.wallet, points: 20n, reason: "Goodwill" }),
        selectors: ["as", "test_worker.active"],
        observations: [async (c, s) => s.wallet.available],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff", false],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "loyalty.reverse",
        seed: [test_worker],
        dependencies: [credited],
        inputs: async (c, s) => ({ entry: s.credited, reason: "Credit entered in error" }),
        selectors: ["as"],
        observations: [
          async (c, s) => s.wallet.available,
          async (c, s) => s.wallet.earned,
          async (c, s) => await count(records(c, "loyalty.Earning", { parent: s.wallet })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff"],
            expected: async (c, s) => [0n, 0n, 2n],
          },
          { dependencies: [], values: async (c, s) => ["members"], error: "forbidden" },
        ],
      },
      {
        operation: "loyalty.reverse",
        seed: [test_worker, reversed],
        dependencies: [credited],
        inputs: async (c, s) => ({ entry: s.credited, reason: "Duplicate correction" }),
        selectors: ["as"],
        observations: [async (c, s) => s.wallet.available],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["loyalty.reward_staff"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "loyalty.earning",
        seed: [wallet],
        dependencies: [test_company, test_site],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "sale",
              revision: 1n,
              customer: s.test_company.id,
              account: s.self,
              location: s.test_site.id,
              product: "meeting",
              amount: money(100n, "EUR"),
              purchased_at: datetime("2026-10-01T00:00:00Z"),
              occurred: datetime("2026-10-02T00:00:00Z"),
              milestone: "completed",
              first_customer: false,
              history_known: false,
            },
          },
        }),
        selectors: [
          "event.value.milestone",
          "event.value.product",
          "event.value.location",
          "perks.active",
        ],
        observations: [
          async (c, s) => s.wallet.available,
          async (c, s) => s.wallet.earned,
          async (c, s) => await count(records(c, "loyalty.SourceEvidence", { parent: s.wallet })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["completed", "meeting", s.test_site.id, true],
            expected: async (c, s) => [10n, 10n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["completed", "membership", s.test_site.id, true],
            expected: async (c, s) => [10n, 10n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["paid", "meeting", s.test_site.id, true],
            expected: async (c, s) => [0n, 0n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["completed", "office", s.test_site.id, true],
            expected: async (c, s) => [0n, 0n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["completed", "meeting", "other-location", true],
            expected: async (c, s) => [0n, 0n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["completed", "meeting", s.test_site.id, false],
            expected: async (c, s) => [0n, 0n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["reversed", "meeting", s.test_site.id, true],
            expected: async (c, s) => [0n, 0n, 1n],
          },
        ],
      },
      {
        operation: "loyalty.earning",
        seed: [wallet],
        dependencies: [test_company, test_site],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "sale",
              revision: 1n,
              customer: s.test_company.id,
              account: s.self,
              location: s.test_site.id,
              product: "meeting",
              amount: money(100n, "EUR"),
              purchased_at: datetime("2026-10-01T00:00:00Z"),
              occurred: datetime("2026-10-02T00:00:00Z"),
              milestone: "completed",
              first_customer: false,
              history_known: false,
            },
          },
        }),
        selectors: [
          "event.value.exclusive_program",
          "event.value.attribution",
          "event.value.attributed_at",
          "event.value.attribution_window",
        ],
        observations: [async (c, s) => s.wallet.available, async (c, s) => s.wallet.earned],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [null, null, null, null],
            expected: async (c, s) => [10n, 10n],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "refer.Program:campaign",
              "share",
              datetime("2026-09-30T00:00:00Z"),
              2592000000n,
            ],
            expected: async (c, s) => [10n, 10n],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "affiliate.Partner:partner",
              "broker",
              datetime("2026-09-30T00:00:00Z"),
              2592000000n,
            ],
            expected: async (c, s) => [10n, 10n],
          },
        ],
      },
      {
        operation: "loyalty.earning",
        seed: [observed],
        dependencies: [observed],
        inputs: async (c, s) => ({ event: { value: s.observed.value } }),
        selectors: [
          "observed.value.revision",
          "event.value.revision",
          "observed.reversed",
          "event.value.milestone",
        ],
        observations: [
          async (c, s) => s.wallet.available,
          async (c, s) => await count(records(c, "loyalty.Earning", { parent: s.wallet })),
          async (c, s) => s.observed.value.revision,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [2n, 1n, false, "completed"],
            expected: async (c, s) => [0n, 0n, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => [1n, 2n, true, "completed"],
            expected: async (c, s) => [0n, 0n, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => [1n, 1n, false, "completed"],
            expected: async (c, s) => [0n, 0n, 1n],
          },
        ],
      },
      {
        operation: "loyalty.earning",
        dependencies: [test_company, test_site],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "sale",
              revision: 1n,
              customer: s.test_company.id,
              account: s.self,
              location: s.test_site.id,
              product: "meeting",
              amount: money(100n, "EUR"),
              purchased_at: datetime("2026-10-01T00:00:00Z"),
              occurred: datetime("2026-10-02T00:00:00Z"),
              milestone: "completed",
              first_customer: false,
              history_known: false,
            },
          },
        }),
        selectors: ["event.value.milestone"],
        observations: [
          async (c, s) => await count(records(c, "loyalty.Account", {})),
          async (c, s) => await count(records(c, "loyalty.Earning", {})),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["completed"],
            expected: async (c, s) => [0n, 0n],
          },
        ],
      },
      {
        operation: "loyalty.earning",
        seed: [credited, reservation],
        dependencies: [observed],
        inputs: async (c, s) => ({ event: { value: s.observed.value } }),
        selectors: ["event.value.revision", "event.value.milestone", "perks.active"],
        observations: [
          async (c, s) => s.wallet.available,
          async (c, s) => s.wallet.earned,
          async (c, s) => await count(records(c, "loyalty.Earning", { parent: s.wallet })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [1n, "completed", true],
            expected: async (c, s) => [-50n, 10n, 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => [2n, "reversed", false],
            expected: async (c, s) => [-60n, 0n, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => [1n, "reversed", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [0n, "completed", true],
            error: "validation",
          },
        ],
      },
      {
        operation: "loyalty.earning",
        seed: [reversed],
        dependencies: [observed],
        inputs: async (c, s) => ({ event: { value: s.observed.value } }),
        selectors: ["observed.reversed", "event.value.revision", "event.value.milestone"],
        observations: [
          async (c, s) => s.wallet.available,
          async (c, s) => s.wallet.earned,
          async (c, s) => await count(records(c, "loyalty.Earning", { parent: s.wallet })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [true, 2n, "reversed"],
            expected: async (c, s) => [0n, 0n, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => [true, 2n, "completed"],
            expected: async (c, s) => [0n, 0n, 2n],
          },
        ],
      },
      {
        operation: "loyalty.earning",
        seed: [credited],
        dependencies: [observed],
        inputs: async (c, s) => ({ event: { value: s.observed.value } }),
        selectors: ["event.value.revision", "event.value.product"],
        observations: [async (c, s) => s.wallet.available],
        rows: [{ dependencies: [], values: async (c, s) => [2n, "office"], error: "rule_failed" }],
      },
      {
        operation: "loyalty.notification",
        seed: [reservation],
        dependencies: [],
        inputs: async (c, s) => ({ event: { delivery_id: "notice", status: "failed" } }),
        selectors: ["event.status"],
        observations: [
          async (c, s) => s.reservation.state,
          async (c, s) => s.reservation.notification,
          async (c, s) => s.reservation.cost,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["failed"],
            expected: async (c, s) => ["reserved", "failed", 60n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["unknown"],
            expected: async (c, s) => ["reserved", "unknown", 60n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["succeeded"],
            expected: async (c, s) => ["reserved", "succeeded", 60n],
          },
        ],
      },
    ],
  };
}
