import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeDeployBundle, type DeployBundle } from "../src/deploy/bundle.js";

function bundle(modules: Record<string, string> = {
  "a.js": "EARLY",
  "worker/main.js": "export default {};",
}): DeployBundle {
  return {
    mainModule: "worker/main.js", modules, moduleCount: Object.keys(modules).length,
    sha256: "reviewed-text", mcpBundleBytes: 0, httpOperationsBytes: 0,
  };
}

function withScratch(check: (scratch: string, output: string, outside: string) => void): void {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "can-text-contained-")));
  const outside = join(scratch, "outside");
  mkdirSync(outside);
  try { check(scratch, join(scratch, "output"), outside); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}

describe("text output containment", () => {
  it.each(["absent", "existing"])("writes exact ordinary bytes and public paths with %s output", (state) => {
    withScratch((_scratch, output, outside) => {
      if (state === "existing") {
        mkdirSync(join(output, "worker"), { recursive: true });
        writeFileSync(join(output, "worker/main.js"), "old selected bytes");
        writeFileSync(join(output, "unselected.txt"), "keep");
      }
      const selected = bundle({ "worker/main.js": "export default {};", "inside/deep/λ.js": "λ\n" });
      const written = writeDeployBundle(selected, output);
      expect(written).toEqual({
        dir: output, mainFile: join(output, "worker/main.js"),
        files: [join(output, "bundle.json"), join(output, "inside/deep/λ.js"), join(output, "worker/main.js")],
      });
      expect(readFileSync(join(output, "inside/deep/λ.js"), "utf8")).toBe("λ\n");
      expect(readFileSync(written.mainFile, "utf8")).toBe("export default {};");
      expect(readFileSync(join(output, "bundle.json"), "utf8")).toBe(`${JSON.stringify({
        mainModule: selected.mainModule, sha256: selected.sha256,
        moduleCount: selected.moduleCount, mcpBundleBytes: 0, httpOperationsBytes: 0,
        modules: [
          { key: "inside/deep/λ.js", bytes: 2 },
          { key: "worker/main.js", bytes: "export default {};".length },
        ],
      }, null, 2)}\n`);
      if (state === "existing") expect(readFileSync(join(output, "unselected.txt"), "utf8")).toBe("keep");
      expect(readdirSync(outside)).toEqual([]);
    });
  });

  it.each(["intermediate", "final", "dangling intermediate", "dangling final", "manifest"])(
    "refuses a %s symlink before overwriting earlier selected files",
    (placement) => withScratch((_scratch, output, outside) => {
      mkdirSync(output);
      writeFileSync(join(output, "a.js"), "existing producer output");
      const target = join(outside, "sentinel");
      writeFileSync(target, "outside bytes");
      if (placement === "intermediate" || placement === "dangling intermediate") {
        symlinkSync(placement === "intermediate" ? outside : join(outside, "missing"), join(output, "worker"));
      } else if (placement === "manifest") {
        symlinkSync(target, join(output, "bundle.json"));
      } else {
        mkdirSync(join(output, "worker"));
        symlinkSync(placement === "final" ? target : join(outside, "missing"), join(output, "worker/main.js"));
      }
      const before = readdirSync(output).sort();
      expect(() => writeDeployBundle(bundle(), output)).toThrow(/output symlink/);
      expect(readFileSync(join(output, "a.js"), "utf8")).toBe("existing producer output");
      expect(readFileSync(target, "utf8")).toBe("outside bytes");
      expect(readdirSync(outside)).toEqual(["sentinel"]);
      expect(readdirSync(output).sort()).toEqual(before);
      if (placement !== "manifest") expect(existsSync(join(output, "bundle.json"))).toBe(false);
    }),
  );

  it.each(["root", "ancestor with missing child", "ancestor with existing child"])(
    "refuses a symlink %s without redirecting output",
    (placement) => withScratch((scratch, output, outside) => {
      writeFileSync(join(outside, "sentinel"), "outside bytes");
      let requested = output;
      if (placement === "root") symlinkSync(outside, requested);
      else {
        const alias = join(scratch, "alias");
        symlinkSync(outside, alias);
        requested = join(alias, "child");
        if (placement === "ancestor with existing child") mkdirSync(join(outside, "child"));
      }
      const before = readdirSync(outside).sort();
      expect(() => writeDeployBundle(bundle(), requested)).toThrow(/output symlink/);
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("outside bytes");
      expect(readdirSync(outside).sort()).toEqual(before);
      if (placement === "ancestor with existing child") expect(readdirSync(join(outside, "child"))).toEqual([]);
    }),
  );

  it.each(["../escape.js", "/absolute.js", "z/../../../escape.js"])(
    "refuses lexical path %s before creating output or overwriting prior bytes",
    (key) => withScratch((_scratch, output, outside) => {
      const selected = bundle({ "a.js": "new bytes", [key]: "invalid" });
      expect(() => writeDeployBundle(selected, output)).toThrow(/outside the module map/);
      expect(existsSync(output)).toBe(false);
      mkdirSync(output);
      writeFileSync(join(output, "a.js"), "prior bytes");
      expect(() => writeDeployBundle(selected, output)).toThrow(/outside the module map/);
      expect(readFileSync(join(output, "a.js"), "utf8")).toBe("prior bytes");
      expect(readdirSync(output)).toEqual(["a.js"]);
      expect(readdirSync(outside)).toEqual([]);
    }),
  );

  it("checks lexical keys in sorted order before physical output errors", () => {
    withScratch((_scratch, output) => {
      writeFileSync(output, "existing root file");
      let failure: unknown;
      try { writeDeployBundle(bundle({ "z/../../../later.js": "bad", "../first.js": "bad" }), output); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('"../first.js"');
      expect(readFileSync(output, "utf8")).toBe("existing root file");
    });
  });

  it("propagates the original first native I/O error without publication", () => {
    withScratch((scratch, output, outside) => {
      writeFileSync(join(scratch, "blocked"), "file ancestor");
      const requested = join(scratch, "blocked", "output");
      let failure: unknown;
      try { writeDeployBundle(bundle(), requested); } catch (error) { failure = error; }
      // The guard rethrows the native lstat error; it does not replace it with a path refusal.
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ code: "ENOTDIR", syscall: "lstat", path: requested });
      expect(lstatSync(join(scratch, "blocked")).isFile()).toBe(true);
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(outside)).toEqual([]);
    });
  });
});
