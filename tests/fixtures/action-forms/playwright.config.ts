import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  testDir: resolve(appDir, "playwright"),
  testMatch: "app.spec.ts",
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env.CAN_ACCEPTANCE_OUTPUT ?? resolve(appDir, "playwright/results"),
  use: { browserName: "chromium", locale: "en-US", colorScheme: "light", actionTimeout: 15_000, trace: "off", video: "off" },
});
