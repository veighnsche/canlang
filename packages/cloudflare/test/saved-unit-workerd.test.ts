import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertSavedUnitSeparation, packSavedUnitModules } from "../src/deploy/bundle.js";
import { startLocalDev } from "../src/runtime/native-preview.test-support.js";

// BGI-11 actual-target harness: the demonstrated missing case —
// packing, separation, maps, and assets qualify in pure unit tests,
// but no fixture executes a packed saved unit on workerd. This one
// small harness boots real workerd (miniflare), imports the staged
// saved module, and asserts its behavior. Browser execution of the
// view `mount` export stays on the held external gate: it is
// reported, never claimed.

describe("saved-unit workerd behavior", () => {
  it("runs a packed saved keyword export on workerd", async () => {
    const js = "export function canonicalKey(value) { return value.normalize(\"NFKC\").toLowerCase(); }\n";
    const sha256 = createHash("sha256").update(js, "utf8").digest("hex");
    const staged = packSavedUnitModules([{ unitId: "u3", kind: "keyword", js, sha256 }]);
    assertSavedUnitSeparation(staged);
    const dev = await startLocalDev({
      workerName: "saved-unit",
      // Within miniflare v4 workerd's supported range (newest: 2026-08-06).
      compatibilityDate: "2026-07-15",
      mainModule: "entry.mjs",
      modules: {
        ...staged,
        "entry.mjs": `import { canonicalKey } from "./can.generated/u3/server.js";
export default { async fetch() { return Response.json({ key: canonicalKey("HeLLo") }); } }`,
      },
    });
    try {
      const response = await dev.dispatch("/");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ key: "hello" });
    } finally {
      await dev.dispose();
    }
  }, 120000);
});
