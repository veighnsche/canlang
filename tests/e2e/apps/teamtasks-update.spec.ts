/**
 * TeamTasks update journeys: browser edit, done-toggle, and delete over the
 * real bridge + browser + fixture worker + D1.
 *
 * The `.can` list declares the `edit` and `delete` row affordances plus the
 * `done` bool (`examples/TeamTasks.can:31-34`); each test drives those
 * controls in the browser and proves the durable effect in D1. Every D1
 * assertion is presence-shaped (own rows only, never exact table counts):
 * the worker — and its D1 — is per Playwright *worker* process, shared
 * across spec files (see `../fixtures/e2e-test.ts`). Titles created here
 * are unique to this file so absence assertions are also safe.
 */
import { expect, type Page } from "@playwright/test";
import { test } from "../fixtures/e2e-test.js";
import { seedFixtureTask, seedTeamUsers } from "../fixtures/seed.js";
import type { WorkerAssembly } from "../fixtures/artifact-loader.js";

const BOB = { email: "bob.update@example.com", password: "correct-horse-50" };
const EDIT_TITLE = "Update journey edits this task";
const EDIT_TITLE_V2 = "Update journey edited this task";
const TOGGLE_TITLE = "Update journey toggles this task";
const DELETE_TITLE = "Update journey deletes this task";

function d1Binding(assembly: WorkerAssembly): string {
  const first = assembly.d1Databases[0];
  if (first === undefined) throw new Error("teamtasks-update spec: assembly has no D1 database");
  return first.binding;
}

async function createTask(page: Page, title: string): Promise<void> {
  await page.locator("#e2e-task-title").fill(title);
  await page.getByRole("button", { name: "Add" }).click();
  await expect(page.getByText(title)).toBeVisible();
}

test.describe("teamtasks update journeys", () => {
  let sessionToken = "";

  test.beforeAll(async ({ assembly, bridge, dev }) => {
    expect(assembly.label).toBe("fixture/handbuilt/teamtasks");
    await seedFixtureTask(dev, d1Binding(assembly));
    const seed = await seedTeamUsers(bridge.url, [BOB]);
    expect(seed.label).toBe(assembly.label);
    expect(seed.users).toHaveLength(1);
    const [bob] = seed.users;
    if (bob === undefined) {
      throw new Error("teamtasks-update spec: seed returned no users");
    }
    sessionToken = bob.session_token;
  });

  test("edits a task title in the browser", async ({ page, bridge, assembly, dev }) => {
    await page.context().addCookies([
      { name: "can_session", value: sessionToken, url: bridge.url },
    ]);
    await page.goto(`${bridge.url}/`);
    await createTask(page, EDIT_TITLE);

    const item = page.locator("li", { hasText: EDIT_TITLE });
    await item.getByRole("button", { name: /edit/i }).click();
    await item.getByRole("textbox").fill(EDIT_TITLE_V2);
    await item.getByRole("button", { name: /save/i }).click();
    await expect(page.getByText(EDIT_TITLE_V2)).toBeVisible();

    const db = await dev.getD1Database(d1Binding(assembly));
    const { results } = await db
      .prepare("SELECT title, version FROM todo WHERE title = ?")
      .bind(EDIT_TITLE_V2)
      .all();
    expect(results).toHaveLength(1);
  });

  test("toggles a task done in the browser", async ({ page, bridge, assembly, dev }) => {
    await page.context().addCookies([
      { name: "can_session", value: sessionToken, url: bridge.url },
    ]);
    await page.goto(`${bridge.url}/`);
    await createTask(page, TOGGLE_TITLE);

    const item = page.locator("li", { hasText: TOGGLE_TITLE });
    await expect(item.getByText("Open")).toBeVisible();
    await item.getByRole("button", { name: /done|finish|complete/i }).click();
    await expect(item.getByText("Done")).toBeVisible();

    const db = await dev.getD1Database(d1Binding(assembly));
    const { results } = await db
      .prepare("SELECT title, done FROM todo WHERE title = ?")
      .bind(TOGGLE_TITLE)
      .all();
    expect(results).toHaveLength(1);
    expect(results[0]?.["done"]).toBe(1);
  });

  test("deletes a task in the browser", async ({ page, bridge, assembly, dev }) => {
    await page.context().addCookies([
      { name: "can_session", value: sessionToken, url: bridge.url },
    ]);
    await page.goto(`${bridge.url}/`);
    await createTask(page, DELETE_TITLE);

    const item = page.locator("li", { hasText: DELETE_TITLE });
    await item.getByRole("button", { name: /delete|remove/i }).click();
    await expect(page.getByText(DELETE_TITLE)).toHaveCount(0);

    const db = await dev.getD1Database(d1Binding(assembly));
    const { results } = await db
      .prepare("SELECT title FROM todo WHERE title = ?")
      .bind(DELETE_TITLE)
      .all();
    expect(results).toHaveLength(0);
  });
});
