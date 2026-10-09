import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Miniflare } from "miniflare";
import { chromium, expect as browserExpect } from "@playwright/test";
import type { CompileArtifact } from "@canlang/contracts";
import { CSRF_FIELD } from "@canlang/contracts";
import { SESSION_COOKIE_NAME, buildSessionCookie, deriveCsrfToken, hashPassword, loginWithPassword, sha256HexText } from "@canlang/identity";
import { deriveOperationInputs } from "@canlang/interfaces/http/operations";
import { projectGeneratedInputs, submitGeneratedForm } from "@canlang/ui";
import { buildDeployBundleWithAssets, writeDeployBundleWithAssets, DEPLOY_MAIN_MODULE } from "../src/deploy/bundle.js";

// The released authored producer is supplied by the focused integration run.
// A handwritten page cannot stand in for the compiler/production join.
// Shared fetch profile used by both Node and workerd in these callers.
type TestFetchInit = { method?: string; headers?: Record<string, string>; body?: string };
const producer = process.env["CANLANG_PAGE_ARTIFACT"];
const workers: Miniflare[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.dispose()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("authored operation forms through defining default Worker", () => {
  it("renders checked create controls and submits the canonical envelope while bound forms stay unavailable", async () => {
    const artifact = JSON.parse(readFileSync(resolve("packages/cloudflare/test/fixtures/typed-operation-forms.json"), "utf8")) as CompileArtifact;
    const bundle = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } });
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "can-operation-forms-")); dirs.push(dir);
    writeDeployBundleWithAssets(bundle, dir);
    const worker = new Miniflare({ compatibilityDate: "2026-07-15", modulesRoot: "/",
      modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
        type: "ESModule" as const, path: `/${path}`, contents: bundle.modules[path]!,
      })), d1Databases: { DB: "actual-operation-forms" } }); workers.push(worker);
    const DB = await worker.getD1Database("DB");
    const fetch = (path: string, init?: TestFetchInit) =>
      worker.dispatchFetch(new URL(path, "https://example.test").href, init);
    const { buildProductionDeps } = await loadStagedModule(pathToFileURL(join(dir, "runtime/env-assembly.js")).href);
    const deps = await buildProductionDeps({ DB });
    // This case issues a real session against the production D1 identity store.
    // The selected-team owner is explicit setup, not a fabricated page context.
    const password = "form-owner-password";
    const user = await deps.identityStore.createUser({ email: "form-owner@example.test",
      password_hash: await hashPassword(password), email_verified: true });
    const team = await deps.identityStore.createTeam({ timezone: "Europe/Brussels" });
    const membership = await deps.identityStore.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const { token } = await loginWithPassword(deps.identityStore, { email: user.email, password });
    const session = await deps.identityStore.findSessionByTokenHash(await sha256HexText(token));
    expect(session).not.toBeNull();
    await deps.identityStore.setSessionTeam(session.session_id, team.team_id);
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
    const csrf = await deriveCsrfToken(token);
    expect((await fetch("/")).status).toBe(403);
    const page = await fetch("/", { headers: { cookie } });
    expect(page.status, await page.clone().text()).toBe(200);
    const html = await page.text();
    const forms = (html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [])
      .filter(form => form.includes('action="/api/operations/'));
    expect(forms).toHaveLength(2);
    const form = forms[0]!;
    // Inspect actual emitted controls; no handwritten field definitions or HTML.
    const attributes = (tag: string) => Object.fromEntries(
      [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1]!, match[2]!]),
    );
    const controls = [...form.matchAll(/<input\b[^>]*>/g)].map(match => attributes(match[0]));
    expect(controls.filter(control => control["name"] === "inputs[label]")).toHaveLength(1);
    expect(controls.filter(control => control["name"] === "inputs[count]")).toHaveLength(1);
    expect(controls.find(control => control["name"] === "inputs[count]")?.["value"]).toBe("1");
    expect(controls.find(control => control["name"] === "inputs[label]")?.["aria-required"]).toBe("true");
    expect(form).toContain("Entry label"); expect(form).toContain("Count"); expect(form).toContain("Add entry");
    expect(html).not.toContain('name="inputs[owner]"');
    expect(forms[1]).toContain("Add another entry");
    const occurrenceControls = forms.map(form => [...form.matchAll(/<input\b[^>]*>/g)].map(match => attributes(match[0])));
    for (const controls of occurrenceControls) {
      expect(controls.filter(control => control["name"] === "inputs[label]")).toHaveLength(1);
      expect(controls.filter(control => control["name"] === "inputs[count]")).toHaveLength(1);
    }
    const occurrenceIds = occurrenceControls.flatMap(controls => controls.map(control => control["id"]).filter(id => id !== undefined));
    expect(occurrenceIds).toHaveLength(4);
    expect(new Set(occurrenceIds).size).toBe(4);
    const occurrenceNonces = occurrenceControls.map(controls => controls.find(control => control["name"] === "operation_id")?.["value"]);
    expect(new Set(occurrenceNonces).size).toBe(2);
    for (const nonce of occurrenceNonces) expect(nonce).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ids = controls.map(control => control["id"]).filter(id => id !== undefined);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(form).toContain(`for="${id}"`);
    const action = attributes(form.slice(0, form.indexOf(">") + 1))["action"]!;
    expect(action).toBe("/api/operations/TypedOperationForms.Entry.create");
    expect(attributes(forms[1]!.slice(0, forms[1]!.indexOf(">") + 1))["action"]).toBe(action);
    const flat = Object.fromEntries(controls.filter(control => control["name"] !== undefined)
      .map(control => [control["name"]!, control["value"] ?? ""]));
    expect(flat[CSRF_FIELD]).toBe(csrf);
    expect(flat["operation_id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const operation = artifact.operations!.find(operation => operation.name === "TypedOperationForms.Entry.create")!;
    const derived = deriveOperationInputs(operation);
    flat["inputs[label]"] = "Actual created entry";
    // Clearing the optional prefill delegates the original source default to State.
    flat["inputs[count]"] = "";
    expect(projectGeneratedInputs(derived, "create", flat)).toEqual({ label: "Actual created entry" });
    const submit = () => submitGeneratedForm({ derived, mode: "create", flat, action, fragment: false,
      fetchImpl: (url, init) => {
        if (typeof init.body !== "string") throw new Error("generated create submit must carry its JSON envelope");
        return fetch(url, { method: init.method, headers: { ...init.headers, cookie }, body: init.body });
      },
    });
    const committed = await submit();
    expect(committed.kind).toBe("committed");
    if (committed.kind !== "committed") throw new Error("actual generated form did not commit");
    expect(committed.result.status).toBe("committed");
    const model = "TypedOperationForms.Entry";
    const rows = await deps.store.query({ model, authority: "owner" });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.data).toEqual({ label: "Actual created entry", count: "1", owner: { id: user.user_id } });
    const receipt = await deps.store.readReceipt({ app: "TypedOperationForms", owner: team.team_id,
      principal: user.user_id, operation: operation.name, operationId: flat["operation_id"] });
    expect(receipt.resolvedDefaults).toEqual({ count: "1", owner: { id: user.user_id } });
    const history = await deps.store.historyFor(model, row.id);
    const revision = await deps.store.readRevision();
    const replayed = await submit();
    expect(replayed.kind).toBe("committed");
    if (replayed.kind !== "committed") throw new Error("actual generated form did not replay");
    expect(replayed.result.status).toBe("replayed");
    expect(replayed.result.result).toBeNull();
    expect(replayed.result.records).toEqual(committed.result.records);
    const body = JSON.stringify({ operation: operation.name, operation_id: flat["operation_id"],
      inputs: projectGeneratedInputs(derived, "create", flat) });
    expect((await fetch(action, { method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": "wrong" }, body })).status).toBe(403);
    expect((await fetch(action, { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body })).status).toBe(403);
    expect(await deps.store.readRevision()).toBe(revision);
    expect(await deps.store.query({ model, authority: "owner" })).toEqual(rows);
    expect(await deps.store.historyFor(model, row.id)).toEqual(history);
    const after = await fetch("/", { headers: { cookie } });
    expect(after.status, await after.clone().text()).toBe(200);
    const afterHtml = await after.text();
    expect(afterHtml).toContain("Protected forms are unavailable.");
    expect((afterHtml.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [])
      .filter(form => form.includes('action="/api/operations/'))).toHaveLength(2);
    expect(afterHtml).not.toContain('name="inputs[entry]');
    expect(afterHtml).not.toContain('name="inputs[newLabel]"');
    expect(afterHtml).not.toContain('name="inputs[delta]"');
    expect(afterHtml).not.toContain("Save changes");
    const nextId = attributes(afterHtml.match(/<input\b[^>]*name="operation_id"[^>]*>/)![0])["value"];
    expect(nextId).not.toBe(flat["operation_id"]);

    // Drive the emitted bootstrap in installed Chromium over the real Worker
    // HTTP origin. Direct submission above remains a separate admitted path.
    const origin = (await worker.ready).origin;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      try {
        await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, url: `${origin}/`,
          httpOnly: true, secure: false, sameSite: "Lax" }]);
        const browserPage = await context.newPage();
        const response = await browserPage.goto(`${origin}/`);
        expect(response?.status()).toBe(200);
        const browserForms = browserPage.locator("form[data-can-generated-form]");
        await browserExpect(browserForms).toHaveCount(2);
        const browserForm = browserForms.nth(0);
        const neighbor = browserForms.nth(1);
        await neighbor.getByLabel("Entry label").fill("Neighbor draft");
        await neighbor.getByLabel("Count", { exact: true }).fill("12");
        const neighborNonce = await neighbor.locator('input[name="operation_id"]').inputValue();
        const neighborFeedback = neighbor.locator("[data-can-form-feedback]");
        await browserExpect(neighborFeedback).toBeHidden();
        expect(await neighbor.getAttribute("data-can-submit-state")).toBeNull();
        await browserForm.getByLabel("Entry label").fill("Browser created entry");
        await browserForm.getByLabel("Count", { exact: true }).fill("1.5");
        const nonce = await browserForm.locator('input[name="operation_id"]').inputValue();
        expect(nonce).not.toBe(flat["operation_id"]);
        expect(nonce).not.toBe(neighborNonce);
        const button = browserForm.getByRole("button", { name: "Add entry", exact: true });
        const isCreatePost = (response: import("@playwright/test").Response) =>
          new URL(response.url()).pathname === action && response.request().method() === "POST";
        // Integer projection keeps the draft verbatim; the owning HTTP bound
        // checker rejects fractional wire before State admission pins a receipt.
        const invalidPost = browserPage.waitForResponse(isCreatePost);
        await button.click();
        expect((await invalidPost).status()).toBe(400);
        await browserExpect(browserForm).toHaveAttribute("data-can-submit-state", "denied");
        const feedback = browserForm.locator("[data-can-form-feedback]");
        await browserExpect(feedback).toBeVisible();
        await browserExpect(feedback).toHaveAttribute("data-can-form-feedback-code", "validation");
        await browserExpect(feedback).toContainText("count");
        expect(await feedback.locator("*").count()).toBe(0);
        await browserExpect(browserForm.getByLabel("Entry label")).toHaveValue("Browser created entry");
        await browserExpect(browserForm.getByLabel("Count", { exact: true })).toHaveValue("1.5");
        expect(await browserForm.locator('input[name="operation_id"]').inputValue()).toBe(nonce);
        await browserExpect(neighbor.getByLabel("Entry label")).toHaveValue("Neighbor draft");
        await browserExpect(neighbor.getByLabel("Count", { exact: true })).toHaveValue("12");
        expect(await neighbor.locator('input[name="operation_id"]').inputValue()).toBe(neighborNonce);
        expect(await neighbor.getAttribute("data-can-submit-state")).toBeNull();
        await browserExpect(neighborFeedback).toBeHidden();
        expect(await neighborFeedback.textContent()).toBe("");
        expect(await neighborFeedback.getAttribute("data-can-form-feedback-code")).toBeNull();
        expect(await deps.store.readRevision()).toBe(revision);
        expect(await deps.store.query({ model, authority: "owner" })).toEqual(rows);
        expect(await deps.store.historyFor(model, row.id)).toEqual(history);
        expect(await deps.store.readReceipt({ app: "TypedOperationForms", owner: team.team_id,
          principal: user.user_id, operation: operation.name, operationId: nonce })).toBeNull();

        // A separate canonical mutation changes the authorized source rows.
        // Its real HX poll must preserve both compatible form occurrences.
        const ownFeedback = await feedback.textContent();
        const focusedCount = browserForm.getByLabel("Count", { exact: true });
        await focusedCount.focus();
        const refreshed = browserPage.waitForResponse(async response =>
          new URL(response.url()).pathname === "/" && response.request().headers()["hx-request"] === "true" &&
          response.status() === 200 && (await response.text()).includes("Poll created entry"));
        const externalCreate = await fetch(action, { method: "POST",
          headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify({ operation: operation.name, operation_id: nextId, inputs: { label: "Poll created entry" } }) });
        expect(externalCreate.status).toBe(200);
        const externalResult: unknown = await externalCreate.json();
        expect(externalResult).toHaveProperty("status", "committed");
        await refreshed;
        await browserExpect(browserPage.locator("#can-main")).toContainText("Poll created entry");
        await browserExpect(browserForms).toHaveCount(2);
        await browserExpect(browserForm.getByLabel("Entry label")).toHaveValue("Browser created entry");
        await browserExpect(focusedCount).toHaveValue("1.5");
        await browserExpect(focusedCount).toBeFocused();
        expect(await browserForm.locator('input[name="operation_id"]').inputValue()).toBe(nonce);
        await browserExpect(browserForm).toHaveAttribute("data-can-submit-state", "denied");
        await browserExpect(feedback).toBeVisible();
        await browserExpect(feedback).toHaveAttribute("data-can-form-feedback-code", "validation");
        expect(await feedback.textContent()).toBe(ownFeedback);
        await browserExpect(neighbor.getByLabel("Entry label")).toHaveValue("Neighbor draft");
        await browserExpect(neighbor.getByLabel("Count", { exact: true })).toHaveValue("12");
        expect(await neighbor.locator('input[name="operation_id"]').inputValue()).toBe(neighborNonce);
        expect(await neighbor.getAttribute("data-can-submit-state")).toBeNull();
        await browserExpect(neighborFeedback).toBeHidden();
        expect(await neighborFeedback.textContent()).toBe("");
        expect(await neighborFeedback.getAttribute("data-can-form-feedback-code")).toBeNull();
        expect(await browserForm.getAttribute("action")).toBe(action);
        expect(await browserForm.locator(`input[name="${CSRF_FIELD}"]`).inputValue()).toBe(csrf);
        const polledRows = await deps.store.query({ model, authority: "owner" });
        expect(polledRows).toHaveLength(2);
        const polledRevision = await deps.store.readRevision();
        let browserCreateRequests = 0;
        browserPage.on("request", request => {
          if (new URL(request.url()).pathname === action && request.method() === "POST") browserCreateRequests += 1;
        });

        // Correct this same occurrence without minting a replacement nonce.
        await browserForm.getByLabel("Count", { exact: true }).fill("");
        const browserPost = browserPage.waitForResponse(isCreatePost);
        await button.click();
        const createdResponse = await browserPost;
        expect(createdResponse.status()).toBe(200);
        expect(createdResponse.request().headers()["content-type"]).toContain("application/json");
        expect(createdResponse.request().headers()["x-csrf-token"]).toBe(csrf);
        expect(createdResponse.request().postDataJSON()).toEqual({
          operation: operation.name, operation_id: nonce, inputs: { label: "Browser created entry" },
        });
        const createdResult = await createdResponse.json();
        expect(createdResult.status).toBe("committed");
        await browserExpect(browserForm).toHaveAttribute("data-can-submit-state", "committed");
        await browserExpect(feedback).toBeHidden();
        const browserRows = await deps.store.query({ model, authority: "owner" });
        expect(browserRows).toHaveLength(3);
        expect(browserCreateRequests).toBe(1);
        expect(await deps.store.readRevision()).toBe(polledRevision + 1);
        const browserRow = browserRows.find((entry: { data: Record<string, unknown> }) => entry.data["label"] === "Browser created entry");
        expect(browserRow.data).toEqual({ label: "Browser created entry", count: "1", owner: { id: user.user_id } });
        const browserReceipt = await deps.store.readReceipt({ app: "TypedOperationForms", owner: team.team_id,
          principal: user.user_id, operation: operation.name, operationId: nonce });
        expect(browserReceipt.resolvedDefaults).toEqual({ count: "1", owner: { id: user.user_id } });
        const browserHistory = await deps.store.historyFor(model, browserRow.id);
        const browserRevision = await deps.store.readRevision();

        // The same DOM form retains its nonce; a second actual click replays.
        const browserReplay = browserPage.waitForResponse(isCreatePost);
        await button.click();
        const replayResponse = await browserReplay;
        expect(replayResponse.status()).toBe(200);
        expect(replayResponse.request().postDataJSON().operation_id).toBe(nonce);
        const replayResult = await replayResponse.json();
        expect(replayResult.status).toBe("replayed");
        expect(browserCreateRequests).toBe(2);
        expect(replayResult.result).toEqual(createdResult.result);
        expect(replayResult.records).toEqual(createdResult.records);
        await browserExpect(browserForm).toHaveAttribute("data-can-submit-state", "committed");
        expect(await deps.store.readRevision()).toBe(browserRevision);
        expect(await deps.store.query({ model, authority: "owner" })).toEqual(browserRows);
        expect(await deps.store.historyFor(model, browserRow.id)).toEqual(browserHistory);

        await browserForm.locator(`input[name="${CSRF_FIELD}"]`).evaluate((input, value) => {
          if (!("value" in input)) throw new Error("CSRF control must expose its input value");
          input.value = value;
        }, "wrong");
        const browserDenial = browserPage.waitForResponse(isCreatePost);
        await button.click();
        const deniedResponse = await browserDenial;
        expect(deniedResponse.status()).toBe(403);
        expect(deniedResponse.request().headers()["x-csrf-token"]).toBe("wrong");
        await browserExpect(browserForm).toHaveAttribute("data-can-submit-state", "denied");
        expect(await deps.store.readRevision()).toBe(browserRevision);
        expect(await deps.store.query({ model, authority: "owner" })).toEqual(browserRows);
        expect(await deps.store.historyFor(model, browserRow.id)).toEqual(browserHistory);
        expect(await deps.store.readReceipt({ app: "TypedOperationForms", owner: team.team_id,
          principal: user.user_id, operation: operation.name, operationId: nonce })).toEqual(browserReceipt);
        // Membership is resolved again by the native poll and operation route.
        // Revocation must also withdraw the old editing/submission affordances.
        const refusedPoll = browserPage.waitForResponse(response =>
          new URL(response.url()).pathname === "/" && response.request().headers()["hx-request"] === "true" && response.status() === 403);
        await deps.identityStore.removeMembership(membership.membership_id);
        expect((await refusedPoll).status()).toBe(403);
        // Assert the public browser outcome, allowing removal, hiding, native
        // disabled controls or an inert subtree without fixing a private marker.
        await browserExpect.poll(() => browserPage.locator(
          'form[data-can-generated-form] input:not([type="hidden"]), form[data-can-generated-form] textarea, form[data-can-generated-form] select, form[data-can-generated-form] button',
        ).evaluateAll(controls => controls.every(control =>
          !control.checkVisibility() || control.matches(":disabled") || control.closest("[inert]") !== null,
        ))).toBe(true);
        const revokedPost = await fetch(action, { method: "POST",
          headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify({ operation: operation.name, operation_id: neighborNonce, inputs: { label: "After revocation" } }) });
        expect(revokedPost.status).toBe(403);
        expect(await deps.store.readRevision()).toBe(browserRevision);
        expect(await deps.store.query({ model, authority: "owner" })).toEqual(browserRows);
        expect(await deps.store.historyFor(model, browserRow.id)).toEqual(browserHistory);
        expect(await deps.store.readReceipt({ app: "TypedOperationForms", owner: team.team_id,
          principal: user.user_id, operation: operation.name, operationId: nonce })).toEqual(browserReceipt);
        const anonymousContext = await browser.newContext();
        try {
          const anonymousPage = await anonymousContext.newPage();
          expect((await anonymousPage.goto(`${origin}/`))?.status()).toBe(403);
        } finally { await anonymousContext.close(); }
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }, 60_000);
});
const loadStagedModule = (url: string): Promise<any> => import(/* @vite-ignore */ url);

