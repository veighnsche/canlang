import {
  addMoney,
  all,
  any,
  require as check,
  compareMoney,
  count,
  create,
  first,
  equalMoney,
  compareDate,
  OperationOutcome,
  date,
  hasRole,
  int64,
  money,
  multiplyMoney,
  records,
  same,
  send,
  set,
  subtractMoney,
  sum,
} from "@canlang/stdlib";
import {
  actions,
  card,
  details,
  edit,
  form,
  history,
  list,
  message,
  metrics,
  renderPage,
  table,
  text,
} from "@canlang/ui";
import { can_work } from "./employee.mjs";
import { Location } from "./rent_catalog.mjs";
import { StockV1 } from "./stock.mjs";
import { budget_manager, buyer, Supplier } from "./supplier.mjs";

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

export const Receipt = "purchase.Receipt";
export const Return = "purchase.Return";
export const PayableEvidence = "purchase.PayableEvidence";
export const PayableEvidenceV1 = "purchase.PayableEvidenceV1";

const purchasingCaption = message("Purchasing", { nl: "Inkoop" });

const stateCaption = message("State", { nl: "Status" });

const approvedCaption = message("Approved", { nl: "Goedgekeurd" });

const cancelledCaption = message("Cancelled", { nl: "Geannuleerd" });

const closedCaption = message("Closed", { nl: "Afgesloten" });

const actualCaption = message("Actual spend", { nl: "Werkelijke uitgaven" });

const sourceCaption = message("Source reference", { nl: "Bronreferentie" });

const acceptedCaption = message("Accepted quantity", { nl: "Geaccepteerd aantal" });

const rejectedCaption = message("Rejected quantity", { nl: "Afgekeurd aantal" });

const receivedCaption = message("Received at", { nl: "Ontvangen op" });

