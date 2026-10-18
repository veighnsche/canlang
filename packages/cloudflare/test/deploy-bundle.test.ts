import { createHash } from "node:crypto";
import { encode } from "@jridgewell/sourcemap-codec";
import { lookup } from "../src/runtime/sourcemap.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActivationVerdict, CompileArtifact, SourceMap } from "@canlang/contracts";
import {
  ARTIFACT_MODULE,
  DEPLOY_MAIN_MODULE,
  HTTP_OPERATIONS_MODULE,
  HTTP_ASSETS_MODULE,
  generatedStyleResources,
  MCP_HANDLER_MODULE,
  WORKER_MAIN_MISSING,
  assertLinksResolve,
  assertWorkerdLoadable,
  buildDeployBundle,
  buildDeployBundleWithAssets,
  deployBundleMain,
  refuseModuleFrontendIssues,
  writeDeployBundle,
  type ModuleSyntaxFacts,
} from "../src/deploy/bundle.js";
import { PINNED_COMPATIBILITY_DATE } from "../src/cli/artifact-defaults.js";
import { startLocalDev } from "../src/runtime/native-preview.test-support.js";
import { rewriteModuleImports, scanModuleImports } from "../src/deploy/module-imports.js";
import { resolveProducerFile } from "../src/deploy/producer-files.js";
// Cross-package journey import: interfaces DIST (never src), per the
// mcp-route.test.ts precedent. Proves bake parity with the real rule.
import { catalogFromArtifactOperations } from "@canlang/interfaces/http/operations";

const repoRoot = resolve(new URL(".", import.meta.url).pathname, "..", "..", "..");

const EMPTY_MAP: SourceMap = {
  version: 3,
  file: "app.can",
  sources: [],
  sourcesContent: [],
  names: [],
  mappings: "",
};

const ACTIVE_VERDICT: ActivationVerdict = { active: true };

/** Minimal valid artifact: one nested module (exercises relative rewrite) + util. */
function testArtifact(): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: "0".repeat(64) }],
    modules: [
      {
        path: "app/main.js",
        js: [
          `import { renderPage } from "@canlang/ui";`,
          `import { ok } from "@canlang/stdlib";`,
          `import { util } from "./util.js";`,
          `export const descriptor = { renderPage, ok, util };`,
          "",
        ].join("\n"),
        map: { ...EMPTY_MAP },
      },
      {
        path: "app/util.js",
        js: `export function util() { return "util"; }\n`,
        map: { ...EMPTY_MAP },
      },
    ],
    callables: [],
    operations: [],
    pages: [{ owner: "test", path: "/main", module: "app/main.js", export: "descriptor" }],
    requires: [],
    tests: [],
  };
}

/**
 * Fake worker dist: stands in for `dist/worker/` so most bundle tests never
 * depend on the sibling packet. The stub exercises the real seams: a
 * relative sibling import plus the `./mcp-handler.js` bundle convention.
 * The pinned `runtime/` set always comes from the REAL dist (its exact
 * workerd-safe closure is what the scanner proof must cover).
 */
function fakeWorkerDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "can-deploy-bundle-"));
  writeFileSync(
    join(dir, "main.js"),
    [
      `import { createMcpHandler } from "./mcp-handler.js";`,
      `import { helper } from "./helper.js";`,
      `export default {`,
      `  async fetch() {`,
      `    return Response.json({ mcp: typeof createMcpHandler, helper: helper() });`,
      `  },`,
      `};`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "helper.js"), `export function helper() { return "from-helper"; }\n`);
  // Pre-existing skew (already at base 1527ed1e8): the pinned real runtime
  // set includes resource-dispatch.js importing ../worker/assembly.js, which
  // this stub predates. Keep the fixture's declared stub scope: a seam-only
  // module so link resolution covers the edge without depending on the
  // sibling worker packet's transitive closure.
  writeFileSync(join(dir, "assembly.js"), `export function assembleDispatchCommands() { return []; }\n`);
  return dir;
}

/** Runtime mapper fixture only; every staged Files producer remains genuine. */
function filesFinalizerRuntimeFixture(): string {
  const runtime = dirname(resolveProducerFile("@canlang/cloudflare/runtime/invoke", "bun run --filter @canlang/cloudflare build"));
  const fixture = mkdtempSync(join(tmpdir(), "can-files-runtime-map-"));
  for (const entry of readdirSync(runtime).filter(name => name.endsWith(".js"))) {
    let js = readFileSync(join(runtime, entry), "utf8");
    if (entry === "invoke.js") js += '\nimport { readFinalizedFileObservation as filesClosureReader } from "@canlang/files/finalize";\nexport { filesClosureReader };\nconst FILES_FINALIZER_MAP_FIXTURE = "@canlang/files/finalize";\n';
    writeFileSync(join(fixture, entry), js);
  }
  return fixture;
}

