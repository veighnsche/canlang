import {
  action,
  active_member,
  add_days,
  require as check,
  compareDate,
  count,
  create,
  date,
  datetime,
  deleteRecord,
  divideDecimal,
  hasRole,
  int64,
  local_date,
  local_instant,
  max,
  records,
  same,
  set,
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
  tabs,
  text,
} from "@canlang/ui";
import { can_work, deactivate, Employee, hr } from "./employee.mjs";
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

export const Template = "onboard.Template";

export const start = "onboard.start";

export const Step = "onboard.Step";

export const complete = "onboard.complete";

const onboardingCaption = message("Onboarding", { nl: "Inwerken" });

const readinessPageDescriptor = {
  owner: "onboard",
  path: "/people/my-readiness",
  title: message("My readiness", { nl: "Mijn inwerkstappen" }),
  description: message("Follow your assigned readiness work and private attachments.", {
    nl: "Volg je toegewezen inwerkstappen en private bijlagen.",
  }),
  admit: async (c, routeBindings = {}) => {
    check(c.team != null, "forbidden");
    check(hasRole(c, "authenticated"), "forbidden");
    return {};
  },
  render: readinessPage,
};

const onboardingPageDescriptor = {
  owner: "onboard",
  path: "/people/onboarding",
  title: onboardingCaption,
  description: message(
    "Prepare work identities and role/location checklists under HR document grants.",
    {
      nl: "Bereid werkidentiteiten en rol- en locatiechecklists voor binnen HR-documentrechten.",
    },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, hr), "forbidden");
    return {};
  },
  render: onboardingPage,
};

