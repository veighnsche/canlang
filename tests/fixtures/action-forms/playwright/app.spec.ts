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
const card = (page: Page, heading: string, recordTitle?: string): Locator => {
  const cards = page.locator("[data-can-card]").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
  return recordTitle === undefined ? cards : cards.filter({ hasText: recordTitle });
};
const titleInput = (form: Locator, update = false): Locator =>
  form.locator(`input[name="inputs${update ? "[changes]" : ""}[title]"]`);
const dialogFor = (form: Locator): Locator => form.locator("xpath=ancestor::dialog[1]");

async function expectSubmit(form: Locator, caption: string): Promise<void> {
  await expect(form).toHaveCount(1);
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
      const inlineUpdate = operationForm(page, "Sample.update", card(page, "Inline update form", "Inspection sample"));
      await expectSubmit(inlineUpdate, "Save inline update");
      await expect(titleInput(inlineUpdate, true)).toHaveValue("Inspection sample");
      await capture(`${viewport.name}-inline-update-default`);
      const editCard = card(page, "Canonical edit control", "Inspection sample");
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
      const persistedInline = operationForm(page, "Sample.update", card(page, "Inline update form", "Inspection sample"));
      await expect(titleInput(persistedInline, true)).toHaveValue("Inspection sample");
      await expect(persistedInline.locator('[name="inputs[changes][note]"]')).toHaveValue(inlineNote);
      await capture(`${viewport.name}-inline-update-saved`);
      const persistedEditCard = card(page, "Canonical edit control", "Inspection sample");
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
      const persistedFinal = operationForm(page, "Sample.update", card(page, "Inline update form", "Inspection sample"));
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

test("failed current rereads mark retained values and denied rereads discard private content", async ({ browser }) => {
  const session = await openDraftSession({ root, source, app: "ActionForms" });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  type ReadFault = "none" | "http" | "network" | "malformed" | "denied";
  let fault: ReadFault = "none";
  let reads = 0;
  let releaseRead: (() => void) | undefined;
  let settleRead: (() => void) | undefined;
  let readGate: Promise<void> | undefined;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    const origin = await session.authenticate(context);
    await page.route(`${origin}/**`, async route => {
      const request = route.request();
      if (request.method() !== "GET" || request.headers()["hx-request"] !== "true") {
        await route.continue(); return;
      }
      reads += 1;
      const currentFault = fault;
      const gate = readGate;
      if (gate !== undefined) await gate;
      if (currentFault === "none") { await route.continue(); return; }
      if (currentFault === "network") { await route.abort("failed"); return; }
      // Only the reread transport is faulted: mutations and normal page loads
      // still use the real native server and canonical operation admission.
      await route.fulfill({ status: currentFault === "denied" ? 403 : currentFault === "http" ? 503 : 200,
        contentType: "text/html", body: '<p>Untrusted reread body must never replace the page</p>' }).catch(error => {
        if (request.failure() === null) throw error;
      });
      settleRead?.();
    });
    await page.goto(origin);
    const create = operationForm(page, "Sample.create", card(page, "Inline create form"));
    await titleInput(create).fill("Private retained sample");
    await create.locator('[name="inputs[note]"]').fill("Original authorized note");
    await create.getByRole("button", { name: "Save inline sample", exact: true }).click();
    await expect(page.getByRole("cell", { name: /Private retained sample/ })).toBeVisible();

    let previousNote = "Original authorized note";
    for (const selected of ["http", "network", "malformed"] as const) {
      await page.goto(`${origin}/edit`);
      const main = page.locator("#can-main");
      const inline = operationForm(page, "Sample.update", card(page, "Inline update form", "Private retained sample"));
      const draft = operationForm(page, "Sample.update", card(page, "Canonical edit control", "Private retained sample"));
      await card(page, "Canonical edit control", "Private retained sample").locator("[data-can-panel-open]").click();
      await titleInput(draft, true).fill(`Private draft ${selected}`);
      await card(page, "Canonical edit control", "Private retained sample").locator("aside .can-panel-heading [data-can-panel-close]").click();
      const nextNote = `Confirmed mutation ${selected}`;
      await inline.locator('[name="inputs[changes][note]"]').fill(nextNote);
      fault = selected;
      await inline.getByRole("button", { name: "Save inline update", exact: true }).click();
      const stale = main.locator('[data-stale-region="can-main"][role="alert"]');
      await expect(stale).toBeVisible();
      await expect(main).toHaveAttribute("data-can-stale", "true");
      await expect(card(page, "Inline update form", "Private retained sample")).toContainText(previousNote);
      await expect(titleInput(draft, true)).toHaveValue(`Private draft ${selected}`);
      await expect(main).not.toContainText("Untrusted reread body");
      fault = "none";
      // Identical submission replays the genuine committed operation and asks
      // for another authorized GET, without issuing a second business change.
      await inline.getByRole("button", { name: "Save inline update", exact: true }).click();
      await expect(stale).toHaveCount(0);
      await expect(main).not.toHaveAttribute("data-can-stale", "true");
      await expect(card(page, "Inline update form", "Private retained sample")).toContainText(nextNote);
      await expect(titleInput(draft, true)).toHaveValue(`Private draft ${selected}`);
      previousNote = nextNote;
    }

    // Exercise the installed poll recipient separately from committed-form
    // rereads. Transport metadata arms the existing GET lifecycle; this is
    // not a source refresh-operation or scheduler qualification.
    await page.goto(`${origin}/edit`);
    fault = "http";
    const beforePoll = reads;
    await page.locator("#can-main").evaluate(main => {
      main.setAttribute("data-can-poll-url", location.pathname);
      main.setAttribute("data-can-poll-interval", "1");
      main.setAttribute("data-can-poll", "");
    });
    await expect(page.locator('[data-stale-region="can-main"]')).toBeVisible();
    expect(reads).toBe(beforePoll + 1);
    await expect(page.locator("#can-main")).toContainText(previousNote);
    fault = "none";
    // The existing visibility rearm requests fresh admission after a refused
    // poll. A valid server partial clears its old failure marker.
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator('[data-stale-region="can-main"]')).toHaveCount(0);

    // An obsolete denial from a read started on /edit must not clear the
    // newly navigated page, even if the old transport settles afterwards.
    fault = "denied";
    readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const obsoleteSettled = new Promise<void>(resolve => { settleRead = resolve; });
    const beforeObsolete = reads;
    const obsoleteUpdate = operationForm(page, "Sample.update", card(page, "Inline update form", "Private retained sample"));
    await obsoleteUpdate.locator('[name="inputs[changes][note]"]').fill("Committed before navigation");
    await obsoleteUpdate.getByRole("button", { name: "Save inline update", exact: true }).click();
    await expect.poll(() => reads).toBe(beforeObsolete + 1);
    await page.goto(origin);
    releaseRead!(); readGate = undefined; releaseRead = undefined;
    await obsoleteSettled; settleRead = undefined;
    // Browser navigation may abort the old read entirely instead of delivering
    // its denial; either outcome must preserve the new authorized projection.
    await expect(page.getByRole("heading", { name: "Shared form actions", exact: true })).toBeVisible();
    await expect(page.locator("#can-main")).not.toHaveAttribute("data-can-read-denied", "true");

    await page.goto(origin);
    const finalCreate = operationForm(page, "Sample.create", card(page, "Inline create form"));
    await titleInput(finalCreate).fill("Committed before access denial");
    await finalCreate.locator('[name="inputs[note]"]').fill("Private committed value");
    fault = "denied";
    readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    const beforeDenied = reads;
    await finalCreate.getByRole("button", { name: "Save inline sample", exact: true }).click();
    await expect.poll(() => reads).toBe(beforeDenied + 1);
    const dialogCard = card(page, "Canonical operation dialog");
    await dialogCard.getByRole("button", { name: "Open create form", exact: true }).click();
    const privateDraft = operationForm(page, "Sample.create", dialogCard);
    await titleInput(privateDraft).fill("Revoked private draft");
    await page.locator("#can-main").evaluate(main => {
      const image = document.createElement("img");
      image.alt = "Previously authorized private preview";
      image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
      main.appendChild(image);
    });
    await expect(dialogFor(privateDraft)).toHaveJSProperty("open", true);
    releaseRead!(); readGate = undefined; releaseRead = undefined;
    await expect(page.locator("#can-main")).toHaveText("This page is no longer available.");
    await expect(page.locator("#can-main form, #can-main input, #can-main textarea, #can-main img")).toHaveCount(0);
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await expect(page.locator("#can-main")).not.toContainText("Private retained sample");
    await expect(page.locator("#can-main")).not.toContainText("Untrusted reread body");
    expect(errors).toEqual([]);
    await session.assertCurrent();
  } finally {
    releaseRead?.();
    try { await context.close(); } finally { await session.close(); }
  }
});
