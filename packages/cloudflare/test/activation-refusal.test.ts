/**
 * B3-I6 serve-refusal tests (`assembleWorker` + `ActivationVerdict`).
 *
 * Failing-first: written before the verdict parameter existed. A worker
 * assembled with a failed verdict must REFUSE to serve (500 envelope
 * naming the first reason) on every route — never 501, never content,
 * never a 404 that could be mistaken for a routing outcome.
 */
import { describe, expect, it } from "vitest";
import type {
  ActivationVerdict,
  CompileArtifact,
  StoragePort,
} from "@canlang/contracts";
import {
  assembleWorker,
  type AssembledModules,
  type AssemblyDeps,
} from "../src/worker/assembly.js";

function fixtureArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "refusal-fixture/0 (hand-written; NOT compiler output)",
    tool_version: "refusal-fixture/0",
    sources: [{ path: "examples/TeamTasks.can", sha256: "fixture-not-a-digest" }],
    modules: [],
    callables: [],
    pages: [],
    requires: [],
    tests: [],
  };
}

function stubAsm(): AssembledModules {
  return { dir: "refusal-fixture", entryUrl: "fixture-entry", moduleUrls: {} };
}

function stubDeps(): AssemblyDeps {
  return {
    store: { readRevision: async () => 0 } as unknown as StoragePort,
    identityStore: {},
  };
}

const FAILED: ActivationVerdict = {
  active: false,
  reasons: [
    { code: "missing-capability", detail: "values.decimal is not installed" },
    { code: "digest-mismatch", detail: "second reason stays unnamed" },
  ],
};

describe("assembleWorker activation refusal", () => {
  it("refuses every route with a 500 envelope naming the FIRST reason", async () => {
    const assembled = await assembleWorker(fixtureArtifact(), stubAsm(), stubDeps(), FAILED);
    expect(assembled.pageCount).toBe(0);
    expect(assembled.opCount).toBe(0);

    for (const url of ["http://localhost/", "http://localhost/nope", "http://localhost/files/intents"]) {
      const response = await assembled.fetch(new Request(url));
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("activation-refused");
      expect(body["reason"]).toBe("missing-capability");
      expect(body["detail"]).toBe("values.decimal is not installed");
      expect(JSON.stringify(body)).not.toContain("second reason stays unnamed");
    }

    const post = await assembled.fetch(new Request("http://localhost/", { method: "POST" }));
    expect(post.status).toBe(500);
    expect(((await post.json()) as { code: string }).code).toBe("activation-refused");
  });

  it("stays loud on a malformed empty-reasons verdict", async () => {
    const assembled = await assembleWorker(fixtureArtifact(), stubAsm(), stubDeps(), {
      active: false,
      reasons: [],
    });
    const response = await assembled.fetch(new Request("http://localhost/"));
    expect(response.status).toBe(500);
    expect(((await response.json()) as { code: string }).code).toBe("activation-refused");
  });

  it("serves normally on an active verdict", async () => {
    const assembled = await assembleWorker(fixtureArtifact(), stubAsm(), stubDeps(), { active: true });
    const response = await assembled.fetch(new Request("http://localhost/nope"));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("not_found");
  });

  it("still throws programmer bugs (bad deps) before the verdict gate", async () => {
    await expect(
      assembleWorker(fixtureArtifact(), stubAsm(), { store: null as never, identityStore: {} }, FAILED),
    ).rejects.toThrow(/deps\.store is required/);
  });
});