describe("deploy bundle (P-B)", () => {
  it("ships the runtime mapper's ESM codec without host import tooling", () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const key = "vendor/sourcemap-codec/sourcemap-codec.js";
    expect(bundle.modules["runtime/sourcemap.js"]).toContain(`"../${key}"`);
    expect(bundle.modules[key]).toContain("export {");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/values/index.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/state/mutation/index.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/state/mutation/crud.js");
    expect(bundle.modules["runtime/invoke.js"]).not.toContain("mutation/index.js/crud");
    expect(bundle.modules["vendor/state/mutation/crud.js"]).toContain("generatedCrudExecuteOwnerSession");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/work/kernel/dispatch-staging.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/work/kernel/schedule-staging.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/work/kernel/occurrence-staging.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/work/receipt/index.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("./receipt-staging.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("./bound-judgment.js");
    expect(bundle.modules["runtime/bound-judgment.js"]).toContain("../vendor/services/judgments/specification.js");
    expect(Object.keys(bundle.modules).filter(name => name.startsWith("vendor/services/"))).toEqual([
      "vendor/services/judgments/specification.js",
    ]);
    expect(Object.keys(bundle.modules).filter(name => name.startsWith("vendor/noble-hashes/"))).toEqual([
      "vendor/noble-hashes/_md.js", "vendor/noble-hashes/_u64.js",
      "vendor/noble-hashes/sha2.js", "vendor/noble-hashes/utils.js",
    ]);
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/ui/index.js");
    expect(bundle.modules["vendor/values/schema.js"]).toContain("normalizeSchema");
    expect(bundle.modules["vendor/values/schema.js"]).toContain("validateOperationInput");
    expect(Object.keys(bundle.modules).filter(name => name.startsWith("vendor/work/"))).toEqual([
      "vendor/work/dispatch/index.js",
      "vendor/work/intent/staging.js",
      "vendor/work/kernel/arguments.js",
      "vendor/work/kernel/callback-diagnostics.js",
      "vendor/work/kernel/committed-model-source.js",
      "vendor/work/kernel/dispatch-staging.js",
      "vendor/work/kernel/file-reference-inventory.js",
      "vendor/work/kernel/handler-occurrence.js",
      "vendor/work/kernel/occurrence-staging.js",
      "vendor/work/kernel/opaque-file-resolver.js",
      "vendor/work/kernel/schedule-staging.js",
      "vendor/work/kernel/staging-support.js",
      "vendor/work/kernel/standard-completion-source.js",
      "vendor/work/kernel/tables.js",
      "vendor/work/observation/association.js",
      "vendor/work/observation/observation.js",
      "vendor/work/receipt/index.js",
    ]);
    expect(bundle.modules["vendor/work/kernel/dispatch-staging.js"]).toContain("stageCanonicalSend");
    expect(bundle.modules["vendor/work/kernel/schedule-staging.js"]).toContain("workSchedulePutCommand");
    expect(bundle.modules["vendor/work/kernel/schedule-staging.js"]).toContain("workScheduleCancelCommand");
    expect(bundle.modules["vendor/work/kernel/schedule-staging.js"]).toContain("stageDueSchedule");
    expect(bundle.modules["vendor/work/kernel/occurrence-staging.js"]).toContain("workOccurrencePutReceiptCommand");
    expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
    expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
    expect(bundle.modules["runtime/native-membership.js"]).toContain("../vendor/work/dispatch/index.js");
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/work/dispatch/index.js");
    expect(bundle.modules["vendor/work/dispatch/index.js"]).toContain("../../state/index.js");
    const missingDispatch = { ...bundle.modules };
    delete missingDispatch["vendor/work/dispatch/index.js"];
    expect(() => assertLinksResolve(missingDispatch)).toThrow(/(?:invoke|native-membership)\.js.*dispatch\/index\.js.*no such staged module/);
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/files/bridge.js");
    expect(bundle.modules["vendor/files/bridge.js"]).toBe(readFileSync(resolveProducerFile("@canlang/files/bridge", "bun run --filter @canlang/files build"), "utf8"));
    const missingJudgmentHash = { ...bundle.modules };
    delete missingJudgmentHash["vendor/noble-hashes/_u64.js"];
    expect(() => assertLinksResolve(missingJudgmentHash)).toThrow("no such staged module");
    expect(Object.keys(bundle.modules).some((name) => /(?:es-module-lexer|magic-string|trace-mapping|resolve-uri)/.test(name))).toBe(false);
    const missingCodec = { ...bundle.modules };
    delete missingCodec[key];
    expect(() => assertLinksResolve(missingCodec)).toThrow(
      `deploy bundle: module "runtime/sourcemap.js" imports "../${key}" (resolves to "${key}"): no such staged module`,
    );
  });

  it("never vendors TEST-ONLY bridges (node-only helpers stay out of workerd)", () => {
    // C4: state's work-loader.js bridges (T25/F5 join proofs) emit
    // beside sources under non-test names with node:url/node:path
    // imports and zero non-test importers. The vendor walk must skip
    // them exactly like *.test.js — otherwise every bundle build
    // fails the workerd link check.
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    expect(bundle.modules["vendor/state/fanout/work-loader.js"]).toBeUndefined();
    expect(bundle.modules["vendor/state/receipt/work-loader.js"]).toBeUndefined();
    expect(bundle.modules["vendor/state/storage/history-bounded-fixtures.js"]).toBeUndefined();
    expect(bundle.modules["vendor/state/query/history.js"]).toContain("queryRecordHistoryForViewer");
    expect(bundle.modules["vendor/state/storage/sqlite-codecs.js"]).toContain("toBoundedHistory");
    expect(Object.keys(bundle.modules).some((key) => key.endsWith("work-loader.js"))).toBe(false);
  });

  it("stages derived-inputs.js baked by the real interfaces derivation", () => {
    // C1: the bake runs the REAL rule at deploy time (no parallel
    // engine); the worker serves the bytes verbatim. Parity is proved
    // by deriving independently and comparing.
    const withOp = testArtifact();
    withOp.operations = [
      {
        name: "test.Todo.create",
        kind: "create",
        description: "Create a todo.",
        inputs: {
          fields: [{ name: "title", field: { kind: "string" }, required: true }],
        },
      },
    ];
    const bundle = buildDeployBundle(withOp, {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const staged = bundle.modules["worker/derived-inputs.js"] as string;
    expect(staged.startsWith("export const derivedInputs = ")).toBe(true);
    const payload = JSON.parse(staged.replace(/^export const derivedInputs = /, "").replace(/;\n$/, ""));
    const real = catalogFromArtifactOperations(withOp);
    expect(payload).toEqual({ "test.Todo.create": real.derivedFor("test.Todo.create") });

    const bare = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    expect(bare.modules["worker/derived-inputs.js"]).toBe("export const derivedInputs = {};\n");
  });

  it("stages the dist-mirroring layout: worker + runtime + artifact + vendor + handler", () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    expect(bundle.mainModule).toBe(DEPLOY_MAIN_MODULE);
    expect(bundle.modules["worker/main.js"]).toContain("mcp-handler.js");
    expect(bundle.modules["worker/helper.js"]).toContain("from-helper");
    expect(bundle.modules[MCP_HANDLER_MODULE]).toBeDefined();
    expect(bundle.modules[ARTIFACT_MODULE]).toBeDefined();
    for (const name of [
      "runtime/context.js",
      "runtime/stdlib.js",
      "runtime/native-membership.js",
      "runtime/native-read-boolean.js",
      "runtime/native-value-schema.js",
      "runtime/generation-callback-origin.js",
      "runtime/invoke.js",
      "runtime/sourcemap.js",
      "runtime/mcp-registry.js",
      "runtime/env-assembly.js",
      "runtime/page-cursor.js",
      "runtime/grant-route.js",
    ]) {
      expect(bundle.modules[name], `pinned ${name} must be staged`).toBeDefined();
    }
    // The node:ful runtime files MUST NOT ship.
    for (const name of ["runtime/modules.js", "runtime/executors.js"]) {
      expect(bundle.modules[name], `${name} must stay out`).toBeUndefined();
    }
    expect(bundle.modules["app/main.js"]).toBeDefined();
    expect(bundle.modules["app/util.js"]).toBeDefined();
    expect(bundle.modules["vendor/ui/index.js"]).toBeDefined();
    expect(bundle.modules["vendor/stdlib/index.js"]).toBeDefined();
    expect(bundle.modules["vendor/identity/index.js"]).toBeDefined();
    expect(bundle.modules["vendor/identity/sessions/comparison-node.js"]).toBeUndefined();
    expect(bundle.modules["vendor/identity/sessions/comparison-worker.js"]).toBeDefined();
    expect(bundle.modules["vendor/identity/sessions/comparison.js"]).toContain("./comparison-worker.js");
    for (const key of ["vendor/cookie/index.js", "vendor/scure-base/index.js", "vendor/csv-parse/sync.js"]) {
      expect(bundle.modules[key], `owning browser dependency ${key}`).toBeDefined();
    }
    expect(bundle.modules["vendor/contracts/presentation.js"]).toBeDefined();
    expect(bundle.modules["contracts/src/presentation.js"]).toBeUndefined();
    expect(bundle.modules["vendor/contracts/presentation.js"]).toBeDefined();
  });

  it("emits no node file-URLs and no CJS: the whole map is workerd-loadable ESM", () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    // Staged artifact content carries no file-URL at all (the M3 hazard:
    // `assembleModules` emits node file-URLs; this counterpart must not).
    for (const name of ["app/main.js", "app/util.js", ARTIFACT_MODULE]) {
      expect(bundle.modules[name], `${name} must not contain a file-URL`).not.toContain("file://");
    }
    // Built dists may carry QUOTED `file://` tokens (SDK zod checks, the
    // invoke.js stack-trace decoder) — never imports. The scanner, not a
    // substring, is the contract over the whole map.
    expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
    expect(bundle.modules[MCP_HANDLER_MODULE]).toContain("file://");
  });

  it("rewrites generated imports to their defining runtime and vendor specifiers", () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const main = bundle.modules["app/main.js"] as string;
    expect(main).toContain(`from "../vendor/ui/index.js"`);
    expect(main).toContain(`from "../runtime/stdlib.js"`);
    expect(main).toContain(`from "./util.js"`);
    expect(main).not.toContain("@canlang/ui");
    expect(main).not.toContain("@canlang/stdlib");
  });

  it("MCP bundle carries the handler markers incl. createHandler + its own IdentityError copy", () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const handler = bundle.modules[MCP_HANDLER_MODULE] as string;
    for (const marker of [
      "createMcpHandler",
      "createHandler",
      "createArtifactRegistry",
      "createArtifactCatalog",
      "IdentityError",
    ]) {
      expect(handler, `MCP bundle must contain ${marker}`).toContain(marker);
    }
    // Real bundle, not a stub: the SDK + interface closure is hundreds of KB.
    expect(handler.length).toBeGreaterThan(100_000);
    expect(bundle.mcpBundleBytes).toBe(handler.length);
  });

  it("HTTP bundle carries the op-chain markers incl. its own IdentityError copy", async () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const ops = bundle.modules[HTTP_OPERATIONS_MODULE] as string;
    expect(bundle.modules["runtime/export-downloads.js"]).toContain("createD1ExportDownloadStore");
    for (const marker of [
      "handleOperationRequest",
      "handleCsvRequest",
      "handleExportRequest",
      "canonicalJson",
      "handlePageRequest",
      "handlePagePreferencePost",
      "receiverFromIdentity",
      "parseJsonBody",
      "JSON_BODY_MAX_BYTES",
      "IdentityError",
    ]) {
      expect(ops, `HTTP bundle must contain ${marker}`).toContain(marker);
    }
    // A body occurrence alone cannot satisfy the runtime's named import.
    expect(ops).toMatch(/\bexport\s*\{[^}]*\breceiverFromIdentity\b[^}]*\}/s);
    // Real bundle, not a stub: the op chain + identity closure is
    // tens of KB (no MCP SDK weight).
    expect(ops.length).toBeGreaterThan(10_000);
    expect(bundle.httpOperationsBytes).toBe(ops.length);
    expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
    expect(() => assertWorkerdLoadable({ [HTTP_OPERATIONS_MODULE]: ops })).not.toThrow();
    // Consume the actual installed named exports and grant-route import edge.
    // Import success alone would miss a stale parser or cap implementation.
    const outDir = mkdtempSync(join(tmpdir(), "can-grant-http-bundle-"));
    try {
      writeDeployBundle(bundle, outDir);
      const http = await import(pathToFileURL(join(outDir, HTTP_OPERATIONS_MODULE)).href);
      const grant = await import(pathToFileURL(join(outDir, "runtime/grant-route.js")).href);
      expect(http.JSON_BODY_MAX_BYTES).toBe(1_048_576);
      expect(http.canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
      expect(typeof http.handleExportRequest).toBe("function");
      expect(await http.parseJsonBody(new Request("https://test.invalid", {
        method: "POST", body: '{"client_id":"installed"}',
      }))).toEqual({ client_id: "installed" });
      await expect(http.parseJsonBody(new Request("https://test.invalid", {
        method: "POST", body: "{invalid",
      }))).rejects.toMatchObject({ name: "IdentityError", code: "validation" });
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(http.JSON_BODY_MAX_BYTES + 1)); },
        cancel() { cancelled = true; },
      });
      await expect(http.parseJsonBody(new Request("https://test.invalid", {
        method: "POST", body, duplex: "half",
      } as RequestInit))).rejects.toMatchObject({ name: "IdentityError", code: "limit" });
      expect(cancelled).toBe(true);
      expect((await grant.handleMcpGrant(new Request("https://test.invalid/mcp/grants", {
        method: "POST", body: '{"client_id":"installed"}',
      }), { identityStore: {} })).status).toBe(401);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("stages artifact.js with the artifact, portable module URLs, and the verdict", () => {
    const verdict: ActivationVerdict = {
      active: false,
      reasons: [{ code: "activation-incomplete", detail: "gate 4 unchecked" }],
    };
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict,
    });
    const source = bundle.modules[ARTIFACT_MODULE] as string;
    expect(source).toContain("export const artifact = ");
    expect(source).toContain("export const modules = ");
    expect(source).toContain("export const verdict = ");
    // Portable URLs resolve against worker/assembly.js (never file-URLs).
    expect(source).toContain(`"app/main.js":"../app/main.js"`);
    expect(source).toContain(`"app/util.js":"../app/util.js"`);
    expect(source).toContain(`"entryUrl":"../app/main.js"`);
    expect(source).not.toContain("file://");
    // The verdict stages verbatim.
    expect(source).toContain(`"active":false`);
    expect(source).toContain("activation-incomplete");
  });

  it("stages derived map views without changing artifact or verdict identity", () => {
    const artifact = testArtifact();
    const js = 'import { ok } from "@canlang/stdlib"; export function boom(){throw new Error("mapped");}\n';
    const column = js.indexOf("new Error");
    const map: SourceMap = { ...EMPTY_MAP, sources: ["original.can"], sourcesContent: ["original"], mappings: encode([[[0, 0, 0, 0], [column, 0, 23, 8], [column + 9, 0, 24, 11]]]) };
    artifact.modules = [{ path: "app/main.js", js, map }];
    artifact.pages = [];
    const original = JSON.stringify(artifact);
    const bundle = buildDeployBundle(artifact, { workerDistDir: fakeWorkerDist(), verdict: ACTIVE_VERDICT });
    const staged = bundle.modules[ARTIFACT_MODULE]!;
    const artifactLine = staged.split("\n").find((line) => line.startsWith("export const artifact = "))!;
    const modulesLine = staged.split("\n").find((line) => line.startsWith("export const modules = "))!;
    const embedded = JSON.parse(artifactLine.slice("export const artifact = ".length, -1));
    const asm = JSON.parse(modulesLine.slice("export const modules = ".length, -1));
    expect(JSON.stringify(embedded)).toBe(original);
    expect(JSON.stringify(artifact)).toBe(original);
    const rewritten = bundle.modules["app/main.js"]!;
    expect(lookup(asm.sourceMaps["app/main.js"], 1, rewritten.indexOf("new Error"))).toEqual({ source: "original.can", line: 24, column: 9 });
    const inline = rewritten.match(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([^\n]+)/)![1]!;
    expect(JSON.parse(Buffer.from(inline, "base64").toString("utf8"))).toEqual(asm.sourceMaps["app/main.js"]);
    expect(Object.keys(bundle.modules).some((key) => /module-imports|module-maps|magic-string|remapping|trace-mapping|lexer/.test(key))).toBe(false);
  });

  it("is deterministic: same inputs yield identical bytes and sha", () => {
    const workerDistDir = fakeWorkerDist();
    const first = buildDeployBundle(testArtifact(), { repoRoot, workerDistDir, verdict: ACTIVE_VERDICT });
    const second = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir,
      verdict: ACTIVE_VERDICT,
    });
    expect(second.sha256).toBe(first.sha256);
    expect(second.modules).toEqual(first.modules);
  });

  it("missing worker main fails loud with a code + the build fix", () => {
    const empty = mkdtempSync(join(tmpdir(), "can-deploy-bundle-empty-"));
    let caught: unknown;
    try {
      buildDeployBundle(testArtifact(), {
        repoRoot,
        workerDistDir: empty,
        verdict: ACTIVE_VERDICT,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("@canlang/cloudflare/worker/main");
    expect((caught as Error).message).toContain("bun run --filter @canlang/cloudflare build");
    expect((caught as { code?: unknown }).code).toBe(WORKER_MAIN_MISSING);
  });

  it("missing pinned runtime sibling fails loud (never silently degraded)", () => {
    const emptyRuntime = mkdtempSync(join(tmpdir(), "can-deploy-bundle-nort-"));
    expect(() =>
      buildDeployBundle(testArtifact(), {
        repoRoot,
        workerDistDir: fakeWorkerDist(),
        runtimeDistDir: emptyRuntime,
        verdict: ACTIVE_VERDICT,
      }),
    ).toThrow(/runtime sibling context\.js not built.*bun run build/);
  });

  it("page/callable references to unknown modules fail loud", () => {
    const badPage = testArtifact();
    badPage.pages = [{ owner: "test", path: "/bad", module: "nope.js", export: "descriptor" }];
    expect(() =>
      buildDeployBundle(badPage, {
        repoRoot,
        workerDistDir: fakeWorkerDist(),
        verdict: ACTIVE_VERDICT,
      }),
    ).toThrow(/page \/bad.*nope\.js/);
    const badCallable = testArtifact();
    badCallable.callables = [
      {
        id: "x.y",
        kind: "handler",
        module: "ghost.js",
        export: "y",
        member: ["y"],
      },
    ];
    expect(() =>
      buildDeployBundle(badCallable, {
        repoRoot,
        workerDistDir: fakeWorkerDist(),
        verdict: ACTIVE_VERDICT,
      }),
    ).toThrow(/callable x\.y.*ghost\.js/);
  });

  it("unresolvable module imports fail loud (never silently staged)", () => {
    const bad = testArtifact();
    bad.modules[0] = {
      path: "app/main.js",
      js: `import fs from "node:fs";\nexport const x = fs;\n`,
      map: { ...EMPTY_MAP },
    };
    expect(() =>
      buildDeployBundle(bad, { repoRoot, workerDistDir: fakeWorkerDist(), verdict: ACTIVE_VERDICT }),
    ).toThrow(/unresolvable import "node:fs"/);
    const badRelative = testArtifact();
    badRelative.modules[0] = {
      path: "app/main.js",
      js: `import { z } from "./missing.js";\nexport const x = z;\n`,
      map: { ...EMPTY_MAP },
    };
    expect(() =>
      buildDeployBundle(badRelative, {
        repoRoot,
        workerDistDir: fakeWorkerDist(),
        verdict: ACTIVE_VERDICT,
      }),
    ).toThrow(/no such artifact module/);
  });

  it("refuses artifact namespace collisions before platform staging or producer builds", () => {
    const emptyDist = mkdtempSync(join(tmpdir(), "can-deploy-bundle-collision-"));
    try {
      const options = { repoRoot, workerDistDir: emptyDist, runtimeDistDir: emptyDist, verdict: ACTIVE_VERDICT };
      for (const path of [
        "worker/main.js", "app/../worker/./main.js", "runtime/context.js",
        "app/../vendor/ui/index.js", "bundle.json", "app/../bundle.mixed.json",
        "bundle.resources.json", "bundle.json/child.js",
      ]) {
        const artifact = testArtifact();
        artifact.modules.push({ path, js: "export const collision = true;\n", map: { ...EMPTY_MAP } });
        expect(() => buildDeployBundle(artifact, options)).toThrow(/artifact module .* reserves (platform directory|writer manifest path)/);
      }
      for (const path of ["app/util.js", "app/./util.js"]) {
        const artifact = testArtifact();
        artifact.modules.push({ path, js: "export const collision = true;\n", map: { ...EMPTY_MAP } });
        expect(() => buildDeployBundle(artifact, options)).toThrow(/artifact module .* aliases "app\/util.js" after normalization/);
      }
    } finally {
      rmSync(emptyDist, { recursive: true, force: true });
    }
  });

  it("writeDeployBundle writes deterministic files; main path is the deploy main", () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const outDir = join(mkdtempSync(join(tmpdir(), "can-deploy-out-")), "teamtasks.deploy");
    const written = writeDeployBundle(bundle, outDir);
    expect(written.dir).toBe(outDir);
    expect(written.mainFile).toBe(join(outDir, DEPLOY_MAIN_MODULE));
    expect(written.files).toEqual([...written.files].sort());
    expect(written.files).toContain(written.mainFile);
    expect(readFileSync(written.mainFile, "utf8")).toBe(bundle.modules[DEPLOY_MAIN_MODULE]);
    expect(readFileSync(join(outDir, MCP_HANDLER_MODULE), "utf8")).toBe(
      bundle.modules[MCP_HANDLER_MODULE],
    );
    expect(readFileSync(join(outDir, ARTIFACT_MODULE), "utf8")).toBe(bundle.modules[ARTIFACT_MODULE]);
    expect(deployBundleMain("teamtasks")).toBe("./teamtasks.deploy/worker/main.js");
    // Second write is byte-identical.
    const outDir2 = join(mkdtempSync(join(tmpdir(), "can-deploy-out-")), "teamtasks.deploy");
    const written2 = writeDeployBundle(bundle, outDir2);
    expect(written2.files.map((file) => readFileSync(file, "utf8"))).toEqual(
      written.files.map((file) => readFileSync(file, "utf8")),
    );
  });

  it("boots in workerd: staged main + real MCP bundle serve over dispatch", async () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const dev = await startLocalDev({
      workerName: "deploy-bundle",
      compatibilityDate: "2026-07-15",
      mainModule: bundle.mainModule,
      modules: bundle.modules,
    });
    try {
      const response = await dev.dispatch("/");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ mcp: "function", helper: "from-helper" });
    } finally {
      await dev.dispose();
    }
  }, 120000);

  it("boots the REAL P-A entry from the bundle: binding gate answers missing-binding", async () => {
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    const workerDist = resolve(repoRoot, "packages/cloudflare/dist/worker");
    const emittedUnitTests = readdirSync(workerDist).filter(entry => entry.endsWith(".test.js"));
    for (const entry of emittedUnitTests) expect(bundle.modules[`worker/${entry}`]).toBeUndefined();
    expect(bundle.modules["worker/main.js"]).toContain("createMainFetch");
    expect(bundle.modules["worker/entry.js"]).toContain("createWorkerApp");
    expect(bundle.modules["worker/assembly.js"]).toContain("assembleWorker");
    expect(bundle.modules["runtime/env-assembly.js"]).toContain("buildProductionDeps");
    expect(bundle.modules["vendor/state/storage/owner-router.js"]).toContain("createD1OwnerRouter");
    const dev = await startLocalDev({
      workerName: "deploy-join",
      compatibilityDate: "2026-07-15",
      mainModule: bundle.mainModule,
      modules: bundle.modules,
    });
    try {
      // No env bindings: the REAL createWorkerApp gate (loaded from the
      // staged worker/entry.js by the staged worker/main.js) refuses 500
      // naming DB — the P-A/P-B join loads end to end.
      const response = await dev.dispatch("/");
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ code: "missing-binding", binding: "DB" });
    } finally {
      await dev.dispose();
    }
  }, 120000);
});

