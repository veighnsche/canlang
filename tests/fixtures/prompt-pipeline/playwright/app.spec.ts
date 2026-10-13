import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDraftSession } from "../../../e2e/drafts/dev-session.js";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(appDir, "../../..");
const operationForm = (page: Page, operation: string, scope: Page | Locator = page): Locator =>
  scope.locator("form").filter({ has: page.locator(`input[name="operation"][value="PromptStudio.${operation}"]`) });
const field = (form: Locator, name: string, update = false): Locator =>
  form.locator(`input[name="inputs${update ? "[changes]" : ""}[${name}]"]`);

const drawerFor = (form: Locator): Locator => form.locator(
  'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " drawer ")][1]',
);
async function openForm(form: Locator): Promise<void> {
  if (!await form.isVisible()) {
    await drawerFor(form).locator(":scope > .drawer-content label.drawer-button").click();
  }
  await expect(form).toBeVisible();
}
async function closeForm(form: Locator): Promise<void> {
  const drawer = drawerFor(form);
  const toggle = drawer.locator(":scope > input.drawer-toggle");
  if (await toggle.count() && await toggle.isChecked()) {
    await drawer.locator(":scope > .drawer-side > label.drawer-overlay").click({ position: { x: 350, y: 20 } });
    await expect(toggle).not.toBeChecked();
  }
}

async function submit(form: Locator): Promise<void> {
  const button = form.locator('button[type="submit"]');
  await expect(button).toHaveAccessibleName(/\S/);
  await button.click();
}

test("saved prompt output works through the real dev server", async ({ browser }, info) => {
  const session = await openDraftSession({ root, source: resolve(appDir, "PromptStudio.can"), app: "PromptStudio" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshots = resolve(appDir, "playwright/screenshots");
  await mkdir(snapshots, { recursive: true });
  async function capture(state: string): Promise<void> {
    await session.assertCurrent();
    await expect(page.locator("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    const path = resolve(snapshots, `${state}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await info.attach(state, { path, contentType: "image/png" });
  }
  try {
    const origin = await session.authenticate(context);
    await page.goto(origin);
    await expect(page.getByText("No items yet. Create your first item.")).toBeVisible();
    await expect(page.locator("[data-can-style]").first()).toBeVisible();
    await capture("01-empty-desktop");
    await openForm(operationForm(page, "Item.create"));
    await capture("02-create-form");

    async function createItem(title: string, handle: string): Promise<void> {
      const form = operationForm(page, "Item.create");
      await openForm(form);
      await field(form, "title").fill(title);
      await field(form, "handle").fill(handle);
      await submit(form);
    }
    await createItem("  First item  ", "Ａlice");
    const cards = page.locator("[data-can-view-presentation]");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("First item");
    await expect(cards.first()).toContainText("Ａlice");
    await expect(cards.first()).toContainText("Open");
    await expect(cards.first()).toHaveAttribute("data-enhanced", "true");
    await closeForm(operationForm(page, "Item.create"));
    await capture("03-created-desktop");

    await createItem("Duplicate", "Alice");
    await expect(page.locator('[data-can-form-feedback]:visible').first()).toBeVisible();
    await expect(cards).toHaveCount(1);
    await expect(field(operationForm(page, "Item.create"), "title")).toHaveValue("Duplicate");
    await expect(field(operationForm(page, "Item.create"), "handle")).toHaveValue("Alice");
    await capture("04-duplicate-error");

    await createItem("Second item", "Bob");
    await expect(cards).toHaveCount(2);
    await closeForm(operationForm(page, "Item.create"));
    await expect(page.locator('[data-enhanced="true"]')).toHaveCount(2);
    const identities = await cards.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-can-view")));
    expect(identities.every(identity => typeof identity === "string" && identity.length > 0)).toBe(true);
    expect(new Set(identities).size).toBe(2);
    const firstItem = cards.filter({ has: page.getByRole("heading", { name: "First item", exact: true }) });
    const edit = operationForm(page, "Item.update", firstItem);
    await openForm(edit);
    await field(edit, "title", true).fill("Edited item");
    await submit(edit);
    const editedItem = cards.filter({ has: page.getByRole("heading", { name: "Edited item", exact: true }) });
    await expect(editedItem).toHaveCount(1);
    await closeForm(operationForm(page, "Item.update", editedItem));
    await capture("05-edited-desktop");

    await page.setViewportSize({ width: 390, height: 844 });
    await capture("06-populated-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await submit(operationForm(page, "Item.delete", editedItem));
    await expect(cards).toHaveCount(1);
    // Canonical delete archives this model, retaining its unique-key claim.
    await createItem("Archived handle stays reserved", "Alice");
    await expect(page.locator('[data-can-form-feedback]:visible').first()).toBeVisible();
    await expect(cards).toHaveCount(1);
    await createItem("Fresh handle", "Charlie");
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: "Fresh handle" })).toContainText("Charlie");

    await page.goto(`${origin}/notes`);
    const note = operationForm(page, "Note.create");
    await openForm(note);
    await field(note, "title").fill("  Generated defaults  ");
    await submit(note);
    const noteTitle = page.getByRole("cell", { name: /Generated defaults/ });
    await expect(noteTitle).toBeVisible();
    expect((await noteTitle.textContent())?.replace(/[\u2066-\u2069]/g, "")).toBe("Generated defaults");
    await expect(page.getByRole("columnheader", { name: /done/i })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: /pinned/i })).toBeVisible();
    const noteRow = page.getByRole("row").filter({ has: noteTitle });
    await expect(noteRow.getByRole("cell").filter({ hasText: "false" })).toHaveCount(2);
    await closeForm(note);
    await capture("07-trait-defaults");

    await page.goto(`${origin}/aliases`);
    const alias = operationForm(page, "Alias.create");
    await openForm(alias);
    await field(alias, "handle").fill("Ａlice");
    await submit(alias);
    await expect(page.getByText(/Ａlice/)).toBeVisible();
    await openForm(alias);
    await field(alias, "handle").fill("Alice");
    await submit(alias);
    await expect(page.locator('[data-can-form-feedback]:visible').first()).toBeVisible();
    await expect(operationForm(page, "Alias.delete")).toHaveCount(1);
    for (const handle of ["Ä", "ä"]) {
      await openForm(alias);
      await field(alias, "handle").fill(handle);
      await submit(alias);
      await expect(page.getByText(new RegExp(handle))).toBeVisible();
    }
    await expect(operationForm(page, "Alias.delete")).toHaveCount(3);
    await closeForm(alias);
    await capture("08-reused-keyword");
    expect(errors).toEqual([]);
    await session.assertCurrent();
  } catch (error) {
    const path = info.outputPath("failure.png");
    await page.screenshot({ path, fullPage: true, animations: "disabled" }).catch(() => {});
    throw error;
  } finally {
    await context.close();
    await session.close();
  }
});
