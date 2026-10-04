import {
  any,
  require as check,
  count,
  create,
  emit,
  equalValue,
  schedule,
  first,
  format,
  hasRole,
  int64,
  OperationOutcome,
  records,
  same,
  set,
  sum,
} from "@canlang/stdlib";
// Desired/unimplemented UI contracts: every @canlang/ui factory below is proposed, not
// installed. The replanned Then section adds alert, badge, breadcrumbs, button, fieldset,
// input, label, modal, pagination, select, stat, status, tab, tabs, textarea, timeline,
// toggle, tooltip and validator; actions() and metrics() have no remaining use.
import {
  alert,
  badge,
  breadcrumbs,
  button,
  card,
  edit,
  fieldset,
  form,
  history,
  input,
  label,
  list,
  message,
  modal,
  pagination,
  renderPage,
  select,
  stat,
  status,
  tab,
  table,
  tabs,
  text,
  textarea,
  timeline,
  toggle,
  tooltip,
  validator,
} from "@canlang/ui";
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
 *
 * Desired UI lowering (unimplemented, for lane 05/01): each new factory takes one
 * props object with `context` plus children arrays, per DESIGN-13. badge({context,
 * value}) and status({context,value}) present one readable value; stat({context,
 * result,fields}) shares the typed metric contract and stat({context,value}) presents
 * a bare read result. button() takes exactly one of action/submit/target/opens.
 * modal({context,caption,id,content,actions?,trigger?}) takes slot arrays; an external
 * button opens= suppresses its implicit opener. fieldset({context,caption,children})
 * groups controls; input/textarea/select/toggle({context,field}) name an existing
 * writable input; label()/validator() move that field's label/feedback outlet.
 * breadcrumbs()/pagination() consume derived ancestry / the enclosing cursor; tabs()
 * hosts tab() panels; tooltip({context,caption,children}) annotates content;
 * timeline({context,model,parent,renderItem}) renders one item template per admitted
 * row. form() accepts children for explicit field placement in source order. Every
 * use site below is marked desired/unimplemented; this file must pass node --check
 * (syntax only) and never claims to run.
 */

// Canonical references exported by the authored package; no adapter implementation.
export const StockReceipt = "stock.StockReceipt";

export const StockV1 = "stock.StockV1";
export const StockIngressV1 = "stock.StockIngressV1";
export const PostOutcome = "stock.PostOutcome";
export const ProjectionOutcome = "stock.ProjectionOutcome";

async function available(c, item, location) {
  return sum(
    records(c, "stock.Movement", {
      parent: item,
      where: (movement) => same(movement.location, location),
    }),
    (movement) => movement.quantity,
  );
}

/* StockV1.post maps authenticated purchase-origin Receipts.post to committed
 * PostOutcome (pending or replay-confirmed). StockV1.changed maps the subsequent
 * committed ProjectionOutcome, retaining the same sealed source/revision. The installed binding fixes the allowed
 * team/location/source namespaces, operation kind and immutable request digest.
 * A rejection becomes a failed receipt; an outcome completes only its originating
 * post delivery after commit. No delegated role or cross-deployment model query.
 * The ingress adapter and source attestation are unimplemented binding obligations.
 */
const sourceCaption = message("Source reference", { nl: "Bronreferentie" });

const orderCaption = message("Purchase order reference", { nl: "Inkoopreferentie" });

const skuCaption = message("SKU", { nl: "Artikelcode" });

const unitCaption = message("Unit", { nl: "Eenheid" });

const reversalCaption = message("Reversal reference", { nl: "Terugboekingsreferentie" });

const reorderCaption = message("Reorder threshold", { nl: "Besteldrempel" });

