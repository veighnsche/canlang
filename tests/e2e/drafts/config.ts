import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** One app-local configuration also works when invoked by the acceptance gate. */
export function draftAppConfig(configUrl: string) {
  const appDir = path.dirname(fileURLToPath(configUrl));
  const output = process.env.CAN_ACCEPTANCE_OUTPUT ?? path.join(appDir, "playwright", "results", "runner");
  return defineConfig({
    testDir: path.join(appDir, "playwright"),
    testMatch: "*.spec.ts",
    timeout: 270_000,
    expect: { timeout: 10_000 },
    fullyParallel: false,
    workers: 1,
    retries: 0,
    forbidOnly: true,
    updateSnapshots: "none",
    snapshotPathTemplate: path.join(appDir, "playwright", "baselines", "{projectName}", "{arg}{ext}"),
    outputDir: path.join(output, "test-results"),
    reporter: [["list"], ["html", { outputFolder: path.join(output, "report"), open: "never" }]],
    use: { browserName: "chromium", trace: "off", video: "off", screenshot: "off",
      locale: "en-US", colorScheme: "light", timezoneId: "Europe/Brussels",
      actionTimeout: 10_000, navigationTimeout: 30_000 },
    projects: [
      { name: "coverage", grep: /@coverage/ },
      { name: "examples", grep: /@examples/ },
      { name: "desktop", grep: /@browser/, use: { viewport: { width: 1440, height: 1000 } } },
      { name: "mobile", grep: /@browser/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    ],
  });
}
