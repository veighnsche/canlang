import { require as check, compareInstant, hasRole, local_date, same } from "@canlang/stdlib";
import {
  alert,
  badge,
  breadcrumbs,
  button,
  card,
  chat_bubble,
  content,
  divider,
  edit,
  fab,
  fieldset,
  form,
  history,
  input,
  list,
  message,
  pagination,
  radio,
  remove,
  renderPage,
  select,
  table,
  tabs,
  text,
  textarea,
} from "@canlang/ui";

/* Then-only composition companion for draft/CanDo.can (lane L replan). Desired
 * witness: each use site marked desired-unimplemented is a proposed,
 * unimplemented producer contract (lane 05 owns renderers, lane 01 owns
 * checking/emission). Business lowering (registry, guards, fixtures, inline
 * examples) stays with the future full witness; this file mirrors the Then
 * page composition only — badges, pagination, and placed inputs (no modals).
 * It must pass node --check (syntax only) and never claims to run.
 */

const tasksPageDescriptor = {
  owner: "todo",
  path: "/tasks",
  title: message("Tasks", { nl: "Taken" }),
  description: message(
    "Add tasks quickly and follow location, due date and ownership.",
    { nl: "Voeg taken snel toe en volg locatie, deadline en eigenaarschap." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: tasksPage,
};

const myWorkPageDescriptor = {
  owner: "todo",
  path: "/tasks/my-work",
  title: message("My work", { nl: "Mijn werk" }),
  description: message(
    "Keep unavailable source work visible without granting source authority.",
    { nl: "Houd niet-beschikbaar bronwerk zichtbaar zonder bronbevoegdheid te verlenen." },
  ),
  /* desired-unimplemented: poll/refresh stay generated page metadata. */
  poll: "5s",
  refresh: "todo.refresh",
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "members"), "forbidden");
    return {};
  },
  render: myWorkPage,
};

const checklistsPageDescriptor = {
  owner: "todo",
  path: "/tasks/checklists",
  title: message("Checklist templates", { nl: "Checklistsjablonen" }),
  description: message(
    "Author scoped checklists and generate independent dated tasks.",
    { nl: "Beheer toegestane checklists en genereer zelfstandige gedateerde taken." },
  ),
  admit: async (c, routeBindings = {}) => {
    check(hasRole(c, "todo.task_manager"), "forbidden");
    return {};
  },
  render: checklistsPage,
};

export async function tasksPage(c, bindings) {
  const preferences = c.preferences.todo;
  return renderPage(
    c,
    tasksPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs consume the declared route ancestry. */
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Quick task entry", { nl: "Snel een taak toevoegen" }),
        children: [
          form({
            context: c,
            operation: "todo.Task.create",
            display: "inline",
            /* desired-unimplemented: placed controls move the generated fields. */
            children: [
              fieldset({
                context: c,
                caption: message("Task details", { nl: "Taakgegevens" }),
                children: [
                  input({ context: c, field: "title" }),
                  radio({ context: c, field: "priority" }),
                  select({ context: c, field: "location" }),
                  textarea({ context: c, field: "description" }),
                  input({ context: c, field: "due" }),
                ],
              }),
            ],
          }),
        ],
      }),
      tabs({ context: c, selector: "todo.view", value: preferences.view }),
      table({
        context: c,
        model: "todo.Task",
        where: (task) =>
          preferences.view === "all" ||
          (task.due !== null &&
            ((preferences.view === "today" &&
              local_date(task.due, c.team.timezone) ===
                local_date(c.now, c.team.timezone)) ||
              (preferences.view === "overdue" &&
                compareInstant(task.due, c.now) < 0 &&
                !task.done))),
        columns: ["title", "assignee", "due", "priority", "done"],
        order: { by: preferences.view, default: ["due"], cases: { all: ["-created"] } },
        filter: ["location", "assignee", "priority", "done"],
        defaults: { location: preferences.location, done: preferences.done },
        search: ["title"],
        display: "split",
        empty: message("No tasks match these filters.", { nl: "Geen taken voor deze filters." }),
        renderRow: (task, v) => [
          /* desired-unimplemented: pagination consumes this collection cursor. */
          pagination({ context: v }),
          /* desired-unimplemented: text presents the readable bool; badges stay enum-only. */
          text({ context: v, values: [task.done] }),
          /* desired-unimplemented: badge presents the readable typed value. */
          badge({ context: v, value: task.priority }),
          card({
            context: v,
            title: message("Current task", { nl: "Huidige taak" }),
            children: [
              text({
                context: v,
                values: [
                  task.title,
                  task.assignee,
                  task.due,
                  task.priority,
                  task.done,
                  task.completed_by,
                  task.completed_at,
                ],
              }),
              /* desired-unimplemented: content presents the readable long text. */
              content({ context: v, value: task.description }),
              edit({ context: v, operation: "todo.Task.update", record: task }),
              /* desired-unimplemented: fab presents the canonical quick actions. */
              fab({
                context: v,
                children: [
                  button({ context: v, action: "todo.complete", arguments: { task } }),
                  button({ context: v, action: "todo.reopen", arguments: { task } }),
                ],
              }),
            ],
          }),
          card({
            context: v,
            title: message("Attributed comments", { nl: "Toegeschreven reacties" }),
            children: [
              form({
                context: v,
                operation: "todo.Comment.create",
                arguments: { parent: task },
                /* desired-unimplemented: placed controls move the generated fields. */
                children: [textarea({ context: v, field: "body" })],
              }),
              list({
                context: v,
                model: "todo.Comment",
                parent: task,
                empty: message("No comments yet.", { nl: "Nog geen reacties." }),
                renderRow: (comment, cv) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: cv }),
                  /* desired-unimplemented: chat_bubble slots preserve the row chain. */
                  chat_bubble({
                    context: cv,
                    content: [
                      /* desired-unimplemented: content presents the readable long text. */
                      content({ context: cv, value: comment.body }),
                    ],
                    header: [text({ context: cv, values: [comment.author] })],
                  }),
                ],
              }),
            ],
          }),
          history({ context: v, record: task }),
        ],
      }),
    ],
  );
}

