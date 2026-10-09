import { encode } from "@jridgewell/sourcemap-codec";
import { lookup } from "../src/runtime/sourcemap.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActivationVerdict, CompileArtifact, SourceMap } from "@canlang/contracts";
import {
  ARTIFACT_MODULE,
  DEPLOY_MAIN_MODULE,
  HTTP_OPERATIONS_MODULE,
  MCP_HANDLER_MODULE,
  WORKER_MAIN_MISSING,
  assertLinksResolve,
  assertWorkerdLoadable,
  buildDeployBundle,
  deployBundleMain,
  writeDeployBundle,
} from "../src/deploy/bundle.js";
import { startLocalDev } from "../src/dev/local-run.js";
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
  return dir;
}

/**
 * Fake runtime dist for the D3b Q3 seam: the REAL pinned files (their
 * exact closure is what the proof must cover) plus a staged `invoke.js`
 * overlay carrying the Q2 observer const spelling from the frozen
 * contract — C's seam is committed but B's observer module is still
 * unlanded, so the suite keeps staging the const spelling instead of
 * depending on the sibling packet. Prune the overlay once B's module
 * lands.
 */
function fakeRuntimeDistWithObserverSeam(): string {
  const real = resolve(repoRoot, "packages", "cloudflare", "dist", "runtime");
  const dir = mkdtempSync(join(tmpdir(), "can-deploy-runtime-"));
  for (const entry of readdirSync(real).sort()) {
    if (!entry.endsWith(".js")) continue;
    const full = join(real, entry);
    if (!statSync(full).isFile()) continue;
    let text = readFileSync(full, "utf8");
    if (entry === "invoke.js") {
      text += `const STATE_RECEIPT_OBSERVER_SPECIFIER_STAGED = "@canlang/state/receipt";\n`;
    }
    writeFileSync(join(dir, entry), text);
  }
  return dir;
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
      "vendor/work/intent/staging.js",
      "vendor/work/kernel/arguments.js",
      "vendor/work/kernel/dispatch-staging.js",
      "vendor/work/kernel/handler-occurrence.js",
      "vendor/work/kernel/occurrence-staging.js",
      "vendor/work/kernel/schedule-staging.js",
      "vendor/work/kernel/staging-support.js",
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
      "runtime/invoke.js",
      "runtime/sourcemap.js",
      "runtime/mcp-registry.js",
      "runtime/env-assembly.js",
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

  it("HTTP bundle carries the op-chain markers incl. its own IdentityError copy", () => {
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      verdict: ACTIVE_VERDICT,
    });
    const ops = bundle.modules[HTTP_OPERATIONS_MODULE] as string;
    for (const marker of [
      "handleOperationRequest",
      "handlePageRequest",
      "handlePagePreferencePost",
      "IdentityError",
    ]) {
      expect(ops, `HTTP bundle must contain ${marker}`).toContain(marker);
    }
    // Real bundle, not a stub: the op chain + identity closure is
    // tens of KB (no MCP SDK weight).
    expect(ops.length).toBeGreaterThan(10_000);
    expect(bundle.httpOperationsBytes).toBe(ops.length);
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
  it("stages the state tree and rewrites pinned-runtime producer imports to vendor keys", () => {
    const bundle = buildDeployBundle(testArtifact(), { repoRoot, verdict: ACTIVE_VERDICT });
    expect(bundle.modules["vendor/state/storage/d1.js"]).toContain("createD1Storage");
    expect(bundle.modules["vendor/identity/index.js"]).toContain("./authentication/grants.js");
    const envAssembly = bundle.modules["runtime/env-assembly.js"] ?? "";
    expect(envAssembly).toContain("../vendor/state/storage/d1.js");
    expect(envAssembly).toContain("../vendor/identity/index.js");
    expect(envAssembly).not.toContain("@canlang/identity");
    expect(envAssembly).not.toContain("../../../state/dist");
    const grantRoute = bundle.modules["runtime/grant-route.js"] ?? "";
    expect(grantRoute).toContain("../vendor/identity/index.js");
    expect(grantRoute).not.toContain("@canlang/identity");
    expect(bundle.modules["vendor/values/index.js"]).toContain("VALUES_CONTRACT_VERSION");
    const stdlib = bundle.modules["vendor/stdlib/index.js"] ?? "";
    expect(stdlib).toContain("../values/index.js");
    expect(stdlib).not.toMatch(/from\s+["']@canlang\/values["']/);
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

  it("rewrites the D3b receipt join + observer producers to vendor entries (D3b Q3)", () => {
    // Join const is real (pinned invoke.js); observer const is the staged
    // Q2 spelling (C committed, B unlanded — see the helper). Both must
    // stage as module-relative vendor keys, never checkout paths.
    const bundle = buildDeployBundle(testArtifact(), {
      repoRoot,
      workerDistDir: fakeWorkerDist(),
      runtimeDistDir: fakeRuntimeDistWithObserverSeam(),
      verdict: ACTIVE_VERDICT,
    });
    const invoke = bundle.modules["runtime/invoke.js"] ?? "";
    expect(invoke).toContain("../vendor/state/receipt/join.js");
    expect(invoke).toContain("../vendor/state/receipt/index.js");
    expect(invoke).not.toContain("../../../state/dist/state/src/receipt/join.js");
    expect(invoke).not.toContain("../../../state/dist/state/src/receipt/observer.js");
    // The owning Work receipt producer is portable; Node-only test
    // work-loader bridges remain excluded below.
    expect(invoke).toContain("../vendor/work/receipt/index.js");
    expect(invoke).not.toContain("@canlang/work/receipt");
    expect(bundle.modules["vendor/work/receipt/index.js"]).toBeDefined();
    // Vendor map: join vendored IN (real, from state dist); both
    // work-loader bridges pinned OUT. The observer vendor key lands with
    // B's module — its rewrite-target spelling is proved resolvable below.
    expect(bundle.modules["vendor/state/receipt/join.js"]).toBeDefined();
    expect(bundle.modules["vendor/state/receipt/work-loader.js"]).toBeUndefined();
    expect(bundle.modules["vendor/state/fanout/work-loader.js"]).toBeUndefined();
  });

  it("proves the rewritten receipt specifiers resolve from the vendor map (D3b Q3 link check)", () => {
    // The real link checker over staged-shaped maps: the rewritten
    // relative specifier resolves against the vendor key; the checkout
    // source it replaces has no staged module. Covers join (vendored
    // today) and observer (B-half target spelling) identically.
    for (const name of ["join.js", "observer.js"]) {
      const ok = {
        "runtime/invoke.js": `const m = await import("../vendor/state/receipt/${name}");\n`,
        [`vendor/state/receipt/${name}`]: `export const producer = 1;\n`,
      };
      expect(() => assertLinksResolve(ok)).not.toThrow();
      const dangling = {
        "runtime/invoke.js": `const m = await import("../../../state/dist/state/src/receipt/${name}");\n`,
        [`vendor/state/receipt/${name}`]: `export const producer = 1;\n`,
      };
      expect(() => assertLinksResolve(dangling)).toThrow(/no such staged module/);
    }
  });
});

describe("assertWorkerdLoadable", () => {
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