const minePageDescriptor = {
  owner: "purchase",
  path: "/purchasing/mine",
  title: message("My requests", { nl: "Mijn aanvragen" }),
  description: message("Submit and follow your own purchase authorization.", {
    nl: "Dien je eigen inkoopautorisatie in en volg deze.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: minePage,
};

const purchasingPageDescriptor = {
  owner: "purchase",
  path: "/purchasing",
  title: purchasingCaption,
  description: message(
    "Maintain supplier records and view affordable commitments and actual spending.",
    { nl: "Beheer leveranciers en bekijk betaalbare toezeggingen en werkelijke uitgaven." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(
      hasRole(c, buyer) || hasRole(c, budget_manager) || hasRole(c, "purchase.approver"),
      "forbidden",
    );
    return {};
  },
  render: purchasingPage,
};

export const appDefinition = {
  id: "CanPurchase",
  uses: ["supplier", "purchase"],
  description: message(
    "Help workspace managers authorize furniture, supplies, repairs, and other spending against location or project budgets.",
    {
      nl: "Help werkplekmanagers meubels, benodigdheden, reparaties en andere uitgaven binnen locatie- of projectbudgetten te autoriseren.",
    },
  ),
  packages: {
    purchase: {
      label: purchasingCaption,
      description: message(
        "Own supplier identities, affordable purchase commitments, partial receipts and spending evidence.",
        {
          nl: "Beheer leveranciersidentiteiten, betaalbare inkooptoezeggingen, gedeeltelijke ontvangsten en uitgavenbewijs.",
        },
      ),
      roles: {
        approver: {
          id: "purchase.approver",
          label: message("Purchase approver", { nl: "Inkoopbeoordelaar" }),
        },
      },
    },
  },
  bindings: {
    "purchase.Stock": { capability: StockV1, from: "deployment.stock" },
    "purchase.Accounting": { capability: PayableEvidenceV1, from: "deployment.accounting" },
  },
  contracts: {
    [PayableEvidence]: {
      exported: true,
      fields: {
        source: { type: "text" },
        order: { type: "text" },
        supplier: { type: "text" },
        supplier_name: { type: "text" },
        supplier_contact: { type: "email" },
        location: { type: "text" },
        invoice: { type: "text" },
        amount: { type: "money" },
        issued: { type: "date" },
        evidence: { type: "text" },
        revision: { type: "int" },
      },
    },
  },
  capabilities: {
    [PayableEvidenceV1]: {
      exported: true,
      version: 1,
      operations: {
        record: { inputs: { value: { type: PayableEvidence } }, result: OperationOutcome },
      },
    },
  },
  models: {
    "purchase.Budget": {
      label: message("Budget", { nl: "Budget" }),
      fields: {
        name: { type: "text" },
        locations: {
          type: Location,
          array: true,
          default: [],
          label: message("Locations", { nl: "Locaties" }),
        },
        total: { type: "money" },
        active: { type: "bool", default: true },
      },
      derived: {
        committed: {
          type: "money",
          handler: "Budget.committed",
          label: message("Committed amount", { nl: "Vastgelegd bedrag" }),
        },
        spent: { type: "money", handler: "Budget.spent", label: actualCaption },
        remaining: {
          type: "money",
          handler: "Budget.remaining",
          label: message("Remaining", { nl: "Resterend" }),
        },
      },
      readGrants: [
        { rule: "Budget.read.1" },
        { rule: "Budget.read.2", fields: ["name", "active"] },
      ],
      invariants: ["Budget.require.1"],
    },
    "purchase.Request": {
      parent: "purchase.Budget",
      derived: {
        authorized: {
          type: "money",
          handler: "Request.authorized",
          label: message("Authorized amount", { nl: "Geautoriseerd bedrag" }),
        },
      },
      label: message("Purchase request", { nl: "Inkoopaanvraag" }),
      fields: {
        location: { type: Location },
        supplier: { type: Supplier },
        requester: {
          type: "user",
          server: "actor",
          label: message("Requester", { nl: "Aanvrager" }),
        },
        reviewer: { type: "user", label: message("Reviewer", { nl: "Beoordelaar" }) },
        purpose: { type: "text", label: message("Purpose", { nl: "Doel" }) },
        category: { type: "text", label: message("Category", { nl: "Categorie" }) },
        required_by: { type: "date", label: message("Required by", { nl: "Nodig op" }) },
        amount: { type: "money" },
        state: {
          type: "enum",
          cases: ["draft", "submitted", "approved", "rejected", "cancelled", "closed"],
          default: "draft",
          label: {
            text: stateCaption,
            values: {
              draft: message("Draft", { nl: "Concept" }),
              submitted: message("Submitted", { nl: "Ingediend" }),
              approved: approvedCaption,
              rejected: message("Rejected", { nl: "Afgewezen" }),
              cancelled: cancelledCaption,
              closed: closedCaption,
            },
          },
        },
        decision: { type: "text", nullable: true, label: message("Decision", { nl: "Besluit" }) },
        actual: { type: "money", nullable: true, label: actualCaption },
        evidence: { type: "text", nullable: true },
      },
      readGrants: [
        { rule: "Request.read.1" },
        { rule: "Request.read.2" },
        { rule: "Request.read.3" },
      ],
      invariants: ["Request.require.1"],
      locks: ["Request.lock.1", "Request.lock.2"],
    },
    "purchase.Order": {
      parent: "purchase.Request",
      label: message("Supplier order", { nl: "Leveranciersbestelling" }),
      fields: {
        reference: { type: "text", unique: true },
        supplier_name: {
          type: "text",
          label: message("Frozen supplier name", { nl: "Vastgelegde leveranciersnaam" }),
        },
        supplier_contact: {
          type: "email",
          label: message("Supplier email", { nl: "E-mailadres leverancier" }),
        },
        location: { type: Location },
        state: {
          type: "enum",
          cases: ["ordered", "part_received", "received", "cancelled", "closed"],
          default: "ordered",
          label: {
            text: stateCaption,
            values: {
              cancelled: cancelledCaption,
              closed: closedCaption,
              ordered: message("Ordered", { nl: "Besteld" }),
              part_received: message("Part received", { nl: "Gedeeltelijk ontvangen" }),
              received: message("Received", { nl: "Ontvangen" }),
            },
          },
        },
      },
      readGrants: [{ rule: "Order.read.1" }],
      invariants: ["Order.require.1"],
      locks: ["Order.lock.1"],
    },
    "purchase.Line": {
      parent: "purchase.Order",
      label: message("Line item", { nl: "Regel" }),
      fields: {
        sku: { type: "text", label: message("SKU", { nl: "SKU" }) },
        unit: { type: "text", label: message("Unit", { nl: "Eenheid" }) },
        quantity: { type: "int", min: 1n },
        unit_price: { type: "money", label: message("Unit price", { nl: "Eenheidsprijs" }) },
      },
      derived: {
        accepted: { type: "int", handler: "Line.accepted", label: acceptedCaption },
        ordered: {
          type: "int",
          handler: "Line.ordered",
          label: message("Ordered quantity", { nl: "Besteld aantal" }),
        },
      },
      readGrants: [{ rule: "Line.read.1" }],
      invariants: ["Line.require.1"],
      locks: ["Line.lock.1"],
    },
    [Receipt]: {
      parent: "purchase.Line",
      exported: true,
      derived: {
        returned: {
          type: "int",
          handler: "Receipt.returned",
          label: message("Returned quantity", { nl: "Geretourneerd aantal" }),
        },
      },
      label: message("Delivery receipt", { nl: "Ontvangstregistratie" }),
      fields: {
        revision: { type: "int", default: 1n },
        attempts: { type: "int", default: 0n, min: 0n, max: 3n },
        source: { type: "text", unique: true, label: sourceCaption },
        accepted: { type: "int", min: 0n, label: acceptedCaption },
        rejected: { type: "int", default: 0n, min: 0n, label: rejectedCaption },
        received: { type: "date", label: receivedCaption },
        evidence: { type: "text" },
        posting: {
          type: "enum",
          cases: ["pending", "confirmed", "failed", "unknown"],
          default: "pending",
          label: {
            text: message("Stock posting outcome", { nl: "Resultaat voorraadboeking" }),
            values: {
              pending: message("Pending", { nl: "In afwachting" }),
              confirmed: message("Confirmed", { nl: "Bevestigd" }),
              failed: message("Failed", { nl: "Mislukt" }),
              unknown: message("Unknown", { nl: "Onbekend" }),
            },
          },
        },
        delivery: {
          type: "text",
          nullable: true,
          label: message("Delivery reference", { nl: "Verzendingsreferentie" }),
        },
      },
      readGrants: [{ rule: "Receipt.read.1" }],
      invariants: ["Receipt.require.1", "Receipt.require.2"],
      locks: ["Receipt.lock.1"],
    },
    "purchase.Increase": {
      parent: "purchase.Request",
      label: message("Authorization increase", { nl: "Autorisatieverhoging" }),
      fields: {
        amount: { type: "money" },
        reason: { type: "text" },
        source: { type: "text", unique: true },
      },
      readGrants: [{ rule: "Increase.read.1" }],
      invariants: ["Increase.require.1"],
      locks: ["Increase.lock.1"],
    },
    "purchase.Amendment": {
      parent: "purchase.Line",
      label: message("Order amendment", { nl: "Bestelwijziging" }),
      fields: {
        quantity: { type: "int" },
        reason: { type: "text" },
        source: { type: "text", unique: true },
      },
      readGrants: [{ rule: "Amendment.read.1" }],
      invariants: ["Amendment.require.1"],
      locks: ["Amendment.lock.1"],
    },
    [Return]: {
      parent: Receipt,
      exported: true,
      label: message("Supplier return", { nl: "Leveranciersretour" }),
      fields: {
        source: { type: "text", unique: true },
        quantity: { type: "int", min: 1n },
        returned: { type: "date" },
        evidence: { type: "text" },
        revision: { type: "int", default: 1n },
        posting: { type: "purchase.Receipt.posting", default: "pending" },
        delivery: { type: "text", nullable: true },
        attempts: { type: "int", default: 0n, min: 0n, max: 3n },
      },
      readGrants: [{ rule: "Return.read.1" }],
      invariants: ["Return.require.1"],
      locks: ["Return.lock.1"],
    },
    "purchase.Payable": {
      parent: "purchase.Order",
      label: message("Supplier invoice evidence", { nl: "Leveranciersfactuurbewijs" }),
      fields: {
        source: { type: "text", unique: true },
        invoice: { type: "text" },
        amount: { type: "money" },
        issued: { type: "date" },
        evidence: { type: "text" },
        revision: { type: "int", default: 1n },
        posting: { type: "purchase.Receipt.posting", default: "pending" },
        delivery: { type: "text", nullable: true },
        attempts: { type: "int", default: 0n, min: 0n },
        reference: { type: "text", nullable: true },
      },
      readGrants: [{ rule: "Payable.read.1" }],
      invariants: ["Payable.require.1", "Payable.require.2"],
      locks: ["Payable.lock.1"],
      unique: [{ fields: ["invoice"] }],
    },
    "purchase.Adjustment": {
      parent: "purchase.Budget",
      label: message("Spending adjustment", { nl: "Uitgavenaanpassing" }),
      fields: {
        request: { type: "purchase.Request" },
        amount: { type: "money" },
        reason: { type: "text" },
        source: { type: "text", unique: true, label: sourceCaption },
      },
      readGrants: [{ rule: "Adjustment.read.1" }],
      invariants: ["Adjustment.require.1"],
      locks: ["Adjustment.lock.1"],
    },
  },
  preferences: {
    purchase: {
      validate: "preferencesValid",
      fields: {
        location: { type: Location, nullable: true, default: null },
        supplier: { type: Supplier, nullable: true, default: null },
        state: { type: "purchase.Request.state", nullable: true, default: null },
      },
    },
  },
  operations: {
    "purchase.Budget.create": {
      handler: "createBudget",
      kind: "create",
      model: "purchase.Budget",
      by: budget_manager,
      read: false,
      inputs: { fields: ["name", "locations", "total"] },
      when: "Budget",
    },
    "purchase.Budget.update": {
      handler: "updateBudget",
      kind: "update",
      model: "purchase.Budget",
      by: budget_manager,
      read: false,
      inputs: {
        record: { type: "purchase.Budget" },
        changes: { fields: ["name", "total", "active"] },
      },
      when: "Budget",
    },
    "purchase.Request.create": {
      handler: "createRequest",
      kind: "create",
      model: "purchase.Request",
      by: "members",
      read: false,
      inputs: {
        parent: { type: "purchase.Budget" },
        fields: [
          "location",
          "supplier",
          "reviewer",
          "purpose",
          "category",
          "required_by",
          "amount",
        ],
      },
      when: "Request",
    },
    "purchase.Request.update": {
      handler: "updateRequest",
      kind: "update",
      model: "purchase.Request",
      by: "members",
      read: false,
      inputs: {
        record: { type: "purchase.Request" },
        changes: {
          fields: [
            "location",
            "supplier",
            "reviewer",
            "purpose",
            "category",
            "required_by",
            "amount",
          ],
        },
      },
      when: "Request",
    },
    "purchase.Line.create": {
      handler: "createLine",
      kind: "create",
      model: "purchase.Line",
      by: buyer,
      read: false,
      inputs: {
        parent: { type: "purchase.Order" },
        fields: ["sku", "unit", "quantity", "unit_price"],
      },
      when: "Line",
    },
    "purchase.Line.update": {
      handler: "updateLine",
      kind: "update",
      model: "purchase.Line",
      by: buyer,
      read: false,
      inputs: {
        record: { type: "purchase.Line" },
        changes: { fields: ["sku", "unit", "quantity", "unit_price"] },
      },
      when: "Line",
    },
    "purchase.submit": {
      handler: "submit",
      by: "members",
      read: false,
      inputs: { request: { type: "purchase.Request" } },
      description: message("Submit frozen purchasing terms for one eligible reviewer.", {
        nl: "Dien vastgelegde inkoopvoorwaarden in voor één bevoegde beoordelaar.",
      }),
    },
    "purchase.decide": {
      handler: "decide",
      by: "purchase.approver",
      read: false,
      inputs: {
        request: { type: "purchase.Request" },
        approve: { type: "bool", label: approvedCaption },
        reason: { type: "text" },
      },
      label: message("Record decision", { nl: "Besluit vastleggen" }),
      description: message(
        "Reserve the approved amount atomically without self-review or budget overspend.",
        {
          nl: "Reserveer het goedgekeurde bedrag atomair, zonder zelfbeoordeling of budgetoverschrijding.",
        },
      ),
    },
    "purchase.order": {
      handler: "order",
      by: buyer,
      read: false,
      inputs: { request: { type: "purchase.Request" }, reference: { type: "text" } },
      label: message("Place supplier order", { nl: "Leveranciersbestelling plaatsen" }),
      description: message(
        "Issue one supplier order against an existing committed authorization.",
        { nl: "Plaats één leveranciersbestelling tegen een bestaande vastgelegde autorisatie." },
      ),
    },
    "purchase.receive": {
      handler: "receive",
      by: buyer,
      read: false,
      inputs: {
        line: { type: "purchase.Line" },
        source: { type: "text", label: sourceCaption },
        accepted: { type: "int", label: acceptedCaption },
        rejected: { type: "int", label: rejectedCaption },
        received: { type: "date", label: receivedCaption },
        evidence: { type: "text" },
      },
      result: Receipt,
      label: message("Record receipt", { nl: "Ontvangst registreren" }),
      description: message(
        "Accept a physical delivery once and replay its saved evidence without receiving it again.",
        {
          nl: "Accepteer een fysieke levering één keer en herhaal het opgeslagen bewijs zonder opnieuw te ontvangen.",
        },
      ),
    },
    "purchase.close": {
      handler: "close",
      by: budget_manager,
      read: false,
      inputs: {
        request: { type: "purchase.Request" },
        actual: { type: "money", label: actualCaption },
        evidence: { type: "text" },
      },
      label: message("Close spending", { nl: "Uitgaven afsluiten" }),
      description: message("Close evidenced actual spend; unused commitment returns once.", {
        nl: "Sluit bewezen werkelijke uitgaven af; ongebruikte toezegging keert één keer terug.",
      }),
    },
    "purchase.cancel": {
      handler: "cancel",
      by: budget_manager,
      read: false,
      inputs: {
        request: { type: "purchase.Request" },
        actual: { type: "money" },
        evidence: { type: "text" },
        reason: { type: "text" },
      },
      description: message(
        "Cancel the outstanding order while retaining received goods and evidenced spending.",
        { nl: "Annuleer het openstaande deel en behoud ontvangen goederen en bewezen uitgaven." },
      ),
    },
    "purchase.increase": {
      handler: "increase",
      by: budget_manager,
      read: false,
      inputs: {
        request: { type: "purchase.Request" },
        amount: { type: "money" },
        reason: { type: "text" },
      },
      description: message(
        "Authorize an affordable increase while preserving the original approval.",
        { nl: "Autoriseer een betaalbare verhoging en behoud de oorspronkelijke goedkeuring." },
      ),
    },
    "purchase.amend": {
      handler: "amend",
      by: buyer,
      read: false,
      inputs: {
        line: { type: "purchase.Line" },
        quantity: { type: "int" },
        reason: { type: "text" },
      },
      description: message("Append additional ordered units within the committed authorization.", {
        nl: "Voeg bestelde eenheden toe binnen de vastgelegde autorisatie.",
      }),
    },
    "purchase.return_goods": {
      handler: "return_goods",
      by: buyer,
      read: false,
      result: Return,
      inputs: {
        receipt: { type: Receipt },
        source: { type: "text" },
        quantity: { type: "int" },
        returned: { type: "date" },
        evidence: { type: "text" },
      },
      label: message("Return goods", { nl: "Goederen retourneren" }),
      description: message(
        "Record a linked supplier return and wait for its usable-stock reversal.",
        {
          nl: "Registreer een gekoppelde leveranciersretour en wacht op de terugboeking van bruikbare voorraad.",
        },
      ),
    },
    "purchase.record_payable": {
      handler: "record_payable",
      by: budget_manager,
      read: false,
      result: "purchase.Payable",
      inputs: {
        order: { type: "purchase.Order" },
        source: { type: "text" },
        invoice: { type: "text" },
        amount: { type: "money" },
        issued: { type: "date" },
        evidence: { type: "text" },
      },
      description: message(
        "Freeze supplier invoice evidence separately from customer invoices and payments.",
        { nl: "Leg leveranciersfactuurbewijs vast, gescheiden van klantfacturen en betalingen." },
      ),
    },
    "purchase.export_payable": {
      handler: "export_payable",
      by: budget_manager,
      read: false,
      inputs: { payable: { type: "purchase.Payable" } },
      description: message(
        "Export the frozen payable evidence to configured accounting without initiating payment.",
        {
          nl: "Exporteer het vastgelegde factuurbewijs naar ingestelde boekhouding zonder betaling te starten.",
        },
      ),
    },
    "purchase.retry_stock": {
      handler: "retry_stock",
      by: buyer,
      read: false,
      inputs: { receipt: { type: Receipt } },
      description: message(
        "Requeue the original receipt after resolving an exhausted stock delivery.",
        {
          nl: "Zet de oorspronkelijke ontvangst opnieuw klaar na herstel van een uitgeputte voorraadlevering.",
        },
      ),
    },
    "purchase.retry_return": {
      handler: "retry_return",
      by: buyer,
      read: false,
      inputs: { returned: { type: Return } },
      description: message(
        "Requeue a linked return without changing its source, quantity or evidence.",
        {
          nl: "Zet een gekoppelde retour opnieuw klaar zonder bron, aantal of bewijs te wijzigen.",
        },
      ),
    },
    "purchase.adjust": {
      handler: "adjust",
      by: budget_manager,
      read: false,
      inputs: {
        request: { type: "purchase.Request" },
        amount: { type: "money" },
        reason: { type: "text" },
      },
      label: message("Adjust spending", { nl: "Uitgaven aanpassen" }),
      description: message(
        "Record an attributed spend adjustment with the same affordability constraint.",
        {
          nl: "Registreer een herleidbare uitgavenaanpassing met dezelfde betaalbaarheidsvoorwaarde.",
        },
      ),
    },
  },
  handlers: {
    "purchase.stock_changed": {
      handler: "stock_changed",
      on: { capability: "purchase.Stock", event: "changed" },
    },
    "purchase.reconcile_stock": {
      handler: "reconcile_stock",
      on: { every: 300000n },
      description: message(
        "Retry one receipt and one return at a time with stable facts and bounded attempts.",
        {
          nl: "Herhaal telkens één ontvangst en één retour met vaste gegevens en begrensde pogingen.",
        },
      ),
    },
    "purchase.payable_result": {
      handler: "payable_result",
      on: { capability: "purchase.Accounting", operation: "record", event: "completed" },
    },
    "purchase.stock_result": {
      handler: "stock_result",
      on: { capability: "purchase.Stock", operation: "post", event: "completed" },
    },
  },
  pages: [
    minePageDescriptor,
    purchasingPageDescriptor,
  ],
  disabled: [
    "purchase.Budget.delete",
    "purchase.Request.delete",
    "purchase.Line.delete",
    "purchase.Order.create",
    "purchase.Order.update",
    "purchase.Order.delete",
    "purchase.Receipt.create",
    "purchase.Receipt.update",
    "purchase.Receipt.delete",
    "purchase.Increase.create",
    "purchase.Increase.update",
    "purchase.Increase.delete",
    "purchase.Amendment.create",
    "purchase.Amendment.update",
    "purchase.Amendment.delete",
    "purchase.Return.create",
    "purchase.Return.update",
    "purchase.Return.delete",
    "purchase.Payable.create",
    "purchase.Payable.update",
    "purchase.Payable.delete",
    "purchase.Adjustment.create",
    "purchase.Adjustment.update",
    "purchase.Adjustment.delete",
  ],
};

export function canApp() {
  const crudWhen = {
    Budget: async (c, row) =>
      await all(row.locations, (location) => can_work(c, c.actor, location)),
    Request: async (c, row) =>
      same(row.requester, c.actor) &&
      row.state === "draft" &&
      (await can_work(c, c.actor, row.location)),
    Line: async (c, row) =>
      (await can_work(c, c.actor, row.parent.location)) &&
      row.parent.state === "ordered" &&
      row.parent.parent.state === "approved" &&
      (await count(records(c, Receipt, { parent: row }))) === 0n,
  };
  return {
    // Evaluated by canonical CRUD admission against its normalized proposed row
    // with a stable newly allocated ID; children of a new Line are empty.
    crudWhen,
    preferencesValid: async (c, row) =>
      row.location === null || (await can_work(c, c.actor, row.location)),
    read: {
      "Budget.read.2": async (c, row) =>
        hasRole(c, "members") &&
        row.active &&
        (await any(row.locations, (location) => can_work(c, c.actor, location))),
      "Budget.read.1": async (c, row) =>
        (hasRole(c, budget_manager) || hasRole(c, "purchase.approver")) &&
        (await any(row.locations, (location) => can_work(c, c.actor, location))),
      "Request.read.1": (c, row) => hasRole(c, "members") && same(row.requester, c.actor),
      "Request.read.2": async (c, row) =>
        hasRole(c, "purchase.approver") &&
        same(row.reviewer, c.actor) &&
        (await can_work(c, c.actor, row.location)) &&
        row.state !== "draft",
      "Request.read.3": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.location)),
      "Order.read.1": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.location)),
      "Line.read.1": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.parent.location)),
      "Receipt.read.1": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Increase.read.1": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.parent.location)),
      "Amendment.read.1": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.parent.parent.location)),
      "Return.read.1": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.parent.parent.parent.location)),
      "Payable.read.1": async (c, row) =>
        (hasRole(c, buyer) || hasRole(c, budget_manager)) &&
        (await can_work(c, c.actor, row.parent.location)),
      "Adjustment.read.1": async (c, row) =>
        hasRole(c, budget_manager) &&
        (await any(row.parent.locations, (location) => can_work(c, c.actor, location))),
    },
    derives: {
      "Budget.committed": (c, row) =>
        sum(
          records(c, "purchase.Request", {
            parent: row,
            where: (request) => request.state === "approved",
          }),
          (request) => request.authorized,
          row.total.currency,
        ),
      "Budget.spent": async (c, row) =>
        addMoney(
          await sum(
            records(c, "purchase.Request", {
              parent: row,
              where: (request) => request.state === "closed",
            }),
            (request) => request.actual ?? money(0n, row.total.currency),
            row.total.currency,
          ),
          await sum(
            records(c, "purchase.Adjustment", { parent: row }),
            (adjustment) => adjustment.amount,
            row.total.currency,
          ),
        ),
      "Budget.remaining": (c, row) =>
        subtractMoney(subtractMoney(row.total, row.committed), row.spent),
      "Request.authorized": async (c, row) =>
        addMoney(
          row.amount,
          await sum(
            records(c, "purchase.Increase", { parent: row }),
            (increase) => increase.amount,
            row.amount.currency,
          ),
        ),
      "Line.ordered": async (c, row) =>
        int64(
          row.quantity +
            (await sum(
              records(c, "purchase.Amendment", { parent: row }),
              (amendment) => amendment.quantity,
            )),
        ),
      "Receipt.returned": (c, row) =>
        sum(records(c, Return, { parent: row }), (returned) => returned.quantity),
      "Line.accepted": (c, row) =>
        sum(records(c, Receipt, { parent: row }), (receipt) => receipt.accepted),
    },
    invariants: {
      "Budget.require.1": (c, row) => row.total.minor >= 0n && row.remaining.minor >= 0n,
      "Request.require.1": async (c, row) =>
        row.amount.minor > 0n &&
        row.amount.currency === row.parent.total.currency &&
        (await any(row.parent.locations, (location) => same(row.location, location))) &&
        (await any(row.supplier.locations, (location) => same(row.location, location))),
      "Order.require.1": async (c, row) =>
        compareMoney(
          await sum(
            records(c, "purchase.Line", { parent: row }),
            (line) => multiplyMoney(line.unit_price, line.ordered),
            row.parent.amount.currency,
          ),
          row.parent.authorized,
        ) <= 0,
      "Adjustment.require.1": async (c, row) =>
        same(row.request.parent, row.parent) &&
        row.request.state === "closed" &&
        compareMoney(
          money(0n, row.amount.currency),
          addMoney(
            row.request.actual ?? money(0n, row.amount.currency),
            await sum(
              records(c, "purchase.Adjustment", {
                parent: row.parent,
                where: (adjustment) => same(adjustment.request, row.request),
              }),
              (adjustment) => adjustment.amount,
              row.amount.currency,
            ),
          ),
        ) <= 0,
      "Line.require.1": (c, row) =>
        row.unit_price.currency === row.parent.parent.amount.currency &&
        row.unit_price.minor >= 0n &&
        row.accepted <= row.ordered,
      "Receipt.require.1": (c, row) =>
        int64(row.accepted + row.rejected) > 0n &&
        row.evidence.trim() !== "" &&
        row.returned <= row.accepted,
      "Receipt.require.2": async (c, row) =>
        !(await any(
          records(c, Receipt),
          (other) => !same(other, row) && other.source === row.source,
        )) && !(await any(records(c, Return), (returned) => returned.source === row.source)),
      "Return.require.1": async (c, row) =>
        !(await any(
          records(c, Return),
          (other) => !same(other, row) && other.source === row.source,
        )) &&
        !(await any(records(c, Receipt), (receipt) => receipt.source === row.source)) &&
        row.evidence.trim() !== "",
      "Increase.require.1": (c, row) =>
        row.amount.currency === row.parent.amount.currency &&
        row.amount.minor > 0n &&
        row.reason.trim() !== "",
      "Amendment.require.1": (c, row) => row.quantity > 0n && row.reason.trim() !== "",
      "Payable.require.2": async (c, row) =>
        !(await any(
          records(c, "purchase.Payable"),
          (other) => !same(other, row) && other.source === row.source,
        )),
      "Payable.require.1": (c, row) =>
        row.amount.currency === row.parent.parent.amount.currency &&
        row.amount.minor >= 0n &&
        row.invoice.trim() !== "" &&
        row.evidence.trim() !== "",
    },
    locks: {
      "Request.lock.1": {
        fields: [
          "location",
          "supplier",
          "requester",
          "reviewer",
          "purpose",
          "category",
          "required_by",
          "amount",
        ],
        when: (c, row) => row.state !== "draft",
      },
      "Request.lock.2": {
        fields: ["state", "actual", "evidence", "decision"],
        when: (c, row) => row.state === "closed",
      },
      "Order.lock.1": { fields: ["reference", "supplier_name", "supplier_contact", "location"] },
      "Line.lock.1": {
        fields: ["sku", "unit", "quantity", "unit_price"],
        when: async (c, row) => (await count(records(c, Receipt, { parent: row }))) > 0n,
      },
      "Receipt.lock.1": {
        fields: ["source", "accepted", "rejected", "received", "evidence", "revision"],
      },
      "Increase.lock.1": { fields: ["amount", "reason", "source"] },
      "Amendment.lock.1": { fields: ["quantity", "reason", "source"] },
      "Return.lock.1": { fields: ["source", "quantity", "returned", "evidence", "revision"] },
      "Payable.lock.1": {
        fields: ["source", "invoice", "amount", "issued", "evidence", "revision"],
      },
      "Adjustment.lock.1": { fields: ["request", "amount", "reason", "source"] },
    },
    async createBudget(c, input) {
      check(hasRole(c, budget_manager), "forbidden");
      await create(c, "purchase.Budget", input, { when: crudWhen.Budget });
    },
    async updateBudget(c, { record, changes }) {
      check(hasRole(c, budget_manager), "forbidden");
      await set(c, record, changes, { when: crudWhen.Budget });
    },
    async createRequest(c, input) {
      check(hasRole(c, "members"), "forbidden");
      await create(c, "purchase.Request", input, { when: crudWhen.Request });
    },
    async updateRequest(c, { record, changes }) {
      check(hasRole(c, "members"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Request });
    },
    async createLine(c, input) {
      check(hasRole(c, buyer), "forbidden");
      await create(c, "purchase.Line", input, { when: crudWhen.Line });
    },
    async updateLine(c, { record, changes }) {
      check(hasRole(c, buyer), "forbidden");
      await set(c, record, changes, { when: crudWhen.Line });
    },
    async submit(c, { request }) {
      check(hasRole(c, "members"), "forbidden");
      check(
        same(request.requester, c.actor) &&
          request.state === "draft" &&
          request.supplier.active &&
          (await any(request.supplier.locations, (location) => same(request.location, location))) &&
          (await can_work(c, c.actor, request.location)) &&
          !same(request.reviewer, c.actor) &&
          (await can_work(c, request.reviewer, request.location)),
      );
      await set(c, request, { state: "submitted" });
    },
    async decide(c, { request, approve, reason }) {
      check(hasRole(c, "purchase.approver"), "forbidden");
      check(
        same(request.reviewer, c.actor) &&
          !same(request.requester, c.actor) &&
          request.state === "submitted" &&
          (await can_work(c, c.actor, request.location)) &&
          reason.trim() !== "",
      );
      if (approve) {
        check(request.parent.active && compareMoney(request.amount, request.parent.remaining) <= 0);
        await set(c, request, { state: "approved", decision: reason });
      } else await set(c, request, { state: "rejected", decision: reason });
    },
    async order(c, { request, reference }) {
      check(hasRole(c, buyer), "forbidden");
      check(
        (await can_work(c, c.actor, request.location)) &&
          request.state === "approved" &&
          request.supplier.active &&
          (await count(records(c, "purchase.Order", { parent: request }))) === 0n,
      );
      await create(c, "purchase.Order", {
        parent: request,
        reference,
        supplier_name: request.supplier.name,
        supplier_contact: request.supplier.contact,
        location: request.location,
      });
    },
    async increase(c, { request, amount, reason }) {
      check(hasRole(c, budget_manager), "forbidden");
      check(
        request.state === "approved" &&
          !same(request.requester, c.actor) &&
          (await can_work(c, c.actor, request.location)) &&
          request.parent.active &&
          amount.currency === request.amount.currency &&
          amount.minor > 0n &&
          compareMoney(amount, request.parent.remaining) <= 0 &&
          reason.trim() !== "",
      );
      await create(c, "purchase.Increase", {
        parent: request,
        amount,
        reason,
        source: c.operation.id,
      });
    },
    async amend(c, { line, quantity, reason }) {
      check(hasRole(c, buyer), "forbidden");
      check(
        (await can_work(c, c.actor, line.parent.location)) &&
          line.parent.parent.state === "approved" &&
          ["ordered", "part_received", "received"].includes(line.parent.state) &&
          quantity > 0n &&
          reason.trim() !== "",
      );
      await create(c, "purchase.Amendment", {
        parent: line,
        quantity,
        reason,
        source: c.operation.id,
      });
      await set(c, line.parent, { state: "part_received" });
    },
    async receive(c, { line, source, accepted, rejected, received, evidence }) {
      check(hasRole(c, buyer), "forbidden");
      check(
        (await can_work(c, c.actor, line.parent.location)) &&
          source.trim() !== "" &&
          accepted >= 0n &&
          rejected >= 0n &&
          int64(accepted + rejected) > 0n &&
          evidence.trim() !== "",
      );
      const previous = await first(
        records(c, Receipt, { where: (receipt) => receipt.source === source, order: ["id"] }),
      );
      if (previous !== null) {
        check(
          same(previous.parent, line) &&
            previous.accepted === accepted &&
            previous.rejected === rejected &&
            compareDate(previous.received, received) === 0 &&
            previous.evidence === evidence,
        );
        return previous;
      }
      check(
        line.parent.parent.state === "approved" &&
          ["ordered", "part_received"].includes(line.parent.state) &&
          accepted <= int64(line.ordered - line.accepted),
      );
      const receipt = await create(c, Receipt, {
        parent: line,
        source,
        accepted,
        rejected,
        received,
        evidence,
      });
      if (accepted > 0n) {
        const delivery = await send(c, "purchase.Stock.post", {
          value: {
            source,
            order: line.parent.reference,
            sku: line.sku,
            unit: line.unit,
            location: line.parent.location.id,
            quantity: accepted,
            revision: receipt.revision,
            reversal: null,
          },
        });
        await set(c, receipt, { delivery: delivery.id, attempts: 1n });
      } else await set(c, receipt, { posting: "confirmed" });
      await set(c, line.parent, { state: "part_received" });
      if (
        await all(
          records(c, "purchase.Line", { parent: line.parent }),
          (item) => item.accepted === item.ordered,
        )
      )
        await set(c, line.parent, { state: "received" });
      return receipt;
    },
    async return_goods(c, { receipt, source, quantity, returned, evidence }) {
      check(hasRole(c, buyer), "forbidden");
      check(
        (await can_work(c, c.actor, receipt.parent.parent.location)) &&
          quantity > 0n &&
          source.trim() !== "" &&
          evidence.trim() !== "",
      );
      const previous = await first(
        records(c, Return, { where: (item) => item.source === source, order: ["id"] }),
      );
      if (previous !== null) {
        check(
          same(previous.parent, receipt) &&
            previous.quantity === quantity &&
            compareDate(previous.returned, returned) === 0 &&
            previous.evidence === evidence,
        );
        return previous;
      }
      check(
        receipt.posting === "confirmed" && quantity <= int64(receipt.accepted - receipt.returned),
      );
      const returned_goods = await create(c, Return, {
        parent: receipt,
        source,
        quantity,
        returned,
        evidence,
      });
      const delivery = await send(c, "purchase.Stock.post", {
        value: {
          source,
          order: receipt.parent.parent.reference,
          sku: receipt.parent.sku,
          unit: receipt.parent.unit,
          location: receipt.parent.parent.location.id,
          quantity: int64(-quantity),
          revision: returned_goods.revision,
          reversal: receipt.source,
        },
      });
      await set(c, returned_goods, { delivery: delivery.id, attempts: 1n });
      return returned_goods;
    },
    async close(c, { request, actual, evidence }) {
      check(hasRole(c, budget_manager), "forbidden");
      check(
        request.state === "approved" &&
          (await can_work(c, c.actor, request.location)) &&
          actual.currency === request.amount.currency &&
          actual.minor >= 0n &&
          compareMoney(actual, request.authorized) <= 0 &&
          evidence.trim() !== "",
      );
      await set(c, request, { state: "closed", actual, evidence });
      for await (const order of records(c, "purchase.Order", { parent: request, limit: 100n }))
        await set(c, order, { state: "closed" });
    },
    async cancel(c, { request, actual, evidence, reason }) {
      check(hasRole(c, budget_manager), "forbidden");
      check(
        request.state === "approved" &&
          (await can_work(c, c.actor, request.location)) &&
          actual.currency === request.amount.currency &&
          actual.minor >= 0n &&
          compareMoney(actual, request.authorized) <= 0 &&
          evidence.trim() !== "" &&
          reason.trim() !== "",
      );
      await set(c, request, { state: "closed", actual, evidence, decision: reason });
      for await (const order of records(c, "purchase.Order", { parent: request, limit: 100n }))
        await set(c, order, { state: "cancelled" });
    },
    async record_payable(c, { order, source, invoice, amount, issued, evidence }) {
      check(hasRole(c, budget_manager), "forbidden");
      check(
        (await can_work(c, c.actor, order.location)) &&
          order.parent.state === "closed" &&
          amount.currency === order.parent.amount.currency &&
          amount.minor >= 0n &&
          source.trim() !== "" &&
          invoice.trim() !== "" &&
          evidence.trim() !== "",
      );
      const previous = await first(
        records(c, "purchase.Payable", {
          parent: order,
          where: (payable) => payable.invoice === invoice,
          order: ["id"],
        }),
      );
      if (previous !== null) {
        check(
          previous.source === source &&
            equalMoney(previous.amount, amount) &&
            compareDate(previous.issued, issued) === 0 &&
            previous.evidence === evidence,
        );
        return previous;
      }
      check(
        compareMoney(
          addMoney(
            await sum(
              records(c, "purchase.Payable", { parent: order }),
              (payable) => payable.amount,
              amount.currency,
            ),
            amount,
          ),
          addMoney(
            order.parent.actual ?? money(0n, amount.currency),
            await sum(
              records(c, "purchase.Adjustment", {
                parent: order.parent.parent,
                where: (adjustment) => same(adjustment.request, order.parent),
              }),
              (adjustment) => adjustment.amount,
              amount.currency,
            ),
          ),
        ) <= 0,
      );
      return await create(c, "purchase.Payable", {
        parent: order,
        source,
        invoice,
        amount,
        issued,
        evidence,
      });
    },
    async export_payable(c, { payable }) {
      check(hasRole(c, budget_manager), "forbidden");
      check(
        (await can_work(c, c.actor, payable.parent.location)) && payable.posting !== "confirmed",
      );
      const delivery = await send(c, "purchase.Accounting.record", {
        value: {
          source: payable.source,
          order: payable.parent.reference,
          supplier: payable.parent.parent.supplier.id,
          supplier_name: payable.parent.supplier_name,
          supplier_contact: payable.parent.supplier_contact,
          location: payable.parent.location.id,
          invoice: payable.invoice,
          amount: payable.amount,
          issued: payable.issued,
          evidence: payable.evidence,
          revision: payable.revision,
        },
      });
      await set(c, payable, {
        delivery: delivery.id,
        posting: "pending",
        attempts: int64(payable.attempts + 1n),
      });
    },
    async adjust(c, { request, amount, reason }) {
      check(hasRole(c, budget_manager), "forbidden");
      check(
        request.state === "closed" &&
          (await can_work(c, c.actor, request.location)) &&
          amount.currency === request.parent.total.currency &&
          reason.trim() !== "",
      );
      await create(c, "purchase.Adjustment", {
        parent: request.parent,
        request,
        amount,
        reason,
        source: c.operation.id,
      });
    },
    async retry_stock(c, { receipt }) {
      check(hasRole(c, buyer), "forbidden");
      check(
        (await can_work(c, c.actor, receipt.parent.parent.location)) &&
          receipt.accepted > 0n &&
          receipt.posting !== "confirmed" &&
          receipt.attempts === 3n,
      );
      await set(c, receipt, { attempts: 0n, posting: "pending" });
    },
    async retry_return(c, { returned }) {
      check(hasRole(c, buyer), "forbidden");
      check(
        (await can_work(c, c.actor, returned.parent.parent.parent.location)) &&
          returned.posting !== "confirmed" &&
          returned.attempts === 3n,
      );
      await set(c, returned, { attempts: 0n, posting: "pending" });
    },
    async reconcile_stock(c, { event }) {
      const receipt = await first(
        records(c, Receipt, {
          where: (item) => item.accepted > 0n && item.posting !== "confirmed" && item.attempts < 3n,
          order: ["created"],
        }),
      );
      if (receipt !== null) {
        const delivery = await send(c, "purchase.Stock.post", {
          value: {
            source: receipt.source,
            order: receipt.parent.parent.reference,
            sku: receipt.parent.sku,
            unit: receipt.parent.unit,
            location: receipt.parent.parent.location.id,
            quantity: receipt.accepted,
            revision: receipt.revision,
            reversal: null,
          },
        });
        await set(c, receipt, {
          delivery: delivery.id,
          posting: "pending",
          attempts: int64(receipt.attempts + 1n),
        });
      }
      const returned = await first(
        records(c, Return, {
          where: (item) => item.posting !== "confirmed" && item.attempts < 3n,
          order: ["created"],
        }),
      );
      if (returned !== null) {
        const delivery = await send(c, "purchase.Stock.post", {
          value: {
            source: returned.source,
            order: returned.parent.parent.parent.reference,
            sku: returned.parent.parent.sku,
            unit: returned.parent.parent.unit,
            location: returned.parent.parent.parent.location.id,
            quantity: int64(-returned.quantity),
            revision: returned.revision,
            reversal: returned.parent.source,
          },
        });
        await set(c, returned, {
          delivery: delivery.id,
          posting: "pending",
          attempts: int64(returned.attempts + 1n),
        });
      }
    },
    async stock_result(c, { event }) {
      for await (const receipt of records(c, Receipt, {
        where: (item) => item.delivery === event.delivery_id && item.posting !== "confirmed",
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === receipt.source &&
          event.result.revision === receipt.revision &&
          event.result.state === "confirmed" &&
          event.result.reference !== null
        )
          await set(c, receipt, { posting: "confirmed" });
        else if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === receipt.source &&
          event.result.revision === receipt.revision &&
          event.result.state === "pending"
        )
          await set(c, receipt, { posting: "pending" });
        else if (event.status === "failed") await set(c, receipt, { posting: "failed" });
        else await set(c, receipt, { posting: "unknown" });
      }
      for await (const returned of records(c, Return, {
        where: (item) => item.delivery === event.delivery_id && item.posting !== "confirmed",
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === returned.source &&
          event.result.revision === returned.revision &&
          event.result.state === "confirmed" &&
          event.result.reference !== null
        )
          await set(c, returned, { posting: "confirmed" });
        else if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === returned.source &&
          event.result.revision === returned.revision &&
          event.result.state === "pending"
        )
          await set(c, returned, { posting: "pending" });
        else if (event.status === "failed") await set(c, returned, { posting: "failed" });
        else await set(c, returned, { posting: "unknown" });
      }
    },
    async stock_changed(c, { event }) {
      for await (const receipt of records(c, Receipt, {
        where: (item) =>
          item.source === event.value.source &&
          item.revision === event.value.revision &&
          item.posting !== "confirmed",
        limit: 1n,
      })) {
        if (event.value.state === "confirmed" && event.value.reference !== null)
          await set(c, receipt, { posting: "confirmed" });
        else if (event.value.state === "failed") await set(c, receipt, { posting: "failed" });
      }
      for await (const returned of records(c, Return, {
        where: (item) =>
          item.source === event.value.source &&
          item.revision === event.value.revision &&
          item.posting !== "confirmed",
        limit: 1n,
      })) {
        if (event.value.state === "confirmed" && event.value.reference !== null)
          await set(c, returned, { posting: "confirmed" });
        else if (event.value.state === "failed") await set(c, returned, { posting: "failed" });
      }
    },
    async payable_result(c, { event }) {
      for await (const payable of records(c, "purchase.Payable", {
        where: (item) => item.delivery === event.delivery_id && item.posting !== "confirmed",
        limit: 1n,
      })) {
        if (
          event.status === "succeeded" &&
          event.result !== null &&
          event.result.source === payable.source &&
          event.result.revision === payable.revision &&
          event.result.state === "confirmed" &&
          event.result.reference !== null
        )
          await set(c, payable, { posting: "confirmed", reference: event.result.reference });
        else if (event.status === "failed") await set(c, payable, { posting: "failed" });
        else await set(c, payable, { posting: "unknown" });
      }
    },
  };
}

