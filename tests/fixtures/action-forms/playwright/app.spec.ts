import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDraftSession } from "../../../e2e/drafts/dev-session.js";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.CAN_ACCEPTANCE_WORKSPACE ?? resolve(appDir, "../../.."));
const source = process.env.CAN_ACCEPTANCE_SOURCE ?? resolve(appDir, "ActionForms.can");
if (!isAbsolute(source)) throw new Error("CAN_ACCEPTANCE_SOURCE must be absolute");
const operationForm = (page: Page, operation: string, scope: Page | Locator = page): Locator =>
  scope.locator("form").filter({ has: page.locator(`input[name="operation"][value="ActionForms.${operation}"]`) });
const card = (page: Page, heading: string): Locator =>
  page.locator("[data-can-card]").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
const titleInput = (form: Locator, update = false): Locator =>
  form.locator(`input[name="inputs${update ? "[changes]" : ""}[title]"]`);
const dialogFor = (form: Locator): Locator => form.locator("xpath=ancestor::dialog[1]");

async function expectSubmit(form: Locator, caption: string): Promise<void> {
  await expect(form.locator('[data-can-form-actions] button[type="submit"]')).toHaveCount(1);
  await expect(form.locator("[data-can-form-actions]").getByRole("button", { name: caption, exact: true })).toBeVisible();
  await expect(form.locator("[data-can-action-menu]")).toHaveCount(0);
}