export const appDefinition = {
  id: "CanOnboard",
  uses: ["employee", "onboard"],
  description: message(
    "Help workspace HR and location managers prepare new employees for reception, sales, community, and facilities duties.",
    {
      nl: "Help HR en locatiemanagers nieuwe medewerkers voor receptie-, verkoop-, community- en facilitaire taken voor te bereiden.",
    },
  ),
  packages: {
    onboard: {
      label: onboardingCaption,
      description: message(
        "Own employee work identity and private, versioned onboarding checklists.",
        {
          nl: "Beheer de werkidentiteit van medewerkers en private, geversioneerde inwerkchecklists.",
        },
      ),
    },
  },
  models: {
    "onboard.Template": {
      exported: true,
      label: message("Checklist template", { nl: "Checklisttemplate" }),
      fields: {
        name: { type: "text" },
        role: { type: "text", label: message("Role", { nl: "Rol" }) },
        location: { type: Location },
        active: {
          type: "bool",
          default: true,
          label: message("Available template", { nl: "Beschikbare template" }),
        },
        revision: { type: "int", default: 1n },
      },
      readGrants: [{ rule: "Template.read.1" }],
    },
    "onboard.TemplateStep": {
      parent: "onboard.Template",
      label: message("Template step", { nl: "Templatestap" }),
      fields: {
        title: { type: "text", trim: true, min: 1n },
        offset_days: {
          type: "int",
          default: 0n,
          label: message("Offset in days", { nl: "Verschuiving in dagen" }),
        },
        category: {
          type: "enum",
          cases: ["equipment", "induction", "account", "training"],
          default: "induction",
          label: {
            text: message("Category", { nl: "Categorie" }),
            values: {
              equipment: message("Equipment", { nl: "Uitrusting" }),
              induction: message("Induction", { nl: "Introductie" }),
              account: message("Account", { nl: "Account" }),
              training: message("Training", { nl: "Opleiding" }),
            },
          },
        },
      },
      readGrants: [{ rule: "TemplateStep.read.1" }],
    },
    "onboard.Checklist": {
      parent: Employee,
      label: message("Onboarding checklist", { nl: "Inwerkchecklist" }),
      fields: {
        template: { type: "onboard.Template" },
        template_version: {
          type: "int",
          label: message("Template version", { nl: "Templateversie" }),
        },
        started: { type: "date", label: message("Started on", { nl: "Gestart op" }) },
        generation: {
          type: "text",
          unique: true,
          label: message("Generation reference", { nl: "Generatiereferentie" }),
        },
      },
      derived: {
        completed_steps: {
          type: "int",
          handler: "Checklist.completed_steps",
          label: message("Completed steps", { nl: "Afgeronde stappen" }),
        },
        total_steps: {
          type: "int",
          handler: "Checklist.total_steps",
          label: message("Active steps", { nl: "Actieve stappen" }),
        },
        progress: {
          type: "decimal",
          handler: "Checklist.progress",
          label: message("Progress", { nl: "Voortgang" }),
        },
      },
      readGrants: [{ rule: "Checklist.read.1" }],
      locks: ["Checklist.lock.1"],
    },
    [Step]: {
      parent: "onboard.Checklist",
      exported: true,
      label: message("Onboarding step", { nl: "Inwerkstap" }),
      fields: {
        title: { type: "text", trim: true, min: 1n },
        due: { type: "date" },
        assignee: { type: "user", label: message("Assignee", { nl: "Toegewezen persoon" }) },
        category: { type: "onboard.TemplateStep.category" },
        document: {
          type: "file",
          nullable: true,
          label: message("Generate document", { nl: "Document genereren" }),
        },
        blocked_reason: {
          type: "text",
          nullable: true,
          label: message("Blocking reason", { nl: "Blokkeerreden" }),
        },
        done: { type: "bool", default: false },
        completed_by: {
          type: "user",
          nullable: true,
          label: message("Completed by", { nl: "Afgerond door" }),
        },
        completed_at: {
          type: "datetime",
          nullable: true,
          label: message("Completed at", { nl: "Afgerond op" }),
        },
      },
      readGrants: [{ rule: "Step.read.1" }],
      invariants: ["Step.require.1"],
    },
  },
  contracts: {
    "onboard.WorkItem": {
      exported: true,
      label: message("Authorized work item", { nl: "Toegestaan werkitem" }),
      fields: {
        reference: { type: "text" },
        revision: { type: "int" },
        location: { type: "text", nullable: true },
        title: { type: "text" },
        detail: { type: "text", nullable: true },
        due: { type: "datetime", nullable: true },
        action: { type: "action", targets: ["onboard.complete"] },
      },
    },
    "onboard.WorkBatch": {
      exported: true,
      label: message("Authorized work batch", { nl: "Toegestane werkverzameling" }),
      fields: { items: { type: "onboard.WorkItem", array: true, requiredArray: true, max: 500n } },
    },
  },
  preferences: {
    onboard: {
      fields: {
        home: {
          type: Location,
          nullable: true,
          default: null,
          label: message("Home location", { nl: "Standplaats" }),
        },
        view: {
          type: "enum",
          cases: ["all", "unfinished", "overdue"],
          default: "all",
          label: {
            text: message("Step view", { nl: "Stappenweergave" }),
            values: {
              all: message("All steps", { nl: "Alle stappen" }),
              unfinished: message("Unfinished steps", { nl: "Onafgeronde stappen" }),
              overdue: message("Overdue steps", { nl: "Achterstallige stappen" }),
            },
          },
        },
      },
    },
  },
  operations: {
    "onboard.work": {
      handler: "work",
      exported: true,
      read: true,
      scope: "authority",
      by: ["employee.hr", "authenticated"],
      result: "onboard.WorkBatch",
      inputs: { locations: { type: "text", array: true } },
      description: message(
        "Return only current eligible work under the canonical completion authority.",
        {
          nl: "Geef alleen actueel uitvoerbaar werk terug binnen de canonieke afrondingsbevoegdheid.",
        },
      ),
    },
    "onboard.work_detail": {
      handler: "work_detail",
      exported: true,
      read: true,
      scope: "authority",
      by: ["employee.hr", "authenticated"],
      result: "onboard.WorkItem",
      inputs: { record: { type: "onboard.Step" } },
      description: message(
        "Revalidate the selected item before presenting its protected canonical action.",
        {
          nl: "Controleer het gekozen item opnieuw voordat de beschermde canonieke actie wordt getoond.",
        },
      ),
    },
    "onboard.Template.create": {
      handler: "createTemplate",
      kind: "create",
      model: "onboard.Template",
      by: hr,
      read: false,
      inputs: { fields: ["name", "role", "location"] },
    },
    "onboard.Template.update": {
      handler: "updateTemplate",
      kind: "update",
      model: "onboard.Template",
      by: hr,
      read: false,
      inputs: {
        record: { type: "onboard.Template" },
        changes: { fields: ["name", "role", "location", "active"] },
      },
    },
    "onboard.Template.delete": {
      handler: "deleteTemplate",
      kind: "delete",
      model: "onboard.Template",
      by: hr,
      read: false,
      mode: "archive",
      inputs: { record: { type: "onboard.Template" } },
    },
    "onboard.TemplateStep.create": {
      handler: "createTemplateStep",
      kind: "create",
      model: "onboard.TemplateStep",
      by: hr,
      read: false,
      inputs: {
        parent: { type: "onboard.Template" },
        fields: ["title", "offset_days", "category"],
      },
    },
    "onboard.TemplateStep.update": {
      handler: "updateTemplateStep",
      kind: "update",
      model: "onboard.TemplateStep",
      by: hr,
      read: false,
      inputs: {
        record: { type: "onboard.TemplateStep" },
        changes: { fields: ["title", "offset_days", "category"] },
      },
    },
    "onboard.TemplateStep.delete": {
      handler: "deleteTemplateStep",
      kind: "delete",
      model: "onboard.TemplateStep",
      by: hr,
      read: false,
      mode: "remove",
      inputs: { record: { type: "onboard.TemplateStep" } },
    },
    "onboard.Step.create": {
      handler: "createStep",
      when: "Step",
      kind: "create",
      model: Step,
      by: hr,
      read: false,
      inputs: {
        parent: { type: "onboard.Checklist" },
        fields: ["title", "due", "assignee", "category", "document", "blocked_reason"],
      },
    },
    "onboard.Step.update": {
      handler: "updateStep",
      when: "Step",
      kind: "update",
      model: Step,
      by: hr,
      read: false,
      inputs: {
        record: { type: Step },
        changes: { fields: ["title", "due", "assignee", "category", "document", "blocked_reason"] },
      },
    },
    "onboard.Step.delete": {
      handler: "deleteStep",
      when: "Step",
      kind: "delete",
      model: Step,
      by: hr,
      read: false,
      mode: "archive",
      inputs: { record: { type: Step } },
    },
    "onboard.start": {
      handler: "start",
      exported: true,
      by: hr,
      read: false,
      inputs: { employee: { type: Employee }, template: { type: "onboard.Template" } },
      label: message("Start", { nl: "Starten" }),
      description: message(
        "Copy a current role/location template once without changing existing checklists.",
        {
          nl: "Kopieer een huidige rol- en locatietemplate één keer zonder bestaande checklists te wijzigen.",
        },
      ),
    },
    [complete]: {
      handler: "complete",
      exported: true,
      by: [hr, "authenticated"],
      read: false,
      inputs: { step: { type: Step } },
      description: message(
        "Record completion by the assigned employee or HR independently of document upload.",
        {
          nl: "Registreer afronding door de toegewezen medewerker of HR onafhankelijk van documentupload.",
        },
      ),
    },
    "onboard.reopen": {
      handler: "reopen",
      by: hr,
      read: false,
      inputs: { step: { type: Step }, reason: { type: "text" } },
      description: message("Reopen a completed step with an attributed reason.", {
        nl: "Heropen een afgeronde stap met een herleidbare reden.",
      }),
    },
  },
  handlers: {
    "onboard.template_changed": { handler: "template_changed", on: "onboard.Template.update" },
    "onboard.template_step_created": {
      handler: "template_step_created",
      on: "onboard.TemplateStep.create",
    },
    "onboard.template_step_changed": {
      handler: "template_step_changed",
      on: "onboard.TemplateStep.update",
    },
    "onboard.template_step_removed": {
      handler: "template_step_removed",
      on: "onboard.TemplateStep.delete",
    },
  },
  pages: [
    readinessPageDescriptor,
    onboardingPageDescriptor,
  ],
  disabled: [],
};

