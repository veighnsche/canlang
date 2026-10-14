import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDraftSession } from "../../../e2e/drafts/dev-session.js";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.CAN_ACCEPTANCE_WORKSPACE ?? resolve(appDir, "../../.."));
const source = process.env.CAN_ACCEPTANCE_SOURCE ?? resolve(appDir, "ActionGallery.can");
if (!isAbsolute(source)) throw new Error("CAN_ACCEPTANCE_SOURCE must be absolute");
const operationForm = (page: Page, operation: string, scope: Page | Locator = page): Locator =>
  scope.locator("form").filter({ has: page.locator(`input[name="operation"][value="ActionGallery.${operation}"]`) });
const card = (page: Page, heading: string): Locator =>
  page.locator("[data-can-card]").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
const dialogFor = (form: Locator): Locator => form.locator("xpath=ancestor::dialog[1]");

async function expectDialogActions(form: Locator): Promise<void> {
  const footer = form.locator("[data-can-dialog-actions]");
  const cancel = footer.getByRole("button", { name: "Cancel", exact: true });
  const commit = footer.locator('button[type="submit"]');
  await expect(footer).toHaveCount(1);
  await expect(cancel).toBeVisible();
  await expect(cancel).toHaveClass(/\bbtn-ghost\b/);
  await expect(commit).toHaveCount(1);
  await expect(commit).toBeVisible();
  const cancelBox = await cancel.boundingBox();
  const commitBox = await commit.boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(commitBox).not.toBeNull();
  // A shared footer must keep the actions on one line, in reading order,
  // with a small gap rather than unrelated corners of the dialog.
  expect(Math.abs(cancelBox!.y + cancelBox!.height / 2 - commitBox!.y - commitBox!.height / 2)).toBeLessThanOrEqual(2);
  expect(commitBox!.x - cancelBox!.x - cancelBox!.width).toBeGreaterThanOrEqual(-1);
  expect(commitBox!.x - cancelBox!.x - cancelBox!.width).toBeLessThanOrEqual(24);
  await expect(dialogFor(form).locator(".modal-box .card")).toHaveCount(0);
}

