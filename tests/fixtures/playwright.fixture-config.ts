import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

/**
 * Shared settings for per-fixture Playwright entry points. Each fixture dir keeps
 * its own thin config file because testDir/outputDir resolve relative to the
 * caller's location; the caller passes its own dir.
 */
export function fixtureConfig(appDir: string) {
  return defineConfig({
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
}
