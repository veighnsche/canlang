/**
 * Scaffold smoke: proves the harness path end to end under real Playwright —
 * bridge -> fixture worker -> real L6 auth -> real D1 -> real ui HTML.
 * Asserts the `fixture/handbuilt/teamtasks` label so this run can never be
 * mistaken for a compiled-artifact run. Per-app journeys arrive in Phase 3.
 */
import { expect } from "@playwright/test";
import { test } from "../fixtures/e2e-test.js";
import { seedFixtureTask, seedTeamUsers } from "../fixtures/seed.js";

const ALICE = { email: "alice@example.com", password: "correct-horse-42" };

test.describe("scaffold smoke", () => {
  let sessionToken = "";

  test.beforeAll(async ({ assembly, bridge, dev }) => {
    expect(assembly.label).toBe("fixture/handbuilt/teamtasks");
    await seedFixtureTask(dev, "DB");
    const seed = await seedTeamUsers(bridge.url, [ALICE]);
    expect(seed.users).toHaveLength(1);
    const user = seed.users[0];
    if (user === undefined) throw new Error("scaffold smoke: seed returned no users");
    sessionToken = user.session_token;
  });

  test("anonymous visitor sees the login screen", async ({ page, bridge }) => {
    await page.goto(`${bridge.url}/`);
    await expect(page).toHaveTitle(/TeamTasks/);
    await expect(page.locator("#e2e-login-username")).toBeVisible();
    await expect(page.locator("#e2e-login-password")).toBeVisible();
  });

  test("member sees the seeded witness task", async ({ page, bridge }) => {
    await page.context().addCookies([
      { name: "can_session", value: sessionToken, url: bridge.url },
    ]);
    await page.goto(`${bridge.url}/`);
    await expect(page.getByText("Team tasks").first()).toBeVisible();
    await expect(page.getByText("Ship prototype")).toBeVisible();
    await expect(page.getByText("Add team work")).toBeVisible();
  });

  test("member creates a task through the form", async ({ page, bridge }) => {
    await page.context().addCookies([
      { name: "can_session", value: sessionToken, url: bridge.url },
    ]);
    await page.goto(`${bridge.url}/`);
    await page.locator("#e2e-task-title").fill("Smoke task");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("Smoke task")).toBeVisible();
    await expect(page.getByText("Ship prototype")).toBeVisible();
  });
});
