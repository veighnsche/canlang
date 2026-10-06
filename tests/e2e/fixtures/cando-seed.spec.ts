/**
 * CanDo pilot seed-plan unit spec (page-less, infra-free): the default
 * plan validates, seeding invokes operations in dependency order with
 * threaded parent ids, and malformed plans / id-less records fail loud.
 * Live execution against real dispatch rides the pilot go-ahead.
 */
import { expect, test } from "@playwright/test";
import {
  buildDefaultCanDoSeedPlan,
  seedCanDoPilot,
  validateCanDoSeedPlan,
  type CanDoSeedInvoker,
} from "./cando-seed.js";

test("default plan validates with T37-covering actors and inputs", () => {
  const plan = buildDefaultCanDoSeedPlan();
  expect(() => validateCanDoSeedPlan(plan)).not.toThrow();
  expect(plan.users.map((u) => u.name)).toEqual(["alice", "bruno", "cara"]);
  expect(plan.tasks.filter((t) => t.done === true)).toHaveLength(1);
});

test("seeding invokes operations in order with threaded parents", async () => {
  const calls: Array<{ operation: string; inputs: Record<string, unknown>; caller: string }> = [];
  let next = 1;
  const invoker: CanDoSeedInvoker = async (operation, inputs, caller) => {
    calls.push({ operation, inputs, caller });
    return { id: `id-${next++}` };
  };
  const created = await seedCanDoPilot(invoker);
  expect(calls.map((c) => c.operation)).toEqual([
    "Task.create",
    "Task.create",
    "Task.create",
    "Comment.create",
    "Template.create",
    "TemplateTask.create",
    "complete",
  ]);
  expect(calls.map((c) => c.caller)).toEqual([
    "alice",
    "alice",
    "bruno",
    "bruno",
    "cara",
    "cara",
    "alice",
  ]);
  // Parents thread created ids: comment -> first task, checklist row -> template.
  expect(calls[3]?.inputs["parent"]).toBe("id-1");
  expect(calls[5]?.inputs["parent"]).toBe("id-5");
  expect(calls[6]?.inputs).toEqual({ task: "id-2" });
  expect(created.get("t_todo")).toEqual({ id: "id-1" });
  expect(created.get("tt1")).toEqual({ id: "id-6" });
});

test("malformed plans and id-less records fail loud", async () => {
  const plan = buildDefaultCanDoSeedPlan();
  expect(() =>
    validateCanDoSeedPlan({ ...plan, users: plan.users.slice(0, 2) }),
  ).toThrow(/task_manager actor/);
  expect(() =>
    validateCanDoSeedPlan({
      ...plan,
      comments: [{ key: "c9", task: "ghost", author: "alice", body: "x" }],
    }),
  ).toThrow(/unknown task/);
  const noId: CanDoSeedInvoker = async () => ({});
  await expect(seedCanDoPilot(noId)).rejects.toThrow(/without a string id/);
});