export function canApp() {
  const crudWhen = {
    Step: async (c, row) =>
      row.parent.parent.active && (await active_member(c, row.assignee, c.team)),
  };
  return {
    crudWhen,
    read: {
      "Template.read.1": async (c, row) =>
        hasRole(c, hr) || (hasRole(c, "members") && (await can_work(c, c.actor, row.location))),
      "TemplateStep.read.1": async (c, row) =>
        hasRole(c, hr) ||
        (hasRole(c, "members") && (await can_work(c, c.actor, row.parent.location))),
      "Checklist.read.1": (c, row) =>
        hasRole(c, hr) || (hasRole(c, "authenticated") && same(row.parent.user, c.actor)),
      "Step.read.1": (c, row) =>
        hasRole(c, hr) ||
        (hasRole(c, "authenticated") &&
          (same(row.assignee, c.actor) || same(row.parent.parent.user, c.actor))),
    },
    derives: {
      "Checklist.completed_steps": async (c, row) =>
        count(records(c, Step, { parent: row, where: (s) => s.done })),
      "Checklist.total_steps": async (c, row) => count(records(c, Step, { parent: row })),
      "Checklist.progress": async (c, row) => {
        const completed = await count(records(c, Step, { parent: row, where: (s) => s.done }));
        const numerator = int64(completed * 100n);
        const total = await count(records(c, Step, { parent: row }));
        return divideDecimal(numerator, await max([1n, total]));
      },
    },
    invariants: {
      "Step.require.1": (c, row) =>
        !row.done || (row.completed_at !== null && row.completed_by !== null),
    },
    locks: {
      "Checklist.lock.1": { fields: ["template", "template_version", "started", "generation"] },
    },
    async createTemplate(c, input) {
      check(hasRole(c, hr), "forbidden");
      await create(c, "onboard.Template", input);
    },
    async updateTemplate(c, { record, changes }) {
      check(hasRole(c, hr), "forbidden");
      await set(c, record, changes);
    },
    async deleteTemplate(c, { record }) {
      check(hasRole(c, hr), "forbidden");
      await deleteRecord(c, record, { mode: "archive" });
    },
    async createTemplateStep(c, input) {
      check(hasRole(c, hr), "forbidden");
      await create(c, "onboard.TemplateStep", input);
    },
    async updateTemplateStep(c, { record, changes }) {
      check(hasRole(c, hr), "forbidden");
      await set(c, record, changes);
    },
    async deleteTemplateStep(c, { record }) {
      check(hasRole(c, hr), "forbidden");
      await deleteRecord(c, record, { mode: "remove" });
    },
    async createStep(c, input) {
      check(hasRole(c, hr), "forbidden");
      await create(c, Step, input, { when: crudWhen.Step });
    },
    async updateStep(c, { record, changes }) {
      check(hasRole(c, hr), "forbidden");
      await set(c, record, changes, { when: crudWhen.Step });
    },
    async deleteStep(c, { record }) {
      check(hasRole(c, hr), "forbidden");
      check(await crudWhen.Step(c, record));
      await deleteRecord(c, record, { mode: "archive" });
    },
    async template_changed(c, { event }) {
      await set(c, event.after, { revision: int64(event.before.revision + 1n) });
    },
    async template_step_created(c, { event }) {
      await set(c, event.after.parent, { revision: int64(event.after.parent.revision + 1n) });
    },
    async template_step_changed(c, { event }) {
      await set(c, event.after.parent, { revision: int64(event.after.parent.revision + 1n) });
    },
    async template_step_removed(c, { event }) {
      await set(c, event.before.parent, { revision: int64(event.before.parent.revision + 1n) });
    },
    async start(c, { employee, template }) {
      check(hasRole(c, hr), "forbidden");
      check(
        employee.active &&
          (await active_member(c, employee.user, c.team)) &&
          template.active &&
          employee.role === template.role &&
          same(employee.home, template.location),
      );
      const checklist = await create(c, "onboard.Checklist", {
        parent: employee,
        template,
        template_version: template.revision,
        started: employee.start,
        generation: c.operation.id,
      });
      for await (const source of records(c, "onboard.TemplateStep", {
        parent: template,
        limit: 100n,
      }))
        await create(c, Step, {
          parent: checklist,
          title: source.title,
          due: add_days(employee.start, source.offset_days),
          assignee: employee.user,
          category: source.category,
        });
    },
    async complete(c, { step }) {
      check(hasRole(c, hr) || hasRole(c, "authenticated"), "forbidden");
      check(
        step.parent.parent.active &&
          (hasRole(c, hr) || same(step.assignee, c.actor)) &&
          !step.done &&
          step.blocked_reason === null,
      );
      await set(c, step, { done: true, completed_by: c.actor, completed_at: c.now });
    },
    async reopen(c, { step, reason }) {
      check(hasRole(c, hr), "forbidden");
      check(step.parent.parent.active && step.done && reason.trim() !== "");
      await set(c, step, {
        done: false,
        completed_by: null,
        completed_at: null,
        blocked_reason: reason,
      });
    },
    async work(c, { locations }) {
      check(hasRole(c, hr) || hasRole(c, "authenticated"), "forbidden");
      const items = [];
      for await (const item of records(c, "onboard.Step", {
        where: async (item) =>
          item.parent.parent.active &&
          (hasRole(c, hr) || same(item.assignee, c.actor)) &&
          !item.done &&
          item.blocked_reason === null &&
          ((await count(locations)) === 0n || locations.includes(item.parent.parent.home.id)),
      }))
        items.push({
          reference: item.id,
          revision: item.version,
          location: item.parent.parent.home.id,
          title: item.title,
          detail: null,
          due: local_instant(item.due, "00:00", c.team.timezone, { fold: "earlier" }),
          action: action(c, "onboard.complete", { step: item }),
        });
      return { items };
    },
    async work_detail(c, { record }) {
      check(hasRole(c, hr) || hasRole(c, "authenticated"), "forbidden");
      check(
        record.parent.parent.active &&
          (hasRole(c, hr) || same(record.assignee, c.actor)) &&
          !record.done &&
          record.blocked_reason === null,
      );
      return {
        reference: record.id,
        revision: record.version,
        location: record.parent.parent.home.id,
        title: record.title,
        detail: null,
        due: local_instant(record.due, "00:00", c.team.timezone, { fold: "earlier" }),
        action: action(c, "onboard.complete", { step: record }),
      };
    },
  };
}