test("inspect canonical form submits and native dialog cancellation", async ({ browser }, info) => {
  const session = await openDraftSession({ root, source, app: "ActionForms" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  const page = await context.newPage();
  const errors: string[] = [];
  const operationResponses: { operation: string; status: number }[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (operationResponses.length >= 16 || response.request().method() !== "POST") return;
    const path = new URL(response.url()).pathname;
    const operation = /^\/api\/operations\/(ActionForms\.[A-Za-z0-9_.]+)$/.exec(path)?.[1];
    if (operation !== undefined) operationResponses.push({ operation, status: response.status() });
  });
  const screenshots = resolve(process.env.CAN_ACCEPTANCE_OUTPUT ?? resolve(appDir, "playwright/results"), "screenshots");
  await mkdir(screenshots, { recursive: true });
  async function capture(name: string): Promise<void> {
    await session.assertCurrent();
    await expect(page.locator("main")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
    const path = resolve(screenshots, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: "disabled" });
    await info.attach(name, { path, contentType: "image/png" });
  }
  try {
    const origin = await session.authenticate(context);
    await page.goto(origin);
    const initialCreate = operationForm(page, "Sample.create", card(page, "Inline create form"));
    await expectSubmit(initialCreate, "Save inline sample");
    await titleInput(initialCreate).fill("Inspection sample");
    await initialCreate.locator('[name="inputs[note]"]').fill("Neutral inspection note");
    await initialCreate.getByRole("button", { name: "Save inline sample", exact: true }).click();
    await expect(page.getByRole("cell", { name: /Inspection sample/ })).toBeVisible();
    for (const viewport of [
      { name: "desktop", width: 1440, height: 1000 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(origin);
      const inlineCreate = operationForm(page, "Sample.create", card(page, "Inline create form"));
      await expectSubmit(inlineCreate, "Save inline sample");
      await capture(`${viewport.name}-inline-create-default`);
      await inlineCreate.locator('[name="inputs[note]"]').fill("Retained validation note");
      await inlineCreate.getByRole("button", { name: "Save inline sample", exact: true }).click();
      await expect(inlineCreate.locator("[data-can-form-feedback]")).toBeVisible();
      await expect(titleInput(inlineCreate)).toHaveValue("");
      await expect(inlineCreate.locator('[name="inputs[note]"]')).toHaveValue("Retained validation note");
      await capture(`${viewport.name}-inline-create-validation`);
      const dialogCard = card(page, "Canonical operation dialog");
      const opener = dialogCard.getByRole("button", { name: "Open create form", exact: true });
      await opener.click();
      const dialogCreate = operationForm(page, "Sample.create", dialogCard);
      await expect(dialogCreate).toBeVisible();
      await titleInput(dialogCreate).fill("Unsubmitted sample");
      await capture(`${viewport.name}-create-dialog-cancel`);
      await dialogFor(dialogCreate).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialogCreate).not.toBeVisible();
      await expect(opener).toBeFocused();
      await expect(page.getByRole("cell", { name: /Unsubmitted sample/ })).toHaveCount(0);
      await page.goto(`${origin}/edit`);
      const inlineUpdate = operationForm(page, "Sample.update", card(page, "Inline update form"));
      await expectSubmit(inlineUpdate, "Save inline update");
      await expect(titleInput(inlineUpdate, true)).toHaveValue("Inspection sample");
      await capture(`${viewport.name}-inline-update-default`);
      const editCard = card(page, "Canonical edit control");
      const editOpener = editCard.locator("[data-can-panel-open]");
      await editOpener.click();
      const edit = operationForm(page, "Sample.update", editCard);
      await expectSubmit(edit, "Save edit");
      await titleInput(edit, true).fill("Unsubmitted edit");
      await capture(`${viewport.name}-canonical-edit-drawer`);
      await editCard.locator("aside .can-panel-heading [data-can-panel-close]").click();
      await expect(edit).not.toBeVisible();
      await expect(titleInput(inlineUpdate, true)).toHaveValue("Inspection sample");
      const inlineNote = `Saved inline note ${viewport.name}`;
      await inlineUpdate.locator('[name="inputs[changes][note]"]').fill(inlineNote);
      const [inlineResponse] = await Promise.all([
        page.waitForResponse(response => response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/operations/ActionForms.Sample.update", { timeout: 30_000 }),
        inlineUpdate.getByRole("button", { name: "Save inline update", exact: true }).click(),
      ]);
      expect(inlineResponse.ok()).toBe(true);
      await inlineResponse.finished();
      await page.goto(`${origin}/edit`);
      const persistedInline = operationForm(page, "Sample.update", card(page, "Inline update form"));
      await expect(titleInput(persistedInline, true)).toHaveValue("Inspection sample");
      await expect(persistedInline.locator('[name="inputs[changes][note]"]')).toHaveValue(inlineNote);
      await capture(`${viewport.name}-inline-update-saved`);
      const persistedEditCard = card(page, "Canonical edit control");
      await persistedEditCard.locator("[data-can-panel-open]").click();
      const persistedEdit = operationForm(page, "Sample.update", persistedEditCard);
      await expectSubmit(persistedEdit, "Save edit");
      await titleInput(persistedEdit, true).fill("Inspection sample");
      const editNote = `Saved edit note ${viewport.name}`;
      await persistedEdit.locator('[name="inputs[changes][note]"]').fill(editNote);
      const [editResponse] = await Promise.all([
        page.waitForResponse(response => response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/operations/ActionForms.Sample.update", { timeout: 30_000 }),
        persistedEdit.getByRole("button", { name: "Save edit", exact: true }).click(),
      ]);
      expect(editResponse.ok()).toBe(true);
      await editResponse.finished();
      await page.goto(`${origin}/edit`);
      const persistedFinal = operationForm(page, "Sample.update", card(page, "Inline update form"));
      await expect(titleInput(persistedFinal, true)).toHaveValue("Inspection sample");
      await expect(persistedFinal.locator('[name="inputs[changes][note]"]')).toHaveValue(editNote);
      await capture(`${viewport.name}-canonical-edit-saved`);
    }
    expect(errors).toEqual([]);
    await session.assertCurrent();
  } catch (error) {
    const failure = resolve(screenshots, "failure.png");
    await page.screenshot({ path: failure, fullPage: true, animations: "disabled" })
      .then(() => info.attach("failure", { path: failure, contentType: "image/png" })).catch(() => {});
    const feedback = await page.locator("[data-can-form-feedback]:visible").evaluateAll(elements => elements.slice(0, 8).map(element => ({
      code: (element.getAttribute("data-can-form-feedback-code") ?? "").slice(0, 80),
      text: (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
      submitState: element.closest("form")?.getAttribute("data-can-submit-state") ?? null,
    }))).catch(() => []);
    await info.attach("operation-diagnostic", { body: Buffer.from(JSON.stringify({ operationResponses, feedback }, null, 2)),
      contentType: "application/json" });
    throw error;
  } finally {
    try { await context.close(); } finally { await session.close(); }
  }
});
