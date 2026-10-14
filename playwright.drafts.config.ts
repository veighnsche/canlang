import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverDraftSources } from "./tests/e2e/drafts/source.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const missingEntries = discoverDraftSources(root).filter(source => !existsSync(path.join(source.appDir, "playwright", "app.spec.ts")));
if (missingEntries.length) throw new Error(`Drafts need app-local Playwright entries: ${missingEntries.map(source => path.relative(root, source.appDir)).join(", ")}`);

// Existing main E2E configuration stays independent. Drafts deliberately fail
// on unavailable language/runtime, missing journeys, or unreviewed appearance.
export default defineConfig({
  testDir: "./draft/apps",
  testMatch: "**/playwright/*.spec.ts",
  timeout: 270_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  updateSnapshots: "none",
  snapshotPathTemplate: "{testDir}/{testFileDir}/baselines/{projectName}/{arg}{ext}",
  outputDir: "./output/draft-frontends/playwright-results",
  reporter: [["list"], ["html", { outputFolder: "output/draft-frontends/playwright-report", open: "never" }]],
  use: { browserName: "chromium", trace: "off", video: "off", screenshot: "off", locale: "en-US", colorScheme: "light", timezoneId: "Europe/Brussels", actionTimeout: 10_000, navigationTimeout: 30_000 },
  projects: [
    { name: "coverage", grep: /@coverage/ },
    { name: "examples", grep: /@examples/ },
    { name: "desktop", grep: /@browser/, use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", grep: /@browser/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