/* PayableEvidenceV1.record retains source/digest identity, acknowledges identical
 * replay and rejects conflicting evidence. This draft includes configured
 * Accounting export and requires its real binding.
 * A deployment without that feature omits the bound import/export action in source.
 * There is no runtime optional binding or vendor payment instruction.
 * Stock ingress/causation and accounting serialization remain adapter obligations.
 * Buyer/reviewer work queues query Request directly. Complete Budget aggregates
 * require the full dependency grant; the UI must withhold partial cross-site totals.
 * Inline BDD and provider execution remain unimplemented authored expectations.
 */
export async function minePage(c, bindings) {
  return renderPage(
    c,
    minePageDescriptor,
    () => [
      card({
        context: c,
        title: message("Own requests", { nl: "Eigen aanvragen" }),
        children: [
          form({ context: c, operation: "purchase.Request.create" }),
          list({
            context: c,
            model: "purchase.Request",
            where: (request) => same(request.requester, c.actor),
            order: ["required_by"],
            filter: ["state", "location", "supplier"],
            defaults: {
              state: c.preferences.purchase.state,
              location: c.preferences.purchase.location,
              supplier: c.preferences.purchase.supplier,
            },
            display: "split",
            renderRow: (request, view) => [
              edit({ context: view, operation: "purchase.Request.update", record: request }),
              actions({ context: view, operations: ["purchase.submit"], boundArgs: { request } }),
              text({
                context: view,
                values: [
                  request.purpose,
                  request.amount,
                  request.required_by,
                  request.state,
                  request.decision,
                  request.actual,
                  request.evidence,
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function purchasingPage(c, bindings) {
  return renderPage(
    c,
    purchasingPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Supplier directory", { nl: "Leveranciersregister" }),
        children: [
          form({ context: c, operation: "supplier.Supplier.create" }),
          table({
            context: c,
            model: Supplier,
            columns: ["name", "contact", "locations", "active"],
            renderRow: (supplier, view) =>
              edit({ context: view, operation: "supplier.Supplier.update", record: supplier }),
          }),
        ],
      }),
      card({
        context: c,
        title: message("Review and order queue", { nl: "Beoordelings- en bestelwachtrij" }),
        children: [
          list({
            context: c,
            model: "purchase.Request",
            display: "split",
            filter: ["state", "location", "category", "supplier"],
            defaults: {
              state: c.preferences.purchase.state,
              location: c.preferences.purchase.location,
              supplier: c.preferences.purchase.supplier,
            },
            renderRow: (request, rv) => [
              text({
                context: rv,
                values: [
                  request.purpose,
                  request.amount,
                  request.authorized,
                  request.required_by,
                  request.state,
                  request.decision,
                ],
              }),
              details({
                context: rv,
                caption: message("Purchase authorization", { nl: "Inkoopautorisatie" }),
                record: request,
                display: "drawer",
                children: [
                  edit({ context: rv, operation: "purchase.Request.update", record: request }),
                  actions({
                    context: rv,
                    operations: [
                      "purchase.submit",
                      "purchase.decide",
                      "purchase.order",
                      "purchase.increase",
                      "purchase.close",
                      "purchase.cancel",
                      "purchase.adjust",
                    ],
                    boundArgs: { request },
                  }),
                  list({
                    context: rv,
                    model: "purchase.Order",
                    parent: request,
                    renderRow: (order, ov) => [
                      form({
                        context: ov,
                        operation: "purchase.Line.create",
                        arguments: { parent: order },
                      }),
                      actions({
                        context: ov,
                        operations: ["purchase.record_payable"],
                        boundArgs: { order },
                      }),
                      table({
                        context: ov,
                        model: "purchase.Payable",
                        parent: order,
                        columns: [
                          "invoice",
                          "amount",
                          "issued",
                          "evidence",
                          "posting",
                          "reference",
                        ],
                        renderRow: (payable, pv) =>
                          actions({
                            context: pv,
                            operations: ["purchase.export_payable"],
                            boundArgs: { payable },
                          }),
                      }),
                      table({
                        context: ov,
                        model: "purchase.Line",
                        parent: order,
                        columns: ["sku", "unit", "quantity", "ordered", "accepted", "unit_price"],
                        renderRow: (line, lv) => [
                          actions({
                            context: lv,
                            operations: ["purchase.amend"],
                            boundArgs: { line },
                          }),
                          edit({
                            context: lv,
                            operation: "purchase.Line.update",
                            record: line,
                          }),
                          form({
                            context: lv,
                            operation: "purchase.receive",
                            arguments: { line },
                          }),
                          table({
                            context: lv,
                            model: Receipt,
                            parent: line,
                            columns: [
                              "source",
                              "accepted",
                              "rejected",
                              "returned",
                              "received",
                              "posting",
                              "evidence",
                            ],
                            order: ["-received"],
                            renderRow: (receipt, rv) => [
                              actions({
                                context: rv,
                                operations: ["purchase.return_goods", "purchase.retry_stock"],
                                boundArgs: { receipt },
                              }),
                              table({
                                context: rv,
                                model: Return,
                                parent: receipt,
                                columns: ["source", "quantity", "returned", "evidence", "posting"],
                                renderRow: (returned, view) =>
                                  actions({
                                    context: view,
                                    operations: ["purchase.retry_return"],
                                    boundArgs: { returned },
                                  }),
                              }),
                              history({ context: rv, record: receipt }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  }),
                  history({ context: rv, record: request }),
                ],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Budget commitments", { nl: "Budgettoezeggingen" }),
        children: [
          form({ context: c, operation: "purchase.Budget.create" }),
          list({
            context: c,
            model: "purchase.Budget",
            display: "split",
            renderRow: (budget, view) => [
              metrics({
                context: view,
                result: budget,
                fields: ["total", "committed", "spent", "remaining"],
              }),
              edit({ context: view, operation: "purchase.Budget.update", record: budget }),
              form({
                context: view,
                operation: "purchase.Request.create",
                arguments: { parent: budget },
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
export const exampleImports = [
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_site, test_worker } = imported;
  const vendor = {
    model: "supplier.Supplier",
    dependencies: [test_site],
    value: async (c, s) => ({
      name: "Supplies",
      contact: "vendor@example.test",
      locations: [s.test_site],
    }),
  };
  const budget = {
    model: "purchase.Budget",
    dependencies: [test_site],
    value: async (c, s) => ({
      name: "Furniture",
      locations: [s.test_site],
      total: money(100n, "EUR"),
    }),
  };
  const submission = {
    model: "purchase.Request",
    dependencies: [budget, test_site, vendor],
    value: async (c, s) => ({
      parent: s.budget,
      location: s.test_site,
      supplier: s.vendor,
      requester: s.other,
      reviewer: s.self,
      purpose: "Chairs",
      category: "Equipment",
      required_by: date("2099-01-01"),
      amount: money(60n, "EUR"),
      state: "submitted",
    }),
  };
  const purchase_order = {
    model: "purchase.Order",
    dependencies: [submission, test_site],
    value: async (c, s) => ({
      parent: s.submission,
      reference: "PO-1",
      supplier_name: "Supplies",
      supplier_contact: "vendor@example.test",
      location: s.test_site,
    }),
  };
  const purchase_line = {
    model: "purchase.Line",
    dependencies: [purchase_order],
    value: async (c, s) => ({
      parent: s.purchase_order,
      sku: "boxes",
      unit: "box",
      quantity: 6n,
      unit_price: money(10n, "EUR"),
    }),
  };
  const goods_receipt = {
    model: "purchase.Receipt",
    dependencies: [purchase_line],
    value: async (c, s) => ({
      parent: s.purchase_line,
      source: "delivery-A",
      accepted: 2n,
      received: date("2099-01-02"),
      evidence: "Delivery A",
      posting: "confirmed",
    }),
  };
  const extra_authorization = {
    model: "purchase.Increase",
    dependencies: [submission],
    value: async (c, s) => ({
      parent: s.submission,
      amount: money(20n, "EUR"),
      reason: "More chairs",
      source: "authorization-2",
    }),
  };
  return {
    budget,
    extra_authorization,
    goods_receipt,
    purchase_line,
    purchase_order,
    submission,
    vendor,
    examples: [
      {
        operation: "purchase.decide",
        seed: [test_worker],
        dependencies: [submission],
        inputs: async (c, s) => ({ request: s.submission, approve: true, reason: "Within budget" }),
        selectors: ["as", "request.amount", "request.requester"],
        observations: [async (c, s) => s.request.state, async (c, s) => s.budget.remaining],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["purchase.approver", money(60n, "EUR"), s.other],
            expected: async (c, s) => ["approved", money(40n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.approver", money(101n, "EUR"), s.other],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.approver", money(60n, "EUR"), s.self],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", money(60n, "EUR"), s.other],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "purchase.increase",
        seed: [test_worker],
        dependencies: [submission],
        inputs: async (c, s) => ({ request: s.submission, reason: "Extra chairs" }),
        selectors: ["as", "request.state", "amount"],
        observations: [
          async (c, s) => s.request.amount,
          async (c, s) => s.request.authorized,
          async (c, s) => s.budget.remaining,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["purchase.budget_manager", "approved", money(20n, "EUR")],
            expected: async (c, s) => [money(60n, "EUR"), money(80n, "EUR"), money(20n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.budget_manager", "approved", money(41n, "EUR")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.budget_manager", "approved", money(20n, "USD")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "approved", money(20n, "EUR")],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "purchase.amend",
        seed: [extra_authorization, goods_receipt, test_worker],
        dependencies: [purchase_line],
        inputs: async (c, s) => ({ line: s.purchase_line, reason: "More boxes" }),
        selectors: ["as", "line.parent.parent.state", "quantity"],
        observations: [
          async (c, s) => s.line.quantity,
          async (c, s) => s.line.ordered,
          async (c, s) => s.line.accepted,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["purchase.buyer", "approved", 2n],
            expected: async (c, s) => [6n, 8n, 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.buyer", "approved", 3n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.buyer", "closed", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "approved", 1n],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "purchase.receive",
        seed: [goods_receipt, test_worker],
        dependencies: [purchase_line],
        inputs: async (c, s) => ({
          line: s.purchase_line,
          rejected: 0n,
          received: date("2099-01-02"),
        }),
        selectors: [
          "as",
          "line.parent.parent.state",
          "line.parent.state",
          "source",
          "accepted",
          "evidence",
        ],
        observations: [
          async (c, s) => await count(records(c, "purchase.Receipt")),
          async (c, s) => s.line.accepted,
          async (c, s) => s.line.parent.state,
          async (c, s) => s.result.posting,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.buyer",
              "approved",
              "part_received",
              "delivery-B",
              4n,
              "Delivery B",
            ],
            expected: async (c, s) => [2n, 6n, "received", "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.buyer",
              "closed",
              "cancelled",
              "delivery-A",
              2n,
              "Delivery A",
            ],
            expected: async (c, s) => [1n, 2n, "cancelled", "confirmed"],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.buyer",
              "approved",
              "part_received",
              "delivery-A",
              2n,
              "Changed proof",
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.buyer",
              "approved",
              "part_received",
              "delivery-B",
              5n,
              "Delivery B",
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "members",
              "approved",
              "part_received",
              "delivery-B",
              1n,
              "Delivery B",
            ],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "purchase.return_goods",
        seed: [goods_receipt, test_worker],
        dependencies: [goods_receipt],
        inputs: async (c, s) => ({
          receipt: s.goods_receipt,
          source: "return-A",
          returned: date("2099-01-03"),
          evidence: "Supplier return",
        }),
        selectors: ["as", "receipt.posting", "quantity"],
        observations: [
          async (c, s) => await count(records(c, "purchase.Return")),
          async (c, s) => s.receipt.accepted,
          async (c, s) => s.receipt.returned,
          async (c, s) => s.result.posting,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["purchase.buyer", "confirmed", 1n],
            expected: async (c, s) => [1n, 2n, 1n, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.buyer", "confirmed", 3n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.buyer", "pending", 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "confirmed", 1n],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "purchase.cancel",
        seed: [goods_receipt, test_worker],
        dependencies: [submission],
        inputs: async (c, s) => ({
          request: s.submission,
          evidence: "Accepted goods cost",
          reason: "Cancel outstanding boxes",
        }),
        selectors: ["as", "request.state", "actual"],
        observations: [
          async (c, s) => s.request.amount,
          async (c, s) => s.request.actual,
          async (c, s) => s.budget.committed,
          async (c, s) => s.budget.spent,
          async (c, s) => s.budget.remaining,
          async (c, s) => s.purchase_order.state,
          async (c, s) => s.goods_receipt.accepted,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["purchase.budget_manager", "approved", money(20n, "EUR")],
            expected: async (c, s) => [
              money(60n, "EUR"),
              money(20n, "EUR"),
              money(0n, "EUR"),
              money(20n, "EUR"),
              money(80n, "EUR"),
              "cancelled",
              2n,
            ],
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.budget_manager", "approved", money(61n, "EUR")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.budget_manager", "approved", money(20n, "USD")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["purchase.budget_manager", "closed", money(20n, "EUR")],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", "approved", money(20n, "EUR")],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "purchase.record_payable",
        seed: [goods_receipt, test_worker],
        dependencies: [purchase_order],
        inputs: async (c, s) => ({
          order: s.purchase_order,
          source: "payable-1",
          invoice: "SUP-001",
          issued: date("2099-01-03"),
          evidence: "Supplier invoice",
        }),
        selectors: ["as", "order.parent.state", "order.parent.actual", "amount"],
        observations: [
          async (c, s) => await count(records(c, "purchase.Payable")),
          async (c, s) => s.result.invoice,
          async (c, s) => s.result.amount,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.budget_manager",
              "closed",
              money(20n, "EUR"),
              money(20n, "EUR"),
            ],
            expected: async (c, s) => [1n, "SUP-001", money(20n, "EUR")],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.budget_manager",
              "closed",
              money(20n, "EUR"),
              money(21n, "EUR"),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.budget_manager",
              "closed",
              money(20n, "EUR"),
              money(20n, "USD"),
            ],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "purchase.budget_manager",
              "approved",
              money(20n, "EUR"),
              money(20n, "EUR"),
            ],
            error: "rule_failed",
          },
        ],
      },
    ],
  };
}