export async function readinessPage(c, bindings) {
  return renderPage(
    c,
    readinessPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Assigned readiness steps", { nl: "Toegewezen inwerkstappen" }),
        children: [
          tabs({ context: c, preference: "onboard.view" }),
          list({
            context: c,
            model: Step,
            where: (step) =>
              same(step.assignee, c.actor) &&
              (c.preferences.onboard.view === "all" ||
                (c.preferences.onboard.view === "unfinished" && !step.done) ||
                (c.preferences.onboard.view === "overdue" &&
                  !step.done &&
                  compareDate(step.due, local_date(c.now, c.team.timezone)) < 0)),
            order: ["due"],
            renderRow: (step, view) => [
              text({
                context: view,
                values: [step.title, step.due, step.blocked_reason, step.document],
              }),
              actions({ context: view, operations: [complete], boundArgs: { step } }),
            ],
          }),
        ],
      }),
    ],
  );
}

export async function onboardingPage(c, bindings) {
  return renderPage(
    c,
    onboardingPageDescriptor,
    () => [
      card({
        context: c,
        title: message("Employee onboarding", { nl: "Medewerkers inwerken" }),
        children: [form({ context: c, operation: "employee.Employee.create" })],
      }),
      card({
        context: c,
        title: message("Dated checklist steps", { nl: "Gedateerde checkliststappen" }),
        children: [
          tabs({ context: c, preference: "onboard.view" }),
          list({
            context: c,
            model: Employee,
            order: ["start"],
            filter: ["home", "active", "role"],
            search: ["role"],
            defaults: { home: c.preferences.onboard.home },
            display: "split",
            renderRow: (employee, view) => [
              edit({ context: view, operation: "employee.Employee.update", record: employee }),
              form({ context: view, operation: "onboard.start", arguments: { employee } }),
              actions({ context: view, operations: [deactivate], boundArgs: { employee } }),
              list({
                context: view,
                model: "onboard.Checklist",
                parent: employee,
                renderRow: (checklist, cv) => [
                  metrics({
                    context: cv,
                    result: checklist,
                    fields: ["completed_steps", "total_steps", "progress"],
                  }),
                  form({
                    context: cv,
                    operation: "onboard.Step.create",
                    arguments: { parent: checklist },
                  }),
                  list({
                    context: cv,
                    model: Step,
                    parent: checklist,
                    where: (step) =>
                      c.preferences.onboard.view === "all" ||
                      (c.preferences.onboard.view === "unfinished" && !step.done) ||
                      (c.preferences.onboard.view === "overdue" &&
                        !step.done &&
                        compareDate(step.due, local_date(c.now, c.team.timezone)) < 0),
                    order: ["due"],
                    renderRow: (step, sv) => [
                      edit({ context: sv, operation: "onboard.Step.update", record: step }),
                      actions({
                        context: sv,
                        operations: [complete, "onboard.reopen"],
                        boundArgs: { step },
                      }),
                      history({ context: sv, record: step }),
                    ],
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Reusable templates", { nl: "Herbruikbare templates" }),
        children: [
          form({ context: c, operation: "onboard.Template.create" }),
          list({
            context: c,
            model: "onboard.Template",
            display: "split",
            renderRow: (template, view) => [
              text({ context: view, values: [template.revision, template.active] }),
              edit({ context: view, operation: "onboard.Template.update", record: template }),
              form({
                context: view,
                operation: "onboard.TemplateStep.create",
                arguments: { parent: template },
              }),
              list({
                context: view,
                model: "onboard.TemplateStep",
                parent: template,
                renderRow: (row, v) => [
                  edit({ context: v, operation: "onboard.TemplateStep.update", record: row }),
                  actions({
                    context: v,
                    operations: ["onboard.TemplateStep.delete"],
                    boundArgs: { record: row },
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

/* Hire uses the canonical exported start operation after explicit HR review.
 * No training/task connection is configured. No
 * background notice is added (requirements specify none in the first version).
 * Template edits advance revision; copies retain independent fields and history.
 * Inline scenarios remain authored checks, not an executed runtime test suite.
 */

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
  const test_template = {
    model: "onboard.Template",
    dependencies: [test_site],
    value: async (c, s) => ({ name: "Opening", role: "operator", location: s.test_site }),
  };
  const test_checklist = {
    model: "onboard.Checklist",
    dependencies: [test_template, test_worker],
    value: async (c, s) => ({
      parent: s.test_worker,
      template: s.test_template,
      template_version: 1n,
      started: date("2026-10-01"),
      generation: "test-onboarding",
    }),
  };
  const test_step = {
    model: "onboard.Step",
    dependencies: [test_checklist],
    value: async (c, s) => ({
      parent: s.test_checklist,
      title: "Induction",
      due: date("2026-10-03"),
      assignee: s.self,
      category: "induction",
    }),
  };
  return {
    test_checklist,
    test_step,
    test_template,
    examples: [
      {
        operation: "onboard.start",
        dependencies: [test_worker, test_template],
        inputs: async (c, s) => ({ employee: s.test_worker, template: s.test_template }),
        selectors: ["as", "employee.active", "template.active"],
        observations: [
          async (c, s) => await count(records(c, "onboard.Checklist", { parent: s.employee })),
        ],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", true, true],
            expected: async (c, s) => [1n],
          },
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", false, true],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", true, false],
            error: "rule_failed",
          },
          { dependencies: [], values: async (c, s) => ["members", true, true], error: "forbidden" },
        ],
      },
      {
        operation: "onboard.reopen",
        dependencies: [test_step],
        inputs: async (c, s) => ({ step: s.test_step, reason: "Equipment correction" }),
        selectors: ["as", "step.done", "step.completed_by", "step.completed_at"],
        observations: [async (c, s) => s.step.done, async (c, s) => s.step.blocked_reason],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", true, s.self, datetime("2026-10-03T12:00:00Z")],
            expected: async (c, s) => [false, "Equipment correction"],
          },
          {
            dependencies: [],
            values: async (c, s) => ["employee.hr", false, null, null],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", false, null, null],
            error: "forbidden",
          },
        ],
      },
      {
        operation: "onboard.complete",
        dependencies: [test_step],
        inputs: async (c, s) => ({ step: s.test_step }),
        selectors: ["as", "step.assignee", "step.blocked_reason"],
        observations: [async (c, s) => s.step.done],
        rows: [
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, null],
            expected: async (c, s) => [true],
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.other, null],
            error: "rule_failed",
          },
          {
            dependencies: [],
            values: async (c, s) => ["members", s.self, "Equipment missing"],
            error: "rule_failed",
          },
        ],
      },
    ],
  };
}
