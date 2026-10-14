import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDraftSession } from "../../../e2e/drafts/dev-session.js";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(process.env.CAN_ACCEPTANCE_WORKSPACE ?? resolve(appDir, "../../.."));
const candidateSource = process.env.CAN_ACCEPTANCE_SOURCE;
if (candidateSource !== undefined && !isAbsolute(candidateSource)) {
  throw new Error("CAN_ACCEPTANCE_SOURCE must be an absolute candidate source path");
}
const source = candidateSource ?? resolve(appDir, "PromptStudio.can");
const operationForm = (page: Page, operation: string, scope: Page | Locator = page): Locator =>
  scope.locator("form").filter({ has: page.locator(`input[name="operation"][value="PromptStudio.${operation}"]`) });
const field = (form: Locator, name: string, update = false): Locator =>
  form.locator(`input[name="inputs${update ? "[changes]" : ""}[${name}]"]`);
const actionMenu = (card: Locator): Locator => card.locator("[data-can-action-menu]");
const actionTrigger = (card: Locator): Locator => card.locator("[data-can-action-menu-trigger]");
const primaryEdit = (card: Locator): Locator => card.locator("[data-can-primary-actions]").getByRole("button", { name: /^Edit (?:item|alias)$/ });
const actionPopover = (card: Locator): Locator => actionMenu(card).locator("[popover]");
const actionDialog = (page: Page, card: Locator, operation: string): Locator =>
  card.locator("dialog").filter({ has: operationForm(page, operation) });

async function expectCompactActions(card: Locator): Promise<void> {
  await expect(actionMenu(card)).toHaveCount(1);
  const trigger = actionTrigger(card);
  await expect(trigger).toHaveAccessibleName("More actions");
  await expect(actionPopover(card)).not.toBeVisible();
  await expect(card.locator("form:visible")).toHaveCount(0);
  if (await primaryEdit(card).count()) await expect(primaryEdit(card)).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  const renderedRoot = card.locator(":scope > [data-can-card]");
  const surface = await renderedRoot.count() ? renderedRoot : card;
  const cardBox = await surface.boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  // The closed action occupies one touch target in the card's top-right header.
  expect(triggerBox!.width).toBeGreaterThanOrEqual(44);
  expect(triggerBox!.width).toBeLessThanOrEqual(56);
  expect(triggerBox!.height).toBeGreaterThanOrEqual(44);
  expect(triggerBox!.height).toBeLessThanOrEqual(56);
  expect(triggerBox!.x + triggerBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width + 1);
  expect(cardBox!.x + cardBox!.width - triggerBox!.x - triggerBox!.width).toBeLessThanOrEqual(48);
  expect(triggerBox!.y - cardBox!.y).toBeGreaterThanOrEqual(0);
  expect(triggerBox!.y - cardBox!.y).toBeLessThanOrEqual(48);
}

