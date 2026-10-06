/**
 * CanDo (todo) pilot seed plan (T37 non-provider scope): declarative users,
 * tasks, comments, templates, and template-tasks plus an order-fixed
 * seeding function over an injected operation invoker. Pure and
 * infra-free: live execution (real dispatch, descriptor-joined input
 * names) rides the pilot go-ahead; this slice proves plan validity and
 * deterministic seeding order against fake invokers.
 *
 * Scope notes (accepted CanDo T37 scoping): Task/Comment/Template CRUD
 * plus `complete`/`reopen`/`generate` only — `refresh`, `work_result`,
 * and `report_error` are bound/provider work and stay out. Seeded rows
 * use null locations (bypass the `can_work` location rule);
 * `staff(actor)` satisfaction for seeded callers is a live-run input.
 * Operation identities (`Task.create`, …) and the `parent` input name
 * follow `.can` spellings and are confirmed against T15a descriptors
 * at live runs.
 */
export interface CanDoSeedUser {
  readonly name: string;
  readonly roles: readonly string[];
}

export interface CanDoSeedTask {
  readonly key: string;
  readonly title: string;
  readonly owner: string;
  readonly done?: boolean | undefined;
}

export interface CanDoSeedComment {
  readonly key: string;
  readonly task: string;
  readonly author: string;
  readonly body: string;
}

export interface CanDoSeedTemplate {
  readonly key: string;
  readonly name: string;
  readonly owner: string;
}

export interface CanDoSeedTemplateTask {
  readonly key: string;
  readonly template: string;
  readonly title: string;
}

export interface CanDoSeedPlan {
  readonly users: readonly CanDoSeedUser[];
  readonly tasks: readonly CanDoSeedTask[];
  readonly comments: readonly CanDoSeedComment[];
  readonly templates: readonly CanDoSeedTemplate[];
  readonly templateTasks: readonly CanDoSeedTemplateTask[];
}

/**
 * Minimal T37-covering plan: two member actors (cross-actor journeys),
 * one task_manager (denied Template reads for members), a done task
 * (reopen journey), a comment (parented create), and a template with
 * one checklist row (generate journey input).
 */
export function buildDefaultCanDoSeedPlan(): CanDoSeedPlan {
  return {
    users: [
      { name: "alice", roles: ["members"] },
      { name: "bruno", roles: ["members"] },
      { name: "cara", roles: ["task_manager"] },
    ],
    tasks: [
      { key: "t_todo", title: "Write pilot notes", owner: "alice" },
      { key: "t_done", title: "File pilot report", owner: "alice", done: true },
      { key: "t_bruno", title: "Review pilot notes", owner: "bruno" },
    ],
    comments: [{ key: "c1", task: "t_todo", author: "bruno", body: "Looks good" }],
    templates: [{ key: "tpl_checklist", name: "Release checklist", owner: "cara" }],
    templateTasks: [{ key: "tt1", template: "tpl_checklist", title: "Cut release notes" }],
  };
}

/** Validates references, actor coverage, and journey inputs (fails loud). */
export function validateCanDoSeedPlan(plan: CanDoSeedPlan): void {
  const users = new Set(plan.users.map((u) => u.name));
  const fail = (reason: string): never => {
    throw new Error(`cando seed plan: ${reason}`);
  };
  if (users.size !== plan.users.length) fail("duplicate user names");
  const members = plan.users.filter((u) => u.roles.includes("members"));
  if (members.length < 2) fail("needs two distinct members actors");
  if (!plan.users.some((u) => u.roles.includes("task_manager"))) {
    fail("needs a task_manager actor for denied Template reads");
  }
  const keys = (items: readonly { readonly key: string }[], what: string): Set<string> => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.key)) fail(`duplicate ${what} key ${JSON.stringify(item.key)}`);
      seen.add(item.key);
    }
    return seen;
  };
  const taskKeys = keys(plan.tasks, "task");
  const templateKeys = keys(plan.templates, "template");
  keys(plan.comments, "comment");
  keys(plan.templateTasks, "templateTask");
  for (const task of plan.tasks) {
    if (!users.has(task.owner)) fail(`task ${JSON.stringify(task.key)} names unknown owner`);
  }
  if (!plan.tasks.some((t) => t.done === true)) fail("needs a done task for the reopen journey");
  for (const comment of plan.comments) {
    if (!taskKeys.has(comment.task)) fail(`comment ${JSON.stringify(comment.key)} names unknown task`);
    if (!users.has(comment.author)) fail(`comment ${JSON.stringify(comment.key)} names unknown author`);
  }
  for (const template of plan.templates) {
    if (!users.has(template.owner)) fail(`template ${JSON.stringify(template.key)} names unknown owner`);
  }
  for (const row of plan.templateTasks) {
    if (!templateKeys.has(row.template)) {
      fail(`templateTask ${JSON.stringify(row.key)} names unknown template`);
    }
  }
}

/** Operation invoker (fake in unit specs; real dispatch at live runs). */
export type CanDoSeedInvoker = (
  operation: string,
  inputs: Record<string, unknown>,
  caller: string,
) => Promise<Record<string, unknown>>;

/**
 * Seeds one plan in dependency order (tasks, comments, templates,
 * checklist rows, then `complete` for done tasks) threading created ids
 * as parents. Returns created records by plan key. Records without a
 * string `id` fail loud (parenting would silently dangle).
 */
export async function seedCanDoPilot(
  invoker: CanDoSeedInvoker,
  plan: CanDoSeedPlan = buildDefaultCanDoSeedPlan(),
): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  validateCanDoSeedPlan(plan);
  const created = new Map<string, Record<string, unknown>>();
  const takeId = (key: string, record: Record<string, unknown>): string => {
    const id: unknown = record["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`cando seed: ${JSON.stringify(key)} created a record without a string id`);
    }
    return id;
  };
  for (const task of plan.tasks) {
    const record = await invoker("Task.create", { title: task.title }, task.owner);
    takeId(task.key, record);
    created.set(task.key, record);
  }
  for (const comment of plan.comments) {
    const parent = created.get(comment.task);
    if (parent === undefined) throw new Error(`cando seed: missing parent for ${comment.key}`);
    const record = await invoker(
      "Comment.create",
      { parent: parent["id"], body: comment.body },
      comment.author,
    );
    takeId(comment.key, record);
    created.set(comment.key, record);
  }
  for (const template of plan.templates) {
    const record = await invoker("Template.create", { name: template.name }, template.owner);
    takeId(template.key, record);
    created.set(template.key, record);
  }
  for (const row of plan.templateTasks) {
    const parent = created.get(row.template);
    if (parent === undefined) throw new Error(`cando seed: missing parent for ${row.key}`);
    const template = plan.templates.find((t) => t.key === row.template);
    if (template === undefined) throw new Error(`cando seed: missing template for ${row.key}`);
    const record = await invoker(
      "TemplateTask.create",
      { parent: parent["id"], title: row.title },
      template.owner,
    );
    takeId(row.key, record);
    created.set(row.key, record);
  }
  for (const task of plan.tasks) {
    if (task.done !== true) continue;
    const target = created.get(task.key);
    if (target === undefined) throw new Error(`cando seed: missing task for ${task.key}`);
    await invoker("complete", { task: target["id"] }, task.owner);
  }
  return created;
}
