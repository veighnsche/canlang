import { defineConfig } from "vitest/config";

// Lane-07-owned suites only. Producer packages keep their own runners until
// their owners opt into this config (e.g. lane 03 uses node:test).
export default defineConfig({
  test: {
    include: [
      "packages/contracts/test/**/*.test.ts",
      "packages/cloudflare/test/**/*.test.ts",
      "packages/testkit/test/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
  },
});
