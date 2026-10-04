import { describe, expect, it } from "vitest";
import type { ArtifactCallable, CompileArtifact } from "@canlang/contracts";
import { invokeCallable, type AssembledModules } from "../src/runtime/invoke.js";

function artifactWith(callables: ArtifactCallable[]): CompileArtifact {
  return {
    artifact_version: 1,
    language_version: "1.0.0",
    tool_version: "0.1.0",
    sources: [{ path: "app.can", sha256: "0".repeat(64) }],
    modules: [
      {
        path: "main.js",
        js: "",
        map: {
          version: 3,
          file: "main.js",
          sources: [],
          sourcesContent: [],
          names: [],
          mappings: "",
        },
      },
    ],
    callables,
    pages: [],
    requires: [],
    tests: [],
  };
}

function asmWith(moduleUrls: Record<string, string>): AssembledModules {
  return { dir: "/tmp/invoke-test", entryUrl: "data:text/javascript,", moduleUrls };
}

function js(source: string): string {
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

function callable(id: string, module: string, name: string): ArtifactCallable {
  return { id, kind: "operation", module, export: name };
}

describe("invokeCallable (B1 op-execution path)", () => {
  it("missing id errors naming the id and the available ids", async () => {
    const artifact = artifactWith([
      callable("expense.Expense.create", "main.js", "create"),
      callable("expense.Expense.approve", "main.js", "approve"),
    ]);
    const result = await invokeCallable(asmWith({}), artifact, "nope.Missing", { user: "u" });
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("nope.Missing");
    expect(result.error ?? "").toContain("expense.Expense.create");
    expect(result.error ?? "").toContain("expense.Expense.approve");
  });

  it("callable module with no assembled URL errors naming the module", async () => {
    const artifact = artifactWith([callable("a.b", "ops.js", "run")]);
    const result = await invokeCallable(
      asmWith({ "main.js": js("export const x = 1;") }),
      artifact,
      "a.b",
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("ops.js");
    expect(result.error ?? "").toContain("a.b");
  });

  it("missing export errors naming the export", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "create")]);
    const result = await invokeCallable(
      asmWith({ "main.js": js("export const other = 1;") }),
      artifact,
      "a.b",
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("create");
    expect(result.error ?? "").toContain("main.js");
  });

  it("identity-const export (real compiler shape) errors naming the kind gap", async () => {
    // DESIGN 1075: canonical operation exports are qualified identity
    // constants; implementations live in the canApp() registry. The
    // artifact carries no registry-member linkage yet, so invoking the
    // const export must fail loud — never call a string, never guess.
    const artifact = artifactWith([callable("TeamNotes.Note.create", "main.js", "TeamNotes_create")]);
    const result = await invokeCallable(
      asmWith({
        "main.js": js(
          'export const TeamNotes_create = "TeamNotes.Note.create";' +
            "export function canApp(){ return { async createNote(){ return 1; } }; }",
        ),
      }),
      artifact,
      "TeamNotes.Note.create",
      {},
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("TeamNotes_create");
    expect(result.error ?? "").toContain("string, not a function");
  });

  it("success calls fn(ctx, ...args) and returns its value", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "create")]);
    const asm = asmWith({
      "main.js": js("export function create(ctx, ...args) { return { ctx, args }; }"),
    });
    const ctx = { user: "u1" };
    const result = await invokeCallable(asm, artifact, "a.b", ctx, [1, "two"]);
    expect(result.ok).toBe(true);
    const value = result.value as { ctx: unknown; args: unknown[] };
    expect(value.ctx).toBe(ctx);
    expect(value.args).toEqual([1, "two"]);
  });

  it("export 'default' calls the default export (async included)", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "default")]);
    const asm = asmWith({
      "main.js": js("export default async function (ctx, ...args) { return args.length; }"),
    });
    const result = await invokeCallable(asm, artifact, "a.b", {}, ["x", "y"]);
    expect(result).toEqual({ ok: true, value: 2 });
  });

  it("handler throw becomes { ok: false, error: message }", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "boom")]);
    const asm = asmWith({
      "main.js": js('export function boom() { throw new Error("boom"); }'),
    });
    const result = await invokeCallable(asm, artifact, "a.b", {});
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("non-Error throw stringifies into error", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "boom")]);
    const asm = asmWith({ "main.js": js('export function boom() { throw "str-fail"; }') });
    const result = await invokeCallable(asm, artifact, "a.b", {});
    expect(result).toEqual({ ok: false, error: "str-fail" });
  });
});