describe("producer import rewrite + link check (P-C/P-B skew class)", () => {
  it("stages the state tree and rewrites pinned-runtime producer imports to vendor keys", async () => {
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    expect(bundle.modules["vendor/state/storage/d1.js"]).toContain("createD1Storage");
    expect(bundle.modules["vendor/identity/index.js"]).toContain("./authentication/grants.js");
    const envAssembly = bundle.modules["runtime/env-assembly.js"] ?? "";
    expect(envAssembly).toContain("../vendor/state/storage/d1.js");
    expect(envAssembly).toContain("../vendor/identity/index.js");
    expect(envAssembly).not.toContain("../../../state/dist");
    const grantRoute = bundle.modules["runtime/grant-route.js"] ?? "";
    expect(grantRoute).toContain("../vendor/identity/index.js");
    for (const [path, js] of [["runtime/env-assembly.js", envAssembly], ["runtime/grant-route.js", grantRoute]]) {
      const specifiers = scanModuleImports(js!, path!).map(record => record.specifier);
      expect(specifiers.filter(specifier => specifier === "@canlang/identity" || specifier?.startsWith("@canlang/identity/"))).toEqual([]);
      // Computed imports consume this binding; diagnostic prose is not an edge.
      expect(js).toMatch(/const IDENTITY_SPECIFIER = ["']\.\.\/vendor\/identity\/index\.js["'];/);
    }
    expect(bundle.modules["vendor/values/index.js"]).toContain("VALUES_CONTRACT_VERSION");
    const stdlib = bundle.modules["vendor/stdlib/index.js"] ?? "";
    expect(stdlib).toContain("../values/index.js");
    expect(stdlib).not.toMatch(/from\s+["']@canlang\/values["']/);
    const leafFile = resolveProducerFile("@canlang/state/receipt/authored-delivery", "bun run --filter @canlang/state build");
    expect(leafFile.replaceAll("\\", "/")).toMatch(/\/dist\/src\/receipt\/authored-delivery\.js$/);
    const runtimeFile = resolveProducerFile("@canlang/cloudflare/runtime/invoke", "bun run --filter @canlang/cloudflare build");
    const [leaf, compatibility] = await Promise.all([
      import(pathToFileURL(leafFile).href),
      import(pathToFileURL(join(dirname(runtimeFile), "receipt-staging.js")).href),
    ]);
    expect(typeof leaf.stageAuthoredDelivery).toBe("function");
    expect(compatibility.stageAuthoredDelivery).toBe(leaf.stageAuthoredDelivery);
    expect(Object.keys(leaf)).toEqual(["stageAuthoredDelivery"]);
    const leafKey = "vendor/state/receipt/authored-delivery.js";
    const stagedLeaf = bundle.modules[leafKey]!;
    expect(stagedLeaf).toContain("export async function stageAuthoredDelivery(");
    // Restore only relocated import specifiers to compare the entire genuine
    // owning emitted body, rather than accepting a substitute implementation.
    const restoredLeaf = rewriteModuleImports(stagedLeaf, leafKey, specifier =>
      specifier === "../../contracts/index.js" ? "@canlang/contracts"
        : specifier === "../../values/index.js" ? "@canlang/values" : specifier,
    { profile: "trusted-producer" }).js;
    expect(restoredLeaf).toBe(readFileSync(leafFile, "utf8"));
    const compatKey = "runtime/receipt-staging.js";
    expect(scanModuleImports(bundle.modules[compatKey]!, compatKey).map(record => record.specifier))
      .toEqual(["../vendor/state/receipt/authored-delivery.js"]);
    expect(bundle.modules[compatKey]).toContain("stageAuthoredDelivery");
    expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
    expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
    const missingLeaf = { ...bundle.modules };
    delete missingLeaf[leafKey];
    expect(() => assertLinksResolve(missingLeaf))
      .toThrow(/receipt-staging\.js.*authored-delivery\.js.*no such staged module/);
  });

  it("assertLinksResolve refuses dangling relative and bare imports", () => {
    expect(() =>
      assertLinksResolve({ "a.js": `import x from "./missing.js";\n` }),
    ).toThrow(/a\.js.*missing\.js.*no such staged module/);
    expect(() =>
      assertLinksResolve({ "a.js": `import x from "@canlang/identity";\n` }),
    ).toThrow(/a\.js.*bare import.*@canlang\/identity/);
    expect(() =>
      assertLinksResolve({
        "a.js": `import x from "./b.js";\n`,
        "b.js": `export const x = 1;\n`,
      }),
    ).not.toThrow();
  });

  it("assertLinksResolve sees brace imports and re-exports (no blind forms)", () => {
    // Each of these slipped through the first back-scan (it stopped at
    // braces): brace import, minified brace, bare re-export, dangling
    // star re-export. Controls (namespace, default-only, side-effect,
    // dynamic-literal) stay covered by the suite around this test.
    expect(() =>
      assertLinksResolve({ "a.js": `import { x } from "@canlang/identity";\n` }),
    ).toThrow(/bare import/);
    expect(() =>
      assertLinksResolve({ "a.js": `import{x}from"@canlang/identity";\n` }),
    ).toThrow(/bare import/);
    expect(() =>
      assertLinksResolve({ "a.js": `export { x } from "@canlang/identity";\n` }),
    ).toThrow(/bare import/);
    expect(() =>
      assertLinksResolve({ "a.js": `export * from "./missing.js";\n` }),
    ).toThrow(/no such staged module/);
    expect(() =>
      assertLinksResolve({
        "a.js": `import { x } from "./b.js";\nexport * from "./b.js";\n`,
        "b.js": `export const x = 1;\n`,
      }),
    ).not.toThrow();
  });

  it("boots the bundle with a DB: active verdict serves /mcp auth seam (401), inactive refuses honestly", async () => {
    // testArtifact's descriptor ({renderPage, ok, util}) is enough for
    // staging assertions but not full assembly, which requires
    // owner+path on every page descriptor and a defining app identity.
    const artifact = testArtifact();
    const main = artifact.modules[0];
    if (main !== undefined) {
      // Actual runtime exports and defining app identity: this module is
      // imported in workerd, so every import and assembly claim resolves.
      main.js = [
        `import { renderPage } from "@canlang/ui";`,
        `import { abs } from "@canlang/stdlib";`,
        `import { util } from "./util.js";`,
        `export const appDefinition = { id: "test" };`,
        `export const descriptor = { owner: "test", path: "/main", admit: async () => ({ ok: true }), render: async () => ({ status: 200 }), renderPage, abs, util };`,
        "",
      ].join("\n");
    }
    const boot = async (verdict: ActivationVerdict) => {
      const bundle = buildDeployBundle(artifact, { repoRoot, verdict });
      return startLocalDev({
        workerName: "deploy-join-routes",
        compatibilityDate: "2026-07-15",
        mainModule: bundle.mainModule,
        modules: bundle.modules,
        d1Databases: [{ binding: "DB", id: "deploy-join-routes" }],
      });
    };
    const post = (path: string) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const active = await boot(ACTIVE_VERDICT);
    try {
      // Route live, real handler + real D1 deps, no grant: safe 401.
      const mcp = await active.dispatch("/mcp", post("/mcp"));
      expect(mcp.status, await mcp.text()).toBe(401);
      const grants = await active.dispatch("/mcp/grants", post("/mcp/grants"));
      expect(grants.status, await grants.text()).toBe(401);
    } finally {
      await active.dispose();
    }
    const refused = await boot({
      active: false,
      reasons: [{ code: "activation-incomplete", detail: "forced inactive" }],
    });
    try {
      const res = await refused.dispatch("/mcp", post("/mcp"));
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        code: "activation-refused",
        reason: "activation-incomplete",
        detail: "forced inactive",
      });
    } finally {
      await refused.dispose();
    }
  }, 180000);

  it("staged main discovers operations for a granted member (member permissions adopted)", async () => {
    // Full chain through the staged production main: real D1 deps,
    // real grant mint, real member permissions (NOT the deny-closed
    // interim — empty discovery would fail this test).
    const artifact = testArtifact();
    const bootMain = artifact.modules[0];
    if (bootMain !== undefined) {
      // Same assemblable module as the boot test above: real runtime
      // exports + app identity/owner/path/admit/render in workerd.
      bootMain.js = [
        `import { renderPage } from "@canlang/ui";`,
        `import { abs } from "@canlang/stdlib";`,
        `import { util } from "./util.js";`,
        `export const appDefinition = { id: "test" };`,
        `export const descriptor = { owner: "test", path: "/main", admit: async () => ({ ok: true }), render: async () => ({ status: 200 }), renderPage, abs, util };`,
        "",
      ].join("\n");
    }
    artifact.operations = [
      {
        name: "test.Todo.create",
        kind: "create",
        description: "Create a todo.",
        inputs: {
          fields: [{ name: "title", field: { kind: "string" }, required: true }],
        },
      },
    ];
    const bundle = buildDeployBundle(artifact, { repoRoot, verdict: ACTIVE_VERDICT });
    expect(bundle.modules["runtime/mcp-permissions.js"]).toContain("createMemberMcpPermissions");
    const dev = await startLocalDev({
      workerName: "deploy-join-grant",
      compatibilityDate: "2026-07-15",
      mainModule: bundle.mainModule,
      modules: bundle.modules,
      d1Databases: [{ binding: "DB", id: "deploy-join-grant" }],
    });
    try {
      // Trigger worker-side DDL ensures (auth fails first: no grant yet).
      const unauth = await dev.dispatch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(unauth.status, await unauth.text()).toBe(401);
      // Seed identity + mint a grant against the SAME D1.
      const { createD1IdentityStore } = await import("@canlang/identity");
      const { issueMcpGrant } = await import("@canlang/identity");
      const db = await dev.getD1Database("DB");
      const store = createD1IdentityStore(db);
      const user = await store.createUser({
        email: "member@test.example",
        password_hash: "test-hash-opaque",
        email_verified: true,
      });
      const team = await store.createTeam({});
      await store.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
      const issued = await issueMcpGrant(store, {
        user_id: user.user_id,
        team_id: team.team_id,
        client_id: "boot-test",
      });
      const listed = await dev.dispatch("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${issued.token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(listed.status).toBe(200);
      const body = (await listed.json()) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(body.result.tools.map((t) => t.name)).toContain("test.Todo.create");
    } finally {
      await dev.dispose();
    }
  }, 180000);

  it("rewrites the contracts version-producer specifier to the vendor entry (C4 t16b)", () => {
    // Pinned invoke.js holds its producer specifier in a const
    // (statically invisible to the link check): the staged copy must
    // name the vendor entry relatively, never the bare specifier —
    // a bare `@canlang/contracts` 500s boot as worker-assembly-failed.
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    expect(bundle.modules["vendor/contracts/index.js"]).toBeDefined();
    expect(bundle.modules["runtime/invoke.js"]).toContain("../vendor/contracts/index.js");
    expect(bundle.modules["runtime/invoke.js"]).not.toContain("@canlang/contracts");
  });

  it("stages the genuine public Work receipt and relative observation closure", async () => {
    const runtimeFile = resolveProducerFile("@canlang/cloudflare/runtime/invoke", "bun run --filter @canlang/cloudflare build");
    const runtimeSource = readFileSync(runtimeFile, "utf8");
    const originalFactoryImports = scanModuleImports(runtimeSource, "runtime/invoke.js")
      .filter(record => record.specifier === "@canlang/work");
    expect(originalFactoryImports).toHaveLength(1);
    expect(originalFactoryImports[0]!.kind).toBe("evaluation-static");
    expect(runtimeSource.slice(originalFactoryImports[0]!.statement.start, originalFactoryImports[0]!.statement.end))
      .toMatch(/^import\s*\{\s*createCommittedModelSourceStager,\s*createStandardCompletionSourceCommand\s*\}\s*from\s*["']@canlang\/work["']/);
    const originalSourceStage = runtimeSource.match(/^async function canonicalCommittedSourceStage\b[\s\S]*?^}/m)?.[0] ?? "";
    expect(originalSourceStage).toMatch(/loadProducerModule\(["']@canlang\/state\/mutation["'],\s*["']committed model source lifetime["']\)/);
    expect(originalSourceStage).toMatch(/requireProducerFn\(state,\s*["']readOwnerMutationSourceStage["'],\s*["']committed model source lifetime["']\)/);
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    const invoke = bundle.modules["runtime/invoke.js"] ?? "";
    const stagedFactoryImports = scanModuleImports(invoke, "runtime/invoke.js")
      .filter(record => record.specifier === "../vendor/work/kernel/committed-model-source.js");
    expect(stagedFactoryImports).toHaveLength(1);
    expect(stagedFactoryImports[0]!.kind).toBe("evaluation-static");
    expect(invoke.slice(stagedFactoryImports[0]!.statement.start, stagedFactoryImports[0]!.statement.end))
      .toMatch(/^import\s*\{\s*createCommittedModelSourceStager\s*\}\s*from\s*["']\.\.\/vendor\/work\/kernel\/committed-model-source\.js["']/);
    const completionImports = scanModuleImports(invoke, 'runtime/invoke.js')
      .filter(record => record.specifier === '../vendor/work/kernel/standard-completion-source.js');
    expect(completionImports).toHaveLength(1);
    expect(completionImports[0]!.kind).toBe('evaluation-static');
    expect(invoke.slice(completionImports[0]!.statement.start, completionImports[0]!.statement.end))
      .toMatch(/^import\s*\{\s*createStandardCompletionSourceCommand\s*\}\s*from/);
    const completionFile = new URL('kernel/standard-completion-source.js', (await import('@canlang/work/distribution')).distribution.modules);
    expect(bundle.modules['vendor/work/kernel/standard-completion-source.js'])
      .toBe(rewriteModuleImports(readFileSync(completionFile, 'utf8'), 'vendor/work/kernel/standard-completion-source.js',
        spec => spec === '@canlang/state' ? '../../state/index.js' : spec.startsWith('@canlang/state/')
          ? `../../state/${spec.slice('@canlang/state/'.length)}.js` : spec === '@canlang/values' ? '../../values/index.js' : spec,
        { profile: 'trusted-producer' }).js);
    const opaqueKey = 'runtime/opaque-file-staging.js';
    const originalOpaque = readFileSync(join(dirname(runtimeFile), 'opaque-file-staging.js'), 'utf8');
    const originalFileImports = scanModuleImports(originalOpaque, opaqueKey).filter(record => record.specifier === '@canlang/work');
    expect(originalFileImports).toHaveLength(1);
    expect(originalFileImports[0]!.kind).toBe('evaluation-static');
    expect(originalOpaque.slice(originalFileImports[0]!.statement.start, originalFileImports[0]!.statement.end))
      .toMatch(/^import\s*\{\s*WORK_FILE_REFERENCE_PRODUCER\s*\}\s*from/);
    const stagedOpaque = bundle.modules[opaqueKey]!;
    const stagedFileImports = scanModuleImports(stagedOpaque, opaqueKey)
      .filter(record => record.specifier === '../vendor/work/kernel/file-reference-inventory.js');
    expect(stagedFileImports).toHaveLength(1);
    expect(stagedFileImports[0]!.kind).toBe('evaluation-static');
    expect(stagedOpaque.slice(stagedFileImports[0]!.statement.start, stagedFileImports[0]!.statement.end))
      .toMatch(/^import\s*\{\s*WORK_FILE_REFERENCE_PRODUCER\s*\}\s*from/);
    const storageImports = scanModuleImports(stagedOpaque, opaqueKey);
    expect(storageImports.filter(record => record.specifier === '../vendor/state/storage/opaque-file-declarations.js')).toHaveLength(1);
    expect(storageImports.filter(record => record.specifier === '../vendor/state/storage/file-retirement.js')).toHaveLength(1);
    expect(storageImports.some(record => record.specifier === '@canlang/state/storage' ||
      record.specifier === '../vendor/state/storage.js' || record.specifier === '../vendor/state/storage/index.js')).toBe(false);
    const stateModules = (await import('@canlang/state/distribution')).distribution.modules;
    for (const name of ['opaque-file-declarations', 'file-retirement']) {
      const key = `vendor/state/storage/${name}.js`;
      expect(bundle.modules[key]).toBe(rewriteModuleImports(readFileSync(new URL(`storage/${name}.js`, stateModules), 'utf8'), key,
        spec => spec === '@canlang/values' ? '../../values/index.js'
          : spec === '@canlang/files/ports' ? '../../files/ports.js'
            : spec === '@canlang/files/finalize' ? '../../files/finalize/index.js' : spec,
        { profile: 'trusted-producer' }).js);
    }
    const fileDistribution = (await import('@canlang/work/distribution')).distribution.modules;
    expect(bundle.modules['vendor/work/kernel/file-reference-inventory.js'])
      .toBe(readFileSync(new URL('kernel/file-reference-inventory.js', fileDistribution), 'utf8'));
    expect(bundle.modules['vendor/work/kernel/opaque-file-resolver.js'])
      .toBe(rewriteModuleImports(readFileSync(new URL('kernel/opaque-file-resolver.js', fileDistribution), 'utf8'),
        'vendor/work/kernel/opaque-file-resolver.js', spec => spec === '@canlang/values' ? '../../values/index.js' : spec,
        { profile: 'trusted-producer' }).js);
    const stagedSourceStage = invoke.match(/^async function canonicalCommittedSourceStage\b[\s\S]*?^}/m)?.[0] ?? "";
    expect(stagedSourceStage).toMatch(/loadProducerModule\(["']\.\.\/vendor\/state\/mutation\/index\.js["'],\s*["']committed model source lifetime["']\)/);
    expect(stagedSourceStage).toMatch(/requireProducerFn\(state,\s*["']readOwnerMutationSourceStage["'],\s*["']committed model source lifetime["']\)/);
    expect(invoke).toContain("../vendor/state/receipt/join.js");
    expect(invoke).toContain("../vendor/state/receipt/index.js");
    expect(invoke).toContain("../vendor/state/query/index.js");
    expect(invoke).not.toContain("../vendor/state/query.js");
    expect(bundle.modules['vendor/state/query/index.js']).toContain('queryRecordHistoryForViewer');
    expect(bundle.modules['vendor/state/query/history.js']).toBeDefined();
    expect(invoke).not.toContain("../../../state/dist/state/src/receipt/join.js");
    expect(invoke).not.toContain("../../../state/dist/state/src/receipt/observer.js");
    expect(invoke).toContain("../vendor/work/receipt/index.js");
    expect(invoke).not.toContain("@canlang/work/receipt");
    const owners = [
      ["@canlang/work/receipt", "vendor/work/receipt/index.js"],
      ["@canlang/work/observation/observation", "vendor/work/observation/observation.js"],
      ["@canlang/work/observation/association", "vendor/work/observation/association.js"],
      ["@canlang/work/intent/staging", "vendor/work/intent/staging.js"],
    ] as const;
    const producers = [];
    for (const [specifier, key] of owners) {
      const file = resolveProducerFile(specifier, "bun run --filter @canlang/work build");
      const staged = bundle.modules[key];
      expect(staged).toBeDefined();
      // Restore only relocated package edges; compare the complete emitted
      // producer body, including the genuine relative observation cycle.
      const restored = rewriteModuleImports(staged!, key, imported =>
        imported === "../../state/receipt/tables.js" ? "@canlang/state/receipt/tables"
          : imported === "../../values/index.js" ? "@canlang/values" : imported,
      { profile: "trusted-producer" }).js;
      expect(restored).toBe(readFileSync(file, "utf8"));
      producers.push(await import(pathToFileURL(file).href));
    }
    const workDistribution = await import("@canlang/work/distribution");
    const committedFile = new URL("kernel/committed-model-source.js", workDistribution.distribution.modules);
    const committedKey = "vendor/work/kernel/committed-model-source.js";
    const committed = bundle.modules[committedKey];
    expect(committed).toBeDefined();
    const restoredCommitted = rewriteModuleImports(committed!, committedKey, imported =>
      imported === "../../state/index.js" ? "@canlang/state" : imported,
    { profile: "trusted-producer" }).js;
    expect(restoredCommitted).toBe(readFileSync(committedFile, "utf8"));
    expect(scanModuleImports(committed!, committedKey).map(record => record.specifier)).toContain("../../state/index.js");
    const workRoot = await import(pathToFileURL(resolveProducerFile("@canlang/work", "bun run --filter @canlang/work build")).href);
    const committedProducer = await import(committedFile.href);
    expect(typeof committedProducer.createCommittedModelSourceStager).toBe("function");
    expect(workRoot.createCommittedModelSourceStager).toBe(committedProducer.createCommittedModelSourceStager);
    // Both public State routes preserve the same defining source-stage identity.
    const stateRoot = await import(pathToFileURL(resolveProducerFile("@canlang/state", "bun run --filter @canlang/state build")).href);
    const mutationFile = resolveProducerFile("@canlang/state/mutation", "bun run --filter @canlang/state build");
    const mutation = await import(pathToFileURL(mutationFile).href);
    const sourceFinalization = await import(pathToFileURL(join(dirname(mutationFile), "source-finalization.js")).href);
    expect(typeof sourceFinalization.readOwnerMutationSourceStage).toBe("function");
    expect(stateRoot.readOwnerMutationSourceStage).toBe(sourceFinalization.readOwnerMutationSourceStage);
    expect(mutation.readOwnerMutationSourceStage).toBe(sourceFinalization.readOwnerMutationSourceStage);
    expect(bundle.modules["vendor/state/index.js"]).toBeDefined();
    expect(scanModuleImports(bundle.modules["vendor/state/index.js"]!, "vendor/state/index.js").map(record => record.specifier))
      .toContain("./mutation/index.js");
    expect(scanModuleImports(bundle.modules["vendor/state/mutation/index.js"]!, "vendor/state/mutation/index.js").map(record => record.specifier))
      .toContain("./source-finalization.js");
    const receipt = producers[0]!;
    const functions = await receipt.loadWorkReceiptFns();
    expect(functions.observeSelectedReceipt).toBe(producers[1]!.observeSelectedReceipt);
    expect(functions.applyReceiptProgress).toBe(producers[2]!.applyReceiptProgress);
    expect(functions.isConsistentCompletion).toBe(receipt.isConsistentCompletion);
    expect(scanModuleImports(bundle.modules[owners[0][1]]!, owners[0][1]).map(record => record.specifier))
      .toEqual(["../observation/observation.js", "../observation/association.js"]);
    expect(bundle.modules["vendor/state/receipt/join.js"]).toBeDefined();
    expect(bundle.modules["vendor/state/receipt/observer.js"]).toBeUndefined();
    expect(bundle.modules["vendor/state/receipt/work-loader.js"]).toBeUndefined();
    expect(bundle.modules["vendor/state/fanout/work-loader.js"]).toBeUndefined();
    expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
    expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
  });

  it("refuses each missing genuine Work receipt closure entry", () => {
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    for (const key of [
      "vendor/work/kernel/committed-model-source.js",
      "vendor/work/kernel/file-reference-inventory.js",
      "vendor/work/kernel/opaque-file-resolver.js",
      "vendor/work/intent/staging.js",
      "vendor/state/storage/opaque-file-declarations.js",
      "vendor/state/storage/file-retirement.js",
      "vendor/work/receipt/index.js",
      "vendor/work/observation/observation.js",
      "vendor/work/observation/association.js",
      "vendor/state/index.js",
      "vendor/state/mutation/source-finalization.js",
      "vendor/state/query/index.js",
      "vendor/state/query/history.js",
    ]) {
      const missing = { ...bundle.modules };
      delete missing[key];
      expect(() => assertLinksResolve(missing)).toThrow(/no such staged module/);
    }
  });

  it.each(["runtime", "vendor"] as const)("links %s portable intent and State fence imports and refuses the Node intent entry", async (kind) => {
    const runtime = dirname(resolveProducerFile("@canlang/cloudflare/runtime/invoke", "bun run --filter @canlang/cloudflare build"));
    const fixture = kind === "runtime" ? mkdtempSync(join(tmpdir(), "can-work-intent-import-")) : undefined;
    if (fixture !== undefined) {
      for (const entry of readdirSync(runtime).filter(name => name.endsWith(".js"))) {
        writeFileSync(join(fixture, entry), readFileSync(join(runtime, entry)));
      }
    }
    const workDistribution = await import("@canlang/work/distribution");
    const target = fixture === undefined
      ? new URL("kernel/committed-model-source.js", workDistribution.distribution.modules)
      : join(fixture, "context.js");
    const original = readFileSync(target);
    const key = kind === "runtime" ? "runtime/context.js" : "vendor/work/kernel/committed-model-source.js";
    const options = { repoRoot, ...(fixture === undefined ? {} : { runtimeDistDir: fixture }), verdict: ACTIVE_VERDICT };
    try {
      // Only the import carrier is overlaid; the staged intent body is the
      // genuine public producer. Dev owns the actual callback consumer.
      const stagingImport = 'import { deriveOutboxIdAsync } from "@canlang/work/intent/staging";';
      const fenceImport = 'import { FenceConflictError } from "@canlang/state/storage/port";';
      writeFileSync(target, `${original.toString("utf8")}\n${stagingImport}\n${fenceImport}\nexport const importFormControl = [deriveOutboxIdAsync, FenceConflictError];\n`);
      const bundle = buildDeployBundle(testArtifact(), options);
      const edges = scanModuleImports(bundle.modules[key]!, key).map(record => record.specifier);
      expect(edges).toContain(kind === 'runtime' ? '../vendor/work/intent/staging.js' : '../intent/staging.js');
      expect(edges).not.toContain('@canlang/work/intent/staging');
      expect(edges).toContain(kind === 'runtime' ? '../vendor/state/storage/port.js' : '../../state/storage/port.js');
      expect(edges).not.toContain('@canlang/state/storage/port');
      expect(bundle.modules['vendor/state/storage/port.js']).toBe(readFileSync(
        resolveProducerFile('@canlang/state/storage/port', 'bun run --filter @canlang/state build'), 'utf8'));
      expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
      expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
      const missingFence = { ...bundle.modules };
      delete missingFence['vendor/state/storage/port.js'];
      expect(() => assertLinksResolve(missingFence)).toThrow(/no such staged module/);
      writeFileSync(target, `${original.toString("utf8")}\nimport { deriveOutboxId } from "@canlang/work/intent";\n`);
      expect(() => buildDeployBundle(testArtifact(), options)).toThrow(/bare import "@canlang\/work\/intent"/);
    } finally {
      writeFileSync(target, original);
      if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
    }
  });

  it.each(["runtime", "vendor"] as const)("restricts %s root Work imports to the selected genuine named stager", async (kind) => {
    // Import-form controls exercise the real staging gate. They do not stand
    // in for Dev's owning runtime consumer or its native workflow.
    const runtime = dirname(resolveProducerFile("@canlang/cloudflare/runtime/invoke", "bun run --filter @canlang/cloudflare build"));
    const fixture = kind === "runtime" ? mkdtempSync(join(tmpdir(), "can-work-import-form-")) : undefined;
    if (fixture !== undefined) {
      for (const entry of readdirSync(runtime).filter(name => name.endsWith(".js"))) {
        writeFileSync(join(fixture, entry), readFileSync(join(runtime, entry)));
      }
    }
    const workDistribution = await import("@canlang/work/distribution");
    const target = fixture === undefined
      ? new URL("kernel/committed-model-source.js", workDistribution.distribution.modules)
      : join(fixture, "context.js");
    const original = readFileSync(target);
    const key = kind === "runtime" ? "runtime/context.js" : "vendor/work/kernel/committed-model-source.js";
    const options = { repoRoot, ...(fixture === undefined ? {} : { runtimeDistDir: fixture }), verdict: ACTIVE_VERDICT };
    const selected = "createCommittedModelSourceStager";
    try {
      for (const source of [
        `import { ${selected} as selectedWorkStager } from "@canlang/work";`,
        `import { ${selected} as selectedWorkStager } from "@canlang/\\u0077ork";`,
        'import { createStandardCompletionSourceCommand as selectedWorkStager } from "@canlang/work";',
        `import { ${selected} as selectedWorkStager, createStandardCompletionSourceCommand as selectedCompletion } from "@canlang/work";`,
        'import { WORK_FILE_REFERENCE_PRODUCER as selectedWorkStager } from "@canlang/work";',
        'import { WORK_FILE_REFERENCE_PRODUCER as selectedWorkStager } from "@canlang/\\u0077ork";',
        `import { ${selected} as selectedWorkStager, createStandardCompletionSourceCommand as selectedCompletion, WORK_FILE_REFERENCE_PRODUCER as selectedFiles } from "@canlang/work";`,
      ]) {
        writeFileSync(target, `${original.toString("utf8")}\n${source}\nexport const importFormControl = selectedWorkStager;\n`);
        const bundle = buildDeployBundle(testArtifact(), options);
        const specifiers = scanModuleImports(bundle.modules[key]!, key).map(record => record.specifier);
        expect(specifiers).toContain(source.includes('createCommittedModelSourceStager')
          ? kind === 'runtime' ? '../vendor/work/kernel/committed-model-source.js' : './committed-model-source.js'
          : source.includes('createStandardCompletionSourceCommand')
            ? kind === 'runtime' ? '../vendor/work/kernel/standard-completion-source.js' : './standard-completion-source.js'
            : kind === 'runtime' ? '../vendor/work/kernel/file-reference-inventory.js' : './file-reference-inventory.js');
        if (source.includes('selectedCompletion')) expect(specifiers).toContain(kind === 'runtime'
          ? '../vendor/work/kernel/standard-completion-source.js' : './standard-completion-source.js');
        if (source.includes('selectedFiles')) expect(specifiers).toContain(kind === 'runtime'
          ? '../vendor/work/kernel/file-reference-inventory.js' : './file-reference-inventory.js');
        expect(specifiers).not.toContain("@canlang/work");
      }
      for (const source of [
        'import { createIntent } from "@canlang/work";',
        `import { ${selected} as selectedWorkStager, createIntent } from "@canlang/work";`,
        'import { WORK_FILE_REFERENCE_PRODUCER as selectedFiles, createIntent } from "@canlang/work";',
        'import work from "@canlang/work";',
        'import * as work from "@canlang/work";',
        'import "@canlang/work";',
        `export { ${selected} as exportedWorkStager } from "@canlang/work";`,
        'export * from "@canlang/work";',
        'const work = import("@canlang/work");',
        'const work = import(`@canlang/work`);',
        'const specifier = "@canlang/work"; const work = import(specifier);',
        "const work = loadProducerModule('@canlang/work', 'committed model source finalizer');",
        'import { createIntent } from "@canlang/\\u0077ork";',
        'const source = { package: "@canlang/work" };',
      ]) {
        writeFileSync(target, `${original.toString("utf8")}\n${source}\n`);
        expect(() => buildDeployBundle(testArtifact(), options), source).toThrow(/only.*named.*createCommittedModelSourceStager/);
      }
      const storageSource = 'import { bindOpaqueFileDeclarations as bound, prepareFrameworkFilePayloadOrigin as origin, resolveOpaqueFileProjection as projection, validateOpaqueFileOrigin as valid } from "@canlang/state/\\u0073torage";';
      writeFileSync(target, `${original.toString('utf8')}\n${storageSource}\nexport const storageImportControl = [bound, origin, projection, valid];\n`);
      const storageBundle = buildDeployBundle(testArtifact(), options);
      const storageEdges = scanModuleImports(storageBundle.modules[key]!, key).map(record => record.specifier);
      expect(storageEdges).toContain(kind === 'runtime' ? '../vendor/state/storage/opaque-file-declarations.js' : '../../state/storage/opaque-file-declarations.js');
      expect(storageEdges).toContain(kind === 'runtime' ? '../vendor/state/storage/file-retirement.js' : '../../state/storage/file-retirement.js');
      expect(storageEdges).not.toContain('@canlang/state/storage');
      for (const source of [
        'import { createD1Storage } from "@canlang/state/storage";',
        'import { prepareFrameworkFilePayloadOrigin, createD1Storage } from "@canlang/state/storage";',
        'import storage from "@canlang/state/storage";',
        'import * as storage from "@canlang/state/storage";',
        'import "@canlang/state/storage";',
        'export { prepareFrameworkFilePayloadOrigin } from "@canlang/state/storage";',
        'export * from "@canlang/state/storage";',
        'const storage = import("@canlang/state/storage");',
        'const storage = import(`@canlang/state/storage`);',
        'const specifier = "@canlang/state/storage"; const storage = import(specifier);',
      ]) {
        writeFileSync(target, `${original.toString('utf8')}\n${source}\n`);
        expect(() => buildDeployBundle(testArtifact(), options), source).toThrow(/only.*named.*bindOpaqueFileDeclarations/);
      }
      if (kind === "vendor") {
        writeFileSync(target, "export function {\n");
        expect(() => buildDeployBundle(testArtifact(), options)).toThrow(/committed-model-source\.js.*invalid JavaScript syntax/);
      }
    } finally {
      writeFileSync(target, original);
      if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
    }
  }, 15000);

  it("stages the genuine public Files finalizer closure with shared noble dependencies", () => {
    // This overlay exercises runtime import/constant rewriting only. The Files
    // bodies remain genuine public emissions; it is not a State consumer fixture.
    const fixture = filesFinalizerRuntimeFixture();
    try {
      const bundle = buildDeployBundle(testArtifact(), { repoRoot, runtimeDistDir: fixture, verdict: ACTIVE_VERDICT });
      const owners = [
        ["@canlang/files/bridge", "vendor/files/bridge.js"],
        ["@canlang/files/finalize", "vendor/files/finalize/index.js"],
        ["@canlang/files/ports", "vendor/files/ports.js"],
        ["@canlang/files/provenance", "vendor/files/provenance/index.js"],
        ["@canlang/files/upload", "vendor/files/upload/index.js"],
      ] as const;
      expect(Object.keys(bundle.modules).filter(key => key.startsWith("vendor/files/"))).toEqual(owners.map(([, key]) => key));
      for (const [specifier, key] of owners) {
        const file = resolveProducerFile(specifier, "bun run --filter @canlang/files build");
        const restored = rewriteModuleImports(bundle.modules[key]!, key, imported =>
          imported === "../../noble-hashes/sha2.js" ? "@noble/hashes/sha2.js"
            : imported === "../../noble-hashes/utils.js" ? "@noble/hashes/utils.js" : imported,
        { profile: "trusted-producer" }).js;
        expect(restored).toBe(readFileSync(file, "utf8"));
      }
      const invoke = bundle.modules["runtime/invoke.js"]!;
      expect(invoke).toContain('from "../vendor/files/finalize/index.js"');
      expect(invoke).toContain('const FILES_FINALIZER_MAP_FIXTURE = "../vendor/files/finalize/index.js"');
      expect(invoke).not.toContain("@canlang/files/finalize");
      expect(bundle.modules["vendor/files/finalize/index.js"]).toContain("export function readFinalizedFileObservation(");
      expect(scanModuleImports(bundle.modules["vendor/files/finalize/index.js"]!, "vendor/files/finalize/index.js").map(record => record.specifier))
        .toEqual(["../ports.js", "../provenance/index.js", "../upload/index.js"]);
      expect(Object.keys(bundle.modules).filter(key => key.startsWith("vendor/noble-hashes/"))).toEqual([
        "vendor/noble-hashes/_md.js", "vendor/noble-hashes/_u64.js",
        "vendor/noble-hashes/sha2.js", "vendor/noble-hashes/utils.js",
      ]);
      expect(scanModuleImports(bundle.modules["vendor/files/upload/index.js"]!, "vendor/files/upload/index.js").map(record => record.specifier))
        .toContain("../../noble-hashes/sha2.js");
      // The released State consumer supplies both actual Files edges.
      const stateBase = dirname(dirname(resolveProducerFile("@canlang/state/mutation", "bun run --filter @canlang/state build")));
      const stateSource = readFileSync(join(stateBase, "invocation/scenario-file-assignment.js"), "utf8");
      expect(stateSource).toContain("@canlang/files/finalize");
      expect(stateSource).toContain("@canlang/files/ports");
      const state = bundle.modules["vendor/state/invocation/scenario-file-assignment.js"]!;
      expect(state).toContain("../../files/finalize/index.js");
      expect(state).toContain("../../files/ports.js");
      expect(state).not.toContain("@canlang/files/finalize");
      expect(state).not.toContain("@canlang/files/ports");
      expect(Object.keys(bundle.modules).some(key => /^vendor\/files\/.*(?:host\/|fs-blob-store|\.test\.js$)/.test(key))).toBe(false);
      expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
      expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("vendors the work-kernel leaf rows and rewrites wrapper bare imports", () => {
    // The work/state wrappers import the package-exported leaf; the deploy
    // map must carry that runtime closure, not leave a bare specifier.
    // Relative edges resolve against their importing module, so compare
    // normalized link targets, not raw specifier suffixes.
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    expect(Object.keys(bundle.modules)).toContain("vendor/work-kernel/src/rows.js");
    expect(bundle.modules["vendor/work-kernel/src/rows.js"]).toContain("export class RowsKernelError");
    for (const key of ["vendor/work/kernel/tables.js", "vendor/state/fanout/tables.js"]) {
      const edges = scanModuleImports(bundle.modules[key]!, key).map(record => record.specifier);
      expect(edges).not.toContain("@canlang/work-kernel/rows");
      const targets = edges.filter(edge => edge.startsWith(".")).map(edge => posix.normalize(posix.join(posix.dirname(key), edge)));
      expect(targets).toContain("vendor/work-kernel/src/rows.js");
    }
    expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
    expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
  });

  it("refuses each missing genuine Files finalizer closure entry", () => {
    const fixture = filesFinalizerRuntimeFixture();
    try {
      const bundle = buildDeployBundle(testArtifact(), { repoRoot, runtimeDistDir: fixture, verdict: ACTIVE_VERDICT });
      for (const key of [
        "vendor/files/bridge.js",
        "vendor/files/finalize/index.js", "vendor/files/upload/index.js",
        "vendor/files/provenance/index.js", "vendor/files/ports.js",
      ]) {
        const missing = { ...bundle.modules };
        delete missing[key];
        expect(() => assertLinksResolve(missing)).toThrow(/no such staged module/);
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("stages the exact public Acorn ESM producer and rewrites its runtime edge", () => {
    const manifestFile = resolveProducerFile("acorn/package.json", "bun install --frozen-lockfile");
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    expect(manifest.name).toBe("acorn");
    expect(manifest.version).toBe("8.18.0");
    expect(manifest.exports["."][0].import).toBe("./dist/acorn.mjs");
    const esm = readFileSync(join(dirname(manifestFile), manifest.exports["."][0].import), "utf8");
    const runtimeFile = resolveProducerFile("@canlang/cloudflare/runtime/invoke", "bun run --filter @canlang/cloudflare build");
    const runtimeSource = readFileSync(runtimeFile, "utf8");
    expect(scanModuleImports(runtimeSource, "runtime/invoke.js").filter(record => record.specifier === "acorn").map(record => record.kind))
      .toEqual(["evaluation-static"]);
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    const key = "vendor/acorn/acorn.js";
    expect(Object.keys(bundle.modules).filter(name => name.startsWith("vendor/acorn/"))).toEqual([key]);
    expect(bundle.modules[key]).toBe(esm);
    const invoke = bundle.modules["runtime/invoke.js"]!;
    const imports = scanModuleImports(invoke, "runtime/invoke.js");
    expect(imports.filter(record => record.specifier === "../vendor/acorn/acorn.js").map(record => record.kind)).toEqual(["evaluation-static"]);
    expect(imports.some(record => record.specifier === "acorn")).toBe(false);
    expect(() => assertLinksResolve(bundle.modules)).not.toThrow();
    expect(() => assertWorkerdLoadable(bundle.modules)).not.toThrow();
    const missing = { ...bundle.modules };
    delete missing[key];
    expect(() => assertLinksResolve(missing)).toThrow(/vendor\/acorn\/acorn\.js.*no such staged module/);
  });
});

describe("assertWorkerdLoadable", () => {
  it("refuses frontend-error facts with the exact owner message (037)", () => {
    // No real source reaches this arm today (lexer errors carry idx);
    // the contract is that the ordinary consumer never swallows the
    // field when the frontend does report it — the old direct
    // scanModuleImports path threw this exact message.
    const facts: ModuleSyntaxFacts = {
      imports: [],
      lexerError: null,
      frontendError: "module-imports: lexer returned an invalid literal span",
      syntaxError: null,
      fileUrl: [],
      unresolved: [{ group: 2, start: 0, end: 7, name: "exports" }],
    };
    expect(() => refuseModuleFrontendIssues(facts, "t.js")).toThrow(
      "module-imports: lexer returned an invalid literal span",
    );
  });

  it("rejects node file-URL imports, naming the module", () => {
    expect(() =>
      assertWorkerdLoadable({ "main.js": `import x from "file:///tmp/x.js";\n` }),
    ).toThrow(/main\.js.*file-URL/);
    expect(() =>
      assertWorkerdLoadable({ "a.js": `const m = await import("file:///tmp/x.js");\n` }),
    ).toThrow(/a\.js.*file-URL/);
  });

  it("rejects real CJS (bare require, module.exports, free exports)", () => {
    expect(() => assertWorkerdLoadable({ "a.js": `const x = require("ajv");\n` })).toThrow(
      /a\.js.*require/,
    );
    expect(() => assertWorkerdLoadable({ "a.js": `module.exports = {};\n` })).toThrow(
      /a\.js.*CommonJS/,
    );
    expect(() => assertWorkerdLoadable({ "a.js": `exports.foo = 1;\n` })).toThrow(/a\.js.*CommonJS/);
  });

  it("allows bundler CJS-interop, quoted tokens, and the stdlib require guard", () => {
    expect(() =>
      assertWorkerdLoadable({
        "a.js": [
          `var r = __commonJS(function(exports, module) { module.exports = {}; exports.a = 1; });`,
          `export function require(c) { if (!c) throw new Error("forbidden"); }`,
          `const s = "file://"; const t = 'require('; // module.exports in a comment`,
          `const schema = startsWith("file://");`,
          `export default { fetch: () => r };`,
          "",
        ].join("\n"),
      }),
    ).not.toThrow();
  });
});


it("serves packed scoped CSS and browser mounts through the canonical asset bundle", () => {
  const artifact = testArtifact();
  const css = '[data-can-style~="u1"] { color: rgb(12, 34, 56); }';
  artifact.stylesheets = [{path:"can.generated/u1/style.css",css,sha256:createHash("sha256").update(css).digest("hex"),
    owner:{unitId:"u1",kind:"style",canPath:"app.can",canRevision:"0".repeat(64),start:0,end:1}}];
  artifact.modules.push({path:"can.generated/u2/view.js",map:{...EMPTY_MAP},
    js:'export function render() { throw new Error("SERVER_RENDERER_MUST_STAY_OFF_BROWSER"); }\nexport function mount(root) { root.setAttribute("data-generated-mounted", "true"); return () => root.removeAttribute("data-generated-mounted"); }\n'});
  artifact.generatedViews = [{view:"TaskTile",module:"can.generated/u2/view.js",renderExport:"render",mountExport:"mount"}];
  const workerDistDir = fakeWorkerDist();
  try {
    const bundle = buildDeployBundleWithAssets(artifact,{repoRoot,workerDistDir,verdict:ACTIVE_VERDICT,assets:{browser:true}});
    const stylesheet = new TextDecoder().decode(bundle.resources["browser/can-style.css"]!.bytes);
    expect(stylesheet).toContain(css);
    const client = new TextDecoder().decode(bundle.resources["browser/bootstrap.js"]!.bytes);
    expect(client).toContain("data-generated-mounted");
    expect(client).toContain("TaskTile");
    expect(client).not.toContain("SERVER_RENDERER_MUST_STAY_OFF_BROWSER");
    expect(Object.keys(bundle.resources).sort()).toEqual(["browser/bootstrap.js","browser/can-style.css","browser/polling.js"]);
    expect(bundle.modules["worker/http-assets.js"]).toContain(bundle.resourcesSha256);
    expect(bundle.modules["can.generated/u2/view.js"]).toContain("SERVER_RENDERER_MUST_STAY_OFF_BROWSER");
  } finally { rmSync(workerDistDir,{recursive:true,force:true}); }
});


it("serves a stylesheet's exact owned asset bytes through encoded workerd paths", async () => {
  const artifact = testArtifact();
  const bytes = readFileSync(join(repoRoot,"editors/vscode/images/previews/light-dark-16.png"));
  const key = "can.generated/u1/paint layer.bin";
  const route = "can.generated/u1/paint%20layer.bin";
  const css = `[data-can-style~="u1"] { background-image: url("/assets/${route}?v=1#paint"); }`;
  const asset = {path:key,contentBase64:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex"),contentType:"image/png"};
  artifact.stylesheets = [{path:"can.generated/u1/style.css",css,sha256:createHash("sha256").update(css).digest("hex"),
    owner:{unitId:"u1",kind:"style",canPath:"app.can",canRevision:"0".repeat(64),start:0,end:1},assets:[asset]}];
  const workerDistDir = fakeWorkerDist();
  let dev: Awaited<ReturnType<typeof startLocalDev>> | undefined;
  try {
    const bundle = buildDeployBundleWithAssets(artifact,{repoRoot,workerDistDir,verdict:ACTIVE_VERDICT,assets:{browser:true}});
    expect(Object.keys(bundle.resources).sort()).toEqual(["browser/bootstrap.js","browser/can-style.css","browser/polling.js",key].sort());
    expect(new TextDecoder().decode(bundle.resources["browser/can-style.css"]!.bytes)).toContain(`/assets/${route}?v=1#paint`);
    const manifest = /export const browserAssets = (.*);/.exec(bundle.modules[ARTIFACT_MODULE]!)![1]!;
    dev = await startLocalDev({workerName:"owned-style-assets",compatibilityDate:PINNED_COMPATIBILITY_DATE,mainModule:"main.js",modules:{
      "main.js":`import {createHandler} from "./http-assets.js"; const ready = createHandler([],${manifest}); export default {async fetch(request) { return (await ready).fetch(request); }};`,
      "http-assets.js":bundle.modules[HTTP_ASSETS_MODULE]!}});
    const response = await dev.dispatchUrl(`https://can.test/assets/${route}?v=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect((await dev.dispatchUrl(`https://can.test/assets/can.generated/u1/missing.bin`)).status).toBe(404);
    expect(()=>generatedStyleResources({...artifact,stylesheets:[{...artifact.stylesheets[0]!,assets:[{...asset,sha256:"0".repeat(64)}]}]})).toThrow(/invalid owning stylesheet asset bytes/);
    expect(()=>generatedStyleResources({...artifact,stylesheets:[{...artifact.stylesheets[0]!,assets:[{...asset,path:"can.generated/other/asset.bin"}]}]})).toThrow(/invalid owning stylesheet asset path/);
  } finally { await dev?.dispose(); rmSync(workerDistDir,{recursive:true,force:true}); }
},30_000);
