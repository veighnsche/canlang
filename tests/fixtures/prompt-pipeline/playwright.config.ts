import { defineConfig, devices } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const workspace = process.env.CAN_ACCEPTANCE_WORKSPACE ?? resolve(appDir, "../../..");

export default defineConfig({
  testDir: resolve(appDir, "playwright"),
  timeout: 240_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: process.env.CAN_ACCEPTANCE_OUTPUT ?? resolve(workspace, "output/prompt-pipeline/playwright"),
  use: { ...devices["Desktop Chrome"], actionTimeout: 15_000, trace: "off" },
});
