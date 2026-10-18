import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface DraftVisualOptions {
  appDir: string;
  selection?: string;
  route: string;
  state: string;
  viewport: string;
  /** Optional conceptual reference, separate from the real screenshot baseline. */
  reference?: string;
  masks?: Locator[];
}

export interface DraftVisualResult {
  screenshot: string;
}

function slug(value: string): string {
  return value.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "home";
}

export function draftVisualName(options: Pick<DraftVisualOptions, "route" | "state" | "viewport">): string {
  return `${slug(options.route)}-${slug(options.state)}-${slug(options.viewport)}.png`;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Ordinary Playwright screenshot regression; baselines use its normal update command. */
export async function captureDraftState(page: Page, testInfo: TestInfo, options: DraftVisualOptions): Promise<DraftVisualResult> {
  const appDir = await realpath(options.appDir);
  const name = draftVisualName(options);
  if (options.selection !== undefined && !/^[a-zA-Z0-9_-]+$/.test(options.selection)) throw new Error("Visual selection must be a nonempty safe path segment");
  const snapshotName = options.selection ? [options.selection, name] : [name];
  const screenshot = testInfo.outputPath(...snapshotName);
  await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled", mask: options.masks ?? [] });
  await testInfo.attach("draft-actual", { path: screenshot, contentType: "image/png" });
  if (options.reference) {
    const referenceRoot = path.join(appDir, "playwright", "references");
    const reference = path.resolve(referenceRoot, options.reference);
    if (!inside(referenceRoot, reference) || !reference.toLowerCase().endsWith(".png")) throw new Error("Visual reference must be a PNG under app/playwright/references");
    try {
      if (!inside(appDir, await realpath(referenceRoot)) || !inside(referenceRoot, await realpath(reference))) throw new Error("Visual reference escapes its app directory");
      if ((await stat(reference)).isFile()) await testInfo.attach("conceptual-reference", { path: reference, contentType: "image/png" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await expect(page).toHaveScreenshot(snapshotName, {
    fullPage: true, animations: "disabled", threshold: 0.25, maxDiffPixelRatio: 0.02, mask: options.masks ?? [],
  });
  return { screenshot };
}
