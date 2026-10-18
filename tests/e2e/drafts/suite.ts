import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDraftSession, type DraftSession } from "./dev-session.js";
import { readDraftSource, selectedInventory, type DraftPage } from "./source.js";
import { captureDraftState, type DraftVisualResult } from "./visual.js";

export interface DraftJourney {
  name: string;
  /** Omit to run against every authored selection in this source. */
  app?: string;
  actor?: string;
  /** Bootstrap the protected preview without creating an application session. */
  unauthenticated?: boolean;
  /** Deliberate offline submission only; every declared failure must occur once. */
  transportFailures?: { operation: string; code: "net::ERR_INTERNET_DISCONNECTED" }[];
  covers?: { states?: { route: string; state: string }[] };
  run(context: {
    page: Page; context: BrowserContext; session: DraftSession; baseURL: string;
    capture(route: string, state: string, reference?: string): Promise<DraftVisualResult>;
  }): Promise<void>;
}

export interface DraftSuiteOptions {
  /** Explicit local Identity grants resolved against the compiled selected app. */
  previewRoles?: Readonly<Record<string, readonly string[]>>;
  /** Business-role provisioning must be real; never assign roles by changing the page DOM. */
  actor?: string;
  /** Permitted seeded identities for guarded routes; custom roles are never inferred. */
  pageActors?: { route: string; actor: string }[];
  journeys?: DraftJourney[];
  /** A page concept may guide several states; it need not duplicate every capture. */
  references?: { route: string; state?: string; viewport?: string; file: string }[];
}

export type DraftTestRegistrar = (title: string, body: (fixtures: { page: Page; context: BrowserContext }, info: TestInfo) => Promise<void>) => void;

function routeMatches(template: string, pathname: string): boolean {
  const segments = template.split(/(\{[^}]+\})/).map(part => part.startsWith("{") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${segments.join("")}$`).test(pathname);
}

async function auditPage(page: Page): Promise<void> {
  const audit = await page.evaluate(() => {
    const visible = (node: Element): boolean => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input:not([type=hidden]),select,textarea")).filter(visible);
    const missingLabels = fields.filter(field => !field.getAttribute("aria-label")?.trim() &&
      !field.getAttribute("aria-labelledby")?.split(/\s+/).some(id => document.getElementById(id)?.textContent?.trim()) &&
      !Array.from(field.labels ?? []).some(label => label.textContent?.trim()) &&
      !(field instanceof HTMLInputElement && ["submit", "button", "reset"].includes(field.type) && field.value)).map(field => field.name);
    const images = Array.from(document.images).filter(visible);
    const main = document.querySelector("#can-main");
    return { main: !!main && visible(main), overflow: document.documentElement.scrollWidth > innerWidth + 1, missingLabels,
      brokenImages: images.filter(image => !image.complete || image.naturalWidth === 0).map(image => image.getAttribute("src")),
      missingAlt: images.filter(image => !image.hasAttribute("alt")).length,
      canonicalCss: Array.from(document.styleSheets).some(sheet => {
        if (!sheet.href || new URL(sheet.href).pathname !== "/assets/browser/can-style.css") return false;
        try { return sheet.cssRules.length > 0; } catch { return false; }
      }) };
  });
  expect(audit, "The actual canonical page and styles must render without clipped content, unlabelled fields or broken images").toEqual({
    main: true, overflow: false, missingLabels: [], brokenImages: [], missingAlt: 0, canonicalCss: true,
  });
}

function browserFailures(page: Page, deniedRoutes: string[] = [], validation = false,
  transportFailures: NonNullable<DraftJourney["transportFailures"]> = []): () => string[] {
  const failures: string[] = [];
  const expectedErrors = new Set<string>();
  const observedTransport = new Set<number>();
  const transportConsole = new Set<string>();
  const consoleErrors: { url: string; status: string | undefined; transport: string | undefined }[] = [];
  // Retain categories and URL paths only; exception/log text can contain secrets or domain data.
  page.on("pageerror", () => failures.push("uncaught browser exception"));
  page.on("console", message => {
    if (message.type() !== "error") return;
    // Chromium reports deliberate HTTP denials as resource console errors.
    // Admit only the expected browser-generated 403 on a declared denied route.
    consoleErrors.push({ url: message.location().url,
      status: /^Failed to load resource:.*\b(\d{3})\b/.exec(message.text())?.[1],
      transport: /^Failed to load resource:\s*(net::ERR_[A-Z_]+)$/.exec(message.text())?.[1] });
  });
  page.on("requestfailed", request => {
    const url = new URL(request.url()), code = request.failure()?.errorText;
    const expected = request.method() === "POST" && url.origin === new URL(page.url()).origin
      ? transportFailures.findIndex((failure, index) => !observedTransport.has(index) &&
        url.pathname === `/api/operations/${failure.operation}` && code === failure.code) : -1;
    if (expected < 0) failures.push(`resource failed: ${url.pathname}`);
    else {
      observedTransport.add(expected);
      transportConsole.add(`${request.url()}#${code}`);
    }
  });
  page.on("response", response => {
    const status = response.status(), url = new URL(response.url());
    const expected = status === 403 && deniedRoutes.some(route => routeMatches(route, url.pathname)) ||
      validation && [400, 409, 422].includes(status) && response.request().method() === "POST" &&
      url.origin === new URL(page.url()).origin && url.pathname.startsWith("/api/operations/");
    if (expected) expectedErrors.add(`${response.url()}#${status}`);
    else if (status >= 400) failures.push(`HTTP ${status}: ${url.pathname}`);
  });
  return () => [...failures,
    ...transportFailures.flatMap((failure, index) => observedTransport.has(index) ? [] : [`expected offline submission missing: ${failure.operation}`]),
    ...consoleErrors.filter(error => !(
      error.status !== undefined && expectedErrors.has(`${error.url}#${error.status}`) ||
      error.transport !== undefined && transportConsole.has(`${error.url}#${error.transport}`)
    )).map(() => "browser console error")];
}

