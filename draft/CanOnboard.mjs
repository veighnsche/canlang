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
  first,
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
  alert,
  badge,
  breadcrumbs,
  button,
  calendar,
  card,
  edit,
  file_input,
  form,
  history,
  input,
  link,
  list,
  message,
  modal,
  pagination,
  progress,
  radio,
  renderPage,
  select,
  slot,
  stat,
  tabs,
  text,
  textarea,
  timeline,
} from "@canlang/ui"; // desired/unimplemented additions: alert/badge/breadcrumbs/button/calendar/file_input/input/link/modal/pagination/progress/radio/select/slot/stat/textarea/timeline
import { can_work, Employee, hr, staff } from "./employee.mjs";
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
        assignee: { type: "user", default: (c, { parent }) => parent.parent.user, label: message("Assignee", { nl: "Toegewezen persoon" }) },
        category: { type: "onboard.TemplateStep.category" },
        document: {
          type: "file",
          nullable: true,
          label: message("Document attachment", { nl: "Documentbijlage" }),
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
  pure: {
    "onboard.can_complete": {
      handler: "can_complete",
      inputs: { step: { type: Step } },
      result: "bool",
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

async function can_complete(c, step) {
  return step.parent.parent.active &&
    (hasRole(c, hr) || (hasRole(c, "authenticated") && same(step.assignee, c.actor) && await staff(c, c.actor))) &&
    !step.done && step.blocked_reason === null;
}

export function canApp() {
  const crudWhen = {
    Step: async (c, row) =>
      row.parent.parent.active && (await active_member(c, row.assignee, c.team)),
  };
  return {
    crudWhen,
    can_complete,
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
          category: source.category,
        });
    },
    async complete(c, { step }) {
      check(hasRole(c, hr) || hasRole(c, "authenticated"), "forbidden");
      check(await can_complete(c, step));
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
          (await can_complete(c, item)) &&
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
      check(await can_complete(c, record));
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
      breadcrumbs({ context: c }),
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
            empty: message("No assigned steps", { nl: "Geen toegewezen stappen" }),
            renderRow: (step, view) => [
              badge({ context: view, value: step.category }),
              text({ context: view, values: [step.title, step.due, step.done] }),
              ...(step.blocked_reason !== null
                ? [
                    alert({
                      context: view,
                      children: [text({ context: view, values: [step.blocked_reason] })],
                    }),
                  ]
                : []),
              ...(step.document !== null
                ? [
                    card({
                      context: view,
                      title: message("Attachment", { nl: "Bijlage" }),
                      children: [
                        link({
                          context: view,
                          target: step.document,
                          caption: message("Open attachment", { nl: "Bijlage openen" }),
                        }),
                      ],
                    }),
                  ]
                : []),
              text({ context: view, values: [step.completed_by, step.completed_at] }),
              actions({ context: view, operations: [complete], boundArgs: { step } }),
            ],
            children: [pagination({ context: c })],
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
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Employee onboarding", { nl: "Medewerkers inwerken" }),
        children: [
          form({
            context: c,
            operation: "employee.Employee.create",
            children: [
              input({ context: c, field: "name" }),
              select({ context: c, field: "home" }),
              calendar({ context: c, field: "start" }),
              input({ context: c, field: "role" }),
            ],
          }),
        ],
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
            empty: message("No employees found", { nl: "Geen medewerkers gevonden" }),
            renderRow: (employee, view) => [
              edit({ context: view, operation: "employee.Employee.update", record: employee }),
              button({ context: view, opens: "start_checklist" }),
              modal({
                context: view,
                caption: message("Start onboarding checklist", { nl: "Inwerkchecklist starten" }),
                id: "start_checklist",
                children: [
                  slot({
                    context: view,
                    name: "content",
                    children: [
                      form({
                        context: view,
                        operation: "onboard.start",
                        arguments: { employee },
                        display: "inline",
                        children: [select({ context: view, field: "template" })],
                      }),
                    ],
                  }),
                ],
              }),
              button({ context: view, opens: "end_employment" }),
              modal({
                context: view,
                caption: message("End active employment", { nl: "Actief dienstverband beëindigen" }),
                id: "end_employment",
                children: [
                  slot({
                    context: view,
                    name: "content",
                    children: [
                      form({
                        context: view,
                        operation: "employee.deactivate",
                        arguments: { employee },
                        display: "inline",
                        children: [calendar({ context: view, field: "ended" })],
                      }),
                    ],
                  }),
                ],
              }),
              list({
                context: view,
                model: "onboard.Checklist",
                parent: employee,
                empty: message("No checklists yet", { nl: "Nog geen checklists" }),
                renderRow: (checklist, cv) => [
                  text({
                    context: cv,
                    values: [checklist.template, checklist.template_version, checklist.started],
                  }),
                  stat({ context: cv, values: [checklist.completed_steps, checklist.total_steps] }),
                  progress({ context: cv, value: checklist.progress, max: 100 }),
                  form({
                    context: cv,
                    operation: "onboard.Step.create",
                    arguments: { parent: checklist },
                    children: [
                      input({ context: cv, field: "title" }),
                      calendar({ context: cv, field: "due" }),
                      radio({ context: cv, field: "category" }),
                      file_input({ context: cv, field: "document" }),
                      textarea({ context: cv, field: "blocked_reason" }),
                    ],
                  }),
                  timeline({
                    context: cv,
                    model: "onboard.Step",
                    parent: checklist,
                    where: (s) => s.done,
                    renderItem: (s, sv) => [
                      text({ context: sv, values: [s.title, s.completed_by, s.completed_at] }),
                    ],
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
                    empty: message("No steps yet", { nl: "Nog geen stappen" }),
                    renderRow: (step, sv) => [
                      badge({ context: sv, value: step.category }),
                      text({ context: sv, values: [step.title, step.due, step.assignee, step.done] }),
                      ...(step.blocked_reason !== null
                        ? [
                            alert({
                              context: sv,
                              children: [text({ context: sv, values: [step.blocked_reason] })],
                            }),
                          ]
                        : []),
                      ...(step.document !== null
                        ? [
                            card({
                              context: sv,
                              title: message("Attachment", { nl: "Bijlage" }),
                              children: [
                                link({
                                  context: sv,
                                  target: step.document,
                                  caption: message("Open attachment", { nl: "Bijlage openen" }),
                                }),
                              ],
                            }),
                          ]
                        : []),
                      text({ context: sv, values: [step.completed_by, step.completed_at] }),
                      edit({ context: sv, operation: "onboard.Step.update", record: step }),
                      actions({ context: sv, operations: [complete], boundArgs: { step } }),
                      button({ context: sv, opens: "reopen_step" }),
                      modal({
                        context: sv,
                        caption: message("Reopen step", { nl: "Stap heropenen" }),
                        id: "reopen_step",
                        children: [
                          slot({
                            context: sv,
                            name: "content",
                            children: [
                              form({
                                context: sv,
                                operation: "onboard.reopen",
                                arguments: { step },
                                display: "inline",
                                children: [textarea({ context: sv, field: "reason" })],
                              }),
                            ],
                          }),
                        ],
                      }),
                      actions({ context: sv, operations: ["onboard.Step.delete"], boundArgs: { record: step } }),
                      history({ context: sv, record: step }),
                    ],
                    children: [pagination({ context: cv })],
                  }),
                ],
                children: [pagination({ context: view })],
              }),
            ],
            children: [pagination({ context: c })],
          }),
        ],
      }),
      card({
        context: c,
        title: message("Reusable templates", { nl: "Herbruikbare templates" }),
        children: [
          form({
            context: c,
            operation: "onboard.Template.create",
            children: [
              input({ context: c, field: "name" }),
              input({ context: c, field: "role" }),
              select({ context: c, field: "location" }),
            ],
          }),
          list({
            context: c,
            model: "onboard.Template",
            display: "split",
            empty: message("No templates yet", { nl: "Nog geen templates" }),
            renderRow: (template, view) => [
              text({
                context: view,
                values: [template.name, template.role, template.location, template.revision, template.active],
              }),
              edit({ context: view, operation: "onboard.Template.update", record: template }),
              form({
                context: view,
                operation: "onboard.TemplateStep.create",
                arguments: { parent: template },
                children: [
                  input({ context: view, field: "title" }),
                  input({ context: view, field: "offset_days" }),
                  radio({ context: view, field: "category" }),
                ],
              }),
              list({
                context: view,
                model: "onboard.TemplateStep",
                parent: template,
                empty: message("No template steps yet", { nl: "Nog geen templatestappen" }),
                renderRow: (row, v) => [
                  badge({ context: v, value: row.category }),
                  text({ context: v, values: [row.title, row.offset_days] }),
                  edit({ context: v, operation: "onboard.TemplateStep.update", record: row }),
                  actions({
                    context: v,
                    operations: ["onboard.TemplateStep.delete"],
                    boundArgs: { record: row },
                  }),
                ],
                children: [pagination({ context: view })],
              }),
            ],
            children: [pagination({ context: c })],
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
  const hr_user = { dependencies: [], user: async (c, s) => ({ roles: [hr] }) };
  const assigned_user = { dependencies: [], user: async (c, s) => ({}) };
  const assigned_worker = {
    model: Employee, dependencies: [assigned_user, test_site],
    value: async (c, s) => ({ user: s.assigned_user, home: s.test_site, locations: [s.test_site], start: date("2026-10-01"), role: "operator" }),
  };
  const opening_step = {
    model: "onboard.TemplateStep", dependencies: [test_template],
    value: async (c, s) => ({ parent: s.test_template, title: "Induction", offset_days: 2n, category: "induction" }),
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
    test_template, hr_user, assigned_user, assigned_worker, opening_step,
    examples: [
      {operation:"onboard.Step.create",dependencies:[test_checklist],
        inputs:async(c,s)=>({parent:s.test_checklist,title:"Manual induction",due:date("2026-10-03"),category:"induction"}),
        selectors:["as"],observations:[async(c,s)=>await count(records(c,Step,{parent:s.test_checklist})),async(c,s)=>(await first(records(c,Step,{parent:s.test_checklist})))?.assignee ?? null],
        rows:[{dependencies:[],values:async()=>[hr],expected:async(c,s)=>[1n,s.self]}]},
      {operation:"onboard.Step.create",dependencies:[test_checklist,assigned_worker],
        inputs:async(c,s)=>({parent:s.test_checklist,title:"Assigned equipment",due:date("2026-10-03"),category:"equipment",assignee:s.assigned_user}),
        selectors:["as"],observations:[async(c,s)=>await count(records(c,Step,{parent:s.test_checklist})),async(c,s)=>(await first(records(c,Step,{parent:s.test_checklist})))?.assignee ?? null],
        rows:[{dependencies:[],values:async()=>[hr],expected:async(c,s)=>[1n,s.assigned_user]}]},
      {operation:"onboard.start",dependencies:[test_worker,test_template,opening_step,assigned_worker,hr_user],sequence:[
        {operation:"onboard.start",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({employee:s.test_worker,template:s.test_template})},
        {let:"copied",value:async(c,s,b)=>await first(records(c,"onboard.Checklist",{parent:s.test_worker}))},
        {observations:async(c,s,b)=>[b.copied!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {let:"initial",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.initial!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.initial.title,b.initial.due,b.initial.assignee,await count(records(c,Step,{parent:b.copied})),await count(records(c,Step,{parent:b.copied,where:row=>row.done}))],expected:async(c,s,b)=>["Induction",date("2026-10-03"),s.self,1n,0n],types:["text","date","user","int","int"]},
        {operation:"onboard.TemplateStep.update",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({record:s.opening_step,changes:{title:"Revised induction"}})},
        {let:"independent",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.independent!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.independent.title],expected:async(c,s,b)=>["Induction"],types:["text"]},
        {operation:"onboard.Step.update",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({record:b.independent,changes:{assignee:s.assigned_user,blocked_reason:"Equipment pending"}})},
        {let:"blocked",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.blocked!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {operation:"onboard.complete",by:async(c,s,b)=>s.assigned_user,inputs:async(c,s,b)=>({step:b.blocked}),error:"rule_failed"},
        {observations:async(c,s,b)=>[b.blocked.done,b.blocked.blocked_reason],expected:async(c,s,b)=>[false,"Equipment pending"],types:["bool","text?"]},
        {operation:"onboard.Step.update",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({record:b.blocked,changes:{blocked_reason:null}})},
        {let:"ready",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.ready!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {operation:"onboard.complete",by:async(c,s,b)=>s.assigned_user,inputs:async(c,s,b)=>({step:b.ready})},
        {let:"completed",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.completed!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.completed.done,b.completed.completed_by,b.completed.completed_at!==null,await count(records(c,Step,{parent:b.copied,where:row=>row.done})),await count(records(c,Step,{parent:b.copied}))],expected:async(c,s,b)=>[true,s.assigned_user,true,1n,1n],types:["bool","user?","bool","int","int"]},
        {operation:"onboard.reopen",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({step:b.completed,reason:"Equipment correction"})},
        {let:"reopened",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.reopened!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.reopened.done,b.reopened.completed_by,b.reopened.completed_at,b.reopened.blocked_reason,await count(records(c,Step,{parent:b.copied,where:row=>row.done}))],expected:async(c,s,b)=>[false,null,null,"Equipment correction",0n],types:["bool","user?","datetime?","text?","int"]},
        {operation:"onboard.Step.delete",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({record:b.reopened})},
        {observations:async(c,s,b)=>[await count(records(c,Step,{parent:b.copied})),await count(records(c,Step,{parent:b.copied})),await count(records(c,Step,{parent:b.copied,where:row=>row.done}))],expected:async(c,s,b)=>[0n,0n,0n],types:["int","int","int"]},
        {operation:"onboard.Step.create",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({parent:b.copied,title:"Equipment",due:date("2026-10-03"),category:"equipment"})},
        {let:"manual",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.manual!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.manual.assignee,await count(records(c,Step,{parent:b.copied}))],expected:async(c,s,b)=>[s.self,1n],types:["user","int"]},
        {operation:"onboard.Step.update",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({record:b.manual,changes:{assignee:s.assigned_user}})},
        {let:"reassigned",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.reassigned!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {operation:"employee.deactivate",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({employee:s.assigned_worker,ended:date("2026-10-03")})},
        {operation:"onboard.complete",by:async(c,s,b)=>s.assigned_user,inputs:async(c,s,b)=>({step:b.reassigned}),error:"rule_failed"},
        {operation:"onboard.work",by:async(c,s,b)=>s.assigned_user,inputs:async(c,s,b)=>({locations:[]}),bind:"remaining"},
        {observations:async(c,s,b)=>[await count(b.remaining.items),s.test_worker.active,s.assigned_worker.active],expected:async(c,s,b)=>[0n,true,false],types:["int","bool","bool"]},
        {operation:"onboard.work_detail",by:async(c,s,b)=>s.assigned_user,inputs:async(c,s,b)=>({record:b.reassigned}),error:"rule_failed"},
        {operation:"onboard.complete",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({step:b.reassigned})},
        {let:"recovered",value:async(c,s,b)=>await first(records(c,Step,{parent:b.copied}))},
        {observations:async(c,s,b)=>[b.recovered!==null],expected:async(c,s,b)=>[true],types:["bool"]},
        {observations:async(c,s,b)=>[b.recovered.done,b.recovered.completed_by],expected:async(c,s,b)=>[true,s.hr_user],types:["bool","user?"]},
        {operation:"employee.deactivate",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({employee:s.test_worker,ended:date("2026-10-03")})},
        {operation:"onboard.reopen",by:async(c,s,b)=>s.hr_user,inputs:async(c,s,b)=>({step:b.recovered,reason:"After employment end"}),error:"rule_failed"}
      ]},
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
        dependencies: [test_step, test_worker],
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
