// E2E-track-owned Playwright config (L7 reviews). Specs live in tests/e2e
// and drive a per-worker L7 workerd instance through the e2e http bridge —
// there is intentionally NO webServer block: one startLocalDev per worker
// is the D1 isolation mechanism, and the bridge URL is dynamic per worker.
//
// Run with root `npm run test:e2e` (L7 PR23: @playwright/test + CI job).
// Chromium-only until the first green TeamTasks run.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
