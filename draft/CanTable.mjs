import {
  addDuration,
  any,
  require as check,
  compareInstant,
  create,
  first,
  hasRole,
  overlaps,
  records,
  same,
  set,
  subtractDuration,
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
  renderPage,
  table,
  tabs,
  text,
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
 */

async function available(c, table, from, until, skip) {
  return (
    table.active &&
    !(await any(
      records(c, "cafe.Booking", { parent: table.parent }),
      (booking) =>
        !same(booking, skip) &&
        same(booking.table, table) &&
        ["reserved", "seated"].includes(booking.state) &&
        booking.from !== null &&
        booking.until !== null &&
        overlaps(from, until, booking.from, booking.until),
    ))
  );
}

const cafeCaption = message("Café", { nl: "Café" });

const tableCaption = message("Dining table", { nl: "Cafétafel" });

const waitingCaption = message("Waiting", { nl: "Wachtend" });

const noShowCaption = message("No-show", { nl: "Niet verschenen" });

const cafePageDescriptor = {
  owner: "cafe",
  path: "/cafe",
  title: message("Café host", { nl: "Cafébediening" }),
  description: message(
    "Run a host floor view with separate waiting, upcoming and actual occupancy evidence.",
    {
      nl: "Bedien het café met afzonderlijk bewijs van wachten, toekomstige reserveringen en werkelijk gebruik.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "cafe.host"), "forbidden");
    return {};
  },
  render: cafePage,
};

export const appDefinition = {
  id: "CanTable",
  uses: ["cafe"],
  description: message(
    "Optionally help reception or café staff seat guests at an on-site workspace café or restaurant.",
    {
      nl: "Help desgewenst receptie- of cafémedewerkers gasten te plaatsen in het werkplekcafé of restaurant.",
    },
  ),
  packages: {
    cafe: {
      description: message(
        "Keep café waiting, interval reservations and actual occupied tables distinct.",
        {
          nl: "Houd wachtende cafégasten, tijdvakreserveringen en werkelijk bezette tafels gescheiden.",
        },
      ),
      roles: { host: { id: "cafe.host", label: message("Café host", { nl: "Cafémedewerker" }) } },
    },
  },
  models: {
    "cafe.Cafe": {
      label: cafeCaption,
      fields: { location: { type: Location }, name: { type: "text" } },
      readGrants: [{ rule: "Cafe.read.1" }],
    },
    "cafe.Table": {
      parent: "cafe.Cafe",
      invariants: ["Table.require.1"],
      label: tableCaption,
      readGrants: [{ rule: "Table.read.1" }],
      fields: {
        name: { type: "text" },
        zone: { type: "text", label: message("Table zone", { nl: "Tafelzone" }) },
        seats: { type: "int", min: 1n, label: message("Seats", { nl: "Zitplaatsen" }) },
        active: { type: "bool", default: true },
      },
    },
    "cafe.Booking": {
      parent: "cafe.Cafe",
      label: message("Booking", { nl: "Reservering" }),
      readGrants: [{ rule: "Booking.read.1" }],
      invariants: [
        "Booking.require.1",
        "Booking.require.2",
        "Booking.require.3",
        "Booking.require.4",
        "Booking.require.5",
        "Booking.require.6",
        "Booking.require.7",
      ],
      derived: {
        overdue: {
          type: "bool",
          handler: "Booking.overdue",
          label: message("Seating estimate exceeded", { nl: "Zitschatting overschreden" }),
        },
        conflict: {
          type: "bool",
          handler: "Booking.conflict",
          label: message("Occupied table conflict", { nl: "Conflict met bezette tafel" }),
        },
      },
      fields: {
        name: { type: "text" },
        contact: {
          type: "text",
          nullable: true,
          label: message("Guest contact", { nl: "Contactgegevens gast" }),
        },
        party: { type: "int", min: 1n, label: message("Party size", { nl: "Aantal gasten" }) },
        notes: { type: "text", nullable: true },
        arrived: {
          type: "datetime",
          server: "now",
          label: message("Arrival time", { nl: "Aankomsttijd" }),
        },
        priority: {
          type: "int",
          default: 0n,
          label: message("Queue priority", { nl: "Wachtrijprioriteit" }),
        },
        table: { type: "cafe.Table", nullable: true, label: tableCaption },
        from: {
          type: "datetime",
          nullable: true,
          label: message("Reserved from", { nl: "Gereserveerd vanaf" }),
        },
        until: {
          type: "datetime",
          nullable: true,
          label: message("Reserved until", { nl: "Gereserveerd tot" }),
        },
        estimated_until: {
          type: "datetime",
          nullable: true,
          label: message("Estimated seating end", { nl: "Geschat einde van het tafelgebruik" }),
        },
        seated: {
          type: "datetime",
          nullable: true,
          label: message("Actual seating time", { nl: "Werkelijk zitmoment" }),
        },
        cleared: {
          type: "datetime",
          nullable: true,
          label: message("Actual clearance time", { nl: "Werkelijk vrijgavemoment" }),
        },
        state: {
          type: "enum",
          cases: ["waiting", "reserved", "seated", "cleared", "cancelled", "no_show"],
          default: "waiting",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              waiting: waitingCaption,
              reserved: message("Reserved", { nl: "Gereserveerd" }),
              seated: message("Seated", { nl: "Zittend" }),
              cleared: message("Cleared", { nl: "Vrijgegeven" }),
              cancelled: message("Cancelled", { nl: "Geannuleerd" }),
              no_show: noShowCaption,
            },
          },
        },
        reason: { type: "text", nullable: true },
      },
    },
  },
  pure: {
    "cafe.available": {
      handler: "available",
      inputs: {
        table: { type: "cafe.Table" },
        from: { type: "datetime" },
        until: { type: "datetime" },
        skip: { type: "cafe.Booking", nullable: true },
      },
      result: "bool",
    },
  },
  preferences: {
    cafe: {
      fields: {
        cafe: { type: "cafe.Cafe", nullable: true, default: null, label: cafeCaption },
        view: {
          type: "enum",
          cases: ["all", "waiting", "reservations", "occupancy"],
          default: "all",
          label: {
            text: message("Initial view", { nl: "Beginweergave" }),
            values: {
              all: message("All", { nl: "Alles" }),
              waiting: waitingCaption,
              reservations: message("Reservations", { nl: "Reserveringen" }),
              occupancy: message("Physical occupancy", { nl: "Werkelijke bezetting" }),
            },
          },
        },
      },
    },
  },
  operations: {
    "cafe.Cafe.create": {
      handler: "createCafe",
      kind: "create",
      model: "cafe.Cafe",
      by: "cafe.host",
      read: false,
      inputs: { fields: ["location", "name"] },
      when: "Cafe",
    },
    "cafe.Cafe.update": {
      handler: "updateCafe",
      kind: "update",
      model: "cafe.Cafe",
      by: "cafe.host",
      read: false,
      inputs: { record: { type: "cafe.Cafe" }, changes: { fields: ["name"] } },
      when: "Cafe",
    },
    "cafe.Table.create": {
      handler: "createTable",
      kind: "create",
      model: "cafe.Table",
      by: "cafe.host",
      read: false,
      inputs: { parent: { type: "cafe.Cafe" }, fields: ["name", "zone", "seats", "active"] },
      when: "Table",
    },
    "cafe.Table.update": {
      handler: "updateTable",
      kind: "update",
      model: "cafe.Table",
      by: "cafe.host",
      read: false,
      inputs: {
        record: { type: "cafe.Table" },
        changes: { fields: ["name", "zone", "seats", "active"] },
      },
      when: "Table",
    },
    "cafe.Booking.create": {
      handler: "createBooking",
      kind: "create",
      model: "cafe.Booking",
      by: "cafe.host",
      read: false,
      inputs: {
        parent: { type: "cafe.Cafe" },
        fields: ["name", "contact", "party", "notes", "priority"],
      },
      when: "Booking",
    },
    "cafe.Booking.update": {
      handler: "updateBooking",
      kind: "update",
      model: "cafe.Booking",
      by: "cafe.host",
      read: false,
      inputs: {
        record: { type: "cafe.Booking" },
        changes: { fields: ["name", "contact", "party", "notes", "priority"] },
      },
      when: "Booking",
    },
    "cafe.reserve": {
      handler: "reserve",
      by: "cafe.host",
      read: false,
      label: message("Reserve dining table", { nl: "Cafétafel reserveren" }),
      description: message(
        "Confirm or move a suitable reservation; changing a confirmed interval requires a recorded reason.",
        {
          nl: "Bevestig of verplaats een geschikte reservering; wijziging van een bevestigd tijdvak vereist een vastgelegde reden.",
        },
      ),
      inputs: {
        booking: { type: "cafe.Booking" },
        table: { type: "cafe.Table" },
        from: { type: "datetime", label: message("From", { nl: "Van" }) },
        until: { type: "datetime", label: message("Until", { nl: "Tot" }) },
        reason: { type: "text", nullable: true },
      },
    },
    "cafe.seat": {
      handler: "seat",
      by: "cafe.host",
      read: false,
      label: message("Record seating", { nl: "Plaatsnemen vastleggen" }),
      description: message("Record actual seating only at a currently clear suitable table.", {
        nl: "Leg werkelijk plaatsnemen alleen aan een momenteel vrije geschikte tafel vast.",
      }),
      inputs: {
        booking: { type: "cafe.Booking" },
        table: { type: "cafe.Table" },
        estimated_until: {
          type: "datetime",
          label: message("Estimated seating end", { nl: "Geschat einde van het tafelgebruik" }),
        },
      },
    },
    "cafe.clear": {
      handler: "clear",
      by: "cafe.host",
      read: false,
      label: message("Clear dining table", { nl: "Cafétafel vrijgeven" }),
      description: message(
        "Clear only this currently seated party; elapsed estimates cannot perform this action.",
        {
          nl: "Geef alleen deze momenteel zittende groep vrij; verstreken schattingen kunnen deze handeling niet uitvoeren.",
        },
      ),
      inputs: { booking: { type: "cafe.Booking" }, reason: { type: "text" } },
    },
    "cafe.cancel": {
      handler: "cancel",
      by: "cafe.host",
      read: false,
      description: message("Resolve a waiting or reserved cancellation or no-show with a reason.", {
        nl: "Verwerk een annulering of niet-verschenen groep met een reden bij een wachtende of gereserveerde boeking.",
      }),
      inputs: {
        booking: { type: "cafe.Booking" },
        missed: { type: "bool", label: noShowCaption },
        reason: { type: "text" },
      },
    },
  },
  pages: [cafePageDescriptor],
  disabled: ["cafe.Cafe.delete", "cafe.Table.delete", "cafe.Booking.delete"],
};

