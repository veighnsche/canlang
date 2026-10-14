import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DraftVisualOptions {
  appDir: string;
  /** App composition namespace; one safe path segment shared with baseline storage. */
  selection?: string;
  route: string;
  state: string;
  viewport: string;
  requireReference?: boolean;
  /** Exact filename beneath app/playwright/references; no inferred state equivalence. */
  reference?: string;
  /** Explicit unstable sample data only. Never mask all controls. */
  masks?: Locator[];
}

export interface DraftVisualResult {
  status: "pending-review" | "baseline-passed" | "baseline-failed";
  pendingReasons: string[];
  referenceStatus: "matched" | "unassigned" | "missing";
  baselineStatus: "missing" | "unapproved" | "passed" | "failed";
  screenshot: string;
  comparison: string;
  metadata: string;
}

function slug(value: string): string {
  return value.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

/** Shared naming convention for authored references and real screenshot baselines. */
export function draftVisualName(options: Pick<DraftVisualOptions, "route" | "state" | "viewport">): string {
  return `${slug(options.route)}-${slug(options.state)}-${slug(options.viewport)}.png`;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function exists(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

async function referenceFiles(appDir: string, options: DraftVisualOptions, name: string): Promise<{ files: string[]; matched: boolean }> {
  const root = path.join(appDir, "playwright", "references");
  const exact = options.reference ?? name;
  const candidate = path.resolve(root, exact);
  if (!inside(root, candidate)) throw new Error("Visual reference must remain under app/playwright/references");
  if (options.reference && !exact.toLowerCase().endsWith(".png")) throw new Error("Visual reference must be a PNG");
  let names: string[];
  try {
    if (!inside(appDir, await realpath(root))) throw new Error("Reference directory escapes appDir");
    names = (await readdir(root)).filter(file => file.toLowerCase().endsWith(".png")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { files: [], matched: false };
  }
  const matched = await exists(candidate);
  const files = matched ? [candidate] : names.map(file => path.join(root, file));
  for (const file of files) {
    if (!inside(root, await realpath(file))) throw new Error(`Visual reference escapes references directory: ${file}`);
  }
  return { files, matched };
}

/**
 * Captures evidence, never accepts a conceptual mockup as a pixel baseline.
 * To enable regression comparison, an existing real Playwright snapshot needs an
 * adjacent .approved.json containing reviewer, approvedAt, baselineSha256, and
 * referenceSha256 for the mapped concept. Digests bind approval to these inputs;
 * the screenshot matcher checks regression only, not conceptual fidelity. Snapshot updates
 * are refused: baseline capture/approval is a separate, deliberate operation.
 * Callers must surface pending-review separately from functional success.
 */
export async function captureDraftState(page: Page, testInfo: TestInfo, options: DraftVisualOptions): Promise<DraftVisualResult> {
  const appDir = await realpath(options.appDir);
  const name = draftVisualName(options);
  if (options.selection !== undefined && !/^[a-zA-Z0-9_-]+$/.test(options.selection)) throw new Error("Visual selection must be a nonempty safe path segment");
  const snapshotName = options.selection ? [options.selection, name] : [name];
  // A canonical JSON refusal has no concept-image equivalent. It still needs
  // an inspected regression baseline, without comparing it to a permitted UI.
  const references = options.requireReference === false && options.reference === undefined
    ? { files: [] as string[], matched: false } : await referenceFiles(appDir, options, name);
  const outputRoot = path.join(appDir, "playwright", "results", ...(options.selection ? [options.selection] : []), name.slice(0, -4));
  await mkdir(outputRoot, { recursive: true });
  if (!inside(appDir, await realpath(outputRoot))) throw new Error("Visual results directory escapes appDir");
  const testId = createHash("sha256").update(testInfo.testId).digest("hex").slice(0, 12);
  const output = await mkdtemp(path.join(outputRoot, `${slug(testInfo.project.name)}-${testId}-retry${testInfo.retry}-`));
  const result: DraftVisualResult = {
    status: "pending-review", pendingReasons: [],
    referenceStatus: references.matched ? "matched" : references.files.length ? "unassigned" : "missing",
    baselineStatus: "missing",
    screenshot: path.join(output, "actual.png"),
    comparison: path.join(output, "comparison.html"),
    metadata: path.join(output, "metadata.json"),
  };
  await page.screenshot({ path: result.screenshot, fullPage: true, animations: "disabled", mask: options.masks ?? [] });
  const accessibility = await page.locator("body").ariaSnapshot();
  await writeFile(path.join(output, "accessibility.yml"), accessibility);
  if (!references.matched && options.requireReference !== false) result.pendingReasons.push(references.files.length ? "No exact reference mapping; displayed references are unassigned concepts." : "No conceptual reference is available.");

  const referenceBytes = new Map(await Promise.all(references.files.map(async file => [file, await readFile(file)] as const)));
  const referenceSha256 = references.matched ? createHash("sha256").update(referenceBytes.get(references.files[0]!)!).digest("hex") : undefined;
  const baseline = testInfo.snapshotPath(...snapshotName);
  let baselineSha256: string | undefined;
  let comparisonError: unknown;
  if (await exists(baseline)) {
    result.baselineStatus = "unapproved";
    baselineSha256 = createHash("sha256").update(await readFile(baseline)).digest("hex");
    let approval: { reviewer?: unknown; approvedAt?: unknown; baselineSha256?: unknown; referenceSha256?: unknown } | undefined;
    try { approval = JSON.parse(await readFile(`${baseline}.approved.json`, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    const currentInputs = approval?.baselineSha256 === baselineSha256 && (references.matched ? approval?.referenceSha256 === referenceSha256 : options.requireReference === false);
    if (approval && !currentInputs) result.pendingReasons.push("Approval does not bind the current baseline and mapped reference bytes; renewed visual inspection is required.");
    if (typeof approval?.reviewer === "string" && approval.reviewer.trim() && typeof approval.approvedAt === "string" && !Number.isNaN(Date.parse(approval.approvedAt)) && currentInputs) {
      if (!inside(appDir, await realpath(baseline))) throw new Error("Approved screenshot baseline must be app-local; configure snapshotPathTemplate under app/playwright");
      if (testInfo.config.updateSnapshots !== "none") throw new Error("Visual capture refuses snapshot update mode; capture and approve real baselines separately");
      try {
        await expect(page).toHaveScreenshot(snapshotName, { fullPage: true, animations: "disabled", threshold: 0.25, maxDiffPixelRatio: 0.02, mask: options.masks ?? [] });
        result.baselineStatus = "passed";
      } catch (error) { result.baselineStatus = "failed"; comparisonError = error; }
    }
  }
  if (result.baselineStatus === "missing" || result.baselineStatus === "unapproved") result.pendingReasons.push(`Real screenshot baseline is ${result.baselineStatus}; visual acceptance is pending.`);
  result.status = result.baselineStatus === "failed" ? "baseline-failed" : result.baselineStatus === "passed" && (references.matched || options.requireReference === false) ? "baseline-passed" : "pending-review";
  if (result.status === "pending-review") testInfo.annotations.push({ type: "visual-review-pending", description: result.pendingReasons.join(" ") });

  const actualBytes = await readFile(result.screenshot);
  const actualSha256 = createHash("sha256").update(actualBytes).digest("hex");
  const actualData = actualBytes.toString("base64");
  const referenceRoot = path.join(appDir, "playwright", "references");
  async function readNotes(file: string): Promise<string> {
    try {
      if (!inside(referenceRoot, await realpath(file))) throw new Error("Reference notes escape references directory");
      return await readFile(file, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return ""; }
  }
  const sharedNotes = [await readNotes(path.join(referenceRoot, "README.md")), await readNotes(path.join(referenceRoot, "prompts.md"))].filter(Boolean).join("\n\n");
  const referencePanels: string[] = [];
  for (const file of references.files) {
    const data = referenceBytes.get(file)!.toString("base64");
    const notes = references.matched ? [await readNotes(file.replace(/\.png$/i, ".md")), await readNotes(file.replace(/\.png$/i, ".prompt.md"))].filter(Boolean).join("\n\n") : "";
    referencePanels.push(`<section><h2>${references.matched ? "Mapped conceptual reference" : "Unassigned conceptual reference"}: ${escapeHtml(path.basename(file))}</h2><img alt="Conceptual reference" src="data:image/png;base64,${data}"><pre>${escapeHtml(notes)}</pre></section>`);
  }
  await writeFile(result.comparison, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Draft visual review</title><style>body{font:16px system-ui;margin:24px;background:#f3f4f6;color:#111827}main{display:flex;gap:24px;align-items:flex-start;overflow:auto}section{flex:0 0 48%;min-width:320px}img{width:100%;height:auto;border:1px solid #9ca3af}pre{white-space:pre-wrap}h2{font-size:18px}</style><h1>${escapeHtml(options.route)} · ${escapeHtml(options.state)} · ${escapeHtml(options.viewport)}</h1><p>Status: ${result.status}. Conceptual mockups guide visual inspection; they are never pixel baselines. Images retain their aspect ratio. A baseline pass checks real screenshot regression; visual inspection establishes conceptual fidelity.</p><p>${escapeHtml(result.pendingReasons.join(" "))}</p><h2>Concept review rubric</h2><p>Flag missing, overlapping, or clipped controls; unreadable hierarchy; wrong major structure; and responsive breakage. Ignore harmless font antialiasing, small spacing differences, and sample content. References may guide multiple states; do not adopt invented concept features.</p><main><section><h2>Actual browser capture</h2><img alt="Actual application screenshot" src="data:image/png;base64,${actualData}"></section>${referencePanels.join("")}</main><h2>Reference review notes</h2><pre>${escapeHtml(sharedNotes)}</pre></html>`);
  await writeFile(result.metadata, JSON.stringify({ ...result, selection: options.selection, route: options.route, state: options.state, viewport: options.viewport, viewportSize: page.viewportSize(), urlPathname: new URL(page.url()).pathname, project: testInfo.project.name, testId: testInfo.testId, retry: testInfo.retry, capturedAt: new Date().toISOString(), baseline, baselineApprovalFile: `${baseline}.approved.json`, baselineSha256, actualSha256, referenceSha256, requestedReference: options.reference ?? name, references: references.files, explicitMaskCount: options.masks?.length ?? 0, comparisonThreshold: { threshold: 0.25, maxDiffPixelRatio: 0.02 }, error: comparisonError ? "Real screenshot baseline comparison failed; see Playwright failure output." : undefined }, null, 2));
  await testInfo.attach("draft-actual", { path: result.screenshot, contentType: "image/png" });
  await testInfo.attach("draft-visual-comparison", { path: result.comparison, contentType: "text/html" });
  await testInfo.attach("draft-visual-metadata", { path: result.metadata, contentType: "application/json" });
  await testInfo.attach("draft-accessibility", { path: path.join(output, "accessibility.yml"), contentType: "text/yaml" });
  if (comparisonError) throw comparisonError;
  return result;
}