describe.skipIf(producer === undefined)("authored Images page through defining default Worker", () => {
  it("serves full/HX/HEAD with authorized rows, real assets and explicit query refusals", async () => {
    const artifact = JSON.parse(readFileSync(producer!, "utf8")) as CompileArtifact;
    const bundle = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: (artifact.pages?.length ?? 0) > 0 } });
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "can-page-query-")); dirs.push(dir);
    writeDeployBundleWithAssets(bundle, dir);
    const worker = new Miniflare({ compatibilityDate: "2026-07-15", modulesRoot: "/",
      modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
        type: "ESModule" as const, path: `/${path}`, contents: bundle.modules[path]!,
      })), d1Databases: { DB: "actual-images-page" } }); workers.push(worker);
    const DB = await worker.getD1Database("DB");
    const nodeWorker = (await loadStagedModule(pathToFileURL(join(dir, DEPLOY_MAIN_MODULE)).href)).default;
    const callers = [
      (path: string, init?: TestFetchInit) => worker.dispatchFetch(`https://example.test${path}`, init),
      (path: string, init?: TestFetchInit) => nodeWorker.fetch(new Request(`https://example.test${path}`, init), { DB }, { waitUntil() {} }),
    ];
    // First request creates real schemas through the actual production owner.
    const initial = await callers[0]!("/");
    expect(initial.status, await initial.clone().text()).toBe(200);
    await DB.prepare("INSERT INTO records(model,id,version,created,updated,created_by,updated_by,data) VALUES (?,?,?,?,?,?,?,?)")
      .bind("Images.Job", "job-1", 1, 1, 1, "fixture", "fixture", JSON.stringify({ title: "Actual row", status: "generating", privateUndeclared: "must not leak" })).run();
    for (const fetch of callers) {
      const full = await fetch("/"); expect(full.status).toBe(200);
      const html = await full.text();
      expect(html.toLowerCase()).toContain("<!doctype html>"); expect(html).toContain("Generating");
      expect(html.match(/id="can-main"/g)).toHaveLength(1);
      expect(html).toContain('href="/assets/browser/can-style.css"');
      expect(html).toContain('src="/assets/browser/bootstrap.js"');
      expect(html).toContain("data-can-poll"); expect(html).not.toContain("must not leak");
      const hx = await fetch("/?poll=yes", { headers: { "HX-Request": "true" } });
      expect(hx.status).toBe(200); const fragment = await hx.text();
      expect(fragment.match(/id="can-main"/g)).toHaveLength(1); expect(fragment.toLowerCase()).not.toContain("<!doctype");
      const head = await fetch("/", { method: "HEAD" }); expect(head.status).toBe(200); expect(await head.text()).toBe("");
      expect((await fetch("/", { headers: { cookie: "can_session=not-an-issued-token" } })).status).toBe(403);
      for (const [key, resource] of Object.entries(bundle.resources)) {
        const response = await fetch(`/assets/${key}?ignored=yes`); expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(resource.bytes);
      }
    }
    // Query controls use the exact same staged canonical runtime, store and identity owner.
    const { buildProductionDeps } = await loadStagedModule(pathToFileURL(join(dir, "runtime/env-assembly.js")).href);
    const deps = await buildProductionDeps({ DB });
    const { queryPageRowsCanonical } = await loadStagedModule(pathToFileURL(join(dir, "runtime/invoke.js")).href);
    const asm = { dir, entryUrl: pathToFileURL(join(dir, artifact.modules[0]!.path)).href,
      moduleUrls: Object.fromEntries(artifact.modules.map(module => [module.path, pathToFileURL(join(dir, module.path)).href])) };
    const identity = { actor: null, team: null, membership: null, resolved_at: new Date().toISOString() };
    const options = { artifact, asm, identity, store: deps.store, memberships: deps.identityStore, model: "Images.Job" };
    const projected = await queryPageRowsCanonical({ ...options, args: { where: { op: "eq", field: "status", value: "generating" }, limit: 1 } });
    expect(projected.rows).toHaveLength(1); expect(projected.rows[0].fields).not.toHaveProperty("privateUndeclared");
    expect(projected.columns.map((column: { field: string }) => column.field)).toEqual(["title", "status"]);
    for (const args of [{ limit: 0 }, { limit: 101 }, { cursor: "opaque" }, { parent: { id: "parent" } }, { where: () => true }, { where: { op: "invented" } }]) {
      await expect(queryPageRowsCanonical({ ...options, args })).rejects.toMatchObject({ code: "validation" });
    }
    await DB.prepare("INSERT INTO records(model,id,version,created,updated,created_by,updated_by,data) VALUES (?,?,?,?,?,?,?,?)")
      .bind("Images.Job", "job-2", 1, 2, 2, "fixture", "fixture", JSON.stringify({ title: "Overflow", status: "ready" })).run();
    await expect(queryPageRowsCanonical({ ...options, args: { limit: 1 } })).rejects.toMatchObject({ code: "validation" });
  }, 60_000);
});