const stockPageDescriptor = {
  owner: "stock",
  path: "/stock",
  title: message("Consumables", { nl: "Verbruiksartikelen" }),
  description: message("Inspect location balances and enter deliberate ledger movements.", {
    nl: "Bekijk locatiesaldi en voer bewuste voorraadmutaties in.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "stock.stock_staff"), "forbidden");
    return {};
  },
  render: stockPage,
};

export const appDefinition = {
  id: "CanStock",
  uses: ["stock"],
  description: message(
    "Help workspace staff track coffee, cleaning supplies, stationery, access-card stock, and other consumables by location and storeroom.",
    {
      nl: "Help werkplekmedewerkers koffie, schoonmaakmiddelen, kantoorartikelen, toegangskaartvoorraad en andere verbruiksartikelen per locatie en voorraadruimte te volgen.",
    },
  ),
  packages: {
    stock: {
      description: message(
        "Own whole-unit consumable ledgers, atomic transfers and source-identified purchase receipts.",
        {
          nl: "Beheer voorraadregisters in gehele eenheden, atomaire overboekingen en brongeïdentificeerde inkoopontvangsten.",
        },
      ),
      roles: {
        stock_staff: {
          id: "stock.stock_staff",
          label: message("Stock staff", { nl: "Voorraadmedewerker" }),
        },
      },
    },
  },
  bindings: { "stock.Receipts": { capability: StockIngressV1, from: "deployment.stock_receipts" } },
  events: {
    [PostOutcome]: { exported: true, fields: { value: { type: OperationOutcome } } },
    [ProjectionOutcome]: { exported: true, fields: { value: { type: OperationOutcome } } },
    "stock.ApplyProjection": { fields: { projection: { type: "stock.Projection" } } },
  },
  models: {
    "stock.Projection": {
      label: message("Purchase stock projection", { nl: "Inkoopvoorraadboeking" }),
      fields: {
        source: { type: "text", unique: true },
        value: { type: StockReceipt },
        location: { type: Location },
        state: { type: "enum", cases: ["pending", "confirmed", "failed"], default: "pending" },
        movement: { type: "stock.Movement", nullable: true },
        detail: { type: "text", nullable: true },
      },
      readGrants: [{ rule: "Projection.read.1" }],
      invariants: ["Projection.require.1"],
      locks: ["Projection.lock.1", "Projection.lock.2"],
    },
    "stock.Item": {
      derived: {
        total: {
          type: "int",
          handler: "Item.total",
          label: message("Total stock", { nl: "Totale voorraad" }),
        },
        low: {
          type: "bool",
          handler: "Item.low",
          label: message("Total reorder needed", { nl: "Totale aanvulling nodig" }),
        },
      },
      label: message("Stock item", { nl: "Voorraadartikel" }),
      readGrants: [{ rule: "Item.read.1" }],
      locks: ["Item.lock.1"],
      fields: {
        sku: { type: "text", unique: true, label: skuCaption },
        name: { type: "text" },
        unit: { type: "text", label: unitCaption },
        reorder: { type: "int", min: 0n, default: 0n, label: reorderCaption },
        active: { type: "bool", default: true },
      },
    },
    "stock.Threshold": {
      parent: "stock.Item",
      derived: {
        available: {
          type: "int",
          handler: "Threshold.available",
          label: message("Available stock", { nl: "Beschikbare voorraad" }),
        },
        low: {
          type: "bool",
          handler: "Threshold.low",
          label: message("Reorder needed", { nl: "Aanvulling nodig" }),
        },
      },
      label: message("Location reorder threshold", { nl: "Besteldrempel per locatie" }),
      readGrants: [{ rule: "Threshold.read.1" }],
      unique: [{ fields: ["location"] }],
      fields: {
        location: { type: Location },
        reorder: { type: "int", min: 0n, default: 0n, label: reorderCaption },
      },
    },
    "stock.Movement": {
      parent: "stock.Item",
      label: message("Stock movement", { nl: "Voorraadmutatie" }),
      readGrants: [{ rule: "Movement.read.1" }],
      locks: ["Movement.lock.1"],
      invariants: ["Movement.require.1", "Movement.require.2"],
      fields: {
        location: { type: Location },
        quantity: { type: "int" },
        reason: { type: "text" },
        source: { type: "text", unique: true, label: sourceCaption },
        transfer: {
          type: "text",
          nullable: true,
          label: message("Transfer reference", { nl: "Overboekingsreferentie" }),
        },
        reversal: { type: "stock.Movement", nullable: true, label: reversalCaption },
        order: { type: "text", nullable: true, label: orderCaption },
        actor: { type: "user", nullable: true },
        revision: { type: "int", nullable: true },
        unit: { type: "text", nullable: true },
      },
    },
  },
  contracts: {
    "stock.StockReceipt": {
      exported: true,
      label: message("Stock receipt", { nl: "Voorraadontvangst" }),
      fields: {
        source: { type: "text", label: sourceCaption },
        order: { type: "text", label: orderCaption },
        sku: { type: "text", label: skuCaption },
        unit: { type: "text", label: unitCaption },
        location: { type: "text" },
        quantity: { type: "int" },
        revision: { type: "int" },
        reversal: { type: "text", nullable: true, label: reversalCaption },
      },
    },
  },
  capabilities: {
    [StockIngressV1]: {
      exported: true,
      version: 1n,
      events: { post: { fields: { value: { type: StockReceipt } } } },
    },
    "stock.StockV1": {
      exported: true,
      version: 1n,
      operations: {
        post: { inputs: { value: { type: "stock.StockReceipt" } }, result: OperationOutcome },
      },
      events: { changed: { fields: { value: { type: OperationOutcome } } } },
    },
  },
  pure: {
    "stock.available": {
      handler: "available",
      inputs: { item: { type: "stock.Item" }, location: { type: Location } },
      result: "int",
    },
  },
  preferences: {
    stock: {
      validate: "preferencesValid",
      fields: { location: { type: Location, nullable: true, default: null } },
    },
  },
  operations: {
    "stock.Item.create": {
      handler: "createItem",
      kind: "create",
      model: "stock.Item",
      by: "stock.stock_staff",
      read: false,
      inputs: { fields: ["sku", "name", "unit", "reorder", "active"] },
    },
    "stock.Item.update": {
      handler: "updateItem",
      kind: "update",
      model: "stock.Item",
      by: "stock.stock_staff",
      read: false,
      inputs: {
        record: { type: "stock.Item" },
        changes: { fields: ["sku", "name", "unit", "reorder", "active"] },
      },
    },
    "stock.Threshold.create": {
      handler: "createThreshold",
      kind: "create",
      model: "stock.Threshold",
      by: "stock.stock_staff",
      read: false,
      inputs: { parent: { type: "stock.Item" }, fields: ["location", "reorder"] },
      when: "Threshold",
    },
    "stock.Threshold.update": {
      handler: "updateThreshold",
      kind: "update",
      model: "stock.Threshold",
      by: "stock.stock_staff",
      read: false,
      inputs: { record: { type: "stock.Threshold" }, changes: { fields: ["location", "reorder"] } },
      when: "Threshold",
    },
    "stock.adjust": {
      handler: "adjust",
      by: "stock.stock_staff",
      read: false,
      label: message("Adjust stock", { nl: "Voorraad corrigeren" }),
      description: message(
        "Record an attributed receipt, consumption or count correction without rewriting history.",
        {
          nl: "Leg een toegeschreven ontvangst, verbruik of telcorrectie vast zonder geschiedenis te herschrijven.",
        },
      ),
      inputs: {
        item: { type: "stock.Item" },
        location: { type: Location },
        quantity: { type: "int" },
        reason: { type: "text" },
      },
    },
    "stock.transfer": {
      handler: "transfer",
      by: "stock.stock_staff",
      read: false,
      label: message("Transfer stock", { nl: "Voorraad overboeken" }),
      description: message(
        "Transfer the same SKU between two authorized sites, committing both legs together.",
        {
          nl: "Boek hetzelfde artikel over tussen twee toegestane locaties en leg beide zijden samen vast.",
        },
      ),
      inputs: {
        item: { type: "stock.Item" },
        from: { type: Location, label: message("Source location", { nl: "Bronlocatie" }) },
        to: { type: Location, label: message("Destination location", { nl: "Doellocatie" }) },
        quantity: { type: "int" },
        reason: { type: "text" },
      },
    },
    "stock.reverse": {
      handler: "reverse",
      by: "stock.stock_staff",
      read: false,
      label: message("Reverse stock movement", { nl: "Voorraadmutatie terugboeken" }),
      description: message(
        "Reverse a posted movement with a reason while keeping stock nonnegative.",
        {
          nl: "Boek een vastgelegde mutatie met een reden terug en behoud een niet-negatieve voorraad.",
        },
      ),
      inputs: { movement: { type: "stock.Movement" }, reason: { type: "text" } },
    },
    "stock.retry": {
      handler: "retry",
      by: "stock.stock_staff",
      read: false,
      inputs: { projection: { type: "stock.Projection" } },
      description: message("Retry a saved projection after investigating a failed stock posting.", {
        nl: "Herhaal een opgeslagen boeking na onderzoek van een mislukte voorraadboeking.",
      }),
    },
    "stock.balance": {
      handler: "balance",
      by: "stock.stock_staff",
      read: true,
      result: "int",
      inputs: { item: { type: "stock.Item" }, location: { type: Location } },
      description: message(
        "Report a scoped location balance without exposing stock at other sites.",
        { nl: "Rapporteer een locatiesaldo zonder voorraad op andere locaties te tonen." },
      ),
    },
  },
  handlers: {
    "stock.apply_projection": {
      handler: "apply_projection",
      on: "stock.ApplyProjection",
      description: message(
        "Apply one saved projection or record a visible failure without inventing usable stock.",
        {
          nl: "Verwerk één opgeslagen boeking of registreer een zichtbare fout zonder bruikbare voorraad te verzinnen.",
        },
      ),
    },
    "stock.post": {
      handler: "post",
      on: { capability: "stock.Receipts", event: "post" },
      description: message(
        "Persist authenticated purchase projections and acknowledge identical source replay.",
        { nl: "Bewaar geauthenticeerde inkoopboekingen en bevestig identieke bronherhaling." },
      ),
    },
  },
  pages: [stockPageDescriptor],
  disabled: [
    "stock.Item.delete",
    "stock.Threshold.delete",
    "stock.Movement.create",
    "stock.Movement.update",
    "stock.Movement.delete",
    "stock.Projection.create",
    "stock.Projection.update",
    "stock.Projection.delete",
  ],
};

export function canApp() {
  const crudWhen = { Threshold: async (c, row) => await can_work(c, c.actor, row.location) };
  return {
    crudWhen,

    preferencesValid: async (c, row) =>
      row.location === null || (await can_work(c, c.actor, row.location)),
    read: {
      "Projection.read.1": async (c, row) =>
        hasRole(c, "stock.stock_staff") && (await can_work(c, c.actor, row.location)),
      "Item.read.1": (c, row) => hasRole(c, "stock.stock_staff"),
      "Threshold.read.1": async (c, row) =>
        hasRole(c, "stock.stock_staff") && (await can_work(c, c.actor, row.location)),
      "Movement.read.1": async (c, row) =>
        hasRole(c, "stock.stock_staff") && (await can_work(c, c.actor, row.location)),
    },
    locks: {
      "Projection.lock.1": { fields: ["source", "value", "location"] },
      "Projection.lock.2": {
        fields: ["state", "movement", "detail"],
        when: (c, row) => row.state === "confirmed",
      },
      "Movement.lock.1": {
        fields: [
          "location",
          "quantity",
          "reason",
          "source",
          "transfer",
          "reversal",
          "order",
          "actor",
          "revision",
          "unit",
        ],
      },
      "Item.lock.1": {
        fields: ["unit", "sku"],
        when: async (c, row) => (await count(records(c, "stock.Movement", { parent: row }))) > 0n,
      },
    },
    invariants: {
      "Projection.require.1": (c, row) =>
        row.source === row.value.source &&
        row.location.id === row.value.location &&
        row.value.revision > 0n &&
        ((row.value.reversal === null && row.value.quantity > 0n) ||
          (row.value.reversal !== null && row.value.quantity < 0n)) &&
        (row.state !== "confirmed" || row.movement !== null),
      "Movement.require.1": async (c, row) =>
        !(await any(
          records(c, "stock.Movement"),
          (other) => !same(other, row) && other.source === row.source,
        )),
      "Movement.require.2": async (c, row) =>
        row.quantity !== 0n &&
        row.reason.trim() !== "" &&
        (await available(c, row.parent, row.location)) >= 0n,
    },
    available,
    derives: {
      "Threshold.available": (c, row) => available(c, row.parent, row.location),
      "Threshold.low": (c, row) => row.available <= row.reorder,
      "Item.low": (c, row) => row.total <= row.reorder,
      "Item.total": (c, row) =>
        sum(records(c, "stock.Movement", { parent: row }), (movement) => movement.quantity),
    },
    async createItem(c, input) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      await create(c, "stock.Item", input);
    },
    async updateItem(c, { record, changes }) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      await set(c, record, changes);
    },
    async createThreshold(c, input) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      await create(c, "stock.Threshold", input, { when: crudWhen.Threshold });
    },
    async updateThreshold(c, { record, changes }) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Threshold });
    },
    async adjust(c, { item, location, quantity, reason }) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      check(
        item.active &&
          (await can_work(c, c.actor, location)) &&
          quantity !== 0n &&
          reason.trim() !== "" &&
          int64((await available(c, item, location)) + quantity) >= 0n,
      );
      await create(c, "stock.Movement", {
        parent: item,
        location,
        quantity,
        reason,
        source: c.operation.id,
        actor: c.actor,
        transfer: null,
        reversal: null,
        order: null,
      });
    },
    async transfer(c, { item, from, to, quantity, reason }) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      check(
        item.active &&
          !same(from, to) &&
          quantity > 0n &&
          (await can_work(c, c.actor, from)) &&
          (await can_work(c, c.actor, to)) &&
          reason.trim() !== "" &&
          (await available(c, item, from)) >= quantity,
      );
      await create(c, "stock.Movement", {
        parent: item,
        location: from,
        quantity: int64(-quantity),
        reason,
        source: format(c, "{id}:out", { id: c.operation.id }),
        transfer: c.operation.id,
        actor: c.actor,
        reversal: null,
        order: null,
      });
      await create(c, "stock.Movement", {
        parent: item,
        location: to,
        quantity,
        reason,
        source: format(c, "{id}:in", { id: c.operation.id }),
        transfer: c.operation.id,
        actor: c.actor,
        reversal: null,
        order: null,
      });
    },
    async reverse(c, { movement, reason }) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      check(
        movement.order === null &&
          (await can_work(c, c.actor, movement.location)) &&
          reason.trim() !== "" &&
          !(await any(records(c, "stock.Movement", { parent: movement.parent }), (item) =>
            same(item.reversal, movement),
          )) &&
          int64((await available(c, movement.parent, movement.location)) - movement.quantity) >= 0n,
      );
      await create(c, "stock.Movement", {
        parent: movement.parent,
        location: movement.location,
        quantity: int64(-movement.quantity),
        reason,
        source: c.operation.id,
        reversal: movement,
        order: movement.order,
        actor: c.actor,
        transfer: null,
      });
    },
    async post(c, { event }) {
      check(
        event.value.source.trim() !== "" &&
          event.value.order.trim() !== "" &&
          event.value.revision > 0n &&
          ((event.value.reversal === null && event.value.quantity > 0n) ||
            (event.value.reversal !== null && event.value.quantity < 0n)),
      );
      const value = event.value;
      const location = await first(
        records(c, Location, {
          where: (location) => location.id === value.location,
          order: ["id"],
        }),
      );
      check(location !== null);
      const previous = await first(
        records(c, "stock.Projection", {
          where: (projection) => projection.source === value.source,
          order: ["id"],
        }),
      );
      if (previous !== null) {
        check(
          equalValue(c, StockReceipt, previous.value, value) && same(previous.location, location),
        );
        if (previous.state === "confirmed")
          await emit(c, PostOutcome, {
            value: {
              source: value.source,
              revision: value.revision,
              state: "confirmed",
              reference: previous.movement.id,
              detail: null,
            },
          });
        else {
          await set(c, previous, { state: "pending", detail: null });
          await schedule(c, previous.id, c.now, "stock.ApplyProjection", { projection: previous });
          await emit(c, PostOutcome, {
            value: {
              source: value.source,
              revision: value.revision,
              state: "pending",
              reference: previous.id,
              detail: null,
            },
          });
        }
      } else {
        const projection = await create(c, "stock.Projection", {
          source: value.source,
          value,
          location,
        });
        await schedule(c, projection.id, c.now, "stock.ApplyProjection", { projection });
        await emit(c, PostOutcome, {
          value: {
            source: value.source,
            revision: value.revision,
            state: "pending",
            reference: projection.id,
            detail: null,
          },
        });
      }
    },
    async apply_projection(c, { event }) {
      const projection = event.projection;
      if (projection.state === "pending") {
        const value = projection.value;
        const location = projection.location;
        const item = await first(
          records(c, "stock.Item", { where: (item) => item.sku === value.sku, order: ["id"] }),
        );
        if (
          item === null ||
          value.unit !== item.unit ||
          (!item.active && value.reversal === null)
        ) {
          await set(c, projection, {
            state: "failed",
            detail: "Unknown SKU, inactive item or mismatched unit",
          });
          await emit(c, ProjectionOutcome, {
            value: {
              source: value.source,
              revision: value.revision,
              state: "failed",
              reference: projection.id,
              detail: projection.detail,
            },
          });
        } else {
          const previous = await first(
            records(c, "stock.Movement", {
              where: (movement) => movement.source === value.source,
              order: ["id"],
            }),
          );
          if (previous !== null) {
            if (
              same(previous.parent, item) &&
              same(previous.location, location) &&
              previous.quantity === value.quantity &&
              previous.order === value.order &&
              previous.unit === value.unit &&
              previous.revision === value.revision &&
              ((previous.reversal === null && value.reversal === null) ||
                (previous.reversal !== null && previous.reversal.source === value.reversal))
            ) {
              await set(c, projection, { state: "confirmed", movement: previous, detail: null });
              await emit(c, ProjectionOutcome, {
                value: {
                  source: value.source,
                  revision: value.revision,
                  state: "confirmed",
                  reference: previous.id,
                  detail: null,
                },
              });
            } else {
              await set(c, projection, {
                state: "failed",
                detail: "Source conflicts with an existing stock movement",
              });
              await emit(c, ProjectionOutcome, {
                value: {
                  source: value.source,
                  revision: value.revision,
                  state: "failed",
                  reference: projection.id,
                  detail: projection.detail,
                },
              });
            }
          } else if (value.reversal === null) {
            const movement = await create(c, "stock.Movement", {
              parent: item,
              location,
              quantity: value.quantity,
              reason: "Accepted purchase receipt",
              source: value.source,
              order: value.order,
              revision: value.revision,
              unit: value.unit,
            });
            await set(c, projection, { state: "confirmed", movement, detail: null });
            await emit(c, ProjectionOutcome, {
              value: {
                source: value.source,
                revision: value.revision,
                state: "confirmed",
                reference: movement.id,
                detail: null,
              },
            });
          } else {
            const original = await first(
              records(c, "stock.Movement", {
                where: (movement) => movement.source === value.reversal,
                order: ["id"],
              }),
            );
            if (
              original === null ||
              !same(original.parent, item) ||
              !same(original.location, location) ||
              original.order !== value.order ||
              original.unit !== value.unit ||
              original.quantity <= 0n ||
              original.reversal !== null
            ) {
              await set(c, projection, {
                state: "failed",
                detail: "Return does not match its original receipt movement",
              });
              await emit(c, ProjectionOutcome, {
                value: {
                  source: value.source,
                  revision: value.revision,
                  state: "failed",
                  reference: projection.id,
                  detail: projection.detail,
                },
              });
            } else if (
              int64(
                original.quantity +
                  (await sum(
                    records(c, "stock.Movement", {
                      parent: original.parent,
                      where: (movement) => same(movement.reversal, original),
                    }),
                    (movement) => movement.quantity,
                  )) +
                  value.quantity,
              ) < 0n ||
              int64((await available(c, item, location)) + value.quantity) < 0n
            ) {
              await set(c, projection, {
                state: "failed",
                detail: "Insufficient usable stock or return exceeds accepted receipt",
              });
              await emit(c, ProjectionOutcome, {
                value: {
                  source: value.source,
                  revision: value.revision,
                  state: "failed",
                  reference: projection.id,
                  detail: projection.detail,
                },
              });
            } else {
              const movement = await create(c, "stock.Movement", {
                parent: item,
                location,
                quantity: value.quantity,
                reason: "Supplier return",
                source: value.source,
                order: value.order,
                reversal: original,
                revision: value.revision,
                unit: value.unit,
              });
              await set(c, projection, { state: "confirmed", movement, detail: null });
              await emit(c, ProjectionOutcome, {
                value: {
                  source: value.source,
                  revision: value.revision,
                  state: "confirmed",
                  reference: movement.id,
                  detail: null,
                },
              });
            }
          }
        }
      }
    },
    async retry(c, { projection }) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      check((await can_work(c, c.actor, projection.location)) && projection.state === "failed");
      await set(c, projection, { state: "pending", detail: null });
      await schedule(c, projection.id, c.now, "stock.ApplyProjection", { projection });
    },
    async balance(c, { item, location }) {
      check(hasRole(c, "stock.stock_staff"), "forbidden");
      check(await can_work(c, c.actor, location));
      return await available(c, item, location);
    },
  };
}

