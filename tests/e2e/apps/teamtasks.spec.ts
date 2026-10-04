/**
 * TeamTasks journeys: login, CSRF, authz, and D1 persistence over the real
 * bridge + browser + fixture worker + D1.
 *
 * Every D1 assertion is presence-shaped (own rows only, never exact table
 * counts): the worker — and its D1 — is per Playwright *worker* process,
 * shared across spec files (see `../fixtures/e2e-test.ts`). Titles created
 * here are unique to this file so absence assertions are also safe.
 */
import { expect } from "@playwright/test";
import { test } from "../fixtures/e2e-test.js";
import { seedFixtureTask, seedTeamUsers } from "../fixtures/seed.js";
import type { WorkerAssembly } from "../fixtures/artifact-loader.js";

const BOB = { email: "bob@example.com", password: "correct-horse-43" };
const CAROL = { email: "carol@example.com", password: "correct-horse-44" };
const JOURNEY_TITLE = "Journey persists this task";
const CAROL_TITLE = "Carol shares this task";
const CSRF_PROBE_TITLE = "CSRF probe must not persist";
const ANON_PROBE_TITLE = "Anonymous probe must not persist";

function d1Binding(assembly: WorkerAssembly): string {
  const first = assembly.d1Databases[0];
  if (first === undefined) throw new Error("teamtasks spec: assembly has no D1 database");
  return first.binding;
}

test.describe("teamtasks journeys", () => {
  let sessionToken = "";
  let carolToken = "";

  test.beforeAll(async ({ assembly, bridge, dev }) => {
    expect(assembly.label).toBe("fixture/handbuilt/teamtasks");
    await seedFixtureTask(dev, d1Binding(assembly));
    const seed = await seedTeamUsers(bridge.url, [BOB, CAROL]);
    expect(seed.label).toBe(assembly.label);
    expect(seed.users).toHaveLength(2);
    const [bob, carol] = seed.users;
    if (bob === undefined || carol === undefined) {
      throw new Error("teamtasks spec: seed returned no users");
    }
    sessionToken = bob.session_token;
    carolToken = carol.session_token;
  });

  test("rejects a wrong password at login", async ({ page, bridge }) => {
    await page.goto(`${bridge.url}/`);
    await page.locator("#e2e-login-username").fill(BOB.email);
    await page.locator("#e2e-login-password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("Invalid email or password.");
    await expect(page.locator("#e2e-login-username")).toBeVisible();
  });

  test("signs in through the form and sees tasks", async ({ page, bridge }) => {
    await page.goto(`${bridge.url}/`);
    await page.locator("#e2e-login-username").fill(BOB.email);
    await page.locator("#e2e-login-password").fill(BOB.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    // 303 + Set-Cookie through the bridge, followed by the real browser.
    await expect(page.getByText("Team tasks").first()).toBeVisible();
    // `.first()`: sibling spec files sharing this worker seed their own
    // witness row into the same D1, so several may render.
    await expect(page.getByText("Ship prototype").first()).toBeVisible();
  });

  test("seeded witness task exists in D1", async ({ assembly, dev }) => {
    const db = await dev.getD1Database(d1Binding(assembly));
    const { results } = await db
      .prepare("SELECT title, done FROM todo WHERE title = ?")
      .bind("Ship prototype")
      .all();
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.["done"]).toBe(0);
  });

  test("persists a created task in D1", async ({ page, bridge, assembly, dev }) => {
    await page.context().addCookies([
      { name: "can_session", value: sessionToken, url: bridge.url },
    ]);
    await page.goto(`${bridge.url}/`);
    await page.locator("#e2e-task-title").fill(JOURNEY_TITLE);
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText(JOURNEY_TITLE)).toBeVisible();

    const db = await dev.getD1Database(d1Binding(assembly));
    const { results } = await db
      .prepare("SELECT title, done, version FROM todo WHERE title = ?")
      .bind(JOURNEY_TITLE)
      .all();
    expect(results).toHaveLength(1);
    expect(results[0]?.["done"]).toBe(0);
    expect(results[0]?.["version"]).toBe(1);
  });

  test("rejects task creation without a CSRF token", async ({ bridge, assembly, dev }) => {
    const response = await fetch(`${bridge.url}/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `can_session=${sessionToken}`,
      },
      body: new URLSearchParams({ title: CSRF_PROBE_TITLE }).toString(),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("bad CSRF token");

    const db = await dev.getD1Database(d1Binding(assembly));
    const { results } = await db
      .prepare("SELECT title FROM todo WHERE title = ?")
      .bind(CSRF_PROBE_TITLE)
      .all();
    expect(results).toHaveLength(0);
  });

  test("collaborators see each other's tasks", async ({ browser, bridge }) => {
    const carolContext = await browser.newContext();
    try {
      await carolContext.addCookies([
        { name: "can_session", value: carolToken, url: bridge.url },
      ]);
      const carolPage = await carolContext.newPage();
      await carolPage.goto(`${bridge.url}/`);
      await carolPage.locator("#e2e-task-title").fill(CAROL_TITLE);
      await carolPage.getByRole("button", { name: "Add" }).click();
      await expect(carolPage.getByText(CAROL_TITLE)).toBeVisible();
    } finally {
      await carolContext.close();
    }

    const bobContext = await browser.newContext();
    try {
      await bobContext.addCookies([
        { name: "can_session", value: sessionToken, url: bridge.url },
      ]);
      const bobPage = await bobContext.newPage();
      await bobPage.goto(`${bridge.url}/`);
      await expect(bobPage.getByText(CAROL_TITLE)).toBeVisible();
    } finally {
      await bobContext.close();
    }
  });

  test("unknown session shows the expired-session login", async ({ page, bridge }) => {
    await page.context().addCookies([
      { name: "can_session", value: "not-a-real-session-token", url: bridge.url },
    ]);
    await page.goto(`${bridge.url}/`);
    await expect(page.getByRole("alert")).toContainText("Session expired or revoked.");
    await expect(page.locator("#e2e-login-username")).toBeVisible();
  });

  test("rejects anonymous task creation", async ({ bridge, assembly, dev }) => {
    const response = await fetch(`${bridge.url}/tasks`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: ANON_PROBE_TITLE }).toString(),
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("sign in first");

    const db = await dev.getD1Database(d1Binding(assembly));
    const { results } = await db
      .prepare("SELECT title FROM todo WHERE title = ?")
      .bind(ANON_PROBE_TITLE)
      .all();
    expect(results).toHaveLength(0);
  });
});