describe("authored readonly state page through native Worker polling", () => {
  it("refreshes Generating to Image ready after an authenticated canonical transition", async () => {
    const artifact = JSON.parse(readFileSync(resolve("packages/cloudflare/test/fixtures/typed-state-page.json"), "utf8")) as CompileArtifact;
    const bundle = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } });
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "can-state-page-")); dirs.push(dir);
    writeDeployBundleWithAssets(bundle, dir);
    const openWorker = () => {
      const opened = new Miniflare({ compatibilityDate: "2026-07-15", modulesRoot: "/",
        modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
          type: "ESModule" as const, path: `/${path}`, contents: bundle.modules[path]!,
        })), d1Databases: { DB: "actual-state-page" }, d1Persist: join(dir, "d1") });
      workers.push(opened);
      return opened;
    };
    let worker = openWorker();
    const DB = await worker.getD1Database("DB");
    const { buildProductionDeps } = await loadStagedModule(pathToFileURL(join(dir, "runtime/env-assembly.js")).href);
    const deps = await buildProductionDeps({ DB });
    const password = "state-page-owner-password";
    const user = await deps.identityStore.createUser({ email: "state-page-owner@example.test",
      password_hash: await hashPassword(password), email_verified: true });
    const team = await deps.identityStore.createTeam({ timezone: "Europe/Brussels" });
    await deps.identityStore.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const { token } = await loginWithPassword(deps.identityStore, { email: user.email, password });
    const session = await deps.identityStore.findSessionByTokenHash(await sha256HexText(token));
    expect(session).not.toBeNull();
    await deps.identityStore.setSessionTeam(session.session_id, team.team_id);
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
    const csrf = await deriveCsrfToken(token);
    const { mintOperationId, isolate } = await import("@canlang/ui");
    const post = async (operation: string, inputs: Record<string, unknown>, authenticated = true) => {
      const response = await worker.dispatchFetch(`https://example.test/api/operations/${operation}`, {
        method: "POST", headers: { "content-type": "application/json", "x-csrf-token": csrf,
          ...(authenticated ? { cookie } : {}) },
        body: JSON.stringify({ operation, operation_id: mintOperationId(), inputs }),
      });
      const body = await response.json() as { status?: string; result?: unknown; records?: Array<{ id: string; version: number }> };
      return { response, body };
    };
    const origin = (await worker.ready).origin;
    // Attach without Playwright's main-session focus/active emulation. The
    // public noDefaults option applies only to this real default Chromium context.
    const profile = join(dir, "chrome-profile");
    const chrome = spawn(chromium.executablePath(), [
      `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
      "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { stdio: "ignore" });
    let launchError: Error | undefined;
    const chromeStopped = new Promise<void>(resolve => {
      chrome.once("exit", () => resolve());
      chrome.once("error", error => { launchError = error; resolve(); });
    });
    let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
    try {
      await browserExpect.poll(() => {
        if (launchError) throw launchError;
        try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; }
        catch { return ""; }
      }, { timeout: 15_000 }).toMatch(/^\d+$/);
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]!;
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true, isLocal: true });
      // The readonly browser is anonymous; only backend mutations use the issued session.
      const context = browser.contexts()[0]!;
      expect(context).toBeDefined();
      try {
        const page = await context.newPage();
        const bootstrap = page.waitForResponse(response => new URL(response.url()).pathname === "/assets/browser/bootstrap.js");
        expect((await page.goto(`${origin}/`))?.status()).toBe(200);
        expect((await bootstrap).status()).toBe(200);
        await browserExpect(page.getByText("No images", { exact: true })).toBeVisible();
        const created = await post("Images.Job.create", {});
        expect(created.response.status, JSON.stringify(created.body)).toBe(200);
        expect(created.body.status).toBe("committed");
        expect(created.body.result).toBeNull();
        const job = created.body.records![0]!;
        expect(job.version).toBe(1);
        await page.reload();
        await browserExpect(page.locator("#can-main .list-row")).toHaveCount(1);
        await browserExpect(page.locator("#can-main [role=alert]")).toHaveCount(0);
        const advanced = await post("Images.advance", { job: { id: job.id, version: "1" } });
        expect(advanced.response.status, JSON.stringify(advanced.body)).toBe(200);
        expect(advanced.body.status).toBe("committed");
        const generating = await deps.store.load("Images.Job", job.id);
        expect(generating.version).toBe(2);
        expect(generating.data).toEqual({ title: "test", status: "generating" });
        const beforeHistory = await deps.store.historyFor("Images.Job", job.id);
        const denied = await post("Images.finish", { job: { id: job.id, version: "2" } }, false);
        expect(denied.response.status).toBe(403);
        expect(await deps.store.load("Images.Job", job.id)).toEqual(generating);
        expect(await deps.store.historyFor("Images.Job", job.id)).toEqual(beforeHistory);
        const initialPage = await page.reload();
        expect(initialPage?.status()).toBe(200);
        expect(await initialPage!.text()).toContain("Generating");
        await browserExpect(page.getByText(isolate("Generating"), { exact: true })).toBeVisible();
        await browserExpect(page.locator("form[data-can-generated-form]")).toHaveCount(0);
        await browserExpect(page.locator('form[action^="/api/operations/"]')).toHaveCount(0);
        let pollRequests = 0;
        page.on("request", request => {
          if (request.headers()["hx-request"] === "true") pollRequests += 1;
        });
        // Both tabs belong to the native default context, so no main inspector
        // session has enabled Playwright's focus/active emulation.
        const siblingTab = await context.newPage();
        await siblingTab.goto("about:blank");
        await page.bringToFront();
        await browserExpect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { document: { visibilityState: string } }).document.visibilityState)).toBe("visible");
        await siblingTab.bringToFront();
        await browserExpect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { document: { visibilityState: string } }).document.visibilityState)).toBe("hidden");
        // Let any request already started before the native transition settle,
        // then observe longer than the actual source's two-second poll cadence.
        await page.waitForTimeout(300);
        const hiddenRequests = pollRequests;
        await page.waitForTimeout(2_500);
        expect(pollRequests).toBe(hiddenRequests);
        const readyPoll = page.waitForResponse(async response =>
          new URL(response.url()).pathname === "/" &&
          response.request().headers()["hx-request"] === "true" &&
          response.status() === 200 && (await response.text()).includes("Image ready"), { timeout: 15_000 });
        const finished = await post("Images.finish", { job: { id: job.id, version: "2" } });
        expect(finished.response.status, JSON.stringify(finished.body)).toBe(200);
        expect(finished.body.status).toBe("committed");
        expect(await page.evaluate(() => (globalThis as typeof globalThis & { document: { visibilityState: string } }).document.visibilityState)).toBe("hidden");
        expect(pollRequests).toBe(hiddenRequests);
        await page.bringToFront();
        await browserExpect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { document: { visibilityState: string } }).document.visibilityState)).toBe("visible");
        await readyPoll;
        expect(pollRequests).toBeGreaterThan(hiddenRequests);
        await siblingTab.close();
        await browserExpect(page.getByText(isolate("Image ready"), { exact: true })).toBeVisible();
        await browserExpect(page.getByText(isolate("Generating"), { exact: true })).toHaveCount(0);
        await browserExpect(page.locator("form[data-can-generated-form]")).toHaveCount(0);
        const persisted = await deps.store.load("Images.Job", job.id);
        expect(persisted.version).toBe(3);
        expect(persisted.data).toEqual({ title: "test", status: "ready" });
        const history = await deps.store.historyFor("Images.Job", job.id);
        expect(history.map((entry: { after: Record<string, unknown> }) => entry.after["status"])).toEqual([
          "idle", "queued", "generating", "ready",
        ]);
        expect(history.map((entry: { version: number }) => entry.version)).toEqual([1, 2, 2, 3]);
        // Hold an actual native Worker HX response, then navigate its owner away.
        let releaseResponse!: () => void;
        const released = new Promise<void>(resolve => { releaseResponse = resolve; });
        let responseHeld!: (body: string) => void;
        const held = new Promise<string>(resolve => { responseHeld = resolve; });
        let responseSettled!: () => void;
        const settled = new Promise<void>(resolve => { responseSettled = resolve; });
        await page.route(`${origin}/`, async route => {
          if (route.request().headers()["hx-request"] !== "true") { await route.continue(); return; }
          const response = await route.fetch();
          responseHeld(await response.text());
          await released;
          try { await route.fulfill({ response }); }
          catch (error) { if (page.url() !== "about:blank") throw error; }
          finally { responseSettled(); }
        });
        expect(await held).toContain("Image ready");
        await page.goto("about:blank");
        releaseResponse();
        await settled;
        await page.unroute(`${origin}/`);
        expect(await page.locator("body").innerText()).toBe("");
        const stoppedRequests = pollRequests;
        await page.waitForTimeout(2_500);
        expect(pollRequests).toBe(stoppedRequests);
        // Reopen the same persisted D1 directory; the readonly view must query it again.
        workers.splice(workers.indexOf(worker), 1);
        await worker.dispose();
        worker = openWorker();
        const reopenedDB = await worker.getD1Database("DB");
        const reopenedDeps = await buildProductionDeps({ DB: reopenedDB });
        const reopenedOrigin = (await worker.ready).origin;
        expect((await page.goto(`${reopenedOrigin}/`))?.status()).toBe(200);
        await browserExpect(page.getByText(isolate("Image ready"), { exact: true })).toBeVisible();
        await browserExpect(page.getByText(isolate("Generating"), { exact: true })).toHaveCount(0);
        await browserExpect(page.locator("form[data-can-generated-form]")).toHaveCount(0);
        expect(await reopenedDeps.store.load("Images.Job", job.id)).toEqual(persisted);
        expect(await reopenedDeps.store.historyFor("Images.Job", job.id)).toEqual(history);
      } finally { await context.close(); }
    } finally {
      await browser?.close();
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGTERM");
      await chromeStopped;
    }
  }, 60_000);
});

describe("configured authored protected forms through native Worker", () => {
  it("restores sealed row bindings and recovers a stale draft with a fresh poll proof", async () => {
    const { SOURCE_FORM_BINDING_FIELD } = await import("@canlang/contracts");
    const { mintOperationId } = await import("@canlang/ui");
    const artifact = JSON.parse(readFileSync(resolve("packages/cloudflare/test/fixtures/typed-operation-forms.json"), "utf8")) as CompileArtifact;
    const bundle = buildDeployBundleWithAssets(artifact, { verdict: { active: true }, assets: { browser: true } });
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "can-protected-forms-")); dirs.push(dir);
    writeDeployBundleWithAssets(bundle, dir);
    const worker = new Miniflare({ compatibilityDate: "2026-07-15", modulesRoot: "/",
      modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
        type: "ESModule" as const, path: `/${path}`, contents: bundle.modules[path]!,
      })), d1Databases: { DB: "actual-protected-forms" },
      // Explicit stable 32-byte fixture key, in the owning canonical base64url spelling.
      bindings: { CAN_FORM_BINDING_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }); workers.push(worker);
    const DB = await worker.getD1Database("DB");
    const { buildProductionDeps } = await loadStagedModule(pathToFileURL(join(dir, "runtime/env-assembly.js")).href);
    const deps = await buildProductionDeps({ DB });
    const password = "protected-form-owner-password";
    const user = await deps.identityStore.createUser({ email: "protected-form-owner@example.test",
      password_hash: await hashPassword(password), email_verified: true });
    const team = await deps.identityStore.createTeam({ timezone: "Europe/Brussels" });
    await deps.identityStore.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const { token } = await loginWithPassword(deps.identityStore, { email: user.email, password });
    const session = await deps.identityStore.findSessionByTokenHash(await sha256HexText(token));
    expect(session).not.toBeNull();
    await deps.identityStore.setSessionTeam(session.session_id, team.team_id);
    const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
    const csrf = await deriveCsrfToken(token);
    const model = "TypedOperationForms.Entry", create = `${model}.create`, rename = "TypedOperationForms.rename";
    const action = `/api/operations/${rename}`;
    const post = (operation: string, envelope: Record<string, unknown>) => worker.dispatchFetch(
      `https://example.test/api/operations/${operation}`, { method: "POST",
        headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(envelope) });
    const invoke = (operation: string, inputs: Record<string, unknown>) =>
      post(operation, { operation, operation_id: mintOperationId(), inputs });
    const created = await invoke(create, { label: "Protected target" });
    expect(created.status).toBe(200);
    const creation = await created.json() as { result: null; records: Array<{ id: string; version: number }> };
    expect(creation.result).toBeNull();
    const target = creation.records[0]!;
    expect(target.version).toBe(1);
    const origin = (await worker.ready).origin;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      try {
        await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, url: `${origin}/`,
          httpOnly: true, secure: false, sameSite: "Lax" }]);
        const page = await context.newPage();
        expect((await page.goto(`${origin}/`))?.status()).toBe(200);
        const form = page.locator(`form[action="${action}"]`).first();
        await browserExpect(form).toBeVisible();
        await browserExpect(form.getByLabel("New label")).toHaveCount(1);
        await browserExpect(form.getByLabel("Increment")).toHaveValue("1");
        await browserExpect(form.locator('[name^="inputs[entry]"]')).toHaveCount(0);
        const nonceInput = form.locator('input[name="operation_id"]');
        const proofInput = form.locator(`input[name="${SOURCE_FORM_BINDING_FIELD}"]`);
        const nonce = await nonceInput.inputValue(), proof = await proofInput.inputValue();
        expect(proof).not.toBe("");
        await form.getByLabel("New label").fill("Protected rename");
        await form.getByLabel("Increment").fill("");
        await form.getByLabel("New label").focus();
        const unrelatedPoll = page.waitForResponse(async response =>
          response.request().headers()["hx-request"] === "true" && response.status() === 200 &&
          (await response.text()).includes("Unrelated entry"));
        const unrelated = await invoke(create, { label: "Unrelated entry" });
        expect(unrelated.status).toBe(200);
        await unrelatedPoll;
        await browserExpect(page.locator("#can-main")).toContainText("Unrelated entry");
        expect(await nonceInput.inputValue()).toBe(nonce);
        expect(await proofInput.inputValue()).toBe(proof);
        await browserExpect(form.getByLabel("New label")).toHaveValue("Protected rename");
        await browserExpect(form.getByLabel("New label")).toBeFocused();
        const isRenamePost = (response: import("@playwright/test").Response) =>
          new URL(response.url()).pathname === action && response.request().method() === "POST";
        const button = form.getByRole("button", { name: "Save changes", exact: true });
        const submitted = page.waitForResponse(isRenamePost);
        await button.click();
        const committed = await submitted;
        expect(committed.status()).toBe(200);
        const envelope = committed.request().postDataJSON() as Record<string, unknown>;
        expect(envelope).toEqual({ operation: rename, operation_id: nonce,
          [SOURCE_FORM_BINDING_FIELD]: proof, inputs: { newLabel: "Protected rename" } });
        const result = await committed.json();
        expect(result.status).toBe("committed"); expect(result.result).toBe("2");
        const row = await deps.store.load(model, target.id);
        expect(row.version).toBe(2);
        expect(row.data).toEqual({ label: "Protected rename", count: "2", owner: { id: user.user_id } });
        const receiptIdentity = { app: "TypedOperationForms", owner: team.team_id,
          principal: user.user_id, operation: rename, operationId: nonce };
        const receipt = await deps.store.readReceipt(receiptIdentity);
        expect(receipt.resolvedDefaults).toEqual({ delta: "1" });
        const history = await deps.store.historyFor(model, target.id), revision = await deps.store.readRevision();
        const replay = await post(rename, envelope);
        expect(replay.status).toBe(200);
        const replayResult = await replay.json() as { status: string; result: unknown };
        expect(replayResult.status).toBe("replayed"); expect(replayResult.result).toEqual(result.result);
        // A sealed field cannot be replaced by submitted JSON; an invalid seal
        // also refuses before an already committed nonce can replay.
        expect((await post(rename, { ...envelope, inputs: { newLabel: "Override", entry: { id: target.id, version: "2" } } })).status).toBe(403);
        expect((await post(rename, { ...envelope, [SOURCE_FORM_BINDING_FIELD]: "invalid" })).status).toBe(403);
        expect(await deps.store.load(model, target.id)).toEqual(row);
        expect(await deps.store.historyFor(model, target.id)).toEqual(history);
        expect(await deps.store.readRevision()).toBe(revision);
        expect(await deps.store.readReceipt(receiptIdentity)).toEqual(receipt);

        // The changed row requires a fresh server nonce/proof pair before the
        // next attempt. Compatible drafts survive that binding replacement.
        await browserExpect.poll(() => proofInput.inputValue()).not.toBe(proof);
        const staleNonce = await nonceInput.inputValue(), staleProof = await proofInput.inputValue();
        expect(staleNonce).not.toBe(nonce);
        let releasePoll!: () => void, heldPoll!: () => void, settledPoll!: () => void;
        const release = new Promise<void>(resolve => { releasePoll = resolve; });
        const held = new Promise<void>(resolve => { heldPoll = resolve; });
        const settled = new Promise<void>(resolve => { settledPoll = resolve; });
        await page.route(`${origin}/`, async route => {
          if (route.request().headers()["hx-request"] !== "true") { await route.continue(); return; }
          const response = await route.fetch();
          heldPoll();
          await release;
          try { await route.fulfill({ response }); } finally { settledPoll(); }
        });
        try {
          await held;
          await form.getByLabel("New label").fill("Recovered draft");
          await form.getByLabel("Increment").fill("");
          const external = await invoke(rename, { entry: { id: target.id, version: "2" }, newLabel: "External rename" });
          expect(external.status).toBe(200);
          expect((await external.json() as { result: unknown }).result).toBe("3");
          const current = await deps.store.load(model, target.id);
          const currentHistory = await deps.store.historyFor(model, target.id), currentRevision = await deps.store.readRevision();
          const stale = page.waitForResponse(isRenamePost);
          await button.click();
          expect((await stale).status()).toBe(409);
          const feedback = form.locator("[data-can-form-feedback]");
          await browserExpect(feedback).toBeVisible();
          await browserExpect(feedback).toHaveAttribute("data-can-form-feedback-code", "conflict");
          await browserExpect(form.getByLabel("New label")).toHaveValue("Recovered draft");
          expect(await nonceInput.inputValue()).toBe(staleNonce);
          expect(await proofInput.inputValue()).toBe(staleProof);
          expect(await deps.store.load(model, target.id)).toEqual(current);
          expect(await deps.store.historyFor(model, target.id)).toEqual(currentHistory);
          expect(await deps.store.readRevision()).toBe(currentRevision);
        } finally { releasePoll(); await settled; await page.unroute(`${origin}/`); }
        await browserExpect.poll(() => proofInput.inputValue()).not.toBe(staleProof);
        const freshNonce = await nonceInput.inputValue(), freshProof = await proofInput.inputValue();
        expect(freshNonce).not.toBe(staleNonce);
        await browserExpect(form.getByLabel("New label")).toHaveValue("Recovered draft");
        await browserExpect(form.getByLabel("Increment")).toHaveValue("");
        const retried = page.waitForResponse(isRenamePost);
        await button.click();
        const recovered = await retried;
        expect(recovered.status()).toBe(200);
        expect(recovered.request().postDataJSON()).toEqual({ operation: rename, operation_id: freshNonce,
          [SOURCE_FORM_BINDING_FIELD]: freshProof, inputs: { newLabel: "Recovered draft" } });
        expect((await recovered.json()).result).toBe("4");
        await browserExpect(form).toHaveAttribute("data-can-submit-state", "committed");
        await browserExpect(form.locator("[data-can-form-feedback]")).toBeHidden();
        const recoveredRow = await deps.store.load(model, target.id);
        expect(recoveredRow.version).toBe(4); expect(recoveredRow.data.count).toBe("4");
        expect(recoveredRow.data.label).toBe("Recovered draft");
        expect((await deps.store.readReceipt({ ...receiptIdentity, operationId: freshNonce })).resolvedDefaults).toEqual({ delta: "1" });

        // The authored CRUD update carries a sealed current record and exposes
        // only changes. Clearing count omits that patch rather than defaulting.
        const updateOperation = `${model}.update`, updateAction = `/api/operations/${updateOperation}`;
        const updateForm = page.locator(`form[action="${updateAction}"]`).first();
        await browserExpect(updateForm.getByLabel("Entry label")).toHaveValue("Recovered draft");
        await browserExpect(updateForm.getByLabel("Count", { exact: true })).toHaveValue("4");
        await browserExpect(updateForm.locator('[name^="inputs[record]"]')).toHaveCount(0);
        const updateNonce = await updateForm.locator('input[name="operation_id"]').inputValue();
        const updateProof = await updateForm.locator(`input[name="${SOURCE_FORM_BINDING_FIELD}"]`).inputValue();
        expect(updateProof).not.toBe("");
        await updateForm.getByLabel("Entry label").fill("Updated through source form");
        await updateForm.getByLabel("Count", { exact: true }).fill("");
        const beforeUpdateHistory = await deps.store.historyFor(model, target.id);
        const beforeUpdateRevision = await deps.store.readRevision();
        const updating = page.waitForResponse(response =>
          new URL(response.url()).pathname === updateAction && response.request().method() === "POST");
        await updateForm.getByRole("button", { name: "Update entry", exact: true }).click();
        const updatedResponse = await updating;
        expect(updatedResponse.status()).toBe(200);
        const updateEnvelope = updatedResponse.request().postDataJSON();
        expect(updateEnvelope).toEqual({ operation: updateOperation, operation_id: updateNonce,
          [SOURCE_FORM_BINDING_FIELD]: updateProof, inputs: { label: "Updated through source form" } });
        const updateResult = await updatedResponse.json();
        expect(updateResult.status).toBe("committed");
        await browserExpect(updateForm).toHaveAttribute("data-can-submit-state", "committed");
        const updatedRow = await deps.store.load(model, target.id);
        expect(updatedRow.version).toBe(5);
        expect(updatedRow.data).toEqual({ label: "Updated through source form", count: "4", owner: { id: user.user_id } });
        const updateReceiptIdentity = { ...receiptIdentity, operation: updateOperation, operationId: updateNonce };
        const updateReceipt = await deps.store.readReceipt(updateReceiptIdentity);
        expect(updateReceipt.resolvedDefaults).toEqual({});
        const updateHistory = await deps.store.historyFor(model, target.id);
        expect(updateHistory).toHaveLength(beforeUpdateHistory.length + 1);
        expect(await deps.store.readRevision()).toBe(beforeUpdateRevision + 1);
        const updateRevision = await deps.store.readRevision();
        const updateReplay = await post(updateOperation, updateEnvelope);
        expect(updateReplay.status).toBe(200);
        expect((await updateReplay.json() as { status: string }).status).toBe("replayed");
        expect(await deps.store.load(model, target.id)).toEqual(updatedRow);
        expect(await deps.store.historyFor(model, target.id)).toEqual(updateHistory);
        expect(await deps.store.readRevision()).toBe(updateRevision);
        expect(await deps.store.readReceipt(updateReceiptIdentity)).toEqual(updateReceipt);
      } finally { await context.close(); }
    } finally { await browser.close(); }
  }, 60_000);
});