export async function stockPage(c, bindings) {
  return renderPage(
    c,
    stockPageDescriptor,
    () => [
      // desired/unimplemented: breadcrumbs() consumes the current declared route ancestry.
      breadcrumbs({ context: c }),
      // desired/unimplemented: tabs()/tab() host transient panels; captions are localized text.
      tabs({
        context: c,
        children: [
          tab({
            context: c,
            caption: message("Posting queue", { nl: "Boekingswachtrij" }),
            children: [
              card({
                context: c,
                title: message("Purchase posting queue", { nl: "Wachtrij inkoopboekingen" }),
                children: [
                  // desired/unimplemented: alert() renders a readable notice; no business invocation.
                  alert({
                    context: c,
                    message: message(
                      "Failed projections need investigation before retry; rejected quantities never become usable stock.",
                      {
                        nl: "Mislukte boekingen vereisen onderzoek vóór herhalen; afgekeurde aantallen worden nooit bruikbare voorraad.",
                      },
                    ),
                  }),
                  list({
                    context: c,
                    model: "stock.Projection",
                    filter: ["state", "location"],
                    defaults: { location: c.preferences.stock.location },
                    empty: message("No purchase projections match these filters", {
                      nl: "Geen inkoopboekingen voor deze filters",
                    }),
                    renderRow: (projection, view) => [
                      text({
                        context: view,
                        values: [
                          projection.source,
                          projection.value.order,
                          projection.value.sku,
                          projection.value.unit,
                          projection.value.quantity,
                          projection.location,
                          projection.detail,
                        ],
                      }),
                      // desired/unimplemented: badge() presents one readable typed value + owning caption.
                      badge({ context: view, value: projection.state }),
                      text({ context: view, values: [projection.movement] }),
                      // desired/unimplemented: tooltip() annotates content; the button lowers to the
                      // existing canonical retry binding (same node as the former action control).
                      tooltip({
                        context: view,
                        caption: message("Retry this failed projection", {
                          nl: "Herhaal deze mislukte boeking",
                        }),
                        children: [
                          button({
                            context: view,
                            action: "stock.retry",
                            boundArgs: { projection },
                          }),
                        ],
                      }),
                      history({ context: view, record: projection }),
                      // desired/unimplemented: pagination() consumes the enclosing collection cursor.
                      pagination({ context: view }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          tab({
            context: c,
            caption: message("Items and ledger", { nl: "Artikelen en register" }),
            children: [
              card({
                context: c,
                title: message("Item identities and fixed units", {
                  nl: "Artikelidentiteiten en vaste eenheden",
                }),
                children: [
                  // desired/unimplemented: form children express explicit field placement in source
                  // order (fieldset/input/toggle/label/button); the unplaced remainder follows.
                  form({
                    context: c,
                    operation: "stock.Item.create",
                    children: [
                      fieldset({
                        context: c,
                        caption: message("Identity", { nl: "Identiteit" }),
                        children: [
                          label({ context: c, field: "sku" }),
                          input({ context: c, field: "sku" }),
                          input({ context: c, field: "name" }),
                          input({ context: c, field: "unit" }),
                        ],
                      }),
                      fieldset({
                        context: c,
                        caption: message("Replenishment", { nl: "Aanvulling" }),
                        children: [
                          input({ context: c, field: "reorder" }),
                          toggle({ context: c, field: "active" }),
                        ],
                      }),
                      button({ context: c, submit: true }),
                    ],
                  }),
                  list({
                    context: c,
                    model: "stock.Item",
                    search: ["name"],
                    filter: ["active"],
                    display: "split",
                    empty: message("No items match this search", {
                      nl: "Geen artikelen voor deze zoekopdracht",
                    }),
                    renderRow: (item, view) => [
                      // desired/unimplemented: badge()/status() present readable values; status adds
                      // a text alternative for the bool. stat() shares the typed metric contract.
                      badge({ context: view, value: item.sku }),
                      status({ context: view, value: item.active }),
                      stat({ context: view, result: item, fields: ["total", "low"] }),
                      // desired/unimplemented: edit() accepts a presentation suite over the same
                      // canonical update schema and version contract.
                      edit({
                        context: view,
                        operation: "stock.Item.update",
                        record: item,
                        children: [
                          fieldset({
                            context: view,
                            caption: message("Item maintenance", { nl: "Artikelbeheer" }),
                            children: [
                              input({ context: view, field: "sku" }),
                              input({ context: view, field: "name" }),
                              input({ context: view, field: "unit" }),
                              input({ context: view, field: "reorder" }),
                              toggle({ context: view, field: "active" }),
                            ],
                          }),
                          button({ context: view, submit: true }),
                        ],
                      }),
                      card({
                        context: view,
                        title: message("Location reorder thresholds", {
                          nl: "Besteldrempels per locatie",
                        }),
                        children: [
                          form({
                            context: view,
                            operation: "stock.Threshold.create",
                            arguments: { parent: item },
                            children: [
                              fieldset({
                                context: view,
                                caption: message("Threshold", { nl: "Drempel" }),
                                children: [
                                  label({ context: view, field: "location" }),
                                  select({ context: view, field: "location" }),
                                  input({ context: view, field: "reorder" }),
                                  validator({ context: view, field: "reorder" }),
                                ],
                              }),
                              button({ context: view, submit: true }),
                            ],
                          }),
                          table({
                            context: view,
                            model: "stock.Threshold",
                            parent: item,
                            columns: ["location", "reorder"],
                            order: ["location"],
                            filter: ["location"],
                            defaults: { location: c.preferences.stock.location },
                            empty: message("No thresholds for this location", {
                              nl: "Geen drempels voor deze locatie",
                            }),
                            renderRow: (threshold, rowView) => [
                              // desired/unimplemented: stat()/status() replace the former metrics()
                              // row; edit keeps the canonical update binding.
                              stat({ context: rowView, result: threshold, fields: ["available"] }),
                              status({ context: rowView, value: threshold.low }),
                              edit({
                                context: rowView,
                                operation: "stock.Threshold.update",
                                record: threshold,
                              }),
                              pagination({ context: rowView }),
                            ],
                          }),
                        ],
                      }),
                      card({
                        context: view,
                        title: message("Ledger movements and corrections", {
                          nl: "Voorraadmutaties en correcties",
                        }),
                        children: [
                          // desired/unimplemented: button opens= activates the matching modal id in
                          // this row scope; captions derive from the target panel.
                          button({ context: view, opens: "adjust_stock" }),
                          button({ context: view, opens: "transfer_stock" }),
                          // desired/unimplemented: modal() takes content/actions slots; the external
                          // opener suppresses the implicit opener for this instance.
                          modal({
                            context: view,
                            caption: message("Adjust stock", { nl: "Voorraad corrigeren" }),
                            id: "adjust_stock",
                            content: [
                              form({
                                context: view,
                                operation: "stock.adjust",
                                arguments: { item },
                                children: [
                                  fieldset({
                                    context: view,
                                    caption: message("Adjustment", { nl: "Correctie" }),
                                    children: [
                                      select({ context: view, field: "location" }),
                                      label({ context: view, field: "quantity" }),
                                      input({ context: view, field: "quantity" }),
                                      validator({ context: view, field: "quantity" }),
                                      textarea({ context: view, field: "reason" }),
                                    ],
                                  }),
                                  button({ context: view, submit: true }),
                                ],
                              }),
                            ],
                          }),
                          modal({
                            context: view,
                            caption: message("Transfer stock", { nl: "Voorraad overboeken" }),
                            id: "transfer_stock",
                            content: [
                              form({
                                context: view,
                                operation: "stock.transfer",
                                arguments: { item },
                                children: [
                                  fieldset({
                                    context: view,
                                    caption: message("Route", { nl: "Route" }),
                                    children: [
                                      select({ context: view, field: "from" }),
                                      select({ context: view, field: "to" }),
                                    ],
                                  }),
                                  fieldset({
                                    context: view,
                                    caption: message("Quantity and reason", {
                                      nl: "Aantal en reden",
                                    }),
                                    children: [
                                      input({ context: view, field: "quantity" }),
                                      textarea({ context: view, field: "reason" }),
                                    ],
                                  }),
                                  button({ context: view, submit: true }),
                                ],
                              }),
                            ],
                          }),
                          form({
                            context: view,
                            operation: "stock.balance",
                            arguments: { item },
                            children: [
                              fieldset({
                                context: view,
                                caption: message("Scoped balance", { nl: "Locatiesaldo" }),
                                children: [select({ context: view, field: "location" })],
                              }),
                              button({ context: view, submit: true }),
                            ],
                            renderResult: (result, resultView) => [
                              // desired/unimplemented: stat() presents the typed read result.
                              stat({ context: resultView, value: result }),
                            ],
                          }),
                          table({
                            context: view,
                            model: "stock.Movement",
                            parent: item,
                            columns: ["location", "reason", "source", "order", "actor"],
                            order: ["-created"],
                            filter: ["location"],
                            defaults: { location: c.preferences.stock.location },
                            empty: message("No ledger movements for this location", {
                              nl: "Geen voorraadmutaties voor deze locatie",
                            }),
                            renderRow: (movement, rowView) => [
                              // desired/unimplemented: badge() carries the signed quantity column.
                              badge({ context: rowView, value: movement.quantity }),
                              text({
                                context: rowView,
                                values: [
                                  movement.reversal,
                                  movement.transfer,
                                  movement.revision,
                                  movement.unit,
                                ],
                              }),
                              button({ context: rowView, opens: "reverse_movement" }),
                              modal({
                                context: rowView,
                                caption: message("Reverse stock movement", {
                                  nl: "Voorraadmutatie terugboeken",
                                }),
                                id: "reverse_movement",
                                content: [
                                  alert({
                                    context: rowView,
                                    message: message(
                                      "Reversal appends a linked movement; posted history stays immutable.",
                                      {
                                        nl: "Terugboeking voegt een gekoppelde mutatie toe; vastgelegde historie blijft ongewijzigd.",
                                      },
                                    ),
                                  }),
                                  form({
                                    context: rowView,
                                    operation: "stock.reverse",
                                    arguments: { movement },
                                    children: [
                                      textarea({ context: rowView, field: "reason" }),
                                      button({ context: rowView, submit: true }),
                                    ],
                                  }),
                                ],
                              }),
                              history({ context: rowView, record: movement }),
                              pagination({ context: rowView }),
                            ],
                          }),
                        ],
                      }),
                      card({
                        context: view,
                        title: message("Recent ledger activity", {
                          nl: "Recente voorraadactiviteit",
                        }),
                        children: [
                          // desired/unimplemented: timeline() renders one item template per admitted
                          // row, reusing the collection evaluator and row chain.
                          timeline({
                            context: view,
                            model: "stock.Movement",
                            parent: item,
                            renderItem: (movement, movementView) => [
                              badge({ context: movementView, value: movement.quantity }),
                              text({
                                context: movementView,
                                values: [movement.reason, movement.location, movement.source],
                              }),
                            ],
                          }),
                        ],
                      }),
                      pagination({ context: view }),
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
export const exampleImports = [
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
  { provider: "employee", member: "test_worker", alias: "test_worker" },
];

export function exampleFixtures({ self, other, imported }) {
  const { test_site, test_worker } = imported;
  const coffee = {
    model: "stock.Item",
    dependencies: [],
    value: async (c, s) => ({ sku: "coffee", name: "Coffee", unit: "box" }),
  };
  const goods = {
    model: "stock.Item",
    dependencies: [],
    value: async (c, s) => ({ sku: "boxes", name: "Boxes", unit: "box" }),
  };
  const opening = {
    model: "stock.Movement",
    dependencies: [goods, test_site],
    value: async (c, s) => ({
      parent: s.goods,
      location: s.test_site,
      quantity: 3n,
      reason: "Initial count",
      source: "opening",
    }),
  };
  const purchased = {
    model: "stock.Movement",
    dependencies: [goods, test_site],
    value: async (c, s) => ({
      parent: s.goods,
      location: s.test_site,
      quantity: 3n,
      reason: "Accepted purchase receipt",
      source: "delivery-A",
      order: "PO-1",
      revision: 1n,
      unit: "box",
    }),
  };
  const consumed = {
    model: "stock.Movement",
    dependencies: [goods, test_site],
    value: async (c, s) => ({
      parent: s.goods,
      location: s.test_site,
      quantity: -1n,
      reason: "Consumption",
      source: "consumed",
    }),
  };
  const incoming = {
    model: "stock.Projection",
    dependencies: [test_site],
    value: async (c, s) => ({
      source: "delivery-B",
      value: {
        source: "delivery-B",
        order: "PO-1",
        sku: "boxes",
        unit: "box",
        location: s.test_site.id,
        quantity: 3n,
        revision: 1n,
        reversal: null,
      },
      location: s.test_site,
    }),
  };
  return {
    coffee,
    consumed,
    goods,
    incoming,
    opening,
    purchased,
    examples: [
      {
        operation: "stock.adjust",
        seed: [opening, test_worker],
        dependencies: [goods, test_site],
        inputs: async (c, s) => ({ item: s.goods, location: s.test_site, reason: "Consumption" }),
        selectors: ["as", "quantity"],
        observations: [async (c, s) => await available(c, s.goods, s.test_site)],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["stock.stock_staff", -3n],
            expected: async (c, s) => [0n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["stock.stock_staff", -4n],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["members", -1n], error: "forbidden" },
        ],
      },
      {
        operation: "stock.post",
        seed: [incoming],
        dependencies: [test_site],
        inputs: async (c, s) => ({
          event: {
            value: {
              source: "delivery-B",
              order: "PO-1",
              sku: "boxes",
              unit: "box",
              location: s.test_site.id,
              quantity: 3n,
              revision: 1n,
              reversal: null,
            },
          },
        }),
        selectors: ["event.value.quantity", "event.value.unit"],
        observations: [
          async (c, s) => await count(records(c, "stock.Projection")),
          async (c, s) => await count(records(c, "stock.Movement")),
          async (c, s) => s.incoming.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [3n, "box"],
            expected: async (c, s) => [1n, 0n, "pending"],
          },
          { dependencies: [], values: async (c, s) => [4n, "box"], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => [3n, "pack"], error: "rule_failed" },
        ],
      },
      {
        operation: "stock.apply_projection",
        seed: [goods, incoming],
        dependencies: [incoming],
        inputs: async (c, s) => ({ event: { projection: s.incoming } }),
        selectors: ["goods.active", "event.projection.value.unit"],
        observations: [
          async (c, s) => await available(c, s.goods, s.test_site),
          async (c, s) => await count(records(c, "stock.Movement")),
          async (c, s) => s.incoming.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [true, "box"],
            expected: async (c, s) => [3n, 1n, "confirmed"],
          },
          {
            dependencies: [],
            values: async (c, s) => [true, "pack"],
            expected: async (c, s) => [0n, 0n, "failed"],
          },
          {
            dependencies: [],
            values: async (c, s) => [false, "box"],
            expected: async (c, s) => [0n, 0n, "failed"],
          },
        ],
      },
      {
        operation: "stock.apply_projection",
        seed: [consumed, incoming, purchased],
        dependencies: [incoming],
        inputs: async (c, s) => ({ event: { projection: s.incoming } }),
        selectors: [
          "event.projection.value.reversal",
          "event.projection.value.quantity",
          "consumed.quantity",
        ],
        observations: [
          async (c, s) => await available(c, s.goods, s.test_site),
          async (c, s) => await count(records(c, "stock.Movement")),
          async (c, s) => s.incoming.state,
          async (c, s) => s.purchased.quantity,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["delivery-A", -2n, -1n],
            expected: async (c, s) => [0n, 3n, "confirmed", 3n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["delivery-A", -2n, -2n],
            expected: async (c, s) => [1n, 2n, "failed", 3n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["delivery-A", -4n, -1n],
            expected: async (c, s) => [2n, 2n, "failed", 3n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["missing", -1n, -1n],
            expected: async (c, s) => [2n, 2n, "failed", 3n],
          },
        ],
      },
    ],
  };
}
