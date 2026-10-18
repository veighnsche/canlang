import { defineConfig } from "@playwright/test";

// Run the available app examples and browser journeys.
export default defineConfig({
  testDir: "./draft/apps",
  testMatch: "**/playwright/*.spec.ts",
  timeout: 270_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  snapshotPathTemplate: "{testDir}/{testFileDir}/baselines/{projectName}/{arg}{ext}",
  outputDir: "./output/draft-frontends/playwright-results",
  reporter: [["list"], ["html", { outputFolder: "output/draft-frontends/playwright-report", open: "never" }]],
  use: { browserName: "chromium", trace: "off", video: "off", screenshot: "off", locale: "en-US", colorScheme: "light", timezoneId: "Europe/Brussels", actionTimeout: 10_000, navigationTimeout: 30_000 },
  projects: [
    { name: "examples", grep: /@examples/ },
    { name: "desktop", grep: /@browser/, use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", grep: /@browser/, use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
