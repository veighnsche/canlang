import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/fixtures/prompt-pipeline/playwright",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "./output/prompt-pipeline/playwright",
  use: { ...devices["Desktop Chrome"], actionTimeout: 15_000, trace: "off" },
});
