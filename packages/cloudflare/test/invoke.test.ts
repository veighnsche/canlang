import { describe, expect, it } from "vitest";
import type { ArtifactCallable, CompileArtifact, StoragePort } from "@canlang/contracts";
import { createContext, type HandlerContext } from "../src/runtime/context.js";
import { invokeCallable, type AssembledModules } from "../src/runtime/invoke.js";

function testCtx(): HandlerContext {
  return createContext({
    caller: { userId: "u-test", roles: [] },
    store: {} as unknown as StoragePort,
  });
}

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

function callable(
  id: string,
  module: string,
  name: string,
  member: string[] = [name],
): ArtifactCallable {
  return { id, kind: "operation", module, export: name, member };
}

describe("invokeCallable (B1 op-execution path)", () => {
  it("missing id errors naming the id and the available ids", async () => {
    const artifact = artifactWith([
      callable("expense.Expense.create", "main.js", "create"),
      callable("expense.Expense.approve", "main.js", "approve"),
    ]);
    const result = await invokeCallable(asmWith({}), artifact, "nope.Missing", testCtx());
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
      testCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("ops.js");
    expect(result.error ?? "").toContain("a.b");
  });

  it("module without canApp() errors naming module + callable (no mod[export] fallback)", async () => {
    // The old shape exported implementations directly; the registry shape
    // keeps exports as identity consts. A direct function export must NOT
    // be picked up — resolution goes through canApp() + member only.
    const artifact = artifactWith([callable("a.b", "main.js", "create")]);
    const result = await invokeCallable(
      asmWith({ "main.js": js("export function create(ctx) { return 1; }") }),
      artifact,
      "a.b",
      testCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("canApp()");
    expect(result.error ?? "").toContain("main.js");
    expect(result.error ?? "").toContain("a.b");
  });

  it("identity-const export + canApp() registry resolves via member (real compiler shape)", async () => {
    // DESIGN 1075: canonical operation exports are qualified identity
    // constants; implementations live in the canApp() registry. The
    // artifact's member path is the linkage between them.
    const artifact = artifactWith([
      callable("TeamNotes.Note.create", "main.js", "TeamNotes_create", ["createNote"]),
    ]);
    const asm = asmWith({
      "main.js": js(
        'export const TeamNotes_create = "TeamNotes.Note.create";' +
          "export function canApp(){ return { async createNote(ctx, ...args){ return { ctx, args }; } }; }",
      ),
    });
    const ctx = testCtx();
    const result = await invokeCallable(asm, artifact, "TeamNotes.Note.create", ctx, [1, "two"]);
    expect(result.ok).toBe(true);
    const value = result.value as { ctx: unknown; args: unknown[] };
    expect(value.ctx).toBe(ctx);
    expect(value.args).toEqual([1, "two"]);
  });

  it("nested member path resolves through registry maps (dotted rule keys)", async () => {
    const artifact = artifactWith([
      callable("app.Note.read", "main.js", "app_read_Note", ["read", "Note.read.1"]),
    ]);
    const asm = asmWith({
      "main.js": js(
        "export function canApp(){ return { read: { 'Note.read.1': async (ctx, input) => ({ input }) } }; }",
      ),
    });
    const result = await invokeCallable(asm, artifact, "app.Note.read", testCtx(), [{ q: 1 }]);
    expect(result).toEqual({ ok: true, value: { input: { q: 1 } } });
  });

  it("missing member segment fails loud naming id + full path + segment", async () => {
    const artifact = artifactWith([
      callable("app.Note.read", "main.js", "app_read_Note", ["read", "Note.read.9"]),
    ]);
    const result = await invokeCallable(
      asmWith({
        "main.js": js("export function canApp(){ return { read: {} }; }"),
      }),
      artifact,
      "app.Note.read",
      testCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("app.Note.read");
    expect(result.error ?? "").toContain('["read","Note.read.9"]');
    expect(result.error ?? "").toContain('missing segment 1 "Note.read.9"');
  });

  it("non-function member segment fails loud naming id + full path + segment", async () => {
    const artifact = artifactWith([
      callable("TeamNotes.Note.create", "main.js", "TeamNotes_create", ["createNote"]),
    ]);
    const result = await invokeCallable(
      asmWith({
        "main.js": js(
          'export const TeamNotes_create = "TeamNotes.Note.create";' +
            'export function canApp(){ return { createNote: "TeamNotes.Note.create" }; }',
        ),
      }),
      artifact,
      "TeamNotes.Note.create",
      testCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("TeamNotes.Note.create");
    expect(result.error ?? "").toContain('["createNote"]');
    expect(result.error ?? "").toContain('segment 0 "createNote" is string, not a function');
  });

  it("empty member path fails loud with the recompile hint", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "create", [])]);
    const result = await invokeCallable(
      asmWith({ "main.js": js("export function canApp(){ return {}; }") }),
      artifact,
      "a.b",
      testCtx(),
    );
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("a.b");
    expect(result.error ?? "").toContain("recompile with the fixed `can compile`");
  });

  it("success calls fn(ctx, ...args) and returns its value", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "create")]);
    const asm = asmWith({
      "main.js": js(
        "export function canApp(){ return { create: (ctx, ...args) => ({ ctx, args }) }; }",
      ),
    });
    const ctx = testCtx();
    const result = await invokeCallable(asm, artifact, "a.b", ctx, [1, "two"]);
    expect(result.ok).toBe(true);
    const value = result.value as { ctx: unknown; args: unknown[] };
    expect(value.ctx).toBe(ctx);
    expect(value.args).toEqual([1, "two"]);
  });

  it("handler throw becomes { ok: false, error: message }", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "boom")]);
    const asm = asmWith({
      "main.js": js(
        "export function canApp(){ return { boom: () => { throw new Error(\"boom\"); } }; }",
      ),
    });
    const result = await invokeCallable(asm, artifact, "a.b", testCtx());
    expect(result).toEqual({ ok: false, error: "boom" });
  });

  it("non-Error throw stringifies into error", async () => {
    const artifact = artifactWith([callable("a.b", "main.js", "boom")]);
    const asm = asmWith({
      "main.js": js('export function canApp(){ return { boom: () => { throw "str-fail"; } }; }'),
    });
    const result = await invokeCallable(asm, artifact, "a.b", testCtx());
    expect(result).toEqual({ ok: false, error: "str-fail" });
  });
});