async function withSession<T>(root: string, source: string, app: string, run: (session: DraftSession) => Promise<T>, previewRoles?: DraftSuiteOptions["previewRoles"]): Promise<T> {
  const session = await openDraftSession({ root, source, app, timeoutMs: 240_000,
    ...(previewRoles === undefined ? {} : { previewRoles }) });
  try { return await run(session); } finally { await session.close(); }
}

async function capture(page: Page, info: TestInfo, appDir: string, selection: string, route: string, state: string, reference?: string): Promise<DraftVisualResult> {
  const result = await captureDraftState(page, info, {
    appDir, selection, route, state, viewport: info.project.name,
    ...(state !== "denied" && reference ? { reference } : {}),
  });
  return result;
}

/** App-local normal Playwright entry. Only source-declared selection names are admitted. */
export function defineDraftAppSuite(specUrl: string, register: DraftTestRegistrar, options: DraftSuiteOptions = {}): void {
  const playwrightDir = path.dirname(fileURLToPath(specUrl));
  const appDir = path.dirname(playwrightDir);
  const checkout = path.resolve(appDir, "../../..");
  const root = path.resolve(process.env.CAN_ACCEPTANCE_WORKSPACE ?? process.env.DRAFT_E2E_ROOT ?? checkout);
  const authoredSource = path.join(root, path.relative(checkout, appDir), `${path.basename(appDir)}.can`);
  const source = process.env.CAN_ACCEPTANCE_SOURCE ?? authoredSource;
  if (!path.isAbsolute(source)) throw new Error("Draft candidate source must be absolute");
  const owner = readDraftSource(source);
  if (!owner.selections.length) throw new Error(`No authored app selection in ${source}`);
  const sourceBytes = readFileSync(source, "utf8");
  const journeys = options.journeys ?? [];
  function mappedReference(route: string, state: string, viewport: string): string | undefined {
    const matches = (options.references ?? []).filter(mapping => mapping.route === route &&
      (!mapping.state || mapping.state === state) && (!mapping.viewport || mapping.viewport === viewport));
    const priority = (mapping: NonNullable<DraftSuiteOptions["references"]>[number]): number => Number(!!mapping.state) + Number(!!mapping.viewport);
    matches.sort((a, b) => priority(b) - priority(a));
    if (matches[0] && matches[1] && priority(matches[0]) === priority(matches[1])) throw new Error(`Ambiguous reference mapping for ${route}#${state}#${viewport}`);
    return matches[0]?.file;
  }
  for (const selection of owner.selections) {
    const inventory = selectedInventory(root, owner, selection, authoredSource);
    const expectedExampleRows = inventory.operations.reduce((total, operation) => total + operation.exampleRows, 0);
    const selectedJourneys = journeys.filter(journey => !journey.app || journey.app === selection.name);
    const uniqueRoutes = new Map<string, DraftPage>();
    for (const page of inventory.pages) {
      if (uniqueRoutes.has(page.route)) throw new Error(`Ambiguous route ${page.route} in lexical ${selection.name} closure; compiler selection must resolve it`);
      uniqueRoutes.set(page.route, page);
    }
    test.describe(selection.name, () => {
      if (expectedExampleRows > 0) {
        register("all authored examples execute against current runtime @examples", async ({}, info) => {
          await withSession(root, source, selection.name, async session => {
            const result = await session.runExamples() as { ok?: boolean; current?: boolean; executed?: number; summary?: Record<string, number> };
            // Counts only: rich example results can include caller/private values.
            await info.attach("source-example-counts", { body: JSON.stringify({ ok: result.ok, current: result.current, executed: result.executed, summary: result.summary }), contentType: "application/json" });
            expect(result.ok).toBe(true);
            expect(result.current).toBe(true);
            expect(result.executed).toBeGreaterThan(0);
            expect(result.summary?.total).toBeGreaterThan(0);
            expect(result.summary?.total, "Executed row denominator must match the selected source candidates; resolve compiler membership before accepting any discrepancy").toBe(expectedExampleRows);
            expect(result.executed).toBe(result.summary?.total);
            expect(result.summary?.passed).toBe(result.summary?.total);
            expect(result.summary?.failed).toBe(0);
            expect(result.summary?.setupFailed).toBe(0);
            expect(result.summary?.unsupported).toBe(0);
            await session.assertCurrent();
          }, options.previewRoles);
        });
      }

      for (const pageSpec of uniqueRoutes.values()) {
        // Parameterized routes require a genuine admitted record produced by an
        // app journey. Never browse literal {Record.id} or fabricate its ID.
        if (pageSpec.route.includes("{")) continue;
        register(`${pageSpec.route} initial page and responsive capture @browser`, async ({ page, context }, info) => {
          expect(readFileSync(source, "utf8"), "Authored source changed after suite discovery").toBe(sourceBytes);
          const actor = options.pageActors?.find(actor => actor.route === pageSpec.route)?.actor ?? options.actor;
          if (actor === undefined && pageSpec.guards.some(guard => guard !== "members")) {
            throw new Error(`${selection.name} ${pageSpec.route} needs a genuinely provisioned permitted pageActors identity for: ${pageSpec.guards.join("; ")}`);
          }
          await withSession(root, source, selection.name, async session => {
            const origin = await session.authenticate(context, actor ?? "Ava");
            const failures = browserFailures(page);
            const response = await page.goto(`${origin}${pageSpec.route}`, { waitUntil: "networkidle" });
            expect(response?.status(), "A permitted business-role actor and domain fixtures must be provisioned; a denial/error page is not an accepted app screenshot").toBe(200);
            expect(response?.headers()["content-type"]).toContain("text/html");
            await auditPage(page);
            if (pageSpec.title) await expect(page.getByRole("heading", { name: pageSpec.title, exact: true }).first()).toBeVisible();
            await capture(page, info, appDir, selection.name, pageSpec.route, "initial", mappedReference(pageSpec.route, "initial", info.project.name));
            expect(failures()).toEqual([]);
            await session.assertCurrent();
          }, options.previewRoles);
        });
      }

      for (const journey of selectedJourneys) {
        register(`${journey.name} @browser`, async ({ page, context }, info) => {
          await withSession(root, source, selection.name, async session => {
            const baseURL = await session.authenticate(context, journey.unauthenticated ? null : journey.actor ?? options.actor ?? "Ava");
            const failures = browserFailures(page, (journey.covers?.states ?? []).filter(state => state.state === "denied").map(state => state.route),
              (journey.covers?.states ?? []).some(state => state.state === "validation"), journey.transportFailures);
            await journey.run({ page, context, session, baseURL, capture: async (route, state, reference) => {
              expect(routeMatches(route, new URL(page.url()).pathname), "State capture must match its declared route and genuine record binding").toBe(true);
              await session.assertCurrent();
              if (state === "denied") {
                await expect(page.locator("form")).toHaveCount(0);
                const refusal = JSON.parse(await page.locator("body").innerText()) as { code?: string };
                expect(refusal.code, "Denied captures must show the real canonical refusal").toBe("forbidden");
              } else await auditPage(page);
              const result = await capture(page, info, appDir, selection.name, route, state, reference ?? mappedReference(route, state, info.project.name));
              return result;
            } });
            expect(failures()).toEqual([]);
            await session.assertCurrent();
          }, options.previewRoles);
        });
      }
    });
  }
}
