import {
  addDuration,
  cancel,
  require as check,
  compareInstant,
  count,
  create,
  delivery,
  first,
  format,
  hasRole,
  int64,
  records,
  same,
  schedule,
  secretEqual,
  send,
  set,
  subtractDuration,
} from "@canlang/stdlib";
import {
  actions,
  card,
  details,
  history,
  message,
  metrics,
  renderPage,
  table,
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

// Canonical references exported by the authored package; no ingress implementation.
export const Heartbeat = "check.Heartbeat";

export const PingV1 = "check.PingV1";

/* Check and its health/notice children use the same D1 owner as employee grants.
 * Developer maintenance is a proposed external canonical model-admission path:
 * it authenticates its configured source/team, preserves receipts/versions/fence,
 * and invokes Check.create/update hooks and invariants. There is no product CRUD,
 * maintenance UI/MCP capability or implemented raw-SQL bypass. Ping ingress must
 * map configured token/site identity to Heartbeat and acknowledge only commit.
 * secretEqual compares secret bytes without exposing them. No adapter exists here.
 */
const applicationCaption = message("Application", { nl: "Applicatie" });

const jobHealthPageDescriptor = {
  owner: "check",
  path: "/job-health",
  title: message("Job health", { nl: "Taakgezondheid" }),
  description: message("Read configured checks and perform only authorized pause and resume.", {
    nl: "Lees geconfigureerde controles en voer uitsluitend toegestane pauze- en hervatacties uit.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "check.operations"), "forbidden");
    return {};
  },
  render: jobHealthPage,
};

export const appDefinition = {
  id: "CanCheck",
  uses: ["check"],
  description: message(
    "Help the workspace operator detect missed check-ins from scheduled booking reconciliation, invoice reminders, reporting imports, and maintenance jobs.",
    {
      nl: "Help de werkplekexploitant ontbrekende signalen detecteren van geplande boekingsafstemming, factuurherinneringen, rapportimports en onderhoudstaken.",
    },
  ),
  packages: {
    check: {
      description: message(
        "Monitor durable heartbeat receipts without treating health as proof of successful business work.",
        {
          nl: "Bewaak opgeslagen heartbeatontvangsten zonder gezondheid als bewijs van geslaagd bedrijfswerk te behandelen.",
        },
      ),
      roles: {
        operations: { id: "check.operations", label: message("Operations", { nl: "Operations" }) },
      },
    },
  },
  bindings: {
    "check.Pings": { capability: "check.PingV1", from: "deployment.pings" },
    "check.Alerts": { capability: "catch.AlertsV1", from: "deployment.alerts" },
  },
  models: {
    "check.Check": {
      label: message("Job check", { nl: "Taakcontrole" }),
      invariants: ["Check.require.1"],
      readGrants: [
        {
          rule: "Check.read.1",
          fields: [
            "name",
            "application",
            "purpose",
            "location",
            "owner",
            "period",
            "grace",
            "enabled",
            "last_ping",
            "due",
            "armed",
            "revision",
            "state",
          ],
        },
      ],
      fields: {
        name: { type: "text" },
        application: { type: "text", label: applicationCaption },
        purpose: { type: "text", label: message("Purpose", { nl: "Doel" }) },
        location: { type: Location, nullable: true },
        owner: { type: "user", label: message("Responsible person", { nl: "Verantwoordelijke" }) },
        period: {
          type: "duration",
          label: message("Expected period", { nl: "Verwachte periode" }),
        },
        grace: {
          type: "duration",
          default: 0n,
          label: message("Grace period", { nl: "Respijtperiode" }),
        },
        history_days: {
          type: "int",
          min: 1n,
          default: 90n,
          label: message("History retention days", { nl: "Bewaartermijn historie in dagen" }),
        },
        token: { type: "secret", unique: true, server: "random_secret" },
        alert: { type: "url", label: message("Alert destination", { nl: "Meldingsbestemming" }) },
        enabled: { type: "bool", default: true },
        last_ping: {
          type: "datetime",
          nullable: true,
          label: message("Last durable heartbeat", { nl: "Laatste opgeslagen heartbeat" }),
        },
        due: {
          type: "datetime",
          nullable: true,
          label: message("Next authoritative deadline", { nl: "Volgende gezaghebbende deadline" }),
        },
        armed: {
          type: "datetime",
          server: "now",
          label: message("Deadline anchor", { nl: "Startpunt deadline" }),
        },
        revision: { type: "int", default: 1n },
        state: {
          type: "enum",
          cases: ["new", "up", "late", "down", "paused"],
          default: "new",
          label: {
            text: message("State", { nl: "Status" }),
            values: {
              new: message("Never pinged", { nl: "Nog geen heartbeat" }),
              up: message("Up", { nl: "Actief" }),
              late: message("Late", { nl: "Te laat" }),
              down: message("Down", { nl: "Uitgevallen" }),
              paused: message("Paused", { nl: "Gepauzeerd" }),
            },
          },
        },
      },
    },
    "check.Transition": {
      parent: "check.Check",
      label: message("Health transition", { nl: "Gezondheidsovergang" }),
      readGrants: [{ rule: "Transition.read.1" }],
      locks: ["Transition.lock.1"],
      retainUntil: "Transition",
      fields: {
        from: { type: "check.Check.state", label: message("From", { nl: "Vanaf" }) },
        to: { type: "check.Check.state", label: message("To", { nl: "Naar" }) },
        occurred: { type: "datetime", server: "now" },
      },
    },
    "check.Notice": {
      parent: "check.Check",
      label: message("Notification delivery", { nl: "Meldingsbezorging" }),
      readGrants: [{ rule: "Notice.read.1", fields: ["parent", "kind", "transition", "revision", "delivery.id", "delivery.status", "outcome", "detail", "occurred", "created_by", "created", "updated_by", "updated", "archived_at"] }],
      locks: ["Notice.lock.1"],
      retainUntil: "Notice",
      fields: {
        kind: { type: "enum", cases: ["down", "recovery", "configuration"] },
        transition: { type: "check.Transition", nullable: true },
        revision: { type: "int" },
        delivery: { type: "delivery", operation: "check.Alerts.notify", nullable: true },
        detail: { type: "text", nullable: true, label: message("Retained safe diagnostic", { nl: "Bewaarde veilige diagnose" }) },
        occurred: { type: "datetime", server: "now" },
      },
      derived: {outcome: {type: "std.DeliveryResult.status", nullable: true, handler: "Notice.outcome", label: message("Notification outcome", {nl: "Meldingsresultaat"})}},
    },
  },
  contracts: {
    "check.Heartbeat": {
      exported: true,
      label: message("Heartbeat receipt", { nl: "Heartbeatontvangst" }),
      fields: {
        check: { type: "text", label: message("Check reference", { nl: "Controlereferentie" }) },
        token: { type: "secret" },
      },
    },
  },
  events: {
    "check.Deadline": { fields: { check: { type: "check.Check" }, revision: { type: "int" } } },
  },
  capabilities: {
    "check.PingV1": {
      exported: true,
      version: 1n,
      events: { received: { fields: { value: { type: "check.Heartbeat" } } } },
    },
  },
  preferences: {
    check: {
      validate: "preferencesValid",
      fields: {
        application: { type: "text", nullable: true, default: null, label: applicationCaption },
        location: { type: Location, nullable: true, default: null },
      },
    },
  },
  operations: {
    "check.pause": {
      handler: "pause",
      by: "check.operations",
      read: false,
      description: message("Pause deadlines and alerts while retaining the last durable receipt.", {
        nl: "Pauzeer deadlines en meldingen met behoud van de laatst opgeslagen ontvangst.",
      }),
      inputs: { check: { type: "check.Check" } },
    },
    "check.resume": {
      handler: "resume",
      by: "check.operations",
      read: false,
      description: message(
        "Resume with a fresh first-period deadline rather than an obsolete alarm.",
        { nl: "Hervat met een nieuwe eerste-periodedeadline in plaats van een verouderd alarm." },
      ),
      inputs: { check: { type: "check.Check" } },
    },
  },
  handlers: {
    "check.ping": { handler: "ping", on: "check.Pings.received" },
    "check.initial": { handler: "initial", on: "check.Check.create" },
    "check.configured": { handler: "configured", on: "check.Check.update" },
    "check.delivered": { handler: "delivered", on: "check.Alerts.notify.completed" },
    "check.deadline": { handler: "deadline", on: "check.Deadline" },
  },
  pages: [jobHealthPageDescriptor],
  disabled: [
    "check.Check.create",
    "check.Check.update",
    "check.Check.delete",
    "check.Transition.create",
    "check.Transition.update",
    "check.Transition.delete",
    "check.Notice.create",
    "check.Notice.update",
    "check.Notice.delete",
  ],
};

export function canApp() {
  return {
    read: {
      "Check.read.1": async (c, row) =>
        hasRole(c, "check.operations") &&
        (row.location === null || (await can_work(c, c.actor, row.location))),
      "Transition.read.1": async (c, row) =>
        hasRole(c, "check.operations") &&
        (row.parent.location === null || (await can_work(c, c.actor, row.parent.location))),
      "Notice.read.1": async (c, row) =>
        hasRole(c, "check.operations") &&
        (row.parent.location === null || (await can_work(c, c.actor, row.parent.location))),
    },
    derives: {"Notice.outcome": async(c,row) => (await delivery(c,{record:row,field:"delivery"},["status"]))?.status ?? null},
    invariants: {
      "Check.require.1": (c, row) =>
        row.period > 0n && row.grace >= 0n && row.alert.startsWith("https://"),
    },
    locks: {
      "Transition.lock.1": { fields: ["from", "to", "occurred"] },
      "Notice.lock.1": { fields: ["kind", "transition", "revision", "occurred"] },
    },
    retention: {
      Transition: (c, row) => addDuration(row.occurred, int64(86400000n * row.parent.history_days)),
      Notice: (c, row) => addDuration(row.occurred, int64(86400000n * row.parent.history_days)),
    },
    preferencesValid: async (c, row) =>
      row.location === null || (await can_work(c, c.actor, row.location)),
    async pause(c, { check: job }) {
      check(hasRole(c, "check.operations"), "forbidden");
      check((job.location === null || (await can_work(c, c.actor, job.location))) && job.enabled);
      const transition = await create(c, "check.Transition", {
        parent: job,
        from: job.state,
        to: "paused",
      });
      await set(c, job, {
        enabled: false,
        state: "paused",
        due: null,
        revision: int64(job.revision + 1n),
      });
      await cancel(c, job.id);
    },
    async resume(c, { check: job }) {
      check(hasRole(c, "check.operations"), "forbidden");
      check((job.location === null || (await can_work(c, c.actor, job.location))) && !job.enabled);
      const revision = int64(job.revision + 1n);
      const due = addDuration(addDuration(c.now, job.period), job.grace);
      const transition = await create(c, "check.Transition", {
        parent: job,
        from: job.state,
        to: "new",
      });
      await set(c, job, { enabled: true, state: "new", armed: c.now, due, revision });
      await schedule(c, job.id, due, "check.Deadline", { check: job, revision });
    },
    async ping(c, { event }) {
      const job = await first(
        records(c, "check.Check", { where: (row) => row.id === event.value.check }),
      );
      check(job !== null);
      check(secretEqual(job.token, event.value.token));
      await set(c, job, { last_ping: c.now });
      if (job.enabled) {
        if (job.state !== "up") {
          const transition = await create(c, "check.Transition", {
            parent: job,
            from: job.state,
            to: "up",
          });
          if (["down", "late"].includes(job.state)) {
            const notice = await create(c, "check.Notice", {
              parent: job,
              kind: "recovery",
              transition,
              revision: int64(job.revision + 1n),
            });
            const attempt = await send(
              c,
              "check.Alerts.notify",
              {
                value: {
                  source: notice.id,
                  destination: job.alert,
                  message: format(
                    c,
                    message("Job heartbeat recovered", { nl: "Heartbeat van taak hersteld" }),
                    { locale: null },
                  ),
                },
              },
              { when: () => job.enabled && job.state === "up" },
            );
            await set(c, notice, { delivery: attempt });
          }
        }
        const revision = int64(job.revision + 1n);
        const due = addDuration(c.now, job.period);
        await set(c, job, { armed: c.now, state: "up", due, revision });
        await schedule(c, job.id, due, "check.Deadline", { check: job, revision });
      }
    },
    async initial(c, { event }) {
      if (event.after.enabled) {
        await set(c, event.after, {
          armed: c.now,
          state: "new",
          due: addDuration(addDuration(c.now, event.after.period), event.after.grace),
        });
        await schedule(c, event.after.id, event.after.due, "check.Deadline", {
          check: event.after,
          revision: event.after.revision,
        });
      } else {
        await set(c, event.after, { state: "paused", due: null });
      }
    },
    async configured(c, { event }) {
      if (
        event.before.name !== event.after.name ||
        event.before.application !== event.after.application ||
        event.before.purpose !== event.after.purpose ||
        !same(event.before.location, event.after.location) ||
        !same(event.before.owner, event.after.owner) ||
        event.before.period !== event.after.period ||
        event.before.grace !== event.after.grace ||
        event.before.history_days !== event.after.history_days ||
        !secretEqual(event.before.token, event.after.token) ||
        event.before.alert !== event.after.alert ||
        event.before.enabled !== event.after.enabled
      ) {
        await set(c, event.after, { revision: int64(event.before.revision + 1n) });
        if (
          event.before.period !== event.after.period ||
          event.before.grace !== event.after.grace ||
          event.before.enabled !== event.after.enabled
        ) {
          if (event.after.enabled) {
            await set(c, event.after, {
              armed: c.now,
              state: "new",
              due: addDuration(addDuration(c.now, event.after.period), event.after.grace),
            });
          } else {
            await set(c, event.after, { state: "paused", due: null });
          }
          if (event.before.state !== event.after.state) {
            const transition = await create(c, "check.Transition", {
              parent: event.after,
              from: event.before.state,
              to: event.after.state,
            });
          }
        }
        if (event.after.enabled && event.after.due !== null) {
          await schedule(c, event.after.id, event.after.due, "check.Deadline", {
            check: event.after,
            revision: event.after.revision,
          });
        } else {
          await cancel(c, event.after.id);
        }
        if (event.after.enabled) {
          const notice = await create(c, "check.Notice", {
            parent: event.after,
            kind: "configuration",
            revision: event.after.revision,
          });
          const attempt = await send(
            c,
            "check.Alerts.notify",
            {
              value: {
                source: notice.id,
                destination: event.after.alert,
                message: format(
                  c,
                  message("Job check configuration changed", {
                    nl: "Configuratie van taakcontrole gewijzigd",
                  }),
                  { locale: null },
                ),
              },
            },
            { when: () => event.after.enabled },
          );
          await set(c, notice, { delivery: attempt });
        }
      }
    },
    async deadline(c, { event }) {
      const job = event.check;
      check(
        job.enabled &&
          job.revision === event.revision &&
          job.due !== null &&
          compareInstant(c.now, job.due) >= 0,
      );
      if (compareInstant(c.now, addDuration(addDuration(job.armed, job.period), job.grace)) >= 0) {
        if (job.state !== "down") {
          const transition = await create(c, "check.Transition", {
            parent: job,
            from: job.state,
            to: "down",
          });
          await set(c, job, { state: "down", due: null });
          const notice = await create(c, "check.Notice", {
            parent: job,
            kind: "down",
            transition,
            revision: job.revision,
          });
          const attempt = await send(
            c,
            "check.Alerts.notify",
            {
              value: {
                source: notice.id,
                destination: job.alert,
                message: format(
                  c,
                  message("Job heartbeat missed", { nl: "Heartbeat van taak ontbreekt" }),
                  { locale: null },
                ),
              },
            },
            { when: () => job.enabled && job.state === "down" },
          );
          await set(c, notice, { delivery: attempt });
        }
      } else {
        if (job.state !== "late") {
          const transition = await create(c, "check.Transition", {
            parent: job,
            from: job.state,
            to: "late",
          });
        }
        const due = addDuration(addDuration(job.armed, job.period), job.grace);
        await set(c, job, { state: "late", due });
        await schedule(c, job.id, due, "check.Deadline", { check: job, revision: job.revision });
      }
    },
    async delivered(c, { event }) {
      const notice = await first(
        records(c, "check.Notice", { where: async (row) => (await delivery(c,{record:row,field:"delivery"},["id"]))?.id === event.delivery_id }),
      );
      check(notice !== null);
      // Latest safe diagnostic retains its independent Notice lifetime.
      await set(c, notice, { detail: event.error?.message ?? null });
    },
  };
}

export async function jobHealthPage(c, bindings) {
  return renderPage(
    c,
    jobHealthPageDescriptor,
    () => [
      table({
        context: c,
        model: "check.Check",
        columns: [
          "name",
          "application",
          "location",
          "owner",
          "state",
          "enabled",
          "last_ping",
          "due",
          "period",
          "grace",
        ],
        order: ["name"],
        search: ["name"],
        filter: ["application", "location", "state"],
        defaults: {
          application: c.preferences.check.application,
          location: c.preferences.check.location,
        },
        display: "split",
        renderRow: (job, view) => [
          card({
            context: view,
            title: message("Current recorded health", { nl: "Huidige vastgelegde gezondheid" }),
            children: [
              text({
                context: view,
                values: [
                  job.purpose,
                  job.state,
                  job.enabled,
                  job.last_ping,
                  job.due,
                  job.armed,
                  job.revision,
                ],
              }),
              ...(job.last_ping === null
                ? [
                    card({
                      context: view,
                      title: message("No heartbeat received yet", {
                        nl: "Nog geen heartbeat ontvangen",
                      }),
                      children: [],
                    }),
                  ]
                : []),
              metrics({ context: view, result: job, fields: ["period", "grace"] }),
              actions({
                context: view,
                operations: ["check.pause", "check.resume"],
                boundArgs: { check: job },
              }),
            ],
          }),
          details({
            context: view,
            caption: message("Transition and recovery history", {
              nl: "Overgangs- en herstelhistorie",
            }),
            children: [
              table({
                context: view,
                model: "check.Transition",
                parent: job,
                columns: ["from", "to", "occurred"],
                order: ["-occurred"],
              }),
              table({
                context: view,
                model: "check.Notice",
                parent: job,
                columns: ["kind", "outcome", "detail", "occurred"],
                order: ["-occurred"],
              }),
              history({ context: view, record: job }),
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
  { provider: "employee", member: "test_worker", alias: "test_worker" },
  { provider: "rent_catalog", member: "test_site", alias: "test_site" },
];

export function exampleFixtures({ self, other, imported }) {
  const heartbeat = {
    model: "check.Check",
    dependencies: [],
    value: async (c, s) => ({
      name: "Reconcile",
      application: "Billing",
      purpose: "Job heartbeat",
      owner: s.self,
      period: 300000n,
      alert: "https://example.test/alert",
    }),
  };
  const foreign_check = {
    model: "check.Check",
    dependencies: [],
    value: async (c, s) => ({
      name: "Import reporting",
      application: "Reporting",
      purpose: "Reporting imports",
      owner: s.other,
      period: 3600000n,
      alert: "https://example.test/report-alert",
    }),
  };
  const notification = {
    model: "check.Notice",
    dependencies: [heartbeat],
    value: async (c, s) => ({
      parent: s.heartbeat,
      kind: "recovery",
      revision: 1n,
    }),
  };
  const attempt={dependencies:[notification,heartbeat],delivery:"check.Alerts.notify",values:async(c,s)=>({request:{value:{source:s.notification.id,destination:s.heartbeat.alert,message:"Job heartbeat recovered"}}})};
  const other_attempt={dependencies:[notification,heartbeat],delivery:"check.Alerts.notify",values:async(c,s)=>({request:{value:{source:s.notification.id,destination:s.heartbeat.alert,message:"Job heartbeat recovered"}},status:"failed",error:{code:"provider",message:"Delivery rejected"}})};
  return {
    heartbeat,
    foreign_check,
    notification,
    attempt,
    other_attempt,
    examples: [
      {
        operation: "check.pause",
        dependencies: [heartbeat, imported.test_worker],
        inputs: async (c, s) => ({ check: s.heartbeat }),
        selectors: ["as", "check.location", "check.enabled", "check.state", "test_worker.active"],
        observations: [
          async (c, s) => s.check.enabled,
          async (c, s) => s.check.state,
          async (c, s) => s.check.due,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["check.operations", null, true, "new", true],
            expected: async (c, s) => [false, "paused", null],
          },
          {
            dependencies: [imported.test_site],
            values: async (c, s) => ["check.operations", s.test_site, true, "new", true],
            expected: async (c, s) => [false, "paused", null],
          },
          {
            dependencies: [imported.test_site],
            values: async (c, s) => ["check.operations", s.test_site, true, "new", false],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["check.operations", null, false, "paused", true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", null, true, "new", true],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "check.resume",
        dependencies: [heartbeat],
        inputs: async (c, s) => ({ check: s.heartbeat }),
        selectors: ["as", "check.enabled", "check.state"],
        observations: [
          async (c, s) => s.check.enabled,
          async (c, s) => s.check.state,
          async (c, s) => s.check.armed,
          async (c, s) => s.check.due,
          async (c, s) => s.check.revision,
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["check.operations", false, "paused"],
            expected: async (c, s) => [true, "new", c.now, addDuration(c.now, 300000n), 2n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["check.operations", true, "up"],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", false, "paused"],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "check.ping",
        dependencies: [heartbeat],
        inputs: async (c, s) => ({
          event: { value: { check: s.heartbeat.id, token: s.heartbeat.token } },
        }),
        selectors: [
          "event.value.check",
          "event.value.token",
          "heartbeat.state",
          "heartbeat.enabled",
        ],
        observations: [
          async (c, s) => s.heartbeat.state,
          async (c, s) => s.heartbeat.last_ping,
          async (c, s) => s.heartbeat.revision,
          async (c, s) => s.heartbeat.due,
          async (c, s) => count(records(c, "check.Notice", { parent: s.heartbeat })),
          async(c,s)=>{const notice=await first(records(c,"check.Notice",{parent:s.heartbeat}));return notice===null?null:(await delivery(c,{record:notice,field:"delivery"},["status"]))?.status ?? null;},
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => [s.heartbeat.id, s.heartbeat.token, "new", true],
            expected: async (c, s) => ["up", c.now, 2n, addDuration(c.now, 300000n), 0n, null],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.heartbeat.id, s.heartbeat.token, "down", true],
            expected: async (c, s) => ["up", c.now, 2n, addDuration(c.now, 300000n), 1n, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.heartbeat.id, s.heartbeat.token, "late", true],
            expected: async (c, s) => ["up", c.now, 2n, addDuration(c.now, 300000n), 1n, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => [s.heartbeat.id, s.heartbeat.token, "paused", false],
            expected: async (c, s) => ["paused", c.now, 1n, null, 0n, null],
          },
          {
            dependencies: [],
            values: async (c, s) => ["unknown", s.heartbeat.token, "new", true],
            error: "rule_failed",
          },
          {
            dependencies: [foreign_check],
            values: async (c, s) => [s.heartbeat.id, s.foreign_check.token, "new", true],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "check.ping",
        seed: [notification,attempt],
        dependencies: [notification,attempt],
        inputs: async (c, s) => ({
          event: { value: { check: s.heartbeat.id, token: s.heartbeat.token } },
        }),
        selectors: ["heartbeat.state", "heartbeat.revision", "notification.delivery"],
        observations: [
          async (c, s) => s.heartbeat.state,
          async (c, s) => s.heartbeat.revision,
          async (c, s) => (await delivery(c,{record:s.notification,field:"delivery"},["status"]))?.status ?? null,
          async (c, s) => count(records(c, "check.Notice", { parent: s.heartbeat })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["up", 2n, s.attempt],
            expected: async (c, s) => ["up", 3n, "pending", 1n],
          },
          {dependencies:[],values:async(c,s)=>["up",2n,null],expected:async(c,s)=>["up",3n,null,1n]},
        ],
      },
      {
        operation: "check.deadline",
        dependencies: [heartbeat],
        inputs: async (c, s) => ({ event: { check: s.heartbeat, revision: 1n } }),
        selectors: [
          "heartbeat.state",
          "heartbeat.armed",
          "heartbeat.grace",
          "heartbeat.enabled",
          "event.revision",
          "heartbeat.due",
        ],
        observations: [
          async (c, s) => s.heartbeat.state,
          async (c, s) => s.heartbeat.due,
          async (c, s) => count(records(c, "check.Notice", { parent: s.heartbeat })),
          async(c,s)=>{const notice=await first(records(c,"check.Notice",{parent:s.heartbeat}));return notice===null?null:(await delivery(c,{record:notice,field:"delivery"},["status"]))?.status ?? null;},
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["new", subtractDuration(c.now, 300000n), 0n, true, 1n, c.now],
            expected: async (c, s) => ["down", null, 1n, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "up",
              subtractDuration(c.now, 300000n),
              60000n,
              true,
              1n,
              c.now,
            ],
            expected: async (c, s) => ["late", addDuration(c.now, 60000n), 0n, null],
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "late",
              subtractDuration(c.now, 360000n),
              60000n,
              true,
              1n,
              c.now,
            ],
            expected: async (c, s) => ["down", null, 1n, "pending"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["down", subtractDuration(c.now, 300000n), 0n, true, 1n, null],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["up", c.now, 0n, true, 1n, addDuration(c.now, 300000n)],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["up", subtractDuration(c.now, 300000n), 0n, true, 0n, c.now],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => [
              "paused",
              subtractDuration(c.now, 300000n),
              0n,
              false,
              1n,
              null,
            ],
            error: "rule_failed",
          },
        ],
      },
      {
        operation: "check.delivered",
        seed: [notification,attempt],
        dependencies: [notification,attempt],
        inputs: async (c, s) => ({event:{delivery_id:s.attempt.id,status:"failed",result:null,error:{code:"provider",message:"Delivery rejected"}}}),
        selectors: ["event.delivery_id", "event.status", "event.result", "event.error", "notification.delivery", "notification.detail", "heartbeat.state", "attempt.status", "attempt.result", "attempt.error"],
        observations: [
          async(c,s)=>(await delivery(c,{record:s.notification,field:"delivery"},["status"]))?.status ?? null,
          async(c,s)=>s.notification.detail,
          async(c,s)=>s.heartbeat.state,
        ],
        rows: [
          {dependencies:[],values:async(c,s)=>[s.attempt.id,"failed",null,{code:"provider",message:"Delivery rejected"},s.attempt,null,"new","failed",null,{code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["failed","Delivery rejected","new"]},
          {dependencies:[],values:async(c,s)=>[s.attempt.id,"unknown",null,{code:"provider",message:"Delivery rejected"},s.attempt,null,"new","unknown",null,{code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["unknown","Delivery rejected","new"]},
          {dependencies:[],values:async(c,s)=>[s.attempt.id,"succeeded",{reference:"accepted-alert"},null,s.attempt,"Delivery rejected","down","succeeded",{reference:"accepted-alert"},null],expected:async(c,s)=>["succeeded",null,"down"]},
          {dependencies:[],values:async(c,s)=>[s.attempt.id,"unknown",null,null,s.attempt,"Delivery rejected","late","unknown",null,null],expected:async(c,s)=>["unknown",null,"late"]},
          {dependencies:[],values:async(c,s)=>[s.attempt.id,"skipped",null,null,s.attempt,null,"new","skipped",null,null],expected:async(c,s)=>["skipped",null,"new"]},
          {dependencies:[],values:async(c,s)=>[s.attempt.id,"failed",null,{code:"provider",message:"Delivery rejected"},s.attempt,"Delivery rejected","new","failed",null,{code:"provider",message:"Delivery rejected"}],expected:async(c,s)=>["failed","Delivery rejected","new"]},
          {dependencies:[other_attempt],values:async(c,s)=>[s.other_attempt.id,"failed",null,{code:"provider",message:"Delivery rejected"},s.attempt,null,"new","failed",null,{code:"provider",message:"Delivery rejected"}],error:"rule_failed"},
        ],
      },
    ],
  };
}