test("inspect every admitted shared action owner on desktop and mobile", async ({ browser }, info) => {
  const session = await openDraftSession({ root, source, app: "ActionGallery" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
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
  async function inspectOwner(owner: Locator, kind: string, viewport: string): Promise<void> {
    const edit = owner.locator("[data-can-primary-actions]").getByRole("button", { name: `Edit ${kind} sample`, exact: true });
    const trigger = owner.locator("[data-can-action-menu-trigger]");
    const popover = owner.locator("[data-can-action-menu-popover]");
    await expect(edit).toBeVisible();
    await expect(trigger).toHaveCount(1);
    await expect(trigger).toHaveAccessibleName("More actions");
    await expect(popover).not.toBeVisible();
    await capture(`${viewport}-${kind.replaceAll(" ", "-")}-default`);
    await edit.click();
    const update = operationForm(page, "Sample.update", owner);
    await expect(update).toBeVisible();
    await expectDialogActions(update);
    await expect(update.locator('input[name="inputs[changes][title]"]')).toHaveValue("Inspection sample");
    await capture(`${viewport}-${kind.replaceAll(" ", "-")}-edit`);
    await dialogFor(update).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(update).not.toBeVisible();
    await expect(edit).toBeFocused();
    await trigger.focus();
    await trigger.press("Enter");
    await expect(popover).toBeVisible();
    await capture(`${viewport}-${kind.replaceAll(" ", "-")}-secondary-open`);
    await popover.getByRole("button", { name: `Archive ${kind} sample`, exact: true }).click();
    const archive = operationForm(page, "Sample.delete", owner);
    await expect(archive).toBeVisible();
    await expectDialogActions(archive);
    await expect(popover).not.toBeVisible();
    await capture(`${viewport}-${kind.replaceAll(" ", "-")}-confirm`);
    await dialogFor(archive).getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(archive).not.toBeVisible();
    await expect(trigger).toBeFocused();
  }
  try {
    const origin = await session.authenticate(context);
    await page.goto(origin);
    await expect(page.getByText("No samples yet. Create a sample to inspect every owner.")).toBeVisible();
    await page.getByRole("button", { name: "Create sample", exact: true }).click();
    const create = operationForm(page, "Sample.create");
    await expect(create).toBeVisible();
    await expectDialogActions(create);
    await create.locator('input[name="inputs[title]"]').fill("Inspection sample");
    await create.locator('[name="inputs[note]"]').fill("Neutral shared-default inspection data.");
    await create.locator('button[type="submit"]').click();
    await expect(card(page, "Inspection sample")).toBeVisible();
    for (const viewport of [
      { name: "desktop", width: 1440, height: 1000 },
      { name: "mobile", width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(origin);
      await inspectOwner(card(page, "Inspection sample"), "card", viewport.name);
      await page.goto(`${origin}/page`);
      const pageOwner = page.locator("main > header .can-page-heading-row");
      const pageCreate = pageOwner.getByRole("button", { name: "Create page sample", exact: true });
      await expect(pageCreate).toBeVisible();
      await capture(`${viewport.name}-page-default`);
      await pageCreate.click();
      const pageCreateForm = operationForm(page, "Sample.create", pageOwner);
      await expect(pageCreateForm).toBeVisible();
      await expectDialogActions(pageCreateForm);
      await pageCreateForm.locator('[name="inputs[title]"]').fill("Unsubmitted page sample");
      await capture(`${viewport.name}-page-create-dialog`);
      await dialogFor(pageCreateForm).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(pageCreateForm).not.toBeVisible();
      await expect(pageCreate).toBeFocused();
      await pageOwner.locator("[data-can-action-menu-trigger]").click();
      await expect(pageOwner.locator("[data-can-action-menu-popover]")).toBeVisible();
      await capture(`${viewport.name}-page-secondary-open`);
      await pageOwner.getByRole("link", { name: "Inspect row owners", exact: true }).click();
      await expect(page).toHaveURL(`${origin}/rows`);
      await expect(page.getByRole("heading", { name: "Collection row owners", exact: true })).toBeVisible();
      await inspectOwner(card(page, "List rows").locator("li[data-can-row-actions]"), "list", viewport.name);
      await inspectOwner(card(page, "Table rows").locator("tbody > tr"), "table", viewport.name);
      // The reported defect was in dark mode; inspect both table dialogs there
      // as well, without changing the app's saved preference or its CSS.
      await page.emulateMedia({ colorScheme: "dark" });
      const tableRow = card(page, "Table rows").locator("tbody > tr");
      await tableRow.getByRole("button", { name: "Edit table sample", exact: true }).click();
      const darkEdit = operationForm(page, "Sample.update", tableRow);
      await expectDialogActions(darkEdit);
      await capture(`${viewport.name}-table-edit-dark`);
      await dialogFor(darkEdit).getByRole("button", { name: "Cancel", exact: true }).click();
      await tableRow.locator("[data-can-action-menu-trigger]").click();
      await tableRow.getByRole("button", { name: "Archive table sample", exact: true }).click();
      const darkArchive = operationForm(page, "Sample.delete", tableRow);
      await expectDialogActions(darkArchive);
      await capture(`${viewport.name}-table-confirm-dark`);
      await dialogFor(darkArchive).getByRole("button", { name: "Cancel", exact: true }).click();
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(`${origin}/overlays`);
      await page.getByRole("link", { name: "Open sample modal", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "Modal sample", exact: true });
      await inspectOwner(modal, "modal", viewport.name);
      await modal.locator("[data-can-panel-close]").click();
      await expect(modal).not.toBeVisible();
      await page.getByRole("link", { name: "Open sample drawer", exact: true }).click();
      const drawer = page.locator("aside").filter({ has: page.getByRole("heading", { name: "Drawer sample", exact: true }) });
      await inspectOwner(drawer, "drawer", viewport.name);
      await drawer.locator("[data-can-panel-close]").click();
      await expect(drawer).not.toBeVisible();
      await page.getByRole("link", { name: "Sample details", exact: true }).click();
      await inspectOwner(page.locator("[data-can-split-panel]"), "detail", viewport.name);
      await page.goto(`${origin}/split-list`);
      await page.locator(".drawer-content .list a").first().click();
      await inspectOwner(page.locator("[data-can-split-panel]"), "split list", viewport.name);
      await page.goto(`${origin}/split-table`);
      await page.getByRole("link", { name: "Open details", exact: true }).click();
      await inspectOwner(page.locator("[data-can-split-panel]"), "split table", viewport.name);
    }
    expect(errors).toEqual([]);
    await session.assertCurrent();
  } catch (error) {
    const failure = resolve(screenshots, "failure.png");
    await page.screenshot({ path: failure, fullPage: true, animations: "disabled" })
      .then(() => info.attach("failure", { path: failure, contentType: "image/png" })).catch(() => {});
    const splitState = await page.locator("[data-can-split]").evaluateAll(roots => roots.slice(0, 8).map((root, index) => {
      const rects = (element: Element | null) => element === null ? [] : Array.from(element.getClientRects()).slice(0, 4)
        .map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }));
      const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const dialog = root.querySelector<HTMLDialogElement>("dialog[data-can-split-panel]");
      const style = dialog === null ? null : getComputedStyle(dialog);
      const ancestors = [];
      for (let ancestor = dialog?.parentElement ?? null; ancestor !== null && ancestors.length < 8; ancestor = ancestor.parentElement) {
        ancestors.push({ tag: ancestor.tagName, inert: ancestor.inert, hidden: ancestor.hidden,
          ariaHidden: ancestor.getAttribute("aria-hidden") });
      }
      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("footer [data-can-primary-actions] button"));
      return { index, checkbox: checkbox === null ? null : {
        checked: checkbox.checked, checkedAttribute: checkbox.hasAttribute("checked"), rects: rects(checkbox),
      }, dialog: dialog === null ? null : {
        open: dialog.open, modal: dialog.matches(":modal"), rects: rects(dialog),
        visibility: style?.visibility, display: style?.display, ariaHidden: dialog.getAttribute("aria-hidden"),
        inert: dialog.inert, ancestors,
      }, footerPrimaryButtonCount: buttons.length,
      visibleFooterPrimaryCaptions: buttons.filter(button => button.getClientRects().length > 0 &&
        getComputedStyle(button).visibility !== "hidden" && getComputedStyle(button).display !== "none")
        .slice(0, 12).map(button => (button.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120)) };
    })).catch(() => []);
    await info.attach("split-state", { body: Buffer.from(JSON.stringify(splitState, null, 2)), contentType: "application/json" });
    throw error;
  } finally {
    try { await context.close(); } finally { await session.close(); }
  }
});
