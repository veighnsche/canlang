import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/cloudflare/test/native-original-canchat.pending.ts", "packages/cloudflare/test/native-guarded-email.test.ts"] },
});
