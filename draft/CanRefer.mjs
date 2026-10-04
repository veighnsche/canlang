import {
  all,
  app_url,
  addDuration,
  compareInstant,
  compareDate,
  datetime,
  equalValue,
  local_date,
  max,
  any,
  require as check,
  compareMoney,
  count,
  create,
  date,
  equalMoney,
  first,
  format,
  hasRole,
  money,
  negateMoney,
  records,
  same,
  send,
  set,
  subtractMoney,
  sum,
  min,
} from "@canlang/stdlib";
import {
  actions,
  card,
  copy,
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
} from "@canlang/ui";
import { can_work } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";
import { Customer, owns, has_role } from "./customer.mjs";
import { Partner } from "./affiliate.mjs";
export const Capture = "sales_attribution.Capture";
export const capture = "sales_attribution.capture";
export const Program = "refer.Program";
export const Advocate = "refer.Advocate";

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

const balances = message("Earned and paid rewards", { nl: "Verdiende en uitbetaalde beloningen" });

const programCaption = message("Referral program", { nl: "Verwijzingsprogramma" });

const creditCaption = message("Reward credit", { nl: "Beloningstegoed" });

const sourceCaption = message("Source reference", { nl: "Bronreferentie" });

const paidCaption = message("Payment date", { nl: "Betaaldatum" });

const methodCaption = message("Payment method", { nl: "Betaalmethode" });

const advocateOptions = (c) => ({
  where: (advocate) =>
    c.preferences.refer.program === null || same(advocate.parent, c.preferences.refer.program),
});

/* The actual Invoice owner produces Qualification from source milestones and its
 * payment ledger. Install the explicitly documented committed-event bindings;
 * no provider/ingress implementation is implied by these handwritten targets.
 */