export async function myWorkPage(c, bindings) {
  return renderPage(
    c,
    myWorkPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs consume the declared route ancestry. */
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Refresh source work", { nl: "Werk uit bronsystemen vernieuwen" }),
        children: [form({ context: c, operation: "todo.refresh", display: "inline" })],
      }),
      /* desired-unimplemented: divider carries the authored section caption. */
      divider({ context: c, caption: message("Current projection", { nl: "Actuele projectie" }) }),
      list({
        context: c,
        model: "todo.WorkView",
        where: (view) => same(view.account, c.actor) && view.current,
        order: ["-requested"],
        empty: message("No work projection yet.", { nl: "Nog geen werkprojectie." }),
        renderRow: (view, v) => [
          /* desired-unimplemented: pagination consumes this collection cursor. */
          pagination({ context: v }),
          text({ context: v, values: [view.requested] }),
          /* desired-unimplemented: badge presents the readable typed value. */
          badge({ context: v, value: view.state }),
          view.state === "partial" || view.state === "unavailable"
            ? /* desired-unimplemented: alert suite carries the coverage notice. */
              alert({
                context: v,
                children: [
                  text({
                    context: v,
                    values: [
                      message(
                        "Some sources are stale or unavailable; affected actions stay withheld.",
                        {
                          nl: "Sommige bronnen zijn verouderd of niet beschikbaar; getroffen acties blijven achtergehouden.",
                        },
                      ),
                    ],
                  }),
                ],
              })
            : null,
          card({
            context: v,
            title: message("Source freshness", { nl: "Actualiteit bron" }),
            children: [
              /* desired-unimplemented: items+contract renders the typed structural array. */
              table({
                context: v,
                items: view.sources,
                contract: "todo.WorkSourceState",
                columns: ["source", "state", "detail"],
                empty: message("No sources reported.", { nl: "Geen bronnen gemeld." }),
                renderRow: (source, sv) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: sv }),
                  /* desired-unimplemented: badge presents the readable typed value. */
                  badge({ context: sv, value: source.state }),
                ],
              }),
            ],
          }),
          card({
            context: v,
            title: message("Authorized work and actions", { nl: "Toegestaan werk en acties" }),
            children: [
              /* desired-unimplemented: items+contract renders the typed structural array. */
              table({
                context: v,
                items: view.items,
                contract: "todo.WorkItem",
                columns: ["title", "source", "location", "due", "state"],
                filter: ["source", "location", "due", "state"],
                empty: message("No authorized work items.", { nl: "Geen toegestaan werk." }),
                renderRow: (item, iv) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: iv }),
                  /* desired-unimplemented: badge presents the readable typed value. */
                  badge({ context: iv, value: item.state }),
                  /* desired-unimplemented: content presents the readable long text. */
                  content({ context: iv, value: item.detail }),
                  /* desired-unimplemented: typed-action form convention awaits the 05 contract. */
                  form({ context: iv, action: item.action }),
                ],
              }),
            ],
          }),
        ],
      }),
      text({
        context: c,
        values: [
          message(
            "Submit refresh once to enable automatic source refresh while this page remains open.",
            {
              nl: "Vernieuw één keer om automatisch bronwerk te vernieuwen zolang deze pagina geopend blijft.",
            },
          ),
        ],
      }),
    ],
  );
}

export async function checklistsPage(c, bindings) {
  return renderPage(
    c,
    checklistsPageDescriptor,
    () => [
      /* desired-unimplemented: breadcrumbs consume the declared route ancestry. */
      breadcrumbs({ context: c }),
      card({
        context: c,
        title: message("Template intake", { nl: "Sjabloon aanmaken" }),
        children: [
          form({
            context: c,
            operation: "todo.Template.create",
            /* desired-unimplemented: placed controls move the generated fields. */
            children: [
              input({ context: c, field: "name" }),
              select({ context: c, field: "location" }),
            ],
          }),
        ],
      }),
      list({
        context: c,
        model: "todo.Template",
        columns: ["name", "location"],
        search: ["name"],
        display: "split",
        empty: message("No templates yet.", { nl: "Nog geen sjablonen." }),
        renderRow: (template, v) => [
          /* desired-unimplemented: pagination consumes this collection cursor. */
          pagination({ context: v }),
          card({
            context: v,
            title: message("Template and generation", { nl: "Sjabloon en generatie" }),
            children: [
              text({ context: v, values: [template.name, template.location] }),
              edit({ context: v, operation: "todo.Template.update", record: template }),
              remove({ context: v, operation: "todo.Template.delete", record: template }),
              form({ context: v, operation: "todo.generate", arguments: { template } }),
            ],
          }),
          card({
            context: v,
            title: message("Template items", { nl: "Sjabloonitems" }),
            children: [
              form({
                context: v,
                operation: "todo.TemplateTask.create",
                arguments: { parent: template },
              }),
              table({
                context: v,
                model: "todo.TemplateTask",
                parent: template,
                columns: ["title", "offset", "priority"],
                order: ["offset"],
                empty: message("No template items yet.", { nl: "Nog geen sjabloonitems." }),
                renderRow: (item, iv) => [
                  /* desired-unimplemented: pagination consumes this collection cursor. */
                  pagination({ context: iv }),
                  edit({ context: iv, operation: "todo.TemplateTask.update", record: item }),
                  remove({ context: iv, operation: "todo.TemplateTask.delete", record: item }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  );
}