export function canApp() {
  const crudWhen = {
    Cafe: async (c, row) => await can_work(c, c.actor, row.location),
    Table: async (c, row) => await can_work(c, c.actor, row.parent.location),
    Booking: async (c, row) =>
      (await can_work(c, c.actor, row.parent.location)) &&
      ["waiting", "reserved"].includes(row.state),
  };
  return {
    crudWhen,

    read: {
      "Cafe.read.1": async (c, row) =>
        hasRole(c, "cafe.host") && (await can_work(c, c.actor, row.location)),
      "Table.read.1": async (c, row) =>
        hasRole(c, "cafe.host") && (await can_work(c, c.actor, row.parent.location)),
      "Booking.read.1": async (c, row) =>
        hasRole(c, "cafe.host") && (await can_work(c, c.actor, row.parent.location)),
    },
    derives: {
      "Booking.overdue": (c, row) =>
        row.seated !== null &&
        row.cleared === null &&
        row.estimated_until !== null &&
        compareInstant(row.estimated_until, c.now) <= 0,
      "Booking.conflict": async (c, row) =>
        row.state === "reserved" &&
        row.table !== null &&
        row.from !== null &&
        (await any(
          records(c, "cafe.Booking", { parent: row.parent }),
          (booking) =>
            !same(booking, row) &&
            same(booking.table, row.table) &&
            booking.seated !== null &&
            booking.cleared === null &&
            (compareInstant(row.from, c.now) <= 0 ||
              booking.overdue ||
              (booking.estimated_until !== null &&
                compareInstant(booking.estimated_until, row.from) > 0)),
        )),
    },
    invariants: {
      "Table.require.1": async (c, row) =>
        !(await any(
          records(c, "cafe.Booking", { parent: row.parent }),
          (booking) =>
            same(booking.table, row) &&
            (booking.state === "reserved" ||
              (booking.seated !== null && booking.cleared === null)) &&
            (!row.active || booking.party > row.seats),
        )),
      "Booking.require.1": (c, row) => row.table === null || same(row.table.parent, row.parent),
      "Booking.require.2": (c, row) =>
        (row.from === null && row.until === null) ||
        (row.from !== null && row.until !== null && compareInstant(row.from, row.until) < 0),
      "Booking.require.3": async (c, row) =>
        row.state !== "reserved" ||
        (row.table !== null &&
          row.from !== null &&
          row.until !== null &&
          row.party <= row.table.seats &&
          (await available(c, row.table, row.from, row.until, row))),
      "Booking.require.4": (c, row) =>
        row.seated === null ||
        (row.table !== null &&
          row.estimated_until !== null &&
          compareInstant(row.seated, row.estimated_until) < 0 &&
          (row.cleared === null || compareInstant(row.seated, row.cleared) <= 0)),
      "Booking.require.5": async (c, row) =>
        row.state !== "seated" ||
        (row.seated !== null &&
          row.cleared === null &&
          row.table !== null &&
          row.table.active &&
          row.party <= row.table.seats &&
          !(await any(
            records(c, "cafe.Booking", { parent: row.parent }),
            (booking) =>
              !same(booking, row) &&
              same(booking.table, row.table) &&
              booking.seated !== null &&
              booking.cleared === null,
          ))),
      "Booking.require.6": (c, row) =>
        row.state !== "cleared" || (row.seated !== null && row.cleared !== null),
      "Booking.require.7": (c, row) =>
        !["cancelled", "no_show"].includes(row.state) || (row.reason ?? "").trim() !== "",
    },
    available,
    async createCafe(c, input) {
      check(hasRole(c, "cafe.host"), "forbidden");
      await create(c, "cafe.Cafe", input, { when: crudWhen.Cafe });
    },
    async updateCafe(c, { record, changes }) {
      check(hasRole(c, "cafe.host"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Cafe });
    },
    async createTable(c, input) {
      check(hasRole(c, "cafe.host"), "forbidden");
      await create(c, "cafe.Table", input, { when: crudWhen.Table });
    },
    async updateTable(c, { record, changes }) {
      check(hasRole(c, "cafe.host"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Table });
    },
    async createBooking(c, input) {
      check(hasRole(c, "cafe.host"), "forbidden");
      await create(c, "cafe.Booking", input, { when: crudWhen.Booking });
    },
    async updateBooking(c, { record, changes }) {
      check(hasRole(c, "cafe.host"), "forbidden");
      await set(c, record, changes, { when: crudWhen.Booking });
    },
    async reserve(c, { booking, table, from, until, reason }) {
      check(hasRole(c, "cafe.host"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          ["waiting", "reserved"].includes(booking.state) &&
          (booking.state === "waiting" || (reason ?? "").trim() !== "") &&
          same(table.parent, booking.parent) &&
          booking.party <= table.seats &&
          compareInstant(from, c.now) >= 0 &&
          compareInstant(from, until) < 0 &&
          (await available(c, table, from, until, booking)),
      );
      await set(c, booking, { table, from, until, state: "reserved", reason });
    },
    async seat(c, { booking, table, estimated_until }) {
      check(hasRole(c, "cafe.host"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          ["waiting", "reserved"].includes(booking.state) &&
          (booking.state === "waiting" || same(booking.table, table)) &&
          same(table.parent, booking.parent) &&
          booking.party <= table.seats &&
          compareInstant(estimated_until, c.now) > 0 &&
          (await available(c, table, c.now, estimated_until, booking)) &&
          !(await any(
            records(c, "cafe.Booking", { parent: booking.parent }),
            (other) => same(other.table, table) && other.seated !== null && other.cleared === null,
          )),
      );
      await set(c, booking, { table, seated: c.now, estimated_until, state: "seated" });
    },
    async clear(c, { booking, reason }) {
      check(hasRole(c, "cafe.host"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          booking.state === "seated" &&
          booking.cleared === null &&
          reason.trim() !== "",
      );
      await set(c, booking, { state: "cleared", cleared: c.now, reason });
    },
    async cancel(c, { booking, missed, reason }) {
      check(hasRole(c, "cafe.host"), "forbidden");
      check(
        (await can_work(c, c.actor, booking.parent.location)) &&
          ["waiting", "reserved"].includes(booking.state) &&
          reason.trim() !== "",
      );
      if (missed) {
        await set(c, booking, { state: "no_show", reason });
      } else {
        await set(c, booking, { state: "cancelled", reason });
      }
    },
  };
}

export async function cafePage(c, bindings) {
  const preferences = c.preferences.cafe;
  return renderPage(
    c,
    cafePageDescriptor,
    () => [
      form({ context: c, operation: "cafe.Cafe.create" }),
      list({
        context: c,
        model: "cafe.Cafe",
        where: (cafe) => preferences.cafe === null || same(cafe, preferences.cafe),
        renderRow: (cafe, view) => [
          card({
            context: view,
            title: message("Café and table definitions", { nl: "Café- en tafeldefinities" }),
            children: [
              edit({ context: view, operation: "cafe.Cafe.update", record: cafe }),
              text({ context: view, values: [cafe.location] }),
              form({ context: view, operation: "cafe.Table.create", arguments: { parent: cafe } }),
              table({
                context: view,
                model: "cafe.Table",
                parent: cafe,
                columns: ["name", "zone", "seats", "active"],
                renderRow: (row, rowView) => [
                  edit({ context: rowView, operation: "cafe.Table.update", record: row }),
                  history({ context: rowView, record: row }),
                ],
              }),
            ],
          }),
          card({
            context: view,
            title: message("Walk-in intake", { nl: "Invoer van binnenlopende gasten" }),
            children: [
              form({
                context: view,
                operation: "cafe.Booking.create",
                arguments: { parent: cafe },
                display: "inline",
              }),
            ],
          }),
          card({
            context: view,
            title: message("Waiting, reservations and physical occupancy", {
              nl: "Wachten, reserveringen en werkelijke bezetting",
            }),
            children: [
              tabs({ context: view, selector: "cafe.view", value: preferences.view }),
              table({
                context: view,
                model: "cafe.Booking",
                parent: cafe,
                where: (booking) =>
                  preferences.view === "all" ||
                  (preferences.view === "waiting" && booking.state === "waiting") ||
                  (preferences.view === "reservations" && booking.state === "reserved") ||
                  (preferences.view === "occupancy" &&
                    booking.seated !== null &&
                    booking.cleared === null),
                columns: [
                  "name",
                  "party",
                  "priority",
                  "arrived",
                  "table",
                  "from",
                  "until",
                  "estimated_until",
                  "seated",
                  "cleared",
                  "state",
                  "overdue",
                  "conflict",
                ],
                order: ["-priority", "arrived"],
                filter: ["state"],
                display: "split",
                renderRow: (booking, rowView) => [
                  // Desired: badge row.state — no verified @canlang/ui badge factory yet; awaits the L5 producer contract.
                  edit({ context: rowView, operation: "cafe.Booking.update", record: booking }),
                  actions({
                    context: rowView,
                    operations: ["cafe.reserve", "cafe.seat", "cafe.clear", "cafe.cancel"],
                    boundArgs: { booking },
                  }),
                  details({
                    context: rowView,
                    caption: message("Guest and planned interval evidence", {
                      nl: "Gastgegevens en geplande tijdvakken",
                    }),
                    children: [
                      text({
                        context: rowView,
                        values: [booking.contact, booking.notes, booking.reason],
                      }),
                    ],
                  }),
                  ...(booking.conflict
                    ? [
                        details({
                          context: rowView,
                          caption: message("Uncleared diners affecting this reservation", {
                            nl: "Niet-vrijgegeven gasten die deze reservering raken",
                          }),
                          children: [
                            table({
                              context: rowView,
                              model: "cafe.Booking",
                              parent: cafe,
                              where: (occupant) =>
                                same(occupant.table, booking.table) &&
                                occupant.seated !== null &&
                                occupant.cleared === null,
                              columns: [
                                "name",
                                "party",
                                "table",
                                "seated",
                                "estimated_until",
                                "overdue",
                              ],
                              renderRow: (occupant, occupantView) => [
                                form({
                                  context: occupantView,
                                  operation: "cafe.clear",
                                  arguments: { booking: occupant },
                                }),
                              ],
                            }),
                          ],
                        }),
                      ]
                    : []),
                  ...(booking.seated !== null && booking.cleared === null
                    ? [
                        details({
                          context: rowView,
                          caption: message("Upcoming reservations affected by this occupancy", {
                            nl: "Toekomstige reserveringen geraakt door deze bezetting",
                          }),
                          children: [
                            table({
                              context: rowView,
                              model: "cafe.Booking",
                              parent: cafe,
                              where: (upcoming) =>
                                upcoming.state === "reserved" &&
                                same(upcoming.table, booking.table) &&
                                upcoming.conflict,
                              columns: ["name", "party", "table", "from", "until", "conflict"],
                              order: ["from"],
                              renderRow: (upcoming, upcomingView) => [
                                form({
                                  context: upcomingView,
                                  operation: "cafe.reserve",
                                  arguments: { booking: upcoming },
                                }),
                                form({
                                  context: upcomingView,
                                  operation: "cafe.cancel",
                                  arguments: { booking: upcoming },
                                }),
                              ],
                            }),
                          ],
                        }),
                      ]
                    : []),
                  history({ context: rowView, record: booking }),
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
  const cafe = {
    model: "cafe.Cafe",
    dependencies: [test_site],
    value: async (c, s) => ({ location: s.test_site, name: "Café" }),
  };
  const table = {
    model: "cafe.Table",
    dependencies: [cafe],
    value: async (c, s) => ({ parent: s.cafe, name: "1", zone: "Main", seats: 4n }),
  };
  const spare = {
    model: "cafe.Table",
    dependencies: [cafe],
    value: async (c, s) => ({ parent: s.cafe, name: "2", zone: "Main", seats: 4n }),
  };
  const walk_in = {
    model: "cafe.Booking",
    dependencies: [cafe],
    value: async (c, s) => ({ parent: s.cafe, name: "Walk-in", party: 2n }),
  };
  const diners = {
    model: "cafe.Booking",
    dependencies: [cafe, table],
    value: async (c, s) => ({
      parent: s.cafe,
      name: "Guest",
      party: 2n,
      table: s.table,
      seated: subtractDuration(c.now, 3600000n),
      estimated_until: subtractDuration(c.now, 60000n),
      state: "seated",
    }),
  };
  const upcoming = {
    model: "cafe.Booking",
    dependencies: [cafe, table],
    value: async (c, s) => ({
      parent: s.cafe,
      name: "Reservation",
      party: 2n,
      table: s.table,
      from: addDuration(c.now, 1800000n),
      until: addDuration(c.now, 3600000n),
      state: "reserved",
    }),
  };
  return {
    cafe,
    table,
    spare,
    walk_in,
    diners,
    upcoming,
    examples: [
      {
        operation: "cafe.Table.update",
        seed: [test_worker, upcoming],
        dependencies: [table],
        inputs: async (c, s) => ({ record: s.table, changes: { seats: 4n } }),
        selectors: ["as", "changes.seats", "changes.active"],
        observations: [
          async (c, s) => s.record.seats,
          async (c, s) => s.record.active,
          async (c, s) => s.upcoming.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 3n, true],
            expected: async (c, s) => [3n, true, "reserved"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 1n, true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 4n, false],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "cafe.Table.update",
        seed: [test_worker, diners],
        dependencies: [table],
        inputs: async (c, s) => ({ record: s.table, changes: { active: true } }),
        selectors: ["as", "changes.active", "changes.seats"],
        observations: [
          async (c, s) => s.record.active,
          async (c, s) => s.record.seats,
          async (c, s) => s.diners.cleared,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", false, 4n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", true, 1n],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", true, 3n],
            expected: async (c, s) => [true, 3n, null],
          },
        ],
      },
      {
        operation: "cafe.Table.update",
        seed: [test_worker, diners],
        dependencies: [table],
        inputs: async (c, s) => ({ record: s.table, changes: { active: false, seats: 1n } }),
        selectors: ["as", "diners.state", "diners.cleared"],
        observations: [
          async (c, s) => s.record.active,
          async (c, s) => s.record.seats,
          async (c, s) => s.diners.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", "cleared", c.now],
            expected: async (c, s) => [false, 1n, "cleared"],
          },
        ],
      },
      {
        operation: "cafe.Table.update",
        seed: [test_worker],
        dependencies: [table],
        inputs: async (c, s) => ({ record: s.table, changes: { active: false, seats: 1n } }),
        selectors: ["as"],
        observations: [async (c, s) => s.record.active, async (c, s) => s.record.seats],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host"],
            expected: async (c, s) => [false, 1n],
          },
          { dependencies: [], values: async (c, s) => ["members"], error: "forbidden" },
        ],
      },
      {
        operation: "cafe.Booking.create",
        seed: [test_worker],
        dependencies: [cafe],
        inputs: async (c, s) => ({ parent: s.cafe, name: "Walk-in", party: 2n }),
        selectors: ["as"],
        observations: [
          async (c, s) => (await first(records(c, "cafe.Booking", { parent: s.cafe }))).state,
          async (c, s) => (await first(records(c, "cafe.Booking", { parent: s.cafe }))).table,
          async (c, s) => (await first(records(c, "cafe.Booking", { parent: s.cafe }))).from,
          async (c, s) => (await first(records(c, "cafe.Booking", { parent: s.cafe }))).seated,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host"],
            expected: async (c, s) => ["waiting", null, null, null],
          },
          { dependencies: [], values: async (c, s) => ["members"], error: "forbidden" },
        ],
      },
      {
        operation: "cafe.Booking.update",
        seed: [test_worker],
        dependencies: [upcoming],
        inputs: async (c, s) => ({
          record: s.upcoming,
          changes: { party: 3n, notes: "Window requested" },
        }),
        selectors: ["as", "changes.party"],
        observations: [
          async (c, s) => s.record.party,
          async (c, s) => s.record.notes,
          async (c, s) => s.record.state,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 3n],
            expected: async (c, s) => [3n, "Window requested", "reserved"],
          },
          { dependencies: [], values: async (c, s) => ["cafe.host", 5n], error: "rule_failed" },
          { dependencies: [], values: async (c, s) => ["members", 3n], error: "forbidden" },
        ],
      },
      {
        operation: "cafe.reserve",
        seed: [test_worker],
        dependencies: [walk_in, table],
        inputs: async (c, s) => ({
          booking: s.walk_in,
          table: s.table,
          from: addDuration(c.now, 1800000n),
          until: addDuration(c.now, 3600000n),
          reason: null,
        }),
        selectors: ["as", "table.seats", "table.active", "test_worker.active"],
        observations: [
          async (c, s) => s.booking.state,
          async (c, s) => s.booking.from,
          async (c, s) => s.booking.seated,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 4n, true, true],
            expected: async (c, s) => ["reserved", addDuration(c.now, 1800000n), null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 1n, true, true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 4n, false, true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", 4n, true, true],
            error: "forbidden",
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", 4n, true, false],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "cafe.reserve",
        seed: [test_worker],
        dependencies: [upcoming, spare],
        inputs: async (c, s) => ({
          booking: s.upcoming,
          table: s.spare,
          from: addDuration(c.now, 3600000n),
          until: addDuration(c.now, 7200000n),
          reason: "Move away from overrun",
        }),
        selectors: ["as", "reason"],
        observations: [
          async (c, s) => s.booking.table,
          async (c, s) => s.booking.from,
          async (c, s) => s.booking.reason,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", "Move away from overrun"],
            expected: async (c, s) => [
              s.spare,
              addDuration(c.now, 3600000n),
              "Move away from overrun",
            ],
          },
          { dependencies: [], values: async (c, s) => ["cafe.host", " "], error: "rule_failed" },
        ],
      },
      {
        operation: "cafe.reserve",
        seed: [test_worker, upcoming, diners],
        dependencies: [walk_in, table],
        inputs: async (c, s) => ({
          booking: s.walk_in,
          table: s.table,
          from: addDuration(c.now, 3600000n),
          until: addDuration(c.now, 7200000n),
          reason: null,
        }),
        selectors: ["as", "from"],
        observations: [
          async (c, s) => s.booking.state,
          async (c, s) => s.upcoming.conflict,
          async (c, s) => s.diners.cleared,
          async (c, s) => s.diners.overdue,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", addDuration(c.now, 3600000n)],
            expected: async (c, s) => ["reserved", true, null, true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", addDuration(c.now, 2700000n)],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "cafe.seat",
        seed: [test_worker],
        dependencies: [walk_in, table],
        inputs: async (c, s) => ({
          booking: s.walk_in,
          table: s.table,
          estimated_until: addDuration(c.now, 3600000n),
        }),
        selectors: ["as", "estimated_until"],
        observations: [
          async (c, s) => s.booking.state,
          async (c, s) => s.booking.seated,
          async (c, s) => s.booking.from,
          async (c, s) => s.booking.until,
          async (c, s) => s.booking.estimated_until,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", addDuration(c.now, 3600000n)],
            expected: async (c, s) => ["seated", c.now, null, null, addDuration(c.now, 3600000n)],
          },
          { dependencies: [], values: async (c, s) => ["cafe.host", c.now], error: "rule_failed" },
          {
            dependencies: [],
            values: async (c, s) => ["members", addDuration(c.now, 3600000n)],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "cafe.seat",
        seed: [test_worker, diners, upcoming],
        dependencies: [walk_in, table],
        inputs: async (c, s) => ({
          booking: s.walk_in,
          table: s.table,
          estimated_until: addDuration(c.now, 600000n),
        }),
        selectors: ["as"],
        observations: [async (c, s) => s.diners.overdue, async (c, s) => s.upcoming.conflict],
        rows: [{ dependencies: [], values: async (c, s) => ["cafe.host"], error: "rule_failed" }],
      },
      {
        operation: "cafe.seat",
        seed: [test_worker],
        dependencies: [upcoming, table],
        inputs: async (c, s) => ({
          booking: s.upcoming,
          table: s.table,
          estimated_until: addDuration(c.now, 7200000n),
        }),
        selectors: ["as"],
        observations: [
          async (c, s) => s.booking.table,
          async (c, s) => s.booking.from,
          async (c, s) => s.booking.until,
          async (c, s) => s.booking.estimated_until,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host"],
            expected: async (c, s) => [
              s.table,
              addDuration(c.now, 1800000n),
              addDuration(c.now, 3600000n),
              addDuration(c.now, 7200000n),
            ],
          },
        ],
      },
      {
        operation: "cafe.clear",
        seed: [test_worker, upcoming],
        dependencies: [diners],
        inputs: async (c, s) => ({ booking: s.diners, reason: "Table cleared" }),
        selectors: ["as", "reason"],
        observations: [
          async (c, s) => s.booking.state,
          async (c, s) => s.booking.cleared,
          async (c, s) => s.booking.reason,
          async (c, s) => s.upcoming.conflict,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", "Table cleared"],
            expected: async (c, s) => ["cleared", c.now, "Table cleared", false],
          },
          { dependencies: [], values: async (c, s) => ["cafe.host", " "], error: "rule_failed" },
          {
            dependencies: [],
            values: async (c, s) => ["members", "Table cleared"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "cafe.clear",
        seed: [test_worker],
        dependencies: [diners],
        inputs: async (c, s) => ({ booking: s.diners, reason: "Table cleared" }),
        selectors: ["as", "request.booking.version"],
        observations: [async (c, s) => s.booking.state],
        rows: [{ dependencies: [], values: async (c, s) => ["cafe.host", 0n], error: "conflict" }],
      },
      {
        operation: "cafe.clear",
        seed: [test_worker],
        dependencies: [walk_in],
        inputs: async (c, s) => ({ booking: s.walk_in, reason: "Wrong party" }),
        selectors: ["as"],
        observations: [async (c, s) => s.booking.state],
        rows: [{ dependencies: [], values: async (c, s) => ["cafe.host"], error: "rule_failed" }],
      },
      {
        operation: "cafe.cancel",
        seed: [test_worker, diners],
        dependencies: [upcoming],
        inputs: async (c, s) => ({
          booking: s.upcoming,
          missed: false,
          reason: "Occupied table; guest declined relocation",
        }),
        selectors: ["as", "missed", "reason"],
        observations: [
          async (c, s) => s.booking.state,
          async (c, s) => s.booking.reason,
          async (c, s) => s.diners.cleared,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", false, "Guest declined relocation"],
            expected: async (c, s) => ["cancelled", "Guest declined relocation", null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", true, "Guest did not arrive"],
            expected: async (c, s) => ["no_show", "Guest did not arrive", null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["cafe.host", true, " "],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", false, "Guest declined relocation"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "cafe.cancel",
        seed: [test_worker],
        dependencies: [diners],
        inputs: async (c, s) => ({ booking: s.diners, missed: false, reason: "Still dining" }),
        selectors: ["as"],
        observations: [async (c, s) => s.booking.state],
        rows: [{ dependencies: [], values: async (c, s) => ["cafe.host"], error: "rule_failed" }],
      },
    ],
  };
}