const referralsPageDescriptor = {
  owner: "refer",
  path: "/referrals",
  title: message("Referrals", { nl: "Verwijzingen" }),
  description: message(
    "Share your configured referral destination and trace earned, paid and owed balances.",
    {
      nl: "Deel de ingestelde verwijzingsbestemming en volg verdiende, betaalde en verschuldigde saldi.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    check(hasRole(c, "authenticated") && c.actor.email_verified, "forbidden");
    return {};
  },
  render: referralsPage,
};

const workPageDescriptor = {
  owner: "refer",
  path: "/referrals/work",
  title: message("Referral rewards", { nl: "Verwijzingsbeloningen" }),
  description: message("Review cash rewards and evidence actual external settlement.", {
    nl: "Beoordeel geldbeloningen en leg bewijs van daadwerkelijke externe uitbetaling vast.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "refer.program_manager") || hasRole(c, "refer.finance"), "forbidden");
    return {};
  },
  render: workPage,
};

const sharePageDescriptor = {
  owner: "refer",
  path: "/referrals/share/{Advocate.id}",
  title: message("Referral invitation", { nl: "Verwijzingsuitnodiging" }),
  nav: "none",
  description: message(
    "A shared link discloses only its public code and configured destination; capture requires verified customer authority.",
    {
      nl: "Een gedeelde link toont alleen de openbare code en ingestelde bestemming; vastlegging vereist geverifieerde klantbevoegdheid.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    const { row } = routeBindings;
    check(row.parent.active, "forbidden");
    return { row };
  },
  render: sharePage,
};

export const appDefinition = {
  id: "CanRefer",
  uses: ["refer"],
  description: message(
    "Help workspace members and advocates earn fixed cash rewards for bringing in qualifying new workspace customers.",
    {
      nl: "Help werkplekleden en ambassadeurs vaste geldbeloningen te verdienen voor het aanbrengen van nieuwe klanten die aan de voorwaarden voldoen.",
    },
  ),
  packages: {
    refer: {
      description: message(
        "Credit fixed cash referrals from trusted qualification and record evidenced manual settlement.",
        {
          nl: "Ken vaste verwijzingsbeloningen toe op basis van vertrouwde kwalificatie en leg handmatige uitbetalingen met bewijs vast.",
        },
      ),
      roles: {
        program_manager: {
          id: "refer.program_manager",
          label: message("Program manager", { nl: "Programmabeheerder" }),
        },
        finance: { id: "refer.finance", label: message("Finance", { nl: "Financiën" }) },
      },
    },
    sales_attribution: {
      description: message(
        "Capture one verified customer choice for either an advocate or a contracted partner.",
        {
          nl: "Leg één geverifieerde klantkeuze vast voor een ambassadeur of een contractpartner.",
        },
      ),
    },
  },
  bindings: {
    "refer.Mail": { capability: "std.EmailV1", from: "deployment.mail" },
    "refer.Sales": { capability: "invoice.SalesV1", from: "deployment.qualified_sales" },
  },
  models: {
    "refer.Program": {
      label: programCaption,
      exported: true,
      readGrants: [
        { rule: "Program.read.1", fields: ["name", "reward", "destination", "active"] },
        { rule: "Program.read.2" },
      ],
      invariants: ["Program.require.1"],
      fields: {
        name: { type: "text" },
        locations: { type: Location, array: true, label: message("Locations", { nl: "Locaties" }) },
        products: {
          type: "text",
          array: true,
          requiredArray: true,
          label: message("Products", { nl: "Producten" }),
        },
        reward: { type: "money", label: message("Cash reward", { nl: "Geldbeloning" }) },
        destination: {
          type: "url",
          label: message("Referral destination", { nl: "Verwijzingsbestemming" }),
        },
        window: {
          type: "duration",
          default: 2592000000n,
          label: message("Attribution window", { nl: "Toewijzingstermijn" }),
        },
        active: { type: "bool", default: true },
      },
    },
    "refer.Advocate": {
      parent: "refer.Program",
      label: message("Advocate", { nl: "Ambassadeur" }),
      exported: true,
      readGrants: [
        { rule: "Advocate.read.1", fields: ["code", "parent"] },
        { rule: "Advocate.read.2" },
        { rule: "Advocate.read.3" },
      ],
      invariants: ["Advocate.require.1"],
      locks: ["Advocate.lock.1"],
      fields: {
        account: {
          type: "user",
          server: "actor",
          label: message("User account", { nl: "Gebruikersaccount" }),
        },
        email: { type: "email" },
        code: {
          type: "text",
          unique: true,
          label: message("Referral code", { nl: "Verwijzingscode" }),
        },
      },
      derived: {
        earned: {
          type: "money",
          handler: "Advocate.earned",
          label: message("Earned rewards", { nl: "Verdiende beloningen" }),
        },
        paid: {
          type: "money",
          handler: "Advocate.paid",
          label: message("Paid rewards", { nl: "Uitbetaalde beloningen" }),
        },
        owed: {
          type: "money",
          handler: "Advocate.owed",
          label: message("Owed rewards", { nl: "Verschuldigde beloningen" }),
        },
        available: {
          type: "money",
          handler: "Advocate.available",
          label: message("Available reward balance", { nl: "Beschikbaar beloningssaldo" }),
        },
      },
    },
    "refer.Credit": {
      parent: "refer.Advocate",
      label: creditCaption,
      readGrants: [{ rule: "Credit.read.1" }, { rule: "Credit.read.2" }],
      locks: ["Credit.lock.1"],
      fields: {
        source: { type: "text", unique: true, label: sourceCaption },
        customer: { type: "text", label: message("Customer reference", { nl: "Klantreferentie" }) },
        amount: { type: "money" },
        reversal: {
          type: "refer.Credit",
          nullable: true,
          label: message("Reversal reference", { nl: "Terugboekingsreferentie" }),
        },
        qualification: {
          type: "text",
          label: message("Qualification evidence", { nl: "Kwalificatiebewijs" }),
        },
      },
    },
    "refer.Settlement": {
      parent: "refer.Advocate",
      label: message("Cash settlement", { nl: "Uitbetaling" }),
      readGrants: [{ rule: "Settlement.read.1" }, { rule: "Settlement.read.2" }],
      locks: ["Settlement.lock.1"],
      unique: [{ fields: ["payment_source", "reference"] }],
      fields: {
        source: { type: "text", unique: true, label: sourceCaption },
        amount: { type: "money" },
        payment_source: { type: "text", label: message("Payment source", { nl: "Betaalbron" }) },
        reference: { type: "text" },
        paid: { type: "date", label: paidCaption },
        method: { type: "text", label: methodCaption },
        evidence: { type: "text" },
        author: {
          type: "user",
          server: "actor",
          label: message("Recorded by", { nl: "Vastgelegd door" }),
        },
      },
    },
    "refer.Allocation": {
      parent: "refer.Settlement",
      label: message("Payment allocation", { nl: "Betalingstoewijzing" }),
      readGrants: [{ rule: "Allocation.read.1" }, { rule: "Allocation.read.2" }],
      invariants: ["Allocation.require.1"],
      locks: ["Allocation.lock.1"],
      fields: { credit: { type: "refer.Credit", label: creditCaption }, amount: { type: "money" } },
    },
    "sales_attribution.Capture": {
      exported: true,
      parent: Customer,
      label: message("Captured attribution", { nl: "Vastgelegde toewijzing" }),
      readGrants: [{ rule: "Capture.read.1" }],
      invariants: ["Capture.require.1"],
      locks: ["Capture.lock.1"],
      fields: {
        advocate: { type: Advocate, nullable: true },
        partner: { type: Partner, nullable: true },
        code: { type: "text", label: message("Attribution code", { nl: "Toewijzingscode" }) },
        program: {
          type: "text",
          label: message("Exclusive program", { nl: "Exclusief programma" }),
        },
        account: { type: "user", server: "actor" },
        captured: {
          type: "datetime",
          server: "now",
          label: message("Capture time", { nl: "Vastleggingstijd" }),
        },
        window: {
          type: "duration",
          label: message("Attribution window", { nl: "Toewijzingstermijn" }),
        },
        source: {
          type: "text",
          unique: true,
          label: message("Capture reference", { nl: "Vastleggingsreferentie" }),
        },
      },
    },
    "refer.SourceEvidence": {
      label: message("Source qualification evidence", { nl: "Bronkwalificatiebewijs" }),
      readGrants: [{ rule: "SourceEvidence.read.1" }],
      locks: ["SourceEvidence.lock.1"],
      fields: {
        advocate: { type: Advocate },
        source: { type: "text", unique: true, label: sourceCaption },
        value: { type: "invoice.Qualification" },
        reversed: {
          type: "bool",
          default: false,
          label: message("Source disqualified", { nl: "Bron gediskwalificeerd" }),
        },
        reason: { type: "text", nullable: true },
      },
    },
  },
  preferences: {
    refer: {
      fields: {
        program: { type: "refer.Program", nullable: true, default: null, label: programCaption },
      },
    },
  },
  operations: {
    "refer.Program.create": {
      handler: "createProgram",
      kind: "create",
      model: "refer.Program",
      by: "refer.program_manager",
      read: false,
      inputs: {
        fields: ["name", "locations", "products", "reward", "destination", "window", "active"],
      },
      when: "Program",
    },
    "refer.Program.update": {
      handler: "updateProgram",
      kind: "update",
      model: "refer.Program",
      by: "refer.program_manager",
      read: false,
      inputs: {
        record: { type: "refer.Program" },
        changes: {
          fields: ["name", "locations", "products", "reward", "destination", "window", "active"],
        },
      },
      when: "Program",
    },
    "refer.join": {
      read: false,
      handler: "join",
      by: "authenticated",
      inputs: { program: { type: "refer.Program" } },
      label: message("Join program", { nl: "Deelnemen aan programma" }),
      description: message("Create your verified own advocate identity and public referral code.", {
        nl: "Maak je eigen geverifieerde ambassadeursidentiteit en openbare verwijzingscode aan.",
      }),
    },
    "refer.settle": {
      read: false,
      result: "refer.Settlement",
      handler: "settle",
      by: "refer.finance",
      inputs: {
        advocate: { type: "refer.Advocate" },
        amount: { type: "money" },
        payment_source: { type: "text", label: message("Payment source", { nl: "Betaalbron" }) },
        reference: { type: "text" },
        paid: { type: "date", label: paidCaption },
        method: { type: "text", label: methodCaption },
        evidence: { type: "text" },
      },
      label: message("Record cash settlement", { nl: "Uitbetaling vastleggen" }),
      description: message(
        "Allocate an affordable earned balance to external cash payment evidence once.",
        {
          nl: "Wijs een betaalbaar verdiend saldo eenmalig toe aan bewijs van een externe betaling.",
        },
      ),
    },
    "refer.reject_source": {
      read: false,
      handler: "rejectSource",
      by: "refer.program_manager",
      inputs: { evidence: { type: "refer.SourceEvidence" }, reason: { type: "text" } },
      label: message("Reject source qualification", { nl: "Bronkwalificatie afwijzen" }),
      description: message(
        "Reject an attributed source with an accountable reason while preserving all payment evidence.",
        {
          nl: "Wijs een toegewezen bron met een verantwoordbare reden af en behoud al het betalingsbewijs.",
        },
      ),
    },
    "sales_attribution.capture": {
      exported: true,
      read: false,
      handler: "capture",
      by: "authenticated",
      result: Capture,
      inputs: {
        customer: { type: Customer },
        advocate: { type: Advocate, nullable: true, default: null },
        partner: { type: Partner, nullable: true, default: null },
      },
      label: message("Use attribution code", { nl: "Toewijzingscode gebruiken" }),
      description: message(
        "Freeze the current origin policy only for your verified customer identity.",
        { nl: "Leg het huidige bronbeleid alleen vast voor je geverifieerde klantidentiteit." },
      ),
    },
  },
  pure: {
    "sales_attribution.latest_capture": {
      exported: true,
      handler: "latest_capture",
      inputs: {
        customer: { type: Customer },
        person: { type: "user" },
        location: { type: Location },
        product: { type: "text" },
      },
      result: { type: "sales_attribution.Capture", nullable: true },
    },
  },
  handlers: { "refer.qualify": { handler: "qualify", on: "refer.Sales.qualification" } },
  pages: [
    referralsPageDescriptor,
    workPageDescriptor,
    sharePageDescriptor,
  ],
  disabled: ["refer.Program.delete"],
  compositions: {
    ReferralsPartners: {
      uses: ["CanRefer", "CanAffiliate"],
      description: message(
        "Trace qualifying referral rewards and broker commissions through distinct settlement evidence.",
        {
          nl: "Volg verwijzingsbeloningen en bemiddelingscommissies die aan de voorwaarden voldoen met afzonderlijk uitbetalingsbewijs.",
        },
      ),
    },
  },
};

export function canApp() {
  const crudWhen = {
    Program: async (c, row) =>
      await all(row.locations, (location) => can_work(c, c.actor, location)),
  };
  return {
    read: {
      "Program.read.1": (c, row) => hasRole(c, "public"),
      "Program.read.2": async (c, row) =>
        (hasRole(c, "refer.program_manager") || hasRole(c, "refer.finance")) &&
        (await all(row.locations, (location) => can_work(c, c.actor, location))),
      "Advocate.read.1": (c, row) => hasRole(c, "public"),
      "Capture.read.1": async (c, row) =>
        hasRole(c, "authenticated") &&
        same(row.account, c.actor) &&
        (await owns(c, c.actor, row.parent) ||
          await has_role(c, c.actor, row.parent, "administrator") ||
          await has_role(c, c.actor, row.parent, "booker")),
      "SourceEvidence.read.1": async (c, row) =>
        (hasRole(c, "refer.program_manager") || hasRole(c, "refer.finance")) &&
        (await all(row.advocate.parent.locations, (location) => can_work(c, c.actor, location))),
      "Advocate.read.2": (c, row) =>
        hasRole(c, "authenticated") && c.actor.email_verified && same(row.account, c.actor),
      "Advocate.read.3": async (c, row) =>
        (hasRole(c, "refer.program_manager") || hasRole(c, "refer.finance")) &&
        (await all(row.parent.locations, (location) => can_work(c, c.actor, location))),
      "Credit.read.1": (c, row) =>
        hasRole(c, "authenticated") && c.actor.email_verified && same(row.parent.account, c.actor),
      "Credit.read.2": async (c, row) =>
        (hasRole(c, "refer.program_manager") || hasRole(c, "refer.finance")) &&
        (await all(row.parent.parent.locations, (location) => can_work(c, c.actor, location))),
      "Settlement.read.1": (c, row) =>
        hasRole(c, "authenticated") && c.actor.email_verified && same(row.parent.account, c.actor),
      "Settlement.read.2": async (c, row) =>
        hasRole(c, "refer.finance") &&
        (await all(row.parent.parent.locations, (location) => can_work(c, c.actor, location))),
      "Allocation.read.1": (c, row) =>
        hasRole(c, "authenticated") &&
        c.actor.email_verified &&
        same(row.parent.parent.account, c.actor),
      "Allocation.read.2": async (c, row) =>
        hasRole(c, "refer.finance") &&
        (await all(row.parent.parent.parent.locations, (location) =>
          can_work(c, c.actor, location),
        )),
    },
    derives: {
      "Advocate.earned": (c, row) =>
        sum(
          records(c, "refer.Credit", { parent: row }),
          (credit) => credit.amount,
          row.parent.reward.currency,
        ),
      "Advocate.paid": (c, row) =>
        sum(
          records(c, "refer.Settlement", { parent: row }),
          (settlement) => settlement.amount,
          row.parent.reward.currency,
        ),
      "Advocate.available": async (c, row) =>
        max([money(0n, row.parent.reward.currency), subtractMoney(row.earned, row.paid)]),
      "Advocate.owed": async (c, row) =>
        max([money(0n, row.parent.reward.currency), subtractMoney(row.paid, row.earned)]),
    },
    invariants: {
      "Program.require.1": async (c, row) =>
        row.reward.minor > 0n &&
        row.destination.startsWith("https://") &&
        row.window > 0n &&
        row.locations.length > 0 &&
        row.products.length > 0 &&
        (await all(
          records(c, "refer.Credit", { where: (credit) => same(credit.parent.parent, row) }),
          (credit) => credit.amount.currency === row.reward.currency,
        )),
      "Advocate.require.1": async (c, row) =>
        !(await any(
          records(c, Advocate),
          (advocate) => !same(advocate, row) && advocate.code === row.code,
        )),
      "Capture.require.1": (c, row) =>
        (row.advocate !== null && row.partner === null) ||
        (row.advocate === null && row.partner !== null),
      "Allocation.require.1": async (c, row) =>
        row.amount.currency === row.credit.amount.currency &&
        row.amount.minor > 0n &&
        same(row.credit.parent, row.parent.parent) &&
        compareMoney(
          await sum(
            records(c, "refer.Allocation", { where: (a) => same(a.credit, row.credit) }),
            (a) => a.amount,
            row.amount.currency,
          ),
          row.credit.amount,
        ) <= 0,
    },
    locks: {
      "Capture.lock.1": {
        fields: [
          "advocate",
          "partner",
          "code",
          "program",
          "account",
          "captured",
          "window",
          "source",
        ],
      },
      "Advocate.lock.1": { fields: ["account", "email", "code"] },
      "SourceEvidence.lock.1": { fields: ["advocate", "source"] },
      "Credit.lock.1": { fields: ["source", "customer", "amount", "reversal", "qualification"] },
      "Settlement.lock.1": {
        fields: [
          "payment_source",
          "source",
          "amount",
          "reference",
          "paid",
          "method",
          "evidence",
          "author",
        ],
      },
      "Allocation.lock.1": { fields: ["credit", "amount"] },
    },
    crudWhen,
    latest_capture,
    async createProgram(c, input) {
      check(hasRole(c, "refer.program_manager"), "forbidden");
      await create(c, "refer.Program", input, { when: crudWhen.Program });
    },
    async updateProgram(c, { record, changes }) {
      check(hasRole(c, "refer.program_manager"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Program });
    },
    async join(c, { program }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(
        c.actor.email_verified &&
          program.active &&
          !(await any(records(c, "refer.Advocate", { parent: program }), (advocate) =>
            same(advocate.account, c.actor),
          )),
      );
      await create(c, "refer.Advocate", {
        parent: program,
        email: c.actor.email,
        account: c.actor,
        code: c.operation.id,
      });
    },
    async capture(c, { customer, advocate = null, partner = null }) {
      check(hasRole(c, "authenticated"), "forbidden");
      check(c.actor.email_verified && customer.active);
      check(
        owns(c, c.actor, customer) ||
          has_role(c, c.actor, customer, "administrator") ||
          has_role(c, c.actor, customer, "booker"),
      );
      check((advocate !== null && partner === null) || (advocate === null && partner !== null));
      if (advocate !== null) {
        check(advocate.parent.active && !same(advocate.account, c.actor));
        const captured = await create(c, Capture, {
          parent: customer,
          advocate,
          account: c.actor,
          code: advocate.code,
          program: format(c, "refer.Program:{id}", { id: advocate.parent.id }),
          captured: c.now,
          window: advocate.parent.window,
          source: c.operation.id,
        });
        return captured;
      }
      check(partner.active && !same(partner.account, c.actor));
      const captured = await create(c, Capture, {
        parent: customer,
        partner,
        account: c.actor,
        code: partner.id,
        program: format(c, "affiliate.Partner:{id}", { id: partner.id }),
        captured: c.now,
        window: partner.window,
        source: c.operation.id,
      });
      return captured;
    },
    async settle(c, { advocate, amount, payment_source, reference, paid, method, evidence }) {
      check(hasRole(c, "refer.finance"), "forbidden");
      check(
        amount.currency === advocate.parent.reward.currency &&
          amount.minor > 0n &&
          payment_source.trim() !== "" &&
          reference.trim() !== "" &&
          method.trim() !== "" &&
          evidence.trim() !== "" &&
          compareDate(paid, local_date(c.now, c.team.timezone)) <= 0 &&
          (await all(advocate.parent.locations, (location) => can_work(c, c.actor, location))),
      );
      const existing = await first(
        records(c, "refer.Settlement", {
          where: (settlement) =>
            settlement.payment_source === payment_source && settlement.reference === reference,
          order: ["id"],
        }),
      );
      if (existing !== null) {
        check(
          same(existing.parent, advocate) &&
            equalMoney(existing.amount, amount) &&
            compareDate(existing.paid, paid) === 0 &&
            existing.method === method &&
            existing.evidence === evidence,
        );
        return existing;
      }
      check(compareMoney(amount, advocate.available) <= 0);
      const settlement = await create(c, "refer.Settlement", {
        parent: advocate,
        source: c.operation.id,
        amount,
        payment_source,
        reference,
        paid,
        method,
        evidence,
        author: c.actor,
      });
      for await (const credit of records(c, "refer.Credit", {
        parent: advocate,
        where: (item) => item.amount.minor > 0n,
        order: ["created"],
        limit: 500n,
      })) {
        const remaining = subtractMoney(
          amount,
          await sum(
            records(c, "refer.Allocation", { parent: settlement }),
            (allocation) => allocation.amount,
            amount.currency,
          ),
        );
        const unpaid = subtractMoney(
          credit.amount,
          await sum(
            records(c, "refer.Allocation", {
              where: (allocation) => same(allocation.credit, credit),
            }),
            (allocation) => allocation.amount,
            amount.currency,
          ),
        );
        const part = await min([remaining, unpaid]);
        if (part.minor > 0n)
          await create(c, "refer.Allocation", { parent: settlement, credit, amount: part });
      }
      check(
        equalMoney(
          await sum(
            records(c, "refer.Allocation", { parent: settlement }),
            (allocation) => allocation.amount,
            amount.currency,
          ),
          amount,
        ),
      );
      return settlement;
    },
    async qualify(c, { event }) {
      const prior = await first(
        records(c, "refer.SourceEvidence", {
          where: (evidence) => evidence.source === event.value.source,
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
      }
      for await (const advocate of records(c, Advocate, {
        where: (advocate) => advocate.code === event.value.attribution,
        limit: 1n,
      })) {
        check(
          event.value.revision > 0n &&
            event.value.exclusive_program ===
              format(c, "refer.Program:{id}", { id: advocate.parent.id }) &&
            !same(event.value.account, advocate.account) &&
            event.value.amount.currency === advocate.parent.reward.currency,
        );
        if (prior === null)
          await create(c, "refer.SourceEvidence", {
            advocate,
            source: event.value.source,
            value: event.value,
            reversed: event.value.milestone === "reversed",
          });
        else {
          check(same(prior.advocate, advocate));
          if (event.value.revision > prior.value.revision)
            await set(c, prior, {
              value: event.value,
              reversed: prior.reversed || event.value.milestone === "reversed",
            });
        }
        const evidence = await first(
          records(c, "refer.SourceEvidence", {
            where: (evidence) => evidence.source === event.value.source,
            order: ["id"],
          }),
        );
        check(evidence !== null);
        if (event.value.revision === evidence.value.revision) {
          const credit = await first(
            records(c, "refer.Credit", {
              parent: advocate,
              where: (credit) => credit.source === event.value.source && credit.reversal === null,
              order: ["id"],
            }),
          );
          if (credit !== null) check(credit.customer === event.value.customer);
          if (
            evidence.reversed ||
            (credit !== null && (!event.value.first_customer || !event.value.history_known))
          ) {
            await set(c, evidence, { reversed: true });
            if (
              credit !== null &&
              !(await any(records(c, "refer.Credit", { parent: advocate }), (item) =>
                same(item.reversal, credit),
              ))
            )
              await create(c, "refer.Credit", {
                parent: advocate,
                source: format(c, "{source}:reversal", { source: credit.source }),
                customer: credit.customer,
                amount: negateMoney(credit.amount),
                reversal: credit,
                qualification: "Source disqualification",
              });
          } else if (
            ["completed", "cancellation_passed"].includes(event.value.milestone) &&
            event.value.first_customer &&
            event.value.history_known &&
            credit === null
          ) {
            check(
              advocate.parent.active &&
                advocate.parent.products.includes(event.value.product) &&
                (await any(
                  advocate.parent.locations,
                  (location) => location.id === event.value.location,
                )) &&
                event.value.amount.minor > 0n &&
                compareInstant(event.value.occurred, c.now) <= 0,
            );
            check(
              await any(
                records(c, Capture),
                (capture) =>
                  capture.parent.id === event.value.customer &&
                  same(capture.advocate, advocate) &&
                  capture.code === event.value.attribution &&
                  capture.program === event.value.exclusive_program &&
                  same(capture.account, event.value.account) &&
                  compareInstant(capture.captured, event.value.attributed_at) === 0 &&
                  capture.window === event.value.attribution_window &&
                  compareInstant(capture.captured, event.value.purchased_at) <= 0 &&
                  compareInstant(
                    event.value.purchased_at,
                    addDuration(capture.captured, capture.window),
                  ) <= 0 &&
                  compareInstant(event.value.purchased_at, event.value.occurred) <= 0,
              ),
            );
            if (
              !(await any(
                records(c, "refer.Credit"),
                (item) =>
                  item.customer === event.value.customer &&
                  same(item.parent.parent, advocate.parent) &&
                  item.reversal === null,
              ))
            ) {
              await create(c, "refer.Credit", {
                parent: advocate,
                source: event.value.source,
                customer: event.value.customer,
                amount: advocate.parent.reward,
                qualification: "Verified first paid customer and completed source",
              });
              await send(c, "refer.Mail.send", {
                to: advocate.email,
                subject: format(
                  c,
                  message("Referral qualified", { nl: "Verwijzing gekwalificeerd" }),
                  { locale: null },
                ),
                body: advocate.parent.name,
              });
            }
          }
        }
      }
    },
    async rejectSource(c, { evidence, reason }) {
      check(hasRole(c, "refer.program_manager"), "forbidden");
      check(
        (await all(evidence.advocate.parent.locations, (location) =>
          can_work(c, c.actor, location),
        )) && reason.trim() !== "",
      );
      await set(c, evidence, { reversed: true, reason });
      const credit = await first(
        records(c, "refer.Credit", {
          parent: evidence.advocate,
          where: (credit) => credit.source === evidence.source && credit.reversal === null,
          order: ["id"],
        }),
      );
      if (
        credit !== null &&
        !(await any(records(c, "refer.Credit", { parent: evidence.advocate }), (item) =>
          same(item.reversal, credit),
        ))
      )
        await create(c, "refer.Credit", {
          parent: evidence.advocate,
          source: format(c, "{source}:reversal", { source: credit.source }),
          customer: credit.customer,
          amount: negateMoney(credit.amount),
          reversal: credit,
          qualification: reason,
        });
    },
  };
}

export async function latest_capture(c, customer, person, location, product) {
  return first(
    records(c, Capture, {
      parent: customer,
      where: (capture) =>
        same(capture.account, person) &&
        compareInstant(addDuration(capture.captured, capture.window), c.now) >= 0 &&
        ((capture.advocate !== null &&
          capture.advocate.parent.active &&
          !same(capture.advocate.account, person) &&
          capture.advocate.parent.locations.some((item) => same(item, location)) &&
          capture.advocate.parent.products.includes(product)) ||
          (capture.partner !== null &&
            capture.partner.active &&
            !same(capture.partner.account, person) &&
            capture.partner.locations.some((item) => same(item, location)) &&
            capture.partner.products.includes(product))),
      order: ["-captured"],
    }),
  );
}

export async function sharePage(c, bindings) {
  const { row } = bindings;
  return renderPage(
    c,
    sharePageDescriptor,
    () => [
      text({ context: c, values: [row.code, row.parent.destination] }),
      form({ context: c, operation: capture, arguments: { advocate: row }, fields: ["customer"] }),
    ],
  );
}

export async function referralsPage(c, bindings) {
  return renderPage(
    c,
    referralsPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Programs and your referral code", {
          nl: "Programma's en je verwijzingscode",
        }),
        children: [
          list({
            context: c,
            model: "refer.Program",
            renderRow: (program, v) =>
              actions({ context: v, operations: ["refer.join"], boundArgs: { program } }),
          }),
          list({
            context: c,
            model: "refer.Advocate",
            where: (advocate) =>
              same(advocate.account, c.actor) &&
              (c.preferences.refer.program === null ||
                same(advocate.parent, c.preferences.refer.program)),
            renderRow: (advocate, v) => [
              copy({
                context: v,
                value: app_url(format(c, "/referrals/share/{id}", { id: advocate.id })),
              }),
              text({ context: v, values: [advocate.code, advocate.parent.destination] }),
              card({
                context: v,
                title: balances,
                children: [
                  metrics({
                    context: v,
                    result: advocate,
                    fields: ["earned", "paid", "available", "owed"],
                  }),
                ],
              }),
              tabs({
                context: v,
                children: [
                  tab({
                    context: v,
                    caption: message("Qualification and reversal evidence", {
                      nl: "Kwalificatie- en terugboekingsbewijs",
                    }),
                    children: [
                      table({
                        context: v,
                        model: "refer.Credit",
                        parent: advocate,
                        columns: ["source", "amount", "reversal", "qualification"],
                      }),
                    ],
                  }),
                  tab({
                    context: v,
                    caption: message("External payment evidence", {
                      nl: "Bewijs van externe betalingen",
                    }),
                    children: [
                      table({
                        context: v,
                        model: "refer.Settlement",
                        parent: advocate,
                        columns: [
                          "amount",
                          "payment_source",
                          "reference",
                          "paid",
                          "method",
                          "evidence",
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

export async function workPage(c, bindings) {
  return renderPage(
    c,
    workPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Program maintenance", { nl: "Programmabeheer" }),
        children: [
          form({ context: c, operation: "refer.Program.create" }),
          list({
            context: c,
            model: "refer.Program",
            renderRow: (program, v) =>
              edit({ context: v, operation: "refer.Program.update", record: program }),
          }),
        ],
      }),
      card({
        context: c,
        title: balances,
        children: [
          list({
            context: c,
            model: "refer.Advocate",
            ...advocateOptions(c),
            renderRow: (advocate, v) => [
              metrics({
                context: v,
                result: advocate,
                fields: ["earned", "paid", "available", "owed"],
              }),
              table({
                context: v,
                model: "refer.SourceEvidence",
                where: (source) => same(source.advocate, advocate),
                columns: [
                  "source",
                  "value.milestone",
                  "value.history_known",
                  "value.first_customer",
                  "reversed",
                  "reason",
                ],
                renderRow: (source, w) =>
                  actions({
                    context: w,
                    operations: ["refer.reject_source"],
                    boundArgs: { evidence: source },
                  }),
              }),
              card({
                context: v,
                title: message("Record a cash settlement", { nl: "Een uitbetaling vastleggen" }),
                children: [
                  form({ context: v, operation: "refer.settle", arguments: { advocate } }),
                ],
              }),
              history({ context: v, record: advocate }),
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
export const exampleImports = [
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "customer", member: "test_company", alias: "test_company" },
  { provider: "customer", member: "test_contact", alias: "test_contact" },
  { provider: "customer", member: "test_admin", alias: "test_admin" },
  { provider: "refer", member: "advocate", alias: "test_advocate" },
  { provider: "affiliate", member: "broker", alias: "test_broker" },
];

export function exampleFixtures({ self, other, imported }) {
  const {
    test_site,
    test_worker,
    test_company,
    test_contact,
    test_admin,
    test_advocate,
    test_broker,
  } = imported;
  const campaign = {
    model: Program,
    exported: true,
    dependencies: [test_site],
    value: async (c, s) => ({
      name: "Advocates",
      locations: [s.test_site],
      products: ["meeting", "membership"],
      reward: money(100n, "EUR"),
      destination: "https://example.test/",
    }),
  };
  const advocate = {
    model: Advocate,
    exported: true,
    dependencies: [campaign],
    value: async (c, s) => ({
      parent: s.campaign,
      account: s.other,
      email: "advocate@example.test",
      code: "share",
    }),
  };
  const captured = {
    model: Capture,
    exported: true,
    dependencies: [test_company, advocate],
    value: async (c, s) => ({
      parent: s.test_company,
      advocate: s.advocate,
      code: "share",
      program: format(c, "refer.Program:{id}", { id: s.campaign.id }),
      account: s.self,
      captured: datetime("2026-10-01T00:00:00Z"),
      window: 2592000000n,
      source: "capture",
    }),
  };
  const earned = {
    model: "refer.Credit",
    dependencies: [advocate],
    value: async (c, s) => ({
      parent: s.advocate,
      source: "sale",
      customer: "new-company",
      amount: money(100n, "EUR"),
      qualification: "Completed paid booking",
    }),
  };
  const reward_paid = {
    model: "refer.Settlement",
    dependencies: [advocate],
    value: async (c, s) => ({
      parent: s.advocate,
      payment_source: "operator-bank",
      source: "settled",
      amount: money(100n, "EUR"),
      reference: "external-1",
      paid: date("2026-10-03"),
      method: "Bank transfer",
      evidence: "Statement",
      author: s.self,
    }),
  };
  const qualificationValue = (c, s) => ({
    source: "sale",
    revision: 1n,
    customer: s.test_company.id,
    account: s.self,
    location: s.test_site.id,
    product: "meeting",
    amount: money(1000n, "EUR"),
    purchased_at: datetime("2026-10-01T01:00:00Z"),
    occurred: datetime("2026-10-02T00:00:00Z"),
    milestone: "completed",
    attribution: "share",
    exclusive_program: format(c, "refer.Program:{id}", { id: s.campaign.id }),
    attributed_at: datetime("2026-10-01T00:00:00Z"),
    attribution_window: 2592000000n,
    first_customer: true,
    history_known: true,
  });
  const observed = {
    model: "refer.SourceEvidence",
    dependencies: [advocate, test_company, test_site],
    value: async (c, s) => ({
      advocate: s.advocate,
      source: "sale",
      value: qualificationValue(c, s),
    }),
  };
  return {
    campaign,
    advocate,
    captured,
    earned,
    reward_paid,
    observed,
    examples: [
      {
        operation: "refer.settle",
        seed: [test_worker, earned],
        dependencies: [advocate],
        inputs: async (c, s) => ({
          advocate: s.advocate,
          payment_source: "operator-bank",
          reference: "external-1",
          paid: date("2026-10-03"),
          method: "Bank transfer",
          evidence: "Statement",
        }),
        selectors: ["as", "amount"],
        observations: [
          async (c, s) => s.advocate.available,
          async (c, s) => count(records(c, "refer.Settlement", { parent: s.advocate })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["refer.finance", money(100n, "EUR")],
            expected: async (c, s) => [money(0n, "EUR"), 1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["refer.finance", money(101n, "EUR")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["refer.program_manager", money(50n, "EUR")],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "refer.settle",
        seed: [test_worker, earned, reward_paid],
        dependencies: [advocate],
        inputs: async (c, s) => ({
          advocate: s.advocate,
          payment_source: "operator-bank",
          reference: "external-1",
          paid: date("2026-10-03"),
          method: "Bank transfer",
          evidence: "Statement",
        }),
        selectors: ["as", "amount"],
        observations: [
          async (c, s) => count(records(c, "refer.Settlement", { parent: s.advocate })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["refer.finance", money(100n, "EUR")],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["refer.finance", money(50n, "EUR")],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "refer.qualify",
        seed: [captured],
        dependencies: [test_company, test_site, advocate],
        inputs: async (c, s) => ({ event: { value: qualificationValue(c, s) } }),
        selectors: [
          "event.value.first_customer",
          "event.value.history_known",
          "event.value.product",
          "event.value.attributed_at",
        ],
        observations: [
          async (c, s) => count(records(c, "refer.Credit", { parent: s.advocate })),
          async (c, s) => s.advocate.available,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [true, true, "meeting", datetime("2026-10-01T00:00:00Z")],
            expected: async (c, s) => [1n, money(100n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => [false, true, "meeting", datetime("2026-10-01T00:00:00Z")],
            expected: async (c, s) => [0n, money(0n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => [true, false, "meeting", datetime("2026-10-01T00:00:00Z")],
            expected: async (c, s) => [0n, money(0n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => [true, true, "office", datetime("2026-10-01T00:00:00Z")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [true, true, "meeting", datetime("2026-09-01T00:00:00Z")],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "refer.qualify",
        seed: [earned, reward_paid],
        dependencies: [advocate, test_site],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "sale",
              revision: 2n,
              customer: "new-company",
              account: s.self,
              location: s.test_site.id,
              product: "meeting",
              amount: money(1000n, "EUR"),
              purchased_at: datetime("2026-10-01T01:00:00Z"),
              occurred: datetime("2026-10-02T00:00:00Z"),
              milestone: "reversed",
              attribution: "share",
              exclusive_program: format(c, "refer.Program:{id}", { id: s.campaign.id }),
              attributed_at: datetime("2026-10-01T00:00:00Z"),
              attribution_window: 2592000000n,
              first_customer: true,
              history_known: true,
            },
          },
        }),
        selectors: ["event.value.milestone"],
        observations: [
          async (c, s) => count(records(c, "refer.Credit", { parent: s.advocate })),
          async (c, s) => s.advocate.available,
          async (c, s) => s.advocate.owed,
          async (c, s) => count(records(c, "refer.Settlement", { parent: s.advocate })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["reversed"],
            expected: async (c, s) => [2n, money(0n, "EUR"), money(100n, "EUR"), 1n],
          },
        ],
      },
      {
        operation: "refer.qualify",
        seed: [captured, observed],
        dependencies: [observed],
        inputs: async (c, s) => ({ event: { value: s.observed.value } }),
        selectors: ["observed.reversed", "event.value.revision", "event.value.amount"],
        observations: [
          async (c, s) => count(records(c, "refer.Credit", { parent: s.advocate })),
          async (c, s) => s.advocate.available,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [false, 1n, money(1000n, "EUR")],
            expected: async (c, s) => [1n, money(100n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => [true, 2n, money(1000n, "EUR")],
            expected: async (c, s) => [0n, money(0n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => [false, 1n, money(999n, "EUR")],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "refer.qualify",
        seed: [captured, observed, earned],
        dependencies: [observed],
        inputs: async (c, s) => ({ event: { value: s.observed.value } }),
        selectors: ["earned.customer", "event.value.customer"],
        observations: [async (c, s) => count(records(c, "refer.Credit", { parent: s.advocate }))],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [s.test_company.id, s.test_company.id],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.test_company.id, "conflicting-customer"],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "refer.reject_source",
        seed: [test_worker, observed, earned],
        dependencies: [observed],
        inputs: async (c, s) => ({ evidence: s.observed, reason: "Duplicate attribution" }),
        selectors: ["as", "reason"],
        observations: [
          async (c, s) => s.evidence.reversed,
          async (c, s) => count(records(c, "refer.Credit", { parent: s.advocate })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["refer.program_manager", "Duplicate attribution"],
            expected: async (c, s) => [true, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["refer.program_manager", ""],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["refer.finance", "Duplicate attribution"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: capture,
        seed: [test_contact, test_admin],
        dependencies: [test_advocate, test_company],
        inputs: async (c, s) => ({ advocate: s.test_advocate, customer: s.test_company }),
        selectors: ["as", "advocate.account", "advocate.parent.active"],
        observations: [async (c, s) => count(records(c, Capture, { parent: s.customer }))],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, true],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, false],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["public", s.other, true],
            error: "forbidden",
          },
        ],
      },
      {
        operation: capture,
        seed: [test_contact, test_admin],
        dependencies: [test_broker, test_company],
        inputs: async (c, s) => ({ partner: s.test_broker, customer: s.test_company }),
        selectors: ["as", "partner.account", "partner.active"],
        observations: [async (c, s) => count(records(c, Capture, { parent: s.customer }))],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, true],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, false],
            error: "rule_failed",
          },
        ],
      },
    ],
  };
}