async function expectItemCohesion(card: Locator, handle: string): Promise<void> {
  const article = card.locator(":scope > [data-can-card]");
  const titleBox = await article.getByRole("heading").boundingBox();
  const footerBox = await article.locator(":scope > .card-body > footer").boundingBox();
  const primaryBox = await primaryEdit(card).boundingBox();
  const handleBox = await article.locator(":scope > .card-body > p").filter({ hasText: handle }).boundingBox();
  const statusBox = await article.locator(":scope > .card-body > .badge").filter({ hasText: /Open|Done/ }).boundingBox();
  expect(titleBox).not.toBeNull();
  expect(footerBox).not.toBeNull();
  expect(primaryBox).not.toBeNull();
  expect(handleBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  // Allow ordinary padding/divider spacing, but keep content and action together.
  expect(Math.abs(footerBox!.x - titleBox!.x)).toBeLessThanOrEqual(8);
  expect(Math.abs(primaryBox!.x - titleBox!.x)).toBeLessThanOrEqual(8);
  const metadataBottom = Math.max(handleBox!.y + handleBox!.height, statusBox!.y + statusBox!.height);
  const actionGap = primaryBox!.y - metadataBottom;
  expect(actionGap).toBeGreaterThanOrEqual(8);
  expect(actionGap).toBeLessThanOrEqual(40);
}

async function openActions(card: Locator, key?: "Enter" | "Space"): Promise<void> {
  const trigger = actionTrigger(card);
  if (key) {
    await trigger.focus();
    await trigger.press(key);
  } else {
    await trigger.click();
  }
  await expect(actionPopover(card)).toBeVisible();
  await expect(actionPopover(card).getByRole("button", { name: /^Edit (?:item|alias)$/ })).toHaveCount(0);
  await expect(actionPopover(card).getByRole("button", { name: /^Archive (?:item|alias)$/ })).toBeVisible();
}

async function selectAction(page: Page, card: Locator, label: "Edit" | "Archive", key?: "Enter" | "Space", operation = label === "Edit" ? "Item.update" : "Item.delete"): Promise<Locator> {
  const button = actionPopover(card).getByRole("button", { name: new RegExp(`^${label} (?:item|alias)$`) });
  if (key) {
    await button.focus();
    await button.press(key);
  } else {
    await button.click();
  }
  await expect(actionPopover(card)).not.toBeVisible();
  const dialog = actionDialog(page, card, operation);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveJSProperty("open", true);
  return dialog;
}

const drawerFor = (form: Locator): Locator => form.locator(
  'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " drawer ")][1]',
);
const formDialog = (form: Locator): Locator => form.locator("xpath=ancestor::dialog[1]");
const formDialogOpener = (form: Locator): Locator => form.locator(
  "xpath=ancestor::div[@data-can-menu-dialog][1]",
).locator(":scope > [data-can-menu-dialog-open]");
async function openForm(form: Locator): Promise<void> {
  const dialog = formDialog(form);
  if (await dialog.count()) {
    if (await dialog.getAttribute("open") === null) {
      await formDialogOpener(form).click();
    }
    await expect(dialog).toHaveJSProperty("open", true);
  } else if (!await form.isVisible()) {
    await drawerFor(form).locator(":scope > .drawer-content label.drawer-button").click();
  }
  await expect(form).toBeVisible();
}
async function closeForm(form: Locator): Promise<void> {
  const dialog = formDialog(form);
  if (await dialog.count()) {
    if (await dialog.getAttribute("open") !== null) {
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await expect(dialog).not.toBeVisible();
    return;
  }
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
  const session = await openDraftSession({ root, source, app: "PromptStudio" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const snapshots = process.env.CAN_ACCEPTANCE_OUTPUT
    ? resolve(process.env.CAN_ACCEPTANCE_OUTPUT, "screenshots")
    : resolve(appDir, "playwright/screenshots");
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
    const itemCreate = operationForm(page, "Item.create");
    const createOpener = formDialogOpener(itemCreate);
    await expect(createOpener).toBeVisible();
    await expect(createOpener).toHaveAccessibleName("Create item");
    await expect(createOpener.locator("xpath=ancestor::*[@data-can-primary-actions][1]")).toHaveCount(1);
    await expect(itemCreate).not.toBeVisible();
    await capture("01-empty-desktop");
    await openForm(itemCreate);
    await field(itemCreate, "title").fill("Draft item");
    await field(itemCreate, "handle").fill("Draft");
    await closeForm(itemCreate);
    await expect(createOpener).toBeFocused();
    await expect(page.locator("[data-can-view-presentation]")).toHaveCount(0);
    await openForm(itemCreate);
    await expect(field(itemCreate, "title")).toHaveValue("Draft item");
    await expect(field(itemCreate, "handle")).toHaveValue("Draft");
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
    await expect(primaryEdit(cards.first())).toBeVisible();
    await expect(operationForm(page, "Item.update", cards.first())).not.toBeVisible();
    await closeForm(operationForm(page, "Item.create"));
    await expectCompactActions(cards.first());
    await expectItemCohesion(cards.first(), "Ａlice");
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
    await expectCompactActions(firstItem);
    await expectItemCohesion(firstItem, "Ａlice");
    const collectionBox = await cards.first().locator("xpath=ancestor::li[1]/..").boundingBox();
    const firstCardBox = await cards.nth(0).locator(":scope > [data-can-card]").boundingBox();
    const secondCardBox = await cards.nth(1).locator(":scope > [data-can-card]").boundingBox();
    expect(collectionBox).not.toBeNull();
    expect(firstCardBox).not.toBeNull();
    expect(secondCardBox).not.toBeNull();
    if (collectionBox!.width >= 672) {
      // Two short records should share a row when two readable cards fit.
      expect(Math.abs(firstCardBox!.y - secondCardBox!.y)).toBeLessThanOrEqual(8);
      expect(firstCardBox!.width).toBeLessThanOrEqual(collectionBox!.width * 0.6);
    }
    await openActions(firstItem, "Enter");
    await expect(actionTrigger(firstItem)).toHaveCount(1);
    await expect(actionPopover(firstItem).getByRole("link", { name: "Open notes", exact: true })).toHaveAttribute("href", "/notes");
    await expect(cards).toHaveCount(2);
    await expect(operationForm(page, "Item.delete", firstItem)).not.toBeVisible();
    await capture("09-actions-open-desktop");
    await actionTrigger(firstItem).press("Escape");
    await expectCompactActions(firstItem);
    await expect(actionTrigger(firstItem)).toBeFocused();
    await openActions(firstItem, "Space");
    // Native popover light-dismiss leaves the collection untouched.
    await page.locator("main").click({ position: { x: 2, y: 2 } });
    await expectCompactActions(firstItem);
    await expect(cards).toHaveCount(2);

    await primaryEdit(firstItem).focus();
    await primaryEdit(firstItem).press("Enter");
    const cancelledEdit = actionDialog(page, firstItem, "Item.update");
    await expect(cancelledEdit).toBeVisible();
    const edit = operationForm(page, "Item.update", firstItem);
    await field(edit, "title", true).fill("Unsaved title");
    await cancelledEdit.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectCompactActions(firstItem);
    await expect(primaryEdit(firstItem)).toBeFocused();
    await expect(firstItem.getByRole("heading", { name: "First item", exact: true })).toBeVisible();
    await expect(cards).toHaveCount(2);
    await primaryEdit(firstItem).click();
    await expect(actionDialog(page, firstItem, "Item.update")).toBeVisible();
    const editedTitle = "Edited item with a longer title that wraps beside its card actions";
    await field(edit, "title", true).fill(editedTitle);
    await submit(edit);
    const editedItem = cards.filter({ has: page.getByRole("heading", { name: editedTitle, exact: true }) });
    await expect(editedItem).toHaveCount(1);
    await expectCompactActions(editedItem);
    await expectItemCohesion(editedItem, "Ａlice");
    await capture("05-edited-desktop");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectCompactActions(editedItem);
    await expectItemCohesion(editedItem, "Ａlice");
    const article = editedItem.locator(":scope > [data-can-card]");
    await expect(article).toHaveCount(1);
    expect(await article.locator("[data-can-card]").evaluateAll(nodes =>
      nodes.filter(node => node.closest("dialog") === null).length)).toBe(0);
    await expect(editedItem.locator('[data-can-style~="u6"], [data-can-style-host~="u6"]')).toHaveCount(0);
    await expect(article.locator(":scope > .card-body > .can-card-heading [data-can-action-menu]")).toHaveCount(1);
    await expect(article.locator(":scope > .card-body > footer [data-can-primary-actions]")).toHaveCount(1);
    const title = article.getByRole("heading", { name: editedTitle, exact: true });
    const titleBox = await title.boundingBox();
    const surfaceBox = await article.boundingBox();
    const primaryBox = await primaryEdit(editedItem).boundingBox();
    const detailsBox = await article.locator(":scope > .card-body > p").filter({ hasText: "Ａlice" }).boundingBox();
    expect(titleBox).not.toBeNull();
    expect(surfaceBox).not.toBeNull();
    expect(primaryBox).not.toBeNull();
    expect(detailsBox).not.toBeNull();
    expect(primaryBox!.y).toBeGreaterThanOrEqual(titleBox!.y + titleBox!.height - 1);
    expect(primaryBox!.y).toBeGreaterThanOrEqual(detailsBox!.y + detailsBox!.height - 1);
    expect(titleBox!.width).toBeGreaterThanOrEqual(surfaceBox!.width * 0.6);
    const lineHeight = await title.evaluate(node => {
      const style = getComputedStyle(node);
      return Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    });
    expect(titleBox!.height / lineHeight).toBeLessThanOrEqual(4.5);
    const availableBox = await editedItem.locator("xpath=ancestor::li[contains(concat(' ', normalize-space(@class), ' '), ' list-row ')][1]").boundingBox();
    expect(availableBox).not.toBeNull();
    expect(surfaceBox!.width).toBeGreaterThanOrEqual(availableBox!.width * 0.9);
    await capture("06-populated-mobile");
    await openActions(editedItem, "Space");
    await capture("10-actions-open-mobile");
    const confirmation = await selectAction(page, editedItem, "Archive", "Space");
    await expect(operationForm(page, "Item.delete", editedItem)).toBeVisible();
    await expect(cards).toHaveCount(2);
    await expect(editedItem).toContainText(editedTitle);
    await capture("11-archive-confirmation-mobile");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectCompactActions(editedItem);
    await expect(actionTrigger(editedItem)).toBeFocused();
    await expect(cards).toHaveCount(2);
    await openActions(editedItem, "Enter");
    const escapedConfirmation = await selectAction(page, editedItem, "Archive", "Enter");
    await escapedConfirmation.press("Escape");
    await expectCompactActions(editedItem);
    await expect(actionTrigger(editedItem)).toBeFocused();
    await expect(cards).toHaveCount(2);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openActions(editedItem);
    await selectAction(page, editedItem, "Archive");
    await submit(operationForm(page, "Item.delete", editedItem));
    await expect(cards).toHaveCount(1);
    // Canonical delete archives this model, retaining its unique-key claim.
    await createItem("Archived handle stays reserved", "Alice");
    await expect(page.locator('[data-can-form-feedback]:visible').first()).toBeVisible();
    await expect(cards).toHaveCount(1);
    await createItem("Fresh handle", "Charlie");
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: "Fresh handle" })).toContainText("Charlie");

    await closeForm(operationForm(page, "Item.create"));
    const freshItem = cards.filter({ has: page.getByRole("heading", { name: "Fresh handle", exact: true }) });
    await openActions(freshItem);
    await actionPopover(freshItem).getByRole("link", { name: "Open notes", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/notes`);
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
    const aliasCards = page.locator("section.card").filter({ has: page.locator("[data-can-action-menu]") });
    await expect(aliasCards).toHaveCount(3);
    const aliasIds = await aliasCards.locator("[data-can-action-menu-trigger]").evaluateAll(nodes =>
      nodes.map(node => node.getAttribute("popovertarget")));
    expect(aliasIds.every(id => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(aliasIds).size).toBe(3);
    const fullwidthAlias = aliasCards.filter({ has: page.getByRole("heading", { name: "Ａlice", exact: true }) });
    await expectCompactActions(fullwidthAlias);
    const aliasTitleBox = await fullwidthAlias.getByRole("heading", { name: "Ａlice", exact: true }).boundingBox();
    const aliasPrimaryBox = await primaryEdit(fullwidthAlias).boundingBox();
    expect(aliasTitleBox).not.toBeNull();
    expect(aliasPrimaryBox).not.toBeNull();
    expect(aliasPrimaryBox!.y).toBeGreaterThanOrEqual(aliasTitleBox!.y + aliasTitleBox!.height - 1);
    await openActions(fullwidthAlias, "Enter");
    const aliasConfirmation = await selectAction(page, fullwidthAlias, "Archive", "Enter", "Alias.delete");
    await expect(operationForm(page, "Alias.delete", fullwidthAlias)).toBeVisible();
    await expect(aliasCards).toHaveCount(3);
    await aliasConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectCompactActions(fullwidthAlias);
    await expect(actionTrigger(fullwidthAlias)).toBeFocused();
    await expect(aliasCards).toHaveCount(3);
    await page.setViewportSize({ width: 390, height: 844 });
    await expectCompactActions(fullwidthAlias);
    await capture("08-reused-keyword");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/actions`);
    const listAction = page.getByRole("button", { name: "Edit list item", exact: true }).first();
    const listActions = listAction.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " can-row-actions ")][1]');
    await expect(listActions).toBeVisible();
    const listContentBox = await listAction.locator("xpath=ancestor::li[1]").locator(".can-row-content").boundingBox();
    const listControlBox = await listAction.boundingBox();
    expect(listContentBox).not.toBeNull();
    expect(listControlBox).not.toBeNull();
    expect(listContentBox!.x).toBeLessThan(listControlBox!.x);
    await expect(listActions.locator("[data-can-action-menu]")).toHaveCount(1);
    await listAction.click();
    const listEdit = page.locator("dialog:visible").filter({ has: operationForm(page, "Item.update") });
    await expect(listEdit).toHaveCount(1);
    await listEdit.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(listAction).toBeFocused();
    const tableAction = page.getByRole("button", { name: "Edit table item", exact: true }).first();
    const dataRow = tableAction.locator("xpath=ancestor::tr[1]");
    await expect(dataRow.getByRole("cell")).toHaveCount(3);
    await expect(dataRow.locator("td:last-child .can-row-actions [data-can-action-menu]")).toHaveCount(1);
    const inlineForm = operationForm(page, "Item.create", page.locator('[data-can-card]').filter({ has: page.getByRole("heading", { name: "Inline item", exact: true }) }));
    await expect(inlineForm.locator('[data-can-form-actions] button[type="submit"]')).toHaveCount(1);
    await expect(inlineForm.locator('[data-can-form-actions]').getByRole("button", { name: "Save item", exact: true })).toBeVisible();
    await field(inlineForm, "title").fill("Inline owner item");
    await field(inlineForm, "handle").fill("inline-owner");
    await submit(inlineForm);
    await expect(page.getByRole("cell", { name: /Inline owner item/ })).toBeVisible();
    await capture("12-action-owners-desktop");

    await page.getByRole("link", { name: "Open tools", exact: true }).click();
    const tools = page.getByRole("dialog", { name: "Item tools", exact: true });
    await expect(tools).toBeVisible();
    await expect(tools.locator(".can-panel-heading [data-can-action-menu]")).toHaveCount(1);
    await expect(tools.locator(".modal-action [data-can-primary-actions]").getByRole("button", { name: "Create from tools", exact: true })).toBeVisible();
    await tools.locator(".can-panel-heading [data-can-action-menu-trigger]").click();
    await expect(tools.getByRole("link", { name: "Tool notes", exact: true })).toBeVisible();
    await capture("13-modal-actions");
    await tools.locator("[data-can-action-menu-trigger]").press("Escape");
    await tools.press("Escape");
    await expect(tools).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Open tools", exact: true })).toBeFocused();

    const pageMenu = page.locator("main > header [data-can-action-menu-trigger]");
    await pageMenu.click();
    await page.getByRole("link", { name: "Open drawer", exact: true }).click();
    const drawerPanel = page.locator("aside").filter({ has: page.getByRole("heading", { name: "Item drawer", exact: true }) });
    await expect(drawerPanel).toBeVisible();
    await expect(drawerPanel.locator(".can-panel-heading [data-can-action-menu]")).toHaveCount(1);
    await expect(drawerPanel.locator("footer [data-can-primary-actions]").getByRole("button", { name: "Create from drawer", exact: true })).toBeVisible();
    await capture("14-drawer-actions");
    await drawerPanel.press("Escape");
    await expect(drawerPanel).not.toBeVisible();
    await expect(pageMenu).toBeFocused();

    await page.getByRole("link", { name: "Item detail", exact: true }).first().click();
    const detailPanel = page.locator("[data-can-split-panel]");
    await expect(detailPanel).toBeVisible();
    await expect(detailPanel.locator(".can-panel-heading [data-can-action-menu]")).toHaveCount(1);
    await expect(detailPanel.locator("footer [data-can-primary-actions]").getByRole("button", { name: "Edit detail item", exact: true })).toBeVisible();
    await capture("15-detail-actions");
    await detailPanel.locator("[data-can-split-close]").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("16-action-owners-mobile");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${origin}/split`);
    await expect(page.getByRole("button", { name: "Edit split item", exact: true })).toHaveCount(0);
    await page.locator(".drawer-content .list a").first().click();
    const splitPanel = page.locator("[data-can-split-panel]");
    await expect(splitPanel.locator(".can-panel-heading [data-can-action-menu]")).toHaveCount(1);
    await expect(splitPanel.locator("footer [data-can-primary-actions]").getByRole("button", { name: "Edit split item", exact: true })).toBeVisible();
    await capture("17-split-actions-desktop");
    await page.setViewportSize({ width: 390, height: 844 });
    await capture("18-split-actions-mobile");
    expect(errors).toEqual([]);
    await session.assertCurrent();
  } catch (error) {
    const path = info.outputPath("failure.png");
    await page.screenshot({ path, fullPage: true, animations: "disabled" }).catch(() => {});
    const panels = await page.locator("[data-can-split]").evaluateAll(roots => roots.map(root => {
      const toggle = root.querySelector<HTMLInputElement>(".drawer-toggle");
      const panel = root.querySelector<HTMLDialogElement>("dialog[data-can-split-panel]");
      return {
        checked: toggle?.checked, checkedAttribute: toggle?.hasAttribute("checked"),
        open: panel?.open, modal: panel?.matches(":modal"),
        visibility: panel === null ? null : getComputedStyle(panel).visibility,
        display: panel === null ? null : getComputedStyle(panel).display,
        primaryButtons: [...root.querySelectorAll("footer [data-can-primary-actions] button")]
          .map(button => ({ caption: button.textContent, visible: button.getClientRects().length > 0 })),
      };
    })).catch(() => []);
    await info.attach("split-state", { body: Buffer.from(JSON.stringify(panels)), contentType: "application/json" });
    await info.attach("browser-errors", { body: Buffer.from(JSON.stringify(errors)), contentType: "application/json" });
    throw error;
  } finally {
    try { await context.close(); } finally { await session.close(); }
  }
});
